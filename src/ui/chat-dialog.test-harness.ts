import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import * as fs from "node:fs";
import { URL } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";

import {
  incrementDefaultFollowUpBehaviorRevision,
  type SavedProfile,
} from "../model/profile.js";
import { buildMarkdownRendererScript } from "../../scripts/build-markdown-renderer.js";
import type { ChatDialogState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

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
  emitServerEvent(payload: unknown): void;
  emitServerEventError(): void;
  errors: unknown[];
  eventSourceUrls: string[];
  failNextCommand(
    error: string,
    field?: string,
    details?: {
      commandOutcome?: "unknown";
      reconciliationRequired?: boolean;
      state?: ChatDialogState;
    },
  ): void;
  failNextConfirmation(error: string): void;
  failNextSend(
    error: string,
    promptPersistence?: string,
    details?: {
      sendFailureKind?: "session_unavailable";
      state?: ChatDialogState;
    },
  ): void;
  failNextSteer(error: string, steeringOutcome?: "unknown"): void;
  rejectNextSteerResponseAfterCommit(error: string): void;
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
  rejectNextCommand(error: string): void;
  rejectNextCommandResponse(error: string): void;
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
    }>
  ): void;
  sendIds: string[];
  setServerState(state: ChatDialogState): void;
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
  capabilityPreview: readClientScript("capability-preview"),
  hostAdapter: readClientScript("host-adapter"),
  markdownRenderer: markdownRendererScript,
  profileEditor: readClientScript("profile-editor"),
  sessionTimeline: readClientScript("session-timeline"),
  skillManager: readClientScript("skill-manager"),
};

