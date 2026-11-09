import { readStoredText, listStoredEntries, withStorageDatabase } from "./sqlite.js";
import { isToolOperationSnapshot, type ToolOperationSnapshot } from "../agent/tool-operation.js";
import { isMcpToolActor, type ToolActor } from "../agent/tool-actor.js";
import { isToolResultOutcome, type ToolResultOutcome } from "../agent/tool-outcome.js";
import { isAgentApplyOperation, type AgentApplyOperation } from "../agent/action-preview.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { isAttachmentProvenance } from "../attachments/provenance.js";
import { throwIfAborted } from "../runtime/host.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as path from "node:path";

import {
  attachmentMediaTypeMatchesKind as attachmentKindMatchesMediaType,
  attachmentQuotaIsWithinLimits,
  isAttachmentMediaType,
  isSafeAttachmentFileName,
  MAX_LOCAL_AUDIO_ATTACHMENT_BYTES,
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import { isAudioAttachmentInspection } from "../attachments/audio.js";
import type {
  PersistedSessionAttachmentRef,
  SessionAttachmentRef,
} from "./attachments.js";
import { isModelCitation, MAX_MODEL_CITATION_COUNT } from "../model/citations.js";
import type { ModelCitation, ModelHostedWebSearch } from "../model/contracts.js";
import { isModelHostedWebSearch } from "../model/web-search.js";
import { MAX_RECOVERY_ACTION_DIGESTS } from "../agent/recovery-contract.js";
import { isArtifactRef, isArtifactRefs, isArtifactSelection, type ArtifactRef, type ArtifactSelection } from "../agent/artifact-contracts.js";

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
import { persistTransientSessionInTransaction } from "./sessions.js";
import {
  withStorageTransaction,
  StorageCommitOutcomeUnknownError,
} from "./persistence.js";

export type SessionEventKind =
  | "operation"
  | "user"
  | "assistant"
  | "reasoning"
  | "web_search"
  | "tool_call"
  | "tool_result"
  | "apply_requested"
  | "apply_auto_approved"
  | "apply_result"
  | "compaction"
  | "candidate"
  | "error";

export interface SessionRecoveryLedger {
  active: boolean;
  completedActionDigests: string[];
}

export interface SessionSteeringReceipt {
  sendId: string;
  id: string;
  sha256: string;
}

export interface SessionEventInput {
  kind: SessionEventKind;
  operation?: ToolOperationSnapshot;
  toolActor?: Extract<ToolActor, { kind: "mcp" }>;
  toolOperationId?: string;
  content: string;
  name?: string;
  outcome?: ToolResultOutcome;
  recovery?: SessionRecoveryLedger;
  attachments?: SessionAttachmentRef[];
  citations?: ModelCitation[];
  webSearch?: ModelHostedWebSearch;
  steeringReceipt?: SessionSteeringReceipt;
  sendReceipt?: { sendId: string };
  candidateSelection?: ArtifactSelection;
  parentCandidate?: ArtifactRef;
  requestEventId?: string;
  applyOperation?: AgentApplyOperation;
  artifacts?: ArtifactRef[];
}

export interface SessionEvent extends Omit<SessionEventInput, "attachments"> {
  id: string;
  createdAt: string;
  attachments?: PersistedSessionAttachmentRef[];
}

const eventsDirectoryName = "live-smith-events";
const memoryEvents = new Map<string, SessionEvent[]>();
const memoryHistoryIds = new Map<string, string>();
function memoryHistoryId(sessionId: string): string {
  let id = memoryHistoryIds.get(sessionId);
  if (!id) { id = createStorageId("history"); memoryHistoryIds.set(sessionId,id); }
  return id;
}

export class SessionEventsCorruptionError extends Error {
  constructor(cause?: unknown) {
    super(
      "Saved Live Smith session events are invalid. No event changes were written; repair or remove the affected event log and try again.",
      { cause },
    );
    this.name = "SessionEventsCorruptionError";
  }
}

export class SessionSteeringReceiptConflictError extends Error {
  constructor(
    readonly sendId: string,
    readonly id: string,
  ) {
    super(
      `Steering receipt ${JSON.stringify(id)} for send ${JSON.stringify(sendId)} conflicts with its persisted user event.`,
    );
    this.name = "SessionSteeringReceiptConflictError";
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
  const candidate: SessionEvent = {
    id: createStorageId("event"),
    createdAt: new Date().toISOString(),
    ...input,
  };
  if (!isSessionEvent(candidate, "current")) {
    throw new TypeError("Session event input is invalid.");
  }
  const event = cloneSessionEvent(candidate);

  return withStorageTransaction(storageDirectory, async (transaction) => {
    if (!storageDirectory) {
      const events = memoryEvents.get(sessionId) ?? [];
      const existing = matchingSendReceiptEvent(events, event) ?? matchingSteeringReceiptEvent(events, event);
      if (existing) return cloneSessionEvent(existing);
      assertAttachmentIdsUnconsumed(events, event);
      await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
      memoryEvents.set(sessionId, [...events, cloneSessionEvent(event)]);
      return cloneSessionEvent(event);
    }
    await ensureEventLog(storageDirectory, sessionId);
    // Persist session metadata before publishing the event, as with the legacy store.
    await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
    return withStorageDatabase(storageDirectory, db => eventTransaction(db, () => {
      if (event.sendReceipt) {
        const row = db.prepare("SELECT r.payload FROM session_event_send_receipts s JOIN session_event_records r ON r.session_id=s.session_id AND r.event_id=s.event_id WHERE s.session_id=? AND s.send_id=?").get(sessionId,event.sendReceipt.sendId);
        if (row) return cloneSessionEvent(matchingSendReceiptEvent([parseEvent(row.payload)], event)!);
      }
      if (event.steeringReceipt) {
        const row = db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND steering_send=? AND steering_id=?")
          .get(sessionId, event.steeringReceipt.sendId, event.steeringReceipt.id);
        if (row) return cloneSessionEvent(matchingSteeringReceiptEvent([parseEvent(row.payload)], event)!);
      }
      for (const attachment of event.attachments ?? []) {
        if (db.prepare("SELECT 1 FROM session_event_attachments WHERE session_id=? AND attachment_id=?").get(sessionId, attachment.id)) {
          throw new TypeError(`Attachment ${attachment.id} has already been consumed by this Session.`);
        }
      }
      insertEvent(db, sessionId, event);
      return cloneSessionEvent(event);
    }));
  });
}

// These tables are a projection of the legacy event log after its one-time import.
function eventSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_event_logs(session_id TEXT PRIMARY KEY, history_id TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, latest_sequence INTEGER NOT NULL DEFAULT 0, last_event_id TEXT, last_message_at TEXT);
    CREATE TABLE IF NOT EXISTS session_event_records(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES session_event_logs(session_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL, kind TEXT NOT NULL, event_name TEXT, created_at TEXT NOT NULL, payload TEXT NOT NULL,
      searchable TEXT, steering_send TEXT, steering_id TEXT,
      UNIQUE(session_id,event_id), UNIQUE(session_id,steering_send,steering_id));
    CREATE INDEX IF NOT EXISTS session_event_order ON session_event_records(session_id,seq);
    CREATE INDEX IF NOT EXISTS session_event_kind_order ON session_event_records(session_id,kind,seq);
    CREATE INDEX IF NOT EXISTS session_event_name_order ON session_event_records(session_id,kind,event_name,seq);
    CREATE INDEX IF NOT EXISTS session_event_operation_order ON session_event_records(session_id,json_extract(payload,'$.operation.id'),seq) WHERE kind='operation';
    CREATE TABLE IF NOT EXISTS session_event_attachments(session_id TEXT NOT NULL REFERENCES session_event_logs(session_id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL, PRIMARY KEY(session_id,attachment_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS session_event_send_receipts(session_id TEXT NOT NULL REFERENCES session_event_logs(session_id) ON DELETE CASCADE,
      send_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(session_id,send_id)) WITHOUT ROWID;`);
  if (!db.prepare("PRAGMA table_info(session_event_attachments)").all().some(row => row.name === "ref_json")) {
    eventTransaction(db, () => {
      db.exec("ALTER TABLE session_event_attachments ADD COLUMN ref_json TEXT");
      db.exec(`UPDATE session_event_attachments SET ref_json=(SELECT a.value FROM session_event_records r,json_each(r.payload,'$.attachments') a
        WHERE r.session_id=session_event_attachments.session_id AND json_extract(a.value,'$.id')=session_event_attachments.attachment_id LIMIT 1)`);
    });
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_event_consumed_attachments'").get()) {
    eventTransaction(db, () => {
      db.exec(`CREATE TABLE session_event_consumed_attachments(session_id TEXT NOT NULL REFERENCES session_event_logs(session_id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL,PRIMARY KEY(session_id,attachment_id)) WITHOUT ROWID`);
      const add = db.prepare("INSERT OR IGNORE INTO session_event_consumed_attachments(session_id,attachment_id) VALUES(?,?)");
      for (const row of db.prepare("SELECT session_id,payload FROM session_event_records").iterate()) {
        for (const id of sessionEventConsumedAttachmentIds(parseEvent(row.payload))) add.run(String(row.session_id),id);
      }
    });
  }
}
function eventTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); try { db.exec("COMMIT"); } catch (error) { throw new StorageCommitOutcomeUnknownError(error); } return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
function insertEvent(db: DatabaseSync, sessionId: string, event: SessionEvent): void {
  db.prepare(`INSERT INTO session_event_records(session_id,event_id,kind,event_name,created_at,payload,searchable,steering_send,steering_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId,event.id,event.kind,event.name ?? null,event.createdAt,JSON.stringify(event),
      event.kind === "user" || event.kind === "assistant" ? event.content.toLowerCase() : null,
      event.steeringReceipt?.sendId ?? null,event.steeringReceipt?.id ?? null);
  const sequence = db.prepare("SELECT last_insert_rowid() AS seq").get()!.seq;
  const add = db.prepare("INSERT INTO session_event_attachments(session_id,attachment_id,ref_json) VALUES(?,?,?)");
  for (const attachment of event.attachments ?? []) add.run(sessionId,attachment.id,JSON.stringify(attachment));
  const consumed = db.prepare("INSERT OR IGNORE INTO session_event_consumed_attachments(session_id,attachment_id) VALUES(?,?)");
  for (const id of sessionEventConsumedAttachmentIds(event)) consumed.run(sessionId,id);
  if (event.sendReceipt) db.prepare("INSERT INTO session_event_send_receipts(session_id,send_id,event_id) VALUES(?,?,?)").run(sessionId,event.sendReceipt.sendId,event.id);
  const message = event.kind === "user" || event.kind === "assistant";
  db.prepare(`UPDATE session_event_logs SET total=total+1, latest_sequence=?, last_event_id=?,
    last_message_at=CASE WHEN ? IS NOT NULL AND (last_message_at IS NULL OR ? > last_message_at) THEN ? ELSE last_message_at END WHERE session_id=?`).run(sequence!,event.id,message ? event.createdAt : null,event.createdAt,event.createdAt,sessionId);
}
function parseEvent(payload: unknown): SessionEvent {
  try {
    const parsed: unknown = JSON.parse(String(payload));
    if (!isSessionEvent(parsed, "persisted")) throw new SessionEventsCorruptionError();
    return parsed;
  } catch (error) { if (error instanceof SessionEventsCorruptionError) throw error; throw new SessionEventsCorruptionError(error); }
}
async function ensureEventLog(root: string, sessionId: string): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  const legacyKey = `${eventsDirectoryName}/${encodeURIComponent(sessionId)}.json`;
  const source = await withStorageDatabase(root, db => {
    eventSchema(db);
    if (db.prepare("SELECT 1 FROM session_event_logs WHERE session_id=?").get(sessionId)) return { exists: true };
    return { exists: false, revision: db.prepare("SELECT revision FROM entries WHERE path=? AND preserved=0").get(legacyKey)?.revision };
  });
  if (source.exists) return;
  let events: SessionEvent[] = [];
  if (source.revision !== undefined) {
    try {
      const raw = await readStoredText(root, eventsPath(root, sessionId));
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(event => isSessionEvent(event, "persisted")) ||
          !hasUniqueStorageIds(parsed) || !hasUniqueConsumedAttachmentIds(parsed) || !hasUniqueSteeringReceiptIds(parsed)) throw new SessionEventsCorruptionError();
      events = parsed;
    } catch (error) {
      if (!isMissingFileError(error)) {
        if (error instanceof SyntaxError) throw new SessionEventsCorruptionError(error);
        throw error;
      }
    }
  }
  await withStorageDatabase(root, db => eventTransaction(db, () => {
    if (db.prepare("SELECT 1 FROM session_event_logs WHERE session_id=?").get(sessionId)) return;
    // Keep the lazy projection bound to its source through the publication transaction.
    if (db.prepare("SELECT revision FROM entries WHERE path=? AND preserved=0").get(legacyKey)?.revision !== source.revision) {
      throw new SessionEventHistoryChangedError();
    }
    db.prepare("INSERT INTO session_event_logs(session_id,history_id) VALUES(?,?)").run(sessionId,createStorageId("history"));
    for (const event of events) insertEvent(db, sessionId, event);
  }));
}
export async function loadSessionEvents(storageDirectory: string | undefined, sessionId: string): Promise<SessionEvent[]> {
  if (!storageDirectory) return (memoryEvents.get(sessionId) ?? []).map(cloneSessionEvent);
  await ensureEventLog(storageDirectory, sessionId);
  return withStorageDatabase(storageDirectory, db => db.prepare("SELECT payload FROM session_event_records WHERE session_id=? ORDER BY seq").all(sessionId).map(row => parseEvent(row.payload)));
}
/** Latest snapshots retain the order in which each operation first appeared. */
export async function loadSessionOperationSnapshots(root: string | undefined, sessionId: string, limit: number, activeIds: readonly string[] = []): Promise<ToolOperationSnapshot[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid operation limit.");
  if (!root) {
    const snapshots = new Map<string, ToolOperationSnapshot>();
    for (const event of memoryEvents.get(sessionId) ?? []) if (event.operation) snapshots.set(event.operation.id, event.operation);
    const recent = new Set([...snapshots.keys()].slice(-limit));
    for (const id of activeIds) recent.add(id);
    return [...snapshots].filter(([id]) => recent.has(id)).map(([, snapshot]) => cloneJsonValue(snapshot));
  }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => {
    const activeFilter = activeIds.length ? ` OR operation_id IN (${activeIds.map(() => "?").join(",")})` : "";
    const rows = db.prepare(`WITH operations AS (
      SELECT json_extract(payload,'$.operation.id') AS operation_id, MIN(seq) AS first_seq, MAX(seq) AS latest_seq
      FROM session_event_records WHERE session_id=? AND kind='operation' GROUP BY operation_id
    ), recent AS (SELECT operation_id FROM operations ORDER BY first_seq DESC LIMIT ?)
    SELECT r.payload FROM operations o JOIN session_event_records r ON r.seq=o.latest_seq
    WHERE o.operation_id IN (SELECT operation_id FROM recent)${activeFilter} ORDER BY o.first_seq`).all(sessionId, limit, ...activeIds);
    return rows.map(row => parseEvent(row.payload).operation!);
  });
}

export async function loadSessionOperationSnapshot(root: string | undefined, sessionId: string, id: string): Promise<ToolOperationSnapshot | undefined> {
  if (!root) {
    const event = (memoryEvents.get(sessionId) ?? []).findLast(item => item.operation?.id === id);
    return event?.operation && cloneJsonValue(event.operation);
  }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => {
    const row = db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND kind='operation' AND json_extract(payload,'$.operation.id')=? ORDER BY seq DESC LIMIT 1").get(sessionId, id);
    return row ? parseEvent(row.payload).operation : undefined;
  });
}

export interface SessionEventSummary {
  hasEvents: boolean; historyId: string; total: number; latestSequence: number;
  lastEventId?: string; lastMessageAt?: string;
}
export async function loadSessionEventSummary(root: string | undefined, sessionId: string): Promise<SessionEventSummary> {
  if (!root) {
    const events = memoryEvents.get(sessionId) ?? [];
    const messages = events.filter(e => e.kind === "user" || e.kind === "assistant");
    const last = events.at(-1);
    const lastMessageAt = messages.reduce<string | undefined>((value,e) => value === undefined || e.createdAt > value ? e.createdAt : value, undefined);
    return {hasEvents: events.length > 0, historyId: memoryHistoryId(sessionId), total: events.length, latestSequence: events.length,
      ...(last ? {lastEventId: last.id} : {}), ...(lastMessageAt === undefined ? {} : {lastMessageAt})};
  }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => summaryFromRow(db.prepare("SELECT * FROM session_event_logs WHERE session_id=?").get(sessionId)!));
}
function summaryFromRow(row: Record<string, unknown>): SessionEventSummary {
  return {hasEvents: Number(row.total)>0, historyId: String(row.history_id), total: Number(row.total), latestSequence: Number(row.latest_sequence),
    ...(typeof row.last_event_id === "string" ? {lastEventId: row.last_event_id} : {}),
    ...(typeof row.last_message_at === "string" ? {lastMessageAt: row.last_message_at} : {})};
}
/** Batch sidebar metadata while isolating corrupt legacy logs per Session. */
export async function loadSessionEventSummaries(root: string | undefined, ids: readonly string[], signal?: AbortSignal): Promise<Map<string, SessionEventSummary | Error>> {
  const result = new Map<string,SessionEventSummary | Error>();
  if (!root) { for (const id of ids) result.set(id,await loadSessionEventSummary(root,id)); return result; }
  const readSummaryRows = async () => withStorageDatabase(root, db => {
    eventSchema(db);
    const rows: Record<string,unknown>[] = [];
    for (let start = 0; start < ids.length; start += 500) {
      throwIfAborted(signal);
      const chunk = ids.slice(start,start+500);
      rows.push(...db.prepare(`SELECT * FROM session_event_logs WHERE session_id IN (${chunk.map(()=>"?").join(",")})`).all(...chunk));
    }
    return rows;
  });
  const addRows = (rows: Record<string,unknown>[]) => {
    for (const row of rows) {
      const id = String(row.session_id);
      try { result.set(id,summaryFromRow(row)); } catch (error) { result.set(id,error instanceof Error ? error : new SessionEventsCorruptionError(error)); }
    }
  };
  try { addRows(await readSummaryRows()); } catch (error) {
    throwIfAborted(signal);
    for (const id of ids) result.set(id,error instanceof Error ? error : new SessionEventsCorruptionError(error));
    return result;
  }
  const missing = ids.filter(id => !result.has(id));
  for (const id of missing) {
    throwIfAborted(signal);
    try { await ensureEventLog(root,id); } catch (error) { throwIfAborted(signal); result.set(id,error instanceof Error ? error : new SessionEventsCorruptionError(error)); }
  }
  if (missing.length) {
    try { addRows(await readSummaryRows()); } catch (error) {
      throwIfAborted(signal);
      for (const id of missing) if (!result.has(id)) result.set(id,error instanceof Error ? error : new SessionEventsCorruptionError(error));
    }
  }
  return result;
}
export class SessionEventHistoryChangedError extends Error {
  constructor() { super("Session event history has changed; reload the first page."); this.name = "SessionEventHistoryChangedError"; }
}
export interface SessionEventPageOptions { before?: number; after?: number; anchorEventId?: string; afterEventId?: string; limit: number; historyId?: string }
export async function loadSessionEventPage(root: string | undefined, sessionId: string, options: SessionEventPageOptions): Promise<{events: SessionEvent[]; nextBefore?: number; nextAfter?: number; historyId: string; total: number; latestSequence: number}> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      [options.before,options.after].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1)) ||
      [options.before,options.after,options.anchorEventId,options.afterEventId].filter(value => value !== undefined).length > 1) throw new TypeError("Invalid event page.");
  if (options.afterEventId !== undefined) requireSafeStorageId(options.afterEventId, "Session event ID");
  if (!root) {
    const all = memoryEvents.get(sessionId) ?? []; const historyId = memoryHistoryId(sessionId);
    if (options.historyId !== undefined && options.historyId !== historyId) throw new SessionEventHistoryChangedError();
    let start: number; let end: number;
    if (options.anchorEventId !== undefined) {
      const index = all.findIndex(event => event.id === options.anchorEventId);
      if (index < 0) throw new SessionEventAnchorNotFoundError();
      start = Math.max(0,index-Math.floor(options.limit/2)); end = Math.min(all.length,start+options.limit);
    } else if (options.afterEventId !== undefined) {
      const index = all.findIndex(event => event.id === options.afterEventId);
      if (index < 0) throw new SessionEventAnchorNotFoundError();
      start = index + 1; end = Math.min(all.length,start+options.limit);
    } else if (options.after !== undefined) { start = Math.min(all.length,options.after); end = Math.min(all.length,start+options.limit); }
    else { end = Math.min(all.length,(options.before ?? all.length+1)-1); start = Math.max(0,end-options.limit); }
    return {events:all.slice(start,end).map(cloneSessionEvent),historyId,total:all.length,latestSequence:all.length,
      ...(start > 0 && start < end ? {nextBefore:start+1} : {}),...(end < all.length && start < end ? {nextAfter:end} : {})};
  }
  await ensureEventLog(root,sessionId);
  return withStorageDatabase(root, db => {
    const log = db.prepare("SELECT history_id,total,latest_sequence FROM session_event_logs WHERE session_id=?").get(sessionId)!;
    const historyId = String(log.history_id);
    if (options.historyId !== undefined && options.historyId !== historyId) throw new SessionEventHistoryChangedError();
    let rows: Record<string,unknown>[];
    if (options.anchorEventId !== undefined) {
      const anchor = db.prepare("SELECT seq FROM session_event_records WHERE session_id=? AND event_id=?").get(sessionId,options.anchorEventId);
      if (!anchor) throw new SessionEventAnchorNotFoundError();
      const older = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(sessionId,Number(anchor.seq),Math.floor(options.limit/2)).reverse();
      const newer = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND seq>=? ORDER BY seq LIMIT ?").all(sessionId,Number(anchor.seq),options.limit-older.length);
      rows = [...older,...newer];
    } else if (options.afterEventId !== undefined) {
      const after = db.prepare("SELECT seq FROM session_event_records WHERE session_id=? AND event_id=?").get(sessionId,options.afterEventId);
      if (!after) throw new SessionEventAnchorNotFoundError();
      rows = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").all(sessionId,Number(after.seq),options.limit);
    } else if (options.after !== undefined) {
      rows = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").all(sessionId,options.after,options.limit);
    } else rows = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(sessionId,options.before ?? Number.MAX_SAFE_INTEGER,options.limit).reverse();
    const first = rows[0]; const last = rows.at(-1);
    return {events:rows.map(row => parseEvent(row.payload)),historyId,total:Number(log.total),latestSequence:Number(log.latest_sequence),
      ...(first && db.prepare("SELECT 1 FROM session_event_records WHERE session_id=? AND seq<? LIMIT 1").get(sessionId,Number(first.seq)) ? {nextBefore:Number(first.seq)} : {}),
      ...(last && db.prepare("SELECT 1 FROM session_event_records WHERE session_id=? AND seq>? LIMIT 1").get(sessionId,Number(last.seq)) ? {nextAfter:Number(last.seq)} : {})};
  });
}
export class SessionEventAnchorNotFoundError extends Error {
  constructor() { super("The requested Session event is unavailable."); this.name = "SessionEventAnchorNotFoundError"; }
}
export function sessionEventConsumedAttachmentIds(event: SessionEvent): string[] {
  return [...(event.attachments?.flatMap(ref => [ref.id,...(ref.provenance?.replacedIds ?? [])]) ?? []),
    ...(event.operation?.result?.audioAttachmentId ? [event.operation.result.audioAttachmentId] : []),
    ...(event.operation?.result?.inputAttachmentIds ?? [])];
}
export async function loadSessionAttachmentRefs(root: string | undefined, sessionId: string): Promise<PersistedSessionAttachmentRef[]> {
  if (!root) return (memoryEvents.get(sessionId) ?? []).flatMap(event => cloneSessionEvent(event).attachments ?? []);
  await ensureEventLog(root,sessionId);
  return withStorageDatabase(root, db => db.prepare("SELECT ref_json FROM session_event_attachments WHERE session_id=? ORDER BY attachment_id").all(sessionId).map(row => JSON.parse(String(row.ref_json)) as PersistedSessionAttachmentRef));
}
export async function loadSessionSendReceiptEvent(root: string | undefined, sessionId: string, sendId: string, steerId?: string): Promise<SessionEvent | undefined> {
  if (!root) {
    const event = (memoryEvents.get(sessionId) ?? []).find(event => steerId === undefined ? event.sendReceipt?.sendId === sendId : event.steeringReceipt?.sendId === sendId && event.steeringReceipt.id === steerId);
    return event && cloneSessionEvent(event);
  }
  await ensureEventLog(root,sessionId);
  return withStorageDatabase(root, db => {
    const row = steerId === undefined
      ? db.prepare("SELECT r.payload FROM session_event_send_receipts s JOIN session_event_records r ON r.session_id=s.session_id AND r.event_id=s.event_id WHERE s.session_id=? AND s.send_id=?").get(sessionId,sendId)
      : db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND steering_send=? AND steering_id=?").get(sessionId,sendId,steerId);
    return row ? parseEvent(row.payload) : undefined;
  });
}
function matchingSendReceiptEvent(events: readonly SessionEvent[], candidate: SessionEvent): SessionEvent | undefined {
  if (!candidate.sendReceipt) return undefined;
  const event = events.find(event => event.sendReceipt?.sendId === candidate.sendReceipt!.sendId);
  if (event && (event.content !== candidate.content || JSON.stringify(event.attachments?.map(ref => ref.id) ?? []) !== JSON.stringify(candidate.attachments?.map(ref => ref.id) ?? []))) {
    throw new Error("The send receipt conflicts with its persisted user event.");
  }
  return event;
}
export async function loadSessionCandidateContextEvents(root: string | undefined, sessionId: string): Promise<SessionEvent[]> {
  if (!root) return (memoryEvents.get(sessionId) ?? []).filter(event => event.kind === "candidate" || event.kind === "user").map(cloneSessionEvent);
  await ensureEventLog(root,sessionId);
  return withStorageDatabase(root,db => {
    const boundary = db.prepare("SELECT seq,payload FROM session_event_records WHERE session_id=? AND kind='user' AND steering_send IS NULL ORDER BY seq DESC LIMIT 1").get(sessionId);
    const candidates = db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND kind='candidate' AND seq>? ORDER BY seq").all(sessionId,boundary ? Number(boundary.seq) : 0).map(row => parseEvent(row.payload));
    return boundary ? [parseEvent(boundary.payload),...candidates] : candidates;
  });
}
export async function loadSessionContextEvents(root: string | undefined, sessionId: string): Promise<SessionEvent[]> {
  if (!root) { const events = memoryEvents.get(sessionId) ?? []; const index = events.findLastIndex(e => e.kind === "compaction"); return events.slice(Math.max(index,0)).map(cloneSessionEvent); }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => db.prepare(`SELECT payload FROM session_event_records WHERE session_id=? AND seq>=COALESCE(
    (SELECT MAX(seq) FROM session_event_records WHERE session_id=? AND kind='compaction'),0) ORDER BY seq`).all(sessionId,sessionId).map(row => parseEvent(row.payload)));
}
export async function searchSessionEvents(root: string | undefined, sessionId: string, query: string): Promise<SessionEvent | undefined> {
  const needle = query.toLowerCase();
  if (!root) { const found = (memoryEvents.get(sessionId) ?? []).findLast(e => (e.kind === "user" || e.kind === "assistant") && e.content.toLowerCase().includes(needle)); return found && cloneSessionEvent(found); }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => { const row = db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND searchable IS NOT NULL AND instr(searchable,?)>0 ORDER BY seq DESC LIMIT 1").get(sessionId,needle); return row ? parseEvent(row.payload) : undefined; });
}
export async function loadConsumedAttachmentIds(root: string | undefined, sessionId: string): Promise<string[]> {
  if (!root) return [...new Set((memoryEvents.get(sessionId) ?? []).flatMap(sessionEventConsumedAttachmentIds))];
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => db.prepare("SELECT attachment_id FROM session_event_consumed_attachments WHERE session_id=? ORDER BY attachment_id").all(sessionId).map(row => String(row.attachment_id)));
}
export async function loadLatestSessionEvent(root: string | undefined, sessionId: string, options: {kind: SessionEventKind; name?: string}): Promise<SessionEvent | undefined> {
  if (!root) { const event = (memoryEvents.get(sessionId) ?? []).findLast(e => e.kind === options.kind && (options.name === undefined || e.name === options.name)); return event && cloneSessionEvent(event); }
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => {
    const row = options.name === undefined
      ? db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND kind=? ORDER BY seq DESC LIMIT 1").get(sessionId,options.kind)
      : db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND kind=? AND event_name=? ORDER BY seq DESC LIMIT 1").get(sessionId,options.kind,options.name);
    return row ? parseEvent(row.payload) : undefined;
  });
}
export async function loadSessionRecoveryEvents(root: string | undefined, sessionId: string): Promise<SessionEvent[]> {
  const recoveryKind = (event: SessionEvent) => event.kind === "apply_requested" || event.kind === "apply_result" || event.kind === "error" || event.kind === "tool_result" && /^Tool call .* has invalid arguments:/i.test(event.content);
  if (!root) return (memoryEvents.get(sessionId) ?? []).filter(recoveryKind).map(cloneSessionEvent);
  await ensureEventLog(root, sessionId);
  return withStorageDatabase(root, db => db.prepare("SELECT payload FROM session_event_records WHERE session_id=? AND (kind IN ('apply_requested','apply_result','error') OR kind='tool_result' AND json_extract(payload,'$.content') LIKE 'Tool call % has invalid arguments:%') ORDER BY seq").all(sessionId).map(row => parseEvent(row.payload)).filter(recoveryKind));
}
export async function deleteSessionEvents(root: string | undefined, sessionId: string): Promise<void> {
  await withStorageTransaction(root, async () => {
    if (!root) { memoryEvents.delete(sessionId); memoryHistoryIds.delete(sessionId); return; }
    requireSafeStorageId(sessionId, "Session ID");
    await withStorageDatabase(root, db => { eventSchema(db); eventTransaction(db, () => {
      db.prepare("DELETE FROM entries WHERE path=? AND preserved=0").run(`${eventsDirectoryName}/${encodeURIComponent(sessionId)}.json`);
      db.prepare("DELETE FROM session_event_logs WHERE session_id=?").run(sessionId);
    }); });
  });
}
export async function listSessionEventLogIds(root: string | undefined): Promise<string[]> {
  return withStorageTransaction(root, async () => {
    if (!root) { const ids = [...memoryEvents.keys()]; if (!ids.every(isSafeStorageId)) throw new SessionEventsCorruptionError(); return ids.sort(); }
    const entries = await listStoredEntries(root, eventsDirectoryName);
    const ids = new Set<string>();
    for (const entry of entries) {
      const name = entry.key.slice(eventsDirectoryName.length + 1);
      if (!name.endsWith(".json") || name.includes("/")) throw new SessionEventsCorruptionError();
      const encoded = name.slice(0,-5); let id: string;
      try { id = decodeURIComponent(encoded); } catch (error) { throw new SessionEventsCorruptionError(error); }
      if (!isSafeStorageId(id) || encodeURIComponent(id) !== encoded) throw new SessionEventsCorruptionError();
      ids.add(id);
    }
    const rows = await withStorageDatabase(root, db => { eventSchema(db); return db.prepare("SELECT DISTINCT session_id FROM session_event_records").all(); });
    for (const row of rows) { if (!isSafeStorageId(row.session_id)) throw new SessionEventsCorruptionError(); ids.add(row.session_id); }
    return [...ids].sort();
  });
}

