import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPlan } from "../agent/actions.js";
import { runAgentLoop } from "../agent/loop.js";
import { executeAgentPlanWithProgress } from "../live/executor.js";
import { midiPreviewFixture, parameterPreviewFixture } from "../live/action-preview.test-harness.js";
import { captureLiveActionPreflightSnapshot } from "../live/preflight.js";
import { preflightAgentPlan } from "./agent-request.js";

const transpose: AgentPlan = {
  message: "Transpose", actions: [{ type: "transpose_midi_notes", clipName: "Phrase", startBeat: 32, semitones: 1 }],
};

test("one guarded MIDI edit carries the initial observation and ignores transient note selection", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 0, duration: 1, selected: true }]);
  const interaction = { target: { track: fixture.track } } as never;
  const guard = await preflightAgentPlan(fixture.context, interaction, transpose, new AbortController().signal, async () => "Observed");
  assert.equal(fixture.noteReads, 1);
  assert.equal(guard.previews?.length, 1);
  assert.equal(guard.previews[0]?.kind, "midi-notes");
  fixture.notes[0]!.selected = false;
  const bindings = await guard();
  assert.equal(fixture.noteReads, 2);
  const preview = guard.previews[0];
  assert.deepEqual(preview.before.notes, [{ pitch: 60, startTime: 0, duration: 1 }]);
  await executeAgentPlanWithProgress(fixture.context, transpose, { track: fixture.track }, undefined, bindings);
  assert.deepEqual(fixture.notes, [{ pitch: 61, startTime: 0, duration: 1, selected: false }]);
});

test("the complete multi-action dependency boundary suppresses every preview and keeps guards", async () => {
  const fixture = midiPreviewFixture([{ pitch: 60, startTime: 0, duration: 1 }]);
  const plan: AgentPlan = { message: "Two edits", actions: [...transpose.actions, ...transpose.actions] };
  const guard = await preflightAgentPlan(fixture.context, { target: { track: fixture.track } } as never, plan,
    new AbortController().signal, async () => "Observed");
  assert.equal(guard.previews, undefined);
  assert.equal(guard.actionKeys?.length, 2);
  fixture.notes[0]!.pitch = 62;
  await assert.rejects(guard, /state changed/);
  assert.equal(fixture.writes, 0);
});

test("injected legacy string snapshotters preserve guards without fabricating preview facts", async () => {
  const fixture = midiPreviewFixture();
  const guard = await preflightAgentPlan(fixture.context, { target: { track: fixture.track } } as never, transpose,
    new AbortController().signal, async () => "Observed", captureLiveActionPreflightSnapshot);
  assert.equal(guard.previews, undefined);
  await guard();
});

test("confirmation receives the same guard and a changed numeric target performs zero writes", async () => {
  const fixture = parameterPreviewFixture();
  const plan: AgentPlan = { message: "Set Amount", actions: [{ type: "set_device_parameter", deviceName: "Filter", parameterName: "Amount", value: 15 }] };
  let turn = 0;
  let confirmedGuard: unknown;
  let executions = 0;
  const guard = await preflightAgentPlan(fixture.context, { target: { track: fixture.track } } as never, plan,
    new AbortController().signal, async () => "Observed");
  assert.equal(guard.previews?.[0]?.kind, "parameter-value");
  await runAgentLoop({
    maxConsecutiveFailures: 3,
    askModel: async () => ++turn === 1
      ? { content: "Set Amount", toolCalls: [{ id: "preview-edit", name: "apply_live_actions", arguments: JSON.stringify(plan) }] }
      : { content: "The state changed; no writes were made.", toolCalls: [] },
    observe: async () => "Observed current parameter",
    preflightActions: async () => guard,
    confirmActions: async (_plan, received) => {
      confirmedGuard = received;
      fixture.value = 12;
      return true;
    },
    executeActions: async () => { executions += 1; return { results: [], mutationCount: 0 }; },
  });
  assert.equal(confirmedGuard, guard);
  assert.equal(executions, 0);
  assert.equal(fixture.writes, 0);
  assert.equal(guard.previews?.[0]?.kind === "parameter-value" ? guard.previews[0].before : undefined, 10);
});
