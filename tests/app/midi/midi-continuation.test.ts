import assert from "node:assert/strict";
import test from "node:test";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { fillMidiContinuation, consumeMidiContinuation, assertMidiContinuationSource } from "../../../src/app/midi/midi-continuation.js";
import { generateMidiContinuationWithModel } from "../../../src/app/midi/midi-continuation-model.js";
import { readMidiContinuation, saveMidiArtifact, readMidiArtifact, listMidiArtifacts } from "../../../src/storage/midi-artifacts.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { createSessionMidiArtifactToolset } from "../../../src/app/midi/midi-artifact-tools.js";
import { artifactGenerationsFromEvents, listSessionArtifacts } from "../../../src/app/session/session-artifacts.js";
import { captureMidiContinuationContext } from "../../../src/app/midi/midi-continuation-context.js";
import { continuationHarness } from "./support/continuation-harness.js";

const tracks = (pitch: number) => [{ name: "Bass", channel: 1, notes: [{ pitch, startTime: 0, duration: 4, velocity: 90 }] },
  { name: "Lead", channel: 2, notes: [{ pitch: pitch + 24, startTime: 1, duration: 2, velocity: 100 }] }];

test("Fill creates ordered sections, consumes only the applied head and refills only vacant slots", async (t) => {
  const h = await continuationHarness(t); const parents: (string | undefined)[] = [];
  const fill = () => fillMidiContinuation({ ...h, bufferId: h.buffer.id, validateGenerator: async () => {}, onProgress: async () => {},
    generate: async (buffer, record) => {
      parents.push(buffer.queue.at(-1)?.artifactRef ?? buffer.lastArtifactRef);
      await record({ kind: "tool_call", name: "save_midi_artifact", content: JSON.stringify({ sequence: buffer.nextSequence }) });
      const artifact = await saveMidiArtifact(h.directory, h.session.id, { source: { kind: "model", profileId: h.profile.id, model: h.profile.defaultModel },
        generationKind: "continuation", serverId: "host", toolName: "save_midi_artifact", label: `Section ${buffer.nextSequence + 1}`,
        bytes: writeStandardMidi({ tracks: tracks(48 + buffer.nextSequence), durationBeats: buffer.segmentBeats }), signal: h.signal });
      await record({ kind: "tool_result", name: "save_midi_artifact", content: JSON.stringify({ artifacts: [{ kind: "midi", artifactRef: artifact.id }] }) });
      return artifact;
    } });
  const first = await fill(); assert.equal(first.queue.length, 2); assert.equal(parents[0], undefined); assert.equal(parents[1], first.queue[0]!.artifactRef);
  await fill(); assert.equal(parents.length, 2, "full buffers must not make generator calls");
  await assert.rejects(consumeMidiContinuation({ ...h, bufferId: h.buffer.id, artifactRef: first.queue[1]!.artifactRef, startBeat: 8 }), /head changed/);
  assert.deepEqual((await readMidiContinuation(h.directory, h.session.id))!.queue, first.queue);
  await consumeMidiContinuation({ ...h, bufferId: h.buffer.id, artifactRef: first.queue[0]!.artifactRef, startBeat: 16 });
  const refilled = await fill(); assert.equal(parents.length, 3); assert.equal(parents[2], first.queue[1]!.artifactRef);
  assert.deepEqual(refilled.queue.map((item) => item.sequence), [1, 2]); assert.equal(refilled.consumedCount, 1);
  assert.equal(refilled.insertBeat + refilled.queue[0]!.sequence * refilled.segmentBeats, 24);
  const events = await loadSessionEvents(h.directory, h.session.id);
  assert.equal(events.some((event) => event.kind === "user"), false, "Fill must not consume an unrelated next-chat source");
  const generations = artifactGenerationsFromEvents(events);
  assert.equal(generations.get(`midi:${refilled.queue[1]!.artifactRef}`)?.parent?.id, first.queue[1]!.artifactRef);
  assert.equal((await readMidiArtifact(h.directory, h.session.id, first.queue[0]!.artifactRef)).artifact.generationKind, "continuation");
  const candidates = await listSessionArtifacts(h);
  assert.equal(candidates.total, 3, "internal conditioning snapshots are not generated candidates");
  for (const candidate of candidates.artifacts) {
    assert.equal(candidate.version!.number, 1, "future sections start independent revision groups");
    assert.equal(candidate.version!.groupId, candidate.ref.id);
  }
});

