import assert from "node:assert/strict";
import test from "node:test";
import { writeStandardMidi, type MidiWriteTrack } from "../../src/attachments/midi-writer.js";
import { parseStandardMidi } from "../../src/attachments/midi.js";
import { parseMidiArtifact } from "../../src/storage/midi-artifacts.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const note = (startTime = 0, duration = 1, pitch = 60, velocity = 90) => ({ startTime, duration, pitch, velocity });
const track = (notes = [note()], channel = 1, name = "Lead"): MidiWriteTrack => ({ name, channel, notes });

test("SMF writing preserves named multitrack parts, channel numbers, offsets and silent endings", () => {
  const input = { durationBeats: 8, tracks: [
    track([note(2, 1, 64), note(0, 0.5, 60)], 16, "旋律 🎻"),
    track([], 3, "Rest"),
    track([note(1, 2, 36, 127)], 10, "Bass"),
  ] };
  const before = JSON.stringify(input);
  const bytes = writeStandardMidi(input);
  const parsed = parseStandardMidi(bytes, { purpose: "artifact" });
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ticksPerQuarterNote, 960);
  assert.equal(parsed.durationBeats, 8);
  assert.deepEqual(parsed.tracks.map(({ name, durationBeats, channels }) => ({ name, durationBeats, channels })), [
    { name: "旋律 🎻", durationBeats: 8, channels: [16] },
    { name: "Rest", durationBeats: 8, channels: [] },
    { name: "Bass", durationBeats: 8, channels: [10] },
  ]);
  const artifact = parseMidiArtifact(bytes);
  assert.deepEqual(artifact.parts.map((part) => [part.id, part.notes]), [
    ["track-0-channel-16", [note(0, 0.5, 60), note(2, 1, 64)]],
    ["track-2-channel-10", [note(1, 2, 36, 127)]],
  ]);
  assert.deepEqual(artifact.timing, { tempoEventCount: 0, timeSignatureEventCount: 0 });
  assert.equal(JSON.stringify(input), before);
});

test("adjacent repeated pitches release before the next attack and ordinary polyphony remains separate", () => {
  const notes = [note(1, 1, 60, 110), note(0, 1, 60, 70), note(0.5, 1, 64)];
  const parsed = parseMidiArtifact(writeStandardMidi({ durationBeats: 4, tracks: [track(notes)] }));
  assert.deepEqual(parsed.parts[0]!.notes, [notes[1], notes[2], notes[0]]);
  assert.throws(() => writeStandardMidi({ durationBeats: 4, tracks: [track([note(0, 2), note(1, 1)])] }), /cannot overlap/);
  assert.throws(() => writeStandardMidi({ durationBeats: 4, tracks: [track([note(), note()])] }), /cannot overlap/);
  assert.equal(parseMidiArtifact(writeStandardMidi({ durationBeats: 4, tracks: [track(), track()] })).notes.length, 2);
});

test("fractional beats round to MIDI ticks without losing triplets or producing zero-length notes", () => {
  const notes = [{ pitch: 60, startTime: 1 / 3, duration: 1 / 3 }, note(0.1, 0.2, 62), note(0.5001, 0.5001, 64)];
  const result = parseMidiArtifact(writeStandardMidi({ durationBeats: 2, tracks: [{ name: "Triplets", channel: 1, notes }] }));
  assert.deepEqual(result.parts[0]!.notes, [note(0.1, 0.2, 62), note(1 / 3, 1 / 3, 60, 100), note(0.5, 0.5, 64)]);
  assert.throws(() => writeStandardMidi({ durationBeats: 1, tracks: [track([note(0, 0.0001)])] }), /at least one tick/);
  assert.throws(() => writeStandardMidi({ durationBeats: 1, tracks: [track([note(0.5, 0.6)])] }), /fit inside/);
});

test("long rests use valid multibyte deltas and track names preserve multibyte UTF-8", () => {
  const name = "弦".repeat(80);
  const result = parseStandardMidi(writeStandardMidi({ durationBeats: 100_000, tracks: [track([note(99_999, 1)], 1, name)] }), { purpose: "artifact" });
  assert.equal(result.tracks[0]!.name, name);
  assert.equal(result.tracks[0]!.notes[0]!.startBeat, 99_999);
  assert.equal(result.tracks[0]!.notes[0]!.durationBeats, 1);
  assert.equal(result.tracks[0]!.durationBeats, 100_000);
});

test("writer bounds match artifact admission and invalid numeric note values fail before serialization", () => {
  const maximum = Array.from({ length: 4096 }, (_, i) => note(i, 1));
  assert.equal(parseMidiArtifact(writeStandardMidi({ durationBeats: 4096, tracks: [track(maximum)] })).notes.length, 4096);
  const thirtyTwo = Array.from({ length: 32 }, () => track());
  assert.equal(parseMidiArtifact(writeStandardMidi({ durationBeats: 1, tracks: thirtyTwo })).trackCount, 32);
  assert.throws(() => writeStandardMidi({ durationBeats: 5000, tracks: [track([...maximum, note(4096)])] }), /4096 notes/);
  for (const tracks of [[], [...thirtyTwo, track()]]) assert.throws(() => writeStandardMidi({ durationBeats: 1, tracks }), /1–32/);
  for (const channel of [0, 17, 1.5]) assert.throws(() => writeStandardMidi({ durationBeats: 1, tracks: [track([note()], channel)] }), /channel/);
  for (const durationBeats of [0, -1, NaN, Infinity, 100_001]) assert.throws(() => writeStandardMidi({ durationBeats, tracks: [track()] }));
  for (const change of [{ pitch: -1 }, { pitch: 128 }, { pitch: 60.5 }, { velocity: 0 }, { velocity: 128 }, { velocity: 90.5 },
    { startTime: -1 }, { startTime: Infinity }, { duration: 0 }, { duration: NaN }]) {
    assert.throws(() => writeStandardMidi({ durationBeats: 4, tracks: [track([{ ...note(), ...change }])] }), /MIDI notes require/);
  }
  assert.throws(() => writeStandardMidi({ durationBeats: 1, tracks: [track([], 1, "字".repeat(1366))] }), /4096 bytes/);
});

test("all-rest tracks remain valid SMF while saved artifact admission rejects an empty composition", () => {
  const bytes = writeStandardMidi({ durationBeats: 4, tracks: [track([], 2, "Rest")] });
  assert.equal(parseStandardMidi(bytes).tracks[0]!.durationBeats, 4);
  assert.throws(() => parseMidiArtifact(bytes), /supported bounded Standard MIDI/);
  const controller = createHostAbortController();
  const reason = new Error("Cancelled MIDI generation"); controller.abort(reason);
  assert.throws(() => writeStandardMidi({ durationBeats: 4, tracks: [track()], signal: controller.signal }), (error) => error === reason);
});
