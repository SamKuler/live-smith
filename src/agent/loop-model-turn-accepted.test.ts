import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "./loop.js";

test("runAgentLoop accepts complete logical turns once and excludes output-limit continuations", async () => {
  let requestCount = 0;
  let acceptedCount = 0;
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
          continuation: { reason: "output_limit" },
          providerState: { kind: "continuation" },
        };
      }
      if (requestCount === 2) {
        return {
          content: "inspection",
          toolCalls: [{
            id: "inspect-track",
            name: "inspect_track",
            arguments: JSON.stringify({ trackName: "Lead" }),
          }],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    observe: async () => "Lead exists.",
    confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onModelTurnAccepted: () => {
      acceptedCount += 1;
      timeline.push("accepted");
    },
    onEvent: (event) => {
      timeline.push(event.kind);
    },
  });

  assert.equal(result.message, "Done.");
  assert.deepEqual(acceptedBeforeRequest, [0, 0, 1]);
  assert.equal(acceptedCount, 2);
  assert.equal(timeline[0], "accepted");
  assert.ok(timeline.indexOf("accepted") < timeline.indexOf("assistant"));
  assert.equal(timeline.at(-2), "accepted");
  assert.equal(timeline.at(-1), "assistant");
});
