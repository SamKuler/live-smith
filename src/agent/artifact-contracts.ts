import { MAX_AUDIO_JOB_OUTPUTS } from "../audio-services/contracts.js";
import type { SessionEvent } from "../storage/events.js";

export interface ArtifactRef { kind: "midi" | "audio"; id: string }
export type ArtifactPluginSource =
  | { pluginId: string; connectionId?: never }
  | { connectionId: string; pluginId?: never };

export interface ArtifactVersion {
  groupId: string;
  number: number;
  derivedFromId?: string;
}
export interface ArtifactVersionSummary {
  id: string;
  label: string;
  number: number;
  derivedFromId?: string;
  createdAt: string;
}

/** Serialized with the original Session event field names for saved-history compatibility. */
export type ArtifactSelectionCommand =
  | { action: "continue"; candidate: ArtifactRef | null }
  | { action: "primary"; group: ArtifactRef; candidate: ArtifactRef | null };
export type ArtifactSelection = ArtifactSelectionCommand | { action: "prefer"; candidate: ArtifactRef | null };

export function isArtifactLabel(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

type VersionedArtifact = { id: string; version?: ArtifactVersion };
export function artifactVersion(artifact: VersionedArtifact): ArtifactVersion {
  return artifact.version ? { ...artifact.version } : { groupId: artifact.id, number: 1 };
}

/** Call inside the owning media store transaction, including metadata whose bytes are unavailable. */
export function allocateArtifactVersion(
  id: string,
  records: readonly VersionedArtifact[],
  options: { revisionOf?: string; groupWith?: string } = {},
): ArtifactVersion {
  const existing = records.find((entry) => entry.id === id);
  if (existing) return artifactVersion(existing);
  const related = [options.revisionOf, options.groupWith].filter((ref): ref is string => ref !== undefined)
    .map((ref) => {
      const source = records.find((entry) => entry.id === ref);
      if (!source) throw new Error("The source artifact version is unavailable in this Session.");
      return artifactVersion(source);
    });
  if (!related.length) return { groupId: id, number: 1 };
  const groupId = related[0]!.groupId;
  if (related.some((version) => version.groupId !== groupId)) throw new Error("Choose artifact versions from the same work.");
  const number = Math.max(...records.filter((entry) => artifactVersion(entry).groupId === groupId)
    .map((entry) => artifactVersion(entry).number)) + 1;
  if (!Number.isSafeInteger(number)) throw new Error("The artifact version limit has been reached.");
  return { groupId, number, ...(options.revisionOf ? { derivedFromId: options.revisionOf } : {}) };
}

export function isArtifactVersion(value: unknown, artifactId?: string): value is ArtifactVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = value as Record<string, unknown>;
  return Object.keys(version).every((key) => ["groupId", "number", "derivedFromId"].includes(key)) &&
    isArtifactId(version.groupId) && Number.isSafeInteger(version.number) && Number(version.number) > 0 &&
    (version.derivedFromId === undefined || isArtifactId(version.derivedFromId) && version.derivedFromId !== artifactId) &&
    (version.number !== 1 || version.derivedFromId === undefined && (artifactId === undefined || version.groupId === artifactId));
}

const isArtifactId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && (record.kind === "midi" || record.kind === "audio") &&
    isArtifactId(record.id);
}

/** A tool result may expose the bounded set of locally saved outputs. */
export function isArtifactRefs(value: unknown): value is ArtifactRef[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_AUDIO_JOB_OUTPUTS &&
    value.every(isArtifactRef) && new Set(value.map((ref) => `${ref.kind}:${ref.id}`)).size === value.length;
}

export function isArtifactSelection(value: unknown): value is ArtifactSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.candidate !== null && !isArtifactRef(record.candidate)) return false;
  if (record.action === "primary") return Object.keys(record).length === 3 && isArtifactRef(record.group) &&
    (record.candidate === null || record.candidate.kind === record.group.kind);
  return Object.keys(record).length === 2 && (record.action === "prefer" || record.action === "continue");
}

export const artifactKey = (artifact: ArtifactRef): string => `${artifact.kind}:${artifact.id}`;

/** A continuation is consumed only by a durable initial chat user event. */
export type ArtifactHistoryEvent = Pick<SessionEvent, "kind" | "candidateSelection"> & {
  steeringReceipt?: unknown;
  steeringAck?: unknown;
};

/** The latest per-work choice wins; callers validate it against currently readable members. */
export function primaryArtifactsFromEvents(events: readonly ArtifactHistoryEvent[]): Map<string, ArtifactRef> {
  const selected = new Map<string, ArtifactRef>();
  for (const event of events) {
    const selection = event.candidateSelection;
    if (selection?.action !== "primary") continue;
    const key = artifactKey(selection.group);
    if (selection.candidate) selected.set(key, { ...selection.candidate });
    else selected.delete(key);
  }
  return selected;
}

export function pendingArtifactParentFromEvents(events: readonly ArtifactHistoryEvent[]): ArtifactRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === "user" && !event.steeringReceipt && !event.steeringAck) return undefined;
    if (event.candidateSelection?.action === "continue") return event.candidateSelection.candidate ?? undefined;
  }
  return undefined;
}

export function artifactSourceInstructions(artifact: ArtifactRef | undefined): string {
  return artifact ? `The user selected this saved Session artifact as the source for this request: ${JSON.stringify(artifact)}. Preserve its provenance when generating variations. Read it through the admitted artifact/audio tools; selecting a source does not authorize a paid tool call or Live mutation.` : "";
}
