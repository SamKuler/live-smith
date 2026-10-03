import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { allocateArtifactVersion, isArtifactVersion } from "../../src/agent/artifact-contracts.js";
import { AttachmentProcessingError } from "../../src/attachments/contracts.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import {
  endTrack,
  event,
  midiBytes,
  midiText,
  meta,
  noteTrack,
  sequentialNotes,
} from "../attachments/support/midi-test-helpers.js";
import { createSession } from "../../src/storage/sessions.js";
import {
  deleteSessionMidiArtifacts,
  inspectMidiArtifacts,
  listMidiArtifacts,
  listSessionMidiArtifactDirectoryIds,
  MidiArtifactStorageError,
  parseMidiArtifact,
  readMidiArtifact,
  saveMidiArtifact,
} from "../../src/storage/midi-artifacts.js";

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
    parts: [{ id: "track-0-channel-1", sourceTrackIndex: 0, channel: 1, durationBeats: 1.5,
      notes: [{ pitch: 64, startTime: 0, duration: 1.5, velocity: 111 }] }],
    timing: { tempoEventCount: 0, timeSignatureEventCount: 0 },
  });
});

test("source parts retain stable track/channel identity, names, offsets and track endings", () => {
  const bytes = midiBytes({ tracks: [
    [...meta(0, 0x51, [7, 161, 32]), ...meta(0, 0x58, [3, 2, 24, 8]), ...endTrack(1920)],
    [...midiText(0, 3, "Strings"), ...event(480, 0x90, 60, 90), ...event(0, 0x91, 64, 80),
      ...event(240, 0x80, 60, 0), ...event(240, 0x81, 64, 0), ...endTrack(480)],
    [...midiText(0, 3, "Strings"), ...noteTrack({ channel: 1, pitch: 48 })],
  ] });
  const parsed = parseMidiArtifact(bytes);
  assert.deepEqual(parsed.parts.map(({ notes, ...part }) => ({ ...part, notes })), [
    { id: "track-1-channel-1", sourceTrackIndex: 1, sourceTrackName: "Strings", channel: 1, durationBeats: 3,
      notes: [{ pitch: 60, startTime: 1, duration: 0.5, velocity: 90 }] },
    { id: "track-1-channel-2", sourceTrackIndex: 1, sourceTrackName: "Strings", channel: 2, durationBeats: 3,
      notes: [{ pitch: 64, startTime: 1, duration: 1, velocity: 80 }] },
    { id: "track-2-channel-1", sourceTrackIndex: 2, sourceTrackName: "Strings", channel: 1, durationBeats: 1,
      notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 96 }] },
  ]);
  assert.deepEqual(parsed.timing, { tempoEventCount: 1, timeSignatureEventCount: 1 });
  assert.equal(parsed.durationBeats, 4);
  assert.deepEqual(parseMidiArtifact(bytes), parsed);
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

test("shared MIDI parsing preserves the exact multitrack Live projection and equal-key note-off ordering", () => {
  const bytes = midiBytes({ tracks: [
    endTrack(960),
    [
      ...event(0, 0x90, 60, 80), ...event(0, 0x91, 60, 80),
      ...event(120, 0x81, 60, 0), ...event(360, 0x80, 60, 0),
      ...endTrack(),
    ],
    noteTrack({ pitch: 48, startTicks: 240, durationTicks: 240 }),
  ] });
  const { parts: _parts, timing: _timing, ...projection } = parseMidiArtifact(bytes);
  assert.deepEqual(projection, {
    format: 1, trackCount: 3, ticksPerQuarterNote: 480, durationBeats: 2,
    notes: [
      { pitch: 60, startTime: 0, duration: 0.25, velocity: 80 },
      { pitch: 60, startTime: 0, duration: 1, velocity: 80 },
      { pitch: 48, startTime: 0.5, duration: 0.5, velocity: 96 },
    ],
  });
});

