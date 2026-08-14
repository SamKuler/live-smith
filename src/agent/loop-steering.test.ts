import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSteeringInterruptError,
  runAgentLoop,
  type AgentLoopModelInput,
} from "./loop.js";
import type { ModelTurn } from "../model/contracts.js";

test("runAgentLoop restarts an interrupted model turn with the steering message", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  const pending = ["Keep the groove sparse and use the Lead track instead."];
  let resets = 0;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (modelInputs.length === 1) throw new AgentSteeringInterruptError();
      return { content: "Steered.", toolCalls: [] };
    },
    consumeSteering: async () => modelInputs.length === 0 ? [] : pending.splice(0),
    onSteeringApplied: () => {
      resets += 1;
    },
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });

  assert.equal(result.message, "Steered.");
  assert.equal(modelInputs.length, 2);
  assert.deepEqual(modelInputs[1]?.messages, [{
    role: "user",
    content: "Keep the groove sparse and use the Lead track instead.",
  }]);
  assert.equal(resets, 1);
});

test("runAgentLoop discards the full pending continuation suffix before steering", async () => {
  const modelInputs: AgentLoopModelInput[] = [];
  let steeringAvailable = false;
  let steeringConsumed = false;

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    maxModelContinuations: 3,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (modelInputs.length <= 2) {
        return {
          content: `Obsolete partial ${modelInputs.length}.`,
          toolCalls: [],
          continuation: { reason: "output_limit" },
          providerState: {
            kind: "openai-responses",
            output: [{
              type: "function_call",
              call_id: `obsolete-partial-${modelInputs.length}`,
              name: "inspect_track",
              arguments: "{\"trackName\":\"Le",
              status: "incomplete",
            }],
          },
        };
      }
      return { content: "Followed the newer direction.", toolCalls: [] };
    },
    consumeSteering: async () => {
      if (!steeringAvailable || steeringConsumed) return [];
      steeringConsumed = true;
      return ["Stop that continuation and inspect the Drums track instead."];
    },
    hasPendingSteering: () => steeringAvailable && !steeringConsumed,
    observe: async () => "",
    confirmActions: async () => true,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onProgress: (message) => {
      if (message.includes("(2/3)")) steeringAvailable = true;
    },
  });

  assert.equal(result.message, "Followed the newer direction.");
  assert.equal(modelInputs.length, 3);
  assert.deepEqual(modelInputs[2]?.messages, [{
    role: "user",
    content: "Stop that continuation and inspect the Drums track instead.",
  }]);
});

test("runAgentLoop discards a completed obsolete tool turn before any tool can run", async () => {
  let steeringAvailable = false;
  let steeringConsumed = false;
  let preflightCount = 0;
  let confirmationCount = 0;
  let executionCount = 0;
  const modelInputs: AgentLoopModelInput[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        steeringAvailable = true;
        return {
          content: "I will delete the old clip.",
          toolCalls: [{
            id: "obsolete-apply",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Delete the old clip.",
              actions: [{ type: "delete_clip", trackName: "Drums", clipIndex: 0 }],
            }),
          }],
        };
      }
      return { content: "I kept the clip and changed direction.", toolCalls: [] };
    },
    consumeSteering: async () => {
      if (!steeringAvailable || steeringConsumed) return [];
      steeringConsumed = true;
      return ["Do not delete anything; keep the clip and inspect it instead."];
    },
    hasPendingSteering: () => steeringAvailable && !steeringConsumed,
    observe: async () => "",
    preflightActions: async () => {
      preflightCount += 1;
      return async () => {};
    },
    confirmActions: async () => {
      confirmationCount += 1;
      return true;
    },
    executeActions: async () => {
      executionCount += 1;
      return { results: [], mutationCount: 0 };
    },
  });

  assert.equal(result.message, "I kept the clip and changed direction.");
  assert.equal(preflightCount, 0);
  assert.equal(confirmationCount, 0);
  assert.equal(executionCount, 0);
  assert.deepEqual(modelInputs[1]?.messages, [{
    role: "user",
    content: "Do not delete anything; keep the clip and inspect it instead.",
  }]);
});

test("runAgentLoop completes the current tool result, skips the remaining batch, then steers", async () => {
  let steeringAvailable = false;
  let steeringConsumed = false;
  const observations: string[] = [];
  const modelInputs: AgentLoopModelInput[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "inspect-song",
              name: "inspect_song_info",
              arguments: "{}",
            },
            {
              id: "inspect-track",
              name: "inspect_track",
              arguments: JSON.stringify({ trackName: "Drums" }),
            },
          ],
        };
      }
      return { content: "Switched to the requested track.", toolCalls: [] };
    },
    consumeSteering: async () => {
      if (!steeringAvailable || steeringConsumed) return [];
      steeringConsumed = true;
      return ["Inspect Lead, not Drums."];
    },
    hasPendingSteering: () => steeringAvailable && !steeringConsumed,
    observe: async (request) => {
      observations.push(request.type);
      steeringAvailable = true;
      return "Tempo: 120 BPM";
    },
    confirmActions: async () => true,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });

  assert.equal(result.message, "Switched to the requested track.");
  assert.deepEqual(observations, ["inspect_song_info"]);
  assert.deepEqual(
    modelInputs[1]?.messages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"],
  );
  assert.match(
    modelInputs[1]?.messages[2]?.content ?? "",
    /not executed because a newer user steering message superseded this tool batch/i,
  );
});

test("runAgentLoop rechecks steering inside the mutation lock before applying", async () => {
  let steeringAvailable = false;
  let steeringConsumed = false;
  let executionCount = 0;
  const modelInputs: AgentLoopModelInput[] = [];

  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async (input): Promise<ModelTurn> => {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        return {
          content: null,
          toolCalls: [{
            id: "apply-tempo",
            name: "apply_live_actions",
            arguments: JSON.stringify({
              message: "Set tempo.",
              actions: [{ type: "set_tempo", tempo: 128 }],
            }),
          }],
        };
      }
      return { content: "Tempo was left unchanged.", toolCalls: [] };
    },
    consumeSteering: async () => {
      if (!steeringAvailable || steeringConsumed) return [];
      steeringConsumed = true;
      return ["Leave the tempo unchanged."];
    },
    hasPendingSteering: () => steeringAvailable && !steeringConsumed,
    observe: async () => "",
    preflightActions: async () => {
      return async () => {
        steeringAvailable = true;
      };
    },
    confirmActions: async () => ({
      confirmed: true,
      source: "automatic",
      mode: "everything",
    }),
    withActionExecutionLock: async (operation) => operation(),
    executeActions: async () => {
      executionCount += 1;
      return { results: ["Set tempo to 128 BPM."], mutationCount: 1 };
    },
  });

  assert.equal(result.message, "Tempo was left unchanged.");
  assert.equal(executionCount, 0);
  assert.equal(modelInputs.length, 2);
  assert.equal(modelInputs[1]?.messages.at(-1)?.role, "user");
});
