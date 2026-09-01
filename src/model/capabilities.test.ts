import assert from "node:assert/strict";
import test from "node:test";

import type {
  DirectApiConnection,
  GenerationParameters,
  ModelAdvancedSettings,
} from "./profile.js";
import type { RuntimeModelSource } from "./provider.js";
import {
  defaultModelCapabilities,
  resolveModelCapabilities,
  resolveModelCapabilitiesWithEvidence,
  validateGenerationParameters,
} from "./capabilities.js";

type DirectModeOverrides =
  | {
      apiFamily?: "openai";
      apiMode?: "responses" | "chat-completions";
    }
  | {
      apiFamily: "anthropic";
      apiMode: "messages";
    };

type ProfileOverrides = Partial<{
  id: string;
  name: string;
  model: string;
  parameters: GenerationParameters & { maxOutputTokens: number };
  advanced: ModelAdvancedSettings;
}> &
  DirectModeOverrides & {
    baseUrl?: string;
    apiKey?: string;
  };

function profile(overrides: ProfileOverrides = {}): RuntimeModelSource {
  const {
    apiFamily,
    apiMode,
    baseUrl = "https://example.test/v1",
    apiKey = "key",
    ...fields
  } = overrides;
  const connection: DirectApiConnection = apiFamily === "anthropic"
    ? {
        kind: "direct-api",
        apiFamily: "anthropic",
        apiMode: "messages",
        baseUrl,
        apiKey,
      }
    : {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: apiMode ?? "responses",
        baseUrl,
        apiKey,
      };
  return {
    profile: {
      id: fields.id ?? "p1",
      name: fields.name ?? "Profile",
      connection,
    },
    model: {
      model: fields.model ?? "unknown-model",
      parameters: fields.parameters ?? {
        maxOutputTokens: 4096,
        temperature: 0.3,
        reasoning: { mode: "default" },
      },
      advanced: fields.advanced ?? {},
    },
  };
}

function subscriptionProfile(
  provider: "openai" | "anthropic" = "openai",
): RuntimeModelSource {
  return {
    profile: {
      id: "subscription",
      name: `${provider} subscription`,
      connection: { kind: "oauth-subscription", provider },
    },
    model: {
      model: provider === "openai" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
      parameters: {
        reasoning: { mode: "default" },
      },
      advanced: {},
    },
  };
}

test("unknown models use conservative mode capabilities", () => {
  const capabilities = defaultModelCapabilities();
  assert.equal(capabilities.tools, true);
  assert.equal(capabilities.reasoning.supported, false);
  assert.equal(capabilities.temperature, "supported");
  assert.equal(capabilities.maxOutputTokens, undefined);
  assert.equal(capabilities.contextWindowTokens, undefined);
  assert.deepEqual(capabilities.inputs, {
    image: false,
    audio: false,
    pdf: false,
  });
});

test("capability evidence distinguishes conservative fallback from explicit support", () => {
  const fallback = resolveModelCapabilitiesWithEvidence(profile());
  assert.deepEqual(fallback.capabilityEvidence, {
    temperature: "unverified",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "unverified",
    inputs: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  });

  const discovered = resolveModelCapabilitiesWithEvidence(profile(), {
    temperature: "unsupported",
    maxOutputTokens: 32_000,
    contextWindowTokens: 200_000,
    reasoning: {
      supported: false,
    },
    inputs: { image: true, audio: false },
  });
  assert.deepEqual(discovered.capabilityEvidence, {
    temperature: "unsupported",
    maxOutputTokens: "verified",
    contextWindowTokens: "verified",
    reasoning: "unsupported",
    inputs: {
      image: "supported",
      audio: "unsupported",
      pdf: "unverified",
    },
  });
});

