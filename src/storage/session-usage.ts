import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { mediaDirectory, mediaObjectPath } from "./media-files.js";
import { withStorageTransaction } from "./persistence.js";
import { listSessionsInTransaction } from "./sessions.js";
import { readStoredText, withStorageDatabase } from "./sqlite.js";

export type SessionStorageUsage = { available: false } | {
  available: true;
  sessions: Array<{ id: string; title: string; updatedAt: string; contentBytes: number; mediaBytes: number }>;
  media: Array<{ bytes: number; sessionIds: string[]; retained: boolean }>;
};

const sessionTrees = new Set([
  "live-smith-attachments", "live-smith-audio", "live-smith-audio-artifacts",
  "live-smith-midi", "live-smith-device-parameters",
]);

// These keys follow the associated-data boundary in Session lifecycle deletion.
function entrySessionId(key: string): string | undefined {
  const [root, id] = key.split("/", 2);
  if (root && sessionTrees.has(root)) return id;
  return /^live-smith-events\/([^/]+)\.json$/u.exec(key)?.[1];
}

async function savedMetadataBytes(directory: string): Promise<Map<string, number>> {
  try {
    // listSessionsInTransaction validates this record before the inventory reads it.
    const saved = JSON.parse(await readStoredText(directory, "live-smith-sessions.json")) as Array<{ id: string }>;
    return new Map(saved.map(session => [session.id, Buffer.byteLength(JSON.stringify(session))]));
  } catch (error) {
    if (isMissingFileError(error)) return new Map();
    throw error;
  }
}

export async function readSessionStorageUsage(directory: string | undefined, signal?: AbortSignal): Promise<SessionStorageUsage> {
  throwIfAborted(signal);
  if (!directory) return { available: false };
  return withStorageTransaction(directory, async transaction => {
    throwIfAborted(signal);
    try {
      const sessions = await listSessionsInTransaction(transaction, directory);
      throwIfAborted(signal);
      const metadata = await savedMetadataBytes(directory);
      const rows = new Map(sessions.map(session => [session.id, {
        id: session.id, title: session.title, updatedAt: session.updatedAt,
        contentBytes: metadata.get(session.id) ?? 0, mediaBytes: 0,
      }]));
      const objects = new Map<string, { sessionIds: Set<string>; retained: boolean }>();
      await withStorageDatabase(directory, db => {
        for (const entry of db.prepare("SELECT path, byte_length, media_object, preserved FROM entries").iterate()) {
          throwIfAborted(signal);
          const id = entrySessionId(String(entry.path));
          const owner = entry.preserved === 0 && id ? rows.get(id) : undefined;
          if (entry.media_object === null) {
            if (owner) owner.contentBytes += Number(entry.byte_length);
            continue;
          }
          const key = String(entry.media_object);
          let object = objects.get(key);
          if (!object) { object = { sessionIds: new Set(), retained: false }; objects.set(key, object); }
          if (owner) object.sessionIds.add(owner.id);
          else object.retained = true;
        }

        // Event schemas are created lazily; inventory leaves unopened histories in their stored format.
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_event_records','session_event_logs')")
          .all().map(row => String(row.name)));
        if (tables.has("session_event_records")) {
          for (const event of db.prepare("SELECT session_id, SUM(length(CAST(payload AS BLOB))) AS bytes FROM session_event_records GROUP BY session_id").iterate()) {
            throwIfAborted(signal);
            const owner = rows.get(String(event.session_id));
            if (owner) owner.contentBytes += Number(event.bytes);
          }
        }
        if (tables.has("session_event_logs")) {
          for (const log of db.prepare("SELECT session_id, last_message_at FROM session_event_logs WHERE last_message_at IS NOT NULL").iterate()) {
            throwIfAborted(signal);
            const owner = rows.get(String(log.session_id)), lastMessageAt = String(log.last_message_at);
            if (owner && lastMessageAt > owner.updatedAt) owner.updatedAt = lastMessageAt;
          }
        }
      });

      const media: Extract<SessionStorageUsage, { available: true }>["media"] = [];
      const mediaRoot = await mediaDirectory(directory);
      for (const [key, object] of objects) {
        throwIfAborted(signal);
        if (!object.sessionIds.size) continue;
        let bytes = 0, retained = object.retained;
        try {
          const stat = await fs.lstat(mediaObjectPath(mediaRoot, key));
          if (stat.isFile()) { bytes = stat.size; retained ||= stat.nlink !== 1; }
        } catch (error) { if (!isMissingFileError(error)) throw error; }
        for (const id of object.sessionIds) {
          const owner = rows.get(id)!;
          owner.mediaBytes += bytes; owner.contentBytes += bytes;
        }
        media.push({ bytes, sessionIds: [...object.sessionIds].sort(), retained });
      }
      throwIfAborted(signal);
      return { available: true, sessions: [...rows.values()], media };
    } catch {
      throwIfAborted(signal);
      throw new Error("Session storage usage could not be read. Try again.");
    }
  });
}
