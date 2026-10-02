/** Maximum serialized source metadata carried by one saved/event attachment reference. */
export const MAX_ATTACHMENT_PROVENANCE_BYTES = 16 * 1024;

/** Immutable source and draft replacement references; file bytes stay independently owned. */
export interface AttachmentProvenance {
  sourceId: string;
  replacedIds: string[];
  startSeconds?: number;
  endSeconds?: number;
}

export function isAttachmentProvenance(value: unknown, ownId: unknown): value is AttachmentProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
  const range = record.startSeconds !== undefined || record.endSeconds !== undefined;
  return Object.keys(record).length === (range ? 4 : 2) &&
    Object.keys(record).every((key) => ["sourceId", "replacedIds", "startSeconds", "endSeconds"].includes(key)) &&
    safeId(record.sourceId) && record.sourceId !== ownId &&
    Array.isArray(record.replacedIds) && record.replacedIds.every((id) => safeId(id) && id !== ownId) &&
    new Set(record.replacedIds).size === record.replacedIds.length &&
    JSON.stringify(record).length <= MAX_ATTACHMENT_PROVENANCE_BYTES &&
    (!range || typeof record.startSeconds === "number" && Number.isFinite(record.startSeconds) && record.startSeconds >= 0 &&
      typeof record.endSeconds === "number" && Number.isFinite(record.endSeconds) && record.endSeconds > record.startSeconds && record.endSeconds <= 900);
}
