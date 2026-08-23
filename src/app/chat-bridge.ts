import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

import type { SessionEvent } from "../storage/events.js";
import { isStorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import type { ModelHostedWebSearch } from "../model/contracts.js";
import {
  compareDefaultFollowUpBehaviorRevisions,
  isDefaultFollowUpBehavior,
  isDefaultFollowUpBehaviorRevision,
  ProfileValidationError,
  type ApprovalMode,
  type DefaultFollowUpBehavior,
  type DefaultFollowUpBehaviorRevision,
} from "../model/profile.js";
import { createHostAbortController } from "../runtime/host.js";
import {
  SteeringCapacityError,
  SteeringChannel,
  SteeringClosedError,
  SteeringConflictError,
  SteeringPersistenceOutcomeUnknownError,
} from "./steering.js";
import type { GlobalSettingsChange } from "./global-settings-events.js";
import type { ActionDiffGroup } from "../ui/action-diff.js";
import {
  chatDialogStateForWire,
  chatSessionEvent,
  type ChatSessionEvent,
  type ChatBridgeState,
  type ChatDialogState,
  type ChatSessionActivity,
  type ChatSessionActivityStatus,
} from "../ui/chat-state.js";
import {
  ChatBridgeConflictError,
  ChatBridgePayloadTooLargeError,
  ChatBridgeRequestTimeoutError,
  ChatBridgeRequestValidationError,
  assertEmptyInput,
  assertExactQueryParameters,
  assertJsonContentType,
  commandIdForRequest,
  parseAttachmentDeleteQuery,
  parseAttachmentUploadQuery,
  parseCommandInput,
  parseConfirmationInput,
  parseSendInput,
  parseSkillDeleteQuery,
  parseSkillInstallQuery,
  parseSteeringInput,
  readJsonBody,
  readRawAttachmentBody,
  readRawSkillBody,
  sendIdForRequest,
  steeringIdForRequest,
  steeringSendIdForRequest,
  stopSendIdForRequest,
  tokenForRequest,
  type ChatBridgeAttachmentDeleteInput,
  type ChatBridgeAttachmentInput,
  type ChatBridgeCommandInput,
  type ChatBridgeSendInput,
  type ChatBridgeSkillDeleteInput,
  type ChatBridgeSkillInstallInput,
  type RawAttachmentBodyReadOptions,
  type RawSkillBodyReadOptions,
} from "./chat-bridge-http.js";

export {
  ChatBridgeConflictError,
  ChatBridgePayloadTooLargeError,
} from "./chat-bridge-http.js";
export type {
  ChatBridgeAttachmentDeleteInput,
  ChatBridgeAttachmentInput,
  ChatBridgeCommandInput,
  ChatBridgeSendInput,
  ChatBridgeSkillDeleteInput,
  ChatBridgeSkillInstallInput,
} from "./chat-bridge-http.js";

const sensitiveResponseHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const maxRetainedSendStopTombstones = 64;
const stateSnapshotCommandId = "bridge-state-snapshot";

export interface ChatBridgeSendContext {
  sendId: string;
}

export interface ChatBridgeCommandContext {
  commandId: string;
}

export interface ChatBridgeSteeringReceiptLookupInput {
  sessionId: string;
  sendId: string;
  steerId: string;
  prompt: string;
}

export type ChatBridgeSteeringReceiptLookupResult =
  | "accepted"
  | "absent"
  | "conflict";

export interface ChatBridgeSkillInstallResult {
  state: ChatDialogState;
  receipt: { id: string; sha256: string };
}


export type PromptPersistence = "persisted" | "not_persisted" | "unknown";
export type ChatBridgeSendFailureKind = "session_unavailable";

export class ChatBridgePromptPersistenceUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgePromptPersistenceUnknownError";
  }
}

export class ChatBridgeSendFailureError extends Error {
  readonly originalError: unknown;
  readonly authoritativeState: ChatDialogState | undefined;
  readonly sendFailureKind: ChatBridgeSendFailureKind | undefined;

  constructor(
    originalError: unknown,
    authoritativeState?: ChatDialogState,
    sendFailureKind?: ChatBridgeSendFailureKind,
  ) {
    super(
      originalError instanceof Error ? originalError.message : String(originalError),
      { cause: originalError },
    );
    this.name = "ChatBridgeSendFailureError";
    this.originalError = originalError;
    this.authoritativeState = authoritativeState;
    this.sendFailureKind = sendFailureKind;
  }
}

function promptPersistenceForSendOutcome(
  observed: PromptPersistence | undefined,
  reportedError: unknown,
): PromptPersistence {
  if (observed === "persisted") return "persisted";
  if (reportedError instanceof ChatBridgePromptPersistenceUnknownError) {
    return "unknown";
  }
  return observed ?? "not_persisted";
}

export class ChatBridgeCommandOutcomeUnknownError extends Error {
  readonly authoritativeState: ChatDialogState | undefined;
  readonly authoritativeStateAttempted: boolean;

  constructor(
    message: string,
    options?: ErrorOptions & { authoritativeState?: ChatDialogState | undefined },
  ) {
    super(message, options);
    this.name = "ChatBridgeCommandOutcomeUnknownError";
    this.authoritativeState = options?.authoritativeState;
    this.authoritativeStateAttempted = options !== undefined &&
      Object.prototype.hasOwnProperty.call(options, "authoritativeState");
  }
}

export class ChatBridgeResourceNotFoundError extends Error {
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeResourceNotFoundError";
  }
}

export class ChatBridgeAttachmentValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeAttachmentValidationError";
  }
}

export class ChatBridgeSkillValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeSkillValidationError";
  }
}

export interface ChatBridgeConfirmationRequest {
  message: string;
  groups: ActionDiffGroup[];
}

export interface ChatBridgeStream {
  assistantDelta(delta: string): Promise<void>;
  assistantReset(): Promise<void>;
  webSearchUpdate(update: ModelHostedWebSearch): Promise<void>;
  sessionEvent(event: SessionEvent): Promise<void>;
  progress(message: string): Promise<void>;
  requestConfirmation(request: ChatBridgeConfirmationRequest): Promise<boolean>;
}

export interface ChatBridge {
  url: string;
  publishSessionApprovalMode(sessionId: string, approvalMode: ApprovalMode): void;
  publishDefaultFollowUpBehavior(change: GlobalSettingsChange): void;
  close(): Promise<void>;
}

