import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  attachmentQuotaIsWithinLimits,
  isSafeAttachmentFileName,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import { isAudioAttachmentInspection } from "../attachments/audio.js";
import type {
  AttachmentMediaType,
  PersistedSessionAttachmentRef,
  SessionAttachmentRef,
} from "./attachments.js";

export const MAX_USER_EVENT_ATTACHMENT_COUNT =
  MAX_PENDING_ATTACHMENT_COUNT;
export const MAX_USER_EVENT_ATTACHMENT_BYTES =
  MAX_PENDING_ATTACHMENT_BYTES;

import {
  createStorageId,
  hasUniqueStorageIds,
  isSafeStorageId,
  requireSafeStorageId,
} from "./id.js";
import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  removeFileDurably,
  withStorageTransaction,
  writeJsonAtomically,
} from "./persistence.js";

export type SessionEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "apply_requested"
  | "apply_auto_approved"
  | "apply_result"
  | "error";

export interface SessionRecoveryLedger {
  active: boolean;
  completedActionDigests: string[];
}

export interface SessionEventInput {
  kind: SessionEventKind;
  content: string;
  name?: string;
  recovery?: SessionRecoveryLedger;
  attachments?: SessionAttachmentRef[];
}

export interface SessionEvent extends Omit<SessionEventInput, "attachments"> {
  id: string;
  createdAt: string;
  attachments?: PersistedSessionAttachmentRef[];
}

const eventsDirectoryName = "live-smith-events";
const memoryEvents = new Map<string, SessionEvent[]>();

export class SessionEventsCorruptionError extends Error {
  constructor(cause?: unknown) {
    super(
      "Saved Live Smith session events are invalid. No event changes were written; repair or remove the affected event log and try again.",
      { cause },
    );
    this.name = "SessionEventsCorruptionError";
  }
}

export async function appendSessionEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  input: SessionEventInput,
): Promise<SessionEvent> {
  if (input.attachments !== undefined && input.kind !== "user") {
    throw new TypeError("Only user events may contain Session attachments.");
  }
  const event: SessionEvent = cloneSessionEvent({
    id: createStorageId("event"),
    createdAt: new Date().toISOString(),
    ...input,
  });
  if (!isSessionEvent(event, "current")) {
    throw new TypeError("Session event input is invalid.");
  }

  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      const events = memoryEvents.get(sessionId) ?? [];
      assertAttachmentIdsUnconsumed(events, event);
      memoryEvents.set(sessionId, [...events, cloneSessionEvent(event)]);
      return cloneSessionEvent(event);
    }

    const events = await loadSessionEventsUnlocked(storageDirectory, sessionId);
    assertAttachmentIdsUnconsumed(events, event);
    await ensurePrivateDirectory(storageDirectory);
    await writeJsonAtomically(
      eventsPath(storageDirectory, sessionId),
      [...events, event],
    );
    return event;
  });
}

export async function loadSessionEvents(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<SessionEvent[]> {
  if (!storageDirectory) {
    return (memoryEvents.get(sessionId) ?? []).map(cloneSessionEvent);
  }

  return loadSessionEventsUnlocked(storageDirectory, sessionId);
}

async function loadSessionEventsUnlocked(
  storageDirectory: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const target = eventsPath(storageDirectory, sessionId);
  try {
    await ensurePrivateFile(target);
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((event) => isSessionEvent(event, "persisted")) ||
      !hasUniqueStorageIds(parsed) ||
      !hasUniqueConsumedAttachmentIds(parsed)
    ) {
      throw new SessionEventsCorruptionError();
    }
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) return [];
    if (error instanceof SyntaxError) {
      throw new SessionEventsCorruptionError(error);
    }
    throw error;
  }
}

export async function deleteSessionEvents(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  await withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memoryEvents.delete(sessionId);
      return;
    }

    await removeFileDurably(eventsPath(storageDirectory, sessionId));
  });
}

