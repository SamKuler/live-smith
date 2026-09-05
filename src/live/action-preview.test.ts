import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAction } from "../agent/actions.js";
import { executeAgentPlanWithProgress } from "./executor.js";
import { captureLiveActionPreflightObservation, captureLiveActionPreflightSnapshot } from "./preflight.js";
import { midiPreviewFixture, parameterPreviewFixture } from "./action-preview.test-harness.js";

const original = [{
  pitch: 60, startTime: 1.1, duration: 0.5, velocity: 80, muted: true,
  probability: 0.4, velocityDeviation: 3, releaseVelocity: 64, selected: true,
}, { pitch: 72, startTime: 5, duration: 1 }];
const musicalNotes = original.map(({ selected: _selected, ...note }) => note);

for (const operation of [
  { type: "transpose_midi_notes", semitones: 7 },
  { type: "quantize_midi_notes", gridBeats: 0.5, strength: 0.5 },
  { type: "scale_midi_velocity", factor: 1.2 },
  { type: "shift_midi_notes", offsetBeats: 0.25 },
] as const) {
  test(`${operation.type} previews the exact executed notes from one initial Clip read`, async () => {
    const fixture = midiPreviewFixture(original, true);
    const action: AgentAction = { ...operation, slotIndex: 0 };
    const observation = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
    assert.equal(fixture.noteReads, 1);
    assert.equal(fixture.writes, 0);
    const preview = observation.preview;
    assert.equal(preview?.kind, "midi-notes");
    assert.deepEqual(preview.range, { coordinate: "clip-beats", start: 0, end: 8 });
    assert.deepEqual(preview.before.notes, musicalNotes);
    assert.equal(preview.before.omittedNoteCount, 0);
    assert.equal(JSON.stringify(preview).includes("handle"), false);
    const result = await executeAgentPlanWithProgress(fixture.context, { message: "Edit", actions: [action] }, { track: fixture.track });
    assert.equal(result.mutationCount, 1);
    assert.deepEqual(fixture.notes.map(({ selected: _selected, ...note }) => note), preview.after.notes);
    assert.equal(fixture.notes[0]!.selected, true);
    assert.equal(await captureLiveActionPreflightSnapshot(fixture.context, action, { track: fixture.track }) === observation.fingerprint, false);
  });
}

test("segment previews include preserved notes and match execution including no-op tolerance", async () => {
  const fixture = midiPreviewFixture(original);
  const action: AgentAction = {
    type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32,
    segmentStartTime: 1, segmentDurationBeats: 1,
    notes: [{ pitch: 65, startTime: 1.5, duration: 0.5, velocity: 100 }],
  };
  const observation = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(observation.preview?.kind, "midi-notes");
  await executeAgentPlanWithProgress(fixture.context, { message: "Replace", actions: [action] }, { track: fixture.track });
  assert.deepEqual(fixture.notes, observation.preview.after.notes);
  assert.deepEqual(fixture.notes[1], original[1]);
});

test("bounded previews declare all omitted notes while the fingerprint still covers them", async () => {
  const fixture = midiPreviewFixture(Array.from({ length: 300 }, () => ({ pitch: 60, startTime: 0, duration: 1 })));
  const action: AgentAction = { type: "transpose_midi_notes", startBeat: 32, clipName: "Phrase", semitones: 1 };
  const before = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(before.preview?.kind, "midi-notes");
  assert.equal(before.preview.before.totalNoteCount, 300);
  assert.equal(before.preview.before.notes.length, 256);
  assert.equal(before.preview.before.omittedNoteCount, 44);
  fixture.notes[299]!.pitch = 70;
  assert.notEqual(await captureLiveActionPreflightSnapshot(fixture.context, action, { track: fixture.track }), before.fingerprint);
});

test("unsupported or invalid predictions omit previews without rejecting valid preflight", async () => {
  const fixture = midiPreviewFixture([{ pitch: 127, startTime: 0, duration: 1 }]);
  const target = { track: fixture.track };
  const transform: AgentAction = { type: "transpose_midi_notes", clipName: "Phrase", startBeat: 32, semitones: 1 };
  const invalid = await captureLiveActionPreflightObservation(fixture.context, transform, target);
  assert.equal(invalid.preview, undefined);
  assert.equal(invalid.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, transform, target));
  const rename = await captureLiveActionPreflightObservation(fixture.context, { type: "rename_track", newName: "New" }, target);
  assert.equal(rename.preview, undefined);
  assert.equal(fixture.writes, 0);
});

