import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentPlan, type AgentAction, type AgentPlan } from "../../../src/agent/actions.js";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { preflightAgentPlan } from "../../../src/app/agent-request.js";
import type { AgentPlanBindings } from "../../../src/live/action-bindings.js";
import { executeAgentPlanWithProgress } from "../../../src/live/executor.js";
import { midiPreviewFixture } from "../../live/support/action-preview.test-harness.js";

type Fixture = ReturnType<typeof midiPreviewFixture>;

function preflight(fixture: Fixture, actions: AgentAction[]) {
  return preflightAgentPlan(fixture.context, { target: { track: fixture.track } } as never,
    validateAgentPlan({ message: "Edit phrase", actions }), new AbortController().signal, async () => "Observed");
}

async function apply(fixture: Fixture, actions: AgentAction[]) {
  const guard = await preflight(fixture, actions);
  assert.equal(fixture.writes, 0);
  const bindings = await guard();
  await executeAgentPlanWithProgress(fixture.context, { message: "Edit phrase", actions },
    { track: fixture.track }, undefined, bindings);
}

const transpose: AgentAction = { type: "transpose_midi_notes", clipName: "Phrase", startBeat: 32, semitones: 1 };

for (const prefix of [false, true]) {
  test(`an invalid MIDI transform ${prefix ? "after another mutation" : "alone"} is rejected before confirmation`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 127, startTime: 0, duration: 1 }]);
    const plan: AgentPlan = { message: "Edit phrase", actions: [
      ...(prefix ? [{ type: "set_track_mute" as const, mute: true }] : []), transpose,
    ] };
    let turn = 0;
    let confirmations = 0;
    await runAgentLoop({
      maxConsecutiveFailures: 3,
      askModel: async () => ++turn === 1
        ? { content: "Edit phrase", toolCalls: [{ id: "edit", name: "apply_live_actions", arguments: JSON.stringify(plan) }] }
        : { content: "Finished", toolCalls: [] },
      observe: async () => "Observed",
      preflightActions: (candidate) => preflight(fixture, candidate.actions),
      confirmActions: async () => { confirmations += 1; return true; },
      executeActions: (candidate, bindings) => executeAgentPlanWithProgress(
        fixture.context, candidate, { track: fixture.track }, undefined, bindings as AgentPlanBindings,
      ),
    });
    assert.equal(fixture.track.mute, false);
    assert.equal(fixture.writes, 0);
    assert.equal(confirmations, 0);
  });
}

test("same-Clip transforms use the preceding notes across ref and named locators", async () => {
  const fixture = midiPreviewFixture([{ pitch: 127, startTime: 0, duration: 1 }]);
  const plan = validateAgentPlan({ message: "Transpose down and back", targets: { bass: { trackName: "Bass" } }, actions: [
    { ...transpose, trackRef: "bass", semitones: -12 },
    { ...transpose, trackName: "Bass", semitones: 12 },
  ] });
  const guard = await preflightAgentPlan(fixture.context, { target: {} } as never, plan,
    new AbortController().signal, async () => "Observed");
  const bindings = await guard();
  await executeAgentPlanWithProgress(fixture.context, plan, {}, undefined, bindings);
  assert.equal(fixture.writes, 2);
  assert.equal(fixture.notes[0]!.pitch, 127);
});

test("cumulative pitch overflow rejects the complete plan before any note write", async () => {
  const fixture = midiPreviewFixture([{ pitch: 126, startTime: 0, duration: 1 }]);
  await assert.rejects(preflight(fixture, [transpose, transpose]), /pitch 128.*outside/);
  assert.equal(fixture.writes, 0);
});

test("every guard invocation evaluates from the current observed notes", async () => {
  const fixture = midiPreviewFixture([{ pitch: 126, startTime: 0, duration: 1 }]);
  const guard = await preflight(fixture, [transpose]);
  await guard();
  await guard();
  assert.equal(fixture.writes, 0);
  fixture.notes[0]!.pitch = 124;
  await assert.rejects(guard, /state changed/);
});

