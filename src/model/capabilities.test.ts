import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "./profile.js";
import {
  defaultModelCapabilities,
  resolveModelCapabilities,
  validateGenerationParameters,
} from "./capabilities.js";

function profile(overrides: Partial<SavedProfile> = {}): SavedProfile {
  return {
    id: "p1",
    name: "Profile",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "unknown-model",
    parameters: {
      maxOutputTokens: 4096,
      temperature: 0.3,
      reasoning: { mode: "default" },
    },
    advanced: {},
    ...overrides,
  };
}

test("unknown models use conservative mode capabilities", () => {
  const capabilities = defaultModelCapabilities();
  assert.equal(capabilities.tools, true);
  assert.equal(capabilities.reasoning.supported, false);
  assert.equal(capabilities.temperature, "supported");
  assert.equal(capabilities.maxOutputTokens, undefined);
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
  const haiku = (budgetTokens: number): SavedProfile => profile({
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
  ): SavedProfile => profile({
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