test("source fingerprint ignores selection and unrelated new clips but rejects musical/timing changes", async (t) => {
  const h = await continuationHarness(t);
  const snapshot = () => captureMidiContinuationContext(h.context, h.buffer.sourceClips).fingerprint;
  const before = snapshot(); (h.clips[0]!.notes[0] as { selected?: boolean }).selected = true;
  h.tracks[0]!.arrangementClips.push(h.clips[1]!);
  assert.equal(snapshot(), before);
  h.clips[0]!.notes[0]!.pitch = 50;
  assert.throws(() => assertMidiContinuationSource(h.context, h.buffer, h.signal), /changed/);
});

test("restricted current-model generation saves actual multitrack bytes and consumes the saved creative brief", async (t) => {
  const h = await continuationHarness(t); let turns = 0;
  const readTools = createSessionMidiArtifactToolset({ storageDirectory: h.directory, sessionId: h.session.id, signal: h.signal });
  const artifact = await generateMidiContinuationWithModel({ storageDirectory: h.directory, buffer: h.buffer, runtimeProfile: h.runtime,
    readTools, signal: h.signal, creativeBrief: h.session.creativeBrief!, beforeSave: async () => {}, beforeCommit: () => assertMidiContinuationSource(h.context, h.buffer, h.signal),
    onEvent: async () => {}, onProgress: async () => {}, requestTurn: async (input) => {
      turns++; assert.equal(input.creativeBrief, h.session.creativeBrief);
      assert.deepEqual(input.tools.map((tool) => tool.type === "function" ? tool.function.name : tool.type), ["list_session_artifacts", "inspect_midi_artifact", "save_midi_artifact"]);
      return turns === 1 ? { content: null, toolCalls: [{ id: "forged", name: "apply_live_actions", arguments: "{}" }] }
        : { content: null, toolCalls: [{ id: "notes", name: "save_midi_artifact", arguments: JSON.stringify({ label: "Next part", tracks: tracks(48) }) }] };
    } });
  assert.equal(turns, 2); assert.equal(artifact.source?.kind, "model"); assert.equal(artifact.generationKind, "continuation");
  const parsed = (await readMidiArtifact(h.directory, h.session.id, artifact.id)).parsed;
  assert.equal(parsed.durationBeats, 8); assert.deepEqual(parsed.parts.map((part) => part.sourceTrackName), ["Bass", "Lead"]);
});

test("failed or obsolete generation preserves already saved material without publishing a new buffer entry", async (t) => {
  const h = await continuationHarness(t);
  const initialArtifacts = await listMidiArtifacts(h.directory, h.session.id);
  await assert.rejects(fillMidiContinuation({ ...h, bufferId: h.buffer.id, validateGenerator: async () => {}, onProgress: async () => {},
    generate: async () => { h.song.tempo = 130; throw new Error("Generator failed"); } }), /Generator failed/);
  assert.deepEqual((await readMidiContinuation(h.directory, h.session.id))!.queue, []);
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), initialArtifacts);
  await assert.rejects(fillMidiContinuation({ ...h, bufferId: h.buffer.id, validateGenerator: async () => {}, onProgress: async () => {},
    generate: async () => assert.fail("stale sources must not call a generator") }), /changed/);
});

test("captured MIDI bytes expand loop occurrences and normalize nonzero Clip markers", async (t) => {
  const h = await continuationHarness(t);
  Object.assign(h.clips[0]!, { looping: true, loopStart: 0, loopEnd: 4, duration: 8, endTime: 8 });
  let snapshot = captureMidiContinuationContext(h.context, [h.buffer.sourceClips[0]!]);
  let parsed = (await import("../../../src/storage/midi-artifacts.js")).parseMidiArtifact(writeStandardMidi(snapshot));
  assert.equal(parsed.durationBeats, 8); assert.deepEqual(parsed.notes.map((note) => note.startTime), [0, 4]);
  Object.assign(h.clips[0]!, { looping: false, startMarker: 4, endMarker: 8, loopStart: 4, loopEnd: 8,
    duration: 4, endTime: 4, notes: [{ pitch: 48, startTime: 4, duration: 1, velocity: 100 }] });
  snapshot = captureMidiContinuationContext(h.context, [h.buffer.sourceClips[0]!]);
  parsed = (await import("../../../src/storage/midi-artifacts.js")).parseMidiArtifact(writeStandardMidi(snapshot));
  assert.equal(parsed.durationBeats, 4); assert.equal(parsed.notes[0]!.startTime, 0);
});
