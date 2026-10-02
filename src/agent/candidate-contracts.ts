import type { SessionEvent } from "../storage/events.js";

export interface CandidateRef { kind: "midi" | "audio"; id: string }
export interface CandidateSelection {
  action: "prefer" | "continue";
  candidate: CandidateRef | null;
}

export function isCandidateRef(value: unknown): value is CandidateRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && (record.kind === "midi" || record.kind === "audio") &&
    typeof record.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(record.id);
}

export function isCandidateSelection(value: unknown): value is CandidateSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && (record.action === "prefer" || record.action === "continue") &&
    (record.candidate === null || isCandidateRef(record.candidate));
}

export const candidateKey = (candidate: CandidateRef): string => `${candidate.kind}:${candidate.id}`;

/** A continuation is consumed only by a durable initial chat user event. */
export type CandidateHistoryEvent = Pick<SessionEvent, "kind" | "candidateSelection"> & {
  steeringReceipt?: unknown;
  steeringAck?: unknown;
};

export function pendingCandidateParentFromEvents(events: readonly CandidateHistoryEvent[]): CandidateRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === "user" && !event.steeringReceipt && !event.steeringAck) return undefined;
    if (event.candidateSelection?.action === "continue") return event.candidateSelection.candidate ?? undefined;
  }
  return undefined;
}

export function preferredCandidateFromEvents(events: readonly SessionEvent[]): CandidateRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const selection = events[index]!.candidateSelection;
    if (selection?.action === "prefer") return selection.candidate ?? undefined;
  }
  return undefined;
}

export function candidateSourceInstructions(candidate: CandidateRef | undefined): string {
  return candidate ? `The user selected this saved Session candidate as the source for this request: ${JSON.stringify(candidate)}. Preserve its provenance when generating variations. Read it through the admitted artifact/audio tools; selecting a source does not authorize a paid tool call or Live mutation.` : "";
}
