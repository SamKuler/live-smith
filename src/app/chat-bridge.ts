import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

import { MAX_DOCUMENT_ATTACHMENT_BYTES } from "../attachments/contracts.js";
import {
  isSafeSkillId,
  MAX_SKILL_FILE_BYTES,
} from "../skills/format.js";
import { requireSafeStorageId } from "../storage/id.js";
import type { SessionEvent } from "../storage/events.js";
import { isStorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import type { ModelHostedWebSearch } from "../model/contracts.js";
import {
  compareDefaultFollowUpBehaviorRevisions,
  isApprovalMode,
  isDefaultFollowUpBehavior,
  isDefaultFollowUpBehaviorRevision,
  ProfileValidationError,
  type ApprovalMode,
  type DefaultFollowUpBehavior,
  type DefaultFollowUpBehaviorRevision,
  type DraftProfile,
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
import type {
  ChatDialogState,
  ChatSessionActivity,
  ChatSessionActivityStatus,
} from "../ui/chat-state.js";

const sensitiveResponseHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const maxRequestBodyBytes = 1024 * 1024;
const maxSteeringPromptUtf8Bytes = 64 * 1024;
const maxAttachmentFileNameUtf8Bytes = 160;
const maxAttachmentQueryUtf8Bytes = 2048;
const maxConcurrentAttachmentBodyReads = 2;
const defaultAttachmentBodyReadTimeoutMs = 15_000;
const initialUnknownAttachmentBodyCapacity = 64 * 1024;
const maxConcurrentSkillBodyReads = 2;
const defaultSkillBodyReadTimeoutMs = 15_000;
const initialUnknownSkillBodyCapacity = 8 * 1024;
const maxRetainedStopTerminalOutcomes = 64;
const stateSnapshotCommandId = "bridge-state-snapshot";
const mimeTypePattern =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
let activeAttachmentBodyReads = 0;
let activeSkillBodyReads = 0;

export interface ChatBridgeSendInput {
  prompt: string;
  sessionId: string;
}

export interface ChatBridgeSteeringInput {
  prompt: string;
  sessionId: string;
}

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

export interface ChatBridgeAttachmentInput {
  sessionId: string;
  fileName: string;
  claimedMediaType?: string;
  bytes: Uint8Array;
}

export interface ChatBridgeAttachmentDeleteInput {
  sessionId: string;
  attachmentId: string;
}

export interface ChatBridgeSkillInstallInput {
  bytes: Uint8Array;
  replace: boolean;
}

export interface ChatBridgeSkillInstallResult {
  state: ChatDialogState;
  receipt: { id: string; sha256: string };
}

export interface ChatBridgeSkillDeleteInput {
  skillId: string;
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

export class ChatBridgeConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeConflictError";
  }
}

export class ChatBridgePayloadTooLargeError extends Error {
  readonly status = 413;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgePayloadTooLargeError";
  }
}

export class ChatBridgeSkillValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeSkillValidationError";
  }
}

class ChatBridgeRequestValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgeRequestValidationError";
  }
}

class ChatBridgeRequestTimeoutError extends Error {
  readonly status = 408;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeRequestTimeoutError";
  }
}

export interface RawAttachmentBodyReadOptions {
  /** Test seam; production callers use the fixed default. */
  timeoutMs?: number;
  /** Test seam for asserting allocation shape without changing ownership. */
  allocateBuffer?(byteLength: number): Buffer;
}

export interface RawSkillBodyReadOptions {
  /** Test seam; production callers use the fixed default. */
  timeoutMs?: number;
  /** Test seam for asserting allocation shape without changing ownership. */
  allocateBuffer?(byteLength: number): Buffer;
}

export type ChatBridgeCommandInput =
  | { kind: "save_profile"; profile: DraftProfile }
  | { kind: "delete_profile"; profileId: string }
  | { kind: "activate_profile"; profileId: string }
  | {
      kind: "save_global_settings";
      defaultFollowUpBehavior: DefaultFollowUpBehavior;
    }
  | {
      kind: "set_session_approval_mode";
      sessionId: string;
      approvalMode: ApprovalMode;
    }
  | { kind: "new_session" }
  | { kind: "select_session"; sessionId: string }
  | { kind: "restore_session"; sessionId: string }
  | { kind: "delete_session"; sessionId: string }
  | { kind: "rename_session"; sessionId: string; title: string }
  | { kind: "archive_session"; sessionId: string }
  | { kind: "unarchive_session"; sessionId: string }
  | { kind: "attach_selected_audio_source"; sessionId: string }
  | { kind: "set_session_skills"; sessionId: string; skillIds: string[] }
  | { kind: "discover_models"; profile: DraftProfile };

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
  buildState(): Promise<ChatDialogState>;
  renderHtml(state: ChatDialogState, bridge: { baseUrl: string; token: string }): string;
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
}

