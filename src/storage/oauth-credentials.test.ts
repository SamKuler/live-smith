import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  deleteOAuthCredential,
  deleteOAuthCredentialProfile,
  loadOAuthCredential,
  prepareOAuthCredentialStoreInTransaction,
  retainOAuthCredentialForProfileProvider,
  saveOAuthCredential,
  type OAuthCredential,
} from "./oauth-credentials.js";
import type { OAuthSubscriptionProvider, SavedProfile } from "../model/profile.js";
import { withStorageTransaction } from "./persistence.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-credentials-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const credentials: OAuthCredential[] = [
  {
    provider: "openai",
    accessToken: "openai-access",
    refreshToken: "openai-refresh",
    expiresAt: 2_000_000_000_000,
    accountId: "account-1",
  },
  {
    provider: "anthropic",
    accessToken: "anthropic-access",
    refreshToken: "anthropic-refresh",
    expiresAt: 2_000_000_000_000,
  },
  {
    provider: "google",
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: 2_000_000_000_000,
    projectId: "project-1",
    accountLabel: "listener@example.com",
  },
];

test("legacy Gemini CLI Google credentials are not reused for Antigravity", async (t) => {
  const directory = await temporaryDirectory(t);
  const oauthDirectory = path.join(directory, "oauth");
  await fs.mkdir(oauthDirectory, { recursive: true });
  const legacyGoogle = {
    provider: "google",
    accessToken: "legacy-google-access",
    refreshToken: "legacy-google-refresh",
    expiresAt: 2_000_000_000_000,
    projectId: "legacy-project",
    accountLabel: "listener@example.com",
  };
  await fs.writeFile(
    path.join(oauthDirectory, "credentials.json"),
    JSON.stringify({
      schemaVersion: 2,
      credentials: {
        "google-profile": { google: legacyGoogle },
        "openai-profile": { openai: credentials[0] },
        "anthropic-profile": { anthropic: credentials[1] },
      },
      legacyCredentials: {
        google: legacyGoogle,
        openai: credentials[0],
        anthropic: credentials[1],
      },
    }),
  );

  assert.equal(
    await loadOAuthCredential(directory, "google-profile", "google"),
    undefined,
  );
  assert.deepEqual(
    await loadOAuthCredential(directory, "openai-profile", "openai"),
    credentials[0],
  );
  const migrated = JSON.parse(
    await fs.readFile(path.join(oauthDirectory, "credentials.json"), "utf8"),
  ) as {
    schemaVersion: number;
    credentials: Record<string, Record<string, OAuthCredential>>;
    legacyCredentials: Record<string, OAuthCredential>;
  };
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.credentials, {
    "openai-profile": { openai: credentials[0] },
    "anthropic-profile": { anthropic: credentials[1] },
  });
  assert.deepEqual(migrated.legacyCredentials, {
    openai: credentials[0],
    anthropic: credentials[1],
  });
});

test("OAuth credentials are private, Profile-scoped, and replace atomically", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const credential of credentials) {
    await saveOAuthCredential(directory, `${credential.provider}-profile`, credential);
  }

  for (const credential of credentials) {
    assert.deepEqual(
      await loadOAuthCredential(
        directory,
        `${credential.provider}-profile`,
        credential.provider,
      ),
      credential,
    );
  }

  const target = path.join(directory, "oauth", "credentials.json");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }

  await saveOAuthCredential(directory, "openai-profile", {
    ...credentials[0]!,
    accessToken: "replacement-access",
  });
  assert.equal(
    (await loadOAuthCredential(directory, "openai-profile", "openai"))?.accessToken,
    "replacement-access",
  );
  assert.equal(
    (await loadOAuthCredential(
      directory,
      "anthropic-profile",
      "anthropic",
    ))?.accessToken,
    "anthropic-access",
  );
});

test("same-provider OAuth credentials are isolated by Profile", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = credentials[0]!;
  const second = {
    ...first,
    accessToken: "second-access",
    refreshToken: "second-refresh",
    accountId: "account-2",
  };
  await saveOAuthCredential(directory, "profile-a", first);
  await saveOAuthCredential(directory, "profile-b", second);

  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-a", "openai"),
    first,
  );
  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-b", "openai"),
    second,
  );

  await deleteOAuthCredential(directory, "profile-a", "openai");

  assert.equal(
    await loadOAuthCredential(directory, "profile-a", "openai"),
    undefined,
  );
  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-b", "openai"),
    second,
  );
});

