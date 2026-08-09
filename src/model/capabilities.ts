import type {
  InputCapabilities,
  InputCapabilityEvidence,
  ModelCapabilities,
  ModelCapabilityHints,
  ReasoningCapabilities,
} from "./provider.js";
import {
  ProfileValidationError,
  type DraftProfile,
  type SavedProfile,
  type ModelCapabilityOverrides,
} from "./profile.js";

const noReasoning: ReasoningCapabilities = {
  supported: false,
  canDisable: false,
  efforts: [],
  budgetTokens: false,
  strategy: "none",
};

export function defaultModelCapabilities(): ModelCapabilities {
  return {
    tools: true,
    streaming: true,
    temperature: "supported",
    reasoning: { ...noReasoning },
    inputs: { image: false, audio: false, pdf: false },
  };
}

function knownCapabilitiesForModel(
  profile: Pick<SavedProfile, "apiFamily" | "apiMode" | "model">,
): ModelCapabilityHints | undefined {
  const model = profile.model.toLocaleLowerCase();

  if (profile.apiFamily === "openai") {
    if (/^gpt-5\.6(?:-|$)/.test(model)) {
      return reasoningPolicy(
        ["low", "medium", "high", "xhigh", "max"],
        true,
        128_000,
      );
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
  profile: DraftProfile | SavedProfile,
  discovered?: ModelCapabilityHints,
): ModelCapabilities {
  return resolveModelCapabilitiesWithEvidence(profile, discovered).capabilities;
}

export function resolveModelCapabilitiesWithEvidence(
  profile: DraftProfile | SavedProfile,
  discovered?: ModelCapabilityHints,
): {
  capabilities: ModelCapabilities;
  inputCapabilityEvidence: InputCapabilityEvidence;
} {
  const fallback = defaultModelCapabilities();
  const known = knownCapabilitiesForModel(profile);
  const withKnown = mergeCapabilities(fallback, known);
  const inputCapabilityEvidence = unverifiedInputCapabilityEvidence();
  const knownInputs = knownInputCapabilitiesForModel(profile);
  const withKnownInputs = mergeCapabilities(
    withKnown,
    knownInputs,
  );
  applyInputCapabilityEvidence(inputCapabilityEvidence, knownInputs?.inputs);
  const withDiscovered = mergeCapabilities(withKnownInputs, discovered);
  applyInputCapabilityEvidence(inputCapabilityEvidence, discovered?.inputs);
  const overrides = profile.advanced.capabilityOverrides;
  const capabilities = mergeCapabilityOverrides(withDiscovered, overrides);
  applyInputCapabilityEvidence(inputCapabilityEvidence, overrides?.inputs);
  return { capabilities, inputCapabilityEvidence };
}

function unverifiedInputCapabilityEvidence(): InputCapabilityEvidence {
  return {
    image: "unverified",
    audio: "unverified",
    pdf: "unverified",
  };
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

function knownInputCapabilitiesForModel(
  profile: Pick<SavedProfile, "apiFamily" | "apiMode" | "model">,
): ModelCapabilityHints | undefined {
  const model = profile.model.toLocaleLowerCase();
  if (profile.apiFamily === "openai") {
    const documentedImageModel = isExplicitAliasOrSnapshot(
      model,
      "gpt-5.6",
      ["gpt-5.6-sol", "gpt-5.6-terra"],
    ) ||
      isBaseModelOrSnapshot(model, "gpt-5.5-pro") ||
      isBaseModelOrSnapshot(model, "gpt-5.5") ||
      isBaseModelOrSnapshot(model, "gpt-5.4-pro") ||
      isBaseModelOrSnapshot(model, "gpt-5.4-mini") ||
      isBaseModelOrSnapshot(model, "gpt-5.4-nano") ||
      isBaseModelOrSnapshot(model, "gpt-5.4") ||
      isBaseModelOrSnapshot(model, "gpt-5.3-codex") ||
      isBaseModelOrSnapshot(model, "gpt-5.2-pro") ||
      isBaseModelOrSnapshot(model, "gpt-5.2-codex") ||
      isBaseModelOrSnapshot(model, "gpt-5.2") ||
      isBaseModelOrSnapshot(model, "gpt-5.1") ||
      isBaseModelOrSnapshot(model, "gpt-5");
    return documentedImageModel ? { inputs: { image: true } } : undefined;
  }

  const documentedImageModel = [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-0",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-7",
    "claude-sonnet-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ].some((base) => isAnthropicBaseModelOrSnapshot(model, base));
  return documentedImageModel ? { inputs: { image: true } } : undefined;
}

function isExplicitAliasOrSnapshot(
  model: string,
  base: string,
  aliases: readonly string[],
): boolean {
  return aliases.includes(model) || isBaseModelOrSnapshot(model, base);
}

function isAnthropicBaseModelOrSnapshot(model: string, base: string): boolean {
  return model === base || new RegExp(
    `^${base.replaceAll(".", "\\.")}-\\d{8}$`,
  ).test(model);
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
  profile: SavedProfile,
  capabilities: ModelCapabilities,
): void {
  const { parameters } = profile;
  if (
    capabilities.maxOutputTokens !== undefined &&
    parameters.maxOutputTokens > capabilities.maxOutputTokens
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
    const budget = requested.budgetTokens ??
      Math.floor(parameters.maxOutputTokens / 2);
    if (budget < 1024) {
      throw new ProfileValidationError(
        "parameters.reasoning.budgetTokens",
        requested.budgetTokens === undefined
          ? "The default thinking budget must be at least 1024; increase max output tokens or set an explicit budget."
          : "Thinking budget must be at least 1024.",
      );
    }
    if (budget >= parameters.maxOutputTokens) {
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
