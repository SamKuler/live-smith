import { isLiveObjectId } from "../../../live/object-id.js";
import type { MidiArtifactImportPreview } from "../../../app/midi-artifact-preview.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const count = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100_000;

export function isMidiArtifactImportPreview(value: unknown): value is MidiArtifactImportPreview {
  if (!record(value) || !boundedString(value.sessionId, 128) || !boundedString(value.artifactRef, 128) ||
      !boundedString(value.label, 120) || !duration(value.durationBeats) || !count(value.unavailableTargetCount, 100_000) ||
      value.maxActions !== 64 || !record(value.timing) || !count(value.timing.tempoEventCount, 200_000) ||
      !count(value.timing.timeSignatureEventCount, 200_000) || !Array.isArray(value.parts) ||
      !value.parts.length || value.parts.length > 512 || !Array.isArray(value.targets)) return false;
  return value.parts.every((part) => record(part) && boundedString(part.id, 64) &&
    part.id === `track-${part.sourceTrackIndex}-channel-${part.channel}` && count(part.sourceTrackIndex, 31) &&
    count(part.channel, 16) && part.channel > 0 && count(part.noteCount, 4096) && part.noteCount > 0 &&
    duration(part.durationBeats) && (part.sourceTrackName === undefined || boundedString(part.sourceTrackName, 120))) &&
    new Set(value.parts.map((part) => part.id)).size === value.parts.length &&
    value.targets.every((target) => record(target) && isLiveObjectId(target.trackId) && boundedString(target.trackName)) &&
    new Set(value.targets.map((target) => target.trackId)).size === value.targets.length &&
    (value.suggestedTrackId === undefined || isLiveObjectId(value.suggestedTrackId) &&
      value.targets.some((target) => target.trackId === value.suggestedTrackId)) &&
    (value.suggestedStartBeat === undefined || typeof value.suggestedStartBeat === "number" &&
      Number.isFinite(value.suggestedStartBeat) && value.suggestedStartBeat >= 0);
}
