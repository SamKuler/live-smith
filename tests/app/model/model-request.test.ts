import assert from "node:assert/strict";
import test from "node:test";

import type { ModelBackend, RuntimeProfile } from "../../../src/model/provider.js";
import type { SavedProfile } from "../../../src/model/profile.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import {
  buildModelRequest,
  requestModelTurn,
  runtimeProfileForSavedProfile,
} from "../../../src/app/model/model-request.js";

const runtimeProfile: RuntimeProfile = {
  profile: {
    id: "subscription",
    name: "Subscription",
    connection: { kind: "oauth-subscription", provider: "openai" },
  },
  model: {
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
  const reconnectState = {};
  const turnExecutor = {
    async createToolTurn(request: Parameters<ModelBackend["createToolTurn"]>[0]) {
      executorTurns += 1;
      assert.equal(request.runtimeProfile, runtimeProfile);
      assert.equal(request.reconnectState, reconnectState);
      assert.match(request.systemInstructions, /current request audio input 1/i);
      assert.doesNotMatch(JSON.stringify(request.currentUserContent), /event-current/);
      return { content: "dispatched", toolCalls: [] };
    },
  };

  assert.deepEqual(await requestModelTurn({
    prompt: "Inspect the track",
    liveContext: "Track: Lead",
    runtimeProfile,
    requestAudioSampleSourceInstructions:
      'Current request audio input 1: {"kind":"request_audio_attachment","requestId":"event-current","audioIndex":0}',
    history: [],
    agentMessages: [],
    tools: [],
    reconnectState,
    signal: createHostAbortController().signal,
    onDelta: () => undefined,
    turnExecutor,
  }), { content: "dispatched", toolCalls: [] });
  assert.equal(executorTurns, 1);
});

test("buildModelRequest includes one request-snapshot Custom Instructions block only in system instructions", () => {
  const customInstructions = "Make editable MIDI unless I ask for rendered audio.";
  const request = buildModelRequest({
    prompt: "Build a track",
    liveContext: "Empty Set",
    runtimeProfile,
    history: [],
    agentMessages: [],
    tools: [],
    customInstructions,
  });
  assert.equal(request.systemInstructions.split(JSON.stringify(customInstructions)).length - 1, 1);
  assert.ok(!JSON.stringify(request.currentUserContent).includes(customInstructions));
  assert.ok(!JSON.stringify(request.history).includes(customInstructions));
  assert.ok(!JSON.stringify(request.agentMessages).includes(customInstructions));
});

test("runtime materialization selects one configured model without mutating the Profile", () => {
  const profile: SavedProfile = {
    id: "direct",
    name: "Direct",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    },
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: {
          maxOutputTokens: 4096,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "enabled", effort: "low" },
        },
        advanced: { capabilityOverrides: { reasoning: {
          supported: true,
          efforts: ["low", "high"],
          strategy: "effort",
        } } },
      },
    ],
  };

  const runtime = runtimeProfileForSavedProfile(profile, [], {
    model: "model-b",
    reasoningEffort: "high",
  });

  assert.deepEqual(Object.keys(runtime.profile).sort(), [
    "connection",
    "id",
    "name",
  ]);
  assert.equal(runtime.model.model, "model-b");
  assert.deepEqual(runtime.model.parameters.reasoning, {
    mode: "enabled",
    effort: "high",
  });
  assert.deepEqual(profile.models[1]?.parameters.reasoning, {
    mode: "enabled",
    effort: "low",
  });
  assert.equal(runtime.capabilities.reasoning.supported, true);
});

test("runtime materialization rejects a model outside the saved Profile", () => {
  const profile: SavedProfile = {
    id: "subscription",
    name: "Subscription",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };

  assert.throws(
    () => runtimeProfileForSavedProfile(profile, [], { model: "model-b" }),
    /not configured in this Profile/,
  );
});


test("saved creative intent is separate from history and fresh Live facts in every model request", () => {
  const creativeBrief = "Style: minimal house\nKeep: original vocal";
  const request = buildModelRequest({ prompt: "Arrange the bridge", liveContext: "Tempo: 123; meter: 7/8",
    runtimeProfile, history: [{ role: "user", content: [{ type: "text", text: "Checkpoint omitting preferences" }] }],
    agentMessages: [], tools: [], creativeBrief });
  const text = request.currentUserContent.find((part) => part.type === "text");
  assert.ok(text?.type === "text");
  assert.ok(text.text.includes(JSON.stringify(creativeBrief)));
  assert.ok(text.text.includes(JSON.stringify("Tempo: 123; meter: 7/8")));
  assert.equal(JSON.stringify(request.history).includes("original vocal"), false);
  assert.equal(request.systemInstructions.includes("original vocal"), false);
  const otherSession = buildModelRequest({ prompt: "Inspect", liveContext: "Tempo: 98", runtimeProfile,
    history: [], agentMessages: [], tools: [] });
  assert.equal(JSON.stringify(otherSession).includes("original vocal"), false);
});
