import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { writeStandardMidi, type MidiWriteTrack } from "../../../src/attachments/midi-writer.js";
import { readMidiArtifactDiff, type MidiArtifactNote } from "../../../src/app/midi/midi-artifact-diff.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";
import { isMidiArtifactDiff } from "../../../src/ui/client/wire-contracts/midi-artifact-diff.js";
import { endTrack, event, midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";

const note = (pitch = 60, startTime = 0, duration = 1, velocity = 90): MidiArtifactNote =>
  ({ pitch, startTime, duration, velocity });
const track = (name: string, notes = [note()], channel = 1): MidiWriteTrack => ({ name, channel, notes });

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-diff-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "MIDI", projectKey: "project", scope: { kind: "selection", identity: "selected", label: "MIDI" },
  });
  const saveBytes = (bytes: Uint8Array, revisionOf?: string) => saveMidiArtifact(directory, session.id, {
    connectionId: "generator", serverId: "midi", toolName: "generate_midi", label: "Section",
    bytes, signal: createHostAbortController().signal, ...(revisionOf ? { revisionOf } : {}),
  });
  const save = (tracks: MidiWriteTrack[], revisionOf?: string, durationBeats = 32) =>
    saveBytes(writeStandardMidi({ tracks, durationBeats }), revisionOf);
  const read = (artifactRef: string, signal = createHostAbortController().signal, sessionId = session.id) =>
    readMidiArtifactDiff({ storageDirectory: directory, sessionId, artifactRef, signal });
  return { directory, session, saveBytes, save, read };
}

test("MIDI diff follows the actual branch parent, preserves all four note properties, and performs no writes", async (t) => {
  const h = await setup(t);
  const before = [note(), note(62, 2, 1, 91), note(64, 4, 1, 92), note(65, 7, 1, 93),
    note(67, 10, 1, 94), note(70, 12, 1, 95)];
  const after = [note(60, 0, 1, 100), note(63, 2, 1, 91), note(64, 5, 1, 92), note(65, 7, 2, 93),
    note(67, 10, 1, 94), note(80, 15, 2, 110)];
  const first = await h.save([track("Piano", before)], undefined, 16);
  await h.save([track("Piano", [note(100)])], first.id);
  const third = await h.save([track("Piano", after)], first.id, 18);
  const snapshot = async (directory: string): Promise<unknown> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => [
      entry.name, entry.isDirectory() ? await snapshot(path.join(directory, entry.name)) :
        (await fs.readFile(path.join(directory, entry.name))).toString("base64"),
    ]));
  };
  const saved = await snapshot(h.directory);
  const diff = await h.read(third.id);
  assert.deepEqual(await snapshot(h.directory), saved);
  assert.equal(diff.baseArtifactRef, first.id);
  assert.equal(diff.baseVersion, 1);
  assert.equal(diff.version, 3);
  assert.equal(diff.beforeDurationBeats, 16);
  assert.equal(diff.afterDurationBeats, 18);
  assert.deepEqual([diff.added, diff.removed, diff.modified, diff.unchanged], [1, 1, 4, 1]);
  assert.deepEqual(diff.parts[0]!.before, { id: "track-0-channel-1", label: "Piano", channel: 1 });
  assert.deepEqual(diff.parts[0]!.changes, [
    { kind: "modified", before: before[0], after: after[0] },
    { kind: "modified", before: before[1], after: after[1] },
    { kind: "modified", before: before[2], after: after[2] },
    { kind: "modified", before: before[3], after: after[3] },
    { kind: "removed", before: before[5] },
    { kind: "added", after: after[5] },
  ]);
  assert.deepEqual(diff.parts[0]!.properties, { pitch: 1, startTime: 1, duration: 1, velocity: 1 });
  assert.equal(diff.parts[0]!.transposeSemitones, undefined);
  assert.equal(isMidiArtifactDiff(diff), true);
});