interface ChatBridgeOptions {
  buildState(signal?: AbortSignal): Promise<ChatDialogState>;
  renderHtml(state: ChatBridgeState, bridge: { baseUrl: string; token: string }): string;
  handleCommand(
    input: ChatBridgeCommandInput,
    signal: AbortSignal,
    context: ChatBridgeCommandContext,
  ): Promise<ChatDialogState>;
  handleSend(
    input: ChatBridgeSendInput,
    stream: ChatBridgeStream,
    signal: AbortSignal,
    steering: SteeringChannel,
    context: ChatBridgeSendContext,
  ): Promise<ChatDialogState | void>;
  lookupSteeringReceipt?(
    input: ChatBridgeSteeringReceiptLookupInput,
  ): Promise<ChatBridgeSteeringReceiptLookupResult>;
  preflightAttachmentUpload?(
    input: { sessionId: string },
    signal: AbortSignal,
  ): Promise<void>;
  handleAttachmentUpload?(
    input: ChatBridgeAttachmentInput,
    signal: AbortSignal,
  ): Promise<ChatDialogState>;
  handleAttachmentDelete?(
    input: ChatBridgeAttachmentDeleteInput,
    signal: AbortSignal,
  ): Promise<ChatDialogState>;
  handleSkillInstall?(
    input: ChatBridgeSkillInstallInput,
    signal: AbortSignal,
  ): Promise<ChatBridgeSkillInstallResult>;
  handleSkillDelete?(
    input: ChatBridgeSkillDeleteInput,
    signal: AbortSignal,
  ): Promise<ChatDialogState>;
  /** Test seam; omitted by production callers. */
  attachmentBodyReadOptions?: RawAttachmentBodyReadOptions;
  /** Test seam; omitted by production callers. */
  skillBodyReadOptions?: RawSkillBodyReadOptions;
}

async function lookupSteeringReceiptSafely(
  options: ChatBridgeOptions,
  input: ChatBridgeSteeringReceiptLookupInput,
): Promise<ChatBridgeSteeringReceiptLookupResult | "unknown"> {
  if (!options.lookupSteeringReceipt) return "absent";
  try {
    return await options.lookupSteeringReceipt(input);
  } catch {
    return "unknown";
  }
}

interface PendingConfirmation {
  confirmationGeneration: number;
  sendId: string;
  sessionId: string;
  request: ChatBridgeConfirmationRequest;
  resolve(apply: boolean): void;
}

interface ActiveSend {
  sendId: string;
  sessionId: string;
  controller: AbortController;
  steering: SteeringChannel;
  stopRequested: boolean;
  nextConfirmationGeneration: number;
}

interface PendingSendAdmission {
  sendId: string;
  stopRequested: boolean;
}

type StateChangeSsePayloadBase =
  | {
      type: "steer_accepted";
      sendId: string;
      sessionId: string;
      steerId: string;
      activity?: StateChangeActivity;
    }
  | {
      type: "session_event";
      sendId: string;
      sessionId: string;
      event: ChatSessionEvent;
      activity?: StateChangeActivity;
    }
  | {
      type: "progress";
      sendId: string;
      sessionId: string;
      message: string;
      activity: StateChangeActivity;
    }
  | {
      type: "confirm_request";
      sendId: string;
      sessionId: string;
      id: string;
      confirmationGeneration: number;
      message: string;
      groups: ActionDiffGroup[];
      activity: StateChangeActivity;
    }
  | {
      type: "confirm_resolved";
      sendId: string;
      sessionId: string;
      id: string;
      confirmationGeneration: number;
      activity?: StateChangeActivity;
    }
  | {
      type: "approval_mode_changed";
      sessionId: string;
      approvalMode: ApprovalMode;
    }
  | {
      type: "default_follow_up_behavior_changed";
      defaultFollowUpBehavior: DefaultFollowUpBehavior;
      defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
      commandId: string;
    };

type StateChangeSsePayload = StateChangeSsePayloadBase & {
  bridgeStateRevision: string;
};

type ApprovalModeChangedSsePayload = Extract<
  StateChangeSsePayload,
  { type: "approval_mode_changed" }
>;

interface StateChangeActivity {
  status: ChatSessionActivityStatus;
  message: string;
}

type SsePayload =
  | { type: "assistant_delta"; sendId: string; sessionId: string; delta: string }
  | { type: "assistant_reset"; sendId: string; sessionId: string }
  | {
      type: "web_search_update";
      sendId: string;
      sessionId: string;
      update: ModelHostedWebSearch;
    }
  | StateChangeSsePayload
  | { type: "state"; commandId: string; state: ChatBridgeState }
  | { type: "done"; sendId: string; sessionId: string; state: ChatBridgeState }
  | {
      type: "error";
      sendId?: string;
      sessionId?: string;
      commandId?: string;
      message: string;
      field?: string;
      promptPersistence?: PromptPersistence;
      sendFailureKind?: ChatBridgeSendFailureKind;
      commandOutcome?: "unknown";
      state?: ChatBridgeState;
      reconciliationRequired?: boolean;
    };

