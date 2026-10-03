import assert from "node:assert/strict";
import test from "node:test";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { saveMidiArtifact, saveMidiContinuation, readMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { midiContinuationImportHooks } from "../../../src/app/midi/midi-continuation-command.js";
import { assertMidiContinuationOutput, configureMidiContinuation } from "../../../src/app/midi/midi-continuation.js";
import { importMidiArtifact } from "../../../src/app/midi-artifact-import.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { continuationHarness } from "./support/continuation-harness.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { endTrack, event, midiBytes } from "../../attachments/support/midi-test-helpers.js";

for (const decision of ["cancel", "changed", "apply"] as const) test(`continuation import ${decision} keeps source guard and buffer consumption at the Live boundary`, async (t) => {
  const h = await continuationHarness(t);
  const artifact = await saveMidiArtifact(h.directory, h.session.id, { source: { kind: "model", profileId: h.profile.id, model: h.profile.defaultModel }, generationKind: "continuation",
    serverId: "host", toolName: "save_midi_artifact", label: "Next Bass", signal: h.signal,
    bytes: writeStandardMidi({ durationBeats: 8, tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 50, startTime: 0, duration: 4, velocity: 100 }] }] }) });
  await saveMidiContinuation(h.directory, h.session.id, { ...h.buffer, nextSequence: 1, lastArtifactRef: artifact.id,
    queue: [{ artifactRef: artifact.id, sequence: 0, label: artifact.label, noteCount: 1 }] }, h.signal);
  let writes = 0;
  Object.defineProperty(h.tracks[0], "createMidiClip", { value: async () => { writes++; return { name: "New", notes: [] }; } });
  const command = { sessionId: h.session.id, artifactRef: artifact.id, bufferId: h.buffer.id, trackId: "1", trackName: "Bass", startBeat: 8 };
  const hooks = await midiContinuationImportHooks(command, h);
  const run = () => importMidiArtifact({ kind: "import_midi_artifact", ...command, ...hooks,
    context: h.context, storageDirectory: h.directory, projectKey: h.projectKey, signal: h.signal, mutationQueue: new LiveMutationQueue(),
    interaction: { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Live Set", scope: h.session.scope, target: {} },
    confirm: async () => { if (decision === "changed") h.clips[0]!.notes[0]!.pitch = 51; return { confirmed: decision !== "cancel", source: "user" }; },
  });
  if (decision === "changed") await assert.rejects(run(), /changed/);
  else assert.equal(await run(), decision === "apply");
  assert.equal(writes, decision === "apply" ? 1 : 0);
  assert.equal((await readMidiContinuation(h.directory, h.session.id))!.queue.length, decision === "apply" ? 0 : 1);
});

for (const selection of ["merged", "long-part", "adjacent-part"] as const) test(`continuation source protection checks actual ${selection} import timing`, async (t) => {
  const h = await continuationHarness(t);
  Object.assign(h.clips[0]!, { startTime: 8, endTime: 16 });
  Object.defineProperty(h.clips[0]!, "color", { value: 0 });
  const buffer = await configureMidiContinuation({ ...h, expectedBufferId: h.buffer.id,
    sourceClips: [h.buffer.sourceClips[0]!], segmentBeats: 8, capacity: 2, generator: h.buffer.generator, prompt: "" });
  const bytes = midiBytes({ tracks: [1, 0].map((extraTick) => [
    ...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0), ...endTrack(3360 + extraTick),
  ]) });
  assertMidiContinuationOutput(bytes, 8, h.signal);
  const artifact = await saveMidiArtifact(h.directory, h.sessionId, {
    connectionId: "generator", serverId: "server", toolName: "generator", label: "Next section", generationKind: "continuation",
    bytes, signal: h.signal,
  });
  await saveMidiContinuation(h.directory, h.sessionId, { ...buffer, nextSequence: 1, lastArtifactRef: artifact.id,
    queue: [{ artifactRef: artifact.id, sequence: 0, label: artifact.label, noteCount: 2 }] }, h.signal);
  const positions: number[][] = [];
  Object.defineProperty(h.tracks[0]!, "createMidiClip", { value: async (start: number, duration: number) => {
    positions.push([start, duration]); return { name: "New", notes: [] };
  } });
  const command = { sessionId: h.sessionId, bufferId: buffer.id, artifactRef: artifact.id, startBeat: 0,
    ...(selection === "merged" ? { trackId: "1", trackName: "Bass", mergeParts: true }
      : { mappings: [{ trackId: "1", trackName: "Bass", partId: `track-${selection === "long-part" ? 0 : 1}-channel-1` }] }),
  };
  const hooks = await midiContinuationImportHooks(command, h);
  let confirmations = 0;
  const run = () => importMidiArtifact({ kind: "import_midi_artifact", ...command, ...hooks,
    context: h.context, storageDirectory: h.directory, projectKey: h.projectKey, signal: h.signal, mutationQueue: new LiveMutationQueue(),
    interaction: { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Live Set", scope: h.session.scope, target: {} },
    confirm: async () => { confirmations++; return { confirmed: true, source: "user" }; },
  });
  if (selection === "adjacent-part") {
    assert.equal(await run(), true);
    assert.equal(confirmations, 1);
    assert.deepEqual(positions, [[0, 8]], "the selected short part remains exactly adjacent to its source");
  } else {
    await assert.rejects(run(), /outside its source clips/);
    assert.equal(confirmations, 0);
    assert.deepEqual(positions, [], "the extra tick must not overwrite the observed source");
  }
  assert.equal((await readMidiContinuation(h.directory, h.sessionId))!.queue.length, selection === "adjacent-part" ? 0 : 1);
});