type SsePayload =
  | { type: "assistant_delta"; sendId: string; sessionId: string; delta: string }
  | { type: "assistant_reset"; sendId: string; sessionId: string }
  | {
      type: "steer_accepted";
      sendId: string;
      sessionId: string;
      steerId: string;
    }
  | {
      type: "web_search_update";
      sendId: string;
      sessionId: string;
      update: ModelHostedWebSearch;
    }
  | { type: "session_event"; sendId: string; sessionId: string; event: SessionEvent }
  | { type: "progress"; sendId: string; sessionId: string; message: string }
  | { type: "confirm_request"; sendId: string; sessionId: string; id: string; message: string; groups: ActionDiffGroup[] }
  | { type: "confirm_resolved"; sendId: string; sessionId: string; id: string }
  | { type: "state"; commandId: string; state: ChatDialogState }
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
    }
  | { type: "done"; sendId: string; sessionId: string; state: ChatDialogState }
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
      state?: ChatDialogState;
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
  const readOnlyResponses = new Set<ServerResponse>();
  const activeSendsById = new Map<string, ActiveSend>();
  const activeSendsBySession = new Map<string, ActiveSend>();
  const stopTerminalOutcomes = new Map<string, PromptPersistence>();
  const activeAttachmentTerminals = new Map<string, Promise<void>>();
  const activeAttachmentControllers = new Map<string, AbortController>();
  const sessionActivities = new Map<string, ChatSessionActivity>();
  let activeCommandAbort: AbortController | null = null;
  let activeCommandTerminal: Promise<void> | null = null;
  let latestGlobalSettingsChange: GlobalSettingsChange | undefined;
  let latestGlobalSettingsFromState = false;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const retainStopTerminalOutcome = (
    sendId: string,
    promptPersistence: PromptPersistence,
  ) => {
    if (closing) return;
    stopTerminalOutcomes.delete(sendId);
    stopTerminalOutcomes.set(sendId, promptPersistence);
    if (stopTerminalOutcomes.size <= maxRetainedStopTerminalOutcomes) return;
    const oldestSendId = stopTerminalOutcomes.keys().next().value;
    if (oldestSendId !== undefined) stopTerminalOutcomes.delete(oldestSendId);
  };

  const consumeStopTerminalOutcome = (
    sendId: string,
  ): PromptPersistence | undefined => {
    const outcome = stopTerminalOutcomes.get(sendId);
    if (outcome !== undefined) stopTerminalOutcomes.delete(sendId);
    return outcome;
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

  const resolveAllConfirmations = (apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      pending.resolve(apply);
      broadcast({
        type: "confirm_resolved",
        sendId: pending.sendId,
        sessionId: pending.sessionId,
        id,
      });
    }
    pendingConfirmations.clear();
  };

  const resolveConfirmationsForSend = (sendId: string, apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      if (pending.sendId !== sendId) continue;
      pendingConfirmations.delete(id);
      pending.resolve(apply);
      broadcast({
        type: "confirm_resolved",
        sendId,
        sessionId: pending.sessionId,
        id,
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

  const buildBridgeState = async (): Promise<ChatDialogState> =>
    stateWithActivities(await options.buildState());

  const updateActivity = (
    sessionId: string,
    sendId: string,
    status: ChatSessionActivityStatus,
    update: { message?: string; unread?: boolean } = {},
  ) => {
    const current = sessionActivities.get(sessionId);
    const message = update.message ?? current?.message;
    sessionActivities.set(sessionId, {
      sessionId,
      sendId,
      status,
      ...(message === undefined ? {} : { message }),
      unread: update.unread ?? current?.unread ?? false,
    });
  };

  const createStream = (
    sendId: string,
    sessionId: string,
    onSessionEvent: (event: SessionEvent) => void,
  ): ChatBridgeStream => ({
    assistantDelta: async (delta) => {
      broadcast({ type: "assistant_delta", sendId, sessionId, delta });
    },
    assistantReset: async () => {
      broadcast({ type: "assistant_reset", sendId, sessionId });
    },
    webSearchUpdate: async (update) => {
      broadcast({ type: "web_search_update", sendId, sessionId, update });
    },
    sessionEvent: async (event) => {
      onSessionEvent(event);
      broadcast({ type: "session_event", sendId, sessionId, event });
    },
    progress: async (message) => {
      updateActivity(sessionId, sendId, "running", { message });
      broadcast({ type: "progress", sendId, sessionId, message });
    },
    requestConfirmation: (request) => {
      const activeSend = activeSendsById.get(sendId);
      if (!activeSend || closing || activeSend.steering.hasPending()) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const id = randomUUID();
        pendingConfirmations.set(id, { sendId, sessionId, request, resolve });
        updateActivity(sessionId, sendId, "waiting_confirmation", {
          message: "Waiting for confirmation",
        });
        broadcast({
          type: "confirm_request",
          sendId,
          sessionId,
          id,
          message: request.message,
          groups: request.groups,
        });
      });
    },
  });

  const server = createServer(async (request, response) => {
    let resolveHandlerTerminal!: () => void;
    const handlerTerminal = new Promise<void>((resolve) => {
      resolveHandlerTerminal = resolve;
    });
    let requestPath = "";
    let sendId: string | undefined;
    let sendSessionId: string | undefined;
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
      if (request.method === "POST" && requestPath === "/send") {
        sendPromptPersistence = "not_persisted";
      }
      if (closing) {
        if (attachmentBodyMayBeUnread) request.resume();
        if (skillBodyMayBeUnread) request.resume();
        sendJson(response, {
          error: "Live Smith bridge is closing.",
          ...(sendPromptPersistence ? { promptPersistence: sendPromptPersistence } : {}),
        }, 503);
        return;
      }

      if (url.searchParams.get("token") !== token) {
        if (attachmentBodyMayBeUnread) request.resume();
        if (skillBodyMayBeUnread) request.resume();
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
        readOnlyResponses.add(response);
        const state = await buildBridgeState();
        if (closing || response.destroyed) return;
        sendHtml(
          response,
          options.renderHtml(state, { baseUrl: bridgeBaseUrl(server), token }),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        readOnlyResponses.add(response);
        await waitForStateMutations();
        if (closing || response.destroyed) return;
        sendJson(response, await buildBridgeState());
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
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
          });
        }
        for (const [id, pending] of pendingConfirmations) {
          writeSse(response, {
            type: "confirm_request",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id,
            message: pending.request.message,
            groups: pending.request.groups,
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
        const state = stateWithActivities(await options.handleAttachmentUpload({
          ...query,
          bytes,
        }, controller.signal));
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
        const state = stateWithActivities(
          await options.handleAttachmentDelete(input, controller.signal),
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
          const state = stateWithActivities(result.state);
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
          const state = stateWithActivities(
            await options.handleSkillDelete(input, controller.signal),
          );
          broadcast({ type: "state", commandId, state });
          sendJson(response, state);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/command") {
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
          const state = stateWithActivities(commandState);
          broadcast({ type: "state", commandId, state });
          sendJson(response, state);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        sendId = sendIdForRequest(request);
        if (activeCommandTerminal) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        const input = parseSendInput(await readRequestBody<unknown>(request));
        sendSessionId = input.sessionId;
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
        };
        stopTerminalOutcomes.delete(sendId);
        activeSendsById.set(sendId, activeSend);
        activeSendsBySession.set(input.sessionId, activeSend);
        updateActivity(input.sessionId, sendId, "running", {
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
          updateActivity(input.sessionId, sendId, "completed", {
            message: "Completed",
            unread: baseState.activeSessionId !== input.sessionId,
          });
          const state = stateWithActivities(baseState);
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
            retainStopTerminalOutcome(
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
            broadcast({
              type: "steer_accepted",
              sendId: targetSendId,
              sessionId: input.sessionId,
              steerId,
            });
            sendJson(response, { ok: true });
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
        broadcast({
          type: "steer_accepted",
          sendId: targetSendId,
          sessionId: input.sessionId,
          steerId,
        });
        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/confirm") {
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
          updateActivity(pending.sessionId, pending.sendId, "running", {
            message: apply ? "Applying confirmed changes" : "Continuing after cancellation",
          });
          broadcast({
            type: "confirm_resolved",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id: input.id,
          });
        }
        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        const stoppedSendId = stopSendIdForRequest(request);
        assertOnlyInputKeys(
          inputRecord(await readRequestBody<unknown>(request)),
          [],
          "Stop request",
        );
        const activeSend = activeSendsById.get(stoppedSendId);
        if (activeSend) {
          activeSend.stopRequested = true;
          resolveConfirmationsForSend(stoppedSendId, false);
          updateActivity(activeSend.sessionId, stoppedSendId, "stopped", {
            message: "Stopped",
          });
          const stoppedError = new SteeringClosedError("Stopped by user.");
          activeSend.steering.close(stoppedError);
          activeSend.controller.abort(stoppedError);
        }
        const terminal = activeSend === undefined;
        const promptPersistence = terminal
          ? consumeStopTerminalOutcome(stoppedSendId) ?? "unknown"
          : undefined;
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
      let commandState: ChatDialogState | undefined;
      let sendErrorState: ChatDialogState | undefined;
      let reconciliationRequired: true | undefined;
      if (commandOutcome === "unknown") {
        if (
          reportedError instanceof ChatBridgeCommandOutcomeUnknownError &&
          reportedError.authoritativeStateAttempted
        ) {
          if (reportedError.authoritativeState === undefined) {
            reconciliationRequired = true;
          } else {
            commandState = stateWithActivities(reportedError.authoritativeState);
          }
        } else try {
          commandState = await buildBridgeState();
        } catch {
          reconciliationRequired = true;
        }
      }
      if (requestPath === "/send" && sendId && sendSessionId) {
        const activity = sessionActivities.get(sendSessionId);
        if (activity?.status !== "stopped") {
          updateActivity(sendSessionId, sendId, "failed", { message });
        }
        const baseState = error instanceof ChatBridgeSendFailureError
          ? error.authoritativeState
          : undefined;
        if (baseState !== undefined) {
          const failedActivity = sessionActivities.get(sendSessionId);
          if (failedActivity) {
            failedActivity.unread = baseState.activeSessionId !== sendSessionId;
          }
          sendErrorState = stateWithActivities(baseState);
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
      if (activeCommandTerminal === handlerTerminal) activeCommandTerminal = null;
      if (
        attachmentSessionId !== undefined &&
        activeAttachmentTerminals.get(attachmentSessionId) === handlerTerminal
      ) {
        activeAttachmentTerminals.delete(attachmentSessionId);
        activeAttachmentControllers.delete(attachmentSessionId);
      }
      inFlightMutationHandlers.delete(handlerTerminal);
      readOnlyResponses.delete(response);
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
      broadcast({ type: "approval_mode_changed", sessionId, approvalMode });
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
      broadcast({
        type: "default_follow_up_behavior_changed",
        ...change,
      });
    },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const mutationTerminals = [...inFlightMutationHandlers];
      const pendingReads = [...readOnlyResponses];
      const connectedClients = [...clients];
      clients.clear();
      readOnlyResponses.clear();
      stopTerminalOutcomes.clear();
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
      for (const response of pendingReads) response.destroy();
      for (const client of connectedClients) client.end();

      closePromise = (async () => {
        await Promise.allSettled(mutationTerminals);
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

function sendIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-send-id"];
  if (raw === undefined) return randomUUID();
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Send-Id must be a valid correlation ID.",
    );
  }
  return raw;
}

function stopSendIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-send-id"];
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Send-Id must identify the send to stop.",
    );
  }
  return raw;
}

function steeringSendIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-send-id",
    "X-Live-Smith-Send-Id must identify the send to steer.",
  );
}

function steeringIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-steer-id",
    "X-Live-Smith-Steer-Id must be a valid unique correlation ID.",
  );
}