for (const replacement of ["arrangement", "session", "segment"] as const) {
  for (const replacementPitch of [60, 127]) {
    test(`${replacement} note replacement determines the following transform at pitch ${replacementPitch}`, async () => {
      const fixture = midiPreviewFixture([{ pitch: replacementPitch === 60 ? 127 : 60, startTime: 0, duration: 1 }], replacement === "session");
      const notes = [{ pitch: replacementPitch, startTime: 0, duration: 1, velocity: 100 }];
      const write: AgentAction = replacement === "segment"
        ? { type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32, segmentStartTime: 0, segmentDurationBeats: 2, notes }
        : replacement === "session"
          ? { type: "create_session_midi_clip", name: "Phrase", slotIndex: 0, durationBeats: 8, notes }
          : { type: "create_midi_clip", name: "Phrase", startBeat: 32, durationBeats: 8, notes };
      const transform: AgentAction = replacement === "session"
        ? { type: "transpose_midi_notes", clipName: "Phrase", slotIndex: 0, semitones: 1 }
        : transpose;
      if (replacementPitch === 127) {
        await assert.rejects(preflight(fixture, [write, transform]), /pitch 128.*outside/);
        assert.equal(fixture.writes, 0);
      } else {
        await apply(fixture, [write, transform]);
        assert.deepEqual(fixture.notes, [{ pitch: 61, startTime: 0, duration: 1, velocity: 100 }]);
        assert.equal(fixture.writes, 2);
      }
    });
  }
}

test("timing edits recompute the source extent after preceding note edits", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 12, duration: 1 }]);
  await assert.rejects(preflight(fixture, [
    { type: "shift_midi_notes", clipName: "Phrase", startBeat: 32, offsetBeats: -5 },
    { type: "shift_midi_notes", clipName: "Phrase", startBeat: 32, offsetBeats: 1 },
  ]), /source bounds 0-8/);
  assert.equal(fixture.writes, 0);
});

for (const session of [false, true]) {
  test(`${session ? "Session" : "Arrangement"} replacement no-ops retain the notes used by a later timing edit`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 60, startTime: 5e-8, duration: 1, velocity: 100 }], session);
    const locator = session ? { slotIndex: 0 } : { startBeat: 32 };
    const replace: AgentAction = session
      ? { type: "create_session_midi_clip", slotIndex: 0, durationBeats: 8,
          notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] }
      : { type: "create_midi_clip", name: "Phrase", startBeat: 32, durationBeats: 8,
          notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] };
    await apply(fixture, [replace, { type: "shift_midi_notes", ...locator, offsetBeats: -5e-8 }]);
    assert.equal(fixture.writes, 1);
    assert.equal(fixture.notes[0]!.startTime, 0);
  });
}

for (const looping of [false, true]) {
  test(`setting looping ${looping} determines source bounds for the next transform`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 60, startTime: 3, duration: 1 }]);
    Object.assign(fixture.clip, { endMarker: 4, loopEnd: 8, looping: !looping });
    const actions: AgentAction[] = [
      { type: "set_clip_properties", clipName: "Phrase", startBeat: 32, looping },
      { type: "shift_midi_notes", clipName: "Phrase", startBeat: 32, offsetBeats: 3 },
    ];
    if (looping) {
      await apply(fixture, actions);
      assert.deepEqual(fixture.notes, [{ pitch: 60, startTime: 6, duration: 1 }]);
    } else {
      await assert.rejects(preflight(fixture, actions), /source bounds 0-4/);
      assert.equal(fixture.clip.looping, true);
      assert.equal(fixture.writes, 0);
    }
  });
}

test("case-sensitive refs on separate tracks can replace the same relative range", async () => {
  const bass = midiPreviewFixture();
  const lead = midiPreviewFixture();
  Object.assign(lead.track, { name: "Lead", handle: { id: 20n } });
  Object.assign(lead.clip, { handle: { id: 22n } });
  bass.context.application.song.tracks.push(lead.track);
  const segment = { type: "replace_midi_clip_segment", clipName: "Phrase", startBeat: 32,
    segmentStartTime: 0, segmentDurationBeats: 2, notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] };
  const plan = validateAgentPlan({ message: "Edit both tracks", targets: { A: { trackName: "Bass" }, a: { trackName: "Lead" } },
    actions: [{ ...segment, trackRef: "A" }, { ...segment, trackRef: "a" }] });
  const guard = await preflightAgentPlan(bass.context, { target: {} } as never, plan,
    new AbortController().signal, async () => "Observed");
  await executeAgentPlanWithProgress(bass.context, plan, {}, undefined, await guard());
  assert.equal(bass.writes, 1);
  assert.equal(lead.writes, 1);

  plan.targets!.a = { trackName: "Bass" };
  await assert.rejects(preflightAgentPlan(bass.context, { target: {} } as never, plan,
    new AbortController().signal, async () => "Observed"), /overlapping replacements/);
});

