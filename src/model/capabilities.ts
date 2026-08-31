import type {
  InputCapabilities,
  InputCapabilityEvidence,
  ModelCapabilitySource,
  ModelCapabilityEvidence,
  ModelCapabilities,
  ModelCapabilityHints,
  ReasoningCapabilities,
  RuntimeModelSource,
} from "./provider.js";
import { isDirectRuntimeModelSource } from "./provider.js";
import {
  ProfileValidationError,
  type ModelCapabilityOverrides,
} from "./profile.js";

const noReasoning: ReasoningCapabilities = {
  supported: false,
  canDisable: false,
  efforts: [],
  budgetTokens: false,
  strategy: "none",
};

const gpt56ContextWindowModels = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function defaultModelCapabilities(): ModelCapabilities {
  return {
    tools: true,
    streaming: true,
    temperature: "supported",
    reasoning: { ...noReasoning },
    inputs: { image: false, audio: false, pdf: false },
  };
}

function runtimeProvider(
  source: ModelCapabilitySource,
): "openai" | "anthropic" | "google" {
  return source.profile.connection.kind === "direct-api"
    ? source.profile.connection.apiFamily
    : source.profile.connection.provider;
}

function knownCapabilitiesForModel(
  source: ModelCapabilitySource,
): ModelCapabilityHints | undefined {
  const model = source.model.model.toLocaleLowerCase();

  if (runtimeProvider(source) === "openai") {
    if (/^gpt-5\.6(?:-|$)/.test(model)) {
      return {
        ...reasoningPolicy(
          ["low", "medium", "high", "xhigh", "max"],
          true,
          128_000,
        ),
        ...(gpt56ContextWindowModels.has(model)
          ? { contextWindowTokens: 1_050_000 }
          : {}),
      };
    }
    if (isBaseModelOrSnapshot(model, "gpt-5.5-pro")) {
      return {
        ...reasoningPolicy(["medium", "high", "xhigh"], false, 128_000),
        streaming: false,
      };
    }
    if (isBaseModelOrSnapshot(model, "gpt-5.4-pro")) {
      return reasoningPolicy(["medium", "high", "xhigh"], false, 128_000);
    }
    if (
      isBaseModelOrSnapshot(model, "gpt-5.4-mini") ||
      isBaseModelOrSnapshot(model, "gpt-5.4-nano")
    ) {
      return reasoningPolicy(
        ["low", "medium", "high", "xhigh"],
        true,
        128_000,
      );
    }
    if (
      isBaseModelOrSnapshot(model, "gpt-5.5") ||
      isBaseModelOrSnapshot(model, "gpt-5.4")
    ) {
      return reasoningPolicy(
        ["low", "medium", "high", "xhigh"],
        true,
        128_000,
      );
    }
    if (isBaseModelOrSnapshot(model, "gpt-5.3-codex")) {
      return reasoningPolicy(["low", "medium", "high", "xhigh"], false, 128_000);
    }
    if (/^gpt-5\.2-pro(?:-|$)/.test(model)) {
      return reasoningPolicy(["medium", "high", "xhigh"], false, 128_000);
    }
    if (/^gpt-5\.2-codex(?:-|$)/.test(model)) {
      return reasoningPolicy(["low", "medium", "high", "xhigh"], false, 128_000);
    }
    if (isBaseModelOrSnapshot(model, "gpt-5.2")) {
      return reasoningPolicy(["low", "medium", "high", "xhigh"], true, 128_000);
    }
    if (isBaseModelOrSnapshot(model, "gpt-5.1")) {
      return reasoningPolicy(["low", "medium", "high"], true, 128_000);
    }
    if (isBaseModelOrSnapshot(model, "gpt-5")) {
      return reasoningPolicy(["minimal", "low", "medium", "high"], false, 128_000);
    }
    return undefined;
  }

  if (runtimeProvider(source) === "google") return undefined;

  if (/^claude-(?:fable|mythos)-5(?:-|$)/.test(model)) {
    return anthropicAdaptiveThinkingPolicy(
      ["low", "medium", "high", "xhigh", "max"],
      false,
      true,
    );
  }
  if (
    /^claude-opus-(?:4-[78]|5)(?:-|$)/.test(model) ||
    /^claude-sonnet-5(?:-|$)/.test(model)
  ) {
    return anthropicAdaptiveThinkingPolicy(
      ["low", "medium", "high", "xhigh", "max"],
      true,
      true,
    );
  }
  if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(model)) {
    return anthropicAdaptiveThinkingPolicy(
      ["low", "medium", "high", "max"],
      true,
      false,
    );
  }
  if (/^claude-opus-4-5(?:-|$)/.test(model)) {
    return {
      maxOutputTokens: 64_000,
      reasoning: {
        supported: true,
        canDisable: true,
        efforts: ["low", "medium", "high"],
        budgetTokens: true,
        strategy: "budget-thinking",
      },
    };
  }
  if (/^claude-haiku-4-5(?:-|$)/.test(model)) {
    return {
      maxOutputTokens: 64_000,
      reasoning: {
        supported: true,
        canDisable: true,
        efforts: [],
        budgetTokens: true,
        strategy: "budget-thinking",
      },
    };
  }
  if (/^claude-(?:opus|sonnet)-4-[05](?:-|$)/.test(model)) {
    return {
      maxOutputTokens: 64_000,
      reasoning: {
        supported: true,
        canDisable: true,
        efforts: [],
        budgetTokens: true,
        strategy: "budget-thinking",
      },
    };
  }
  return undefined;
}