function requiredCorrelationId(
  request: IncomingMessage,
  headerName: string,
  errorMessage: string,
): string {
  const raw = singleHeaderValue(request, headerName, true);
  if (
    raw === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(errorMessage);
  }
  return raw;
}

function commandIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-command-id"];
  if (raw === undefined) return randomUUID();
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Command-Id must be a valid correlation ID.",
    );
  }
  return raw;
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

export async function readJsonBody<T>(
  request: AsyncIterable<string | Uint8Array>,
): Promise<T> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxRequestBodyBytes) {
      throw new ChatBridgeRequestValidationError(
        `Request body exceeds ${maxRequestBodyBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch (cause) {
    throw new ChatBridgeRequestValidationError(
      "Request body must contain valid JSON.",
      { cause },
    );
  }
}

export function readRawAttachmentBody(
  request: IncomingMessage,
  options: RawAttachmentBodyReadOptions = {},
): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    assertAttachmentContentType(request);
    declaredLength = boundedContentLength(
      request,
      "Attachment",
      MAX_DOCUMENT_ATTACHMENT_BYTES,
    );
    if (declaredLength === 0) {
      throw new ChatBridgeRequestValidationError("Attachment body must not be empty.");
    }
  } catch (error) {
    request.resume();
    throw error;
  }

  return readBoundedRawBody(request, declaredLength, {
    maximumBytes: MAX_DOCUMENT_ATTACHMENT_BYTES,
    initialCapacity: initialUnknownAttachmentBodyCapacity,
    timeoutMs: options.timeoutMs ?? defaultAttachmentBodyReadTimeoutMs,
    allocateBuffer: options.allocateBuffer ?? Buffer.allocUnsafe,
    acquirePermit: acquireAttachmentBodyReadPermit,
    emptyMessage: "Attachment body must not be empty.",
    tooLargeMessage:
      `Attachment uploads may not exceed ${MAX_DOCUMENT_ATTACHMENT_BYTES} bytes.`,
    mismatchMessage: "Attachment Content-Length does not match the received body.",
    timeoutMessage: "Attachment upload timed out before the complete body was received.",
    incompleteMessage: "Attachment upload ended before the complete body was received.",
    readErrorMessage: "Attachment upload could not be read.",
    bufferErrorMessage: "Attachment upload could not be buffered.",
  });
}

export function readRawSkillBody(
  request: IncomingMessage,
  options: RawSkillBodyReadOptions = {},
): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    assertSkillContentType(request);
    declaredLength = boundedContentLength(
      request,
      "Skill",
      MAX_SKILL_FILE_BYTES,
    );
    if (declaredLength === 0) {
      throw new ChatBridgeRequestValidationError(
        "Skill body must not be empty.",
      );
    }
  } catch (error) {
    request.resume();
    throw error;
  }

  return readBoundedRawBody(request, declaredLength, {
    maximumBytes: MAX_SKILL_FILE_BYTES,
    initialCapacity: initialUnknownSkillBodyCapacity,
    timeoutMs: options.timeoutMs ?? defaultSkillBodyReadTimeoutMs,
    allocateBuffer: options.allocateBuffer ?? Buffer.allocUnsafe,
    acquirePermit: acquireSkillBodyReadPermit,
    emptyMessage: "Skill body must not be empty.",
    tooLargeMessage: `Skill uploads may not exceed ${MAX_SKILL_FILE_BYTES} bytes.`,
    mismatchMessage: "Skill Content-Length does not match the received body.",
    timeoutMessage: "Skill upload timed out before the complete body was received.",
    incompleteMessage: "Skill upload ended before the complete body was received.",
    readErrorMessage: "Skill upload could not be read.",
    bufferErrorMessage: "Skill upload could not be buffered.",
  });
}

interface BoundedRawBodyPolicy {
  maximumBytes: number;
  initialCapacity: number;
  timeoutMs: number;
  allocateBuffer(byteLength: number): Buffer;
  acquirePermit(): () => void;
  emptyMessage: string;
  tooLargeMessage: string;
  mismatchMessage: string;
  timeoutMessage: string;
  incompleteMessage: string;
  readErrorMessage: string;
  bufferErrorMessage: string;
}

function readBoundedRawBody(
  request: IncomingMessage,
  declaredLength: number | undefined,
  policy: BoundedRawBodyPolicy,
): Promise<Uint8Array> {
  let releasePermit: () => void;
  try {
    releasePermit = policy.acquirePermit();
  } catch (error) {
    request.resume();
    throw error;
  }
  let body: Buffer | undefined;
  try {
    body = declaredLength === undefined
      ? undefined
      : policy.allocateBuffer(declaredLength);
  } catch (cause) {
    releasePermit();
    request.resume();
    throw new Error(policy.bufferErrorMessage, { cause });
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    let actualLength = 0;
    let ended = false;
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new ChatBridgeRequestTimeoutError(policy.timeoutMessage), true);
    }, policy.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("close", onClose);
      request.off("error", onError);
      releasePermit();
    };
    const fail = (error: Error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const buffer = typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const nextLength = actualLength + buffer.byteLength;
      if (nextLength > policy.maximumBytes) {
        fail(new ChatBridgePayloadTooLargeError(policy.tooLargeMessage), true);
        return;
      }
      if (declaredLength !== undefined && nextLength > declaredLength) {
        fail(new ChatBridgeRequestValidationError(policy.mismatchMessage), true);
        return;
      }
      if (body === undefined || nextLength > body.byteLength) {
        let nextCapacity = body?.byteLength ?? policy.initialCapacity;
        while (nextCapacity < nextLength) {
          nextCapacity = Math.min(policy.maximumBytes, nextCapacity * 2);
        }
        try {
          const expanded = policy.allocateBuffer(nextCapacity);
          body?.copy(expanded, 0, 0, actualLength);
          body = expanded;
        } catch (cause) {
          fail(new Error(policy.bufferErrorMessage, { cause }), true);
          return;
        }
      }
      buffer.copy(body, actualLength);
      actualLength = nextLength;
    };
    const onEnd = () => {
      ended = true;
      if (settled) return;
      if (actualLength === 0) {
        fail(new ChatBridgeRequestValidationError(policy.emptyMessage));
        return;
      }
      if (declaredLength !== undefined && declaredLength !== actualLength) {
        fail(new ChatBridgeRequestValidationError(policy.mismatchMessage));
        return;
      }
      settled = true;
      cleanup();
      resolve(body!.subarray(0, actualLength));
    };
    const onAborted = () => fail(
      new ChatBridgeRequestValidationError(policy.incompleteMessage),
    );
    const onClose = () => {
      if (!ended) onAborted();
    };
    const onError = () => fail(
      new ChatBridgeRequestValidationError(policy.readErrorMessage),
    );

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("close", onClose);
    request.once("error", onError);
  });
}

function acquireAttachmentBodyReadPermit(): () => void {
  if (activeAttachmentBodyReads >= maxConcurrentAttachmentBodyReads) {
    throw new ChatBridgeConflictError(
      "Too many attachment uploads are being received. Try again shortly.",
    );
  }
  activeAttachmentBodyReads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAttachmentBodyReads -= 1;
  };
}

function acquireSkillBodyReadPermit(): () => void {
  if (activeSkillBodyReads >= maxConcurrentSkillBodyReads) {
    throw new ChatBridgeConflictError(
      "Too many Skill uploads are being received. Try again shortly.",
    );
  }
  activeSkillBodyReads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSkillBodyReads -= 1;
  };
}

function parseAttachmentUploadQuery(
  request: IncomingMessage,
  url: URL,
): Omit<ChatBridgeAttachmentInput, "bytes"> {
  assertAttachmentQuery(request, url, ["token", "sessionId", "fileName"]);
  const sessionId = attachmentSessionId(url);
  const fileName = singleAttachmentQueryValue(url, "fileName");
  if (
    !fileName.trim() ||
    Buffer.byteLength(fileName, "utf8") > maxAttachmentFileNameUtf8Bytes
  ) {
    throw new ChatBridgeRequestValidationError(
      `fileName must contain 1-${maxAttachmentFileNameUtf8Bytes} UTF-8 bytes.`,
    );
  }
  const claimedMediaType = singleHeaderValue(
    request,
    "x-live-smith-file-type",
    false,
  );
  let normalizedClaimedMediaType: string | undefined;
  if (claimedMediaType !== undefined) {
    if (
      Buffer.byteLength(claimedMediaType, "utf8") > 128 ||
      !isSingleMimeType(claimedMediaType)
    ) {
      throw new ChatBridgeRequestValidationError(
        "X-Live-Smith-File-Type must be one valid MIME type.",
      );
    }
    normalizedClaimedMediaType = claimedMediaType.toLowerCase();
  }
  return {
    sessionId,
    fileName,
    ...(normalizedClaimedMediaType === undefined
      ? {}
      : { claimedMediaType: normalizedClaimedMediaType }),
  };
}

function isSingleMimeType(value: string): boolean {
  return mimeTypePattern.test(value);
}

function parseAttachmentDeleteQuery(
  request: IncomingMessage,
  url: URL,
): ChatBridgeAttachmentDeleteInput {
  assertAttachmentQuery(request, url, ["token", "sessionId"]);
  const encodedId = url.pathname.slice("/attachments/".length);
  if (!encodedId || encodedId.includes("/")) {
    throw new ChatBridgeRequestValidationError("Attachment ID is invalid.");
  }
  let attachmentId: string;
  try {
    attachmentId = decodeURIComponent(encodedId);
    requireSafeStorageId(attachmentId, "Attachment ID");
  } catch {
    throw new ChatBridgeRequestValidationError("Attachment ID is invalid.");
  }
  return { sessionId: attachmentSessionId(url), attachmentId };
}

function parseSkillInstallQuery(
  request: IncomingMessage,
  url: URL,
): { replace: boolean } {
  assertSkillQuery(request, url, ["token", "replace"]);
  const values = url.searchParams.getAll("replace");
  if (values.length === 0) return { replace: false };
  if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false")) {
    throw new ChatBridgeRequestValidationError(
      "replace must be true or false when provided.",
    );
  }
  return { replace: values[0] === "true" };
}

function parseSkillDeleteQuery(
  request: IncomingMessage,
  url: URL,
): ChatBridgeSkillDeleteInput {
  assertSkillQuery(request, url, ["token"]);
  const encodedId = url.pathname.slice("/skills/".length);
  if (!encodedId || encodedId.includes("/")) {
    throw new ChatBridgeRequestValidationError("Skill ID is invalid.");
  }
  let skillId: string;
  try {
    skillId = decodeURIComponent(encodedId);
  } catch {
    throw new ChatBridgeRequestValidationError("Skill ID is invalid.");
  }
  if (!isSafeSkillId(skillId)) {
    throw new ChatBridgeRequestValidationError("Skill ID is invalid.");
  }
  return { skillId };
}

function assertSkillQuery(
  request: IncomingMessage,
  url: URL,
  allowedKeys: readonly string[],
): void {
  if (Buffer.byteLength(request.url ?? "", "utf8") > maxAttachmentQueryUtf8Bytes) {
    throw new ChatBridgeRequestValidationError("Skill request query is too long.");
  }
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ChatBridgeRequestValidationError(
        `Skill request does not support query parameter ${key}.`,
      );
    }
  }
  if (url.searchParams.getAll("token").length !== 1) {
    throw new ChatBridgeRequestValidationError(
      "token must appear exactly once in the Skill request.",
    );
  }
}

function assertAttachmentQuery(
  request: IncomingMessage,
  url: URL,
  allowedKeys: readonly string[],
): void {
  if (Buffer.byteLength(request.url ?? "", "utf8") > maxAttachmentQueryUtf8Bytes) {
    throw new ChatBridgeRequestValidationError("Attachment request query is too long.");
  }
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ChatBridgeRequestValidationError(
        `Attachment request does not support query parameter ${key}.`,
      );
    }
  }
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ChatBridgeRequestValidationError(
        `${key} must appear exactly once in the attachment request.`,
      );
    }
  }
}

function attachmentSessionId(url: URL): string {
  const sessionId = singleAttachmentQueryValue(url, "sessionId");
  try {
    return requireSafeStorageId(sessionId, "Session ID");
  } catch {
    throw new ChatBridgeRequestValidationError("Session ID is invalid.");
  }
}

function singleAttachmentQueryValue(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1) {
    throw new ChatBridgeRequestValidationError(
      `${key} must appear exactly once in the attachment request.`,
    );
  }
  return values[0]!;
}

function assertAttachmentContentType(request: IncomingMessage): void {
  const contentType = singleHeaderValue(request, "content-type", true);
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    throw new ChatBridgeRequestValidationError(
      "Attachment uploads require Content-Type application/octet-stream.",
    );
  }
}

function assertSkillContentType(request: IncomingMessage): void {
  const contentType = singleHeaderValue(request, "content-type", true);
  if (
    contentType === undefined ||
    !/^text\/markdown\s*;\s*charset\s*=\s*utf-8\s*$/i.test(contentType)
  ) {
    throw new ChatBridgeRequestValidationError(
      "Skill uploads require Content-Type text/markdown; charset=utf-8.",
    );
  }
}

function boundedContentLength(
  request: IncomingMessage,
  label: string,
  maximumBytes: number,
): number | undefined {
  const raw = singleHeaderValue(request, "content-length", false);
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new ChatBridgeRequestValidationError(
      `${label} Content-Length must be a non-negative integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximumBytes) {
    throw new ChatBridgePayloadTooLargeError(
      `${label} uploads may not exceed ${maximumBytes} bytes.`,
    );
  }
  return value;
}

