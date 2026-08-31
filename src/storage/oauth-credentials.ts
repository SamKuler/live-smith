import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isProfileId,
  type SavedProfile,
} from "../model/profile.js";
import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateFile,
  requireActiveStorageTransaction,
  removeFileDurably,
  type StorageTransactionContext,
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

interface OAuthCredentialStoreV1 {
  schemaVersion: 1;
  credentials: Partial<Record<OAuthProvider, OAuthCredential>>;
}

interface OAuthCredentialStoreV2 {
  schemaVersion: 2;
  credentials: Record<
    string,
    Partial<Record<OAuthProvider, OAuthCredential>>
  >;
  /** Provider-global credentials awaiting one atomic Profile claim. */
  legacyCredentials: Partial<Record<OAuthProvider, OAuthCredential>>;
}

interface OAuthCredentialStoreV3 {
  schemaVersion: 3;
  credentials: Record<
    string,
    Partial<Record<OAuthProvider, OAuthCredential>>
  >;
  legacyCredentials: Partial<Record<OAuthProvider, OAuthCredential>>;
}

const emptyStore = (): OAuthCredentialStoreV3 => ({
  schemaVersion: 3,
  credentials: {},
  legacyCredentials: {},
});

export async function loadOAuthCredential(
  storageDirectory: string | undefined,
  profileId: string,
  provider: OAuthProvider,
): Promise<OAuthCredential | undefined> {
  requireStorageDirectory(storageDirectory);
  requireProfileId(profileId);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    return ownProviderCredential(
      ownProfileCredentials(store.credentials, profileId),
      provider,
    );
  });
}

export async function prepareOAuthCredentialStoreInTransaction(
  transaction: StorageTransactionContext,
  storageDirectory: string,
  profiles: readonly SavedProfile[],
  activeProfileId: string | null,
): Promise<void> {
  requireActiveStorageTransaction(transaction, storageDirectory);
  const store = await readStore(storageDirectory);
  let changed = false;
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const [profileId, scopedCredentials] of Object.entries(store.credentials)) {
    const profile = profilesById.get(profileId);
    const retainedProvider = profile?.connection.kind === "oauth-subscription"
      ? profile.connection.provider
      : undefined;
    for (const provider of oauthProviders) {
      if (
        provider === retainedProvider ||
        !ownProviderCredential(scopedCredentials, provider)
      ) continue;
      delete scopedCredentials[provider];
      changed = true;
    }
    if (Object.keys(scopedCredentials).length === 0) {
      delete store.credentials[profileId];
      changed = true;
    }
  }
  for (const provider of oauthProviders) {
    const legacy = ownProviderCredential(store.legacyCredentials, provider);
    if (!legacy) continue;
    if (!Object.values(store.credentials).some(
      (credentials) => ownProviderCredential(credentials, provider),
    )) {
      const candidates = profiles.filter(
        (profile) =>
          profile.connection.kind === "oauth-subscription" &&
          profile.connection.provider === provider,
      );
      const owner = candidates.find((profile) => profile.id === activeProfileId) ??
        candidates[0];
      if (owner) {
        store.credentials[owner.id] = {
          ...ownProfileCredentials(store.credentials, owner.id),
          [provider]: legacy,
        };
      }
    }
    delete store.legacyCredentials[provider];
    changed = true;
  }
  if (changed) await persistOrRemoveStore(storageDirectory, store);
}

export async function saveOAuthCredential(
  storageDirectory: string | undefined,
  profileId: string,
  credential: OAuthCredential,
  options: { shouldCommit?: () => boolean } = {},
): Promise<boolean> {
  requireStorageDirectory(storageDirectory);
  requireProfileId(profileId);
  validateCredential(credential, credential.provider);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    if (options.shouldCommit && !options.shouldCommit()) return false;
    store.credentials[profileId] = {
      ...ownProfileCredentials(store.credentials, profileId),
      [credential.provider]: { ...credential },
    };
    delete store.legacyCredentials[credential.provider];
    await writeJsonAtomically(credentialsPath(storageDirectory), store);
    return true;
  });
}

export async function deleteOAuthCredential(
  storageDirectory: string | undefined,
  profileId: string,
  provider: OAuthProvider,
): Promise<void> {
  requireStorageDirectory(storageDirectory);
  requireProfileId(profileId);
  await withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    const scoped = ownProfileCredentials(store.credentials, profileId);
    if (!ownProviderCredential(scoped, provider)) return;
    delete scoped[provider];
    if (Object.keys(scoped).length === 0) delete store.credentials[profileId];
    await persistOrRemoveStore(storageDirectory, store);
  });
}

export async function deleteOAuthCredentialProfile(
  storageDirectory: string | undefined,
  profileId: string,
): Promise<void> {
  requireStorageDirectory(storageDirectory);
  requireProfileId(profileId);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    const credentials = ownProfileCredentials(store.credentials, profileId);
    if (Object.keys(credentials).length === 0) return;
    delete store.credentials[profileId];
    await persistOrRemoveStore(storageDirectory, store);
  });
}

export async function retainOAuthCredentialForProfileProvider(
  storageDirectory: string | undefined,
  profileId: string,
  provider: OAuthProvider,
): Promise<void> {
  requireStorageDirectory(storageDirectory);
  requireProfileId(profileId);
  return withStorageTransaction(storageDirectory, async () => {
    const store = await readStore(storageDirectory);
    const credentials = ownProfileCredentials(store.credentials, profileId);
    const removed = oauthProviders.filter(
      (candidate) =>
        candidate !== provider &&
        ownProviderCredential(credentials, candidate),
    );
    if (removed.length === 0) return;
    for (const removedProvider of removed) delete credentials[removedProvider];
    if (Object.keys(credentials).length === 0) delete store.credentials[profileId];
    await persistOrRemoveStore(storageDirectory, store);
  });
}

