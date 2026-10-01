import assert from "node:assert/strict";
import test from "node:test";

import {
  runAgentLoop,
  type AgentLoopTraceEvent,
} from "../../src/agent/loop.js";

const unusedExecution = async () => ({ results: [], mutationCount: 0 });

test("agent loop records visible reasoning before its assistant response", async () => {
  const events: AgentLoopTraceEvent[] = [];

  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      reasoning: { content: "Inspecting the current clip." },
      content: "The clip is ready.",
      toolCalls: [],
    }),
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: unusedExecution,
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(events, [{
    kind: "reasoning",
    content: "Inspecting the current clip.",
  }, {
    kind: "assistant",
    content: "The clip is ready.",
  }]);
});

test("agent loop merges continuation reasoning and preserves a stage-only result", async () => {
  const events: AgentLoopTraceEvent[] = [];
  let turn = 0;

  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ++turn === 1
      ? {
          reasoning: { content: "First stage" },
          content: "Partial ",
          toolCalls: [],
          continuation: { reason: "output_limit" as const },
          providerState: { kind: "test", output: [] },
        }
      : {
          reasoning: { content: "" },
          content: "answer.",
          toolCalls: [],
        },
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: unusedExecution,
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(events, [{ kind: "reasoning", content: "First stage" }, {
    kind: "assistant",
    content: "Partial answer.",
  }]);

  events.length = 0;
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      reasoning: { content: "" },
      content: "Done.",
      toolCalls: [],
    }),
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: unusedExecution,
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(events[0], { kind: "reasoning", content: "" });
});

test("agent loop rejects malformed visible reasoning before recording it", async () => {
  const events: AgentLoopTraceEvent[] = [];
  await assert.rejects(runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      reasoning: { content: { private: true } } as never,
      content: "Done.",
      toolCalls: [],
    }),
    observe: async () => "unused",
    confirmActions: async () => false,
    executeActions: unusedExecution,
    onEvent: (event) => { events.push(event); },
  }), /reasoning.*invalid/iu);
  assert.deepEqual(events, []);
});
