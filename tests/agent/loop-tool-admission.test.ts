import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop, type AgentLoopTraceEvent } from "../../src/agent/loop.js";

for (const name of ["apply_live_actions", "resolve_live_recovery", "inspect_live_set", "generate_music"]) {
  test(`restricted model workflows reject forged ${name} before any side effect`, async () => {
    const events: AgentLoopTraceEvent[] = [];
    const admittedToolNames = ["save_midi_artifact"];
    let turns = 0, saves = 0;
    const result = await runAgentLoop({
      admittedToolNames, maxConsecutiveFailures: 3,
      askModel: async () => {
        turns++;
        if (turns === 1) {
          admittedToolNames.push(name);
          return { content: null, toolCalls: [{ id: "forged", name, arguments: "{}" }] };
        }
        if (turns === 2) return { content: null, toolCalls: [{ id: "saved", name: "save_midi_artifact", arguments: "{}" }] };
        return { content: "Saved the MIDI candidate.", toolCalls: [] };
      },
      externalTools: { names: ["save_midi_artifact", "generate_music"], execute: async (call) => {
        assert.equal(call.name, "save_midi_artifact"); saves++;
        return { content: "MIDI candidate saved." };
      } },
      observe: async () => assert.fail("No built-in observations admitted"),
      preflightActions: async () => assert.fail("No Live preflight admitted"),
      prepareActionPlan: async () => assert.fail("No action materialization admitted"),
      confirmActions: async () => assert.fail("No Live confirmation admitted"),
      confirmRecoveryResolution: async () => assert.fail("No recovery mutation admitted"),
      executeActions: async () => assert.fail("No Live writes admitted"),
      onEvent: (event) => { events.push(event); },
    });
    assert.equal(saves, 1); assert.equal(result.message, "Saved the MIDI candidate.");
    assert.ok(events.some((event) => event.kind === "tool_result" && event.name === name && /not admitted/.test(event.content)));
    assert.equal(events.some((event) => event.kind === "apply_requested"), false);
  });
}
