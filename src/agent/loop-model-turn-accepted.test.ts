import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "./loop.js";

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
