import type { NoteDescription } from "@ableton-extensions/sdk";
import { throwIfAborted } from "../../runtime/host.js";
import { midiArtifactVersion, readMidiArtifact, type MidiArtifactPart } from "../../storage/midi-artifacts.js";

export interface MidiArtifactNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
}

export type MidiArtifactNoteChange =
  | { kind: "added"; after: MidiArtifactNote }
  | { kind: "removed"; before: MidiArtifactNote }
  | { kind: "modified"; before: MidiArtifactNote; after: MidiArtifactNote };

interface MidiArtifactDiffCounts { added: number; removed: number; modified: number; unchanged: number }
export interface MidiArtifactPartIdentity { id: string; label: string; channel: number }
export interface MidiArtifactPropertyCounts { pitch: number; startTime: number; duration: number; velocity: number }
export interface MidiArtifactPartDiff extends MidiArtifactDiffCounts {
  before?: MidiArtifactPartIdentity;
  after?: MidiArtifactPartIdentity;
  properties: MidiArtifactPropertyCounts;
  transposeSemitones?: number;
  changes: MidiArtifactNoteChange[];
}
export interface MidiArtifactDiff extends MidiArtifactDiffCounts {
  sessionId: string;
  artifactRef: string;
  baseArtifactRef: string;
  baseVersion: number;
  version: number;
  beforeDurationBeats: number;
  afterDurationBeats: number;
  parts: MidiArtifactPartDiff[];
}

/** Session/project admission belongs to the caller; both immutable files are read in the same Session. */
export async function readMidiArtifactDiff(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  artifactRef: string;
  baseArtifactRef?: string;
  signal: AbortSignal;
}): Promise<MidiArtifactDiff> {
  const target = await readMidiArtifact(input.storageDirectory, input.sessionId, input.artifactRef, input.signal);
  const version = midiArtifactVersion(target.artifact);
  const baseArtifactRef = input.baseArtifactRef ?? version.derivedFromId;
  if (!baseArtifactRef) throw new Error("This MIDI version has no source version to compare.");
  if (baseArtifactRef === target.artifact.id) throw new Error("Choose a different MIDI version to compare.");
  let base;
  try {
    base = await readMidiArtifact(input.storageDirectory, input.sessionId, baseArtifactRef, input.signal);
  } catch {
    throwIfAborted(input.signal);
    throw new Error("The source MIDI version is unavailable in this Session. Its changes cannot be shown.");
  }
  throwIfAborted(input.signal);
  const baseVersion = midiArtifactVersion(base.artifact);
  if (baseVersion.groupId !== version.groupId || !input.baseArtifactRef && baseVersion.number >= version.number) {
    throw new Error("Choose a MIDI version from the same work.");
  }
  const diff: MidiArtifactDiff = {
    sessionId: input.sessionId, artifactRef: target.artifact.id, baseArtifactRef: base.artifact.id,
    baseVersion: baseVersion.number, version: version.number,
    beforeDurationBeats: base.parsed.durationBeats, afterDurationBeats: target.parsed.durationBeats,
    ...emptyCounts(), parts: [],
  };
  for (const pair of alignParts(base.parsed.parts, target.parsed.parts)) {
    throwIfAborted(input.signal);
    const result = compareNotes(pair.before?.notes ?? [], pair.after?.notes ?? []);
    const part: MidiArtifactPartDiff = {
      ...(pair.before ? { before: partIdentity(pair.before) } : {}),
      ...(pair.after ? { after: partIdentity(pair.after) } : {}),
      ...result,
    };
    diff.parts.push(part);
    diff.added += part.added;
    diff.removed += part.removed;
    diff.modified += part.modified;
    diff.unchanged += part.unchanged;
  }
  throwIfAborted(input.signal);
  return diff;
}

function emptyCounts(): MidiArtifactDiffCounts { return { added: 0, removed: 0, modified: 0, unchanged: 0 }; }