export function resolveModelCapabilities(
  source: ModelCapabilitySource,
  discovered?: ModelCapabilityHints,
): ModelCapabilities {
  return resolveModelCapabilitiesWithEvidence(source, discovered).capabilities;
}

export function resolveModelCapabilitiesWithEvidence(
  source: ModelCapabilitySource,
  discovered?: ModelCapabilityHints,
): {
  capabilities: ModelCapabilities;
  capabilityEvidence: ModelCapabilityEvidence;
} {
  const fallback = defaultModelCapabilities();
  const useKnownDirectPolicy = source.profile.connection.kind === "direct-api";
  const known = useKnownDirectPolicy
    ? knownCapabilitiesForModel(source)
    : undefined;
  const withKnown = mergeCapabilities(fallback, known);
  const capabilityEvidence = defaultModelCapabilityEvidence();
  applyCapabilityEvidence(capabilityEvidence, known);
  const withDiscovered = mergeCapabilities(withKnown, discovered);
  applyCapabilityEvidence(capabilityEvidence, discovered);
  const overrides = source.model.advanced.capabilityOverrides;
  const capabilities = mergeCapabilityOverrides(withDiscovered, overrides);
  applyCapabilityEvidence(capabilityEvidence, overrides);
  return { capabilities, capabilityEvidence };
}

export function defaultModelCapabilityEvidence(): ModelCapabilityEvidence {
  return {
    temperature: "unverified",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "unverified",
    inputs: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  };
}

function applyCapabilityEvidence(
  evidence: ModelCapabilityEvidence,
  values: ModelCapabilityHints | ModelCapabilityOverrides | undefined,
): void {
  if (!values) return;
  if (values.temperature !== undefined) {
    evidence.temperature = values.temperature;
  }
  if (values.maxOutputTokens !== undefined) {
    evidence.maxOutputTokens = "verified";
  }
  if ("contextWindowTokens" in values && values.contextWindowTokens !== undefined) {
    evidence.contextWindowTokens = "verified";
  }
  if (values.reasoning?.supported !== undefined) {
    evidence.reasoning = values.reasoning.supported
      ? "supported"
      : "unsupported";
  }
  applyInputCapabilityEvidence(evidence.inputs, values.inputs);
}

function applyInputCapabilityEvidence(
  evidence: InputCapabilityEvidence,
  values: Partial<InputCapabilities> | undefined,
): void {
  if (!values) return;
  for (const kind of ["image", "audio", "pdf"] as const) {
    const value = values[kind];
    if (typeof value === "boolean") {
      evidence[kind] = value ? "supported" : "unsupported";
    }
  }
}

function mergeCapabilities(
  base: ModelCapabilities,
  override: ModelCapabilityHints | undefined,
): ModelCapabilities {
  if (!override) return cloneCapabilities(base);
  return {
    ...base,
    ...override,
    reasoning: mergeReasoning(base.reasoning, override.reasoning),
    inputs: mergeInputs(base.inputs, override.inputs),
  };
}

function isBaseModelOrSnapshot(model: string, base: string): boolean {
  return model === base || new RegExp(
    `^${base.replaceAll(".", "\\.")}-\\d{4}-\\d{2}-\\d{2}$`,
  ).test(model);
}

