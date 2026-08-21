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
    parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
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

test("requestModelTurn consumes a reserved turn instead of the raw backend", async () => {
  let backendTurns = 0;
  let reservedTurns = 0;
  const backend: ModelBackend = {
    kind: "codex-subscription",
    async listModels() { return []; },
    async createToolTurn() {
      backendTurns += 1;
      return { content: "wrong path", toolCalls: [] };
    },
    async close() {},
  };
  const reservation = {
    async createToolTurn(request: Parameters<ModelBackend["createToolTurn"]>[0]) {
      reservedTurns += 1;
      assert.equal(request.runtimeProfile, runtimeProfile);
      return { content: "reserved", toolCalls: [] };
    },
    async release() {},
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
    backend,
    turnReservation: reservation,
  }), { content: "reserved", toolCalls: [] });
  assert.equal(reservedTurns, 1);
  assert.equal(backendTurns, 0);
});