function eventsPath(storageDirectory: string, sessionId: string): string {
  const safeSessionId = requireSafeStorageId(sessionId, "Session ID");
  return path.resolve(
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
      "operation", "toolActor", "toolOperationId",
      "id",
      "createdAt",
      "kind",
      "content",
      "name",
      "recovery",
      "attachments",
      "citations",
      "webSearch",
      "steeringReceipt", "sendReceipt",
      "candidateSelection",
      "parentCandidate",
      "requestEventId",
      "applyOperation",
      "artifacts",
      "outcome",
    ]) &&
    (record.kind === "operation" ? isToolOperationSnapshot(record.operation) : record.operation === undefined) &&
    (record.toolActor === undefined ? record.toolOperationId === undefined : isMcpToolActor(record.toolActor) && isSafeStorageId(record.toolOperationId)) &&
    isSafeStorageId(record.id) &&
    typeof record.createdAt === "string" &&
    isSessionEventKind(record.kind) &&
    typeof record.content === "string" &&
    (record.kind === "candidate" ? isArtifactSelection(record.candidateSelection) : record.candidateSelection === undefined) &&
    (record.parentCandidate === undefined || (record.kind === "user" || record.kind === "tool_call") && isArtifactRef(record.parentCandidate)) &&
    (record.requestEventId === undefined || record.kind === "tool_call" && isSafeStorageId(record.requestEventId)) &&
    (record.applyOperation === undefined || isAgentApplyOperation(record.applyOperation, record.kind)) &&
    (record.artifacts === undefined || record.kind === "tool_result" && isArtifactRefs(record.artifacts)) &&
    (record.outcome === undefined || record.kind === "tool_result" && isToolResultOutcome(record.outcome)) &&
    (record.name === undefined || typeof record.name === "string") &&
    (record.recovery === undefined || (
      record.kind === "apply_result" && isSessionRecoveryLedger(record.recovery)
    )) &&
    (record.attachments === undefined || (
      record.kind === "user" &&
      isSessionAttachmentRefs(record.attachments, attachmentPolicy)
    )) &&
    (record.citations === undefined || (
      record.kind === "assistant" &&
      isSessionEventCitations(record.citations)
    )) &&
    (record.sendReceipt === undefined || (record.kind === "user" && record.steeringReceipt === undefined &&
      typeof record.sendReceipt === "object" && record.sendReceipt !== null && !Array.isArray(record.sendReceipt) &&
      Object.keys(record.sendReceipt).length === 1 && isSteeringCorrelationId((record.sendReceipt as {sendId?: unknown}).sendId))) &&
    (record.steeringReceipt === undefined || (
      record.kind === "user" &&
      record.name === undefined &&
      isSessionSteeringReceipt(record.steeringReceipt) &&
      record.steeringReceipt.sha256 === sessionSteeringContentSha256(
        record.content,
        (record.attachments as PersistedSessionAttachmentRef[] | undefined)?.map((attachment) => attachment.id),
      )
    )) &&
    (record.kind === "web_search"
      ? isModelHostedWebSearch(record.webSearch) &&
        (record.webSearch.status === "completed" ||
          record.webSearch.status === "failed")
      : record.webSearch === undefined)
  );
}