export function validateGenerationParameters(
  source: RuntimeModelSource,
  capabilities: ModelCapabilities,
): void {
  const { parameters } = source.model;
  const configuredMaxOutputTokens = isDirectRuntimeModelSource(source)
    ? parameters.maxOutputTokens
    : undefined;
  if (
    configuredMaxOutputTokens !== undefined &&
    capabilities.maxOutputTokens !== undefined &&
    configuredMaxOutputTokens > capabilities.maxOutputTokens
  ) {
    throw new ProfileValidationError(
      "parameters.maxOutputTokens",
      `Max output tokens exceed this model's limit of ${capabilities.maxOutputTokens}.`,
    );
  }
  if (
    parameters.temperature !== undefined &&
    capabilities.temperature === "unsupported"
  ) {
    throw new ProfileValidationError(
      "parameters.temperature",
      "This model does not support temperature.",
    );
  }

  const requested = parameters.reasoning;
  if (requested.mode === "default") return;
  if (!capabilities.reasoning.supported) {
    throw new ProfileValidationError(
      "parameters.reasoning.mode",
      "This model does not support explicit reasoning controls.",
    );
  }
  if (requested.mode === "disabled" && !capabilities.reasoning.canDisable) {
    throw new ProfileValidationError(
      "parameters.reasoning.mode",
      "This model cannot explicitly disable reasoning.",
    );
  }
  if (requested.mode !== "enabled") return;

  if (
    requested.effort !== undefined &&
    !capabilities.reasoning.efforts.includes(requested.effort)
  ) {
    throw new ProfileValidationError(
      "parameters.reasoning.effort",
      `Reasoning effort ${requested.effort} is not supported by this model.`,
    );
  }
  if (
    requested.budgetTokens !== undefined &&
    !capabilities.reasoning.budgetTokens
  ) {
    throw new ProfileValidationError(
      "parameters.reasoning.budgetTokens",
      "This model does not support a thinking token budget.",
    );
  }
  if (
    requested.budgetTokens !== undefined ||
    capabilities.reasoning.strategy === "budget-thinking"
  ) {
    const maxOutputTokens = configuredMaxOutputTokens ??
      capabilities.maxOutputTokens;
    if (maxOutputTokens === undefined) {
      throw new ProfileValidationError(
        "parameters.reasoning.budgetTokens",
        "Thinking token budgets require a verified maximum output limit.",
      );
    }
    const budget = requested.budgetTokens ??
      Math.floor(maxOutputTokens / 2);
    if (budget < 1024) {
      throw new ProfileValidationError(
        "parameters.reasoning.budgetTokens",
        requested.budgetTokens === undefined
          ? "The default thinking budget must be at least 1024; increase max output tokens or set an explicit budget."
          : "Thinking budget must be at least 1024.",
      );
    }
    if (budget >= maxOutputTokens) {
      throw new ProfileValidationError(
        "parameters.reasoning.budgetTokens",
        "Thinking budget must be below max output tokens.",
      );
    }
  }
  if (capabilities.reasoning.strategy === "none") {
    throw new ProfileValidationError(
      "parameters.reasoning.mode",
      "This model has no configured reasoning strategy.",
    );
  }
}

function anthropicAdaptiveThinkingPolicy(
  efforts: ReasoningCapabilities["efforts"],
  canDisable: boolean,
  temperatureUnsupported: boolean,
): ModelCapabilityHints {
  return {
    maxOutputTokens: 128_000,
    ...(temperatureUnsupported ? { temperature: "unsupported" as const } : {}),
    reasoning: {
      supported: true,
      canDisable,
      efforts,
      budgetTokens: false,
      strategy: "adaptive-thinking",
    },
  };
}

function reasoningPolicy(
  efforts: ReasoningCapabilities["efforts"],
  canDisable: boolean,
  maxOutputTokens: number,
): Partial<ModelCapabilities> {
  return {
    maxOutputTokens,
    temperature: "unsupported",
    reasoning: {
      supported: true,
      canDisable,
      efforts,
      budgetTokens: false,
      strategy: "effort",
    },
  };
}

function mergeCapabilityOverrides(
  base: ModelCapabilities,
  override: ModelCapabilityOverrides | undefined,
): ModelCapabilities {
  if (!override) return cloneCapabilities(base);
  return {
    ...base,
    ...(override.tools === undefined ? {} : { tools: override.tools }),
    ...(override.streaming === undefined
      ? {}
      : { streaming: override.streaming }),
    ...(override.temperature === undefined
      ? {}
      : { temperature: override.temperature }),
    ...(override.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: override.maxOutputTokens }),
    reasoning: mergeReasoning(base.reasoning, override.reasoning),
    inputs: mergeInputs(base.inputs, override.inputs),
  };
}

function mergeInputs(
  base: ModelCapabilities["inputs"],
  override: Partial<ModelCapabilities["inputs"]> | undefined,
): ModelCapabilities["inputs"] {
  return override ? { ...base, ...override } : { ...base };
}

function mergeReasoning(
  base: ReasoningCapabilities,
  override: Partial<ReasoningCapabilities> | undefined,
): ReasoningCapabilities {
  if (!override) return { ...base, efforts: [...base.efforts] };
  return {
    ...base,
    ...override,
    efforts: override.efforts ? [...override.efforts] : [...base.efforts],
  };
}

function cloneCapabilities(value: ModelCapabilities): ModelCapabilities {
  return {
    ...value,
    reasoning: { ...value.reasoning, efforts: [...value.reasoning.efforts] },
    inputs: { ...value.inputs },
  };
}