function partIdentity(part: MidiArtifactPart): MidiArtifactPartIdentity {
  return { id: part.id, label: part.sourceTrackName ?? "", channel: part.channel };
}

/** File track indexes are local positions, not durable identities across revisions. */
function alignParts(before: readonly MidiArtifactPart[], after: readonly MidiArtifactPart[]): {
  before?: MidiArtifactPart; after?: MidiArtifactPart;
}[] {
  const key = (part: MidiArtifactPart): string => JSON.stringify([part.sourceTrackName ?? "", part.channel]);
  const beforeIndex = uniqueIndex(before.map(key));
  const afterIndex = uniqueIndex(after.map(key));
  const beforeChannels = uniqueIndex(before.map((part) => String(part.channel)));
  const afterChannels = uniqueIndex(after.map((part) => String(part.channel)));
  const matchedAfter = new Set<number>();
  const pairs: { before?: MidiArtifactPart; after?: MidiArtifactPart }[] = before.map((part) => {
    if (!part.sourceTrackName && (beforeChannels.get(String(part.channel)) === null ||
        afterChannels.get(String(part.channel)) === null)) return { before: part };
    const identity = key(part);
    const index = afterIndex.get(identity);
    if (beforeIndex.get(identity) === null || index === undefined || index === null) return { before: part };
    matchedAfter.add(index);
    return { before: part, after: after[index]! };
  });
  for (const pair of pairs) {
    if (pair.after || !pair.before) continue;
    const channel = String(pair.before.channel);
    const afterIndex = afterChannels.get(channel);
    if (beforeChannels.get(channel) === null || afterIndex === undefined || afterIndex === null ||
        matchedAfter.has(afterIndex)) continue;
    pair.after = after[afterIndex]!;
    matchedAfter.add(afterIndex);
  }
  after.forEach((part, index) => { if (!matchedAfter.has(index)) pairs.push({ after: part }); });
  return pairs;
}

/** null means the signature has multiple occurrences and cannot establish a unique pairing. */
function uniqueIndex(keys: readonly string[]): Map<string, number | null> {
  const index = new Map<string, number | null>();
  keys.forEach((key, position) => index.set(key, index.has(key) ? null : position));
  return index;
}

type NoteValues = readonly [number, number, number, number];
function noteValues(note: NoteDescription): NoteValues {
  // 1e-10 beat normalization absorbs floating arithmetic while staying below distinct SMF tick fractions.
  return [note.pitch, Math.round(note.startTime * 1e10), Math.round(note.duration * 1e10), note.velocity!];
}
function noteView(note: NoteDescription): MidiArtifactNote {
  return { pitch: note.pitch, startTime: note.startTime, duration: note.duration, velocity: note.velocity! };
}

