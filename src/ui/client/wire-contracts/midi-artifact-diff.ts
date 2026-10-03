import type {
  MidiArtifactDiff, MidiArtifactNote, MidiArtifactNoteChange, MidiArtifactPartDiff, MidiArtifactPartIdentity, MidiArtifactPropertyCounts,
} from "../../../app/midi/midi-artifact-diff.js";
import { hasOnlyWireKeys, isWireRecord, isWireStorageId } from "./primitives.js";

// Mirrors storage/midi-artifacts.ts admission and attachments/midi.ts text retention; those modules require Node.
const MAX_SOURCE_NOTES = 4096;
const MAX_SOURCE_TRACKS = 32;
const MAX_DURATION_BEATS = 100_000;
const MAX_TRACK_LABEL_CHARACTERS = 4096;
const noteProperties = ["pitch", "startTime", "duration", "velocity"] as const;

const count = (value: unknown, maximum = MAX_SOURCE_NOTES): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const beat = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_BEATS;

function isNote(value: unknown): value is MidiArtifactNote {
  return isWireRecord(value) && hasOnlyWireKeys<MidiArtifactNote>(value, ["pitch", "startTime", "duration", "velocity"]) &&
    count(value.pitch, 127) && beat(value.startTime) && beat(value.duration) && value.duration > 0 &&
    count(value.velocity, 127) && value.velocity > 0;
}

function isIdentity(value: unknown): value is MidiArtifactPartIdentity {
  if (!isWireRecord(value) || !hasOnlyWireKeys<MidiArtifactPartIdentity>(value, ["id", "label", "channel"]) ||
      typeof value.id !== "string" || typeof value.label !== "string" || value.label.length > MAX_TRACK_LABEL_CHARACTERS ||
      !count(value.channel, 16) || value.channel < 1) return false;
  const match = /^track-(\d+)-channel-(\d+)$/.exec(value.id);
  return Boolean(match && count(Number(match[1]), MAX_SOURCE_TRACKS - 1) && Number(match[2]) === value.channel &&
    value.id === `track-${Number(match[1])}-channel-${value.channel}`);
}

function isChange(value: unknown): value is MidiArtifactNoteChange {
  if (!isWireRecord(value)) return false;
  if (value.kind === "added") return hasOnlyWireKeys<MidiArtifactNoteChange>(value, ["kind", "after"]) && isNote(value.after);
  if (value.kind === "removed") return hasOnlyWireKeys<MidiArtifactNoteChange>(value, ["kind", "before"]) && isNote(value.before);
  if (value.kind !== "modified" || !hasOnlyWireKeys<MidiArtifactNoteChange>(value, ["kind", "before", "after"]) ||
      !isNote(value.before) || !isNote(value.after)) return false;
  const { before, after } = value;
  return noteProperties.some((property) => before[property] !== after[property]);
}

function isProperties(value: unknown): value is MidiArtifactPropertyCounts {
  return isWireRecord(value) && hasOnlyWireKeys<MidiArtifactPropertyCounts>(value, noteProperties) &&
    noteProperties.every((property) => count(value[property]));
}

function isPart(value: unknown): value is MidiArtifactPartDiff {
  if (!isWireRecord(value) || !hasOnlyWireKeys<MidiArtifactPartDiff>(value,
      ["before", "after", "added", "removed", "modified", "unchanged", "properties", "transposeSemitones", "changes"]) ||
      value.before === undefined && value.after === undefined ||
      value.before !== undefined && !isIdentity(value.before) || value.after !== undefined && !isIdentity(value.after) ||
      !count(value.added) || !count(value.removed) || !count(value.modified) || !count(value.unchanged) ||
      !isProperties(value.properties) ||
      value.transposeSemitones !== undefined && (typeof value.transposeSemitones !== "number" ||
        !Number.isInteger(value.transposeSemitones) || value.transposeSemitones === 0 || Math.abs(value.transposeSemitones) > 127) ||
      !Array.isArray(value.changes) || value.changes.length > 2 * MAX_SOURCE_NOTES ||
      !value.changes.every(isChange)) return false;
  const displayed = { added: 0, removed: 0, modified: 0 };
  const properties = { pitch: 0, startTime: 0, duration: 0, velocity: 0 };
  for (const change of value.changes) {
    displayed[change.kind]++;
    if (change.kind !== "modified") continue;
    for (const property of noteProperties) {
      if (change.before[property] !== change.after[property]) properties[property]++;
    }
    if (value.transposeSemitones !== undefined && change.after.pitch - change.before.pitch !== value.transposeSemitones) return false;
  }
  const totalProperties = value.properties;
  if (noteProperties.some((property) => totalProperties[property] !== properties[property])) return false;
  if (value.transposeSemitones !== undefined && (value.modified === 0 || value.added !== 0 || value.removed !== 0 ||
      value.unchanged !== 0 || value.properties.pitch !== value.modified || value.properties.startTime !== 0 ||
      value.properties.duration !== 0 || value.properties.velocity !== 0)) return false;
  if (displayed.added !== value.added || displayed.removed !== value.removed || displayed.modified !== value.modified ||
      value.before === undefined && (value.removed !== 0 || value.modified !== 0 || value.unchanged !== 0) ||
      value.after === undefined && (value.added !== 0 || value.modified !== 0 || value.unchanged !== 0)) return false;
  return true;
}

export function isMidiArtifactDiff(value: unknown): value is MidiArtifactDiff {
  if (!isWireRecord(value) || !hasOnlyWireKeys<MidiArtifactDiff>(value,
      ["sessionId", "artifactRef", "baseArtifactRef", "baseVersion", "version", "beforeDurationBeats", "afterDurationBeats",
        "added", "removed", "modified", "unchanged", "parts"]) ||
      !isWireStorageId(value.sessionId) || !isWireStorageId(value.artifactRef) || !isWireStorageId(value.baseArtifactRef) ||
      value.artifactRef === value.baseArtifactRef || !count(value.baseVersion, Number.MAX_SAFE_INTEGER) || value.baseVersion < 1 ||
      !count(value.version, Number.MAX_SAFE_INTEGER) || value.version === value.baseVersion ||
      !beat(value.beforeDurationBeats) || value.beforeDurationBeats <= 0 ||
      !beat(value.afterDurationBeats) || value.afterDurationBeats <= 0 ||
      !count(value.added) || !count(value.removed) || !count(value.modified) || !count(value.unchanged) ||
      value.removed + value.modified + value.unchanged > MAX_SOURCE_NOTES || value.added + value.modified + value.unchanged > MAX_SOURCE_NOTES ||
      !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 2 * MAX_SOURCE_TRACKS * 16 || !value.parts.every(isPart)) return false;
  const totals = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const beforeIds = new Set<string>();
  const afterIds = new Set<string>();
  let displayed = 0;
  for (const part of value.parts) {
    if (part.before) {
      if (beforeIds.has(part.before.id)) return false;
      beforeIds.add(part.before.id);
    }
    if (part.after) {
      if (afterIds.has(part.after.id)) return false;
      afterIds.add(part.after.id);
    }
    totals.added += part.added; totals.removed += part.removed;
    totals.modified += part.modified; totals.unchanged += part.unchanged;
    displayed += part.changes.length;
  }
  return displayed <= 2 * MAX_SOURCE_NOTES && totals.added === value.added && totals.removed === value.removed &&
    totals.modified === value.modified && totals.unchanged === value.unchanged;
}