export async function listSessionEventLogIds(
  storageDirectory: string | undefined,
): Promise<string[]> {
  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      const ids = [...memoryEvents.keys()];
      if (!ids.every(isSafeStorageId)) throw new SessionEventsCorruptionError();
      return ids.sort();
    }

    const directory = path.join(storageDirectory, eventsDirectoryName);
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      before = await fs.lstat(directory);
    } catch (cause) {
      if (isMissingFileError(cause)) return [];
      throw cause;
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new SessionEventsCorruptionError();
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) {
        throw new SessionEventsCorruptionError();
      }
      const encodedId = entry.name.slice(0, -".json".length);
      let id: string;
      try {
        id = decodeURIComponent(encodedId);
      } catch (cause) {
        throw new SessionEventsCorruptionError(cause);
      }
      if (!isSafeStorageId(id) || encodeURIComponent(id) !== encodedId) {
        throw new SessionEventsCorruptionError();
      }
      ids.push(id);
    }

    const after = await fs.lstat(directory);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new SessionEventsCorruptionError();
    }
    return ids.sort();
  });
}

function eventsPath(storageDirectory: string, sessionId: string): string {
  const safeSessionId = requireSafeStorageId(sessionId, "Session ID");
  return path.join(
    storageDirectory,
    eventsDirectoryName,
    `${encodeURIComponent(safeSessionId)}.json`,
  );
}

function isSessionEvent(
  value: unknown,
  attachmentPolicy: "current" | "persisted",
): value is SessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, [
      "id",
      "createdAt",
      "kind",
      "content",
      "name",
      "recovery",
      "attachments",
    ]) &&
    isSafeStorageId(record.id) &&
    typeof record.createdAt === "string" &&
    isSessionEventKind(record.kind) &&
    typeof record.content === "string" &&
    (record.name === undefined || typeof record.name === "string") &&
    (record.recovery === undefined || (
      record.kind === "apply_result" && isSessionRecoveryLedger(record.recovery)
    )) &&
    (record.attachments === undefined || (
      record.kind === "user" &&
      isSessionAttachmentRefs(record.attachments, attachmentPolicy)
    ))
  );
}

function isSessionAttachmentRefs(
  value: unknown,
  attachmentPolicy: "current" | "persisted",
): value is PersistedSessionAttachmentRef[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_USER_EVENT_ATTACHMENT_COUNT ||
    !value.every(isCurrentSessionAttachmentRef)
  ) {
    return attachmentPolicy === "persisted" &&
      isLegacySessionAttachmentRefs(value);
  }
  const ids = new Set(value.map((attachment) => attachment.id));
  return ids.size === value.length && attachmentQuotaIsWithinLimits(value);
}

function isCurrentSessionAttachmentRef(
  value: unknown,
): value is SessionAttachmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const commonKeys = [
    "id",
    "kind",
    "fileName",
    "mediaType",
    "byteLength",
    "sha256",
  ];
  const allowedKeys = record.kind === "audio"
    ? [...commonKeys, "durationSeconds", "sampleRate", "channels"]
    : commonKeys;
  return hasOnlyKeys(record, allowedKeys) &&
    Object.keys(record).length === allowedKeys.length &&
    isSafeStorageId(record.id) &&
    (record.kind === "image" ||
      record.kind === "document" ||
      record.kind === "audio") &&
    isSafeAttachmentFileName(record.fileName) &&
    isAttachmentMediaType(record.mediaType) &&
    attachmentKindMatchesMediaType(record.kind, record.mediaType) &&
    Number.isInteger(record.byteLength) &&
    (record.byteLength as number) > 0 &&
    (record.byteLength as number) <= (
      record.kind === "image"
        ? MAX_IMAGE_ATTACHMENT_BYTES
        : record.kind === "audio"
          ? MAX_AUDIO_ATTACHMENT_BYTES
          : MAX_DOCUMENT_ATTACHMENT_BYTES
    ) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) && (
      record.kind !== "audio" ||
      isAudioAttachmentInspection({
        mediaType: record.mediaType,
        durationSeconds: record.durationSeconds,
        sampleRate: record.sampleRate,
        channels: record.channels,
      })
    );
}