test("artifact parsing keeps strict format/header, track/note/event/duration bounds and error messages", () => {
  assert.equal(parseMidiArtifact(midiBytes({ tracks: [sequentialNotes(4096)] })).notes.length, 4096);
  assert.equal(parseMidiArtifact(midiBytes({ tracks: [noteTrack(), ...Array.from({ length: 31 }, () => endTrack())] })).trackCount, 32);
  assert.equal(parseMidiArtifact(midiFile({ durationTicks: 480 * 100000 })).durationBeats, 100000);
  const eventLimitTrack = Array.from({ length: 199997 }, () => [0, 0xc0, 0]).flat();
  eventLimitTrack.push(...noteTrack());
  assert.equal(parseMidiArtifact(midiBytes({ tracks: [eventLimitTrack] })).notes.length, 1);
  const cases = [
    midiBytes({ format: 2, tracks: [noteTrack()] }),
    midiBytes({ headerExtra: [0], tracks: [noteTrack()] }),
    midiBytes({ tracks: [noteTrack(), ...Array.from({ length: 32 }, () => endTrack())] }),
    midiBytes({ tracks: [sequentialNotes(4097)] }),
    midiFile({ durationTicks: 480 * 100001 }),
    midiBytes({ tracks: [[...eventLimitTrack.slice(0, -4), ...event(0, 0xc0, 0), ...endTrack()]] }),
    midiBytes({ tracks: [endTrack()] }),
    midiBytes({ tracks: [[...event(0, 0x90, 60, 90), ...endTrack(480)]] }),
    midiBytes({ tracks: [noteTrack({ durationTicks: 0 })] }),
  ];
  for (const bytes of cases) {
    assert.throws(() => parseMidiArtifact(bytes), {
      name: "MidiArtifactStorageError",
      message: "MIDI artifact is not a supported bounded Standard MIDI File.",
    });
  }
  for (const bytes of [new Uint8Array(0), new Uint8Array(8 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseMidiArtifact(bytes), {
      name: "MidiArtifactStorageError",
      message: "MIDI artifacts must be valid Standard MIDI Files of at most 8 MiB.",
    });
  }
});

test("artifact parsing preserves cancellation as the original reason", () => {
  for (const reason of [new Error("Cancelled MIDI read"), new AttachmentProcessingError("invalid_midi", "Cancelled")]) {
    const controller = createHostAbortController();
    controller.abort(reason);
    assert.throws(() => parseMidiArtifact(midiFile(), controller.signal), (error) => error === reason);
  }
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

test("MIDI provenance requires exactly one valid Plugin or standalone Connection on write and read", async (t) => {
  const h = await harness(t);
  const common = { serverId: "server", toolName: "transcribe", label: "MIDI", bytes: midiFile(), signal: h.signal };
  const sources = [
    {},
    { pluginId: "valid.plugin", connectionId: "valid-connection" },
    { connectionId: "../invalid" },
  ];
  for (const source of sources) await assert.rejects(saveMidiArtifact(h.directory, h.session.id,
    { ...common, ...source } as Parameters<typeof saveMidiArtifact>[2]), MidiArtifactStorageError);
  const artifact = await saveMidiArtifact(h.directory, h.session.id, { ...common, connectionId: "standalone" });
  assert.equal(Object.hasOwn(artifact, "pluginId"), false);
  const metadata = path.join(h.directory, "live-smith-midi", h.session.id, `${artifact.id}.midi.json`);
  for (const source of sources) {
    const { connectionId: _connection, ...rest } = artifact;
    await fs.writeFile(metadata, JSON.stringify({ ...rest, ...source }));
    await assert.rejects(readMidiArtifact(h.directory, h.session.id, artifact.id), MidiArtifactStorageError);
  }
});

test("incomplete MIDI writes do not poison a Session or hide committed artifacts", async (t) => {
  const h = await harness(t);
  const bytes = midiFile();
  const committed = await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "Committed",
    bytes,
    signal: h.signal,
  });
  const root = path.join(h.directory, "live-smith-midi", h.session.id);
  const incompleteId = "midi_incomplete";
  await fs.writeFile(path.join(root, `${incompleteId}.midi.json`), JSON.stringify({
    ...committed,
    id: incompleteId,
    version: { groupId: incompleteId, number: 1 },
    label: "Interrupted metadata-first save",
  }), { mode: 0o600 });
  await fs.writeFile(path.join(root, "midi_orphan.mid"), bytes, { mode: 0o600 });
  await fs.writeFile(path.join(root, ".midi_orphan.mid.tmp_interrupted"), bytes, { mode: 0o600 });
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), [committed]);
  assert.equal((await inspectMidiArtifacts(h.directory, h.session.id)).unavailableCount, 1);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    `${committed.id}.mid`, `${committed.id}.midi.json`,
    `${incompleteId}.midi.json`, "midi_orphan.mid", ".midi_orphan.mid.tmp_interrupted",
  ].sort());
  const next = await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi",
    serverId: "local",
    toolName: "transcribe",
    label: "After recovery",
    bytes,
    signal: h.signal,
  });
  assert.deepEqual((await listMidiArtifacts(h.directory, h.session.id)).map(({ id }) => id),
    [committed.id, next.id]);
});

test("fresh incomplete MIDI files remain untouched while another process may be writing", async (t) => {
  const h = await harness(t);
  const bytes = midiFile();
  const committed = await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi", serverId: "local", toolName: "transcribe",
    label: "Committed", bytes, signal: h.signal,
  });
  const root = path.join(h.directory, "live-smith-midi", h.session.id);
  const incomplete = "midi_incomplete";
  await fs.writeFile(path.join(root, `${incomplete}.midi.json`), JSON.stringify({ ...committed, id: incomplete, version: { groupId: incomplete, number: 1 } }),
    { mode: 0o600 });
  await fs.writeFile(path.join(root, "midi_orphan.mid"), bytes, { mode: 0o600 });
  await fs.writeFile(path.join(root, ".midi_orphan.mid.tmp_writing"), bytes, { mode: 0o600 });
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), [committed]);
  assert.ok((await fs.readdir(root)).includes(`${incomplete}.midi.json`));
  assert.ok((await fs.readdir(root)).includes("midi_orphan.mid"));
  assert.ok((await fs.readdir(root)).includes(".midi_orphan.mid.tmp_writing"));
});

