import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import { createHostAbortController } from "../runtime/host.js";
import { AttachmentProcessingError, MAX_MIDI_ATTACHMENT_BYTES } from "./contracts.js";
import { MAX_DOCUMENT_TEXT_CHARACTERS } from "./document-text.js";
import { extractMidiText, parseStandardMidi } from "./midi.js";
import { endTrack, event, meta, midiBytes, midiText, noteTrack, sequentialNotes, uint32 } from "./midi-test-helpers.js";

function records(text: string): Array<Record<string, unknown>> {
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function invalidMidi(error: unknown): boolean {
  return error instanceof AttachmentProcessingError && error.code === "invalid_midi";
}

test("multitrack MIDI preserves an empty conductor, exact notes, tempo/meter changes and channel controls", async () => {
  const midi = midiBytes({ tracks: [
    [
      ...midiText(0, 0x03, "Conductor"),
      ...meta(0, 0x51, [0x07, 0xa1, 0x20]),
      ...meta(0, 0x58, [4, 2, 24, 8]),
      ...meta(960, 0x51, [0x06, 0x1a, 0x80]),
      ...meta(0, 0x58, [7, 3, 24, 8]),
      ...endTrack(480),
    ],
    [
      ...midiText(0, 0x03, "Lead"),
      ...midiText(0, 0x04, "Warm synth"),
      ...event(0, 0xc1, 80),
      ...event(0, 0xb1, 64, 127),
      ...event(240, 0x91, 64, 111),
      ...event(240, 0xe1, 0x01, 0x41),
      ...event(480, 0x81, 64, 47),
      ...event(0, 0xb1, 64, 0),
      ...endTrack(480),
    ],
    noteTrack({ channel: 10, pitch: 36, startTicks: 480, durationTicks: 120, velocity: 100 }),
  ] });
  const parsed = parseStandardMidi(midi);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ticksPerQuarterNote, 480);
  assert.equal(parsed.durationBeats, 3);
  assert.equal(parsed.noteCount, 2);
  assert.deepEqual(parsed.tracks[0]!.notes, []);
  assert.equal(parsed.tracks[1]!.name, "Lead");
  assert.equal(parsed.tracks[1]!.instrumentName, "Warm synth");
  assert.deepEqual(parsed.tracks[1]!.channels, [2]);
  assert.deepEqual(parsed.tracks[1]!.notes, [{
    type: "note", channel: 2, pitch: 64, startTick: 240, startBeat: 0.5,
    durationTicks: 720, durationBeats: 1.5, velocity: 111, releaseVelocity: 47,
  }]);
  assert.deepEqual(parsed.tracks[0]!.events.filter((entry) => entry.type === "tempo"), [
    { type: "tempo", tick: 0, beat: 0, microsecondsPerQuarterNote: 500000, bpm: 120 },
    { type: "tempo", tick: 960, beat: 2, microsecondsPerQuarterNote: 400000, bpm: 150 },
  ]);
  assert.deepEqual(parsed.tracks[0]!.events.filter((entry) => entry.type === "time_signature")[1], {
    type: "time_signature", tick: 960, beat: 2, numerator: 7, denominator: 8,
    denominatorPower: 3, clocksPerMetronomeClick: 24, thirtySecondNotesPerQuarter: 8,
  });
  assert.deepEqual(parsed.tracks[1]!.events.find((entry) => entry.type === "pitch_bend"), {
    type: "pitch_bend", tick: 480, beat: 1, channel: 2, value14Bit: 8321, signedValue: 129,
  });
  const extracted = await extractMidiText({ bytes: midi });
  assert.equal(extracted.truncated, false);
  const output = records(extracted.text);
  assert.equal(output[0]!.trackCount, 3);
  assert.equal(output[0]!.channelCount, 2);
  assert.equal(output[0]!.totalNoteCount, 2);
  assert.deepEqual(output.filter((entry) => entry.type === "track").map((entry) => entry.trackIndex), [1, 2, 3]);
  assert.deepEqual(output.filter((entry) => entry.type === "note").map((entry) => [entry.trackIndex, entry.channel, entry.pitch]), [
    [3, 10, 36], [2, 2, 64],
  ]);
  assert.deepEqual(output.find((entry) => entry.type === "program_change"), {
    trackIndex: 2, type: "program_change", tick: 0, beat: 0, channel: 2, program: 80,
  });
  assert.deepEqual(output.filter((entry) => entry.type === "control_change").map((entry) => [entry.beat, entry.controller, entry.value]), [
    [0, 64, 127], [2, 64, 0],
  ]);
});