function isSessionEventCitations(value: unknown): value is ModelCitation[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MODEL_CITATION_COUNT &&
    value.every(isModelCitation) &&
    new Set(value.map((citation) => citation.url)).size === value.length;
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
  if (record.provenance !== undefined) commonKeys.push("provenance");
  const allowedKeys = record.kind === "audio"
    ? [...commonKeys, "durationSeconds", "sampleRate", "channels"]
    : commonKeys;
  return (record.provenance === undefined || isAttachmentProvenance(record.provenance, record.id)) &&
    hasOnlyKeys(record, allowedKeys) &&
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
          ? MAX_LOCAL_AUDIO_ATTACHMENT_BYTES
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
      }, {maxBytes: MAX_LOCAL_AUDIO_ATTACHMENT_BYTES, maxDurationSeconds: MAX_LOCAL_AUDIO_DURATION_SECONDS})
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

function matchingSteeringReceiptEvent(
  events: readonly SessionEvent[],
  candidate: SessionEvent,
): SessionEvent | undefined {
  const receipt = candidate.steeringReceipt;
  if (receipt === undefined) return undefined;
  const existing = events.find((event) =>
    event.steeringReceipt?.sendId === receipt.sendId &&
    event.steeringReceipt.id === receipt.id
  );
  if (existing === undefined) return undefined;
  if (
    existing.content !== candidate.content ||
    existing.steeringReceipt?.sha256 !== receipt.sha256
  ) {
    throw new SessionSteeringReceiptConflictError(receipt.sendId, receipt.id);
  }
  return existing;
}

