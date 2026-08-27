import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import * as fs from "node:fs";
import { URL } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";

import {
  incrementDefaultFollowUpBehaviorRevision,
  type ModelAdvancedSettings,
  type GenerationParameters,
  type SavedProfile,
} from "../model/profile.js";
import {
  availableSkillSummaries,
  isBuiltInSkillId,
} from "../skills/builtins.js";
import { buildMarkdownRendererScript } from "../../scripts/build-markdown-renderer.js";
import type { ChatBridgeState, ChatDialogState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";
import { isEditScopes, resolveEditScopes, type EditScope } from "../agent/edit-scopes.js";

interface BridgeCall {
  path: string;
  body: BodyInit | null | undefined;
  headers?: HeadersInit;
  jsonBody?: unknown;
  url: string;
}

interface ParsedBridgeCall {
  path: string;
  body: unknown;
}

interface DialogHarness {
  acceptAppConfirmation(): Promise<void>;
  calls: BridgeCall[];
  clipboardWrites: string[];
  commandIds: string[];
  click(selector: string): void;
  clickButton(label: string): void;
  close(): void;
  cancelAppConfirmation(): Promise<void>;
  document: Document;
  deferServerEvent(payload: unknown): unknown;
  emitServerEvent(payload: unknown): void;
  emitRawServerEvent(payload: unknown): void;
  emitServerEventError(): void;
  emitServerEventOpen(): void;
  errors: unknown[];
  eventSourceUrls: string[];
  failNextCommand(
    error: string,
    field?: string,
    details?: {
      commandOutcome?: "unknown";
      reconciliationRequired?: boolean;
      state?: ChatBridgeState;
      status?: number;
    },
  ): void;
  failNextConfirmation(error: string): void;
  failNextSend(
    error: string,
    promptPersistence?: string,
    details?: {
      sendFailureKind?: "session_unavailable";
      state?: ChatBridgeState;
    },
  ): void;
  failNextSteer(error: string, steeringOutcome?: "unknown"): void;
  rejectNextSteerResponseAfterCommit(error: string): void;
  rejectNextConfirmationResponseAfterCommit(error: string): void;
  failNextState(error: string): void;
  failNextAttachmentUnknown(
    error: string,
    committedMetadata?: {
      fileName?: string;
      mediaType?: ChatDialogState["pendingAttachments"][number]["mediaType"];
      sha256?: string;
    },
  ): void;
  failAttachmentNamed(fileName: string, error: string, status?: number): void;
  rejectNextAttachmentAfterCommit(error: string): void;
  truncateNextAttachmentResponseAfterCommit(): void;
  rejectNextSkillResponseAfterCommit(error: string): void;
  truncateNextSkillResponseAfterCommit(): void;
  flushAnimationFrames(): number;
  rejectNextSend(error: string): void;
  omitNextSendState(): void;
  rejectNextCommand(error: string): void;
  rejectNextCommandResponse(error: string): void;
  omitNextCommandId(): void;
  truncateNextCommandResponseAfterCommit(): void;
  rejectNextState(error: string): void;
  holdNextCommand(): void;
  holdNextCommandResponse(): void;
  holdNextConfirmation(): void;
  holdNextSend(): void;
  holdNextSteer(): void;
  holdNextState(): void;
  holdNextAttachment(): void;
  hostMessages: unknown[];
  input(selector: string, value: string): void;
  releaseHeldCommand(): void;
  releaseHeldCommandResponse(): void;
  releaseHeldConfirmation(): void;
  releaseHeldSend(): void;
  releaseHeldSteer(): void;
  releaseHeldState(): void;
  releaseHeldAttachment(): void;
  queueStopTerminals(...values: boolean[]): void;
  queueStopOutcomes(
    ...values: Array<{
      terminal: boolean;
      promptPersistence?: "persisted" | "not_persisted" | "unknown";
      sendId?: string;
    }>
  ): void;
  sendIds: string[];
  queueNextStatePublication(
    bridgeStateRevision: string,
    bridgeStateCoveredThroughRevision: string,
  ): void;
  setServerState(state: ChatBridgeState): void;
  stopIds: string[];
  select(selector: string, value: string): void;
  dispatchPaste(files?: File[], text?: string): boolean;
  dispatchDrop(files: File[]): boolean;
  dispatchDragOver(files: File[]): boolean;
  dropAttachmentFiles(files: File[]): void;
  dropSkillFile(file: File): boolean;
  settle(): Promise<void>;
  settleAttachmentOperation(): Promise<void>;
  window: JSDOM["window"];
}

const chatTemplate = fs.readFileSync(
  new URL("./templates/chat-dialog.html", import.meta.url),
  "utf8",
);
const markdownRendererScript = await buildMarkdownRendererScript(false);
const clientScripts = {
  attachments: readClientScript("attachments"),
  bootstrap: readClientScript("bootstrap"),
  bridgeClient: readClientScript("bridge-client"),
  hostAdapter: readClientScript("host-adapter"),
  markdownRenderer: markdownRendererScript,
  profileEditor: readClientScript("profile-editor"),
  sessionTimeline: readClientScript("session-timeline"),
  skillManager: readClientScript("skill-manager"),
};

function renderChatHtml(
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string },
): string {
  return composeChatDocument(chatTemplate, state, bridge, clientScripts);
}

function readClientScript(name: string): string {
  return fs.readFileSync(
    new URL(`./client/${name}.script.html`, import.meta.url),
    "utf8",
  );
}

function capabilities(): ChatDialogState["capabilities"] {
  return {
    tools: true,
    streaming: true,
    temperature: "supported",
    maxOutputTokens: 8192,
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none",
    },
    inputs: { image: false, audio: false, pdf: false },
  };
}

function capabilityEvidence(): ChatDialogState["capabilityEvidence"] {
  return {
    temperature: "supported",
    maxOutputTokens: "verified",
    contextWindowTokens: "unverified",
    reasoning: "unsupported",
    inputs: {
      image: "unsupported",
      audio: "unsupported",
      pdf: "unsupported",
    },
  };
}

function unverifiedCapabilityEvidence(): ChatDialogState["capabilityEvidence"] {
  return {
    temperature: "unverified",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "unverified",
    inputs: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  };
}

function inputCapabilityEvidence(
  image: "supported" | "unsupported" | "unverified" = "unverified",
  pdf: "supported" | "unsupported" | "unverified" = "unverified",
): NonNullable<ChatDialogState["runtimeProfile"]>["inputCapabilityEvidence"] {
  return { image, audio: "unverified", pdf };
}

interface ProfileFixtureOverrides {
  id?: string;
  name?: string;
  connection?: SavedProfile["connection"];
  defaultModel?: string;
  models?: SavedProfile["models"];
  model?: string;
  parameters?: GenerationParameters;
  advanced?: ModelAdvancedSettings;
}

function profileFixture(overrides: ProfileFixtureOverrides = {}): SavedProfile {
  const connection = overrides.connection ?? {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "chat-completions",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    };
  const model = overrides.model ?? overrides.defaultModel ?? "model-a";
  const parameters = overrides.parameters ?? {
      maxOutputTokens: 8192,
      temperature: 0.4,
      reasoning: { mode: "default" },
    };
  const models = overrides.models ?? [{
    model,
    parameters: connection.kind === "codex-subscription"
      ? { reasoning: parameters.reasoning }
      : parameters as GenerationParameters & { maxOutputTokens: number },
    advanced: connection.kind === "codex-subscription"
      ? {}
      : overrides.advanced ?? {},
  }];
  return {
    id: overrides.id ?? "profile-1",
    name: overrides.name ?? "Studio",
    connection,
    defaultModel: overrides.defaultModel ?? model,
    models,
  } as SavedProfile;
}

function modelStateSourceFixture(profile: SavedProfile) {
  const model = profile.models.find(
    (entry) => entry.model === profile.defaultModel,
  )?.model ?? profile.models[0]?.model ?? profile.defaultModel;
  return {
    profileId: profile.id,
    connection: profile.connection.kind === "direct-api"
      ? {
          ...profile.connection,
          baseUrl: profile.connection.baseUrl.replace(/\/+$/, ""),
          apiKey: profile.connection.apiKey.trim(),
        }
      : { ...profile.connection },
    model,
  };
}

export function profileRevisionFixture(profile: SavedProfile): string {
  return createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
}

