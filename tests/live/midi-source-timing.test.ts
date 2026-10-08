import assert from "node:assert/strict";
import test from "node:test";
import { MidiClip, TakeLane, type NoteDescription } from "@ableton-extensions/sdk";
import { validateAgentPlan } from "../../src/agent/actions.js";
import { preflightAgentPlan } from "../../src/app/agent-request.js";
import { executeAgentPlanWithProgress } from "../../src/live/executor.js";
import { projectMidiClipNotes } from "../../src/live/midi-clip-timing.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import { midiPreviewFixture } from "./support/action-preview.test-harness.js";

async function preflight(h: ReturnType<typeof midiPreviewFixture>, input: unknown) {
  const plan = validateAgentPlan(input);
  const signal = createHostAbortController().signal;
  const guard = await preflightAgentPlan(h.context, {
    target: { track: h.track }, summary: "", scope: { kind: "selection", identity: "test", label: "Test" },
  } as never, plan, signal);
  return { plan, signal, bindings: await guard() };
}

async function apply(h: ReturnType<typeof midiPreviewFixture>, input: unknown) {
  const { plan, signal, bindings } = await preflight(h, input);
  return executeAgentPlanWithProgress(h.context, plan, { track: h.track }, signal, bindings);
}

const timingCases = [
  { label: "cropped", startMarker: 4, endMarker: 12, looping: false, loopStart: 4, loopEnd: 12 },
  { label: "shifted loop", startMarker: 2, endMarker: 10, looping: true, loopStart: 0, loopEnd: 8 },
  { label: "repeated loop", startMarker: 0, endMarker: 8, looping: true, loopStart: 0, loopEnd: 4 },
];
const authored = [{ pitch: 67, startTime: 6, duration: 1, velocity: 100 }];

for (const session of [false, true]) for (const timing of timingCases) {
  test(`creating over a ${timing.label} ${session ? "Session" : "Arrangement"} Clip preserves authored playback`, async () => {
    const h = midiPreviewFixture([{ pitch: 60, startTime: 4, duration: 1, velocity: 90 }], session);
    Object.assign(h.clip, timing);
    let destination = h.clip;
    const create = async (...args: number[]) => {
      assert.deepEqual(args, session ? [8] : [32, 8]);
      destination = Object.defineProperties(Object.create(MidiClip.prototype), {
        name: { value: "New", writable: true }, notes: { value: [], writable: true },
        duration: { value: 8 }, startMarker: { value: 0 }, endMarker: { value: 8 },
        looping: { value: false }, loopStart: { value: 0 }, loopEnd: { value: 8 }, muted: { value: false },
      });
      return destination;
    };
    if (session) {
      const slot = h.track.clipSlots[0]!;
      Object.defineProperties(slot, { createMidiClip: { value: create }, deleteClip: { value: async () => {} } });
    } else Object.defineProperty(h.track, "createMidiClip", { value: create });
    const action = session
      ? { type: "create_session_midi_clip", slotIndex: 0 }
      : { type: "create_midi_clip", startBeat: 32 };
    await apply(h, { message: "Author section", actions: [{ ...action, trackName: "Bass", name: "Phrase", durationBeats: 8, notes: authored }] });
    assert.deepEqual(projectMidiClipNotes(destination.notes, destination, 4096), authored);
    assert.notEqual(destination, h.clip);
    assert.equal(h.writes, 0);
  });
}

for (const session of [false, true]) {
  test(`creation reuses a ${session ? "Session" : "Arrangement"} loop whose first pass covers the section`, async () => {
    const h = midiPreviewFixture([], session);
    Object.assign(h.clip, { looping: true, loopStart: 2, loopEnd: 8 });
    const action = session ? { type: "create_session_midi_clip", slotIndex: 0 } : { type: "create_midi_clip", startBeat: 32 };
    const result = await apply(h, { message: "Author section", actions: [{ ...action, trackName: "Bass", name: "Phrase", durationBeats: 8, notes: authored }] });
    assert.equal(result.mutationCount, 1);
    assert.equal(h.writes, 1);
    assert.deepEqual(projectMidiClipNotes(h.notes, h.clip, 4096), authored);
  });

  test(`incompatible ${session ? "Session" : "Arrangement"} creation rejects a later edit of the replaced Clip`, async () => {
    const h = midiPreviewFixture([], session); Object.assign(h.clip, timingCases[0]);
    const locator = session ? { slotIndex: 0 } : { startBeat: 32 };
    await assert.rejects(apply(h, { message: "Create then edit", actions: [
      { type: session ? "create_session_midi_clip" : "create_midi_clip", ...locator, trackName: "Bass", name: "Phrase", durationBeats: 8, notes: authored },
      { type: "transpose_midi_notes", ...locator, trackName: "Bass", clipName: "Phrase", semitones: 12 },
    ] }), /invalidated by action 1/);
    assert.equal(h.writes, 0);
  });
}