test("an out-of-range source note shifted into the Clip stays executable without an incomplete before preview", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 8, duration: 1, probability: 0.7 }]);
  const action: AgentAction = { type: "shift_midi_notes", clipName: "Phrase", startBeat: 32, offsetBeats: -2 };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(observed.preview, undefined);
  assert.equal(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, { track: fixture.track }));
  const result = await executeAgentPlanWithProgress(fixture.context, { message: "Move into clip", actions: [action] }, { track: fixture.track });
  assert.equal(result.mutationCount, 1);
  assert.deepEqual(fixture.notes, [{ pitch: 60, startTime: 6, duration: 1, probability: 0.7 }]);
});

test("a tiny note starting exactly at the Clip end omits the preview but can still be shifted inside", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 8, duration: 1e-8 }]);
  const action: AgentAction = { type: "shift_midi_notes", clipName: "Phrase", startBeat: 32, offsetBeats: -1 };
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview, undefined);
  assert.equal(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, target));
  const result = await executeAgentPlanWithProgress(fixture.context, { message: "Move inside", actions: [action] }, target);
  assert.equal(result.mutationCount, 1);
  assert.deepEqual(fixture.notes, [{ pitch: 60, startTime: 7, duration: 1e-8 }]);
});

test("a note starting inside the Clip retains the existing slight end-drift tolerance", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 7.5, duration: 0.50000005 }]);
  const action: AgentAction = {
    type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32,
    segmentStartTime: 0, segmentDurationBeats: 1, notes: [],
  };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(observed.preview?.kind, "midi-notes");
  assert.deepEqual(observed.preview.before.notes, fixture.notes);
  assert.deepEqual(observed.preview.after.notes, fixture.notes);
});

test("empty Clips produce complete zero-note previews and non-finite metadata falls back to details", async () => {
  const fixture = midiPreviewFixture();
  const action: AgentAction = { type: "transpose_midi_notes", clipName: "Phrase", startBeat: 32, semitones: 1 };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(observed.preview?.kind, "midi-notes");
  assert.deepEqual(observed.preview.before, { notes: [], totalNoteCount: 0, omittedNoteCount: 0 });
  assert.deepEqual(observed.preview.after, observed.preview.before);
  fixture.notes = [{ pitch: 60, startTime: 0, duration: 1, probability: NaN }];
  const invalid = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(invalid.preview, undefined);
});

test("unreadable or excessive enum metadata is omitted and an out-of-range current value omits the preview", async () => {
  const fixture = parameterPreviewFixture();
  const action: AgentAction = { type: "set_device_parameter", deviceName: "Filter", parameterName: "Amount", value: 15 };
  fixture.metadata.isQuantized = true;
  fixture.metadata.valueItems = Array.from({ length: 13 }, () => ({ name: "Value", shortName: "v" }));
  const excessive = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(excessive.preview?.kind, "parameter-value");
  assert.equal(excessive.preview.isQuantized, undefined);
  assert.equal(excessive.preview.valueItems, undefined);
  Object.defineProperty(fixture.parameter, "valueItems", { get: () => { throw new Error("Not readable"); } });
  const unreadable = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(unreadable.preview?.kind, "parameter-value");
  assert.equal(unreadable.preview.valueItems, undefined);
  fixture.value = 25;
  const outside = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
  assert.equal(outside.preview, undefined);
});

for (const action of [
  { type: "set_device_parameter", deviceName: "Filter", parameterName: "Amount", value: 15 },
  { type: "set_track_mixer_parameter", parameter: "volume", value: 15 },
  { type: "set_chain_mixer_parameter", rackName: "Rack", chainIndex: 0, parameter: "volume", value: 15 },
] satisfies AgentAction[]) {
  test(`${action.type} uses the exact single observed raw value and enum metadata`, async () => {
    const fixture = parameterPreviewFixture();
    fixture.metadata.isQuantized = true;
    fixture.metadata.valueItems = [{ name: "A", shortName: "a" }, { name: "B", shortName: "b" }];
    const observation = await captureLiveActionPreflightObservation(fixture.context, action, { track: fixture.track });
    assert.equal(fixture.valueReads, 1);
    assert.equal(fixture.writes, 0);
    const preview = observation.preview;
    assert.equal(preview?.kind, "parameter-value");
    assert.equal(preview.before, 10);
    assert.equal(preview.after, 15);
    assert.equal(preview.minimum, 10);
    assert.equal(preview.maximum, 20);
    assert.deepEqual(preview.valueItems, fixture.metadata.valueItems);
    assert.notEqual(preview.valueItems, fixture.metadata.valueItems);
    assert.equal(preview.isQuantized, true);
    fixture.metadata.valueItems[0]!.name = "Changed";
    assert.notEqual(await captureLiveActionPreflightSnapshot(fixture.context, action, { track: fixture.track }), observation.fingerprint);
  });
}
