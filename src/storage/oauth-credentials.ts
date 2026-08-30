import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateFile,
  removeFileDurably,
  withStorageTransaction,
  writeJsonAtomically,
} from "./persistence.js";

const oauthProviders = ["openai", "anthropic", "google"] as const;
export type OAuthProvider = (typeof oauthProviders)[number];

interface OAuthCredentialFields {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type OAuthCredential =
  | (OAuthCredentialFields & {
      provider: "openai";
      accountId: string;
    })
  | (OAuthCredentialFields & {
      provider: "anthropic";
    })
  | (OAuthCredentialFields & {
      provider: "google";
      projectId: string;
      accountLabel: string | null;
    });

interface OAuthCredentialStore {
  schemaVersion: 1;
  credentials: Partial<Record<OAuthProvider, OAuthCredential>>;
}

const emptyStore = (): OAuthCredentialStore => ({
  schemaVersion: 1,
  credentials: {},
});

export async function loadOAuthCredential(
  storageDirectory: string | undefined,
  provider: OAuthProvider,
): Promise<OAuthCredential | undefined> {
  requireStorageDirectory(storageDirectory);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    return store.credentials[provider];
  });
}

export async function saveOAuthCredential(
  storageDirectory: string | undefined,
  credential: OAuthCredential,
  options: { shouldCommit?: () => boolean } = {},
): Promise<boolean> {
  requireStorageDirectory(storageDirectory);
  validateCredential(credential, credential.provider);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    if (options.shouldCommit && !options.shouldCommit()) return false;
    store.credentials[credential.provider] = { ...credential };
    await writeJsonAtomically(credentialsPath(storageDirectory), store);
    return true;
  });
}

export async function deleteOAuthCredential(
  storageDirectory: string | undefined,
  provider: OAuthProvider,
): Promise<void> {
  requireStorageDirectory(storageDirectory);
  await withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    if (!(provider in store.credentials)) return;
    delete store.credentials[provider];
    if (Object.keys(store.credentials).length === 0) {
      await removeFileDurably(credentialsPath(storageDirectory));
      return;
    }
    await writeJsonAtomically(credentialsPath(storageDirectory), store);
  });
}

async function readStore(storageDirectory: string): Promise<OAuthCredentialStore> {
  const target = credentialsPath(storageDirectory);
  let parsed: unknown;
  try {
    const raw = await fs.readFile(target, "utf8");
    await ensurePrivateFile(target);
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return emptyStore();
    if (error instanceof SyntaxError) throw invalidStore();
    throw error;
  }
  return decodeStore(parsed);
}

function decodeStore(value: unknown): OAuthCredentialStore {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "credentials"]) ||
    value.schemaVersion !== 1 || !isRecord(value.credentials)) {
    throw invalidStore();
  }
  const rawCredentials = value.credentials;
  if (!hasOnlyKeys(rawCredentials, oauthProviders)) throw invalidStore();
  const credentials: OAuthCredentialStore["credentials"] = {};
  for (const provider of oauthProviders) {
    const credential = rawCredentials[provider];
    if (credential === undefined) continue;
    credentials[provider] = validateCredential(credential, provider);
  }
  return { schemaVersion: 1, credentials };
}

function validateCredential(
  value: unknown,
  provider: OAuthProvider,
): OAuthCredential {
  if (!isRecord(value) || value.provider !== provider) throw invalidStore();
  const commonKeys = ["provider", "accessToken", "refreshToken", "expiresAt"];
  const providerKeys = provider === "openai"
    ? ["accountId"]
    : provider === "google"
      ? ["projectId", "accountLabel"]
      : [];
  if (!hasOnlyKeys(value, [...commonKeys, ...providerKeys]) ||
    !isBoundedSecret(value.accessToken) ||
    !isBoundedSecret(value.refreshToken) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0) {
    throw invalidStore();
  }
  if (provider === "openai") {
    if (!isBoundedLabel(value.accountId)) throw invalidStore();
    return {
      provider,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      accountId: value.accountId,
    };
  }
  if (provider === "google") {
    if (!isBoundedLabel(value.projectId) ||
      (value.accountLabel !== null && !isBoundedLabel(value.accountLabel))) {
      throw invalidStore();
    }
    return {
      provider,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      projectId: value.projectId,
      accountLabel: value.accountLabel,
    };
  }
  return {
    provider,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
  };
}

function credentialsPath(storageDirectory: string): string {
  return path.join(storageDirectory, "oauth", "credentials.json");
}

function requireStorageDirectory(
  storageDirectory: string | undefined,
): asserts storageDirectory is string {
  if (!storageDirectory) {
    throw new Error("OAuth credentials require the Ableton storage directory.");
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 65_536;
}

function isBoundedLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function invalidStore(): Error {
  return new Error("OAuth credential store is invalid.");
}