function stateFixture(): ChatBridgeState {
  return {
    bridgeStateRevision: "1",
    bridgeStateCoveredThroughRevision: "0",
    contextSummary: "Selected track: Bass",
    sessionContinueTarget: { kind: "track", label: "Drums" },
    sessions: [
      {
        id: "session-1",
        title: "Bass session",
        projectKey: "project-1",
        scope: { kind: "track", identity: "track-bass", label: "Bass" },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "session-2",
        title: "Lead session",
        projectKey: "project-1",
        scope: { kind: "track", identity: "track-lead", label: "Lead" },
        approvalMode: "low-risk",
        createdAt: "2026-08-01T00:01:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
    ],
    previousSessions: [],
    archivedSessions: [],
    activeSessionId: "session-1",
    approvalMode: "manual",
    events: [],
    pendingAttachments: [],
    availableSkills: availableSkillSummaries([]),
    activeSkillIds: [],
    capabilities: capabilities(),
    capabilityEvidence: capabilityEvidence(),
    availableModels: [],
    configuredModels: [{ model: "model-a", label: "model-a" }],
    configuredModelsReady: true,
    modelStateSource: modelStateSourceFixture(profileFixture()),
    runtimeProfile: runtimeSummaryForHarnessProfile(profileFixture()),
    activeProfileRevision: profileRevisionFixture(profileFixture()),
    codexAuth: { status: "signed-out" },
    codexAuthGeneration: 0,
    settings: {
      schemaVersion: 5,
      activeProfileId: "profile-1",
      approvalMode: "manual",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      profiles: [
        profileFixture(),
        profileFixture({
          id: "profile-2",
          name: "Mix review",
          connection: {
            kind: "direct-api",
            apiFamily: "anthropic",
            apiMode: "messages",
            apiKey: "test-key",
            baseUrl: "https://example.test/v1",
          },
          model: "model-b",
        }),
      ],
    },
    openSettingsOnLoad: true,
  };
}

function imageCapableState(): ChatBridgeState {
  const state = stateFixture();
  state.runtimeProfile!.capabilities.inputs.image = true;
  state.runtimeProfile!.inputCapabilityEvidence.image = "supported";
  return state;
}

function audioCapableState(): ChatBridgeState {
  const state = stateFixture();
  state.runtimeProfile!.capabilities.inputs.audio = true;
  state.runtimeProfile!.inputCapabilityEvidence.audio = "supported";
  return state;
}

function cloneState<T>(state: T): T {
  return JSON.parse(JSON.stringify(state)) as T;
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function createDialogHarness(
  initialState: ChatBridgeState = stateFixture(),
  bridge = { baseUrl: "http://bridge.test", token: "test-token" },
  options: {
    webCryptoAvailable?: boolean;
    webCryptoDigestFails?: boolean;
    serverState?: ChatBridgeState;
    initialCommandError?: string;
    holdInitialCommandResponse?: boolean;
  } = {},
): Promise<DialogHarness> {
  const calls: BridgeCall[] = [];
  const clipboardWrites: string[] = [];
  const commandIds: string[] = [];
  const errors: unknown[] = [];
  const eventSourceUrls: string[] = [];
  const sendIds: string[] = [];
  const stopIds: string[] = [];
  const eventSources: Array<{
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
    onopen: (() => void) | null;
  }> = [];
  const hostMessages: unknown[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  let nextBridgeStateRevision = BigInt(initialState.bridgeStateRevision) + 1n;
  const queuedStatePublications: Array<{
    bridgeStateRevision: string;
    bridgeStateCoveredThroughRevision: string;
  }> = [];
  let nextCommandError: {
    error: string;
    field?: string;
    commandOutcome?: "unknown";
    reconciliationRequired?: boolean;
    state?: ChatBridgeState;
    status?: number;
  } | null = options.initialCommandError ? { error: options.initialCommandError } : null;
  let nextConfirmationError: { error: string } | null = null;
  let nextConfirmationResponseRejection: Error | null = null;
  let nextSendError: {
    error: string;
    promptPersistence?: string;
    sendFailureKind?: "session_unavailable";
    state?: ChatBridgeState;
  } | null = null;
  let nextSteerError: {
    error: string;
    steeringOutcome?: "unknown";
  } | null = null;
  let nextSteerResponseRejection: Error | null = null;
  let nextStateError: { error: string } | null = null;
  let nextSendRejection: Error | null = null;
  let omitNextSendStateResponse = false;
  let nextCommandRejection: Error | null = null;
  let nextCommandResponseRejection: Error | null = null;
  let omitNextCommandIdResponse = false;
  let truncatedCommandResponses = 0;
  let nextStateRejection: Error | null = null;
  let nextAttachmentRejection: Error | null = null;
  let truncatedAttachmentResponses = 0;
  const skillResponseRejections: Error[] = [];
  let truncatedSkillResponses = 0;
  let nextAttachmentUnknown: {
    error: string;
    committedMetadata?: {
      fileName?: string;
      mediaType?: ChatDialogState["pendingAttachments"][number]["mediaType"];
      sha256?: string;
    };
  } | null = null;
  const attachmentFailuresByName = new Map<
    string,
    { error: string; status: number }
  >();
  let heldCommand: Promise<void> | null = null;
  let heldCommandResponse: Promise<void> | null = null;
  let heldConfirmation: Promise<void> | null = null;
  const heldSends: Promise<void>[] = [];
  let heldSteer: Promise<void> | null = null;
  let heldState: Promise<void> | null = null;
  let heldAttachment: Promise<void> | null = null;
  let releaseCommand: (() => void) | null = null;
  let releaseCommandResponse: (() => void) | null = null;
  if (options.holdInitialCommandResponse) {
    heldCommandResponse = new Promise<void>((resolve) => {
      releaseCommandResponse = resolve;
    });
  }
  let releaseConfirmation: (() => void) | null = null;
  const releaseSends: Array<() => void> = [];
  let releaseSteer: (() => void) | null = null;
  let releaseState: (() => void) | null = null;
  let releaseAttachment: (() => void) | null = null;
  const stopTerminals: boolean[] = [];
  const stopOutcomes: Array<{
    terminal: boolean;
    promptPersistence?: "persisted" | "not_persisted" | "unknown";
    sendId?: string;
  }> = [];
  let serverState = cloneState(options.serverState ?? initialState);
  let fallbackSessionSequence = 0;
  const synchronizeActiveSessionProjection = (): void => {
    let active = serverState.sessions.find(
      (session) => session.id === serverState.activeSessionId,
    );
    if (!active && serverState.sessions.length === 0) {
      const template = initialState.sessions[0];
      assert.ok(template);
      fallbackSessionSequence += 1;
      active = {
        ...template,
        scope: { ...template.scope },
        ...(template.originScope === undefined
          ? {}
          : { originScope: { ...template.originScope } }),
        ...(template.activeSkillIds === undefined
          ? {}
          : { activeSkillIds: [...template.activeSkillIds] }),
        id: `session-fallback-${fallbackSessionSequence}`,
        title: "New session",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
      delete active.archivedAt;
      serverState.sessions = [active];
    }
    if (!active) active = serverState.sessions[0];
    if (!active) throw new Error("The harness requires an active Session.");
    if (active && serverState.activeSessionId !== active.id) {
      serverState.activeSessionId = active.id;
    }
    serverState.approvalMode = active?.approvalMode ?? "manual";
    serverState.activeSkillIds = [...(active?.activeSkillIds ?? [])];
    const profile = serverState.settings.profiles.find(
      (entry) => entry.id === serverState.settings.activeProfileId,
    );
    if (!profile) {
      serverState.runtimeProfile = null;
      serverState.configuredModels = [];
      serverState.configuredModelsReady = true;
      return;
    }
    const selectedModel = active.modelSelection?.profileId === profile.id &&
        profile.models.some((entry) => entry.model === active.modelSelection?.model)
      ? active.modelSelection.model
      : profile.defaultModel;
    const discovered = serverState.availableModels.find(
      (entry) => entry.id === selectedModel,
    );
    serverState.runtimeProfile = runtimeSummaryForHarnessProfile(
      profile,
      discovered?.capabilities ??
        serverState.runtimeProfile?.capabilities ?? capabilities(),
      discovered?.capabilityEvidence.inputs ??
        serverState.runtimeProfile?.inputCapabilityEvidence ??
        inputCapabilityEvidence(),
      selectedModel,
      active.modelSelection?.profileId === profile.id
        ? active.modelSelection.reasoningEffort
        : undefined,
    );
    serverState.configuredModels = profile.models.map((entry) => ({
      model: entry.model,
      label: entry.model,
    }));
    if (profile.connection.kind !== "codex-subscription") {
      serverState.configuredModelsReady = true;
    }
  };
  const pendingConfirmations = new Map<
    string,
    { confirmationGeneration: number; sendId: string; sessionId: string }
  >();
  const confirmationGenerations = new Map<
    string,
    { confirmationGeneration: number; sendId: string }
  >();
  const nextConfirmationGenerationBySend = new Map<string, number>();
  const modelTurnEpochsBySend = new Map<string, number>();
  const confirmationResolutionPublications = new Map<
    string,
    Record<string, unknown>
  >();
  const acceptedSteeringIds = new Set<string>();
  const activeSteeringRequests = new Map<
    string,
    { publication?: Record<string, unknown>; sseDelivered: boolean }
  >();
  const pendingSteeringSsePublications = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  const pendingAttachmentsBySession = new Map([
    [serverState.activeSessionId, cloneState(serverState).pendingAttachments],
  ]);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));

  const latestBridgeStateRevision = (): string =>
    String(nextBridgeStateRevision - 1n);

  const observeBridgeStateRevision = (revision: string): void => {
    if (!/^(?:0|[1-9][0-9]*)$/.test(revision)) return;
    const observed = BigInt(revision);
    if (observed >= nextBridgeStateRevision) {
      nextBridgeStateRevision = observed + 1n;
    }
  };

  const allocateBridgeStateRevision = (): string =>
    String(nextBridgeStateRevision++);

  const confirmationGenerationForEvent = (
    event: Record<string, unknown>,
  ): number | undefined => {
    if (
      event.type !== "confirm_request" &&
      event.type !== "confirm_resolved"
    ) return undefined;
    if (
      Number.isSafeInteger(event.confirmationGeneration) &&
      (event.confirmationGeneration as number) > 0
    ) {
      const explicit = event.confirmationGeneration as number;
      if (typeof event.id === "string" && typeof event.sendId === "string") {
        confirmationGenerations.set(event.id, {
          confirmationGeneration: explicit,
          sendId: event.sendId,
        });
        nextConfirmationGenerationBySend.set(
          event.sendId,
          Math.max(
            nextConfirmationGenerationBySend.get(event.sendId) ?? 1,
            explicit + 1,
          ),
        );
      }
      return explicit;
    }
    if (typeof event.id !== "string" || typeof event.sendId !== "string") {
      return undefined;
    }
    const known = confirmationGenerations.get(event.id);
    if (known?.sendId === event.sendId) return known.confirmationGeneration;
    const next = nextConfirmationGenerationBySend.get(event.sendId) ?? 1;
    nextConfirmationGenerationBySend.set(event.sendId, next + 1);
    confirmationGenerations.set(event.id, {
      confirmationGeneration: next,
      sendId: event.sendId,
    });
    return next;
  };

  const publishBridgeState = (
    state: ChatBridgeState,
    requestCutRevision: string,
  ): ChatBridgeState => {
    const override = queuedStatePublications.shift();
    const bridgeStateRevision = override?.bridgeStateRevision ??
      allocateBridgeStateRevision();
    if (override) observeBridgeStateRevision(bridgeStateRevision);
    const projected = cloneState(state);
    if (
      projected?.settings &&
      Array.isArray(projected.settings.profiles)
    ) {
      const activeProfile = projected.settings.profiles.find(
        (profile) => profile.id === projected.settings.activeProfileId,
      );
      projected.activeProfileRevision = activeProfile
        ? profileRevisionFixture(activeProfile)
        : null;
    }
    return {
      ...projected,
      bridgeStateRevision,
      bridgeStateCoveredThroughRevision:
        override?.bridgeStateCoveredThroughRevision ?? requestCutRevision,
    };
  };

  const publishErrorState = <T extends { state?: ChatBridgeState }>(
    error: T,
    requestCutRevision: string,
  ): T => error.state
    ? {
        ...error,
        state: publishBridgeState(error.state, requestCutRevision),
      }
    : error;

  const stateChangeEventTypes = new Set([
    "approval_mode_changed",
    "session_edit_scopes_changed",
    "confirm_request",
    "confirm_resolved",
    "default_follow_up_behavior_changed",
    "progress",
    "profile_settings_changed",
    "session_event",
    "session_model_selection_changed",
    "steer_accepted",
  ]);

  const applyServerProjectionPatch = (event: Record<string, unknown>): void => {
    if (
      event.type === "session_edit_scopes_changed" &&
      typeof event.sessionId === "string" &&
      isEditScopes(event.editScopes)
    ) {
      for (const sessions of [
        serverState.sessions,
        serverState.previousSessions,
        serverState.archivedSessions,
      ]) {
        const session = sessions.find((entry) => entry.id === event.sessionId);
        if (session) {
          session.editScopes = resolveEditScopes(event.editScopes);
          if (typeof event.updatedAt === "string") {
            session.updatedAt = event.updatedAt;
          }
        }
      }
      return;
    }
    if (
      event.type === "approval_mode_changed" &&
      typeof event.sessionId === "string" &&
      ["manual", "low-risk", "everything"].includes(String(event.approvalMode))
    ) {
      for (const sessions of [
        serverState.sessions,
        serverState.previousSessions,
        serverState.archivedSessions,
      ]) {
        const session = sessions.find((entry) => entry.id === event.sessionId);
        if (session) {
          session.approvalMode = event.approvalMode as
            ChatDialogState["approvalMode"];
          if (typeof event.updatedAt === "string") {
            session.updatedAt = event.updatedAt;
          }
        }
      }
      if (serverState.activeSessionId === event.sessionId) {
        serverState.approvalMode = event.approvalMode as
          ChatDialogState["approvalMode"];
      }
      return;
    }
    if (
      event.type === "session_model_selection_changed" &&
      typeof event.sessionId === "string" &&
      event.modelSelection &&
      typeof event.modelSelection === "object" &&
      !Array.isArray(event.modelSelection)
    ) {
      const selection = event.modelSelection as NonNullable<
        ChatDialogState["sessions"][number]["modelSelection"]
      >;
      for (const sessions of [
        serverState.sessions,
        serverState.previousSessions,
        serverState.archivedSessions,
      ]) {
        const session = sessions.find((entry) => entry.id === event.sessionId);
        if (session) {
          session.modelSelection = cloneState(selection);
          if (typeof event.updatedAt === "string") {
            session.updatedAt = event.updatedAt;
          }
        }
      }
      if (serverState.activeSessionId === event.sessionId) {
        synchronizeActiveSessionProjection();
      }
      return;
    }
    const activity = event.activity;
    if (
      typeof event.sessionId === "string" &&
      activity &&
      typeof activity === "object" &&
      !Array.isArray(activity) &&
      typeof (activity as { status?: unknown }).status === "string" &&
      typeof (activity as { message?: unknown }).message === "string"
    ) {
      const projected = activity as {
        status: NonNullable<ChatDialogState["sessionActivities"]>[number]["status"];
        message: string;
      };
      const current = serverState.sessionActivities?.find(
        (entry) => entry.sessionId === event.sessionId,
      );
      serverState.sessionActivities = [
        ...(serverState.sessionActivities || []).filter(
          (entry) => entry.sessionId !== event.sessionId,
        ),
        {
          ...(current || {}),
          sessionId: event.sessionId,
          status: projected.status,
          message: projected.message,
          unread: current?.unread || false,
        },
      ];
      if (event.type !== "session_event") return;
    }
    if (
      event.type === "session_event" &&
      event.sessionId === serverState.activeSessionId &&
      event.event &&
      typeof event.event === "object" &&
      !Array.isArray(event.event)
    ) {
      const sessionEvent = event.event as ChatDialogState["events"][number];
      serverState.events = [
        ...serverState.events.filter((entry) => entry.id !== sessionEvent.id),
        sessionEvent,
      ];
      return;
    }
    if (
      event.type === "default_follow_up_behavior_changed" &&
      ["queue", "steer"].includes(String(event.defaultFollowUpBehavior)) &&
      typeof event.defaultFollowUpBehaviorRevision === "string"
    ) {
      serverState.settings.defaultFollowUpBehavior =
        event.defaultFollowUpBehavior as "queue" | "steer";
      serverState.settings.defaultFollowUpBehaviorRevision =
        event.defaultFollowUpBehaviorRevision;
    }
  };

  const publishServerEvent = (payload: unknown): unknown => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }
    const event = { ...(payload as Record<string, unknown>) };
    const sendId = typeof event.sendId === "string" ? event.sendId : undefined;
    if (
      sendId &&
      [
        "assistant_delta",
        "assistant_reset",
        "confirm_request",
        "model_turn_state",
        "session_event",
        "web_search_update",
      ].includes(String(event.type))
    ) {
      const currentEpoch = modelTurnEpochsBySend.get(sendId) ?? 0;
      if (event.modelTurnEpoch === undefined) {
        event.modelTurnEpoch = event.type === "assistant_reset"
          ? currentEpoch + 1
          : currentEpoch;
      }
      if (
        Number.isSafeInteger(event.modelTurnEpoch) &&
        (event.modelTurnEpoch as number) >= 0
      ) {
        modelTurnEpochsBySend.set(
          sendId,
          Math.max(currentEpoch, event.modelTurnEpoch as number),
        );
      }
    }
    if (event.type === "confirm_resolved" && typeof event.id === "string") {
      const existing = confirmationResolutionPublications.get(event.id);
      if (existing) return existing;
    }
    if (event.type === "steer_accepted" && typeof event.steerId === "string") {
      const queued = pendingSteeringSsePublications.get(event.steerId);
      const existing = queued?.shift();
      if (queued?.length === 0) {
        pendingSteeringSsePublications.delete(event.steerId);
      }
      if (existing) return existing;
      const activeRequest = activeSteeringRequests.get(event.steerId);
      if (activeRequest?.publication) return activeRequest.publication;
    }
    if (
      typeof event.type === "string" &&
      stateChangeEventTypes.has(event.type)
    ) {
      if (
        [
          "approval_mode_changed",
          "session_edit_scopes_changed",
          "session_model_selection_changed",
        ].includes(event.type) &&
        event.updatedAt === undefined
      ) {
        const session = [
          ...serverState.sessions,
          ...serverState.previousSessions,
          ...serverState.archivedSessions,
        ].find((candidate) => candidate.id === event.sessionId);
        event.updatedAt = session?.updatedAt || "2026-08-01T00:00:00.000Z";
      }
      const bridgeStateRevision = typeof event.bridgeStateRevision === "string"
        ? event.bridgeStateRevision
        : allocateBridgeStateRevision();
      observeBridgeStateRevision(bridgeStateRevision);
      const activity = event.activity ?? (
        event.type === "progress"
          ? { status: "running", message: String(event.message || "") }
          : event.type === "confirm_request"
            ? {
                status: "waiting_confirmation",
                message: "Waiting for confirmation",
              }
            : event.type === "steer_accepted"
              ? { status: "running", message: "Guidance applied" }
              : event.type === "session_event" &&
                  event.event &&
                  typeof event.event === "object" &&
                  !Array.isArray(event.event) &&
                  "steeringAck" in event.event
                ? { status: "running", message: "Guidance applied" }
              : undefined
      );
      const confirmationGeneration = confirmationGenerationForEvent(event);
      const published: Record<string, unknown> = {
        ...event,
        ...(activity === undefined ? {} : { activity }),
        ...(confirmationGeneration === undefined
          ? {}
          : { confirmationGeneration }),
        bridgeStateRevision,
      };
      if (
        published.type === "confirm_request" &&
        typeof published.id === "string" &&
        typeof published.sendId === "string" &&
        typeof published.sessionId === "string"
      ) {
        pendingConfirmations.set(published.id, {
          confirmationGeneration: published.confirmationGeneration as number,
          sendId: published.sendId,
          sessionId: published.sessionId,
        });
        confirmationResolutionPublications.delete(published.id);
      } else if (
        published.type === "confirm_resolved" &&
        typeof published.id === "string"
      ) {
        pendingConfirmations.delete(published.id);
        confirmationResolutionPublications.set(published.id, published);
      } else if (
        published.type === "steer_accepted" &&
        typeof published.steerId === "string"
      ) {
        const activeRequest = activeSteeringRequests.get(published.steerId);
        if (activeRequest) {
          activeRequest.publication = published;
          activeRequest.sseDelivered = true;
        }
        acceptedSteeringIds.add(published.steerId);
      }
      applyServerProjectionPatch(published);
      return published;
    }
    if (
      ["done", "state", "error"].includes(String(event.type)) &&
      event.state &&
      typeof event.state === "object" &&
      !Array.isArray(event.state)
    ) {
      return {
        ...event,
        state: publishBridgeState(
          event.state as ChatBridgeState,
          latestBridgeStateRevision(),
        ),
      };
    }
    return event;
  };

  const dom = new JSDOM(
    renderChatHtml(cloneState(initialState), bridge),
    {
      url: "http://dialog.test/chat",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        Object.defineProperty(window, "crypto", {
          configurable: true,
          value: options.webCryptoAvailable === false
            ? { randomUUID: () => "test-random-id" }
            : options.webCryptoDigestFails
              ? {
                  randomUUID: () => webcrypto.randomUUID(),
                  subtle: {
                    digest: async () => {
                      throw new Error("Web Crypto digest failed.");
                    },
                  },
                }
              : webcrypto,
        });
        window.addEventListener("error", (event) => errors.push(event.error));
        Object.defineProperty(window, "requestAnimationFrame", {
          configurable: true,
          value: (callback: FrameRequestCallback) => {
            const id = nextAnimationFrameId;
            nextAnimationFrameId += 1;
            animationFrames.set(id, callback);
            return id;
          },
        });
        Object.defineProperty(window, "cancelAnimationFrame", {
          configurable: true,
          value: (id: number) => animationFrames.delete(id),
        });
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            messageHandlers: {
              live: {
                postMessage: (message: unknown) => hostMessages.push(message),
              },
            },
          },
        });
        Object.defineProperty(window, "confirm", {
          configurable: true,
          value: () => {
            throw new Error("Native confirm is unavailable in the Ableton host.");
          },
        });
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              clipboardWrites.push(value);
            },
          },
        });
        Object.defineProperty(window, "EventSource", {
          configurable: true,
          value: class {
            onmessage: ((event: { data: string }) => void) | null = null;
            onerror: (() => void) | null = null;
            onopen: (() => void) | null = null;
            constructor(url: string | URL) {
              eventSourceUrls.push(String(url));
              eventSources.push(this);
            }
            close(): void {}
          },
        });
        Object.defineProperty(window, "fetch", {
          configurable: true,
          value: async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const stateSnapshotCutRevision = latestBridgeStateRevision();
            const body = typeof init?.body === "string"
              ? JSON.parse(init.body) as unknown
              : undefined;
            if (url.pathname === "/send") {
              const headers = init?.headers as Record<string, string> | undefined;
              sendIds.push(headers?.["X-Live-Smith-Send-Id"] ?? "");
            }
            if (url.pathname === "/stop") {
              const headers = init?.headers as Record<string, string> | undefined;
              stopIds.push(headers?.["X-Live-Smith-Send-Id"] ?? "");
            }
            if (url.pathname === "/command") {
              const headers = init?.headers as Record<string, string> | undefined;
              commandIds.push(headers?.["X-Live-Smith-Command-Id"] ?? "");
            }
            calls.push({
              path: url.pathname,
              body: init?.body,
              ...(init?.headers === undefined ? {} : { headers: init.headers }),
              ...(body === undefined ? {} : { jsonBody: body }),
              url: url.toString(),
            });

            if (url.pathname === "/attachments" && init?.method === "POST") {
              if (heldAttachment) {
                const wait = heldAttachment;
                heldAttachment = null;
                await wait;
              }
              const file = init.body as File;
              const sessionId = url.searchParams.get("sessionId") ?? "";
              const fileName = url.searchParams.get("fileName") ?? "image";
              const namedFailure = attachmentFailuresByName.get(fileName);
              if (namedFailure !== undefined) {
                attachmentFailuresByName.delete(fileName);
                return failedResponse(
                  { error: namedFailure.error },
                  namedFailure.status,
                  namedFailure.status === 409
                    ? "Conflict"
                    : "Internal Server Error",
                );
              }
              const attachments = pendingAttachmentsBySession.get(sessionId) ?? [];
              const mediaType = nextAttachmentUnknown?.committedMetadata?.mediaType ??
                attachmentMediaTypeForFile(file);
              const commonAttachment = {
                id: `attachment-${attachments.length + 1}`,
                fileName: nextAttachmentUnknown?.committedMetadata?.fileName ??
                  fileName,
                byteLength: file.size,
                sha256: nextAttachmentUnknown?.committedMetadata?.sha256 ??
                  createHash("sha256")
                    .update(new Uint8Array(await file.arrayBuffer()))
                    .digest("hex"),
              };
              let attachment: ChatDialogState["pendingAttachments"][number];
              if (mediaType.startsWith("image/")) {
                attachment = {
                  ...commonAttachment,
                  kind: "image",
                  mediaType: mediaType as "image/png" | "image/jpeg" | "image/webp",
                };
              } else if (mediaType.startsWith("audio/")) {
                attachment = {
                  ...commonAttachment,
                  kind: "audio",
                  mediaType: mediaType as "audio/wav" | "audio/mpeg",
                  durationSeconds: 83.25,
                  sampleRate: 48_000,
                  channels: 2,
                };
              } else {
                attachment = {
                  ...commonAttachment,
                  kind: "document",
                  mediaType: mediaType as Extract<
                    ChatDialogState["pendingAttachments"][number],
                    { kind: "document" }
                  >["mediaType"],
                };
              }
              const next = [...attachments, attachment];
              pendingAttachmentsBySession.set(sessionId, next);
              if (serverState.activeSessionId === sessionId) {
                serverState.pendingAttachments = next;
              }
              if (nextAttachmentRejection) {
                const error = nextAttachmentRejection;
                nextAttachmentRejection = null;
                throw error;
              }
              if (nextAttachmentUnknown) {
                const error = nextAttachmentUnknown;
                nextAttachmentUnknown = null;
                return failedResponse(publishErrorState({
                  error: error.error,
                  commandOutcome: "unknown",
                  state: cloneState(serverState),
                }, stateSnapshotCutRevision), 500, "Internal Server Error");
              }
              if (truncatedAttachmentResponses > 0) {
                truncatedAttachmentResponses -= 1;
                return truncatedJsonResponse();
              }
              return response(publishBridgeState(
                serverState,
                stateSnapshotCutRevision,
              ));
            }

            if (url.pathname.startsWith("/attachments/") && init?.method === "DELETE") {
              const sessionId = url.searchParams.get("sessionId") ?? "";
              const attachmentId = decodeURIComponent(
                url.pathname.slice("/attachments/".length),
              );
              const next = (pendingAttachmentsBySession.get(sessionId) ?? []).filter(
                (attachment) => attachment.id !== attachmentId,
              );
              pendingAttachmentsBySession.set(sessionId, next);
              if (serverState.activeSessionId === sessionId) {
                serverState.pendingAttachments = next;
              }
              return response(publishBridgeState(
                serverState,
                stateSnapshotCutRevision,
              ));
            }

            if (url.pathname === "/skills" && init?.method === "POST") {
              const file = init.body as File;
              const bytes = new Uint8Array(await file.arrayBuffer());
              const source = NodeBuffer.from(bytes).toString("utf8");
              const id = /^name:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "";
              const description = /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "";
              const installed = serverState.availableSkills.filter(
                (skill) => skill.source === "user",
              );
              const existing = installed.find((skill) => skill.id === id);
              if (!existing && isBuiltInSkillId(id)) {
                return failedResponse(
                  { error: `Built-in Skill ${id} is read-only.` },
                  400,
                  "Bad Request",
                );
              }
              if (existing && url.searchParams.get("replace") !== "true") {
                return failedResponse(
                  { error: `Skill ${id} is already installed.` },
                  409,
                  "Conflict",
                );
              }
              serverState.availableSkills = availableSkillSummaries([
                ...installed.filter((skill) => skill.id !== id),
                { id, description },
              ]);
              const responseRejection = skillResponseRejections.shift();
              if (responseRejection) throw responseRejection;
              if (truncatedSkillResponses > 0) {
                truncatedSkillResponses -= 1;
                return truncatedJsonResponse();
              }
              return response({
                state: publishBridgeState(
                  serverState,
                  stateSnapshotCutRevision,
                ),
                receipt: {
                  id,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              });
            }

            if (url.pathname.startsWith("/skills/") && init?.method === "DELETE") {
              const skillId = decodeURIComponent(url.pathname.slice("/skills/".length));
              const installed = serverState.availableSkills.filter(
                (skill) => skill.source === "user",
              );
              if (installed.some((skill) => skill.id === skillId)) {
                const inUse = [
                  ...serverState.sessions,
                  ...serverState.previousSessions,
                  ...serverState.archivedSessions,
                ].some((session) => session.activeSkillIds?.includes(skillId));
                if (inUse) {
                  return failedResponse(
                    { error: "Remove this Skill from every Session before deleting it." },
                    409,
                    "Conflict",
                  );
                }
                serverState.availableSkills = availableSkillSummaries(
                  installed.filter((skill) => skill.id !== skillId),
                );
              }
              if (truncatedSkillResponses > 0) {
                truncatedSkillResponses -= 1;
                return truncatedJsonResponse();
              }
              return response(publishBridgeState(
                serverState,
                stateSnapshotCutRevision,
              ));
            }

            if (
              url.pathname === "/command" ||
              url.pathname === "/session-model-capabilities"
            ) {
              if (nextCommandRejection) {
                const error = nextCommandRejection;
                nextCommandRejection = null;
                throw error;
              }
              if (heldCommand) {
                const wait = heldCommand;
                heldCommand = null;
                await wait;
              }
              if (nextCommandError) {
                const error = nextCommandError;
                nextCommandError = null;
                const { status = 400, ...publishedError } = error;
                const commandId = new Headers(init?.headers)
                  .get("X-Live-Smith-Command-Id") ?? "";
                const errorEnvelope = omitNextCommandIdResponse
                  ? publishedError
                  : { ...publishedError, commandId };
                omitNextCommandIdResponse = false;
                return failedResponse(
                  publishErrorState(errorEnvelope, stateSnapshotCutRevision),
                  status,
                  status === 409 ? "Conflict" : "Bad Request",
                );
              }
              const commandId = new Headers(init?.headers)
                .get("X-Live-Smith-Command-Id") ?? "";
              const command = body as {
                kind?: string;
                approvalMode?: "manual" | "low-risk" | "everything";
                editScopes?: EditScope[];
                defaultFollowUpBehavior?: "queue" | "steer";
                profile?: SavedProfile;
                profileId?: string;
                model?: string;
                reasoningEffort?: "minimal" | "low" | "medium" | "high" |
                  "xhigh" | "max" | "ultra" | null;
                sessionId?: string;
                skillIds?: string[];
                title?: string;
              };
              if (
                command.kind === "save_global_settings" &&
                typeof command.defaultFollowUpBehavior === "string"
              ) {
                serverState.settings.defaultFollowUpBehavior =
                  command.defaultFollowUpBehavior;
                serverState.settings.defaultFollowUpBehaviorRevision =
                  incrementDefaultFollowUpBehaviorRevision(
                    serverState.settings.defaultFollowUpBehaviorRevision,
                  );
              } else if (
                command.kind === "set_session_approval_mode" &&
                typeof command.sessionId === "string" &&
                typeof command.approvalMode === "string"
              ) {
                const session = [
                  ...serverState.sessions,
                  ...serverState.previousSessions,
                  ...serverState.archivedSessions,
                ].find((entry) => entry.id === command.sessionId);
                if (session) session.approvalMode = command.approvalMode;
                if (serverState.activeSessionId === command.sessionId) {
                  serverState.approvalMode = command.approvalMode;
                }
              } else if (
                command.kind === "set_session_edit_scopes" &&
                typeof command.sessionId === "string" &&
                isEditScopes(command.editScopes)
              ) {
                const session = [
                  ...serverState.sessions,
                  ...serverState.previousSessions,
                  ...serverState.archivedSessions,
                ].find((entry) => entry.id === command.sessionId);
                if (session) session.editScopes = resolveEditScopes(command.editScopes);
              } else if (command.kind === "start_codex_login") {
                serverState.codexAuthGeneration += 1;
                serverState.codexAuth = {
                  status: "pending",
                  verificationUrl: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-EFGH",
                };
              } else if (command.kind === "refresh_codex_account") {
                serverState.codexAuthGeneration += 1;
                serverState.codexAuth = {
                  status: "signed-in",
                  accountLabel: "studio@example.test",
                  planType: "pro",
                  subscriptionEligible: true,
                };
              } else if (command.kind === "logout_codex") {
                serverState.codexAuthGeneration += 1;
                serverState.codexAuth = { status: "signed-out" };
              } else if (
                command.kind === "set_session_model_selection" &&
                command.sessionId &&
                command.profileId &&
                command.model
              ) {
                const session = serverState.sessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                if (session) {
                  session.modelSelection = {
                    profileId: command.profileId,
                    model: command.model,
                    ...(command.reasoningEffort === null ||
                        command.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: command.reasoningEffort }),
                  };
                  if (session.id === serverState.activeSessionId) {
                    synchronizeActiveSessionProjection();
                  }
                }
              } else if (
                command.kind === "load_session_model_capabilities" &&
                command.sessionId &&
                command.profileId
              ) {
                serverState.configuredModelsReady = true;
              } else if (command.kind === "save_profile" && command.profile) {
                const profiles = serverState.settings.profiles.filter(
                  (profile) => profile.id !== command.profile?.id,
                );
                profiles.push(JSON.parse(JSON.stringify(command.profile)) as SavedProfile);
                serverState.settings.profiles = profiles;
                serverState.settings.activeProfileId = command.profile.id;
                serverState.modelStateSource = modelStateSourceFixture(command.profile);
                const selectedConfig = command.profile.models.find(
                  (entry) => entry.model === command.profile?.defaultModel,
                ) ?? command.profile.models[0]!;
                const discovered = serverState.availableModels.find(
                  (model) => model.id === selectedConfig.model,
                );
                serverState.capabilities = discovered
                  ? cloneState(discovered.capabilities)
                  : {
                      tools: true,
                      streaming: true,
                      temperature: "supported",
                      reasoning: {
                        supported: false,
                        canDisable: false,
                        efforts: [],
                        budgetTokens: false,
                        strategy: "none",
                      },
                      inputs: { image: false, audio: false, pdf: false },
                    };
                serverState.capabilityEvidence = discovered
                  ? cloneState(discovered.capabilityEvidence)
                  : unverifiedCapabilityEvidence();
                serverState.runtimeProfile = runtimeSummaryForHarnessProfile(
                  command.profile,
                  serverState.capabilities,
                  serverState.capabilityEvidence.inputs,
                );
                serverState.configuredModels = command.profile.models.map((entry) => ({
                  model: entry.model,
                  label: entry.model,
                }));
                serverState.configuredModelsReady =
                  command.profile.connection.kind !== "codex-subscription";
              } else if (command.kind === "discover_models") {
                serverState.modelCatalogLoadReceipt = commandId;
                serverState.availableModels = [{
                  id: "model-discovered",
                  displayName: "Discovered model",
                  capabilities: capabilities(),
                  capabilityEvidence: capabilityEvidence(),
                }];
                if (command.profile) {
                  serverState.modelStateSource = modelStateSourceFixture(command.profile);
                  serverState.capabilities = capabilities();
                  serverState.capabilityEvidence = capabilityEvidence();
                }
              } else if (command.kind === "activate_profile" && command.profileId) {
                serverState.settings.activeProfileId = command.profileId;
                const profile = serverState.settings.profiles.find(
                  (entry) => entry.id === command.profileId,
                );
                serverState.modelStateSource = profile
                  ? modelStateSourceFixture(profile)
                  : null;
                serverState.runtimeProfile = profile
                  ? runtimeSummaryForHarnessProfile(profile)
                  : null;
                serverState.configuredModels = profile
                  ? profile.models.map((entry) => ({
                      model: entry.model,
                      label: entry.model,
                    }))
                  : [];
                serverState.configuredModelsReady =
                  profile?.connection.kind !== "codex-subscription";
              } else if (command.kind === "delete_profile" && command.profileId) {
                serverState.settings.profiles = serverState.settings.profiles.filter(
                  (entry) => entry.id !== command.profileId,
                );
                if (serverState.settings.activeProfileId === command.profileId) {
                  serverState.settings.activeProfileId =
                    serverState.settings.profiles[0]?.id ?? null;
                }
                const profile = serverState.settings.profiles.find(
                  (entry) => entry.id === serverState.settings.activeProfileId,
                );
                serverState.modelStateSource = profile
                  ? modelStateSourceFixture(profile)
                  : null;
                serverState.runtimeProfile = profile
                  ? runtimeSummaryForHarnessProfile(profile)
                  : null;
                serverState.configuredModels = profile
                  ? profile.models.map((entry) => ({
                      model: entry.model,
                      label: entry.model,
                    }))
                  : [];
                serverState.configuredModelsReady =
                  profile?.connection.kind !== "codex-subscription";
              } else if (command.kind === "select_session" && command.sessionId) {
                serverState.activeSessionId = command.sessionId;
                const selected = serverState.sessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                const activity = serverState.sessionActivities?.find(
                  (entry) => entry.sessionId === command.sessionId,
                );
                if (activity) activity.unread = false;
                serverState.approvalMode = selected?.approvalMode ?? "manual";
                serverState.activeSkillIds = [...(selected?.activeSkillIds ?? [])];
                serverState.pendingAttachments = pendingAttachmentsBySession.get(
                  command.sessionId,
                ) ?? [];
                synchronizeActiveSessionProjection();
              } else if (
                command.kind === "attach_selected_audio_source" &&
                command.sessionId
              ) {
                const attachments = pendingAttachmentsBySession.get(command.sessionId) ?? [];
                const attachment = pendingAudio(
                  `attachment-${attachments.length + 1}`,
                  "Selected audio.wav",
                  "audio/wav",
                  96_000,
                  1.5,
                );
                const next = [...attachments, attachment];
                pendingAttachmentsBySession.set(command.sessionId, next);
                if (serverState.activeSessionId === command.sessionId) {
                  serverState.pendingAttachments = next;
                }
              } else if (
                command.kind === "set_session_skills" &&
                command.sessionId &&
                Array.isArray(command.skillIds)
              ) {
                const session = [
                  ...serverState.sessions,
                  ...serverState.previousSessions,
                  ...serverState.archivedSessions,
                ].find((entry) => entry.id === command.sessionId);
                if (session) session.activeSkillIds = [...command.skillIds].sort();
                if (serverState.activeSessionId === command.sessionId) {
                  serverState.activeSkillIds = [...command.skillIds].sort();
                }
              } else if (command.kind === "restore_session" && command.sessionId) {
                const restored = serverState.previousSessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                if (restored) {
                  serverState.previousSessions = serverState.previousSessions.filter(
                    (entry) => entry.id !== command.sessionId,
                  );
                  restored.projectKey = serverState.sessions[0]?.projectKey ?? "project-1";
                  restored.scope = {
                    kind: serverState.sessionContinueTarget.kind,
                    identity: "current-live-object",
                    label: serverState.sessionContinueTarget.label,
                  };
                  serverState.sessions = [restored, ...serverState.sessions];
                  serverState.activeSessionId = restored.id;
                  synchronizeActiveSessionProjection();
                }
              } else if (
                command.kind === "rename_session" &&
                command.sessionId &&
                command.title
              ) {
                const session = [
                  ...serverState.sessions,
                  ...serverState.previousSessions,
                  ...serverState.archivedSessions,
                ].find((entry) => entry.id === command.sessionId);
                if (session) session.title = command.title;
              } else if (command.kind === "archive_session" && command.sessionId) {
                const session = [...serverState.sessions, ...serverState.previousSessions]
                  .find((entry) => entry.id === command.sessionId);
                if (session) {
                  session.archivedAt = "2026-08-02T00:00:00.000Z";
                  serverState.sessions = serverState.sessions.filter(
                    (entry) => entry.id !== command.sessionId,
                  );
                  serverState.previousSessions = serverState.previousSessions.filter(
                    (entry) => entry.id !== command.sessionId,
                  );
                  serverState.archivedSessions = [session, ...serverState.archivedSessions];
                  if (serverState.activeSessionId === command.sessionId) {
                    serverState.activeSessionId = serverState.sessions[0]?.id ?? "";
                    synchronizeActiveSessionProjection();
                  }
                }
              } else if (command.kind === "unarchive_session" && command.sessionId) {
                const session = serverState.archivedSessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                if (session) {
                  delete session.archivedAt;
                  serverState.archivedSessions = serverState.archivedSessions.filter(
                    (entry) => entry.id !== command.sessionId,
                  );
                  const currentProjectKey = serverState.sessions[0]?.projectKey ?? "project-1";
                  if (session.projectKey === currentProjectKey) {
                    serverState.sessions = [session, ...serverState.sessions];
                  } else {
                    serverState.previousSessions = [session, ...serverState.previousSessions];
                  }
                }
              } else if (command.kind === "delete_session" && command.sessionId) {
                serverState.sessions = serverState.sessions.filter(
                  (entry) => entry.id !== command.sessionId,
                );
                serverState.previousSessions = serverState.previousSessions.filter(
                  (entry) => entry.id !== command.sessionId,
                );
                serverState.archivedSessions = serverState.archivedSessions.filter(
                  (entry) => entry.id !== command.sessionId,
                );
                serverState.activeSessionId = serverState.sessions[0]?.id ?? "";
                synchronizeActiveSessionProjection();
              }
              const capabilityState = url.pathname === "/session-model-capabilities"
                ? publishBridgeState(serverState, stateSnapshotCutRevision)
                : null;
              if (heldCommandResponse) {
                const wait = heldCommandResponse;
                heldCommandResponse = null;
                await wait;
              }
              if (nextCommandResponseRejection) {
                const error = nextCommandResponseRejection;
                nextCommandResponseRejection = null;
                throw error;
              }
              if (truncatedCommandResponses > 0) {
                truncatedCommandResponses -= 1;
                return truncatedJsonResponse();
              }
              return response(capabilityState ?? publishBridgeState(
                serverState,
                stateSnapshotCutRevision,
              ));
            }

            if (url.pathname === "/state") {
              if (nextStateError) {
                const error = nextStateError;
                nextStateError = null;
                return failedResponse(error, 503, "Service Unavailable");
              }
              if (nextStateRejection) {
                const error = nextStateRejection;
                nextStateRejection = null;
                throw error;
              }
              if (heldState) {
                const wait = heldState;
                heldState = null;
                await wait;
              }
              return response(publishBridgeState(
                serverState,
                stateSnapshotCutRevision,
              ));
            }
            if (url.pathname === "/send") {
              const wait = heldSends.shift();
              if (wait) await wait;
              if (nextSendError) {
                const error = nextSendError;
                nextSendError = null;
                return failedResponse(
                  publishErrorState(error, stateSnapshotCutRevision),
                  500,
                  "Internal Server Error",
                );
              }
              if (nextSendRejection) {
                const error = nextSendRejection;
                nextSendRejection = null;
                throw error;
              }
              if (omitNextSendStateResponse) {
                omitNextSendStateResponse = false;
                return response({ ok: true });
              }
              return response({
                ok: true,
                state: publishBridgeState(
                  serverState,
                  stateSnapshotCutRevision,
                ),
              });
            }
            if (url.pathname === "/steer") {
              const headers = new Headers(init?.headers);
              const sendId = headers.get("X-Live-Smith-Send-Id") || "";
              const steerId = headers.get("X-Live-Smith-Steer-Id") || "";
              const sessionId = (body as { sessionId?: string } | undefined)
                ?.sessionId ?? serverState.activeSessionId;
              const steeringRequest: {
                publication?: Record<string, unknown>;
                sseDelivered: boolean;
              } = { sseDelivered: false };
              activeSteeringRequests.set(steerId, steeringRequest);
              const injectedError = nextSteerError;
              nextSteerError = null;
              if (!injectedError && !acceptedSteeringIds.has(steerId)) {
                for (const [id, confirmation] of pendingConfirmations) {
                  if (confirmation.sendId === sendId) pendingConfirmations.delete(id);
                }
              }
              try {
                if (heldSteer) {
                  const wait = heldSteer;
                  heldSteer = null;
                  await wait;
                }
                if (injectedError) {
                  return failedResponse(
                    injectedError,
                    injectedError.steeringOutcome === "unknown" ? 503 : 409,
                    injectedError.steeringOutcome === "unknown"
                      ? "Service Unavailable"
                      : "Conflict",
                  );
                }
                let published = steeringRequest.publication;
                if (!published) {
                  const newerConfirmationPending = [...pendingConfirmations.values()]
                    .some((confirmation) => confirmation.sendId === sendId);
                  const activity = newerConfirmationPending
                    ? undefined
                    : { status: "running" as const, message: "Guidance applied" };
                  published = {
                    type: "steer_accepted",
                    sendId,
                    sessionId,
                    steerId,
                    ...(activity ? { activity } : {}),
                    bridgeStateRevision: allocateBridgeStateRevision(),
                  };
                  steeringRequest.publication = published;
                  acceptedSteeringIds.add(steerId);
                  applyServerProjectionPatch(published);
                }
                if (!steeringRequest.sseDelivered) {
                  const queued = pendingSteeringSsePublications.get(steerId) || [];
                  queued.push(published);
                  pendingSteeringSsePublications.set(steerId, queued);
                }
                if (nextSteerResponseRejection) {
                  const error = nextSteerResponseRejection;
                  nextSteerResponseRejection = null;
                  throw error;
                }
                return response({
                  ok: true,
                  bridgeStateRevision: published.bridgeStateRevision,
                  ...(published.activity ? { activity: published.activity } : {}),
                });
              } finally {
                if (activeSteeringRequests.get(steerId) === steeringRequest) {
                  activeSteeringRequests.delete(steerId);
                }
              }
            }
            if (url.pathname === "/confirm") {
              const confirmation = body as {
                id?: string;
                apply?: boolean;
              } | undefined;
              const confirmationId = confirmation?.id;
              const injectedError = nextConfirmationError;
              nextConfirmationError = null;
              let published: Record<string, unknown> | undefined;
              if (!injectedError && typeof confirmationId === "string") {
                const owner = pendingConfirmations.get(confirmationId);
                if (owner) {
                  const activity = {
                    status: "running" as const,
                    message: confirmation?.apply === true
                      ? "Applying confirmed changes"
                      : "Continuing after cancellation",
                  };
                  published = publishServerEvent({
                    type: "confirm_resolved",
                    sendId: owner.sendId,
                    sessionId: owner.sessionId,
                    id: confirmationId,
                    confirmationGeneration: owner.confirmationGeneration,
                    activity,
                  }) as Record<string, unknown>;
                }
              }
              if (heldConfirmation) {
                const wait = heldConfirmation;
                heldConfirmation = null;
                await wait;
              }
              if (injectedError) {
                return failedResponse(injectedError, 503, "Service Unavailable");
              }
              if (nextConfirmationResponseRejection) {
                const error = nextConfirmationResponseRejection;
                nextConfirmationResponseRejection = null;
                throw error;
              }
              return response({
                ok: true,
                ...(published
                  ? {
                      bridgeStateRevision: published.bridgeStateRevision,
                      confirmationGeneration:
                        published.confirmationGeneration,
                      ...(published.activity ? { activity: published.activity } : {}),
                    }
                  : {}),
              });
            }
            if (url.pathname === "/stop") {
              const outcome = stopOutcomes.shift();
              const headers = new Headers(init?.headers);
              const terminal = outcome?.terminal ?? stopTerminals.shift() ?? true;
              const sendId = outcome?.sendId ??
                headers.get("X-Live-Smith-Send-Id") ?? "";
              return response({
                ok: true,
                terminal,
                sendId,
                ...(terminal
                  ? {
                      promptPersistence:
                        outcome?.promptPersistence ?? "persisted",
                    }
                  : {}),
              });
            }
            return response({ ok: true });
          },
        });
      },
    },
  );
  const { window } = dom;
  if (window.document.readyState !== "complete") {
    await new Promise<void>((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
  }

  const required = <T extends Element>(selector: string): T => {
    const element = window.document.querySelector<T>(selector);
    assert.ok(element, `Expected ${selector} to exist`);
    return element;
  };

  return {
    async acceptAppConfirmation() {
      await waitForCondition(
        () => required<HTMLElement>("#appConfirmation").hidden === false,
        "Expected an in-page confirmation.",
      );
      required<HTMLButtonElement>("#appConfirmationAccept").click();
      await Promise.resolve();
    },
    calls,
    clipboardWrites,
    commandIds,
    click(selector) {
      required<HTMLElement>(selector).click();
    },
    clickButton(label) {
      const button = [...window.document.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(button, `Expected button ${label} to exist`);
      button.click();
    },
    async cancelAppConfirmation() {
      await waitForCondition(
        () => required<HTMLElement>("#appConfirmation").hidden === false,
        "Expected an in-page confirmation.",
      );
      required<HTMLButtonElement>("#appConfirmationCancel").click();
      await Promise.resolve();
    },
    close() {
      window.close();
    },
    deferServerEvent(payload) {
      return publishServerEvent(payload);
    },
    document: window.document,
    emitServerEvent(payload) {
      const source = eventSources.at(-1);
      assert.ok(source?.onmessage, "Expected the EventSource to be connected");
      const published = publishServerEvent(payload);
      if (
        published &&
        typeof published === "object" &&
        !Array.isArray(published) &&
        (published as Record<string, unknown>).type === "confirm_resolved" &&
        typeof (published as Record<string, unknown>).id === "string"
      ) {
        confirmationResolutionPublications.delete(
          (published as Record<string, unknown>).id as string,
        );
      }
      source.onmessage({ data: JSON.stringify(published) });
    },
    emitRawServerEvent(payload) {
      const source = eventSources.at(-1);
      assert.ok(source?.onmessage, "Expected the EventSource to be connected");
      source.onmessage({ data: JSON.stringify(payload) });
    },
    emitServerEventError() {
      const source = eventSources.at(-1);
      assert.ok(source?.onerror, "Expected the EventSource to be connected");
      source.onerror();
    },
    emitServerEventOpen() {
      const source = eventSources.at(-1);
      assert.ok(source?.onopen, "Expected the EventSource to be connected");
      source.onopen();
    },
    errors,
    eventSourceUrls,
    failNextCommand(error, field, details) {
      nextCommandError = {
        error,
        ...(field ? { field } : {}),
        ...(details || {}),
      };
    },
    failNextConfirmation(error) {
      nextConfirmationError = { error };
    },
    failNextSend(error, promptPersistence, details) {
      nextSendError = {
        error,
        ...(promptPersistence ? { promptPersistence } : {}),
        ...(details || {}),
      };
    },
    failNextSteer(error, steeringOutcome) {
      nextSteerError = {
        error,
        ...(steeringOutcome ? { steeringOutcome } : {}),
      };
    },
    rejectNextSteerResponseAfterCommit(error) {
      nextSteerResponseRejection = new Error(error);
    },
    rejectNextConfirmationResponseAfterCommit(error) {
      nextConfirmationResponseRejection = new Error(error);
    },
    failNextState(error) {
      nextStateError = { error };
    },
    failNextAttachmentUnknown(error, committedMetadata) {
      nextAttachmentUnknown = {
        error,
        ...(committedMetadata ? { committedMetadata } : {}),
      };
    },
    failAttachmentNamed(fileName, error, status = 500) {
      attachmentFailuresByName.set(fileName, { error, status });
    },
    rejectNextAttachmentAfterCommit(error) {
      nextAttachmentRejection = new Error(error);
    },
    truncateNextAttachmentResponseAfterCommit() {
      truncatedAttachmentResponses += 1;
    },
    rejectNextSkillResponseAfterCommit(error) {
      skillResponseRejections.push(new Error(error));
    },
    truncateNextSkillResponseAfterCommit() {
      truncatedSkillResponses += 1;
    },
    flushAnimationFrames() {
      const pending = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of pending) callback(0);
      return pending.length;
    },
    rejectNextSend(error) {
      nextSendRejection = new Error(error);
    },
    omitNextSendState() {
      omitNextSendStateResponse = true;
    },
    rejectNextCommand(error) {
      nextCommandRejection = new Error(error);
    },
    rejectNextCommandResponse(error) {
      nextCommandResponseRejection = new Error(error);
    },
    omitNextCommandId() {
      omitNextCommandIdResponse = true;
    },
    truncateNextCommandResponseAfterCommit() {
      truncatedCommandResponses += 1;
    },
    rejectNextState(error) {
      nextStateRejection = new Error(error);
    },
    holdNextCommand() {
      heldCommand = new Promise<void>((resolve) => {
        releaseCommand = resolve;
      });
    },
    holdNextCommandResponse() {
      heldCommandResponse = new Promise<void>((resolve) => {
        releaseCommandResponse = resolve;
      });
    },
    holdNextConfirmation() {
      heldConfirmation = new Promise<void>((resolve) => {
        releaseConfirmation = resolve;
      });
    },
    holdNextSend() {
      heldSends.push(new Promise<void>((resolve) => {
        releaseSends.push(resolve);
      }));
    },
    holdNextSteer() {
      heldSteer = new Promise<void>((resolve) => {
        releaseSteer = resolve;
      });
    },
    holdNextState() {
      heldState = new Promise<void>((resolve) => {
        releaseState = resolve;
      });
    },
    holdNextAttachment() {
      heldAttachment = new Promise<void>((resolve) => {
        releaseAttachment = resolve;
      });
    },
    hostMessages,
    input(selector, value) {
      const field = required<HTMLInputElement | HTMLTextAreaElement>(selector);
      field.value = value;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    releaseHeldCommand() {
      assert.ok(releaseCommand, "Expected a held command");
      const release = releaseCommand;
      releaseCommand = null;
      release();
    },
    releaseHeldCommandResponse() {
      assert.ok(releaseCommandResponse, "Expected a held command response");
      const release = releaseCommandResponse;
      releaseCommandResponse = null;
      release();
    },
    releaseHeldConfirmation() {
      assert.ok(releaseConfirmation, "Expected a held confirmation");
      const release = releaseConfirmation;
      releaseConfirmation = null;
      release();
    },
    releaseHeldSend() {
      const release = releaseSends.shift();
      assert.ok(release, "Expected a held send");
      release();
    },
    releaseHeldSteer() {
      assert.ok(releaseSteer, "Expected a held steering request");
      const release = releaseSteer;
      releaseSteer = null;
      release();
    },
    releaseHeldState() {
      assert.ok(releaseState, "Expected a held state refresh");
      const release = releaseState;
      releaseState = null;
      release();
    },
    releaseHeldAttachment() {
      assert.ok(releaseAttachment, "Expected a held attachment request");
      const release = releaseAttachment;
      releaseAttachment = null;
      release();
    },
    queueStopTerminals(...values) {
      stopTerminals.push(...values);
    },
    queueStopOutcomes(...values) {
      stopOutcomes.push(...values);
    },
    sendIds,
    queueNextStatePublication(
      bridgeStateRevision,
      bridgeStateCoveredThroughRevision,
    ) {
      queuedStatePublications.push({
        bridgeStateRevision,
        bridgeStateCoveredThroughRevision,
      });
    },
    setServerState(state) {
      serverState = cloneState(state);
    },
    stopIds,
    select(selector, value) {
      const field = required<HTMLSelectElement>(selector);
      field.value = value;
      field.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    dispatchPaste(files = [], text = "") {
      const event = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files,
          types: text ? ["text/plain", "Files"] : ["Files"],
          getData(type: string) {
            return type === "text/plain" ? text : "";
          },
        },
      });
      required<HTMLTextAreaElement>("#prompt").dispatchEvent(event);
      return event.defaultPrevented;
    },
    dispatchDrop(files) {
      const event = new window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files, types: ["Files"] },
      });
      required<HTMLElement>(".composer").dispatchEvent(event);
      return event.defaultPrevented;
    },
    dispatchDragOver(files) {
      const event = new window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files, types: ["Files"] },
      });
      required<HTMLElement>(".composer").dispatchEvent(event);
      return event.defaultPrevented;
    },
    dropAttachmentFiles(files) {
      const event = new window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files, types: ["Files"] },
      });
      required<HTMLElement>(".composer").dispatchEvent(event);
    },
    dropSkillFile(file) {
      const event = new window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file], types: ["Files"] },
      });
      required<HTMLElement>("#skillDropZone").dispatchEvent(event);
      return event.defaultPrevented;
    },
    async settle() {
      await Promise.resolve();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    },
    async settleAttachmentOperation() {
      await waitForCondition(
        () => required("#pendingAttachments").getAttribute("aria-busy") === "false",
        "Expected the attachment operation to reach its terminal UI state.",
      );
      await Promise.resolve();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    },
    window,
  };
}

