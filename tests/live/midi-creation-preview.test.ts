import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAction } from "../../src/agent/actions.js";
import { executeAgentPlanWithProgress } from "../../src/live/executor.js";
import { captureLiveActionPreflightObservation, captureLiveActionPreflightSnapshot } from "../../src/live/preflight.js";
import { midiPreviewFixture } from "./support/action-preview.test-harness.js";

type CreateMidiAction = Extract<AgentAction, { type: "create_midi_clip" | "create_session_midi_clip" }>;
const requestedNotes = Array.from({ length: 42 }, (_, index) => ({ pitch: 55 + index % 12, startTime: Math.floor(index / 3) * 2, duration: 2, velocity: 96 }));
const arrangementAction = (overrides: Partial<Extract<CreateMidiAction, { type: "create_midi_clip" }>> = {}): CreateMidiAction => ({
  type: "create_midi_clip", startBeat: 0, durationBeats: 32, name: "G Major Pop Progression", notes: requestedNotes, ...overrides,
});

for (const session of [false, true]) {
  test(`${session ? "Session" : "Arrangement"} MIDI creation previews an empty destination and the complete executed score`, async () => {
    const fixture = midiPreviewFixture();
    fixture.track.arrangementClips.length = 0;
    let creations = 0;
    const create = async () => { creations += 1; return fixture.clip; };
    Object.defineProperty(fixture.track, "createMidiClip", { value: create });
    Object.defineProperty(fixture.track, "clipSlots", { value: [{ handle: { id: 15n }, clip: null, createMidiClip: create }] });
    const action: CreateMidiAction = session
      ? { type: "create_session_midi_clip", slotIndex: 0, requireEmpty: true, durationBeats: 32, name: "G Major Pop Progression", notes: requestedNotes }
      : arrangementAction();
    const target = { track: fixture.track };
    const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
    assert.equal(observed.preview?.kind, "midi-notes");
    assert.equal(observed.preview.status, "proposed");
    assert.deepEqual(observed.preview.range, { coordinate: "clip-beats", start: 0, end: 32 });
    assert.deepEqual(observed.preview.before, { notes: [], totalNoteCount: 0, omittedNoteCount: 0 });
    assert.deepEqual(observed.preview.after.notes, requestedNotes);
    assert.equal(fixture.noteReads, 0);
    assert.equal(creations, 0);
    assert.equal(fixture.writes, 0);
    const outcome = await executeAgentPlanWithProgress(fixture.context, { message: "Create", actions: [action] }, target);
    assert.equal(creations, 1);
    assert.equal(outcome.mutationCount, 1);
    assert.deepEqual(fixture.notes, observed.preview.after.notes);
  });
}

for (const session of [false, true]) {
  test(`${session ? "Session" : "Arrangement"} exact reuse previews observed notes once and matches the notes written`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 36, startTime: 0, duration: 4, velocity: 80, selected: true }], session);
    const notes = [{ pitch: 60, startTime: 1, duration: 2, velocity: 90 }];
    const action: CreateMidiAction = session
      ? { type: "create_session_midi_clip", slotIndex: 0, durationBeats: 8, name: "Renamed", notes }
      : arrangementAction({ startBeat: 32, durationBeats: 8, name: "phrase", notes });
    const target = { track: fixture.track };
    const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
    assert.equal(observed.preview?.kind, "midi-notes");
    assert.deepEqual(observed.preview.before.notes, [{ pitch: 36, startTime: 0, duration: 4, velocity: 80 }]);
    assert.deepEqual(observed.preview.after.notes, notes);
    assert.equal(fixture.noteReads, 1);
    await executeAgentPlanWithProgress(fixture.context, { message: "Replace", actions: [action] }, target);
    assert.deepEqual(fixture.notes, observed.preview.after.notes);
    assert.equal(fixture.clip.name, session ? "Renamed" : "Phrase");
  });
}