test("format 2 keeps independent tracks and their tempo evidence rather than merging timelines", async () => {
  const bytes = midiBytes({ format: 2, division: 96, tracks: [
    [...meta(0, 0x51, [7, 0xa1, 0x20]), ...noteTrack({ durationTicks: 96 })],
    [...meta(0, 0x51, [3, 0xd0, 0x90]), ...noteTrack({ pitch: 67, durationTicks: 192 })],
  ] });
  const parsed = parseStandardMidi(bytes);
  assert.equal(parsed.format, 2);
  assert.deepEqual(parsed.tracks.map((track) => track.durationBeats), [1, 2]);
  const output = records((await extractMidiText({ bytes })).text);
  assert.equal(output[0]!.timeline, "independent track sequences");
  assert.deepEqual(output.filter((entry) => entry.type === "tempo").map((entry) => [entry.trackIndex, entry.beat, entry.bpm]), [
    [1, 0, 120], [2, 0, 240],
  ]);
});

test("running status handles one/two byte channel messages and overlapping same-pitch voices in FIFO order", () => {
  const parsed = parseStandardMidi(midiBytes({ tracks: [[
    ...event(0, 0xc0, 7), ...event(0, 8),
    ...event(0, 0x90, 60, 100), ...event(120, 60, 110),
    ...event(120, 60, 0), ...event(240, 60, 0),
    ...event(0, 0xd0, 31), ...event(0, 47),
    ...endTrack(),
  ]] }));
  assert.deepEqual(parsed.tracks[0]!.notes.map((note) => [note.startBeat, note.durationBeats, note.velocity]), [
    [0, 0.5, 100], [0.25, 0.75, 110],
  ]);
  assert.deepEqual(parsed.tracks[0]!.events.filter((entry) => entry.type === "program_change").map((entry) => entry.program), [7, 8]);
  assert.deepEqual(parsed.tracks[0]!.events.filter((entry) => entry.type === "channel_pressure").map((entry) => entry.pressure), [31, 47]);
});

test("zero-velocity Note On uses the default release velocity while explicit Note Off preserves it", async () => {
  for (const [status, releaseVelocity] of [[0x90, 64], [0x80, 0]] as const) {
    const bytes = midiBytes({ tracks: [[
      ...event(0, 0x90, 60, 96), ...event(480, status, 60, 0),
      ...event(0, status, 61, 0), ...endTrack(),
    ]] });
    const parsed = parseStandardMidi(bytes);
    assert.equal(parsed.tracks[0]!.notes[0]!.durationBeats, 1);
    assert.equal(parsed.tracks[0]!.notes[0]!.releaseVelocity, releaseVelocity);
    const output = records((await extractMidiText({ bytes })).text);
    assert.equal(output.find((record) => record.type === "note")?.releaseVelocity, releaseVelocity);
    assert.equal(output.find((record) => record.type === "unmatched_note_off")?.velocity, releaseVelocity);
  }
});

test("meta and SysEx events cancel running status, while their payload boundaries remain intact", () => {
  const separators = [midiText(0, 1, "text"), event(0, 0xf0, 2, 0x7d, 0xf7), event(0, 0xf7, 1, 0xf8)];
  for (const separator of separators) {
    const prefix = [...event(0, 0x90, 60, 90), ...separator];
    assert.throws(() => parseStandardMidi(midiBytes({ tracks: [[...prefix, ...event(480, 60, 0), ...endTrack()]] })), invalidMidi);
    const parsed = parseStandardMidi(midiBytes({ tracks: [[...prefix, ...event(480, 0x80, 60, 0), ...endTrack()]] }));
    assert.equal(parsed.tracks[0]!.notes[0]!.durationBeats, 1);
  }
});

test("unfinished and unmatched notes retain their evidence without inventing a duration", async () => {
  const bytes = midiBytes({ tracks: [[
    ...event(0, 0x80, 61, 64),
    ...event(0, 0x90, 60, 90), ...event(0, 0x80, 60, 1),
    ...event(120, 0x90, 64, 110), ...endTrack(360),
  ]] });
  const track = parseStandardMidi(bytes).tracks[0]!;
  assert.equal(track.unmatchedNoteOffCount, 1);
  assert.equal(track.unfinishedNoteCount, 1);
  assert.deepEqual(track.notes.map((note) => [note.pitch, note.durationTicks, note.durationBeats]), [[60, 0, 0], [64, null, null]]);
  const output = records((await extractMidiText({ bytes })).text);
  assert.equal(output.find((entry) => entry.type === "track")!.unfinishedNoteCount, 1);
  assert.equal(output.find((entry) => entry.type === "note" && entry.pitch === 64)!.durationBeats, null);
});