function failedResponse(
  body: unknown,
  status: number,
  statusText: string,
): {
  json(): Promise<unknown>;
  ok: false;
  status: number;
  statusText: string;
} {
  return {
    ok: false,
    status,
    statusText,
    json: async () => body,
  };
}

function response(body: unknown): {
  json(): Promise<unknown>;
  ok: true;
  status: 200;
  statusText: "OK";
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

function truncatedJsonResponse(): {
  json(): Promise<never>;
  ok: true;
  status: 200;
  statusText: "OK";
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      throw new Error("The response body ended before JSON was complete.");
    },
  };
}

function commandCalls(harness: DialogHarness): ParsedBridgeCall[] {
  return jsonCalls(harness, "/command");
}

function renderedCapabilityStatuses(
  harness: DialogHarness,
): Array<[string, string | undefined]> {
  return [...harness.document.querySelectorAll<HTMLElement>(
    "#inputCapabilitiesPreview [data-capability-state]",
  )].map((item) => [
    [
      item.querySelector(".capability-label")?.textContent,
      item.querySelector(".capability-mark")?.textContent,
    ].filter(Boolean).join(" "),
    item.dataset.capabilityState,
  ]);
}

function jsonCalls(harness: DialogHarness, path: string): ParsedBridgeCall[] {
  return harness.calls
    .filter((call) => call.path === path)
    .map((call) => ({ path: call.path, body: call.jsonBody }));
}