test("creation preview omission preserves the full fingerprint, including non-displayed source notes", async () => {
  const fixture = midiPreviewFixture(Array.from({ length: 300 }, () => ({ pitch: 36, startTime: 0, duration: 1 })));
  const action = arrangementAction({ startBeat: 32, durationBeats: 8, name: "Phrase", notes: Array.from({ length: 300 }, () => ({ pitch: 60, startTime: 1, duration: 1, velocity: 90 })) });
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview?.kind, "midi-notes");
  assert.deepEqual([observed.preview.before.totalNoteCount, observed.preview.before.notes.length, observed.preview.before.omittedNoteCount], [300, 256, 44]);
  assert.deepEqual([observed.preview.after.totalNoteCount, observed.preview.after.notes.length, observed.preview.after.omittedNoteCount], [300, 256, 44]);
  const hidden = await captureLiveActionPreflightObservation(fixture.context, action, target, undefined, false);
  assert.equal(hidden.preview, undefined);
  assert.equal(hidden.fingerprint, observed.fingerprint);
  assert.equal(await captureLiveActionPreflightSnapshot(fixture.context, action, target), observed.fingerprint);
  fixture.notes[299]!.pitch = 40;
  assert.notEqual(await captureLiveActionPreflightSnapshot(fixture.context, action, target), observed.fingerprint);
});

test("nonmatching Arrangement overlaps retain their guard without inventing a replacement preview", async () => {
  const fixture = midiPreviewFixture([{ pitch: 36, startTime: 0, duration: 4 }]);
  const action = arrangementAction({ startBeat: 32, durationBeats: 8 });
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview, undefined);
  assert.equal(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, target));
  fixture.notes[0]!.pitch = 40;
  assert.notEqual(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, target));
  assert.equal(fixture.writes, 0);
});

test("occupied Session replacement of a different duration stays summary-only and requireEmpty still rejects", async () => {
  const fixture = midiPreviewFixture([{ pitch: 36, startTime: 0, duration: 8 }], true);
  const action: CreateMidiAction = { type: "create_session_midi_clip", slotIndex: 0, durationBeats: 4, notes: [] };
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview, undefined);
  assert.equal(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, target));
  await assert.rejects(captureLiveActionPreflightObservation(fixture.context, { ...action, requireEmpty: true }, target), /must be empty/);
});

test("reused clips with out-of-range source notes omit an incomplete preview while retaining preflight", async () => {
  const fixture = midiPreviewFixture([{ pitch: 36, startTime: 7, duration: 2 }]);
  const action = arrangementAction({ startBeat: 32, durationBeats: 8, name: "Phrase", notes: [] });
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview, undefined);
  assert.equal(observed.fingerprint, await captureLiveActionPreflightSnapshot(fixture.context, action, target));
});

test("Take Lane MIDI creation reuses the observed lane Clip and retains overlap rejection", async () => {
  const fixture = midiPreviewFixture([{ pitch: 36, startTime: 0, duration: 4 }]);
  const lane = { handle: { id: 19n }, name: "Take 1", clips: [fixture.clip] };
  Object.defineProperty(fixture.track, "takeLanes", { value: [lane] });
  fixture.track.arrangementClips.length = 0;
  const action = arrangementAction({ startBeat: 32, durationBeats: 8, name: "Phrase", laneIndex: 0, laneName: "Take 1", notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 96 }] });
  const target = { track: fixture.track };
  const observed = await captureLiveActionPreflightObservation(fixture.context, action, target);
  assert.equal(observed.preview?.kind, "midi-notes");
  assert.deepEqual(observed.preview.before.notes, fixture.notes);
  await executeAgentPlanWithProgress(fixture.context, { message: "Replace take", actions: [action] }, target);
  assert.deepEqual(observed.preview.after.notes, fixture.notes);
  await assert.rejects(captureLiveActionPreflightObservation(fixture.context, { ...action, name: "Other" }, target), /not empty/);
});