test("non-reusable Take Lane geometry rejects overlapping creation before any write", async () => {
  const h = midiPreviewFixture(); Object.assign(h.clip, timingCases[0]);
  const lane = Object.defineProperties(Object.create(TakeLane.prototype), {
    handle: { value: { id: 30n } }, name: { value: "Take 1" }, clips: { value: [h.clip] },
  });
  Object.defineProperty(h.track, "takeLanes", { value: [lane] });
  await assert.rejects(apply(h, { message: "Author take", actions: [{ type: "create_midi_clip", trackName: "Bass", name: "Phrase", startBeat: 32, durationBeats: 8, laneIndex: 0, notes: authored }] }), /Take Lane.*not empty/);
  assert.equal(h.writes, 0);
});

for (const session of [false, true]) for (const transform of [
  { type: "transpose_midi_notes", semitones: 12, pitch: 72, velocity: 90 },
  { type: "scale_midi_velocity", factor: 0.5, pitch: 60, velocity: 45 },
]) {
  test(`${transform.type} preserves cropped and hidden source times in ${session ? "Session" : "Arrangement"}`, async () => {
    const notes: NoteDescription[] = [
      { pitch: 60, startTime: 4, duration: 1, velocity: 90 },
      { pitch: 60, startTime: 12, duration: 2, velocity: 90, muted: true, probability: 0.4 },
    ];
    const h = midiPreviewFixture(notes, session);
    Object.assign(h.clip, { ...timingCases[0], duration: 4, endMarker: 8 });
    const { pitch, velocity, ...action } = transform;
    await apply(h, { message: "Edit source notes", actions: [{ ...action, trackName: "Bass", clipName: "Phrase", ...(session ? { slotIndex: 0 } : { startBeat: 32 }) }] });
    assert.deepEqual(h.notes, notes.map((note) => ({ ...note, pitch, velocity })));
  });
}

test("segment replacement addresses cropped source beats and preserves hidden notes", async () => {
  const hidden = { pitch: 48, startTime: 12, duration: 1, velocity: 80 };
  const h = midiPreviewFixture([{ pitch: 60, startTime: 4, duration: 1, velocity: 90 }, hidden]);
  Object.assign(h.clip, { ...timingCases[0], duration: 4, endMarker: 8 });
  const replacement = { pitch: 67, startTime: 4, duration: 1, velocity: 100 };
  await apply(h, { message: "Replace source segment", actions: [{ type: "replace_midi_clip_segment", trackName: "Bass", clipName: "Phrase", startBeat: 32, segmentStartTime: 4, segmentDurationBeats: 2, notes: [replacement] }] });
  assert.deepEqual(h.notes, [replacement, hidden]);
});

for (const action of [
  { type: "shift_midi_notes", offsetBeats: -0.25 },
  { type: "quantize_midi_notes", gridBeats: 1, strength: 1 },
]) {
  test(`${action.type} edits source coordinates throughout cropped and hidden material`, async () => {
    const notes = [{ pitch: 60, startTime: 4.25, duration: 1, velocity: 90 },
      { pitch: 48, startTime: 12.25, duration: 1, velocity: 80, muted: true }];
    const h = midiPreviewFixture(notes);
    Object.assign(h.clip, { ...timingCases[0], duration: 4, endMarker: 8 });
    await apply(h, { message: "Move source notes", actions: [{ ...action, trackName: "Bass", clipName: "Phrase", startBeat: 32 }] });
    assert.deepEqual(h.notes, [{ ...notes[0], startTime: 4 }, { ...notes[1], startTime: 12 }]);
  });
}

test("source timing edits reject notes outside the captured source extent without a write", async () => {
  const h = midiPreviewFixture([{ pitch: 60, startTime: 4, duration: 1, velocity: 90 },
    { pitch: 48, startTime: 12, duration: 1, velocity: 80 }]);
  Object.assign(h.clip, { ...timingCases[0], duration: 4, endMarker: 8 });
  await assert.rejects(apply(h, { message: "Move source notes", actions: [{ type: "shift_midi_notes", offsetBeats: 1, trackName: "Bass", clipName: "Phrase", startBeat: 32 }] }), /source bounds 0-13/);
  assert.equal(h.writes, 0);
});

for (const locator of [{ trackName: "Bass" }, {}]) {
  test(`overlapping replacement aliases ${"trackName" in locator ? "named" : "selected"} resolve to one Clip`, async () => {
    const h = midiPreviewFixture();
    const segment = { type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32, segmentDurationBeats: 2, notes: [] };
    await assert.rejects(apply(h, { message: "Replace segments", targets: { bass: { trackName: "Bass" } }, actions: [
      { ...segment, trackRef: "bass", segmentStartTime: 0 },
      { ...segment, ...locator, segmentStartTime: 1 },
    ] }), /overlapping replacements/);
    assert.equal(h.writes, 0);
  });
}

test("adjacent source segments can use different locators for one bound Clip", async () => {
  const h = midiPreviewFixture();
  const segment = { type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32, segmentDurationBeats: 2 };
  await apply(h, { message: "Replace adjacent segments", targets: { bass: { trackName: "Bass" } }, actions: [
    { ...segment, trackRef: "bass", segmentStartTime: 0, notes: [{ pitch: 60, startTime: 1, duration: 1, velocity: 100 }] },
    { ...segment, trackName: "Bass", segmentStartTime: 2, notes: [{ pitch: 67, startTime: 2, duration: 1, velocity: 100 }] },
  ] });
  assert.deepEqual(h.notes.map((note) => note.pitch), [60, 67]);
});