function singleHeaderValue(
  request: IncomingMessage,
  name: string,
  required: boolean,
): string | undefined {
  const rawHeaders = request.rawHeaders ?? [];
  let occurrences = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      occurrences += 1;
    }
  }
  if (occurrences > 1) {
    throw new ChatBridgeRequestValidationError(`${name} must appear at most once.`);
  }
  const raw = request.headers[name];
  if (Array.isArray(raw)) {
    throw new ChatBridgeRequestValidationError(`${name} must appear at most once.`);
  }
  if (raw === undefined && required) {
    throw new ChatBridgeRequestValidationError(`${name} is required.`);
  }
  return raw;
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

function parseSendInput(value: unknown): ChatBridgeSendInput {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["prompt", "sessionId"], "Send request");
  return {
    prompt: inputString(input, "prompt"),
    sessionId: inputString(input, "sessionId"),
  };
}

function parseSteeringInput(value: unknown): ChatBridgeSteeringInput {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["prompt", "sessionId"], "Steering request");
  const prompt = inputString(input, "prompt");
  if (!prompt.trim()) {
    throw new ChatBridgeRequestValidationError(
      "prompt must be a non-empty string.",
    );
  }
  if (Buffer.byteLength(prompt, "utf8") > maxSteeringPromptUtf8Bytes) {
    throw new ChatBridgeRequestValidationError(
      `prompt may not exceed ${maxSteeringPromptUtf8Bytes} UTF-8 bytes.`,
    );
  }
  return {
    prompt,
    sessionId: inputString(input, "sessionId"),
  };
}

