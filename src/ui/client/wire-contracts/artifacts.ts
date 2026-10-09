import { isArtifactRef, isArtifactVersion, MAX_MIDI_ARTIFACT_OVERVIEW_NOTES } from "../../../agent/artifact-contracts.js";
import type { MidiPartPreview, SessionArtifact, SessionArtifactDetail, SessionArtifacts } from "../../../app/session/session-artifacts.js";
import { MAX_SEARCH_QUERY_LENGTH, normalizeSearchQuery } from "../../../app/session/search-contracts.js";
import { isDeviceParameterSnapshot, isDeviceParameterTarget, MAX_DEVICE_PARAMETERS } from "../../../agent/device-parameter-contracts.js";
// Mirrors MAX_MIDI_ARTIFACT_NOTES in storage/midi-artifacts.ts, which requires Node.
const MAX_SOURCE_NOTES = 4096;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const previewNote = (value: unknown): value is MidiPartPreview["notes"][number] => record(value) && text(value.partId, 64) &&
  finite(value.pitch) && value.pitch <= 127 && finite(value.startTime) && finite(value.duration);
export function isMidiPartPreview(value: unknown): value is MidiPartPreview {
  return record(value) && typeof value.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.sessionId) &&
    isArtifactRef({ kind: "midi", id: value.artifactRef }) && text(value.partId, 64) && value.partId.length > 0 &&
    Array.isArray(value.notes) && value.notes.length <= MAX_SOURCE_NOTES &&
    value.notes.every((note) => previewNote(note) && note.partId === value.partId) &&
    value.omittedNoteCount === 0;
}
export function isSessionArtifactDetail(value: unknown): value is SessionArtifactDetail {
  if (!record(value) || !text(value.sessionId, 128) || !isSessionArtifact(value.artifact, MAX_SOURCE_NOTES)) return false;
  return value.artifact.ref.kind === "device-parameters" ? value.artifact.deviceParameters?.parameters !== undefined : value.artifact.ref.kind !== "midi" || value.artifact.midi!.omittedNoteCount === 0;
}
export function isSessionArtifacts(value: unknown): value is SessionArtifacts {
  return record(value) && text(value.sessionId, 128) && Array.isArray(value.artifacts) && value.artifacts.length <= 24 &&
    (value.query === undefined || text(value.query, MAX_SEARCH_QUERY_LENGTH) && value.query.length > 0 && normalizeSearchQuery(value.query) === value.query) &&
    finite(value.total) && finite(value.offset) && finite(value.unavailableCount) &&
    (value.continuation === undefined || isArtifactRef(value.continuation)) && value.artifacts.every((artifact) => isSessionArtifact(artifact, MAX_MIDI_ARTIFACT_OVERVIEW_NOTES));
}
function isSessionArtifact(artifact: unknown, maximumMidiNotes: number): artifact is SessionArtifact {
  if (!record(artifact) || !isArtifactRef(artifact.ref)) return false;
  const ref = artifact.ref;
  const primary = artifact.primary;
  return text(artifact.label, 512) &&
    text(artifact.createdAt, 64) && text(artifact.sourceLabel, 512) &&
    (artifact.version === undefined || record(artifact.version) &&
      isArtifactVersion({ groupId: artifact.version.groupId, number: artifact.version.number,
        ...(artifact.version.derivedFromId === undefined ? {} : { derivedFromId: artifact.version.derivedFromId }) }, ref.id) &&
      text(artifact.version.groupLabel, 512)) &&
    (artifact.versions === undefined || Array.isArray(artifact.versions) && artifact.versions.length > 0 && artifact.versions.length <= 256 &&
      artifact.versions.every((version) => record(version) && isArtifactRef({ kind: ref.kind, id: version.id }) && text(version.label, 512) &&
        Number.isSafeInteger(version.number) && Number(version.number) > 0 && text(version.createdAt, 64) &&
        (version.derivedFromId === undefined || isArtifactRef({ kind: ref.kind, id: version.derivedFromId })))) &&
    (primary === undefined || isArtifactRef(primary) && primary.kind === ref.kind &&
      (Array.isArray(artifact.versions) ? artifact.versions.some((version) => record(version) && version.id === primary.id)
        : primary.id === ref.id)) &&
    (artifact.parent === undefined || isArtifactRef(artifact.parent)) &&
    (artifact.generation === undefined || record(artifact.generation) && text(artifact.generation.toolName, 256) &&
      text(artifact.generation.callEventId, 128) && text(artifact.generation.resultEventId, 128) &&
      (artifact.generation.requestEventId === undefined || text(artifact.generation.requestEventId, 128)) &&
      text(artifact.generation.parameters, 4000) && typeof artifact.generation.parametersTruncated === "boolean") &&
    (ref.kind === "device-parameters" ? record(artifact.deviceParameters) && isDeviceParameterTarget(artifact.deviceParameters.target) &&
      ["captured", "model"].includes(String(artifact.deviceParameters.source)) && Number.isSafeInteger(artifact.deviceParameters.parameterCount) &&
      Number(artifact.deviceParameters.parameterCount) > 0 && Number(artifact.deviceParameters.parameterCount) <= MAX_DEVICE_PARAMETERS &&
      (artifact.deviceParameters.parameters === undefined || isDeviceParameterSnapshot({ target: artifact.deviceParameters.target, parameters: artifact.deviceParameters.parameters }) &&
        (artifact.deviceParameters.parameters as unknown[]).length === artifact.deviceParameters.parameterCount)
      : ref.kind === "audio" ? record(artifact.audio) && finite(artifact.audio.durationSeconds) && (artifact.audio.jobId === undefined || text(artifact.audio.jobId, 128)) &&
      ["audio/wav", "audio/mpeg"].includes(artifact.audio.mediaType as string)
      : record(artifact.midi) && finite(artifact.midi.durationBeats) && artifact.midi.durationBeats > 0 && finite(artifact.midi.noteCount) &&
        Number.isSafeInteger(artifact.midi.noteCount) && artifact.midi.noteCount <= MAX_SOURCE_NOTES &&
        finite(artifact.midi.omittedNoteCount) && Number.isSafeInteger(artifact.midi.omittedNoteCount) && Array.isArray(artifact.midi.parts) && artifact.midi.parts.length <= 512 &&
        artifact.midi.parts.every((part) => record(part) && text(part.id, 64) && finite(part.sourceTrackIndex) && finite(part.channel) &&
          finite(part.durationBeats) && finite(part.noteCount) && (part.sourceTrackName === undefined || text(part.sourceTrackName, 120))) &&
        Array.isArray(artifact.midi.notes) && artifact.midi.notes.length <= maximumMidiNotes &&
        artifact.midi.noteCount === artifact.midi.notes.length + artifact.midi.omittedNoteCount && artifact.midi.notes.every((note) => previewNote(note) &&
          (artifact.midi as { parts: { id: string }[] }).parts.some((part) => part.id === note.partId)));
}
