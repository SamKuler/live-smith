import type { MidiContinuationCommand } from "../../agent/midi-continuation-contracts.js";
import { isCreativeBrief, MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../agent/creative-brief.js";
import { MAX_AUDIO_PARAMETER_BYTES } from "../../plugins/builtins/parameter-panel.js";
import type { MidiArtifactImportCommand } from "../midi-artifact-import.js";
import { isCandidateSelection, type CandidateSelection } from "../../agent/candidate-contracts.js";
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

import {
  isEditScopes,
  resolveEditScopes,
  type EditScope,
} from "../../agent/edit-scopes.js";
import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_DOCUMENT_ATTACHMENT_BYTES, MAX_PENDING_ATTACHMENT_COUNT } from "../../attachments/contracts.js";
import {
  isSafeSkillId,
  isSafeSkillReferenceId,
  MAX_SKILL_FILE_BYTES,
} from "../../skills/format.js";
import { isSafePluginId } from "../../plugins/contracts.js";
import { configRecord, MAX_PLUGIN_CONFIG_BYTES } from "../../plugins/user-config.js";
import { requireSafeStorageId, isSafeStorageId } from "../../storage/id.js";
import { normalizeIntegrationConnectionsSettingsPatch, type IntegrationConnectionsSettingsPatch } from "../../storage/settings.js";
import {
  MAX_SESSION_TITLE_CODE_POINTS,
  isSessionTitle,
} from "../../storage/sessions.js";
import {
  isApprovalMode,
  isDefaultFollowUpBehavior,
  isUiLanguage,
  isProfileId,
  isReasoningEffort,
  normalizeCustomInstructions,
  normalizeNetworkProxySettings,
  ProfileValidationError,
  type ApprovalMode,
  type DefaultFollowUpBehavior,
  type UiLanguage,
  type DraftProfile,
  type NetworkProxySettings,
  type OAuthSubscriptionProvider,
  type ReasoningEffort,
} from "../../model/profile.js";

const maxRequestBodyBytes = 1024 * 1024;
const maxSteeringPromptUtf8Bytes = 64 * 1024;
const maxCompactionInstructionsUtf8Bytes = 16 * 1024;
const maxAttachmentFileNameUtf8Bytes = 160;
const maxAttachmentQueryUtf8Bytes = 2048;
const maxConcurrentAttachmentBodyReads = 2;
const defaultAttachmentBodyReadTimeoutMs = 15_000;
const initialUnknownAttachmentBodyCapacity = 64 * 1024;
const maxConcurrentSkillBodyReads = 2;
const defaultSkillBodyReadTimeoutMs = 15_000;
const initialUnknownSkillBodyCapacity = 8 * 1024;
const mimeTypePattern =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

export type ChatBridgeStopTarget =
  | { kind: "send"; id: string }
  | { kind: "command"; id: string };

export interface ChatBridgeAttachmentInput {
  sessionId: string;
  fileName: string;
  claimedMediaType?: string;
  bytes: Uint8Array;
}

