import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { createHostAbortController } from "../runtime/host.js";
import { createSession } from "./sessions.js";
import {
  deleteSessionMidiArtifacts,
  listMidiArtifacts,
  listSessionMidiArtifactDirectoryIds,
  MidiArtifactStorageError,
  parseMidiArtifact,
  readMidiArtifact,
  saveMidiArtifact,
} from "./midi-artifacts.js";

function midiFile(options: {
  pitch?: number;
  velocity?: number;
  durationTicks?: number;
  division?: number;
  trailing?: readonly number[];
} = {}): Uint8Array {
  const pitch = options.pitch ?? 60;
  const velocity = options.velocity ?? 96;
  const division = options.division ?? 480;
  const track = new Uint8Array([
    0x00, 0x90, pitch, velocity,
    ...variableLength(options.durationTicks ?? 480), 0x80, pitch, 0x40,
    0x00, 0xff, 0x2f, 0x00,
  ]);
  return new Uint8Array([
    ...ascii("MThd"), ...uint32(6), 0x00, 0x00, 0x00, 0x01,
    division >> 8, division & 0xff,
    ...ascii("MTrk"), ...uint32(track.byteLength), ...track,
    ...(options.trailing ?? []),
  ]);
}

function ascii(value: string): number[] { return [...value].map((character) => character.charCodeAt(0)); }
function uint32(value: number): number[] { return [value >>> 24, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff]; }
function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining; remaining >>>= 7) bytes.unshift((remaining & 0x7f) | 0x80);
  return bytes;
}

async function harness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-artifacts-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "MIDI artifacts",
    projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "MIDI" },
  });
  const signal = createHostAbortController().signal;
  return { directory, session, signal };
}

test("bounded Standard MIDI parsing produces the exact Live note contract", () => {
  assert.deepEqual(parseMidiArtifact(midiFile({ pitch: 64, velocity: 111, durationTicks: 720 })), {
    format: 0,
    trackCount: 1,
    ticksPerQuarterNote: 480,
    durationBeats: 1.5,
    notes: [{ pitch: 64, startTime: 0, duration: 1.5, velocity: 111 }],
  });
});

test("MIDI parser rejects malformed chunks, unsupported timing, unfinished notes and trailing bytes", () => {
  const valid = midiFile();
  const cases = [
    valid.subarray(0, valid.byteLength - 1),
    midiFile({ division: 0 }),
    midiFile({ division: 0xe728 }),
    midiFile({ trailing: [0] }),
    new Uint8Array(valid.map((byte, index) => index === 0 ? 0 : byte)),
    new Uint8Array(valid.map((byte, index) => index === 28 ? 0x90 : byte)),
  ];
  for (const bytes of cases) assert.throws(() => parseMidiArtifact(bytes), MidiArtifactStorageError);
});

test("MIDI artifacts persist immutable ownership and parse again on every read", async (t) => {
  const h = await harness(t);
  const bytes = midiFile();
  const saved = await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Lead transcription",
    bytes,
    signal: h.signal,
  });
  assert.equal(saved.noteCount, 1);
  assert.equal(saved.durationBeats, 1);
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), [saved]);
  const read = await readMidiArtifact(h.directory, h.session.id, saved.id, h.signal);
  assert.deepEqual(read.bytes, bytes);
  assert.deepEqual(read.parsed.notes, [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }]);
  assert.deepEqual(await listSessionMidiArtifactDirectoryIds(h.directory), [h.session.id]);
  await deleteSessionMidiArtifacts(h.directory, h.session.id);
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), []);
  assert.deepEqual(await listSessionMidiArtifactDirectoryIds(h.directory), []);
});

test("MIDI artifact reads reject cross-Session IDs, tampered bytes and symlinks", async (t) => {
  const h = await harness(t);
  const other = await createSession(h.directory, {
    title: "Other",
    projectKey: "project",
    scope: { kind: "selection", identity: "other", label: "Other" },
  });
  const saved = await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Transcription",
    bytes: midiFile(),
    signal: h.signal,
  });
  await assert.rejects(readMidiArtifact(h.directory, other.id, saved.id), MidiArtifactStorageError);
  const blob = path.join(h.directory, "live-smith-midi", h.session.id, `${saved.id}.mid`);
  await fs.writeFile(blob, midiFile({ pitch: 61 }));
  await assert.rejects(readMidiArtifact(h.directory, h.session.id, saved.id), MidiArtifactStorageError);
  await fs.rm(blob);
  await fs.symlink("/dev/null", blob);
  await assert.rejects(readMidiArtifact(h.directory, h.session.id, saved.id), MidiArtifactStorageError);
});

test("invalid Plugin output never creates a MIDI artifact directory", async (t) => {
  const h = await harness(t);
  await assert.rejects(saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Invalid",
    bytes: new Uint8Array([1, 2, 3]),
    signal: h.signal,
  }), MidiArtifactStorageError);
  assert.deepEqual(await listSessionMidiArtifactDirectoryIds(h.directory), []);
});
