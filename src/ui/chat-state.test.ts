import assert from "node:assert/strict";
import test from "node:test";

import {
  chatRuntimeSummary,
  serializeChatStateForHtml,
} from "./chat-state.js";

test("chatRuntimeSummary keeps Runtime display aligned without credentials", () => {
  const capabilities = {
    tools: true,
    streaming: true,
    temperature: "supported" as const,
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none" as const,
    },
  };
  const summary = chatRuntimeSummary({
    profile: {
      id: "p1",
      name: "Runtime",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret-key",
      model: "runtime-model",
      parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } },
      advanced: { extraBody: { secret: true } },
    },
    capabilities,
  });

  assert.deepEqual(summary, {
    profile: {
      id: "p1",
      name: "Runtime",
      apiFamily: "openai",
      apiMode: "responses",
      model: "runtime-model",
    },
    capabilities,
  });
  assert.equal("apiKey" in summary.profile, false);
  assert.equal("advanced" in summary.profile, false);
});

test("serializeChatStateForHtml escapes script-breaking characters", () => {
  const serialized = serializeChatStateForHtml({
    defaultPrompt: "<script>&\u2028\u2029",
    contextSummary: "",
    sessions: [],
    recoverableSessions: [],
    activeSessionId: "",
    events: [],
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
    },
    availableModels: [],
    modelStateSource: null,
    runtimeProfile: null,
    settings: {
      schemaVersion: 1,
      activeProfileId: null,
      autoApprove: false,
      profiles: [],
    },
    openSettingsOnLoad: false,
  });

  assert.match(serialized, /\\u003Cscript\\u003E/);
  assert.match(serialized, /\\u0026/);
  assert.match(serialized, /\\u2028/);
  assert.match(serialized, /\\u2029/);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/);
});