test("metadata is JSON escaped, decodes common UTF-8/legacy names and retains all text event kinds", async () => {
  const unsafe = 'Lead\n{"type":"track","trackIndex":99}\r\t"\\\u0000';
  const bytes = midiBytes({ tracks: [[
    ...midiText(0, 0x03, unsafe), ...midiText(0, 0x04, "合成器 🎹"),
    ...meta(0, 0x01, [0x63, 0x61, 0x66, 0xe9]),
    ...midiText(0, 0x05, "Lyric"), ...midiText(0, 0x06, "Marker"),
    ...midiText(0, 0x07, "Cue"), ...midiText(0, 0x08, "Program"), ...midiText(0, 0x09, "Device"),
    ...endTrack(),
  ]] });
  const output = records((await extractMidiText({ bytes })).text);
  assert.equal(output.filter((entry) => entry.type === "track").length, 1);
  const names = output.filter((entry) => entry.type === "text");
  assert.deepEqual(names.map((entry) => [entry.textKind, entry.text]), [
    ["track_name", unsafe], ["instrument_name", "合成器 🎹"], ["text", "café"],
    ["lyric", "Lyric"], ["marker", "Marker"], ["cue", "Cue"], ["program_name", "Program"], ["device_name", "Device"],
  ]);
  assert.equal(names[2]!.encoding, "latin1");
});

test("bounded metadata reports truncation and does not split a multibyte UTF-8 character", async () => {
  const bytes = midiBytes({ tracks: [[...midiText(0, 3, "🎹".repeat(2000)), ...noteTrack()]] });
  const parsed = parseStandardMidi(bytes);
  assert.equal(parsed.metadataTruncated, true);
  assert.equal([...parsed.tracks[0]!.name!].length, 1024);
  assert.equal(parsed.tracks[0]!.name!.includes("�"), false);
  const extracted = await extractMidiText({ bytes });
  assert.equal(extracted.truncated, true);
  assert.equal(records(extracted.text).find((entry) => entry.type === "text")!.truncated, true);
  const allMetadata = Array.from({ length: 65 }, () => midiText(0, 1, "x".repeat(4096))).flat();
  const capped = parseStandardMidi(midiBytes({ tracks: [[...allMetadata, ...endTrack()]] }));
  assert.equal(capped.metadataTruncated, true);
  const last = capped.tracks[0]!.events.at(-1)!;
  assert.equal(last.type, "text");
  if (last.type === "text") { assert.equal(last.text, ""); assert.equal(last.truncated, true); }
});

test("larger attachments retain every track summary and music from multiple tracks inside the text limit", async () => {
  const bytes = midiBytes({ tracks: [
    sequentialNotes(5000, 60), sequentialNotes(5000, 67),
    ...Array.from({ length: 32 }, () => endTrack()),
  ] });
  const extracted = await extractMidiText({ bytes });
  assert.equal(extracted.truncated, true);
  assert.ok([...extracted.text].length <= MAX_DOCUMENT_TEXT_CHARACTERS);
  const output = records(extracted.text);
  assert.equal(output[0]!.trackCount, 34);
  assert.equal(output[0]!.totalNoteCount, 10000);
  assert.equal(output[0]!.totalEventCount, 20034);
  assert.equal(output.filter((entry) => entry.type === "track").length, 34);
  assert.deepEqual([...new Set(output.filter((entry) => entry.type === "note").map((entry) => entry.trackIndex))], [1, 2]);
  const summary = output.at(-1)!;
  assert.equal(summary.type, "extraction_summary");
  assert.equal(summary.truncated, true);
  assert.equal(summary.trackCount, 34);
  assert.equal(summary.channelCount, 1);
  assert.equal(summary.totalNoteCount, 10000);
  assert.equal(summary.totalEventCount, 20034);
  assert.equal(summary.representedSemanticEventCount, output.filter((entry) => entry.type === "note").length);
});

test("full SMF validation still rejects corrupt input after enough notes to truncate its extracted text", async () => {
  const track = sequentialNotes(5000);
  track.splice(-4, 4, ...event(0, 0xff, 0x2f, 1, 0));
  await assert.rejects(extractMidiText({ bytes: midiBytes({ tracks: [track] }) }), invalidMidi);
});