export interface ChatBridgeAttachmentSelectionInput {
  sessionId: string;
  attachmentId: string;
  mode: "copy" | "original" | "excerpt" | "convert-mp3";
  replace: boolean;
  startSeconds?: number;
  endSeconds?: number;
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

export interface ChatBridgeSkillDeleteInput {
  skillId: string;
}

export interface ChatBridgePluginInstallInput {
  bytes: Uint8Array;
  replace: boolean;
}

export interface ChatBridgePluginInspectInput {
  bytes: Uint8Array;
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

export interface RawPluginBodyReadOptions extends RawAttachmentBodyReadOptions {}

export type ChatBridgeCommandInput =
  | MidiContinuationCommand
  | MidiArtifactImportCommand
  | { kind: "select_candidate"; sessionId: string; selection: CandidateSelection }
  | {
      kind: "save_profile";
      profile: DraftProfile;
      expectedProfileRevision: string | null;
    }
  | { kind: "delete_profile"; profileId: string }
  | { kind: "activate_profile"; profileId: string }
  | { kind: "discard_profile_oauth"; profileId: string }
  | {
      kind: "start_oauth_login";
      profileId: string;
      provider: OAuthSubscriptionProvider;
    }
  | {
      kind: "refresh_oauth_account";
      profileId: string;
      provider: OAuthSubscriptionProvider;
    }
  | {
      kind: "open_oauth_authorization";
      profileId: string;
      provider: OAuthSubscriptionProvider;
    }
  | {
      kind: "submit_oauth_authorization_code";
      profileId: string;
      provider: "google";
      authorizationCode: string;
    }
  | {
      kind: "logout_oauth";
      profileId: string;
      provider: OAuthSubscriptionProvider;
    }
  | {
      kind: "save_global_settings";
      uiLanguage?: never;
      defaultFollowUpBehavior: DefaultFollowUpBehavior;
      integrationConnections?: never;
      showContextUsage?: never;
      networkProxy?: never;
      customInstructions?: never;
    }
  | {
      kind: "save_global_settings";
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage: boolean;
      integrationConnections?: never;
      networkProxy?: never;
      customInstructions?: never;
    }
  | {
      kind: "save_global_settings";
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy: NetworkProxySettings;
      integrationConnections?: never;
      customInstructions?: never;
    }
  | {
      kind: "save_global_settings";
      uiLanguage: UiLanguage;
      integrationConnections?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      customInstructions?: never;
    }
  | {
      kind: "save_global_settings";
      integrationConnections: IntegrationConnectionsSettingsPatch;
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      customInstructions?: never;
    }
  | {
      kind: "save_global_settings";
      customInstructions: string;
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      integrationConnections?: never;
    }
  | { kind: "resume_audio_job"; sessionId: string; jobId: string }
  | { kind: "download_audio_output"; sessionId: string; jobId: string; outputKey: string }
  | { kind: "open_audio_download"; sessionId: string; assetId: string }
  | { kind: "export_midi_artifact"; sessionId: string; artifactRef: string }
  | { kind: "attach_midi_artifact"; sessionId: string; artifactRef: string }
  | { kind: "open_attachment"; sessionId: string; attachmentId: string }
  | { kind: "open_suno_website" }
  | { kind: "open_suno_platform" }
  | { kind: "import_suno_session"; serviceId: string; sessionValue: string }
  | { kind: "refresh_suno_login"; serviceId: string }
  | { kind: "logout_suno"; serviceId: string }
  | { kind: "load_suno_models"; serviceId: string }
  | {
      kind: "set_session_approval_mode";
      sessionId: string;
      approvalMode: ApprovalMode;
    }
  | {
      kind: "set_session_edit_scopes";
      sessionId: string;
      editScopes: EditScope[];
    }
  | {
      kind: "set_session_creative_brief";
      sessionId: string;
      creativeBrief: string;
      expectedCreativeBrief: string;
    }
  | {
      kind: "set_session_model_selection";
      sessionId: string;
      profileId: string;
      model: string;
      reasoningEffort: ReasoningEffort | null;
    }
  | {
      kind: "load_session_model_capabilities";
      sessionId: string;
      profileId: string;
    }
  | { kind: "load_session_tools"; sessionId: string }
  | { kind: "run_audio_tool"; sessionId: string; toolName: string; signature: string; arguments: Record<string, unknown> }
  | { kind: "run_plugin_tool"; sessionId: string; toolName: string; signature: string; arguments: Record<string, unknown> }
  | { kind: "start_mcp_oauth"; connectionId: string }
  | { kind: "logout_mcp_oauth"; connectionId: string }
  | { kind: "new_session" }
  | { kind: "compact_session"; sessionId: string; instructions?: string }
  | { kind: "select_session"; sessionId: string }
  | { kind: "restore_session"; sessionId: string }
  | { kind: "delete_session"; sessionId: string }
  | { kind: "rename_session"; sessionId: string; title: string }
  | { kind: "archive_session"; sessionId: string }
  | { kind: "unarchive_session"; sessionId: string }
  | { kind: "set_session_skills"; sessionId: string; skillIds: string[] }
  | { kind: "set_plugin_enabled"; pluginId: string; enabled: boolean }
  | { kind: "set_plugin_user_config"; pluginId: string; sha256: string; revision: string; values: Record<string, unknown>; secretUpdates: Record<string, unknown> }
  | { kind: "set_plugin_mcp_server_approved"; pluginId: string; serverId: string; approved: boolean }
  | { kind: "set_plugin_artifact_permission"; pluginId: string; serverId: string; permission: "input" | "output"; approved: boolean }
  | { kind: "delete_plugin"; pluginId: string }
  | { kind: "discover_models"; profile: DraftProfile };

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

export class ChatBridgeRequestValidationError extends Error {
  readonly field?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { field?: string },
  ) {
    super(message, options);
    this.name = "ChatBridgeRequestValidationError";
    if (options?.field !== undefined) this.field = options.field;
  }
}

export class ChatBridgeRequestTimeoutError extends Error {
  readonly status = 408;

  constructor(message: string) {
    super(message);
    this.name = "ChatBridgeRequestTimeoutError";
  }
}

export function sendIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-send-id",
    "X-Live-Smith-Send-Id must be a valid correlation ID.",
  );
}

export function stopTargetForRequest(
  request: IncomingMessage,
): ChatBridgeStopTarget {
  const sendId = optionalCorrelationId(
    request,
    "x-live-smith-send-id",
    "X-Live-Smith-Send-Id must identify the send to stop.",
  );
  const commandId = optionalCorrelationId(
    request,
    "x-live-smith-command-id",
    "X-Live-Smith-Command-Id must identify the command to stop.",
  );
  if ((sendId === undefined) === (commandId === undefined)) {
    throw new ChatBridgeRequestValidationError(
      "Stop requests require exactly one Send ID or Command ID.",
    );
  }
  return sendId === undefined
    ? { kind: "command", id: commandId! }
    : { kind: "send", id: sendId };
}