function isLegacySessionAttachmentRefs(
  value: unknown,
): value is PersistedSessionAttachmentRef[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PENDING_ATTACHMENT_COUNT ||
    !value.every(isLegacySessionAttachmentRef)
  ) return false;
  const ids = new Set(value.map((attachment) => attachment.id));
  return ids.size === value.length &&
    value.reduce((total, attachment) => total + attachment.byteLength, 0) <=
      MAX_PENDING_IMAGE_ATTACHMENT_BYTES;
}

function isLegacySessionAttachmentRef(
  value: unknown,
): value is PersistedSessionAttachmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, [
    "id",
    "kind",
    "fileName",
    "mediaType",
    "byteLength",
    "sha256",
  ]) &&
    Object.keys(record).length === 6 &&
    isSafeStorageId(record.id) &&
    (record.kind === "image" ||
      record.kind === "document" ||
      record.kind === "audio") &&
    typeof record.fileName === "string" &&
    record.fileName.length > 0 &&
    record.fileName.length <= 160 &&
    isAttachmentMediaType(record.mediaType) &&
    attachmentKindMatchesMediaType(record.kind, record.mediaType) &&
    Number.isInteger(record.byteLength) &&
    (record.byteLength as number) > 0 &&
    (record.byteLength as number) <= MAX_IMAGE_ATTACHMENT_BYTES &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256);
}

function assertAttachmentIdsUnconsumed(
  events: readonly SessionEvent[],
  candidate: SessionEvent,
): void {
  if (!candidate.attachments?.length) return;
  const consumedIds = new Set(
    events.flatMap((event) => event.attachments?.map((attachment) => attachment.id) ?? []),
  );
  const duplicate = candidate.attachments.find((attachment) =>
    consumedIds.has(attachment.id)
  );
  if (duplicate) {
    throw new TypeError(
      `Attachment ${duplicate.id} has already been consumed by this Session.`,
    );
  }
}

function hasUniqueConsumedAttachmentIds(events: readonly SessionEvent[]): boolean {
  const ids = events.flatMap(
    (event) => event.attachments?.map((attachment) => attachment.id) ?? [],
  );
  return new Set(ids).size === ids.length;
}

function cloneSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    ...(event.attachments === undefined
      ? {}
      : { attachments: event.attachments.map((attachment) => ({ ...attachment })) }),
    ...(event.recovery === undefined
      ? {}
      : {
          recovery: {
            ...event.recovery,
            completedActionDigests: [...event.recovery.completedActionDigests],
          },
        }),
  };
}

function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "application/pdf" ||
    value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    value === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    value === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    value === "audio/wav" ||
    value === "audio/mpeg";
}

function attachmentKindMatchesMediaType(
  kind: "image" | "document" | "audio",
  mediaType: AttachmentMediaType,
): boolean {
  if (kind === "image") return mediaType.startsWith("image/");
  if (kind === "audio") return mediaType.startsWith("audio/");
  return mediaType === "application/pdf" ||
    mediaType.startsWith("application/vnd.openxmlformats-officedocument.");
}

function isSessionRecoveryLedger(value: unknown): value is SessionRecoveryLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["active", "completedActionDigests"]) ||
    typeof record.active !== "boolean" ||
    !Array.isArray(record.completedActionDigests) ||
    record.completedActionDigests.length > 4096 ||
    !record.completedActionDigests.every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    ) ||
    new Set(record.completedActionDigests).size !==
      record.completedActionDigests.length
  ) {
    return false;
  }
  return record.active || record.completedActionDigests.length === 0;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function isSessionEventKind(value: unknown): value is SessionEventKind {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "apply_requested" ||
    value === "apply_auto_approved" ||
    value === "apply_result" ||
    value === "error"
  );
}
