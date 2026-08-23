import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import type { URL } from "node:url";

import { MAX_DOCUMENT_ATTACHMENT_BYTES } from "../attachments/contracts.js";
import {
  isSafeSkillId,
  MAX_SKILL_FILE_BYTES,
} from "../skills/format.js";
import { requireSafeStorageId } from "../storage/id.js";
import {
  isApprovalMode,
  isDefaultFollowUpBehavior,
  isReasoningEffort,
  type ApprovalMode,
  type DefaultFollowUpBehavior,
  type DraftProfile,
  type ReasoningEffort,
} from "../model/profile.js";

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

export interface ChatBridgeSkillDeleteInput {
  skillId: string;
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
  | {
      kind: "save_profile";
      profile: DraftProfile;
      expectedProfileRevision: string | null;
    }
  | { kind: "delete_profile"; profileId: string }
  | { kind: "activate_profile"; profileId: string }
  | { kind: "start_codex_login" }
  | { kind: "refresh_codex_account" }
  | { kind: "logout_codex" }
  | {
      kind: "save_global_settings";
      defaultFollowUpBehavior: DefaultFollowUpBehavior;
    }
  | {
      kind: "set_session_approval_mode";
      sessionId: string;
      approvalMode: ApprovalMode;
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgeRequestValidationError";
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

export function stopSendIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-send-id",
    "X-Live-Smith-Send-Id must identify the send to stop.",
  );
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
  if (
    raw === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(errorMessage);
  }
  return raw;
}

export function commandIdForRequest(request: IncomingMessage): string {
  return requiredCorrelationId(
    request,
    "x-live-smith-command-id",
    "X-Live-Smith-Command-Id must be a valid correlation ID.",
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

export function parseAttachmentDeleteQuery(
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
  if (kind === "new_session") {
    assertOnlyInputKeys(input, ["kind"], `${kind} command`);
    return { kind };
  }
  if (
    kind === "start_codex_login" ||
    kind === "refresh_codex_account" ||
    kind === "logout_codex"
  ) {
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