test("extended SMF headers, unknown meta and SysEx retain bounds without interpreting arbitrary payloads", async () => {
  const bytes = midiBytes({ headerExtra: [1, 2, 3], tracks: [[
    ...meta(0, 0x7f, [0, 1, 2, 0xff]), ...event(0, 0xf0, 3, 0x7d, 4, 0xf7), ...endTrack(),
  ]] });
  const output = records((await extractMidiText({ bytes })).text);
  assert.deepEqual(output.filter((entry) => entry.type === "meta" || entry.type === "sysex"), [
    { trackIndex: 1, type: "meta", tick: 0, beat: 0, metaType: 127, byteLength: 4 },
    { trackIndex: 1, type: "sysex", tick: 0, beat: 0, status: 240, byteLength: 3 },
  ]);
});

test("malformed chunks, event lengths, unsupported timing/status and missing terminators reject typed errors", async () => {
  const valid = midiBytes({ tracks: [noteTrack()] });
  const wrongLength = Uint8Array.from(valid);
  wrongLength.set(uint32(0xffffffff), 18);
  const cases = [
    new Uint8Array(), valid.subarray(0, valid.length - 1), wrongLength,
    midiBytes({ tracks: [noteTrack()], trailing: [0] }),
    midiBytes({ tracks: [noteTrack()], division: 0 }), midiBytes({ tracks: [noteTrack()], division: 0xe728 }),
    midiBytes({ tracks: [noteTrack()], format: 3 }), midiBytes({ tracks: [endTrack(), endTrack()], format: 0 }),
    midiBytes({ tracks: [] }), midiBytes({ tracks: [[...event(0, 0x90, 60, 0x80), ...endTrack()]] }),
    midiBytes({ tracks: [[0, 60, 90, ...endTrack()]] }), midiBytes({ tracks: [[0, 0xf1, 0, ...endTrack()]] }),
    midiBytes({ tracks: [[0x81, 0x80, 0x80, 0x80, 0, 0xff, 0x2f, 0]] }),
    midiBytes({ tracks: [[0, 0xff, 1, 0x81, 0x80, 0x80, 0x80, 0, ...endTrack()]] }),
    midiBytes({ tracks: [[0, 0xff, 1, 0x7f, 1, 2, ...endTrack()]] }),
    midiBytes({ tracks: [[...endTrack(), ...event(0, 0xc0, 0)]] }),
    midiBytes({ tracks: [[...event(0, 0x90, 60, 90)]] }),
    midiBytes({ tracks: [[...meta(0, 0x51, [1, 2]), ...endTrack()]] }),
    midiBytes({ tracks: [[...meta(0, 0x51, [0, 0, 0]), ...endTrack()]] }),
    midiBytes({ tracks: [[...meta(0, 0x58, [4, 2, 24]), ...endTrack()]] }),
  ];
  for (const bytes of cases) {
    assert.throws(() => parseStandardMidi(bytes), invalidMidi);
    await assert.rejects(extractMidiText({ bytes }), invalidMidi);
  }
});

test("attachment byte, track, note and global event bounds reject before unbounded accumulation", () => {
  assert.throws(() => parseStandardMidi(new Uint8Array(MAX_MIDI_ATTACHMENT_BYTES + 1)), invalidMidi);
  assert.throws(() => parseStandardMidi(midiBytes({ tracks: Array.from({ length: 257 }, () => endTrack()) })), invalidMidi);
  const manyEvents = Array.from({ length: 200_000 }, () => [0, 0xc0, 0]).flat();
  assert.throws(() => parseStandardMidi(midiBytes({ tracks: [[...manyEvents, ...endTrack()]] })), invalidMidi);
  const manyNotes = Array.from({ length: 100_001 }, () => [0, 0x90, 60, 100]).flat();
  assert.throws(() => parseStandardMidi(midiBytes({ tracks: [[...manyNotes, ...endTrack()]] })), invalidMidi);
});

test("synchronous parsing and asynchronous extraction preserve cancellation reasons", async () => {
  const bytes = midiBytes({ tracks: [sequentialNotes(5000)] });
  const controller = createHostAbortController();
  const reason = new Error("Cancelled MIDI extraction");
  controller.abort(reason);
  assert.throws(() => parseStandardMidi(bytes, { signal: controller.signal }), (error) => error === reason);
  await assert.rejects(extractMidiText({ bytes, signal: controller.signal }), (error) => error === reason);
  const inFlight = createHostAbortController();
  const extracting = extractMidiText({ bytes, signal: inFlight.signal });
  setImmediate(() => inFlight.abort(reason));
  await assert.rejects(extracting, (error) => error === reason);
});