test("one Profile keeps provider credentials isolated until its connection is saved", async (t) => {
  const directory = await temporaryDirectory(t);
  await saveOAuthCredential(directory, "profile-a", credentials[0]!);
  await saveOAuthCredential(directory, "profile-a", credentials[1]!);

  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-a", "openai"),
    credentials[0],
  );
  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-a", "anthropic"),
    credentials[1],
  );
  await deleteOAuthCredential(directory, "profile-a", "openai");
  assert.deepEqual(
    await loadOAuthCredential(directory, "profile-a", "anthropic"),
    credentials[1],
  );
  await retainOAuthCredentialForProfileProvider(
    directory,
    "profile-a",
    "openai",
  );
  assert.equal(
    await loadOAuthCredential(directory, "profile-a", "anthropic"),
    undefined,
  );
  await saveOAuthCredential(directory, "profile-a", credentials[1]!);
  await deleteOAuthCredentialProfile(directory, "profile-a");
  assert.equal(
    await loadOAuthCredential(directory, "profile-a", "anthropic"),
    undefined,
  );
});

test("legacy provider credentials migrate only to a deterministic saved Profile", async (t) => {
  const directory = await temporaryDirectory(t);
  const oauthDirectory = path.join(directory, "oauth");
  await fs.mkdir(oauthDirectory, { recursive: true });
  await fs.writeFile(
    path.join(oauthDirectory, "credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      credentials: { openai: credentials[0] },
    }),
  );

  assert.equal(
    await loadOAuthCredential(directory, "new-draft", "openai"),
    undefined,
  );
  const first = subscriptionProfile("profile-a", "openai");
  const active = subscriptionProfile("profile-b", "openai");
  await withStorageTransaction(directory, (transaction) =>
    prepareOAuthCredentialStoreInTransaction(
      transaction,
      directory,
      [first, active],
      active.id,
    )
  );
  assert.equal(
    await loadOAuthCredential(directory, first.id, "openai"),
    undefined,
  );
  assert.deepEqual(
    await loadOAuthCredential(directory, active.id, "openai"),
    credentials[0],
  );

  const persisted = JSON.parse(
    await fs.readFile(path.join(oauthDirectory, "credentials.json"), "utf8"),
  ) as {
    schemaVersion: number;
    credentials: Record<string, Record<string, OAuthCredential>>;
    legacyCredentials: Record<string, OAuthCredential>;
  };
  assert.equal(persisted.schemaVersion, 3);
  assert.deepEqual(persisted.credentials, {
    "profile-b": { openai: credentials[0] },
  });
  assert.deepEqual(persisted.legacyCredentials, {});
});

test("legacy credentials without an existing saved owner cannot reach a future Profile", async (t) => {
  const directory = await temporaryDirectory(t);
  const oauthDirectory = path.join(directory, "oauth");
  await fs.mkdir(oauthDirectory, { recursive: true });
  await fs.writeFile(
    path.join(oauthDirectory, "credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      credentials: { openai: credentials[0] },
    }),
  );

  await withStorageTransaction(directory, (transaction) =>
    prepareOAuthCredentialStoreInTransaction(
      transaction,
      directory,
      [],
      null,
    )
  );
  const future = subscriptionProfile("future-profile", "openai");
  await withStorageTransaction(directory, (transaction) =>
    prepareOAuthCredentialStoreInTransaction(
      transaction,
      directory,
      [future],
      future.id,
    )
  );

  assert.equal(
    await loadOAuthCredential(directory, future.id, "openai"),
    undefined,
  );
  await saveOAuthCredential(directory, future.id, credentials[0]!);
  await withStorageTransaction(directory, (transaction) =>
    prepareOAuthCredentialStoreInTransaction(
      transaction,
      directory,
      [],
      null,
    )
  );
  assert.equal(
    await loadOAuthCredential(directory, future.id, "openai"),
    undefined,
  );
});

test("OAuth credential reads reject malformed or unknown persisted fields", async (t) => {
  const directory = await temporaryDirectory(t);
  const oauthDirectory = path.join(directory, "oauth");
  await fs.mkdir(oauthDirectory, { recursive: true });
  await fs.writeFile(
    path.join(oauthDirectory, "credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      credentials: {
        openai: {
          ...credentials[0],
          leakedField: "unexpected",
        },
      },
    }),
  );

  await assert.rejects(
    loadOAuthCredential(directory, "profile-a", "openai"),
    /OAuth credential store is invalid/i,
  );
});

test("OAuth credential storage requires an Ableton storage directory", async () => {
  await assert.rejects(
    saveOAuthCredential(undefined, "profile-a", credentials[0]!),
    /storage directory/i,
  );
  await assert.rejects(
    loadOAuthCredential(undefined, "profile-a", "openai"),
    /storage directory/i,
  );
  await assert.rejects(
    loadOAuthCredential("/tmp/live-smith-invalid-profile", "bad profile", "openai"),
    /valid Profile ID/i,
  );
});

function subscriptionProfile(
  id: string,
  provider: OAuthSubscriptionProvider,
): SavedProfile {
  return {
    id,
    name: id,
    connection: { kind: "oauth-subscription", provider },
    defaultModel: "model-1",
    models: [{
      model: "model-1",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
}