/** Attachment selection is request metadata, like the Send/Steer correlation IDs. */
export function attachmentIdsForRequest(request: IncomingMessage): readonly string[] | undefined {
  const raw = singleHeaderValue(request, "x-live-smith-attachment-ids", false);
  if (raw === undefined) return undefined;
  try {
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids) || ids.length > MAX_PENDING_ATTACHMENT_COUNT ||
        new Set(ids).size !== ids.length) throw new Error("Invalid attachment IDs");
    for (const id of ids) requireSafeStorageId(id, "Attachment ID");
    return ids as string[];
  } catch {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Attachment-Ids must contain a bounded array of unique attachment IDs.",
    );
  }
}

export function steeringSendIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-send-id",
    "X-Live-Smith-Send-Id must identify the send to steer.",
  );
}

export function steeringIdForRequest(request: IncomingMessage): string {
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
  if (raw === undefined || !correlationIdPattern.test(raw)) {
    throw new ChatBridgeRequestValidationError(errorMessage);
  }
  return raw;
}

function optionalCorrelationId(
  request: IncomingMessage,
  headerName: string,
  errorMessage: string,
): string | undefined {
  const raw = singleHeaderValue(request, headerName, false);
  if (raw !== undefined && !correlationIdPattern.test(raw)) {
    throw new ChatBridgeRequestValidationError(errorMessage);
  }
  return raw;
}

export function commandIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-command-id",
    "X-Live-Smith-Command-Id must be a valid unique correlation ID.",
  );
}

export function tokenForRequest(url: URL): string | undefined {
  const values = url.searchParams.getAll("token");
  if (values.length > 1) {
    throw new ChatBridgeRequestValidationError(
      "token must appear at most once in a bridge request.",
    );
  }
  return values[0];
}

export function assertExactQueryParameters(
  url: URL,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ChatBridgeRequestValidationError(
        `${label} does not support query parameter ${key}.`,
      );
    }
  }
  if (url.searchParams.getAll("token").length !== 1) {
    throw new ChatBridgeRequestValidationError(
      `token must appear exactly once in the ${label.toLowerCase()}.`,
    );
  }
}

export function assertJsonContentType(request: IncomingMessage): void {
  const contentType = singleHeaderValue(request, "content-type", true);
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      contentType,
    )
  ) {
    throw new ChatBridgeRequestValidationError(
      "JSON requests require Content-Type application/json with optional UTF-8 charset.",
    );
  }
}
export async function readJsonBody<T>(
  request: AsyncIterable<string | Uint8Array>,
  maximumBytes = maxRequestBodyBytes,
): Promise<T> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) {
      throw new ChatBridgeRequestValidationError(
        `Request body exceeds ${maximumBytes} bytes.`,
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
  allowEmpty = false,
): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    assertAttachmentContentType(request);
    declaredLength = boundedContentLength(
      request,
      "Attachment",
      MAX_ATTACHMENT_UPLOAD_BYTES,
    );
    if (declaredLength === 0 && !allowEmpty) {
      throw new ChatBridgeRequestValidationError("Attachment body must not be empty.");
    }
  } catch (error) {
    request.resume();
    throw error;
  }

  return readBoundedRawBody(request, declaredLength, {
    maximumBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
    allowEmpty,
    initialCapacity: initialUnknownAttachmentBodyCapacity,
    timeoutMs: options.timeoutMs ?? defaultAttachmentBodyReadTimeoutMs,
    allocateBuffer: options.allocateBuffer ?? Buffer.allocUnsafe,
    acquirePermit: acquireAttachmentBodyReadPermit,
    emptyMessage: "Attachment body must not be empty.",
    tooLargeMessage:
      `Attachment uploads may not exceed ${MAX_ATTACHMENT_UPLOAD_BYTES} bytes.`,
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

export function readRawPluginBody(
  request: IncomingMessage,
  options: RawPluginBodyReadOptions = {},
): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    assertPluginContentType(request);
    declaredLength = boundedContentLength(request, "Plugin", MAX_DOCUMENT_ATTACHMENT_BYTES);
    if (declaredLength === 0) throw new ChatBridgeRequestValidationError("Plugin body must not be empty.");
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
    emptyMessage: "Plugin body must not be empty.",
    tooLargeMessage: `Plugin uploads may not exceed ${MAX_DOCUMENT_ATTACHMENT_BYTES} bytes.`,
    mismatchMessage: "Plugin Content-Length does not match the received body.",
    timeoutMessage: "Plugin upload timed out before the complete body was received.",
    incompleteMessage: "Plugin upload ended before the complete body was received.",
    readErrorMessage: "Plugin upload could not be read.",
    bufferErrorMessage: "Plugin upload could not be buffered.",
  });
}

