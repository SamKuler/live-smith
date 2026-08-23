import assert from "node:assert/strict";
import test from "node:test";

import type { ModelBackend, RuntimeProfile } from "../model/provider.js";
import { createHostAbortController } from "../runtime/host.js";
import { requestModelTurn } from "./model-request.js";

const runtimeProfile: RuntimeProfile = {
  profile: {
    id: "subscription",
    name: "Subscription",
    connection: { kind: "codex-subscription", provider: "openai" },
    model: "gpt-5.6-sol",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  },
  capabilities: {
    tools: true,
    streaming: false,
    temperature: "unsupported",
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

test("requestModelTurn dispatches through one explicit turn executor", async () => {
  let executorTurns = 0;
  const turnExecutor = {
    async createToolTurn(request: Parameters<ModelBackend["createToolTurn"]>[0]) {
      executorTurns += 1;
      assert.equal(request.runtimeProfile, runtimeProfile);
      return { content: "dispatched", toolCalls: [] };
    },
  };

  assert.deepEqual(await requestModelTurn({
    prompt: "Inspect the track",
    liveContext: "Track: Lead",
    runtimeProfile,
    history: [],
    agentMessages: [],
    tools: [],
    signal: createHostAbortController().signal,
    onDelta: () => undefined,
    turnExecutor,
  }), { content: "dispatched", toolCalls: [] });
  assert.equal(executorTurns, 1);
});
