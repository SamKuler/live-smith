import { isCandidateRef } from "../../../agent/candidate-contracts.js";
import type { SessionCandidates } from "../../../app/session/session-candidates.js";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function isSessionCandidates(value: unknown): value is SessionCandidates {
  if (!record(value) || !text(value.sessionId, 128) || !Array.isArray(value.candidates) || value.candidates.length > 24 ||
      !finite(value.total) || !finite(value.offset) || !finite(value.unavailableCount) ||
      value.preferred !== undefined && !isCandidateRef(value.preferred) || value.continuation !== undefined && !isCandidateRef(value.continuation)) return false;
  return value.candidates.every((candidate) => record(candidate) && isCandidateRef(candidate.ref) && text(candidate.label, 512) &&
    text(candidate.createdAt, 64) && text(candidate.sourceLabel, 512) && typeof candidate.preferred === "boolean" &&
    (candidate.version === undefined || record(candidate.version) && text(candidate.version.groupId, 128) &&
      Number.isSafeInteger(candidate.version.number) && Number(candidate.version.number) > 0 && text(candidate.version.groupLabel, 120) &&
      (candidate.version.derivedFromId === undefined || text(candidate.version.derivedFromId, 128))) &&
    (candidate.parent === undefined || isCandidateRef(candidate.parent)) &&
    (candidate.generation === undefined || record(candidate.generation) && text(candidate.generation.toolName, 256) &&
      text(candidate.generation.callEventId, 128) && text(candidate.generation.resultEventId, 128) &&
      (candidate.generation.requestEventId === undefined || text(candidate.generation.requestEventId, 128)) &&
      text(candidate.generation.parameters, 4000) && typeof candidate.generation.parametersTruncated === "boolean") &&
    (candidate.ref.kind === "audio" ? record(candidate.audio) && finite(candidate.audio.durationSeconds) && text(candidate.audio.jobId, 128) &&
      ["audio/wav", "audio/mpeg"].includes(candidate.audio.mediaType as string)
      : record(candidate.midi) && finite(candidate.midi.durationBeats) && candidate.midi.durationBeats > 0 && finite(candidate.midi.noteCount) &&
        finite(candidate.midi.omittedNoteCount) && Array.isArray(candidate.midi.parts) && candidate.midi.parts.length <= 512 &&
        candidate.midi.parts.every((part) => record(part) && text(part.id, 64) && finite(part.sourceTrackIndex) && finite(part.channel) &&
          finite(part.durationBeats) && finite(part.noteCount) && (part.sourceTrackName === undefined || text(part.sourceTrackName, 120))) &&
        Array.isArray(candidate.midi.notes) && candidate.midi.notes.length <= 256 && candidate.midi.notes.every((note) => record(note) &&
          finite(note.pitch) && note.pitch <= 127 && finite(note.startTime) && finite(note.duration))));
}