test("MIDI diff reads notes beyond overview limits and returns complete changes for every part", async (t) => {
  const h = await setup(t);
  const notes = Array.from({ length: 300 }, (_, i) => note(60, i));
  const first = await h.save([track("Piano", notes)], undefined, 301);
  const revised = notes.map((entry, i) => i === 299 ? { ...entry, velocity: 100 } : entry);
  const second = await h.save([track("Piano", revised)], first.id, 301);
  const late = await h.read(second.id);
  assert.equal(late.modified, 1);
  assert.equal(late.unchanged, 299);
  assert.deepEqual(late.parts[0]!.changes, [{ kind: "modified", before: notes[299], after: revised[299] }]);
  const base = await h.save([track("Piano", notes), track("Bass", notes, 2)], undefined, 301);
  const changed = await h.save([track("Piano", notes.map((entry) => ({ ...entry, pitch: 61 }))),
    track("Bass", notes.map((entry) => ({ ...entry, velocity: 100 })), 2)], base.id, 301);
  const diff = await h.read(changed.id);
  assert.deepEqual([diff.modified, diff.unchanged, diff.added, diff.removed], [600, 0, 0, 0]);
  assert.deepEqual(diff.parts.map((part) => part.changes.length), [300, 300]);
  assert.deepEqual(diff.parts[0]!.changes.at(-1), { kind: "modified", before: notes[299], after: { ...notes[299]!, pitch: 61 } });
  assert.deepEqual(diff.parts[1]!.changes.at(-1), { kind: "modified", before: notes[299], after: { ...notes[299]!, velocity: 100 } });
  assert.deepEqual(diff.parts.map((part) => part.properties), [
    { pitch: 300, startTime: 0, duration: 0, velocity: 0 },
    { pitch: 0, startTime: 0, duration: 0, velocity: 300 },
  ]);
  assert.deepEqual(diff.parts.map((part) => part.transposeSemitones), [1, undefined]);
  assert.equal(isMidiArtifactDiff(diff), true);
});

test("named track order is not identity and unique unnamed channels can align", async (t) => {
  const h = await setup(t);
  const before = [track("Piano", [note()]), track("Bass", [note(36)], 2), track("", [note(50)], 3)];
  const first = await h.save(before);
  const second = await h.save([before[2]!, before[1]!, before[0]!], first.id);
  const diff = await h.read(second.id);
  assert.deepEqual([diff.unchanged, diff.modified, diff.added, diff.removed], [3, 0, 0, 0]);
  assert.deepEqual(diff.parts.map((part) => [part.before!.id, part.after!.id]), [
    ["track-0-channel-1", "track-2-channel-1"], ["track-1-channel-2", "track-1-channel-2"],
    ["track-2-channel-3", "track-0-channel-3"],
  ]);
});

test("ambiguous named or unnamed parts remain added and removed even with equal track indexes", async (t) => {
  const h = await setup(t);
  for (const [before, after] of [
    [[track("Piano"), track("Piano", [note(62)])], [track("Piano"), track("Piano", [note(62)])]],
    [[track(""), track("", [note(62)])], [track(""), track("", [note(62)])]],
  ] as [MidiWriteTrack[], MidiWriteTrack[]][]) {
    const first = await h.save(before);
    const second = await h.save(after, first.id);
    const diff = await h.read(second.id);
    assert.deepEqual([diff.added, diff.removed, diff.modified, diff.unchanged], [after.length, before.length, 0, 0]);
    assert.equal(diff.parts.length, before.length + after.length);
    assert.equal(isMidiArtifactDiff(diff), true);
  }
});

test("unnamed parts sharing a channel with named parts do not claim a durable identity", async (t) => {
  const h = await setup(t);
  const named = track("Piano");
  const unnamed = track("", [note(62)]);
  const first = await h.save([named, unnamed]);
  const second = await h.save([unnamed, named], first.id);
  const diff = await h.read(second.id);
  assert.deepEqual([diff.added, diff.removed, diff.modified, diff.unchanged], [1, 1, 0, 1]);
  assert.deepEqual(diff.parts.map((part) => [part.before?.label, part.after?.label]),
    [["Piano", "Piano"], ["", undefined], [undefined, ""]]);
});

test("MIDI diff does not guess ambiguous chord or cross-property modifications", async (t) => {
  const h = await setup(t);
  for (const [before, after] of [
    [[note(60), note(64)], [note(62), note(65)]],
    [[note()], [note(61), note(60, 1)]],
    [[note(61), note(60, 1)], [note()]],
    [[note()], [note(61, 1)]],
  ]) {
    const first = await h.save([track("Piano", before)]);
    const second = await h.save([track("Piano", after)], first.id);
    const diff = await h.read(second.id);
    assert.deepEqual([diff.modified, diff.unchanged, diff.added, diff.removed], [0, 0, after!.length, before!.length]);
  }
});

function duplicateBytes(count: number, velocity = 90): Uint8Array {
  return midiBytes({ tracks: [[...Array.from({ length: count }, () => event(0, 0x90, 60, velocity)).flat(),
    ...event(480, 0x80, 60, 0), ...Array.from({ length: count - 1 }, () => event(0, 0x80, 60, 0)).flat(), ...endTrack()]] });
}

