import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeModelSource, RuntimeProfile } from "./provider.js";
import {
  HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
  modelToolsForProfile,
  supportsAudioInputDelivery,
} from "./tools.js";

function profile(enabled: boolean): RuntimeModelSource {
  return {
    profile: {
      id: "profile",
      name: "Profile",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "responses",
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
      },
    },
    model: {
      model: "model",
      parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } },
      advanced: enabled ? { hostedTools: { webSearch: true } } : {},
    },
  };
}

test("model tools append hosted Web Search only for an opted-in Profile", () => {
  const clientTool = {
    type: "function" as const,
    function: { name: "inspect", description: "Inspect" },
  };
  assert.deepEqual(modelToolsForProfile(profile(false), [clientTool]), [clientTool]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool]), [
    clientTool,
    {
      type: "hosted_web_search",
      maxUses: HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
    },
  ]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool], 2), [
    clientTool,
    { type: "hosted_web_search", maxUses: 2 },
  ]);
  assert.deepEqual(modelToolsForProfile(profile(true), [clientTool], 0), [
    clientTool,
  ]);
  for (const invalid of [-1, 1.5, HOSTED_WEB_SEARCH_REQUEST_MAX_USES + 1]) {
    assert.throws(
      () => modelToolsForProfile(profile(true), [clientTool], invalid),
      /request limit is invalid/,
    );
  }
});

test("tool-produced audio follows verified protocol capability rather than model names", () => {
  const runtime = (
    connection: RuntimeModelSource["profile"]["connection"],
    audio: boolean,
    evidence: "supported" | "unsupported" | "unverified",
  ): RuntimeProfile => ({
    profile: { id: "profile", name: "Profile", connection },
    model: {
      model: "arbitrary-model",
      parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" as const } },
      advanced: {},
    },
    capabilities: {
      tools: true,
      streaming: false,
      temperature: "unsupported" as const,
      reasoning: {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none" as const,
      },
      inputs: { image: false, audio, pdf: false },
    },
    inputCapabilityEvidence: {
      image: "unsupported" as const,
      audio: evidence,
      pdf: "unsupported" as const,
    },
  } as RuntimeProfile);
  const chat = {
    kind: "direct-api" as const,
    apiFamily: "openai" as const,
    apiMode: "chat-completions" as const,
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
  };
  const responses = { ...chat, apiMode: "responses" as const };
  const subscription = {
    kind: "codex-subscription" as const,
    provider: "openai" as const,
  };

  assert.equal(supportsAudioInputDelivery(runtime(chat, true, "supported")), true);
  assert.equal(supportsAudioInputDelivery(runtime(subscription, true, "supported")), true);
  assert.equal(supportsAudioInputDelivery(runtime(responses, true, "supported")), false);
  assert.equal(supportsAudioInputDelivery(runtime(chat, false, "supported")), false);
  assert.equal(supportsAudioInputDelivery(runtime(chat, true, "unverified")), false);
});