function parseCommandInput(value: unknown): ChatBridgeCommandInput {
  const input = inputRecord(value);
  const kind = inputString(input, "kind");
  if (kind === "save_global_settings") {
    assertOnlyInputKeys(
      input,
      ["kind", "defaultFollowUpBehavior"],
      `${kind} command`,
    );
    if (!isDefaultFollowUpBehavior(input.defaultFollowUpBehavior)) {
      throw new ChatBridgeRequestValidationError(
        "defaultFollowUpBehavior must be queue or steer.",
      );
    }
    return {
      kind,
      defaultFollowUpBehavior: input.defaultFollowUpBehavior,
    };
  }
  if (kind === "save_profile" || kind === "discover_models") {
    assertOnlyInputKeys(input, ["kind", "profile"], `${kind} command`);
    if (!isRecord(input.profile)) {
      throw new ChatBridgeRequestValidationError("profile must be an object.");
    }
    return { kind, profile: input.profile as unknown as DraftProfile };
  }
  if (kind === "delete_profile" || kind === "activate_profile") {
    assertOnlyInputKeys(input, ["kind", "profileId"], `${kind} command`);
    return { kind, profileId: inputString(input, "profileId") };
  }
  if (kind === "set_session_approval_mode") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "approvalMode"],
      `${kind} command`,
    );
    if (!isApprovalMode(input.approvalMode)) {
      throw new ChatBridgeRequestValidationError(
        "approvalMode must be manual, low-risk, or everything.",
      );
    }
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      approvalMode: input.approvalMode,
    };
  }
  if (kind === "new_session") {
    assertOnlyInputKeys(input, ["kind"], `${kind} command`);
    return { kind };
  }
  if (
    kind === "select_session" ||
    kind === "restore_session" ||
    kind === "delete_session" ||
    kind === "archive_session" ||
    kind === "unarchive_session" ||
    kind === "attach_selected_audio_source"
  ) {
    assertOnlyInputKeys(input, ["kind", "sessionId"], `${kind} command`);
    return { kind, sessionId: inputString(input, "sessionId") };
  }
  if (kind === "rename_session") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "title"],
      `${kind} command`,
    );
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      title: inputString(input, "title"),
    };
  }
  if (kind === "set_session_skills") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "skillIds"],
      `${kind} command`,
    );
    const skillIds = input.skillIds;
    if (
      !Array.isArray(skillIds) ||
      skillIds.length > 4 ||
      !skillIds.every(isSafeSkillId) ||
      new Set(skillIds).size !== skillIds.length
    ) {
      throw new ChatBridgeRequestValidationError(
        "skillIds must contain at most four unique safe Skill IDs.",
      );
    }
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      skillIds: [...skillIds],
    };
  }
  throw new ChatBridgeRequestValidationError(`Unsupported command ${kind}.`);
}

function parseConfirmationInput(
  value: unknown,
): { id: string; apply: boolean } {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["id", "apply"], "Confirmation request");
  const id = inputString(input, "id");
  if (!id.trim()) {
    throw new ChatBridgeRequestValidationError("id must be a non-empty string.");
  }
  if (typeof input.apply !== "boolean") {
    throw new ChatBridgeRequestValidationError("apply must be a boolean.");
  }
  return { id, apply: input.apply };
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

function inputRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChatBridgeRequestValidationError("Request body must be an object.");
  }
  return value;
}

function inputString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ChatBridgeRequestValidationError(`${key} must be a string.`);
  }
  return value;
}

function assertOnlyInputKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new ChatBridgeRequestValidationError(
      `${label} does not support property ${unknown}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