test("exact matching is a multiset and remaining duplicate notes are not guessed as modifications", async (t) => {
  const h = await setup(t);
  const first = await h.saveBytes(duplicateBytes(2));
  const second = await h.saveBytes(duplicateBytes(1), first.id);
  const fewer = await h.read(second.id);
  assert.deepEqual([fewer.unchanged, fewer.removed, fewer.added, fewer.modified], [1, 1, 0, 0]);
  const third = await h.saveBytes(duplicateBytes(2), first.id);
  assert.equal((await h.read(third.id)).unchanged, 2);
  const fourth = await h.saveBytes(duplicateBytes(1, 100), first.id);
  const ambiguous = await h.read(fourth.id);
  assert.deepEqual([ambiguous.unchanged, ambiguous.removed, ambiguous.added, ambiguous.modified], [0, 2, 1, 0]);
});

test("equivalent beat fractions at different PPQ values are unchanged", async (t) => {
  const h = await setup(t);
  const first = await h.saveBytes(midiBytes({ division: 480, tracks: [noteTrack({ startTicks: 160, durationTicks: 320 })] }));
  const second = await h.saveBytes(midiBytes({ division: 960, tracks: [noteTrack({ startTicks: 320, durationTicks: 640 })] }), first.id);
  const diff = await h.read(second.id);
  assert.deepEqual([diff.unchanged, diff.modified, diff.added, diff.removed], [1, 0, 0, 0]);
  assert.deepEqual(diff.parts[0]!.changes, []);
  const preciseBase = await h.saveBytes(midiBytes({ division: 32767,
    tracks: [noteTrack({ startTicks: 32766, durationTicks: 32767 })] }));
  const preciseRevision = await h.saveBytes(midiBytes({ division: 32766,
    tracks: [noteTrack({ startTicks: 32765, durationTicks: 32766 })] }), preciseBase.id);
  const precise = await h.read(preciseRevision.id);
  assert.deepEqual([precise.unchanged, precise.modified, precise.added, precise.removed], [0, 1, 0, 0]);
});

test("MIDI diff rejects missing parent, cross-Session access, unavailable files, and inconsistent lineage", async (t) => {
  const h = await setup(t);
  const first = await h.save([track("Piano")]);
  await assert.rejects(h.read(first.id), /no source version/);
  const second = await h.save([track("Piano", [note(62)])], first.id);
  const other = await createSession(h.directory, {
    title: "Other", projectKey: "project", scope: { kind: "selection", identity: "other", label: "Other" },
  });
  await assert.rejects(h.read(second.id, createHostAbortController().signal, other.id), /does not exist|invalid/);
  const metadataPath = path.join(h.directory, "live-smith-midi", h.session.id, `${second.id}.midi.json`);
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const foreign = await saveMidiArtifact(h.directory, other.id, {
    connectionId: "generator", serverId: "midi", toolName: "generate_midi", label: "Other",
    bytes: writeStandardMidi({ tracks: [track("Piano")], durationBeats: 4 }), signal: createHostAbortController().signal,
  });
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, version: { ...metadata.version, derivedFromId: foreign.id } }));
  await assert.rejects(h.read(second.id), /source MIDI version is unavailable in this Session/);
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, version: { ...metadata.version, groupId: second.id } }));
  await assert.rejects(h.read(second.id), /same work/);
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await fs.unlink(path.join(h.directory, "live-smith-midi", h.session.id, `${first.id}.mid`));
  await assert.rejects(h.read(second.id), /source MIDI version is unavailable/);
});