async function persistOrRemoveStore(
  storageDirectory: string,
  store: OAuthCredentialStoreV3,
): Promise<void> {
  if (
    Object.keys(store.credentials).length === 0 &&
    Object.keys(store.legacyCredentials).length === 0
  ) {
    await removeFileDurably(credentialsPath(storageDirectory));
    return;
  }
  await writeJsonAtomically(credentialsPath(storageDirectory), store);
}

async function readStore(storageDirectory: string): Promise<OAuthCredentialStoreV3> {
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
  const decoded = decodeStore(parsed);
  if (decoded.migrated) {
    await persistOrRemoveStore(storageDirectory, decoded.store);
  }
  return decoded.store;
}

function decodeStore(value: unknown): {
  store: OAuthCredentialStoreV3;
  migrated: boolean;
} {
  if (!isRecord(value)) {
    throw invalidStore();
  }
  if (value.schemaVersion === 1) {
    return {
      store: migrateStoreV2(migrateStoreV1(decodeStoreV1(value))),
      migrated: true,
    };
  }
  if (value.schemaVersion === 2) {
    return { store: migrateStoreV2(decodeStoreV2(value)), migrated: true };
  }
  if (value.schemaVersion !== 3 ||
    !hasOnlyKeys(value, ["schemaVersion", "credentials", "legacyCredentials"]) ||
    !isRecord(value.credentials) || !isRecord(value.legacyCredentials)) {
    throw invalidStore();
  }
  const credentials: OAuthCredentialStoreV3["credentials"] = {};
  for (const [profileId, rawCredentials] of Object.entries(value.credentials)) {
    if (!isProfileId(profileId) || !isRecord(rawCredentials)) {
      throw invalidStore();
    }
    const scoped = decodeProviderCredentials(rawCredentials);
    if (Object.keys(scoped).length === 0) throw invalidStore();
    credentials[profileId] = scoped;
  }
  const legacyCredentials = decodeProviderCredentials(value.legacyCredentials);
  return {
    store: { schemaVersion: 3, credentials, legacyCredentials },
    migrated: false,
  };
}

function decodeStoreV1(value: Record<string, unknown>): OAuthCredentialStoreV1 {
  if (!hasOnlyKeys(value, ["schemaVersion", "credentials"]) ||
    value.schemaVersion !== 1 || !isRecord(value.credentials)) {
    throw invalidStore();
  }
  return {
    schemaVersion: 1,
    credentials: decodeProviderCredentials(value.credentials),
  };
}

function decodeStoreV2(value: Record<string, unknown>): OAuthCredentialStoreV2 {
  if (!hasOnlyKeys(value, ["schemaVersion", "credentials", "legacyCredentials"]) ||
    value.schemaVersion !== 2 ||
    !isRecord(value.credentials) ||
    !isRecord(value.legacyCredentials)) {
    throw invalidStore();
  }
  const credentials: OAuthCredentialStoreV2["credentials"] = {};
  for (const [profileId, rawCredentials] of Object.entries(value.credentials)) {
    if (!isProfileId(profileId) || !isRecord(rawCredentials)) {
      throw invalidStore();
    }
    const scoped = decodeProviderCredentials(rawCredentials);
    if (Object.keys(scoped).length === 0) throw invalidStore();
    credentials[profileId] = scoped;
  }
  return {
    schemaVersion: 2,
    credentials,
    legacyCredentials: decodeProviderCredentials(value.legacyCredentials),
  };
}

function decodeProviderCredentials(
  rawCredentials: Record<string, unknown>,
): Partial<Record<OAuthProvider, OAuthCredential>> {
  if (!hasOnlyKeys(rawCredentials, oauthProviders)) throw invalidStore();
  const credentials: Partial<Record<OAuthProvider, OAuthCredential>> = {};
  for (const provider of oauthProviders) {
    const credential = rawCredentials[provider];
    if (credential === undefined) continue;
    credentials[provider] = validateCredential(credential, provider);
  }
  return credentials;
}

function migrateStoreV1(store: OAuthCredentialStoreV1): OAuthCredentialStoreV2 {
  return {
    schemaVersion: 2,
    credentials: {},
    legacyCredentials: store.credentials,
  };
}

function migrateStoreV2(store: OAuthCredentialStoreV2): OAuthCredentialStoreV3 {
  const credentials: OAuthCredentialStoreV3["credentials"] = {};
  for (const [profileId, scoped] of Object.entries(store.credentials)) {
    const { google: _retiredGoogle, ...retained } = scoped;
    if (Object.keys(retained).length > 0) credentials[profileId] = retained;
  }
  const { google: _retiredLegacyGoogle, ...legacyCredentials } =
    store.legacyCredentials;
  return { schemaVersion: 3, credentials, legacyCredentials };
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

function requireProfileId(profileId: string): void {
  if (!isProfileId(profileId)) throw new Error("OAuth credentials require a valid Profile ID.");
}

function ownProfileCredentials(
  credentials: OAuthCredentialStoreV3["credentials"],
  profileId: string,
): Partial<Record<OAuthProvider, OAuthCredential>> {
  return Object.prototype.hasOwnProperty.call(credentials, profileId)
    ? credentials[profileId]!
    : {};
}

function ownProviderCredential(
  credentials: Partial<Record<OAuthProvider, OAuthCredential>> | undefined,
  provider: OAuthProvider,
): OAuthCredential | undefined {
  if (!credentials) return undefined;
  return Object.prototype.hasOwnProperty.call(credentials, provider)
    ? credentials[provider]
    : undefined;
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