function renderChatHtml(
  state: ChatDialogState,
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

function inputCapabilityEvidence(
  image: "supported" | "unsupported" | "unverified" = "unverified",
  pdf: "supported" | "unsupported" | "unverified" = "unverified",
): NonNullable<ChatDialogState["runtimeProfile"]>["inputCapabilityEvidence"] {
  return { image, audio: "unverified", pdf };
}

function profileFixture(
  overrides: Partial<SavedProfile> = {},
): SavedProfile {
  return {
    id: "profile-1",
    name: "Studio",
    apiFamily: "openai",
    apiMode: "chat-completions",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "model-a",
    parameters: {
      maxOutputTokens: 8192,
      temperature: 0.4,
      reasoning: { mode: "default" },
    },
    advanced: {},
    ...overrides,
  };
}

function modelStateSourceFixture(profile: SavedProfile) {
  return {
    profileId: profile.id,
    apiFamily: profile.apiFamily,
    apiMode: profile.apiMode,
    baseUrl: profile.baseUrl.replace(/\/+$/, ""),
    apiKey: profile.apiKey,
    model: profile.model,
  };
}

function stateFixture(): ChatDialogState {
  return {
    defaultPrompt: "Make a bassline",
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
    availableSkills: [],
    activeSkillIds: [],
    capabilities: capabilities(),
    availableModels: [],
    modelStateSource: modelStateSourceFixture(profileFixture()),
    runtimeProfile: {
      profile: profileFixture(),
      capabilities: capabilities(),
      inputCapabilityEvidence: inputCapabilityEvidence(),
    },
    settings: {
      schemaVersion: 3,
      activeProfileId: "profile-1",
      approvalMode: "manual",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      profiles: [
        profileFixture(),
        profileFixture({
          id: "profile-2",
          name: "Mix review",
          apiFamily: "anthropic",
          apiMode: "messages",
          model: "model-b",
        }),
      ],
    },
    openSettingsOnLoad: true,
  };
}

function imageCapableState(): ChatDialogState {
  const state = stateFixture();
  state.runtimeProfile!.capabilities.inputs.image = true;
  state.runtimeProfile!.inputCapabilityEvidence.image = "supported";
  return state;
}

function audioCapableState(): ChatDialogState {
  const state = stateFixture();
  state.runtimeProfile!.capabilities.inputs.audio = true;
  state.runtimeProfile!.inputCapabilityEvidence.audio = "supported";
  return state;
}

function cloneState(state: ChatDialogState): ChatDialogState {
  return JSON.parse(JSON.stringify(state)) as ChatDialogState;
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
  initialState: ChatDialogState = stateFixture(),
  bridge = { baseUrl: "http://bridge.test", token: "test-token" },
  options: {
    webCryptoAvailable?: boolean;
    webCryptoDigestFails?: boolean;
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
  }> = [];
  const hostMessages: unknown[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextAnimationFrameId = 1;
  let nextCommandError: {
    error: string;
    field?: string;
    commandOutcome?: "unknown";
    reconciliationRequired?: boolean;
    state?: ChatDialogState;
  } | null = null;
  let nextConfirmationError: { error: string } | null = null;
  let nextSendError: {
    error: string;
    promptPersistence?: string;
    sendFailureKind?: "session_unavailable";
    state?: ChatDialogState;
  } | null = null;
  let nextSteerError: {
    error: string;
    steeringOutcome?: "unknown";
  } | null = null;
  let nextSteerResponseRejection: Error | null = null;
  let nextStateError: { error: string } | null = null;
  let nextSendRejection: Error | null = null;
  let nextCommandRejection: Error | null = null;
  let nextCommandResponseRejection: Error | null = null;
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
  let releaseConfirmation: (() => void) | null = null;
  const releaseSends: Array<() => void> = [];
  let releaseSteer: (() => void) | null = null;
  let releaseState: (() => void) | null = null;
  let releaseAttachment: (() => void) | null = null;
  const stopTerminals: boolean[] = [];
  const stopOutcomes: Array<{
    terminal: boolean;
    promptPersistence?: "persisted" | "not_persisted" | "unknown";
  }> = [];
  let serverState = cloneState(initialState);
  const pendingAttachmentsBySession = new Map([
    [serverState.activeSessionId, cloneState(serverState).pendingAttachments],
  ]);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));

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
                return failedResponse({
                  error: error.error,
                  commandOutcome: "unknown",
                  state: cloneState(serverState),
                }, 500, "Internal Server Error");
              }
              if (truncatedAttachmentResponses > 0) {
                truncatedAttachmentResponses -= 1;
                return truncatedJsonResponse();
              }
              return response(cloneState(serverState));
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
              return response(cloneState(serverState));
            }

            if (url.pathname === "/skills" && init?.method === "POST") {
              const file = init.body as File;
              const bytes = new Uint8Array(await file.arrayBuffer());
              const source = NodeBuffer.from(bytes).toString("utf8");
              const id = /^name:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "";
              const description = /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "";
              const existing = serverState.availableSkills.find(
                (skill) => skill.id === id,
              );
              if (existing && url.searchParams.get("replace") !== "true") {
                return failedResponse(
                  { error: `Skill ${id} is already installed.` },
                  409,
                  "Conflict",
                );
              }
              serverState.availableSkills = [
                ...serverState.availableSkills.filter((skill) => skill.id !== id),
                { id, description },
              ].sort((left, right) => left.id.localeCompare(right.id));
              const responseRejection = skillResponseRejections.shift();
              if (responseRejection) throw responseRejection;
              if (truncatedSkillResponses > 0) {
                truncatedSkillResponses -= 1;
                return truncatedJsonResponse();
              }
              return response({
                state: cloneState(serverState),
                receipt: {
                  id,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              });
            }

            if (url.pathname.startsWith("/skills/") && init?.method === "DELETE") {
              const skillId = decodeURIComponent(url.pathname.slice("/skills/".length));
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
              serverState.availableSkills = serverState.availableSkills.filter(
                (skill) => skill.id !== skillId,
              );
              if (truncatedSkillResponses > 0) {
                truncatedSkillResponses -= 1;
                return truncatedJsonResponse();
              }
              return response(cloneState(serverState));
            }

            if (url.pathname === "/command") {
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
                return failedResponse(error, 400, "Bad Request");
              }
              const command = body as {
                kind?: string;
                approvalMode?: "manual" | "low-risk" | "everything";
                defaultFollowUpBehavior?: "queue" | "steer";
                profile?: SavedProfile;
                profileId?: string;
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
              } else if (command.kind === "save_profile" && command.profile) {
                const profiles = serverState.settings.profiles.filter(
                  (profile) => profile.id !== command.profile?.id,
                );
                profiles.push(JSON.parse(JSON.stringify(command.profile)) as SavedProfile);
                serverState.settings.profiles = profiles;
                serverState.settings.activeProfileId = command.profile.id;
                serverState.modelStateSource = modelStateSourceFixture(command.profile);
                serverState.runtimeProfile = {
                  profile: command.profile,
                  capabilities: capabilities(),
                  inputCapabilityEvidence: inputCapabilityEvidence(),
                };
              } else if (command.kind === "discover_models") {
                serverState.availableModels = [{
                  id: "model-discovered",
                  displayName: "Discovered model",
                  capabilities: capabilities(),
                }];
                if (command.profile) {
                  serverState.modelStateSource = modelStateSourceFixture(command.profile);
                  serverState.capabilities = capabilities();
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
                  ? {
                      profile,
                      capabilities: capabilities(),
                      inputCapabilityEvidence: inputCapabilityEvidence(),
                    }
                  : null;
              } else if (command.kind === "select_session" && command.sessionId) {
                serverState.activeSessionId = command.sessionId;
                const selected = serverState.sessions.find(
                  (entry) => entry.id === command.sessionId,
                );
                serverState.approvalMode = selected?.approvalMode ?? "manual";
                serverState.pendingAttachments = pendingAttachmentsBySession.get(
                  command.sessionId,
                ) ?? [];
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
                serverState.approvalMode = serverState.sessions[0]?.approvalMode ?? "manual";
              }
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
              return response(cloneState(serverState));
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
              return response(cloneState(serverState));
            }
            if (url.pathname === "/send") {
              const wait = heldSends.shift();
              if (wait) await wait;
              if (nextSendError) {
                const error = nextSendError;
                nextSendError = null;
                return failedResponse(error, 500, "Internal Server Error");
              }
              if (nextSendRejection) {
                const error = nextSendRejection;
                nextSendRejection = null;
                throw error;
              }
              return response({ ok: true });
            }
            if (url.pathname === "/steer") {
              if (heldSteer) {
                const wait = heldSteer;
                heldSteer = null;
                await wait;
              }
              if (nextSteerError) {
                const error = nextSteerError;
                nextSteerError = null;
                return failedResponse(
                  error,
                  error.steeringOutcome === "unknown" ? 503 : 409,
                  error.steeringOutcome === "unknown"
                    ? "Service Unavailable"
                    : "Conflict",
                );
              }
              if (nextSteerResponseRejection) {
                const error = nextSteerResponseRejection;
                nextSteerResponseRejection = null;
                throw error;
              }
              return response({ ok: true });
            }
            if (url.pathname === "/confirm") {
              if (heldConfirmation) {
                const wait = heldConfirmation;
                heldConfirmation = null;
                await wait;
              }
              if (nextConfirmationError) {
                const error = nextConfirmationError;
                nextConfirmationError = null;
                return failedResponse(error, 503, "Service Unavailable");
              }
            }
            if (url.pathname === "/stop") {
              const outcome = stopOutcomes.shift();
              return response({
                ok: true,
                ...(outcome || { terminal: stopTerminals.shift() ?? true }),
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
    document: window.document,
    emitServerEvent(payload) {
      const source = eventSources.at(-1);
      assert.ok(source?.onmessage, "Expected the EventSource to be connected");
      source.onmessage({ data: JSON.stringify(payload) });
    },
    emitServerEventError() {
      const source = eventSources.at(-1);
      assert.ok(source?.onerror, "Expected the EventSource to be connected");
      source.onerror();
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
    rejectNextCommand(error) {
      nextCommandRejection = new Error(error);
    },
    rejectNextCommandResponse(error) {
      nextCommandResponseRejection = new Error(error);
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
  )].map((item) => [item.textContent?.trim() ?? "", item.dataset.capabilityState]);
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
): NonNullable<ChatDialogState["runtimeProfile"]> {
  const runtimeCapabilities = capabilities();
  const evidence = inputCapabilityEvidence();
  if (profile.model === "pdf-capable-model") {
    runtimeCapabilities.inputs.pdf = true;
    evidence.pdf = "supported";
  }
  return {
    profile,
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
  stateFixture,
  waitForCondition,
};
export type { DialogHarness };