test("MIDI diff honors cancellation and does not reclassify it as a missing source", async (t) => {
  const h = await setup(t);
  const first = await h.save([track("Piano")]);
  const second = await h.save([track("Piano", [note(62)])], first.id);
  const controller = createHostAbortController();
  controller.abort();
  await assert.rejects(h.read(second.id, controller.signal), { name: "AbortError" });
  const duringRead = createHostAbortController();
  const pending = h.read(second.id, duringRead.signal);
  duringRead.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("MIDI diff wire validation rejects malformed identities, counts, changes, and unbounded details", async (t) => {
  const h = await setup(t);
  const first = await h.save([track("Piano")]);
  const second = await h.save([track("Piano", [note(62)])], first.id);
  const diff = await h.read(second.id);
  assert.equal(isMidiArtifactDiff(JSON.parse(JSON.stringify(diff))), true);
  const mutate = (edit: (value: any) => void): boolean => {
    const value = JSON.parse(JSON.stringify(diff)); edit(value); return isMidiArtifactDiff(value);
  };
  assert.equal(mutate((value) => { value.baseVersion = value.version; }), false);
  assert.equal(mutate((value) => { value.artifactRef = value.baseArtifactRef; }), false);
  assert.equal(mutate((value) => { value.sessionId = "../other"; }), false);
  assert.equal(mutate((value) => { value.parts[0].after.channel = 2; }), false);
  assert.equal(mutate((value) => { value.parts[0].after.extra = true; }), false);
  assert.equal(mutate((value) => { value.parts[0].changes[0].before.velocity = 128; }), false);
  assert.equal(mutate((value) => { value.parts[0].changes[0].after.duration = 0; }), false);
  assert.equal(mutate((value) => { value.modified = 2; }), false);
  assert.equal(mutate((value) => { value.parts[0].extra = true; }), false);
  assert.equal(mutate((value) => { value.parts[0].before = undefined; }), false);
  assert.equal(mutate((value) => { delete value.parts[0].properties; }), false);
  assert.equal(mutate((value) => { value.parts[0].properties.extra = 0; }), false);
  assert.equal(mutate((value) => { value.parts[0].properties.pitch = 0; }), false);
  assert.equal(mutate((value) => { value.parts[0].properties.pitch = 2; }), false);
  assert.equal(mutate((value) => { value.parts[0].properties.duration = 1; }), false);
  for (const transpose of [0, 0.5, 128, -128, "2", null]) {
    assert.equal(mutate((value) => { value.parts[0].transposeSemitones = transpose; }), false);
  }
  assert.equal(mutate((value) => { value.parts[0].transposeSemitones = -2; }), false);
  assert.equal(mutate((value) => { value.parts[0].changes[0].after = value.parts[0].changes[0].before; }), false);
  assert.equal(mutate((value) => {
    value.modified = value.parts[0].modified = value.parts[0].properties.pitch = 4097;
    value.parts[0].changes = Array.from({ length: 4097 }, () => value.parts[0].changes[0]);
  }), false);
  assert.equal(mutate((value) => {
    const second = JSON.parse(JSON.stringify(value.parts[0]));
    value.parts.push(second); value.modified = 2;
  }), false);
});

test("explicit MIDI comparison accepts any distinct version in the same work without changing lineage", async (t) => {
  const h = await setup(t);
  const first = await h.save([track("Piano", [note(60)])]);
  const second = await h.save([track("Piano", [note(64)])], first.id);
  const third = await h.save([track("Piano", [note(67)])], first.id);
  const compare = (artifactRef: string, baseArtifactRef: string) => readMidiArtifactDiff({
    storageDirectory: h.directory, sessionId: h.session.id, artifactRef, baseArtifactRef, signal: createHostAbortController().signal,
  });
  const sideways = await compare(third.id, second.id);
  assert.equal(sideways.baseVersion, 2); assert.equal(sideways.version, 3);
  assert.equal(sideways.modified, 1); assert.equal(isMidiArtifactDiff(sideways), true);
  const backwards = await compare(first.id, third.id);
  assert.equal(backwards.baseVersion, 3); assert.equal(backwards.version, 1);
  assert.equal(isMidiArtifactDiff(backwards), true);
  assert.equal((await h.read(third.id)).baseArtifactRef, first.id);
  await assert.rejects(compare(first.id, first.id), /different MIDI version/);
  const other = await h.save([track("Piano", [note(72)])]);
  await assert.rejects(compare(third.id, other.id), /same work/);
});


test("renamed and reordered unique-channel parts preserve complete chord transpositions", async (t) => {
  const h = await setup(t);
  const names = ["Lead", "Piano", "Bass", "Strings"];
  const before = names.map((name, index) => track(`${name} F`, [
    note(53 + index, 0, 2, 88), note(57 + index, 0, 2, 88), note(60 + index, 0, 2, 88),
    note(60 + index, 4, 1, 96), note(62 + index, 4, 1, 96), note(65 + index, 4, 1, 96),
  ], index + 1));
  const after = before.map((part, index) => track(`${names[index]} G`,
    [...part.notes].reverse().map((entry) => note(entry.pitch + 2, entry.startTime, entry.duration, entry.velocity!)), index + 1));
  const first = await h.save(before);
  const second = await h.save([after[3]!, after[1]!, after[0]!, after[2]!], first.id);
  const diff = await h.read(second.id);
  assert.equal(diff.parts.length, 4);
  assert.deepEqual([diff.added, diff.removed, diff.modified, diff.unchanged], [0, 0, 24, 0]);
  for (const [index, part] of diff.parts.entries()) {
    assert.equal(part.before!.label, `${names[index]} F`);
    assert.equal(part.after!.label, `${names[index]} G`);
    assert.equal(part.before!.channel, part.after!.channel);
    assert.equal(part.transposeSemitones, 2);
    assert.deepEqual(part.properties, { pitch: 6, startTime: 0, duration: 0, velocity: 0 });
    assert.equal(part.changes.length, 6);
    for (const change of part.changes) {
      assert.equal(change.kind, "modified");
      if (change.kind !== "modified") assert.fail("Every transposed note needs both versions");
      assert.equal(change.after.pitch - change.before.pitch, 2);
      assert.deepEqual({ ...change.after, pitch: change.before.pitch }, change.before);
    }
  }
  assert.equal(isMidiArtifactDiff(diff), true);
});

test("channel fallback requires uniqueness in both complete versions after exact named matches", async (t) => {
  const h = await setup(t);
  const piano = track("Piano", [note(60)]);
  const bass = track("Bass", [note(36)]);
  for (const [before, after, unchanged, unmatched] of [
    [[piano], [track("Keys")], 1, 0],
    [[piano, bass], [bass, piano], 2, 0],
    [[piano, bass], [bass, track("Keys")], 1, 1],
  ] as [MidiWriteTrack[], MidiWriteTrack[], number, number][]) {
    const first = await h.save(before); const second = await h.save(after, first.id);
    const diff = await h.read(second.id);
    assert.deepEqual([diff.unchanged, diff.modified, diff.removed, diff.added], [unchanged, 0, unmatched, unmatched]);
    assert.equal(isMidiArtifactDiff(diff), true);
  }
  for (const [before, after] of [
    [[piano], [track("Keys"), bass]],
    [[piano, bass], [track("Keys")]],
  ] as [MidiWriteTrack[], MidiWriteTrack[]][]) {
    const first = await h.save(before); const second = await h.save(after, first.id);
    const diff = await h.read(second.id);
    assert.deepEqual([diff.modified, diff.unchanged, diff.removed, diff.added], [0, 0, before.length, after.length]);
  }
});

test("whole-part transposition requires unchanged rhythm, velocity, note counts and a single interval", async (t) => {
  const h = await setup(t);
  const before = [note(60), note(64), note(67), note(70, 4, 2, 100)];
  for (const after of [
    before,
    [note(62), note(66), note(69), note(71, 4, 2, 100)],
    [note(62), note(66), note(69), note(72, 4, 2, 101)],
    [note(62), note(66), note(69), note(72, 5, 2, 100)],
    [note(62), note(66), note(69), note(72, 4, 3, 100)],
    [note(62), note(66), note(69)],
  ]) {
    const first = await h.save([track("Piano", before)]);
    const second = await h.save([track("Piano", after)], first.id);
    const diff = await h.read(second.id);
    assert.equal(diff.parts[0]!.transposeSemitones, undefined);
    assert.equal(isMidiArtifactDiff(diff), true);
  }
  const first = await h.save([track("Piano", before)]);
  const second = await h.save([track("Piano", before.map((entry) => ({ ...entry, pitch: entry.pitch - 12 })))], first.id);
  assert.equal((await h.read(second.id)).parts[0]!.transposeSemitones, -12);
});


test("MIDI diff retains every part up to the source-bound total of 8192 changed notes", async (t) => {
  const h = await setup(t);
  const notes = Array.from({ length: 128 }, (_, index) => note(60, index));
  const parts = (prefix: string) => Array.from({ length: 32 }, (_, index) => track(`${prefix} ${index}`, notes, index % 16 + 1));
  const first = await h.save(parts("Original"), undefined, 129);
  const second = await h.save(parts("Renamed"), first.id, 129);
  const diff = await h.read(second.id);
  assert.deepEqual([diff.added, diff.removed, diff.modified, diff.unchanged], [4096, 4096, 0, 0]);
  assert.equal(diff.parts.length, 64);
  assert.equal(diff.parts.reduce((total, part) => total + part.changes.length, 0), 8192);
  assert.equal(diff.parts.every((part) => part.changes.length === 128), true);
  assert.equal(isMidiArtifactDiff(diff), true);
});
