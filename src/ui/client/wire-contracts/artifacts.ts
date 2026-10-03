import { isArtifactRef } from "../../../agent/artifact-contracts.js";
import type { SessionArtifacts } from "../../../app/session/session-artifacts.js";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function isSessionArtifacts(value: unknown): value is SessionArtifacts {
  if (!record(value) || !text(value.sessionId, 128) || !Array.isArray(value.artifacts) || value.artifacts.length > 24 ||
      !finite(value.total) || !finite(value.offset) || !finite(value.unavailableCount) ||
      value.preferred !== undefined && !isArtifactRef(value.preferred) || value.continuation !== undefined && !isArtifactRef(value.continuation)) return false;
  return value.artifacts.every((artifact) => record(artifact) && isArtifactRef(artifact.ref) && text(artifact.label, 512) &&
    text(artifact.createdAt, 64) && text(artifact.sourceLabel, 512) && typeof artifact.preferred === "boolean" &&
    (artifact.version === undefined || record(artifact.version) && text(artifact.version.groupId, 128) &&
      Number.isSafeInteger(artifact.version.number) && Number(artifact.version.number) > 0 && text(artifact.version.groupLabel, 120) &&
      (artifact.version.derivedFromId === undefined || text(artifact.version.derivedFromId, 128))) &&
    (artifact.parent === undefined || isArtifactRef(artifact.parent)) &&
    (artifact.generation === undefined || record(artifact.generation) && text(artifact.generation.toolName, 256) &&
      text(artifact.generation.callEventId, 128) && text(artifact.generation.resultEventId, 128) &&
      (artifact.generation.requestEventId === undefined || text(artifact.generation.requestEventId, 128)) &&
      text(artifact.generation.parameters, 4000) && typeof artifact.generation.parametersTruncated === "boolean") &&
    (artifact.ref.kind === "audio" ? record(artifact.audio) && finite(artifact.audio.durationSeconds) && text(artifact.audio.jobId, 128) &&
      ["audio/wav", "audio/mpeg"].includes(artifact.audio.mediaType as string)
      : record(artifact.midi) && finite(artifact.midi.durationBeats) && artifact.midi.durationBeats > 0 && finite(artifact.midi.noteCount) &&
        finite(artifact.midi.omittedNoteCount) && Array.isArray(artifact.midi.parts) && artifact.midi.parts.length <= 512 &&
        artifact.midi.parts.every((part) => record(part) && text(part.id, 64) && finite(part.sourceTrackIndex) && finite(part.channel) &&
          finite(part.durationBeats) && finite(part.noteCount) && (part.sourceTrackName === undefined || text(part.sourceTrackName, 120))) &&
        Array.isArray(artifact.midi.notes) && artifact.midi.notes.length <= 256 && artifact.midi.notes.every((note) => record(note) &&
          finite(note.pitch) && note.pitch <= 127 && finite(note.startTime) && finite(note.duration))));
}
