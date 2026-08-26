import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { decodeDiscoveredModelCatalog } from "../model/catalog.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import {
  type DraftProfile,
  type SavedProfile,
} from "../model/profile.js";
import { isMissingFileError } from "./errors.js";
import { writeJsonAtomically } from "./persistence.js";

interface ModelCacheEntry {
  schemaVersion: 1;
  fingerprint: string;
  models: DiscoveredModelInfo[];
}

const memoryCache = new Map<string, ModelCacheEntry>();
const modelCacheEntryKeys = new Set(["schemaVersion", "fingerprint", "models"]);
const maximumCacheIdSlugLength = 80;

export function connectionFingerprint(profile: DraftProfile | SavedProfile): string {
  const connection = profile.connection.kind === "direct-api"
    ? {
        connectionKind: profile.connection.kind,
        apiFamily: profile.connection.apiFamily,
        apiMode: profile.connection.apiMode,
        baseUrl: profile.connection.baseUrl.replace(/\/+$/, ""),
        apiKey: profile.connection.apiKey,
      }
    : {
        connectionKind: profile.connection.kind,
        provider: profile.connection.provider,
      };
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: profile.id,
        ...connection,
      }),
    )
    .digest("hex");
}

export async function loadModelCache(
  storageDirectory: string | undefined,
  profile: DraftProfile | SavedProfile,
): Promise<DiscoveredModelInfo[]> {
  if (profile.connection.kind === "codex-subscription") return [];
  const expected = connectionFingerprint(profile);
  if (!storageDirectory) {
    const entry = memoryCache.get(expected);
    return entry
      ? decodeDiscoveredModelCatalog(entry.models) ?? []
      : [];
  }

  try {
    const raw = await fs.readFile(cachePath(storageDirectory, expected), "utf8");
    const entry = JSON.parse(raw) as unknown;
    return decodeModelCacheEntry(entry, expected) ?? [];
  } catch (error) {
    if (isMissingFileError(error)) {
      return loadLegacyModelCache(storageDirectory, profile, expected);
    }
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function saveModelCache(
  storageDirectory: string | undefined,
  profile: DraftProfile | SavedProfile,
  models: DiscoveredModelInfo[],
): Promise<void> {
  if (profile.connection.kind === "codex-subscription") return;
  const canonicalModels = decodeDiscoveredModelCatalog(models);
  if (!canonicalModels) throw new TypeError("Model catalog is invalid.");
  const fingerprint = connectionFingerprint(profile);
  const entry: ModelCacheEntry = {
    schemaVersion: 1,
    fingerprint,
    models: canonicalModels,
  };
  if (!storageDirectory) {
    memoryCache.set(fingerprint, entry);
    return;
  }

  await writeJsonAtomically(cachePath(storageDirectory, fingerprint), entry);
}

function cachePath(storageDirectory: string, fingerprint: string): string {
  return path.join(
    storageDirectory,
    `live-smith-models-v2-${fingerprint}.json`,
  );
}

function legacyCachePath(storageDirectory: string, profileId: string): string {
  const safeId = profileId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, maximumCacheIdSlugLength) || "profile";
  const idHash = createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  return path.join(storageDirectory, `live-smith-models-${safeId}-${idHash}.json`);
}

async function loadLegacyModelCache(
  storageDirectory: string,
  profile: DraftProfile | SavedProfile,
  expectedFingerprint: string,
): Promise<DiscoveredModelInfo[]> {
  try {
    const raw = await fs.readFile(
      legacyCachePath(storageDirectory, profile.id),
      "utf8",
    );
    const entry = JSON.parse(raw) as unknown;
    return decodeModelCacheEntry(entry, expectedFingerprint) ?? [];
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return [];
    throw error;
  }
}

function decodeModelCacheEntry(
  value: unknown,
  expectedFingerprint: string,
): DiscoveredModelInfo[] | undefined {
  if (!isRecordWithOnlyKeys(value, modelCacheEntryKeys)) return undefined;
  if (
    value.schemaVersion !== 1 ||
    value.fingerprint !== expectedFingerprint
  ) return undefined;
  return decodeDiscoveredModelCatalog(value.models);
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
