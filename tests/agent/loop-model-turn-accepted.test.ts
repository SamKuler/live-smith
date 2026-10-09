import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "../../src/agent/loop.js";

test("runAgentLoop accepts complete logical turns once and excludes output-limit continuations", async () => {
  let requestCount = 0;
  let acceptedCount = 0;
  const acceptedUsage: unknown[] = [];
  const acceptedBeforeRequest: number[] = [];
  const timeline: string[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 2,
    askModel: async () => {
      acceptedBeforeRequest.push(acceptedCount);
      requestCount += 1;
      if (requestCount === 1) {
        return {
          content: "Partial ",
          toolCalls: [],
          contextUsage: { usedTokens: 100, contextWindowTokens: 1_000 },
          continuation: { reason: "output_limit" },
          providerState: { kind: "continuation" },
        };
      }
      if (requestCount === 2) {
        return {
          content: "inspection",
          contextUsage: { usedTokens: 200, contextWindowTokens: 1_000 },
          toolCalls: [{
            id: "inspect-track",
            name: "inspect_track",
            arguments: JSON.stringify({ trackName: "Lead" }),
          }],
        };
      }
      return {
        content: "Done.",
        toolCalls: [],
        contextUsage: { usedTokens: 300, contextWindowTokens: 1_000 },
      };
    },
    observe: async () => "Lead exists.",
    confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onModelTurnAccepted: (usage) => {
      acceptedCount += 1;
      acceptedUsage.push(usage);
      timeline.push("accepted");
    },
    onEvent: (event) => {
      timeline.push(event.kind);
    },
  });

  assert.equal(result.message, "Done.");
  assert.deepEqual(acceptedBeforeRequest, [0, 0, 1]);
  assert.equal(acceptedCount, 2);
  assert.deepEqual(acceptedUsage, [
    { usedTokens: 200, contextWindowTokens: 1_000 },
    { usedTokens: 300, contextWindowTokens: 1_000 },
  ]);
  assert.equal(timeline[0], "accepted");
  assert.ok(timeline.indexOf("accepted") < timeline.indexOf("assistant"));
  assert.equal(timeline.at(-2), "accepted");
  assert.equal(timeline.at(-1), "assistant");
});

test("runAgentLoop rejects malformed context usage before the accepted callback", async () => {
  let accepted = false;

  await assert.rejects(
    runAgentLoop({
      maxConsecutiveFailures: 2,
      askModel: async () => ({
        content: "Invalid usage.",
        toolCalls: [],
        contextUsage: { usedTokens: -1, contextWindowTokens: 1_000 },
      }),
      observe: async () => "",
      confirmActions: async () => false,
      executeActions: async () => ({ results: [], mutationCount: 0 }),
      onModelTurnAccepted: () => {
        accepted = true;
      },
    }),
    /context usage/i,
  );

  assert.equal(accepted, false);
});

test("hosted tool continuations accept usage and return to the normal model loop", async () => {
  let turns = 0;
  let clientCalls = 0;
  const accepted: unknown[] = [];
  const projection = { messages: [{ role: "tool" as const, toolCallId: "search-1", content: "Source text" }], usageMessageCount: 0 };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 1,
    askModel: async ({ messages }) => {
      turns++;
      if (turns <= 3) return {
        content: null, toolCalls: [], continuation: { reason: "hosted_tools" },
        providerState: { kind: "private-search" }, contextProjection: projection,
        contextUsage: { usedTokens: turns * 100, contextWindowTokens: 1_000 },
      };
      assert.equal(accepted.length, 3);
      assert.equal(messages.filter(message => message.role === "assistant" && message.contextProjection === projection).length, 3);
      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => { clientCalls++; return ""; },
    confirmActions: async () => false,
    executeActions: async () => { clientCalls++; return { results: [], mutationCount: 0 }; },
    onModelTurnAccepted: usage => { accepted.push(usage); },
  });
  assert.equal(result.message, "Done.");
  assert.equal(turns, 4);
  assert.equal(clientCalls, 0);
  assert.deepEqual(accepted.slice(0, 3), [100, 200, 300].map(usedTokens => ({ usedTokens, contextWindowTokens: 1_000 })));
});

test("runAgentLoop preserves partial output when the model reaches its context limit", async () => {
  const events: Array<{ kind: string; content: string }> = [];
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ({
      content: "Partial answer with evidence.",
      toolCalls: [],
      contextUsage: { usedTokens: 1_000, contextWindowTokens: 1_000 },
      termination: { reason: "context_limit" },
      providerState: { kind: "test", output: ["partial"] },
      citations: [{
        url: "https://example.test/context-limit",
        title: "Context source",
      }],
    }),
    observe: async () => "",
    confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onEvent: (event) => {
      events.push({ kind: event.kind, content: event.content });
    },
  });

  assert.deepEqual(events.map((event) => event.kind), ["assistant", "error"]);
  assert.equal(events[0]?.content, "Partial answer with evidence.");
  assert.match(events[1]?.content ?? "", /context-window limit/i);
  assert.match(result.message, /Partial answer with evidence/u);
  assert.match(result.message, /context-window limit/i);
});
