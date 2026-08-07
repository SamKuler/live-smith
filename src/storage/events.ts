import * as fs from "node:fs/promises";
import * as path from "node:path";

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
}

export interface SessionEvent extends SessionEventInput {
  id: string;
  createdAt: string;
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
  const event: SessionEvent = {
    id: createStorageId("event"),
    createdAt: new Date().toISOString(),
    ...input,
  };
  if (!isSessionEvent(event)) {
    throw new TypeError("Session event input is invalid.");
  }

  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memoryEvents.set(sessionId, [...(memoryEvents.get(sessionId) ?? []), event]);
      return event;
    }

    const events = await loadSessionEventsUnlocked(storageDirectory, sessionId);
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
  if (!storageDirectory) return [...(memoryEvents.get(sessionId) ?? [])];

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
      !parsed.every(isSessionEvent) ||
      !hasUniqueStorageIds(parsed)
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

function eventsPath(storageDirectory: string, sessionId: string): string {
  const safeSessionId = requireSafeStorageId(sessionId, "Session ID");
  return path.join(
    storageDirectory,
    eventsDirectoryName,
    `${encodeURIComponent(safeSessionId)}.json`,
  );
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, ["id", "createdAt", "kind", "content", "name", "recovery"]) &&
    isSafeStorageId(record.id) &&
    typeof record.createdAt === "string" &&
    isSessionEventKind(record.kind) &&
    typeof record.content === "string" &&
    (record.name === undefined || typeof record.name === "string") &&
    (record.recovery === undefined || (
      record.kind === "apply_result" && isSessionRecoveryLedger(record.recovery)
    ))
  );
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