test("MIDI recovery never follows or removes an orphan symlink target", async (t) => {
  const h = await harness(t);
  const root = path.join(h.directory, "live-smith-midi", h.session.id);
  await saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "audio-to-midi", serverId: "local", toolName: "transcribe",
    label: "Committed", bytes: midiFile(), signal: h.signal,
  });
  const outside = path.join(h.directory, "outside.mid");
  await fs.writeFile(outside, midiFile());
  await fs.symlink(outside, path.join(root, "midi_orphan.mid"));
  await assert.rejects(listMidiArtifacts(h.directory, h.session.id), MidiArtifactStorageError);
  assert.deepEqual(new Uint8Array(await fs.readFile(outside)), midiFile());
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


test("model and host MIDI artifact identities remain distinct from Plugin identities", async (t) => {
  const h = await harness(t);
  const source = { kind: "model" as const, profileId: "profile-main", model: "configured-model" };
  const model = await saveMidiArtifact(h.directory, h.session.id, { source, serverId: "host", toolName: "save_midi_artifact", label: "Next section", bytes: midiFile(), signal: h.signal });
  source.model = "caller mutation";
  assert.deepEqual(model.source, { kind: "model", profileId: "profile-main", model: "configured-model" });
  assert.equal(model.pluginId, undefined); assert.equal(model.connectionId, undefined);
  if (model.source?.kind === "model") model.source.model = "returned mutation";
  const read = await readMidiArtifact(h.directory, h.session.id, model.id, h.signal);
  assert.deepEqual(read.artifact.source, { kind: "model", profileId: "profile-main", model: "configured-model" });
  const host = await saveMidiArtifact(h.directory, h.session.id, { source: { kind: "host", operation: "live-midi-context" }, serverId: "host", toolName: "observe_midi_continuation", label: "Live source", bytes: midiFile(), signal: h.signal });
  assert.deepEqual(host.source, { kind: "host", operation: "live-midi-context" });
  await assert.rejects(saveMidiArtifact(h.directory, h.session.id, { source: { kind: "host", operation: "live-midi-context" }, pluginId: "forged-plugin", serverId: "host", toolName: "save_midi_artifact", label: "Invalid", bytes: midiFile(), signal: h.signal } as never), MidiArtifactStorageError);
  assert.equal((await listMidiArtifacts(h.directory, h.session.id)).length, 2);
});


test("version allocation distinguishes independent siblings from revisions and keeps retry identity", () => {
  const original = { id: "audio-first", version: allocateArtifactVersion("audio-first", []) };
  const sibling = { id: "audio-second", version: allocateArtifactVersion("audio-second", [original], { groupWith: original.id }) };
  const revision = { id: "audio-third", version: allocateArtifactVersion("audio-third", [original, sibling], { revisionOf: original.id }) };
  assert.deepEqual(sibling.version, { groupId: original.id, number: 2 });
  assert.deepEqual(revision.version, { groupId: original.id, number: 3, derivedFromId: original.id });
  const records = [original, sibling, revision];
  assert.deepEqual(allocateArtifactVersion(sibling.id, records, { groupWith: original.id }), sibling.version);
  assert.deepEqual(allocateArtifactVersion("next", records, { revisionOf: sibling.id, groupWith: original.id }),
    { groupId: original.id, number: 4, derivedFromId: sibling.id });
  assert.equal(isArtifactVersion(sibling.version, sibling.id), true);
  assert.throws(() => allocateArtifactVersion("next", records, { revisionOf: "missing" }));
  assert.throws(() => allocateArtifactVersion("next", [...records, { id: "unrelated" }], { revisionOf: sibling.id, groupWith: "unrelated" }));
  const retry = allocateArtifactVersion(sibling.id, records); retry.number = 40;
  assert.equal(sibling.version.number, 2);
});

test("concurrent MIDI siblings reserve unique versions and missing blobs retain allocated numbers", async (t) => {
  const h = await harness(t);
  const save = (options: { revisionOf?: string; groupWith?: string } = {}) => saveMidiArtifact(h.directory, h.session.id, {
    pluginId: "generator", serverId: "local", toolName: "make", label: "Theme", bytes: midiFile(), signal: h.signal, ...options,
  });
  const original = await save();
  const siblings = await Promise.all(Array.from({ length: 4 }, () => save({ groupWith: original.id })));
  assert.deepEqual(siblings.map((artifact) => artifact.version!.number).sort(), [2, 3, 4, 5]);
  assert.ok(siblings.every((artifact) => artifact.version!.groupId === original.id && artifact.version!.derivedFromId === undefined));
  const latest = siblings.find((artifact) => artifact.version!.number === 5)!;
  await fs.rm(path.join(h.directory, "live-smith-midi", h.session.id, `${latest.id}.mid`));
  const revision = await save({ revisionOf: siblings[0]!.id });
  assert.deepEqual(revision.version, { groupId: original.id, number: 6, derivedFromId: siblings[0]!.id });
  assert.equal((await inspectMidiArtifacts(h.directory, h.session.id)).unavailableCount, 1);
  assert.deepEqual((await readMidiArtifact(h.directory, h.session.id, siblings[0]!.id)).artifact.version, siblings[0]!.version);
});