for (const laterTarget of ["clip", "slot"] as const) {
  test(`an earlier looping change that forces Session Clip recreation rejects later ${laterTarget} dependencies`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 60, startTime: 3, duration: 1 }], true);
    Object.assign(fixture.clip, { endMarker: 4, loopEnd: 8, looping: true });
    const actions: AgentAction[] = [
      { type: "set_clip_properties", slotIndex: 0, looping: false },
      { type: "create_session_midi_clip", slotIndex: 0, durationBeats: 8,
        notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] },
    ];
    await preflight(fixture, actions);
    const laterAction: AgentAction = laterTarget === "clip"
      ? { type: "transpose_midi_notes", slotIndex: 0, semitones: 1 }
      : actions[1]!;
    await assert.rejects(preflight(fixture, [...actions, laterAction]),
      /Action 3 depends on Session (?:Clip|slot content).*invalidated by action 2/);
    assert.equal(fixture.clip.looping, true);
    assert.equal(fixture.writes, 0);
  });
}

for (const looping of [false, true]) {
  test(`an earlier looping change to ${looping} allows later edits when Session creation retains the Clip`, async () => {
    const fixture = midiPreviewFixture([{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }], true);
    Object.assign(fixture.clip, {
      endMarker: looping ? 4 : 8, loopEnd: looping ? 8 : 4, looping: !looping,
    });
    const clip = fixture.track.clipSlots[0]!.clip;
    const plan = validateAgentPlan({ message: "Update the existing Session phrase",
      targets: { bass: { trackName: "Bass" } }, actions: [
        { type: "set_clip_properties", trackRef: "bass", slotIndex: 0, looping },
        { type: "create_session_midi_clip", trackName: "Bass", slotIndex: 0, durationBeats: 8,
          notes: [{ pitch: 61, startTime: 0, duration: 1, velocity: 100 }] },
        { type: "transpose_midi_notes", slotIndex: 0, semitones: 1 },
      ] });
    const guard = await preflightAgentPlan(fixture.context, { target: { track: fixture.track } } as never,
      plan, new AbortController().signal, async () => "Observed");
    assert.equal(fixture.writes, 0);
    assert.equal(fixture.clip.looping, !looping);
    const outcome = await executeAgentPlanWithProgress(fixture.context, plan,
      { track: fixture.track }, undefined, await guard());
    assert.equal(outcome.mutationCount, 3);
    assert.equal(fixture.track.clipSlots[0]!.clip, clip);
    assert.equal(fixture.clip.looping, looping);
    assert.equal(fixture.notes[0]!.pitch, 62);
    assert.equal(fixture.writes, 2);
  });
}

test("the latest looping change determines whether Session creation invalidates the Clip", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 0, duration: 1 }], true);
  Object.assign(fixture.clip, { endMarker: 8, loopEnd: 4, looping: true });
  await assert.rejects(preflight(fixture, [
    { type: "set_clip_properties", slotIndex: 0, looping: false },
    { type: "set_clip_properties", slotIndex: 0, looping: true },
    { type: "create_session_midi_clip", slotIndex: 0, durationBeats: 8, notes: [] },
    { type: "transpose_midi_notes", slotIndex: 0, semitones: 1 },
  ]), /Action 4 depends on Session Clip.*invalidated by action 3/);
  assert.equal(fixture.clip.looping, true);
  assert.equal(fixture.writes, 0);
});

test("a looping edit on one Clip does not authorize reusing another Clip", async () => {
  const bass = midiPreviewFixture([], true);
  const lead = midiPreviewFixture([], true);
  Object.assign(lead.track, { name: "Lead", handle: { id: 20n } });
  Object.assign(lead.track.clipSlots[0]!, { handle: { id: 21n } });
  Object.assign(lead.clip, { handle: { id: 22n } });
  for (const fixture of [bass, lead]) Object.assign(fixture.clip, { endMarker: 8, loopEnd: 4, looping: true });
  bass.context.application.song.tracks.push(lead.track);
  await assert.rejects(preflight(bass, [
    { type: "set_clip_properties", trackName: "Bass", slotIndex: 0, looping: false },
    { type: "create_session_midi_clip", trackName: "Lead", slotIndex: 0, durationBeats: 8, notes: [] },
    { type: "transpose_midi_notes", trackName: "Lead", slotIndex: 0, semitones: 1 },
  ]), /Action 3 depends on Session Clip.*invalidated by action 2/);
  assert.equal(bass.clip.looping, true);
  assert.equal(lead.clip.looping, true);
  assert.equal(bass.writes + lead.writes, 0);
});