test("configured context windows override model metadata without claiming provider evidence", () => {
  const direct = profile({
    parameters: {
      maxOutputTokens: 4096,
      contextWindowTokens: 240_000,
      autoCompactTokenLimit: 180_000,
      reasoning: { mode: "default" },
    },
  });
  const directResolved = resolveModelCapabilitiesWithEvidence(direct, {
    contextWindowTokens: 200_000,
  });
  assert.equal(directResolved.capabilities.contextWindowTokens, 240_000);
  assert.equal(
    directResolved.capabilityEvidence.contextWindowTokens,
    "configured",
  );

  const subscription = subscriptionProfile();
  subscription.model.parameters.contextWindowTokens = 180_000;
  subscription.model.parameters.autoCompactTokenLimit = 140_000;
  const subscriptionResolved = resolveModelCapabilitiesWithEvidence(
    subscription,
    { contextWindowTokens: 160_000 },
  );
  assert.equal(subscriptionResolved.capabilities.contextWindowTokens, 180_000);
  assert.equal(
    subscriptionResolved.capabilityEvidence.contextWindowTokens,
    "configured",
  );
});

test("runtime validation keeps auto compaction below a discovered context window", () => {
  const source = profile({
    parameters: {
      maxOutputTokens: 4096,
      autoCompactTokenLimit: 200_000,
      reasoning: { mode: "default" },
    },
  });
  const capabilities = resolveModelCapabilities(source, {
    contextWindowTokens: 200_000,
  });
  assert.throws(
    () => validateGenerationParameters(source, capabilities),
    /below the context window/i,
  );
});

test("manual overrides update capability evidence after discovery", () => {
  const resolved = resolveModelCapabilitiesWithEvidence(profile({
    advanced: {
      capabilityOverrides: {
        temperature: "supported",
        maxOutputTokens: 64_000,
        reasoning: { supported: true },
        inputs: { image: false },
      },
    },
  }), {
    temperature: "unsupported",
    maxOutputTokens: 32_000,
    reasoning: { supported: false },
    inputs: { image: true },
  });

  assert.deepEqual(resolved.capabilityEvidence, {
    temperature: "supported",
    maxOutputTokens: "verified",
    contextWindowTokens: "unverified",
    reasoning: "supported",
    inputs: {
      image: "unsupported",
      audio: "unverified",
      pdf: "unverified",
    },
  });
});

test("only the documented GPT-5.6 family receives a known context window", () => {
  for (const model of [
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]) {
    const resolved = resolveModelCapabilitiesWithEvidence(profile({ model }));
    assert.equal(resolved.capabilities.contextWindowTokens, 1_050_000, model);
    assert.equal(resolved.capabilityEvidence.contextWindowTokens, "verified", model);
  }

  for (const model of [
    "gpt-5.6-custom",
    "gpt-5.5",
    "gpt-5.4",
    "unknown-model",
  ]) {
    const resolved = resolveModelCapabilitiesWithEvidence(profile({ model }));
    assert.equal(resolved.capabilities.contextWindowTokens, undefined, model);
    assert.equal(resolved.capabilityEvidence.contextWindowTokens, "unverified", model);
  }
});

test("OAuth subscription capabilities require signed-in provider evidence", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const unresolved = resolveModelCapabilitiesWithEvidence(
      subscriptionProfile(provider),
    );
    assert.equal(unresolved.capabilities.streaming, true, provider);
    assert.equal(unresolved.capabilities.reasoning.supported, false, provider);
    assert.equal(unresolved.capabilities.inputs.image, false, provider);
    assert.equal(unresolved.capabilityEvidence.reasoning, "unverified", provider);
    assert.equal(
      unresolved.capabilityEvidence.inputs.image,
      "unverified",
      provider,
    );
  }

  const discovered = resolveModelCapabilitiesWithEvidence(
    subscriptionProfile(),
    {
      streaming: false,
      temperature: "unsupported",
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["low", "high"],
        budgetTokens: false,
        strategy: "effort",
      },
      inputs: { image: true, audio: true, pdf: false },
    },
  );
  assert.deepEqual(discovered.capabilities.inputs, {
    image: true,
    audio: true,
    pdf: false,
  });
  assert.equal(discovered.capabilityEvidence.inputs.audio, "supported");
});

