import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop, type AgentLoopTraceEvent } from "../../src/agent/loop.js";

for (const [outcome, result] of [
  ["failed", { failed: true }],
  ["unknown", { failed: true, outcomeUnknown: true }],
  ["success", {}],
] as const) {
  test(`external ${outcome} survives the trace even when the tool ends the loop`, async () => {
    const events: AgentLoopTraceEvent[] = [];
    let executions = 0;
    await runAgentLoop({
      maxConsecutiveFailures: 2,
      externalTools: { names: ["external"], execute: async () => {
        executions++; return { content: "Provider text is not a status contract", stop: true, ...result };
      } },
      askModel: async () => ({ content: null, toolCalls: [{ id: "external-call", name: "external", arguments: "{}" }] }),
      observe: async () => "", confirmActions: async () => false,
      executeActions: async () => ({ results: [], mutationCount: 0 }),
      onEvent: event => { events.push(event); },
    });
    assert.equal(executions, 1);
    assert.equal(events.find(event => event.kind === "tool_result")?.outcome, outcome);
  });
}