function imageFile(
  window: JSDOM["window"],
  fileName: string,
  mediaType: "image/png" | "image/jpeg" | "image/webp",
  byteLength = 24,
): File {
  return new window.File([new Uint8Array(byteLength)], fileName, {
    type: mediaType,
  });
}

function documentFile(
  window: JSDOM["window"],
  fileName: string,
  mediaType: string,
  byteLength = 24,
): File {
  return new window.File([new Uint8Array(byteLength)], fileName, {
    type: mediaType,
  });
}

function audioFile(
  window: JSDOM["window"],
  fileName: string,
  mediaType: "audio/wav" | "audio/mpeg",
  byteLength = 24,
): File {
  return new window.File([new Uint8Array(byteLength)], fileName, {
    type: mediaType,
  });
}

function attachmentMediaTypeForFile(
  file: File,
): ChatDialogState["pendingAttachments"][number]["mediaType"] {
  const knownMediaTypes = new Set<
    ChatDialogState["pendingAttachments"][number]["mediaType"]
  >([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "audio/wav",
    "audio/mpeg",
  ]);
  if (knownMediaTypes.has(
    file.type as ChatDialogState["pendingAttachments"][number]["mediaType"],
  )) {
    return file.type as ChatDialogState["pendingAttachments"][number]["mediaType"];
  }
  const extension = /\.([^.]+)$/.exec(file.name.toLowerCase())?.[1];
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (extension === "wav") return "audio/wav";
  if (extension === "mp3") return "audio/mpeg";
  throw new Error(`Unsupported test attachment ${file.name}`);
}

