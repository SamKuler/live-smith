import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { cloneJsonValue } from "../model/json-clone.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import type { DraftProfile, SavedProfile } from "../model/profile.js";
import { isMissingFileError } from "./errors.js";
import { writeJsonAtomically } from "./persistence.js";

interface ModelCacheEntry {
  schemaVersion: 1;
  fingerprint: string;
  models: DiscoveredModelInfo[];
}

const memoryCache = new Map<string, ModelCacheEntry>();
const modelCacheEntryKeys = new Set(["schemaVersion", "fingerprint", "models"]);
const discoveredModelKeys = new Set(["id", "displayName", "capabilities"]);
const capabilityKeys = new Set([
  "tools",
  "streaming",
  "temperature",
  "maxOutputTokens",
  "reasoning",
]);
const reasoningKeys = new Set([
  "supported",
  "canDisable",
  "efforts",
  "budgetTokens",
  "strategy",
]);
const reasoningEfforts = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const reasoningStrategies = new Set([
  "effort",
  "adaptive-thinking",
  "budget-thinking",
  "none",
]);
const maximumCacheIdSlugLength = 80;

export function connectionFingerprint(profile: DraftProfile | SavedProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: profile.id,
        apiFamily: profile.apiFamily,
        apiMode: profile.apiMode,
        baseUrl: profile.baseUrl.replace(/\/+$/, ""),
        apiKey: profile.apiKey,
      }),
    )
    .digest("hex");
}

export async function loadModelCache(
  storageDirectory: string | undefined,
  profile: DraftProfile | SavedProfile,
): Promise<DiscoveredModelInfo[]> {
  const expected = connectionFingerprint(profile);
  if (!storageDirectory) {
    const entry = memoryCache.get(profile.id);
    return entry?.fingerprint === expected ? cloneJsonValue(entry.models) : [];
  }

  try {
    const raw = await fs.readFile(cachePath(storageDirectory, profile.id), "utf8");
    const entry = JSON.parse(raw) as unknown;
    return isModelCacheEntry(entry, expected) ? entry.models : [];
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function saveModelCache(
  storageDirectory: string | undefined,
  profile: DraftProfile | SavedProfile,
  models: DiscoveredModelInfo[],
): Promise<void> {
  const entry: ModelCacheEntry = {
    schemaVersion: 1,
    fingerprint: connectionFingerprint(profile),
    models: cloneJsonValue(models),
  };
  if (!storageDirectory) {
    memoryCache.set(profile.id, entry);
    return;
  }

  await writeJsonAtomically(cachePath(storageDirectory, profile.id), entry);
}

function cachePath(storageDirectory: string, profileId: string): string {
  const safeId = profileId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, maximumCacheIdSlugLength) || "profile";
  const idHash = createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  return path.join(storageDirectory, `live-smith-models-${safeId}-${idHash}.json`);
}

function isModelCacheEntry(
  value: unknown,
  expectedFingerprint: string,
): value is ModelCacheEntry {
  if (!isRecordWithOnlyKeys(value, modelCacheEntryKeys)) return false;
  return value.schemaVersion === 1 &&
    value.fingerprint === expectedFingerprint &&
    Array.isArray(value.models) &&
    value.models.every(isDiscoveredModelInfo);
}

function isDiscoveredModelInfo(value: unknown): value is DiscoveredModelInfo {
  if (!isRecordWithOnlyKeys(value, discoveredModelKeys)) return false;
  return typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    isModelCapabilityHints(value.capabilities);
}

function isModelCapabilityHints(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, capabilityKeys)) return false;
  if (value.tools !== undefined && typeof value.tools !== "boolean") return false;
  if (value.streaming !== undefined && typeof value.streaming !== "boolean") return false;
  if (
    value.temperature !== undefined &&
    value.temperature !== "supported" &&
    value.temperature !== "unsupported"
  ) {
    return false;
  }
  if (
    value.maxOutputTokens !== undefined &&
    (
      typeof value.maxOutputTokens !== "number" ||
      !Number.isFinite(value.maxOutputTokens) ||
      value.maxOutputTokens <= 0
    )
  ) {
    return false;
  }
  return value.reasoning === undefined || isReasoningCapabilityHints(value.reasoning);
}

function isReasoningCapabilityHints(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, reasoningKeys)) return false;
  if (value.supported !== undefined && typeof value.supported !== "boolean") return false;
  if (value.canDisable !== undefined && typeof value.canDisable !== "boolean") return false;
  if (value.budgetTokens !== undefined && typeof value.budgetTokens !== "boolean") {
    return false;
  }
  if (
    value.efforts !== undefined &&
    (
      !Array.isArray(value.efforts) ||
      !value.efforts.every(
        (effort) => typeof effort === "string" && reasoningEfforts.has(effort),
      )
    )
  ) {
    return false;
  }
  return value.strategy === undefined ||
    (typeof value.strategy === "string" && reasoningStrategies.has(value.strategy));
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