function compareNotes(before: readonly NoteDescription[], after: readonly NoteDescription[]):
  MidiArtifactDiffCounts & Pick<MidiArtifactPartDiff, "properties" | "transposeSemitones" | "changes"> {
  const result = { ...emptyCounts(), properties: { pitch: 0, startTime: 0, duration: 0, velocity: 0 },
    changes: [] as MidiArtifactNoteChange[] };
  const add = (change: MidiArtifactNoteChange): void => {
    result[change.kind]++;
    if (change.kind === "modified") {
      for (const property of ["pitch", "startTime", "duration", "velocity"] as const) {
        if (change.before[property] !== change.after[property]) result.properties[property]++;
      }
    }
    result.changes.push(change);
  };
  const transposition = wholePartTransposition(before, after);
  if (transposition) {
    transposition.afterIndexes.forEach((target, source) => add({
      kind: "modified", before: noteView(before[source]!), after: noteView(after[target]!),
    }));
    return { ...result, transposeSemitones: transposition.semitones };
  }
  const beforeValues = before.map(noteValues);
  const afterValues = after.map(noteValues);
  const exactAfter = new Map<string, number[]>();
  afterValues.forEach((values, index) => {
    const key = JSON.stringify(values);
    const bucket = exactAfter.get(key);
    if (bucket) bucket.push(index);
    else exactAfter.set(key, [index]);
  });
  const beforeMatched = new Set<number>();
  const afterMatched = new Set<number>();
  beforeValues.forEach((values, index) => {
    const match = exactAfter.get(JSON.stringify(values))?.pop();
    if (match === undefined) return;
    beforeMatched.add(index);
    afterMatched.add(match);
    result.unchanged++;
  });
  const beforeRemaining = beforeValues.flatMap((values, index) => beforeMatched.has(index) ? [] : [{ index, values }]);
  const afterRemaining = afterValues.flatMap((values, index) => afterMatched.has(index) ? [] : [{ index, values }]);
  const beforeSignatures = modificationIndexes(beforeRemaining.map((note) => note.values));
  const afterSignatures = modificationIndexes(afterRemaining.map((note) => note.values));
  const beforeCandidates = beforeRemaining.map((note) => onlyCandidate(note.values, afterSignatures));
  const afterCandidates = afterRemaining.map((note) => onlyCandidate(note.values, beforeSignatures));
  beforeRemaining.forEach((note, position) => {
    const candidate = beforeCandidates[position];
    if (candidate === undefined || afterCandidates[candidate] !== position) return;
    const target = afterRemaining[candidate]!;
    beforeMatched.add(note.index);
    afterMatched.add(target.index);
    add({ kind: "modified", before: noteView(before[note.index]!), after: noteView(after[target.index]!) });
  });
  before.forEach((note, index) => { if (!beforeMatched.has(index)) add({ kind: "removed", before: noteView(note) }); });
  after.forEach((note, index) => { if (!afterMatched.has(index)) add({ kind: "added", after: noteView(note) }); });
  return result;
}

/** Match pitch-sorted notes inside identical rhythmic/velocity groups before consuming overlapping pitches. */
function wholePartTransposition(before: readonly NoteDescription[], after: readonly NoteDescription[]): {
  semitones: number; afterIndexes: number[];
} | undefined {
  if (!before.length || before.length !== after.length) return;
  const ordered = (notes: readonly NoteDescription[]) => notes.map((note, index) => ({ note, index })).sort((left, right) =>
    left.note.startTime - right.note.startTime || left.note.duration - right.note.duration ||
    left.note.velocity! - right.note.velocity! || left.note.pitch - right.note.pitch);
  const beforeOrdered = ordered(before);
  const afterOrdered = ordered(after);
  const semitones = afterOrdered[0]!.note.pitch - beforeOrdered[0]!.note.pitch;
  if (!semitones) return;
  const afterIndexes: number[] = [];
  for (const [position, source] of beforeOrdered.entries()) {
    const target = afterOrdered[position]!;
    if (source.note.startTime !== target.note.startTime || source.note.duration !== target.note.duration ||
        source.note.velocity !== target.note.velocity || target.note.pitch - source.note.pitch !== semitones) return;
    afterIndexes[source.index] = target.index;
  }
  return { semitones, afterIndexes };
}

function modificationKey(values: NoteValues, omittedField: number): string {
  return JSON.stringify(values.filter((_, index) => index !== omittedField));
}

function modificationIndexes(notes: readonly NoteValues[]): Map<string, number | null>[] {
  return [0, 1, 2, 3].map((field) => uniqueIndex(notes.map((note) => modificationKey(note, field))));
}

/** Require mutual uniqueness across every single-property change, avoiding greedy chord pairing. */
function onlyCandidate(values: NoteValues, indexes: readonly Map<string, number | null>[]): number | undefined {
  let candidate: number | undefined;
  for (const [field, index] of indexes.entries()) {
    const match = index.get(modificationKey(values, field));
    if (match === null || match !== undefined && candidate !== undefined && candidate !== match) return undefined;
    if (match !== undefined) candidate = match;
  }
  return candidate;
}