function runtimeSummaryForHarnessProfile(
  profile: SavedProfile,
  projectedCapabilities = capabilities(),
  projectedInputEvidence = inputCapabilityEvidence(),
  selectedModel = profile.defaultModel,
  reasoningEffort?: NonNullable<
    ChatDialogState["sessions"][number]["modelSelection"]
  >["reasoningEffort"],
): NonNullable<ChatDialogState["runtimeProfile"]> {
  const runtimeCapabilities = cloneState(projectedCapabilities);
  const evidence = cloneState(projectedInputEvidence);
  const selected = profile.models.find(
    (entry) => entry.model === selectedModel,
  ) ?? profile.models[0]!;
  if (selected.model === "pdf-capable-model") {
    runtimeCapabilities.inputs.pdf = true;
    evidence.pdf = "supported";
  }
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      connectionKind: profile.connection.kind,
      apiFamily: profile.connection.kind === "direct-api"
        ? profile.connection.apiFamily
        : profile.connection.provider,
      apiMode: profile.connection.kind === "direct-api"
        ? profile.connection.apiMode
        : null,
    },
    selection: {
      model: selected.model,
      reasoning: {
        ...cloneState(selected.parameters.reasoning),
        ...(reasoningEffort === undefined
          ? {}
          : { mode: "enabled" as const, effort: reasoningEffort }),
      },
    },
    capabilities: runtimeCapabilities,
    inputCapabilityEvidence: evidence,
  };
}

