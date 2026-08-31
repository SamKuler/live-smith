import type { DiscoveredModelInfo } from "../provider.js";
import {
  decodeDiscoveredModelCatalog,
  isDiscoveredModelId,
  MAX_DISCOVERED_MODEL_COUNT,
} from "../catalog.js";
import {
  googleAntigravityInputSupport,
  mimeBackedInputCapabilities,
} from "../input-support.js";
import { isRecord } from "./oauth-utils.js";

export function decodeGoogleAntigravityCatalog(
  value: unknown,
): DiscoveredModelInfo[] | undefined {
  if (!isRecord(value) || !isRecord(value.models)) return undefined;
  const entries = Object.entries(value.models);
  if (entries.length > MAX_DISCOVERED_MODEL_COUNT) return undefined;
  const imageGenerationModelIds = specializedModelIds(
    value.imageGenerationModelIds,
  );
  const audioTranscriptionModelIds = specializedModelIds(
    value.audioTranscriptionModelIds,
  );
  if (
    imageGenerationModelIds === "invalid" ||
    audioTranscriptionModelIds === "invalid"
  ) return undefined;
  const excludedModelIds = new Set([
    ...(imageGenerationModelIds ?? []),
    ...(audioTranscriptionModelIds ?? []),
  ]);
  const models: DiscoveredModelInfo[] = [];
  for (const [catalogId, rawModel] of entries) {
    if (!isRecord(rawModel)) return undefined;
    if (rawModel.isInternal !== undefined && typeof rawModel.isInternal !== "boolean") {
      return undefined;
    }
    if (rawModel.isInternal === true) continue;
    if (!isDiscoveredModelId(catalogId)) return undefined;
    const id = catalogId;
    if (excludedModelIds.has(id)) continue;
    const displayName = typeof rawModel.displayName === "string" &&
        rawModel.displayName.trim()
      ? rawModel.displayName.trim()
      : id;
    const providerReported = antigravityProviderReported(rawModel);
    if (providerReported === "invalid") return undefined;
    const returned = returnedAntigravityCapabilities(rawModel, providerReported);
    if (!returned) return undefined;
    models.push({
      id,
      displayName,
      capabilities: returned,
      ...(providerReported === undefined ? {} : { providerReported }),
    });
  }
  return decodeDiscoveredModelCatalog(models);
}

function returnedAntigravityCapabilities(
  rawModel: Record<string, unknown>,
  providerReported: DiscoveredModelInfo["providerReported"],
): DiscoveredModelInfo["capabilities"] | undefined {
  const maxOutputTokens = optionalPositiveInteger(rawModel, "maxOutputTokens");
  const contextWindowTokens = optionalPositiveInteger(rawModel, "maxTokens");
  if (
    maxOutputTokens === "invalid" ||
    contextWindowTokens === "invalid"
  ) return undefined;

  const reportedInputs = providerReported?.inputs;
  const reportedReasoning = providerReported?.reasoning;
  const inputs = mimeBackedInputCapabilities(
    reportedInputs,
    googleAntigravityInputSupport,
  );
  return {
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(reportedReasoning?.supportsThinking === false
      ? {
          reasoning: {
            supported: false,
            canDisable: false,
            efforts: [],
            budgetTokens: false,
            strategy: "none",
          },
        }
      : {}),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function antigravityProviderReported(
  rawModel: Record<string, unknown>,
): DiscoveredModelInfo["providerReported"] | "invalid" | undefined {
  const supportsImages = optionalBoolean(rawModel, "supportsImages");
  const supportsPdf = optionalBoolean(rawModel, "supportsPdf");
  const supportsVideo = optionalBoolean(rawModel, "supportsVideo");
  const supportedMimeTypes = optionalMimeTypeMap(rawModel.supportedMimeTypes);
  const supportsThinking = optionalBoolean(rawModel, "supportsThinking");
  const supportsAdaptiveThinking = optionalBoolean(
    rawModel,
    "supportsAdaptiveThinking",
  );
  const thinkingBudget = optionalInt32(rawModel, "thinkingBudget");
  const minThinkingBudget = optionalInt32(rawModel, "minThinkingBudget");
  const thinkingLevel = optionalInt32(rawModel, "thinkingLevel");
  if (
    supportsImages === "invalid" ||
    supportsPdf === "invalid" ||
    supportsVideo === "invalid" ||
    supportedMimeTypes === "invalid" ||
    supportsThinking === "invalid" ||
    supportsAdaptiveThinking === "invalid" ||
    thinkingBudget === "invalid" ||
    minThinkingBudget === "invalid" ||
    thinkingLevel === "invalid"
  ) return "invalid";
  const inputs = {
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(supportsVideo === undefined ? {} : { supportsVideo }),
    ...(supportedMimeTypes === undefined ? {} : { supportedMimeTypes }),
  };
  const reasoning = {
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(supportsAdaptiveThinking === undefined
      ? {}
      : { supportsAdaptiveThinking }),
    ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
    ...(minThinkingBudget === undefined ? {} : { minThinkingBudget }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  if (Object.keys(inputs).length === 0 && Object.keys(reasoning).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
  };
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | "invalid" | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : "invalid";
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | "invalid" | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : "invalid";
}

function optionalInt32(
  record: Record<string, unknown>,
  key: string,
): number | "invalid" | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return Number.isInteger(value) &&
      (value as number) >= -2_147_483_648 &&
      (value as number) <= 2_147_483_647
    ? value as number
    : "invalid";
}

function optionalMimeTypeMap(
  value: unknown,
): Readonly<Record<string, boolean>> | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "invalid";
  return Object.values(value).every((supported) => typeof supported === "boolean")
    ? value as Record<string, boolean>
    : "invalid";
}

function specializedModelIds(
  value: unknown,
): string[] | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_DISCOVERED_MODEL_COUNT ||
    !value.every(isDiscoveredModelId)
  ) return "invalid";
  return value;
}