interface BoundedRawBodyPolicy {
  allowEmpty?: boolean;
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
      if (actualLength === 0 && !policy.allowEmpty) {
        fail(new ChatBridgeRequestValidationError(policy.emptyMessage));
        return;
      }
      if (declaredLength !== undefined && declaredLength !== actualLength) {
        fail(new ChatBridgeRequestValidationError(policy.mismatchMessage));
        return;
      }
      settled = true;
      cleanup();
      resolve(body?.subarray(0, actualLength) ?? new Uint8Array());
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

export function parseAttachmentUploadQuery(
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

export function parseAttachmentSelectionQuery(request: IncomingMessage, url: URL): Omit<ChatBridgeAttachmentSelectionInput, "bytes"> {
  assertAttachmentQuery(request, url, ["token", "sessionId", "mode", "replace",
    ...(url.searchParams.has("start") || url.searchParams.has("end") ? ["start", "end"] : [])]);
  const referenceUrl = new URL(url);
  for (const key of ["mode", "replace", "start", "end"]) referenceUrl.searchParams.delete(key);
  const reference = parseAttachmentReferenceQuery(request, referenceUrl);
  const mode = url.searchParams.get("mode");
  const replace = url.searchParams.get("replace");
  if (!["copy", "original", "excerpt", "convert-mp3"].includes(mode ?? "") || !["true", "false"].includes(replace ?? "")) {
    throw new ChatBridgeRequestValidationError("Attachment selection mode is invalid.");
  }
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (mode === "copy" || mode === "original") {
    if (start !== null || end !== null) throw new ChatBridgeRequestValidationError("Whole-file reuse does not accept a time range.");
    return { ...reference, mode, replace: replace === "true" };
  }
  const startSeconds = start === null || start.trim() === "" ? NaN : Number(start);
  const endSeconds = end === null || end.trim() === "" ? NaN : Number(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 900) {
    throw new ChatBridgeRequestValidationError("Select a valid audio time range.");
  }
  return { ...reference, mode: mode as "excerpt" | "convert-mp3", replace: replace === "true", startSeconds, endSeconds };
}

export function parseAttachmentReferenceQuery(
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

export function parseSkillInstallQuery(
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

export function parsePluginInstallQuery(
  request: IncomingMessage,
  url: URL,
): { replace: boolean } {
  assertSkillQuery(request, url, ["token", "replace"]);
  const values = url.searchParams.getAll("replace");
  if (values.length === 0) return { replace: false };
  if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false")) {
    throw new ChatBridgeRequestValidationError("replace must be true or false when provided.");
  }
  return { replace: values[0] === "true" };
}

export function parseSkillDeleteQuery(
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
  assertExactQueryParameters(url, allowedKeys, "Skill request");
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

function assertPluginContentType(request: IncomingMessage): void {
  const contentType = singleHeaderValue(request, "content-type", true);
  if (contentType === undefined ||
      !/^(?:application\/zip|application\/octet-stream)$/iu.test(contentType.trim())) {
    throw new ChatBridgeRequestValidationError(
      "Plugin uploads require Content-Type application/zip or application/octet-stream.",
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
export function parseSendInput(value: unknown): ChatBridgeSendInput {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["prompt", "sessionId"], "Send request");
  return {
    prompt: inputString(input, "prompt"),
    sessionId: inputString(input, "sessionId"),
  };
}

export function parseSteeringInput(value: unknown): ChatBridgeSteeringInput {
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

export function parseCommandInput(value: unknown): ChatBridgeCommandInput {
  const input = inputRecord(value);
  const kind = inputString(input, "kind");
  if (kind === "save_global_settings") {
    assertOnlyInputKeys(
      input,
      ["kind", "defaultFollowUpBehavior", "showContextUsage", "networkProxy", "uiLanguage", "integrationConnections", "customInstructions"],
      `${kind} command`,
    );
    const hasFollowUpBehavior = Object.prototype.hasOwnProperty.call(
      input,
      "defaultFollowUpBehavior",
    );
    const hasContextUsage = Object.prototype.hasOwnProperty.call(
      input,
      "showContextUsage",
    );
    const hasUiLanguage = Object.prototype.hasOwnProperty.call(input, "uiLanguage");
    const hasAudioService = Object.prototype.hasOwnProperty.call(input, "integrationConnections");
    const hasCustomInstructions = Object.prototype.hasOwnProperty.call(input, "customInstructions");
    const hasNetworkProxy = Object.prototype.hasOwnProperty.call(
      input,
      "networkProxy",
    );
    if (
      Number(hasFollowUpBehavior) +
        Number(hasContextUsage) +
        Number(hasNetworkProxy) +
        Number(hasUiLanguage) + Number(hasAudioService) + Number(hasCustomInstructions) !== 1
    ) {
      throw new ChatBridgeRequestValidationError(
        "save_global_settings must contain exactly one setting.",
      );
    }
    if (hasUiLanguage) {
      if (!isUiLanguage(input.uiLanguage)) {
        throw new ChatBridgeRequestValidationError(
          "uiLanguage must be system or a registered interface language.",
        );
      }
      return { kind, uiLanguage: input.uiLanguage };
    }
    if (hasFollowUpBehavior) {
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
    if (hasContextUsage && typeof input.showContextUsage !== "boolean") {
      throw new ChatBridgeRequestValidationError(
        "showContextUsage must be a boolean.",
      );
    }
    if (hasContextUsage) {
      return { kind, showContextUsage: input.showContextUsage as boolean };
    }
    try {
      if (hasCustomInstructions) return {
        kind,
        customInstructions: normalizeCustomInstructions(input.customInstructions),
      };
      if (hasAudioService) return { kind, integrationConnections: normalizeIntegrationConnectionsSettingsPatch(input.integrationConnections) };
      return {
        kind,
        networkProxy: normalizeNetworkProxySettings(input.networkProxy),
      };
    } catch (error) {
      if (error instanceof ProfileValidationError) {
        throw new ChatBridgeRequestValidationError(error.message, {
          field: error.field,
        });
      }
      throw error;
    }
  }
  if (kind === "open_suno_website" || kind === "open_suno_platform") {
    assertOnlyInputKeys(input, ["kind"], `${kind} command`);
    return { kind };
  }
  if (kind === "import_suno_session") {
    assertOnlyInputKeys(input, ["kind", "serviceId", "sessionValue"], "import_suno_session command");
    if (!isSafeStorageId(input.serviceId)) throw new ChatBridgeRequestValidationError("Suno connection ID must be a safe storage ID.");
    if (typeof input.sessionValue !== "string" || !input.sessionValue.trim() || input.sessionValue.length > 16_384 ||
      /[\u0000-\u001f\u007f]/u.test(input.sessionValue)) {
      throw new ChatBridgeRequestValidationError("Enter a Suno session Cookie value or Cookie header (up to 16384 characters).");
    }
    return { kind, serviceId: input.serviceId, sessionValue: input.sessionValue };
  }
  if (kind === "refresh_suno_login" || kind === "logout_suno" || kind === "load_suno_models") {
    assertOnlyInputKeys(input, ["kind", "serviceId"], `${kind} command`);
    if (!isSafeStorageId(input.serviceId)) throw new ChatBridgeRequestValidationError("Suno connection ID must be a safe storage ID.");
    return { kind, serviceId: input.serviceId };
  }
  if (kind === "download_audio_output") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "jobId", "outputKey"], "download_audio_output command");
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.jobId) ||
      typeof input.outputKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.outputKey)) {
      throw new ChatBridgeRequestValidationError("Choose one generated Suno output from this Session.");
    }
    return { kind, sessionId: input.sessionId, jobId: input.jobId, outputKey: input.outputKey };
  }
  if (kind === "export_midi_artifact" || kind === "attach_midi_artifact") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "artifactRef"], `${kind} command`);
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.artifactRef)) {
      throw new ChatBridgeRequestValidationError("Choose a saved MIDI version in this Session.");
    }
    return { kind, sessionId: input.sessionId, artifactRef: input.artifactRef };
  }
  if (kind === "open_audio_download") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "assetId"], "open_audio_download command");
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.assetId)) {
      throw new ChatBridgeRequestValidationError("Choose a saved audio file in this Session.");
    }
    return { kind, sessionId: input.sessionId, assetId: input.assetId };
  }
  if (kind === "open_attachment") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "attachmentId"], "open_attachment command");
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.attachmentId)) {
      throw new ChatBridgeRequestValidationError("Choose an attached file in this Session.");
    }
    return { kind, sessionId: input.sessionId, attachmentId: input.attachmentId };
  }
  if (kind === "resume_audio_job") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "jobId"], "resume_audio_job command");
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.jobId)) {
      throw new ChatBridgeRequestValidationError("Audio job and Session IDs must be safe storage IDs.");
    }
    return { kind, sessionId: input.sessionId, jobId: input.jobId };
  }
  if (kind === "save_profile") {
    assertOnlyInputKeys(
      input,
      ["kind", "profile", "expectedProfileRevision"],
      `${kind} command`,
    );
    if (!isRecord(input.profile)) {
      throw new ChatBridgeRequestValidationError("profile must be an object.");
    }
    if (
      input.expectedProfileRevision !== null &&
      (
        typeof input.expectedProfileRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.expectedProfileRevision)
      )
    ) {
      throw new ChatBridgeRequestValidationError(
        "expectedProfileRevision must be a lowercase SHA-256 digest or null.",
      );
    }
    return {
      kind,
      profile: input.profile as unknown as DraftProfile,
      expectedProfileRevision: input.expectedProfileRevision,
    };
  }
  if (kind === "discover_models") {
    assertOnlyInputKeys(input, ["kind", "profile"], `${kind} command`);
    if (!isRecord(input.profile)) {
      throw new ChatBridgeRequestValidationError("profile must be an object.");
    }
    return { kind, profile: input.profile as unknown as DraftProfile };
  }
  if (kind === "discard_profile_oauth") {
    assertOnlyInputKeys(input, ["kind", "profileId"], `${kind} command`);
    const profileId = inputString(input, "profileId");
    if (!isProfileId(profileId)) {
      throw new ChatBridgeRequestValidationError(
        "profileId must be a valid Profile ID.",
      );
    }
    return { kind, profileId };
  }
  if (kind === "delete_profile" || kind === "activate_profile") {
    assertOnlyInputKeys(input, ["kind", "profileId"], `${kind} command`);
    return { kind, profileId: inputString(input, "profileId") };
  }
  if (kind === "start_mcp_oauth" || kind === "logout_mcp_oauth") {
    assertOnlyInputKeys(input, ["kind", "connectionId"], `${kind} command`);
    const connectionId = inputString(input, "connectionId");
    if (!isProfileId(connectionId)) throw new ChatBridgeRequestValidationError("MCP connection ID is invalid.");
    return { kind, connectionId };
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
  if (kind === "set_session_edit_scopes") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "editScopes"],
      `${kind} command`,
    );
    if (!isEditScopes(input.editScopes)) {
      throw new ChatBridgeRequestValidationError(
        "editScopes must be a list of distinct supported scopes.",
      );
    }
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      editScopes: resolveEditScopes(input.editScopes),
    };
  }
  if (kind === "set_session_creative_brief") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "creativeBrief", "expectedCreativeBrief"], `${kind} command`);
    if (!isCreativeBrief(input.creativeBrief) || !isCreativeBrief(input.expectedCreativeBrief)) {
      throw new ChatBridgeRequestValidationError(
        `Creative brief must be text of at most ${MAX_CREATIVE_BRIEF_CODE_POINTS} characters.`,
      );
    }
    return { kind, sessionId: inputString(input, "sessionId"),
      creativeBrief: input.creativeBrief, expectedCreativeBrief: input.expectedCreativeBrief };
  }
  if (kind === "set_session_model_selection") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "profileId", "model", "reasoningEffort"],
      `${kind} command`,
    );
    if (
      input.reasoningEffort !== null &&
      !isReasoningEffort(input.reasoningEffort)
    ) {
      throw new ChatBridgeRequestValidationError(
        "reasoningEffort must be a supported effort or null.",
      );
    }
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      profileId: inputString(input, "profileId"),
      model: inputString(input, "model"),
      reasoningEffort: input.reasoningEffort,
    };
  }
  if (kind === "load_session_model_capabilities") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "profileId"],
      `${kind} command`,
    );
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      profileId: inputString(input, "profileId"),
    };
  }
  if (kind === "load_session_tools") {
    assertOnlyInputKeys(input, ["kind", "sessionId"], `${kind} command`);
    if (!isSafeStorageId(input.sessionId)) {
      throw new ChatBridgeRequestValidationError("Choose one valid Session before loading tools.");
    }
    return { kind, sessionId: input.sessionId };
  }
  if (kind === "load_midi_continuation" || kind === "fill_midi_continuation") {
    assertOnlyInputKeys(input, kind === "load_midi_continuation" ? ["kind", "sessionId"] : ["kind", "sessionId", "bufferId"], `${kind} command`);
    if (!isSafeStorageId(input.sessionId) || kind === "fill_midi_continuation" && !isSafeStorageId(input.bufferId)) throw new ChatBridgeRequestValidationError("Choose the active MIDI continuation Session and buffer.");
    return kind === "load_midi_continuation" ? { kind, sessionId: input.sessionId } : { kind, sessionId: input.sessionId, bufferId: input.bufferId as string };
  }
  if (kind === "configure_midi_continuation") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "expectedBufferId", "sourceClips", "segmentBeats", "capacity", "prompt", "generator"], `${kind} command`);
    const generator = input.generator;
    if (!isSafeStorageId(input.sessionId) || input.expectedBufferId !== null && !isSafeStorageId(input.expectedBufferId) ||
        !Array.isArray(input.sourceClips) || !input.sourceClips.length || input.sourceClips.length > 16 ||
        !input.sourceClips.every((ref) => ref && typeof ref === "object" && !Array.isArray(ref) && Object.keys(ref).length === 2 && isSafeStorageId(ref.trackId) && isSafeStorageId(ref.clipId)) ||
        new Set(input.sourceClips.map((ref) => `${ref.trackId}:${ref.clipId}`)).size !== input.sourceClips.length ||
        typeof input.segmentBeats !== "number" || !Number.isFinite(input.segmentBeats) || input.segmentBeats < 1 || input.segmentBeats > 256 ||
        !Number.isInteger(input.capacity) || Number(input.capacity) < 1 || Number(input.capacity) > 4 ||
        typeof input.prompt !== "string" || input.prompt.length > 8000 || !generator || typeof generator !== "object" || Array.isArray(generator)) {
      throw new ChatBridgeRequestValidationError("Choose 1–16 MIDI sources, a section length of 1–256 beats and a buffer capacity of 1–4.");
    }
    const source = generator as Record<string, unknown>;
    if (source.kind === "model") assertOnlyInputKeys(source, ["kind"], "MIDI model generator");
    else if (source.kind === "plugin") {
      assertOnlyInputKeys(source, ["kind", "toolName", "signature", "arguments"], "MIDI Plugin generator");
      if (typeof source.toolName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(source.toolName) ||
          typeof source.signature !== "string" || !/^[a-f0-9]{64}$/u.test(source.signature) || !source.arguments || typeof source.arguments !== "object" || Array.isArray(source.arguments) ||
          Buffer.byteLength(JSON.stringify(source.arguments), "utf8") > 32 * 1024 || input.prompt !== "") throw new ChatBridgeRequestValidationError("Choose a declared MIDI conditioning tool and its current parameters.");
    } else throw new ChatBridgeRequestValidationError("Choose the current model or a declared MIDI conditioning tool.");
    return input as unknown as Extract<MidiContinuationCommand, { kind: "configure_midi_continuation" }>;
  }
  if (kind === "import_midi_continuation") {
    if (!isSafeStorageId(input.bufferId)) throw new ChatBridgeRequestValidationError("Choose the current MIDI buffer.");
    const { bufferId, ...rest } = input;
    const imported = parseCommandInput({ ...rest, kind: "import_midi_artifact" });
    if (imported.kind !== "import_midi_artifact") throw new ChatBridgeRequestValidationError("Invalid MIDI import.");
    return { ...imported, kind, bufferId };
  }
  if (kind === "import_midi_artifact") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "artifactRef", "trackName", "trackId", "mergeParts", "mappings", "startBeat", "name"], `${kind} command`);
    const validName = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 256;
    const validTrackId = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,30}$/u.test(value);
    const mappings = input.mappings;
    if (mappings !== undefined) {
      if (input.trackName !== undefined || input.trackId !== undefined || input.mergeParts !== undefined ||
          !Array.isArray(mappings) || !mappings.length || mappings.length > 64 ||
          mappings.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) ||
            Object.keys(entry).some((key) => !["partId", "trackId", "trackName"].includes(key)) ||
            typeof entry.partId !== "string" || !/^track-[0-9]{1,2}-channel-(?:[1-9]|1[0-6])$/u.test(entry.partId) ||
            !validTrackId(entry.trackId) || !validName(entry.trackName)) ||
          new Set(mappings.map((entry) => entry.partId)).size !== mappings.length ||
          new Set(mappings.map((entry) => entry.trackId)).size !== mappings.length) {
        throw new ChatBridgeRequestValidationError("Map each selected source part to a different observed MIDI track (at most 64 parts).");
      }
    } else if (!validName(input.trackName) || input.trackId !== undefined && !validTrackId(input.trackId) ||
        input.mergeParts !== undefined && typeof input.mergeParts !== "boolean") {
      throw new ChatBridgeRequestValidationError("Choose a MIDI destination and explicit import mode.");
    }
    if (!isSafeStorageId(input.sessionId) || !isSafeStorageId(input.artifactRef) ||
        typeof input.startBeat !== "number" || !Number.isFinite(input.startBeat) || input.startBeat < 0 ||
        (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim()))) {
      throw new ChatBridgeRequestValidationError("Choose a MIDI artifact, target track, and non-negative start beat.");
    }
    return { kind, sessionId: input.sessionId, artifactRef: input.artifactRef,
      ...(mappings === undefined ? { trackName: input.trackName as string,
        ...(input.trackId === undefined ? {} : { trackId: input.trackId as string }),
        ...(input.mergeParts === undefined ? {} : { mergeParts: input.mergeParts as boolean }) }
        : { mappings: mappings as NonNullable<MidiArtifactImportCommand["mappings"]> }),
      startBeat: input.startBeat,
      ...(input.name === undefined ? {} : { name: input.name as string }) };
  }
  if (kind === "select_candidate") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "selection"], `${kind} command`);
    if (!isSafeStorageId(input.sessionId) || !isCandidateSelection(input.selection)) {
      throw new ChatBridgeRequestValidationError("Choose a saved candidate and selection action.");
    }
    return { kind, sessionId: input.sessionId, selection: input.selection };
  }
  if (kind === "run_plugin_tool" || kind === "run_audio_tool") {
    assertOnlyInputKeys(input, ["kind", "sessionId", "toolName", "signature", "arguments"], `${kind} command`);
    if (!isSafeStorageId(input.sessionId) || typeof input.toolName !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(input.toolName) || typeof input.signature !== "string" ||
        !/^[a-f0-9]{64}$/u.test(input.signature) || !input.arguments ||
        typeof input.arguments !== "object" || Array.isArray(input.arguments) ||
        kind === "run_audio_tool" && Buffer.byteLength(JSON.stringify(input.arguments), "utf8") > MAX_AUDIO_PARAMETER_BYTES) {
      throw new ChatBridgeRequestValidationError(kind === "run_audio_tool"
        ? "Choose a loaded audio tool and valid parameters." : "Choose a loaded Plugin tool and valid parameters.");
    }
    return { kind, sessionId: input.sessionId, toolName: input.toolName, signature: input.signature,
      arguments: input.arguments as Record<string, unknown> };
  }
  if (kind === "new_session") {
    assertOnlyInputKeys(input, ["kind"], `${kind} command`);
    return { kind };
  }
  if (kind === "compact_session") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "instructions"],
      `${kind} command`,
    );
    const sessionId = inputString(input, "sessionId");
    if (input.instructions === undefined) return { kind, sessionId };
    if (typeof input.instructions !== "string") {
      throw new ChatBridgeRequestValidationError(
        "instructions must be a string when provided.",
      );
    }
    const instructions = input.instructions.trim();
    if (Buffer.byteLength(instructions, "utf8") > maxCompactionInstructionsUtf8Bytes) {
      throw new ChatBridgeRequestValidationError(
        `instructions may not exceed ${maxCompactionInstructionsUtf8Bytes} UTF-8 bytes.`,
      );
    }
    return {
      kind,
      sessionId,
      ...(instructions ? { instructions } : {}),
    };
  }
  if (
    kind === "start_oauth_login" ||
    kind === "refresh_oauth_account" ||
    kind === "open_oauth_authorization" ||
    kind === "logout_oauth"
  ) {
    assertOnlyInputKeys(
      input,
      ["kind", "profileId", "provider"],
      `${kind} command`,
    );
    const profileId = input.profileId;
    if (!isProfileId(profileId)) {
      throw new ChatBridgeRequestValidationError(
        "profileId must be a valid Profile ID.",
      );
    }
    const provider = input.provider;
    if (provider !== "openai" && provider !== "anthropic" && provider !== "google") {
      throw new ChatBridgeRequestValidationError(
        "provider must be openai, anthropic, or google.",
      );
    }
    return { kind, profileId, provider };
  }
  if (kind === "submit_oauth_authorization_code") {
    assertOnlyInputKeys(
      input,
      ["kind", "profileId", "provider", "authorizationCode"],
      `${kind} command`,
    );
    const profileId = input.profileId;
    if (!isProfileId(profileId)) {
      throw new ChatBridgeRequestValidationError(
        "profileId must be a valid Profile ID.",
      );
    }
    if (input.provider !== "google") {
      throw new ChatBridgeRequestValidationError(
        "submit_oauth_authorization_code provider must be google.",
      );
    }
    return {
      kind,
      profileId,
      provider: "google",
      authorizationCode: inputAuthorizationCode(input),
    };
  }
  if (
    kind === "select_session" ||
    kind === "restore_session" ||
    kind === "delete_session" ||
    kind === "archive_session" ||
    kind === "unarchive_session"
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
    const title = inputString(input, "title");
    if (!isSessionTitle(title)) {
      throw new ChatBridgeRequestValidationError(
        `title may not exceed ${MAX_SESSION_TITLE_CODE_POINTS} characters.`,
      );
    }
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      title,
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
      !skillIds.every(isSafeSkillReferenceId) ||
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
  if (kind === "set_plugin_user_config") {
    assertOnlyInputKeys(input, ["kind", "pluginId", "sha256", "revision", "values", "secretUpdates"], `${kind} command`);
    if (!isSafePluginId(input.pluginId) || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256) ||
        typeof input.revision !== "string" || !/^(?:0|[1-9]\d{0,30})$/u.test(input.revision) ||
        !configRecord(input.values) || !configRecord(input.secretUpdates) ||
        Buffer.byteLength(JSON.stringify([input.values, input.secretUpdates]), "utf8") > MAX_PLUGIN_CONFIG_BYTES) {
      throw new ChatBridgeRequestValidationError("Plugin configuration is invalid.");
    }
    return { kind, pluginId: input.pluginId, sha256: input.sha256, revision: input.revision,
      values: input.values, secretUpdates: input.secretUpdates };
  }
  if (kind === "set_plugin_enabled") {
    assertOnlyInputKeys(input, ["kind", "pluginId", "enabled"], `${kind} command`);
    if (!isSafePluginId(input.pluginId) || typeof input.enabled !== "boolean") {
      throw new ChatBridgeRequestValidationError("Plugin enabled state is invalid.");
    }
    return { kind, pluginId: input.pluginId, enabled: input.enabled };
  }
  if (kind === "set_plugin_mcp_server_approved") {
    assertOnlyInputKeys(input, ["kind", "pluginId", "serverId", "approved"], `${kind} command`);
    if (!isSafePluginId(input.pluginId) || typeof input.serverId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(input.serverId) || typeof input.approved !== "boolean") {
      throw new ChatBridgeRequestValidationError("Plugin MCP server approval is invalid.");
    }
    return { kind, pluginId: input.pluginId, serverId: input.serverId, approved: input.approved };
  }
  if (kind === "set_plugin_artifact_permission") {
    assertOnlyInputKeys(input, ["kind", "pluginId", "serverId", "permission", "approved"], `${kind} command`);
    if (!isSafePluginId(input.pluginId) || typeof input.serverId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(input.serverId) ||
        (input.permission !== "input" && input.permission !== "output") || typeof input.approved !== "boolean") {
      throw new ChatBridgeRequestValidationError("Plugin artifact permission is invalid.");
    }
    return { kind, pluginId: input.pluginId, serverId: input.serverId,
      permission: input.permission, approved: input.approved };
  }
  if (kind === "delete_plugin") {
    assertOnlyInputKeys(input, ["kind", "pluginId"], `${kind} command`);
    if (!isSafePluginId(input.pluginId)) throw new ChatBridgeRequestValidationError("Plugin ID is invalid.");
    return { kind, pluginId: input.pluginId };
  }
  throw new ChatBridgeRequestValidationError(`Unsupported command ${kind}.`);
}

export function parseConfirmationInput(
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

export function assertEmptyInput(value: unknown, label: string): void {
  assertOnlyInputKeys(inputRecord(value), [], label);
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

function inputAuthorizationCode(record: Record<string, unknown>): string {
  const code = inputString(record, "authorizationCode").trim();
  if (!code || code.length > 4_096 || /[\s\u0000-\u001F\u007F]/u.test(code)) {
    throw new ChatBridgeRequestValidationError(
      "code must be a non-empty authorization code without whitespace.",
    );
  }
  return code;
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
