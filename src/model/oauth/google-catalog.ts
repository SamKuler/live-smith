import type { DiscoveredModelInfo, ReasoningCapabilities } from "../provider.js";
import {
  decodeDiscoveredModelCatalog,
  isDiscoveredModelId,
  MAX_DISCOVERED_MODEL_COUNT,
} from "../catalog.js";
import { isRecord } from "./oauth-utils.js";

const googleModels: ReadonlyArray<{
  id: string;
  displayName: string;
  reasoning: Pick<
    ReasoningCapabilities,
    "canDisable" | "efforts" | "strategy"
  >;
  maxOutputTokens: number;
}> = [
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash (Cloud Code Assist)",
    reasoning: {
      canDisable: true,
      efforts: ["minimal", "low", "medium", "high"],
      strategy: "budget-thinking",
    },
    maxOutputTokens: 65_535,
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro (Cloud Code Assist)",
    reasoning: {
      canDisable: false,
      efforts: ["minimal", "low", "medium", "high"],
      strategy: "budget-thinking",
    },
    maxOutputTokens: 65_535,
  },
  {
    id: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview (Cloud Code Assist)",
    reasoning: {
      canDisable: false,
      efforts: ["minimal", "low", "medium", "high"],
      strategy: "effort",
    },
    maxOutputTokens: 65_535,
  },
  {
    id: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro Preview (Cloud Code Assist)",
    reasoning: {
      canDisable: false,
      efforts: ["low", "high"],
      strategy: "effort",
    },
    maxOutputTokens: 65_535,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash Lite Preview (Cloud Code Assist)",
    reasoning: {
      canDisable: false,
      efforts: ["minimal", "low", "medium", "high"],
      strategy: "effort",
    },
    maxOutputTokens: 65_535,
  },
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview (Cloud Code Assist)",
    reasoning: {
      canDisable: false,
      efforts: ["low", "medium", "high"],
      strategy: "effort",
    },
    maxOutputTokens: 65_535,
  },
];

const googleModelsById = new Map(googleModels.map((model) => [model.id, model]));

export function decodeGoogleCloudCodeAssistCatalog(
  value: unknown,
): DiscoveredModelInfo[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.buckets)) return undefined;
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const bucket of value.buckets) {
    if (!isRecord(bucket)) return undefined;
    if (bucket.modelId === undefined) continue;
    if (!isDiscoveredModelId(bucket.modelId)) return undefined;
    if (seen.has(bucket.modelId)) continue;
    seen.add(bucket.modelId);
    modelIds.push(bucket.modelId);
    if (modelIds.length > MAX_DISCOVERED_MODEL_COUNT) return undefined;
  }
  return decodeDiscoveredModelCatalog(modelIds.map((id) => {
    const model = googleModelsById.get(id);
    return {
      id,
      displayName: model?.displayName ?? id,
      capabilities: model
        ? {
            tools: true,
            streaming: true,
            temperature: "supported" as const,
            maxOutputTokens: model.maxOutputTokens,
            contextWindowTokens: 1_048_576,
            reasoning: {
              supported: true,
              canDisable: model.reasoning.canDisable,
              efforts: [...model.reasoning.efforts],
              budgetTokens: false,
              strategy: model.reasoning.strategy,
            },
            inputs: { image: true, audio: false, pdf: false },
          }
        : {},
    };
  }));
}