test("input capabilities merge discovery and partial overrides without model-name guesses", () => {
  const nameOnly = resolveModelCapabilities(profile({ model: "gpt-5.6" }));
  assert.deepEqual(nameOnly.inputs, { image: false, audio: false, pdf: false });

  const discovered = resolveModelCapabilities(profile(), {
    inputs: { image: true, pdf: true },
  });
  assert.deepEqual(discovered.inputs, { image: true, audio: false, pdf: true });

  const overridden = resolveModelCapabilities(profile({
    model: "gpt-5.6",
    advanced: {
      capabilityOverrides: {
        inputs: { image: false, audio: true },
      },
    },
  }), {
    inputs: { pdf: true },
  });
  assert.deepEqual(overridden.inputs, { image: false, audio: true, pdf: true });
});

test("input capability evidence follows overrides and discovery, not model names", () => {
  const fallback = resolveModelCapabilitiesWithEvidence(profile());
  assert.equal(fallback.capabilities.inputs.image, false);
  assert.equal(fallback.capabilityEvidence.inputs.image, "unverified");

  const nameOnly = resolveModelCapabilitiesWithEvidence(
    profile({ model: "gpt-5.6" }),
  );
  assert.equal(nameOnly.capabilities.inputs.image, false);
  assert.equal(nameOnly.capabilityEvidence.inputs.image, "unverified");

  const discovered = resolveModelCapabilitiesWithEvidence(
    profile({ model: "gpt-5.6" }),
    { inputs: { image: false, pdf: true } },
  );
  assert.equal(discovered.capabilities.inputs.image, false);
  assert.deepEqual(discovered.capabilityEvidence.inputs, {
    image: "unsupported",
    audio: "unverified",
    pdf: "supported",
  });

  const overridden = resolveModelCapabilitiesWithEvidence(
    profile({
      model: "gpt-5.6",
      advanced: {
        capabilityOverrides: { inputs: { image: true, pdf: false } },
      },
    }),
    { inputs: { image: false, pdf: true } },
  );
  assert.deepEqual(overridden.capabilities.inputs, {
    image: true,
    audio: false,
    pdf: false,
  });
  assert.deepEqual(overridden.capabilityEvidence.inputs, {
    image: "supported",
    audio: "unverified",
    pdf: "unsupported",
  });
});

test("model names never authorize binary input without evidence", () => {
  for (const model of [
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.2-codex-2025-12-11",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-20260301",
    "claude-haiku-4-5-20251001",
  ]) {
    const anthropic = model.startsWith("claude-");
    assert.equal(resolveModelCapabilities(profile({
      ...(anthropic
        ? { apiFamily: "anthropic", apiMode: "messages" }
        : {}),
      model,
    })).inputs.image, false, model);
  }
});

test("unknown output limits do not cap requests while explicit limits still do", () => {
  const unknown = profile({
    parameters: {
      maxOutputTokens: 64_000,
      reasoning: { mode: "default" },
    },
  });
  assert.doesNotThrow(() =>
    validateGenerationParameters(unknown, resolveModelCapabilities(unknown))
  );

  const aboveDiscoveredLimit = profile({
    parameters: {
      maxOutputTokens: 64_001,
      reasoning: { mode: "default" },
    },
  });
  assert.throws(
    () => validateGenerationParameters(
      aboveDiscoveredLimit,
      resolveModelCapabilities(aboveDiscoveredLimit, { maxOutputTokens: 64_000 }),
    ),
    /limit of 64000/,
  );
});

