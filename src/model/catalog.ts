import { cloneJsonValue } from "./json-clone.js";
import type { DiscoveredModelInfo } from "./provider.js";
import {
  isReasoningEffort,
  isReasoningStrategy,
} from "./profile.js";

const discoveredModelKeys = new Set(["id", "displayName", "capabilities"]);
const capabilityKeys = new Set([
  "tools",
  "streaming",
  "temperature",
  "maxOutputTokens",
  "contextWindowTokens",
  "reasoning",
  "inputs",
]);
const inputKeys = new Set(["image", "audio", "pdf"]);
const reasoningKeys = new Set([
  "supported",
  "canDisable",
  "efforts",
  "budgetTokens",
  "strategy",
]);

export const MAX_DISCOVERED_MODEL_COUNT = 1_000;
export const MAX_DISCOVERED_MODEL_ID_CODE_POINTS = 256;
export const MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS = 256;
export const MAX_MODEL_DISCOVERY_PAGE_COUNT = 20;
export const MAX_DISCOVERED_MODEL_OUTPUT_TOKENS = 1_000_000;
export const MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS = 10_000_000;

/** Decodes the one catalog shape shared by runtime selection, cache, and UI. */
export function decodeDiscoveredModelCatalog(
  value: unknown,
): DiscoveredModelInfo[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_DISCOVERED_MODEL_COUNT ||
    !value.every(isDiscoveredModelInfo) ||
    new Set(value.map((model) => model.id)).size !== value.length
  ) return undefined;
  return cloneJsonValue(value);
}

function isDiscoveredModelInfo(value: unknown): value is DiscoveredModelInfo {
  if (!isRecordWithOnlyKeys(value, discoveredModelKeys)) return false;
  return isDiscoveredModelId(value.id) &&
    isBoundedDisplayString(
      value.displayName,
      MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS,
    ) &&
    isModelCapabilityHints(value.capabilities);
}

/** Canonical model ID rule shared by provider decoders and catalog decoding. */
export function isDiscoveredModelId(value: unknown): value is string {
  return isBoundedDisplayString(
    value,
    MAX_DISCOVERED_MODEL_ID_CODE_POINTS,
  );
}

function isModelCapabilityHints(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, capabilityKeys)) return false;
  if (value.tools !== undefined && typeof value.tools !== "boolean") return false;
  if (value.streaming !== undefined && typeof value.streaming !== "boolean") return false;
  if (
    value.temperature !== undefined &&
    value.temperature !== "supported" &&
    value.temperature !== "unsupported"
  ) return false;
  if (
    value.maxOutputTokens !== undefined &&
    (
      typeof value.maxOutputTokens !== "number" ||
      !Number.isInteger(value.maxOutputTokens) ||
      value.maxOutputTokens <= 0 ||
      value.maxOutputTokens > MAX_DISCOVERED_MODEL_OUTPUT_TOKENS
    )
  ) return false;
  if (
    value.contextWindowTokens !== undefined &&
    (
      typeof value.contextWindowTokens !== "number" ||
      !Number.isInteger(value.contextWindowTokens) ||
      value.contextWindowTokens <= 0 ||
      value.contextWindowTokens > MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS
    )
  ) return false;
  if (value.reasoning !== undefined && !isReasoningCapabilityHints(value.reasoning)) {
    return false;
  }
  return value.inputs === undefined || isInputCapabilityHints(value.inputs);
}

function isInputCapabilityHints(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, inputKeys)) return false;
  return ["image", "audio", "pdf"].every((key) =>
    value[key] === undefined || typeof value[key] === "boolean"
  );
}

function isReasoningCapabilityHints(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, reasoningKeys)) return false;
  if (value.supported !== undefined && typeof value.supported !== "boolean") {
    return false;
  }
  if (value.canDisable !== undefined && typeof value.canDisable !== "boolean") {
    return false;
  }
  if (value.budgetTokens !== undefined && typeof value.budgetTokens !== "boolean") {
    return false;
  }
  if (value.efforts !== undefined) {
    if (
      !Array.isArray(value.efforts) ||
      !value.efforts.every(isReasoningEffort) ||
      new Set(value.efforts).size !== value.efforts.length
    ) return false;
  }
  return value.strategy === undefined || isReasoningStrategy(value.strategy);
}

function isBoundedDisplayString(
  value: unknown,
  maximumCodePoints: number,
): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    hasAtMostCodePoints(value, maximumCodePoints) &&
    !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function isRecordWithOnlyKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key));
}