function pendingImage(
  id: string,
  fileName: string,
  mediaType: "image/png" | "image/jpeg" | "image/webp" = "image/png",
  byteLength = 24,
): ChatDialogState["pendingAttachments"][number] {
  return {
    id,
    kind: "image",
    fileName,
    mediaType,
    byteLength,
    sha256: "a".repeat(64),
  };
}

function pendingDocument(
  id: string,
  fileName: string,
  mediaType:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  byteLength = 24,
): ChatDialogState["pendingAttachments"][number] {
  return {
    id,
    kind: "document",
    fileName,
    mediaType,
    byteLength,
    sha256: "b".repeat(64),
  };
}

function pendingAudio(
  id: string,
  fileName: string,
  mediaType: "audio/wav" | "audio/mpeg" = "audio/wav",
  byteLength = 24,
  durationSeconds = 1.5,
): ChatDialogState["pendingAttachments"][number] {
  return {
    id,
    kind: "audio",
    fileName,
    mediaType,
    byteLength,
    sha256: "c".repeat(64),
    durationSeconds,
    sampleRate: 48_000,
    channels: 2,
  };
}

export {
  audioCapableState,
  audioFile,
  capabilities,
  capabilityEvidence,
  cloneState,
  commandCalls,
  createDialogHarness,
  documentFile,
  imageCapableState,
  imageFile,
  jsonCalls,
  modelStateSourceFixture,
  pendingAudio,
  pendingDocument,
  pendingImage,
  profileFixture,
  renderedCapabilityStatuses,
  runtimeSummaryForHarnessProfile,
  stateFixture,
  waitForCondition,
};
export type { DialogHarness };