test("known model policy supplies protocol-independent reasoning capabilities", () => {
  const capabilities = resolveModelCapabilities(profile({ model: "gpt-5.6" }));
  assert.equal(capabilities.reasoning.supported, true);
  assert.equal(capabilities.reasoning.canDisable, true);
  assert.deepEqual(capabilities.reasoning.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(capabilities.temperature, "unsupported");
});

test("known OpenAI model policies advertise only documented reasoning controls", () => {
  const cases = [
    ["gpt-5", false, ["minimal", "low", "medium", "high"]],
    ["gpt-5-2025-08-07", false, ["minimal", "low", "medium", "high"]],
    ["gpt-5.1", true, ["low", "medium", "high"]],
    ["gpt-5.2", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.2-codex", false, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.2-pro", false, ["medium", "high", "xhigh"]],
    ["gpt-5.3-codex", false, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-mini", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-mini-2026-03-17", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-nano", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-nano-2026-03-17", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-pro", false, ["medium", "high", "xhigh"]],
    ["gpt-5.5", true, ["low", "medium", "high", "xhigh"]],
    ["gpt-5.5-pro", false, ["medium", "high", "xhigh"]],
    ["gpt-5.6-terra", true, ["low", "medium", "high", "xhigh", "max"]],
  ] as const;

  for (const [model, canDisable, efforts] of cases) {
    const capabilities = resolveModelCapabilities(profile({ model }));
    assert.equal(capabilities.reasoning.canDisable, canDisable, model);
    assert.deepEqual(capabilities.reasoning.efforts, efforts, model);
  }

  assert.equal(
    resolveModelCapabilities(profile({ model: "gpt-5.4-pro" })).streaming,
    true,
  );
  assert.equal(
    resolveModelCapabilities(profile({ model: "gpt-5.5-pro" })).streaming,
    false,
  );
});

test("current OpenAI known policy survives discovery records without reasoning metadata", () => {
  for (const [model, canDisable] of [
    ["gpt-5.3-codex", false],
    ["gpt-5.4-mini", true],
    ["gpt-5.4-nano", true],
  ] as const) {
    const p = profile({
      model,
      parameters: {
        maxOutputTokens: 128_000,
        reasoning: { mode: "enabled", effort: "xhigh" },
      },
    });
    const capabilities = resolveModelCapabilities(p, { tools: true, streaming: true });
    assert.equal(capabilities.maxOutputTokens, 128_000, model);
    assert.equal(capabilities.reasoning.supported, true, model);
    assert.equal(capabilities.reasoning.canDisable, canDisable, model);
    assert.deepEqual(
      capabilities.reasoning.efforts,
      ["low", "medium", "high", "xhigh"],
      model,
    );
    assert.doesNotThrow(() => validateGenerationParameters(p, capabilities), model);
  }
});

test("known Claude policies match current output, sampling, and thinking controls", () => {
  const cases = [
    ["claude-opus-4-6", 128_000, true, ["low", "medium", "high", "max"], "adaptive-thinking", "supported"],
    ["claude-sonnet-4-6-20260301", 128_000, true, ["low", "medium", "high", "max"], "adaptive-thinking", "supported"],
    ["claude-opus-4-7", 128_000, true, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-opus-4-8", 128_000, true, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-opus-5", 128_000, true, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-sonnet-5", 128_000, true, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-fable-5", 128_000, false, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-mythos-5", 128_000, false, ["low", "medium", "high", "xhigh", "max"], "adaptive-thinking", "unsupported"],
    ["claude-haiku-4-5", 64_000, true, [], "budget-thinking", "supported"],
    ["claude-haiku-4-5-20251001", 64_000, true, [], "budget-thinking", "supported"],
  ] as const;

  for (const [model, maxOutputTokens, canDisable, efforts, strategy, temperature] of cases) {
    const capabilities = resolveModelCapabilities(profile({
      apiFamily: "anthropic",
      apiMode: "messages",
      model,
    }));
    assert.equal(capabilities.maxOutputTokens, maxOutputTokens, model);
    assert.equal(capabilities.reasoning.canDisable, canDisable, model);
    assert.deepEqual(capabilities.reasoning.efforts, efforts, model);
    assert.equal(capabilities.reasoning.strategy, strategy, model);
    assert.equal(capabilities.temperature, temperature, model);
  }
});

test("Claude Opus 4.5 supports budget thinking with low, medium, and high effort", () => {
  const capabilities = resolveModelCapabilities(profile({
    apiFamily: "anthropic",
    apiMode: "messages",
    model: "claude-opus-4-5",
  }));
  assert.equal(capabilities.maxOutputTokens, 64_000);
  assert.equal(capabilities.reasoning.budgetTokens, true);
  assert.deepEqual(capabilities.reasoning.efforts, ["low", "medium", "high"]);
  assert.equal(capabilities.reasoning.strategy, "budget-thinking");
});

test("Claude Haiku 4.5 validates manual thinking budgets", () => {
  const haiku = (budgetTokens: number): RuntimeModelSource => profile({
    apiFamily: "anthropic",
    apiMode: "messages",
    model: "claude-haiku-4-5",
    parameters: {
      maxOutputTokens: 4096,
      reasoning: { mode: "enabled", budgetTokens },
    },
  });
  const invalid = haiku(1023);
  assert.throws(
    () => validateGenerationParameters(invalid, resolveModelCapabilities(invalid)),
    /at least 1024/,
  );
  const valid = haiku(1024);
  assert.doesNotThrow(() =>
    validateGenerationParameters(valid, resolveModelCapabilities(valid))
  );
});

test("manual capability overrides win over discovery and known policy", () => {
  const capabilities = resolveModelCapabilities(
    profile({
      model: "gpt-5.6",
      advanced: {
        capabilityOverrides: {
          temperature: "supported",
          reasoning: { efforts: ["high"] },
        },
      },
    }),
    {
      tools: false,
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["medium"],
        budgetTokens: false,
        strategy: "effort",
      },
    },
  );
  assert.equal(capabilities.tools, false);
  assert.equal(capabilities.temperature, "supported");
  assert.deepEqual(capabilities.reasoning.efforts, ["high"]);
});

test("generation validation rejects unsupported explicit reasoning and temperature", () => {
  const unknown = profile({
    parameters: {
      maxOutputTokens: 4096,
      temperature: 0.3,
      reasoning: { mode: "enabled", effort: "high" },
    },
  });
  assert.throws(
    () => validateGenerationParameters(unknown, resolveModelCapabilities(unknown)),
    /does not support explicit reasoning/,
  );

  const known = profile({ model: "gpt-5.6" });
  assert.throws(
    () => validateGenerationParameters(known, resolveModelCapabilities(known)),
    /does not support temperature/,
  );
});

test("generation validation enforces explicit and default thinking budget space", () => {
  const withReasoning = (
    maxOutputTokens: number,
    budgetTokens?: number,
  ): RuntimeModelSource => profile({
    apiFamily: "anthropic",
    apiMode: "messages",
    model: "claude-opus-4-5",
    parameters: {
      maxOutputTokens,
      reasoning: {
        mode: "enabled",
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
      },
    },
  });

  for (const [candidate, message] of [
    [withReasoning(4096, 1023), /at least 1024/],
    [withReasoning(4096, 4096), /below max output tokens/],
    [withReasoning(2047), /default thinking budget.*at least 1024/i],
  ] as const) {
    assert.throws(
      () => validateGenerationParameters(candidate, resolveModelCapabilities(candidate)),
      message,
    );
  }

  const valid = withReasoning(1025, 1024);
  assert.doesNotThrow(() =>
    validateGenerationParameters(valid, resolveModelCapabilities(valid))
  );
});

test("OAuth generation accepts catalog-owned budget thinking without persisted output settings", () => {
  const source: RuntimeModelSource = {
    profile: {
      id: "google-subscription",
      name: "Gemini",
      connection: { kind: "oauth-subscription", provider: "google" },
    },
    model: {
      model: "gemini-2.5-pro",
      parameters: {
        reasoning: { mode: "enabled", effort: "medium" },
      },
      advanced: {},
    },
  };
  assert.doesNotThrow(() => validateGenerationParameters(source, {
    tools: true,
    streaming: true,
    temperature: "supported",
    maxOutputTokens: 65_535,
    reasoning: {
      supported: true,
      canDisable: false,
      efforts: ["minimal", "low", "medium", "high"],
      budgetTokens: false,
      strategy: "budget-thinking",
    },
    inputs: { image: true, audio: false, pdf: false },
  }));
});
