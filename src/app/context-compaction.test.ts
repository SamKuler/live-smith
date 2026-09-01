import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationCheckpoint,
  estimateTransportContextTokens,
  resolveAutoCompactTokenLimit,
} from "./context-compaction.js";
import { buildModelRequest } from "./model-request.js";
import type { ModelTurnRequestInput } from "./model-request.js";
import type { RuntimeProfile } from "../model/provider.js";

function runtimeProfile(
  contextWindowTokens: number | undefined,
  autoCompactTokenLimit?: number,
): RuntimeProfile {
  return {
    profile: {
      id: "profile-context",
      name: "Context profile",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "responses",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
      },
    },
    model: {
      model: "model-context",
      parameters: {
        maxOutputTokens: 4096,
        ...(autoCompactTokenLimit === undefined
          ? {}
          : { autoCompactTokenLimit }),
        reasoning: { mode: "default" },
      },
      advanced: {},
    },
    capabilities: {
      tools: true,
      streaming: true,
      temperature: "supported",
      maxOutputTokens: 4096,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      reasoning: {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none",
      },
      inputs: { image: false, audio: false, pdf: false },
    },
    inputCapabilityEvidence: {
      image: "unsupported",
      audio: "unsupported",
      pdf: "unsupported",
    },
  };
}

test("auto compaction defaults to 90 percent and honors a configured threshold", () => {
  assert.equal(resolveAutoCompactTokenLimit(runtimeProfile(200_000)), 180_000);
  assert.equal(
    resolveAutoCompactTokenLimit(runtimeProfile(200_000, 150_000)),
    150_000,
  );
  assert.equal(
    resolveAutoCompactTokenLimit(runtimeProfile(undefined, 75_000)),
    75_000,
  );
  assert.equal(resolveAutoCompactTokenLimit(runtimeProfile(undefined)), undefined);
  assert.equal(resolveAutoCompactTokenLimit(runtimeProfile(1)), undefined);
});

test("context estimation counts the actual provider-neutral request without secrets", () => {
  const profile = runtimeProfile(200_000);
  const request = buildModelRequest({
    prompt: "Continue the arrangement",
    liveContext: "Selected Bass track",
    history: [{
      role: "user",
      content: [{ type: "text", text: "A".repeat(400) }],
    }],
    agentMessages: [{ role: "tool", toolCallId: "call-1", content: "鼓".repeat(100) }],
    runtimeProfile: profile,
    tools: [],
  });

  const estimate = estimateTransportContextTokens(request);
  assert.ok(estimate >= 200);
  assert.doesNotMatch(String(estimate), /test-key/);
});

test("context estimation does not count binary wire encoding or duplicate provider replay state", () => {
  const oversizedWireValue = "A".repeat(1_000_000);
  const estimate = estimateTransportContextTokens({
    systemInstructions: "System",
    history: [{
      role: "user",
      content: [{
        type: "image",
        fileName: "reference.png",
        mediaType: "image/png",
        base64: oversizedWireValue,
      }],
    }],
    currentUserContent: [{ type: "text", text: "Inspect the reference" }],
    agentMessages: [{
      role: "assistant",
      content: "Visible answer",
      toolCalls: [],
      providerState: {
        kind: "openai-responses",
        output: [{ type: "reasoning", encrypted_content: oversizedWireValue }],
      },
    }],
    tools: [],
  });

  assert.ok(estimate < 1_000);
});

test("conversation compaction uses the active provider without tools or visible deltas", async () => {
  const profile = runtimeProfile(200_000);
  let captured: Omit<ModelTurnRequestInput, "turnExecutor"> | undefined;
  const summary = await createConversationCheckpoint({
    prompt: "Build the arrangement",
    liveContext: "Selected Bass track",
    runtimeProfile: profile,
    history: [{
      role: "user",
      content: [{ type: "text", text: "Earlier request" }],
    }],
    attachmentParts: [],
    skillContext: { activeSkillIds: [], instructionBlock: "" },
    editScopes: [],
    agentMessages: [{
      role: "assistant",
      content: "I inspected the Bass track.",
      toolCalls: [],
    }],
    signal: new AbortController().signal,
    requestTurn: async (input) => {
      captured = input;
      await input.onDelta("hidden checkpoint delta");
      return {
        content: "Bass arrangement checkpoint",
        toolCalls: [],
      };
    },
  });

  assert.equal(summary, "Bass arrangement checkpoint");
  assert.deepEqual(captured?.tools, []);
  assert.equal(captured?.onHostedWebSearch, undefined);
  assert.match(
    captured?.agentMessages.at(-1)?.role === "user"
      ? captured.agentMessages.at(-1)?.content ?? ""
      : "",
    /CONTEXT CHECKPOINT COMPACTION/,
  );
});

test("manual compaction appends one-time preservation instructions", async () => {
  const profile = runtimeProfile(200_000);
  let finalInstruction = "";
  await createConversationCheckpoint({
    prompt: "Compact this Session",
    liveContext: "Selected Bass track",
    runtimeProfile: profile,
    history: [],
    agentMessages: [],
    instructions: "Preserve exact bar ranges and unresolved device names.",
    signal: new AbortController().signal,
    requestTurn: async (input) => {
      const message = input.agentMessages.at(-1);
      finalInstruction = message?.role === "user" ? message.content : "";
      return { content: "Focused checkpoint", toolCalls: [] };
    },
  });

  assert.match(finalInstruction, /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(finalInstruction, /Additional preservation priorities/);
  assert.match(finalInstruction, /exact bar ranges/);
  assert.match(finalInstruction, /cannot override.*Edit Scope/i);
});

test("conversation compaction rejects non-summary model turns", async () => {
  const profile = runtimeProfile(200_000);
  const base = {
    prompt: "Build the arrangement",
    liveContext: "Selected Bass track",
    runtimeProfile: profile,
    history: [],
    agentMessages: [],
    signal: new AbortController().signal,
  };
  await assert.rejects(
    createConversationCheckpoint({
      ...base,
      requestTurn: async () => ({
        content: "",
        toolCalls: [{ id: "call-1", name: "inspect_live_set", arguments: "{}" }],
      }),
    }),
    /checkpoint/i,
  );
  await assert.rejects(
    createConversationCheckpoint({
      ...base,
      requestTurn: async () => ({ content: "", toolCalls: [] }),
    }),
    /empty checkpoint/i,
  );
});