export async function createChatBridge(
  options: ChatBridgeOptions,
): Promise<ChatBridge> {
  const token = randomUUID();
  const clients = new Set<ServerResponse>();
  const pendingConfirmations = new Map<string, PendingConfirmation>();
  const pendingRequestBodies = new Set<IncomingMessage>();
  const inFlightMutationHandlers = new Set<Promise<void>>();
  const readOnlyBuilds = new Map<ServerResponse, {
    controller: ReturnType<typeof createHostAbortController>;
    terminal: Promise<void>;
    onResponseClose: () => void;
  }>();
  const activeSendsById = new Map<string, ActiveSend>();
  const activeSendsBySession = new Map<string, ActiveSend>();
  const pendingSendAdmissions = new Map<string, PendingSendAdmission>();
  const latestApprovalModeChanges = new Map<
    string,
    ApprovalModeChangedSsePayload
  >();
  const sendStopTombstones = new Map<string, PromptPersistence>();
  const activeAttachmentTerminals = new Map<string, Promise<void>>();
  const activeAttachmentControllers = new Map<string, AbortController>();
  const sessionActivities = new Map<string, ChatSessionActivity>();
  let activeCommandAbort: AbortController | null = null;
  let activeCommandTerminal: Promise<void> | null = null;
  let latestGlobalSettingsChange: GlobalSettingsChange | undefined;
  let latestGlobalSettingsFromState = false;
  let nextBridgeStateRevision = 1;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const retainSendStopTombstone = (
    sendId: string,
    promptPersistence: PromptPersistence,
  ) => {
    if (closing) return;
    sendStopTombstones.delete(sendId);
    sendStopTombstones.set(sendId, promptPersistence);
    if (sendStopTombstones.size <= maxRetainedSendStopTombstones) return;
    const oldestSendId = sendStopTombstones.keys().next().value;
    if (oldestSendId !== undefined) sendStopTombstones.delete(oldestSendId);
  };

  const beginReadOnlyBuild = (
    response: ServerResponse,
    terminal: Promise<void>,
  ): AbortSignal => {
    const controller = createHostAbortController();
    const onResponseClose = (): void => {
      controller.abort(new Error("Live Smith state request closed."));
    };
    readOnlyBuilds.set(response, { controller, terminal, onResponseClose });
    response.once("close", onResponseClose);
    if (response.destroyed) onResponseClose();
    return controller.signal;
  };

  const finishReadOnlyBuild = (response: ServerResponse): void => {
    const read = readOnlyBuilds.get(response);
    if (!read) return;
    response.off("close", read.onResponseClose);
    readOnlyBuilds.delete(response);
  };

  const broadcast = (payload: SsePayload) => {
    if (closing) return;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
      } else {
        writeSse(client, payload);
      }
    }
  };

  const nextStateRevision = (): string =>
    String(nextBridgeStateRevision++);

  const latestStateRevision = (): string =>
    String(nextBridgeStateRevision - 1);

  const broadcastStateChange = (payload: StateChangeSsePayloadBase) => {
    if (closing) return undefined;
    const published: StateChangeSsePayload = {
      ...payload,
      bridgeStateRevision: nextStateRevision(),
    };
    broadcast(published);
    return published;
  };

  const resolveAllConfirmations = (apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      pending.resolve(apply);
      broadcastStateChange({
        type: "confirm_resolved",
        sendId: pending.sendId,
        sessionId: pending.sessionId,
        id,
        confirmationGeneration: pending.confirmationGeneration,
      });
    }
    pendingConfirmations.clear();
  };

  const resolveConfirmationsForSend = (sendId: string, apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      if (pending.sendId !== sendId) continue;
      pendingConfirmations.delete(id);
      pending.resolve(apply);
      broadcastStateChange({
        type: "confirm_resolved",
        sendId,
        sessionId: pending.sessionId,
        id,
        confirmationGeneration: pending.confirmationGeneration,
      });
    }
  };

  const readRequestBody = async <T>(request: IncomingMessage): Promise<T> => {
    pendingRequestBodies.add(request);
    try {
      return await readJsonBody<T>(request);
    } finally {
      pendingRequestBodies.delete(request);
    }
  };

  const readAttachmentRequestBody = async (
    request: IncomingMessage,
  ): Promise<Uint8Array> => {
    pendingRequestBodies.add(request);
    try {
      return await readRawAttachmentBody(
        request,
        options.attachmentBodyReadOptions,
      );
    } finally {
      pendingRequestBodies.delete(request);
    }
  };

  const readSkillRequestBody = async (
    request: IncomingMessage,
  ): Promise<Uint8Array> => {
    pendingRequestBodies.add(request);
    try {
      return await readRawSkillBody(request, options.skillBodyReadOptions);
    } finally {
      pendingRequestBodies.delete(request);
    }
  };

  const waitForStateMutations = async () => {
    for (;;) {
      const command = activeCommandTerminal;
      const attachments = [...activeAttachmentTerminals.values()];
      if (!command && attachments.length === 0) return;
      await Promise.all([
        ...(command ? [command] : []),
        ...attachments,
      ]);
    }
  };

  const reconcileGlobalSettings = (state: ChatDialogState): ChatDialogState => {
    const settings = state.settings;
    if (
      !settings ||
      !isDefaultFollowUpBehavior(settings.defaultFollowUpBehavior) ||
      !isDefaultFollowUpBehaviorRevision(
        settings.defaultFollowUpBehaviorRevision,
      )
    ) return state;
    if (
      latestGlobalSettingsChange === undefined ||
      compareDefaultFollowUpBehaviorRevisions(
        settings.defaultFollowUpBehaviorRevision,
        latestGlobalSettingsChange.defaultFollowUpBehaviorRevision,
      ) > 0
    ) {
      latestGlobalSettingsChange = {
        defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
        defaultFollowUpBehaviorRevision:
          settings.defaultFollowUpBehaviorRevision,
        commandId: stateSnapshotCommandId,
      };
      latestGlobalSettingsFromState = true;
      return state;
    }
    if (
      latestGlobalSettingsChange !== undefined &&
      compareDefaultFollowUpBehaviorRevisions(
        latestGlobalSettingsChange.defaultFollowUpBehaviorRevision,
        settings.defaultFollowUpBehaviorRevision,
      ) > 0
    ) {
      return {
        ...state,
        settings: {
          ...settings,
          defaultFollowUpBehavior:
            latestGlobalSettingsChange.defaultFollowUpBehavior,
          defaultFollowUpBehaviorRevision:
            latestGlobalSettingsChange.defaultFollowUpBehaviorRevision,
        },
      };
    }
    return state;
  };

  const stateWithActivities = (state: ChatDialogState): ChatDialogState => {
    const reconciled = reconcileGlobalSettings(state);
    const activities = (reconciled.sessions ?? [])
      .map((session) => sessionActivities.get(session.id))
      .filter((activity): activity is ChatSessionActivity => activity !== undefined);
    return activities.length || reconciled.sessionActivities !== undefined
      ? { ...reconciled, sessionActivities: activities }
      : reconciled;
  };

  const finalizeBridgeState = (
    state: ChatDialogState,
    bridgeStateCoveredThroughRevision: string,
  ): ChatBridgeState => {
    const projected = chatDialogStateForWire(stateWithActivities(state));
    return {
      ...projected,
      bridgeStateRevision: nextStateRevision(),
      bridgeStateCoveredThroughRevision,
    };
  };

  const buildBridgeState = async (
    bridgeStateCoveredThroughRevision: string,
    signal?: AbortSignal,
  ): Promise<ChatBridgeState> =>
    finalizeBridgeState(
      await options.buildState(signal),
      bridgeStateCoveredThroughRevision,
    );

  const updateActivity = (
    sessionId: string,
    status: ChatSessionActivityStatus,
    update: { message?: string; unread?: boolean } = {},
  ): ChatSessionActivity => {
    const current = sessionActivities.get(sessionId);
    const message = update.message ?? current?.message;
    const activity = {
      sessionId,
      status,
      ...(message === undefined ? {} : { message }),
      unread: update.unread ?? current?.unread ?? false,
    };
    sessionActivities.set(sessionId, activity);
    return activity;
  };

  const stateChangeActivity = (
    activity: ChatSessionActivity,
  ): StateChangeActivity => ({
    status: activity.status,
    message: activity.message ?? "",
  });

  const publishSteeringAccepted = (
    sendId: string,
    sessionId: string,
    steerId: string,
  ) => {
    const activeSend = activeSendsById.get(sendId);
    const ownsCurrentActivity = activeSend !== undefined &&
      activeSend.sessionId === sessionId &&
      activeSendsBySession.get(sessionId) === activeSend &&
      !activeSend.stopRequested;
    const currentActivity = ownsCurrentActivity
      ? sessionActivities.get(sessionId)
      : undefined;
    const newerConfirmationPending = [...pendingConfirmations.values()].some(
      (pending) => pending.sendId === sendId,
    );
    const activity = !newerConfirmationPending && currentActivity && [
        "running",
        "waiting_confirmation",
      ].includes(currentActivity.status)
      ? stateChangeActivity(updateActivity(sessionId, "running", {
          message: "Guidance applied",
        }))
      : undefined;
    return broadcastStateChange({
      type: "steer_accepted",
      sendId,
      sessionId,
      steerId,
      ...(activity ? { activity } : {}),
    });
  };

  const stateChangeReceipt = (
    published: StateChangeSsePayload | undefined,
  ): {
    bridgeStateRevision?: string;
    confirmationGeneration?: number;
    activity?: StateChangeActivity;
  } =>
    published === undefined
      ? {}
      : {
          bridgeStateRevision: published.bridgeStateRevision,
          ...("confirmationGeneration" in published
            ? { confirmationGeneration: published.confirmationGeneration }
            : {}),
          ...("activity" in published && published.activity
            ? { activity: published.activity }
            : {}),
        };

  const createStream = (
    sendId: string,
    sessionId: string,
    onSessionEvent: (event: SessionEvent) => void,
  ): ChatBridgeStream => ({
    assistantDelta: async (delta) => {
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend || activeSend.stopRequested) return;
      broadcast({ type: "assistant_delta", sendId, sessionId, delta });
    },
    assistantReset: async () => {
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend || activeSend.stopRequested) return;
      broadcast({ type: "assistant_reset", sendId, sessionId });
    },
    webSearchUpdate: async (update) => {
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend || activeSend.stopRequested) return;
      broadcast({ type: "web_search_update", sendId, sessionId, update });
    },
    sessionEvent: async (event) => {
      onSessionEvent(event);
      const projectedEvent = chatSessionEvent(event);
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend) return;
      const activity = projectedEvent.steeringAck
        ? stateChangeActivity(activeSend.stopRequested
          ? sessionActivities.get(sessionId) ?? updateActivity(
              sessionId,
              "stopped",
              { message: "Stopped" },
            )
          : updateActivity(sessionId, "running", {
              message: "Guidance applied",
            }))
        : undefined;
      broadcastStateChange({
        type: "session_event",
        sendId,
        sessionId,
        event: projectedEvent,
        ...(activity ? { activity } : {}),
      });
    },
    progress: async (message) => {
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend || activeSend.stopRequested) return;
      const activity = updateActivity(sessionId, "running", { message });
      broadcastStateChange({
        type: "progress",
        sendId,
        sessionId,
        message,
        activity: stateChangeActivity(activity),
      });
    },
    requestConfirmation: (request) => {
      const activeSend = activeSendsById.get(sendId);
      if (
        !activeSend ||
        closing ||
        activeSend.stopRequested ||
        activeSend.steering.hasPending()
      ) {
        return Promise.resolve(false);
      }
      const confirmationGeneration = activeSend.nextConfirmationGeneration;
      if (!Number.isSafeInteger(confirmationGeneration)) {
        return Promise.resolve(false);
      }
      activeSend.nextConfirmationGeneration += 1;
      return new Promise<boolean>((resolve) => {
        const id = randomUUID();
        pendingConfirmations.set(id, {
          confirmationGeneration,
          sendId,
          sessionId,
          request,
          resolve,
        });
        const activity = updateActivity(sessionId, "waiting_confirmation", {
          message: "Waiting for confirmation",
        });
        broadcastStateChange({
          type: "confirm_request",
          sendId,
          sessionId,
          id,
          confirmationGeneration,
          message: request.message,
          groups: request.groups,
          activity: stateChangeActivity(activity),
        });
      });
    },
  });

  const server = createServer(async (request, response) => {
    // Capture before any async work. A later publication number describes only
    // response order; this cut is the part of the patch stream the snapshot
    // can safely claim to include.
    const stateSnapshotCutRevision = latestStateRevision();
    let resolveHandlerTerminal!: () => void;
    const handlerTerminal = new Promise<void>((resolve) => {
      resolveHandlerTerminal = resolve;
    });
    let requestPath = "";
    let sendId: string | undefined;
    let sendSessionId: string | undefined;
    let sendAdmission: PendingSendAdmission | undefined;
    let commandId: string | undefined;
    let attachmentSessionId: string | undefined;
    let sendPromptPersistence: PromptPersistence | undefined;
    let attachmentBodyMayBeUnread = false;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requestPath = url.pathname;
      attachmentBodyMayBeUnread = request.method === "POST" &&
        (requestPath === "/attachments" || requestPath.startsWith("/attachments/"));
      const skillBodyMayBeUnread = request.method === "POST" &&
        requestPath === "/skills";
      const jsonBodyMayBeUnread = request.method === "POST" && [
        "/command",
        "/confirm",
        "/send",
        "/steer",
        "/stop",
      ].includes(requestPath);
      if (request.method === "POST" && requestPath === "/send") {
        sendPromptPersistence = "not_persisted";
      }
      if (closing) {
        if (attachmentBodyMayBeUnread) request.resume();
        if (skillBodyMayBeUnread) request.resume();
        if (jsonBodyMayBeUnread) request.resume();
        sendJson(response, {
          error: "Live Smith bridge is closing.",
          ...(sendPromptPersistence ? { promptPersistence: sendPromptPersistence } : {}),
        }, 503);
        return;
      }

      if (tokenForRequest(url) !== token) {
        if (attachmentBodyMayBeUnread) request.resume();
        if (skillBodyMayBeUnread) request.resume();
        if (jsonBodyMayBeUnread) request.resume();
        if (sendPromptPersistence) {
          sendJson(response, {
            error: "Forbidden",
            promptPersistence: sendPromptPersistence,
          }, 403);
        } else {
          response.writeHead(403).end("Forbidden");
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/chat") {
        assertExactQueryParameters(url, ["token"], "Chat request");
        const signal = beginReadOnlyBuild(response, handlerTerminal);
        const state = await buildBridgeState(stateSnapshotCutRevision, signal);
        if (closing || response.destroyed) return;
        sendHtml(
          response,
          options.renderHtml(state, { baseUrl: bridgeBaseUrl(server), token }),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        assertExactQueryParameters(url, ["token"], "State request");
        const signal = beginReadOnlyBuild(response, handlerTerminal);
        await waitForStateMutations();
        if (closing || response.destroyed) return;
        sendJson(
          response,
          await buildBridgeState(stateSnapshotCutRevision, signal),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        assertExactQueryParameters(url, ["token"], "Event stream request");
        response.writeHead(200, {
          ...sensitiveResponseHeaders,
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.write("\n");
        clients.add(response);
        if (latestGlobalSettingsChange) {
          writeSse(response, {
            type: "default_follow_up_behavior_changed",
            ...latestGlobalSettingsChange,
            bridgeStateRevision: nextStateRevision(),
          });
        }
        for (const published of latestApprovalModeChanges.values()) {
          writeSse(response, published);
        }
        for (const [id, pending] of pendingConfirmations) {
          const activity = sessionActivities.get(pending.sessionId);
          writeSse(response, {
            type: "confirm_request",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id,
            confirmationGeneration: pending.confirmationGeneration,
            message: pending.request.message,
            groups: pending.request.groups,
            activity: stateChangeActivity(activity ?? {
              sessionId: pending.sessionId,
              status: "waiting_confirmation",
              message: "Waiting for confirmation",
              unread: false,
            }),
            bridgeStateRevision: nextStateRevision(),
          });
        }
        request.on("close", () => clients.delete(response));
        return;
      }

      if (request.method === "POST" && url.pathname === "/attachments") {
        if (!options.preflightAttachmentUpload || !options.handleAttachmentUpload) {
          request.resume();
          response.writeHead(404).end("Not found");
          return;
        }
        const query = parseAttachmentUploadQuery(request, url);
        attachmentSessionId = query.sessionId;
        if (
          activeCommandTerminal ||
          activeSendsBySession.has(query.sessionId) ||
          activeAttachmentTerminals.has(query.sessionId)
        ) {
          request.resume();
          sendJson(response, {
            error: activeSendsBySession.has(query.sessionId)
              ? "Stop this Session's active request before changing attachments."
              : "Another Live Smith operation is already in progress for this Session.",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeAttachmentTerminals.set(query.sessionId, handlerTerminal);
        const controller = createHostAbortController();
        activeAttachmentControllers.set(query.sessionId, controller);
        await options.preflightAttachmentUpload(
          { sessionId: query.sessionId },
          controller.signal,
        );
        throwIfBridgeAborted(controller.signal);
        const bytes = await readAttachmentRequestBody(request);
        attachmentBodyMayBeUnread = false;
        throwIfBridgeAborted(controller.signal);
        const state = finalizeBridgeState(
          await options.handleAttachmentUpload({
            ...query,
            bytes,
          }, controller.signal),
          stateSnapshotCutRevision,
        );
        sendJson(response, state, 201);
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/attachments/")) {
        if (!options.handleAttachmentDelete) {
          response.writeHead(404).end("Not found");
          return;
        }
        const input = parseAttachmentDeleteQuery(request, url);
        attachmentSessionId = input.sessionId;
        if (
          activeCommandTerminal ||
          activeSendsBySession.has(input.sessionId) ||
          activeAttachmentTerminals.has(input.sessionId)
        ) {
          sendJson(response, {
            error: activeSendsBySession.has(input.sessionId)
              ? "Stop this Session's active request before changing attachments."
              : "Another Live Smith operation is already in progress for this Session.",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeAttachmentTerminals.set(input.sessionId, handlerTerminal);
        const controller = createHostAbortController();
        activeAttachmentControllers.set(input.sessionId, controller);
        const state = finalizeBridgeState(
          await options.handleAttachmentDelete(input, controller.signal),
          stateSnapshotCutRevision,
        );
        sendJson(response, state);
        return;
      }

      if (request.method === "POST" && url.pathname === "/skills") {
        if (!options.handleSkillInstall) {
          request.resume();
          response.writeHead(404).end("Not found");
          return;
        }
        let query: Pick<ChatBridgeSkillInstallInput, "replace">;
        try {
          commandId = commandIdForRequest(request);
          query = parseSkillInstallQuery(request, url);
        } catch (error) {
          request.resume();
          throw error;
        }
        response.setHeader("X-Live-Smith-Command-Id", commandId);
        if (activeCommandTerminal || activeAttachmentTerminals.size > 0) {
          request.resume();
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeCommandTerminal = handlerTerminal;
        const controller = createHostAbortController();
        activeCommandAbort = controller;
        try {
          const bytes = await readSkillRequestBody(request);
          throwIfBridgeAborted(controller.signal);
          const result = await options.handleSkillInstall(
            { ...query, bytes },
            controller.signal,
          );
          const state = finalizeBridgeState(
            result.state,
            stateSnapshotCutRevision,
          );
          broadcast({ type: "state", commandId, state });
          sendJson(response, { state, receipt: result.receipt }, 201);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/skills/")) {
        if (!options.handleSkillDelete) {
          response.writeHead(404).end("Not found");
          return;
        }
        commandId = commandIdForRequest(request);
        response.setHeader("X-Live-Smith-Command-Id", commandId);
        if (activeCommandTerminal || activeAttachmentTerminals.size > 0) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeCommandTerminal = handlerTerminal;
        const controller = createHostAbortController();
        activeCommandAbort = controller;
        try {
          const input = parseSkillDeleteQuery(request, url);
          const state = finalizeBridgeState(
            await options.handleSkillDelete(input, controller.signal),
            stateSnapshotCutRevision,
          );
          broadcast({ type: "state", commandId, state });
          sendJson(response, state);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/command") {
        assertExactQueryParameters(url, ["token"], "Command request");
        assertJsonContentType(request);
        commandId = commandIdForRequest(request);
        response.setHeader("X-Live-Smith-Command-Id", commandId);
        if (activeCommandTerminal || activeAttachmentTerminals.size > 0) {
          sendJson(response, { error: "Another Live Smith operation is already in progress." }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeCommandTerminal = handlerTerminal;
        const input = parseCommandInput(await readRequestBody<unknown>(request));
        if (closing) {
          sendJson(response, { error: "Live Smith bridge is closing." }, 503);
          return;
        }
        if (activeCommandTerminal !== handlerTerminal) {
          sendJson(response, { error: "Another Live Smith operation is already in progress." }, 409);
          return;
        }
        if (activeAttachmentTerminals.size > 0) {
          sendJson(response, { error: "Another Live Smith operation is already in progress." }, 409);
          return;
        }
        if (activeSendsBySession.size > 0 && !isCommandAllowedDuringSend(input)) {
          sendJson(response, {
            error: "Profile settings cannot change while an agent request is active.",
          }, 409);
          return;
        }
        if (
          (
            input.kind === "delete_session" ||
            input.kind === "archive_session" ||
            input.kind === "attach_selected_audio_source"
          ) &&
          activeSendsBySession.has(input.sessionId)
        ) {
          sendJson(response, {
            error: input.kind === "attach_selected_audio_source"
              ? "Stop this Session's active request before attaching its selected audio source."
              : `Stop this Session's active request before ${
                input.kind === "delete_session" ? "deleting" : "archiving"
              } it.`,
          }, 409);
          return;
        }
        const controller = createHostAbortController();
        activeCommandAbort = controller;
        try {
          const commandState = await options.handleCommand(
            input,
            controller.signal,
            { commandId },
          );
          if (input.kind === "select_session") {
            const activity = sessionActivities.get(input.sessionId);
            if (activity) activity.unread = false;
          } else if (
            input.kind === "delete_session" ||
            input.kind === "archive_session"
          ) {
            sessionActivities.delete(input.sessionId);
          }
          const state = finalizeBridgeState(
            commandState,
            stateSnapshotCutRevision,
          );
          broadcast({ type: "state", commandId, state });
          sendJson(response, state);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        assertExactQueryParameters(url, ["token"], "Send request");
        assertJsonContentType(request);
        sendId = sendIdForRequest(request);
        if (activeCommandTerminal) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (sendStopTombstones.has(sendId)) {
          request.resume();
          retainSendStopTombstone(sendId, "not_persisted");
          sendJson(response, {
            error: "That send correlation ID was already stopped and cannot be reused.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (
          activeSendsById.has(sendId) ||
          pendingSendAdmissions.has(sendId)
        ) {
          sendJson(response, {
            error: "That send correlation ID is already active.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        sendAdmission = { sendId, stopRequested: false };
        pendingSendAdmissions.set(sendId, sendAdmission);
        const input = parseSendInput(await readRequestBody<unknown>(request));
        sendSessionId = input.sessionId;
        if (sendAdmission.stopRequested) {
          sendJson(response, {
            error: "The send was stopped before its request body completed.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (closing) {
          sendJson(response, {
            error: "Live Smith bridge is closing.",
            promptPersistence: "not_persisted",
          }, 503);
          return;
        }
        if (activeCommandTerminal) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (activeAttachmentTerminals.has(input.sessionId)) {
          sendJson(response, {
            error: "This Session already has an attachment operation in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (
          activeSendsBySession.has(input.sessionId) ||
          activeSendsById.has(sendId)
        ) {
          sendJson(response, {
            error: activeSendsBySession.has(input.sessionId)
              ? "This Session already has an active agent request."
              : "That send correlation ID is already active.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        const controller = createHostAbortController();
        const steering = new SteeringChannel();
        const activeSend: ActiveSend = {
          sendId,
          sessionId: input.sessionId,
          controller,
          steering,
          stopRequested: false,
          nextConfirmationGeneration: 1,
        };
        pendingSendAdmissions.delete(sendId);
        sendAdmission = undefined;
        activeSendsById.set(sendId, activeSend);
        activeSendsBySession.set(input.sessionId, activeSend);
        updateActivity(input.sessionId, "running", {
          message: "Starting agent loop",
          unread: false,
        });
        let sendOutcomeError: unknown;
        try {
          const stream = createStream(sendId, input.sessionId, (event) => {
            if (event.kind === "user") sendPromptPersistence = "persisted";
          });
          let handledState: ChatDialogState | void;
          try {
            handledState = await options.handleSend(
              input,
              stream,
              controller.signal,
              steering,
              { sendId },
            );
          } finally {
            steering.close(new SteeringClosedError(
              "The target agent request is no longer accepting steering.",
            ));
          }
          const baseState = handledState ?? await options.buildState();
          if (!activeSend.stopRequested) {
            updateActivity(input.sessionId, "completed", {
              message: "Completed",
              unread: baseState.activeSessionId !== input.sessionId,
            });
          }
          const state = finalizeBridgeState(
            baseState,
            stateSnapshotCutRevision,
          );
          broadcast({
            type: "done",
            sendId,
            sessionId: input.sessionId,
            state,
          });
          sendJson(response, { ok: true, state });
        } catch (error) {
          sendOutcomeError = error instanceof ChatBridgeSendFailureError
            ? error.originalError
            : error;
          throw error;
        } finally {
          steering.close(new SteeringClosedError(
            "The target agent request is no longer accepting steering.",
          ));
          if (activeSend.stopRequested) {
            retainSendStopTombstone(
              sendId,
              promptPersistenceForSendOutcome(
                sendPromptPersistence,
                sendOutcomeError,
              ),
            );
          }
          if (activeSendsById.get(sendId) === activeSend) {
            activeSendsById.delete(sendId);
          }
          if (activeSendsBySession.get(input.sessionId) === activeSend) {
            activeSendsBySession.delete(input.sessionId);
          }
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/steer") {
        assertExactQueryParameters(url, ["token"], "Steering request");
        assertJsonContentType(request);
        const targetSendId = steeringSendIdForRequest(request);
        const steerId = steeringIdForRequest(request);
        const input = parseSteeringInput(await readRequestBody<unknown>(request));
        if (closing) {
          sendJson(response, { error: "Live Smith bridge is closing." }, 503);
          return;
        }
        const activeSend = activeSendsById.get(targetSendId);
        if (!activeSend || activeSend.sessionId !== input.sessionId) {
          const receiptOutcome = await lookupSteeringReceiptSafely(
            options,
            {
              sessionId: input.sessionId,
              sendId: targetSendId,
              steerId,
              prompt: input.prompt,
            },
          );
          if (receiptOutcome === "accepted") {
            const accepted = publishSteeringAccepted(
              targetSendId,
              input.sessionId,
              steerId,
            );
            sendJson(response, {
              ok: true,
              ...stateChangeReceipt(accepted),
            });
            return;
          }
          if (receiptOutcome === "unknown") {
            sendJson(response, {
              error: "The steering persistence outcome could not be confirmed.",
              steeringOutcome: "unknown",
            }, 503);
            return;
          }
          sendJson(response, {
            error: receiptOutcome === "conflict"
              ? "That steering correlation ID belongs to different guidance."
              : "The target agent request is no longer active for this Session.",
          }, 409);
          return;
        }
        try {
          const submission = activeSend.steering.enqueue(steerId, input.prompt);
          if (submission.created) {
            resolveConfirmationsForSend(targetSendId, false);
          }
          await submission.completion;
        } catch (error) {
          if (
            error instanceof SteeringPersistenceOutcomeUnknownError ||
            error instanceof SteeringClosedError
          ) {
            const receiptOutcome = await lookupSteeringReceiptSafely(
              options,
              {
                sessionId: input.sessionId,
                sendId: targetSendId,
                steerId,
                prompt: input.prompt,
              },
            );
            if (receiptOutcome === "accepted") {
              // The durable Session event is the authoritative acknowledgement.
            } else if (receiptOutcome === "unknown") {
              sendJson(response, {
                error: "The steering persistence outcome could not be confirmed.",
                steeringOutcome: "unknown",
              }, 503);
              return;
            } else if (receiptOutcome === "conflict") {
              throw new ChatBridgeConflictError(
                "That steering correlation ID belongs to different guidance.",
              );
            } else if (error instanceof SteeringClosedError) {
              throw new ChatBridgeConflictError(error.message);
            } else {
              sendJson(response, {
                error: "The steering message was not persisted.",
              }, 500);
              return;
            }
          } else if (
            error instanceof SteeringConflictError ||
            error instanceof SteeringCapacityError ||
            error instanceof SteeringClosedError
          ) {
            throw new ChatBridgeConflictError(error.message);
          } else {
            throw error;
          }
        }
        const accepted = publishSteeringAccepted(
          targetSendId,
          input.sessionId,
          steerId,
        );
        sendJson(response, {
          ok: true,
          ...stateChangeReceipt(accepted),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/confirm") {
        assertExactQueryParameters(url, ["token"], "Confirmation request");
        assertJsonContentType(request);
        const input = parseConfirmationInput(
          await readRequestBody<unknown>(request),
        );
        if (closing) {
          sendJson(response, { error: "Live Smith bridge is closing." }, 503);
          return;
        }
        const pending = pendingConfirmations.get(input.id);
        if (pending) {
          pendingConfirmations.delete(input.id);
          const apply = input.apply === true;
          pending.resolve(apply);
          const activity = updateActivity(pending.sessionId, "running", {
            message: apply ? "Applying confirmed changes" : "Continuing after cancellation",
          });
          const resolved = broadcastStateChange({
            type: "confirm_resolved",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id: input.id,
            confirmationGeneration: pending.confirmationGeneration,
            activity: stateChangeActivity(activity),
          });
          sendJson(response, {
            ok: true,
            ...stateChangeReceipt(resolved),
          });
          return;
        }
        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        assertExactQueryParameters(url, ["token"], "Stop request");
        assertJsonContentType(request);
        const stoppedSendId = stopSendIdForRequest(request);
        assertEmptyInput(
          await readRequestBody<unknown>(request),
          "Stop request",
        );
        const activeSend = activeSendsById.get(stoppedSendId);
        const pendingAdmission = pendingSendAdmissions.get(stoppedSendId);
        if (pendingAdmission) pendingAdmission.stopRequested = true;
        if (activeSend) {
          activeSend.stopRequested = true;
          resolveConfirmationsForSend(stoppedSendId, false);
          updateActivity(activeSend.sessionId, "stopped", {
            message: "Stopped",
          });
          const stoppedError = new SteeringClosedError("Stopped by user.");
          activeSend.steering.close(stoppedError);
          activeSend.controller.abort(stoppedError);
        }
        const terminal = activeSend === undefined && pendingAdmission === undefined;
        const promptPersistence = terminal
          ? sendStopTombstones.get(stoppedSendId) ?? "unknown"
          : undefined;
        if (promptPersistence !== undefined) {
          retainSendStopTombstone(stoppedSendId, promptPersistence);
        }
        sendJson(response, {
          ok: true,
          terminal,
          sendId: stoppedSendId,
          ...(promptPersistence === undefined ? {} : { promptPersistence }),
        });
        return;
      }

      if (attachmentBodyMayBeUnread) request.resume();
      response.writeHead(404).end("Not found");
    } catch (error) {
      if (attachmentBodyMayBeUnread) request.resume();
      if (
        request.method === "POST" &&
        ["/command", "/confirm", "/send", "/steer", "/stop"].includes(
          requestPath,
        )
      ) request.resume();
      const reportedError = error instanceof ChatBridgeSendFailureError
        ? error.originalError
        : error;
      const attachmentMutation = requestPath === "/attachments" ||
        requestPath.startsWith("/attachments/");
      const skillMutation = requestPath === "/skills" ||
        requestPath.startsWith("/skills/");
      const commandOutcome =
        (requestPath === "/command" || attachmentMutation || skillMutation) &&
          (
            isStorageCommitOutcomeUnknownError(reportedError) ||
            reportedError instanceof ChatBridgeCommandOutcomeUnknownError
          )
        ? "unknown" as const
        : undefined;
      const message = attachmentMutation
        ? safeAttachmentErrorMessage(reportedError, commandOutcome)
        : skillMutation
          ? safeSkillErrorMessage(reportedError, commandOutcome)
        : reportedError instanceof Error
          ? reportedError.message
          : String(reportedError);
      const field = reportedError instanceof ProfileValidationError
        ? reportedError.field
        : undefined;
      const promptPersistence = requestPath === "/send"
        ? promptPersistenceForSendOutcome(sendPromptPersistence, reportedError)
        : undefined;
      const sendFailureKind = error instanceof ChatBridgeSendFailureError
        ? error.sendFailureKind
        : undefined;
      let commandState: ChatBridgeState | undefined;
      let sendErrorState: ChatBridgeState | undefined;
      let reconciliationRequired: true | undefined;
      if (commandOutcome === "unknown") {
        if (
          reportedError instanceof ChatBridgeCommandOutcomeUnknownError &&
          reportedError.authoritativeStateAttempted
        ) {
          if (reportedError.authoritativeState === undefined) {
            reconciliationRequired = true;
          } else {
            commandState = finalizeBridgeState(
              reportedError.authoritativeState,
              stateSnapshotCutRevision,
            );
          }
        } else try {
          commandState = await buildBridgeState(stateSnapshotCutRevision);
        } catch {
          reconciliationRequired = true;
        }
      }
      if (requestPath === "/send" && sendId && sendSessionId) {
        const activity = sessionActivities.get(sendSessionId);
        if (activity?.status !== "stopped") {
          updateActivity(sendSessionId, "failed", { message });
        }
        const baseState = error instanceof ChatBridgeSendFailureError
          ? error.authoritativeState
          : undefined;
        if (baseState !== undefined) {
          const failedActivity = sessionActivities.get(sendSessionId);
          if (failedActivity) {
            failedActivity.unread = baseState.activeSessionId !== sendSessionId;
          }
          sendErrorState = finalizeBridgeState(
            baseState,
            stateSnapshotCutRevision,
          );
        }
      }
      if (
        !attachmentMutation &&
        (
          (requestPath === "/send" && sendId !== undefined) ||
          (requestPath !== "/send" && commandId !== undefined)
        )
      ) {
        broadcast({
          type: "error",
          ...(sendId === undefined ? {} : { sendId }),
          ...(sendSessionId === undefined ? {} : { sessionId: sendSessionId }),
          ...(commandId === undefined ? {} : { commandId }),
          message,
          ...(field === undefined ? {} : { field }),
          ...(promptPersistence === undefined ? {} : { promptPersistence }),
          ...(sendFailureKind === undefined ? {} : { sendFailureKind }),
          ...(commandOutcome === undefined ? {} : { commandOutcome }),
          ...(sendErrorState !== undefined
            ? { state: sendErrorState }
            : commandState === undefined
              ? {}
              : { state: commandState }),
          ...(reconciliationRequired === undefined
            ? {}
            : { reconciliationRequired }),
        });
      }
      sendJson(
        response,
        {
          error: message,
          ...(commandId === undefined ? {} : { commandId }),
          ...(field === undefined ? {} : { field }),
          ...(promptPersistence === undefined ? {} : { promptPersistence }),
          ...(sendFailureKind === undefined ? {} : { sendFailureKind }),
          ...(commandOutcome === undefined ? {} : { commandOutcome }),
          ...(sendErrorState !== undefined
            ? { state: sendErrorState }
            : commandState === undefined
              ? {}
              : { state: commandState }),
          ...(reconciliationRequired === undefined
            ? {}
            : { reconciliationRequired }),
        },
        field !== undefined || reportedError instanceof ChatBridgeRequestValidationError
          ? 400
          : reportedError instanceof ChatBridgeRequestTimeoutError
            ? reportedError.status
            : reportedError instanceof ChatBridgeAttachmentValidationError ||
                reportedError instanceof ChatBridgeSkillValidationError ||
                reportedError instanceof ChatBridgeResourceNotFoundError ||
                reportedError instanceof ChatBridgeConflictError ||
                reportedError instanceof ChatBridgePayloadTooLargeError
              ? reportedError.status
              : 500,
      );
    } finally {
      if (
        sendAdmission !== undefined &&
        pendingSendAdmissions.get(sendAdmission.sendId) === sendAdmission
      ) {
        pendingSendAdmissions.delete(sendAdmission.sendId);
        if (sendAdmission.stopRequested) {
          retainSendStopTombstone(sendAdmission.sendId, "not_persisted");
        }
      }
      if (activeCommandTerminal === handlerTerminal) activeCommandTerminal = null;
      if (
        attachmentSessionId !== undefined &&
        activeAttachmentTerminals.get(attachmentSessionId) === handlerTerminal
      ) {
        activeAttachmentTerminals.delete(attachmentSessionId);
        activeAttachmentControllers.delete(attachmentSessionId);
      }
      inFlightMutationHandlers.delete(handlerTerminal);
      finishReadOnlyBuild(response);
      resolveHandlerTerminal();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `${bridgeBaseUrl(server)}/chat?token=${token}`,
    publishSessionApprovalMode: (sessionId, approvalMode) => {
      const published = broadcastStateChange({
        type: "approval_mode_changed",
        sessionId,
        approvalMode,
      });
      if (published?.type === "approval_mode_changed") {
        latestApprovalModeChanges.set(sessionId, published);
      }
    },
    publishDefaultFollowUpBehavior: (change) => {
      if (latestGlobalSettingsChange !== undefined) {
        const revisionOrder = compareDefaultFollowUpBehaviorRevisions(
          change.defaultFollowUpBehaviorRevision,
          latestGlobalSettingsChange.defaultFollowUpBehaviorRevision,
        );
        if (
          revisionOrder < 0 ||
          (
            revisionOrder === 0 &&
            (
              !latestGlobalSettingsFromState ||
              change.defaultFollowUpBehavior !==
                latestGlobalSettingsChange.defaultFollowUpBehavior
            )
          )
        ) return;
      }
      latestGlobalSettingsChange = change;
      latestGlobalSettingsFromState = false;
      broadcastStateChange({
        type: "default_follow_up_behavior_changed",
        ...change,
      });
    },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const mutationTerminals = [...inFlightMutationHandlers];
      const pendingReads = [...readOnlyBuilds.entries()];
      const connectedClients = [...clients];
      clients.clear();
      sendStopTombstones.clear();
      for (const request of pendingRequestBodies) request.destroy();
      pendingRequestBodies.clear();
      resolveAllConfirmations(false);
      for (const activeSend of activeSendsById.values()) {
        const closedError = new SteeringClosedError("Live Smith window closed.");
        activeSend.steering.close(closedError);
        activeSend.controller.abort(closedError);
      }
      for (const controller of activeAttachmentControllers.values()) {
        controller.abort(new Error("Live Smith window closed."));
      }
      activeCommandAbort?.abort(new Error("Live Smith window closed."));
      for (const [, read] of pendingReads) {
        read.controller.abort(new Error("Live Smith window closed."));
      }
      for (const [response] of pendingReads) response.destroy();
      for (const client of connectedClients) client.end();

      closePromise = (async () => {
        await Promise.allSettled([
          ...mutationTerminals,
          ...pendingReads.map(([, read]) => read.terminal),
        ]);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}

function writeSse(response: ServerResponse, payload: SsePayload): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function bridgeBaseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Chat bridge has not started.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function sendHtml(response: ServerResponse, html: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(200, {
    ...sensitiveResponseHeaders,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendJson(
  response: ServerResponse,
  payload: unknown,
  status = 200,
): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    ...sensitiveResponseHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function safeAttachmentErrorMessage(
  error: unknown,
  commandOutcome: "unknown" | undefined,
): string {
  if (commandOutcome === "unknown") {
    return error instanceof ChatBridgeCommandOutcomeUnknownError
      ? error.message
      : "The attachment changed, but its final state could not be confirmed.";
  }
  if (
    error instanceof ChatBridgeRequestValidationError ||
    error instanceof ChatBridgeRequestTimeoutError ||
    error instanceof ChatBridgeAttachmentValidationError ||
    error instanceof ChatBridgeResourceNotFoundError ||
    error instanceof ChatBridgeConflictError ||
    error instanceof ChatBridgePayloadTooLargeError
  ) {
    return error.message;
  }
  return "The attachment operation could not be completed.";
}

function safeSkillErrorMessage(
  error: unknown,
  commandOutcome: "unknown" | undefined,
): string {
  if (commandOutcome === "unknown") {
    return error instanceof ChatBridgeCommandOutcomeUnknownError
      ? error.message
      : "The Skill catalog changed, but its final state could not be confirmed.";
  }
  if (
    error instanceof ChatBridgeRequestValidationError ||
    error instanceof ChatBridgeRequestTimeoutError ||
    error instanceof ChatBridgeSkillValidationError ||
    error instanceof ChatBridgeResourceNotFoundError ||
    error instanceof ChatBridgeConflictError ||
    error instanceof ChatBridgePayloadTooLargeError
  ) {
    return error.message;
  }
  return "The Skill operation could not be completed.";
}

function throwIfBridgeAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw "reason" in signal ? signal.reason : new Error("Operation was aborted.");
}

function isSessionCommand(input: ChatBridgeCommandInput): boolean {
  return input.kind === "new_session" ||
    input.kind === "select_session" ||
    input.kind === "restore_session" ||
    input.kind === "delete_session" ||
    input.kind === "rename_session" ||
    input.kind === "archive_session" ||
    input.kind === "unarchive_session" ||
    input.kind === "attach_selected_audio_source" ||
    input.kind === "set_session_approval_mode" ||
    input.kind === "set_session_skills";
}

function isCommandAllowedDuringSend(input: ChatBridgeCommandInput): boolean {
  return isSessionCommand(input) || input.kind === "save_global_settings";
}
