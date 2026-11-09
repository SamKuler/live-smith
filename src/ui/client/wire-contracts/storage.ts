import type { StorageUsage } from "../../../storage/management.js";
import type { SessionStorageUsage } from "../../../storage/session-usage.js";
import { hasOnlyWireKeys, isSafeInteger, isWireRecord, isWireStorageId } from "./primitives.js";

export const storageUsageByteFields = [
  "totalBytes", "databaseBytes", "databaseFreeBytes", "mediaBytes", "backupBytes", "exportBytes", "pluginBytes", "otherBytes",
] as const;

const storageUsageNumericFields = [...storageUsageByteFields, "backupFileCount", "sessionCount"] as const;

export function isWireStorageUsage(value: unknown): value is StorageUsage {
  if (!isWireRecord(value)) return false;
  if (value.available === false) return hasOnlyWireKeys<StorageUsage>(value, ["available"]);
  return value.available === true &&
    hasOnlyWireKeys<StorageUsage>(value, ["available", ...storageUsageNumericFields, "backupRevision"]) &&
    storageUsageNumericFields.every((field) => {
      const count = value[field];
      return isSafeInteger(count) && count >= 0;
    }) &&
    typeof value.backupRevision === "string" && /^[0-9a-f]{64}$/.test(value.backupRevision);
}

export function isWireSessionStorageUsage(value: unknown): value is SessionStorageUsage {
  if (!isWireRecord(value)) return false;
  if (value.available === false) return hasOnlyWireKeys(value, ["available"]);
  const bytes = (value: unknown): value is number => isSafeInteger(value) && value >= 0;
  if (value.available !== true || !hasOnlyWireKeys(value, ["available", "sessions", "media"]) ||
      !Array.isArray(value.sessions) || !Array.isArray(value.media)) return false;
  const ids = new Set<string>();
  for (const session of value.sessions) {
    if (!isWireRecord(session) || !hasOnlyWireKeys(session, ["id", "title", "updatedAt", "contentBytes", "mediaBytes"]) ||
        !isWireStorageId(session.id) || ids.has(session.id) || typeof session.title !== "string" ||
        typeof session.updatedAt !== "string" || !Number.isFinite(Date.parse(session.updatedAt)) ||
        !bytes(session.contentBytes) || !bytes(session.mediaBytes) || session.mediaBytes > session.contentBytes) return false;
    ids.add(session.id);
  }
  return value.media.every(item => isWireRecord(item) && hasOnlyWireKeys(item, ["bytes", "sessionIds", "retained"]) &&
    bytes(item.bytes) && typeof item.retained === "boolean" && Array.isArray(item.sessionIds) && item.sessionIds.length > 0 &&
    item.sessionIds.every(id => typeof id === "string" && ids.has(id)) && new Set(item.sessionIds).size === item.sessionIds.length);
}
