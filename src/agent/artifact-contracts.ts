import type { SessionEvent } from "../storage/events.js";

export interface ArtifactRef { kind: "midi" | "audio"; id: string }
export interface ArtifactSelection {
  action: "prefer" | "continue";
  /** Serialized with the original Session event field name for saved-history compatibility. */
  candidate: ArtifactRef | null;
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && (record.kind === "midi" || record.kind === "audio") &&
    typeof record.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(record.id);
}

export function isArtifactSelection(value: unknown): value is ArtifactSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && (record.action === "prefer" || record.action === "continue") &&
    (record.candidate === null || isArtifactRef(record.candidate));
}

export const artifactKey = (artifact: ArtifactRef): string => `${artifact.kind}:${artifact.id}`;

/** A continuation is consumed only by a durable initial chat user event. */
export type ArtifactHistoryEvent = Pick<SessionEvent, "kind" | "candidateSelection"> & {
  steeringReceipt?: unknown;
  steeringAck?: unknown;
};

export function pendingArtifactParentFromEvents(events: readonly ArtifactHistoryEvent[]): ArtifactRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === "user" && !event.steeringReceipt && !event.steeringAck) return undefined;
    if (event.candidateSelection?.action === "continue") return event.candidateSelection.candidate ?? undefined;
  }
  return undefined;
}

export function preferredArtifactFromEvents(events: readonly SessionEvent[]): ArtifactRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const selection = events[index]!.candidateSelection;
    if (selection?.action === "prefer") return selection.candidate ?? undefined;
  }
  return undefined;
}

export function artifactSourceInstructions(artifact: ArtifactRef | undefined): string {
  return artifact ? `The user selected this saved Session artifact as the source for this request: ${JSON.stringify(artifact)}. Preserve its provenance when generating variations. Read it through the admitted artifact/audio tools; selecting a source does not authorize a paid tool call or Live mutation.` : "";
}