function hasUniqueSteeringReceiptIds(
  events: readonly SessionEvent[],
): boolean {
  const idsBySend = new Map<string, Set<string>>();
  for (const event of events) {
    const receipt = event.steeringReceipt;
    if (receipt === undefined) continue;
    const ids = idsBySend.get(receipt.sendId) ?? new Set<string>();
    if (ids.has(receipt.id)) return false;
    ids.add(receipt.id);
    idsBySend.set(receipt.sendId, ids);
  }
  return true;
}

function isSessionSteeringReceipt(
  value: unknown,
): value is SessionSteeringReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, ["sendId", "id", "sha256"]) &&
    Object.keys(record).length === 3 &&
    isSteeringCorrelationId(record.sendId) &&
    isSteeringCorrelationId(record.id) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256);
}

function isSteeringCorrelationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function sessionSteeringContentSha256(
  content: string,
  attachmentIds?: readonly string[],
): string {
  return createHash("sha256")
    .update(attachmentIds?.length ? JSON.stringify({ content, attachmentIds }) : content, "utf8")
    .digest("hex");
}

function cloneSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    ...(event.operation ? { operation: cloneJsonValue(event.operation) } : {}),
    ...(event.toolActor ? { toolActor: { ...event.toolActor } } : {}),
    ...(event.applyOperation ? { applyOperation: cloneJsonValue(event.applyOperation) } : {}),
    ...(event.artifacts ? { artifacts: event.artifacts.map((ref) => ({ ...ref })) } : {}),
    ...(event.parentCandidate ? { parentCandidate: { ...event.parentCandidate } } : {}),
    ...(event.candidateSelection ? { candidateSelection: { ...event.candidateSelection,
      ...(event.candidateSelection.action === "primary" ? { group: { ...event.candidateSelection.group } } : {}),
      candidate: event.candidateSelection.candidate ? { ...event.candidateSelection.candidate } : null } } : {}),
    ...(event.attachments === undefined
      ? {}
      : { attachments: event.attachments.map((attachment) => ({
          ...attachment,
          ...(attachment.provenance ? { provenance: { ...attachment.provenance, replacedIds: [...attachment.provenance.replacedIds] } } : {}),
        })) }),
    ...(event.citations === undefined
      ? {}
      : { citations: event.citations.map((citation) => ({ ...citation })) }),
    ...(event.webSearch === undefined
      ? {}
      : {
          webSearch: {
            ...event.webSearch,
            queries: [...event.webSearch.queries],
            sources: event.webSearch.sources.map((source) => ({ ...source })),
          },
        }),
    ...(event.sendReceipt ? { sendReceipt: { ...event.sendReceipt } } : {}),
    ...(event.steeringReceipt === undefined
      ? {}
      : { steeringReceipt: { ...event.steeringReceipt } }),
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

function isSessionRecoveryLedger(value: unknown): value is SessionRecoveryLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["active", "completedActionDigests"]) ||
    typeof record.active !== "boolean" ||
    !Array.isArray(record.completedActionDigests) ||
    record.completedActionDigests.length > MAX_RECOVERY_ACTION_DIGESTS ||
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
    value === "operation" ||
    value === "user" ||
    value === "assistant" ||
    value === "reasoning" ||
    value === "web_search" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "apply_requested" ||
    value === "apply_auto_approved" ||
    value === "apply_result" ||
    value === "compaction" ||
    value === "candidate" ||
    value === "error"
  );
}