for (const destination of ["new", "mixed"] as const) test(`continuation ${destination} import protects source handles through creator and existing refs`, async (t) => {
  const h = await continuationHarness(t);
  const artifact = await saveMidiArtifact(h.directory, h.session.id, {
    source: { kind: "model", profileId: h.profile.id, model: h.profile.defaultModel }, generationKind: "continuation",
    serverId: "host", toolName: "save_midi_artifact", label: "Next section", signal: h.signal,
    bytes: writeStandardMidi({ durationBeats: 8, tracks: [50, 74].map((pitch, index) => ({
      name: `Part ${index + 1}`, channel: index + 1, notes: [{ pitch, startTime: 0, duration: 4, velocity: 100 }],
    })) }),
  });
  await saveMidiContinuation(h.directory, h.session.id, { ...h.buffer, nextSequence: 1, lastArtifactRef: artifact.id,
    queue: [{ artifactRef: artifact.id, sequence: 0, label: artifact.label, noteCount: 2 }] }, h.signal);
  const written: { destination: string; notes: { pitch: number }[] }[] = [];
  const clip = (destination: string) => {
    const result = { destination, name: "New", notes: [] };
    written.push(result); return result;
  };
  Object.defineProperty(h.tracks[1], "createMidiClip", { value: async () => clip("existing") });
  let createdCount = 0;
  Object.defineProperty(h.song, "createMidiTrack", { value: async () => {
    createdCount++;
    const track = Object.defineProperties(Object.create(h.tracks[1]!), {
      handle: { value: { id: 3n } }, name: { value: "MIDI", writable: true }, arrangementClips: { value: [] },
      createMidiClip: { value: async () => clip("new") },
    });
    h.song.tracks.push(track); return track;
  } });
  const command = { sessionId: h.session.id, artifactRef: artifact.id, bufferId: h.buffer.id,
    startBeat: destination === "new" ? 0 : 8,
    ...(destination === "new" ? { createTrack: true, trackName: "Lead", mergeParts: true } : { mappings: [
      { partId: "track-0-channel-1", createTrack: true as const, trackName: "Lead" },
      { partId: "track-1-channel-2", trackId: "2", trackName: "Lead" },
    ] }),
  };
  const hooks = await midiContinuationImportHooks(command, h);
  assert.equal(await importMidiArtifact({ kind: "import_midi_artifact", ...command, ...hooks,
    context: h.context, storageDirectory: h.directory, projectKey: h.projectKey, signal: h.signal, mutationQueue: new LiveMutationQueue(),
    interaction: { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Live Set", scope: h.session.scope, target: {} },
    confirm: async () => ({ confirmed: true, source: "user" }),
  }), true);
  assert.equal(createdCount, 1);
  assert.deepEqual(written.map((entry) => ({ destination: entry.destination, pitches: entry.notes.map((note) => note.pitch) })),
    destination === "new" ? [{ destination: "new", pitches: [50, 74] }] : [
      { destination: "new", pitches: [50] }, { destination: "existing", pitches: [74] },
    ]);
  assert.deepEqual(h.clips.map((clip) => clip.notes[0]!.pitch), [48, 72]);
  assert.equal((await readMidiContinuation(h.directory, h.session.id))!.queue.length, 0);
});
