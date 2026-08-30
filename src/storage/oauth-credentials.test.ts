import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  deleteOAuthCredential,
  loadOAuthCredential,
  saveOAuthCredential,
  type OAuthCredential,
} from "./oauth-credentials.js";

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

test("OAuth credentials are private, provider-scoped, and replace atomically", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const credential of credentials) {
    await saveOAuthCredential(directory, credential);
  }

  for (const credential of credentials) {
    assert.deepEqual(
      await loadOAuthCredential(directory, credential.provider),
      credential,
    );
  }

  const target = path.join(directory, "oauth", "credentials.json");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }

  await saveOAuthCredential(directory, {
    ...credentials[0]!,
    accessToken: "replacement-access",
  });
  assert.equal(
    (await loadOAuthCredential(directory, "openai"))?.accessToken,
    "replacement-access",
  );
  assert.equal(
    (await loadOAuthCredential(directory, "anthropic"))?.accessToken,
    "anthropic-access",
  );
});

test("deleting one OAuth credential preserves other providers", async (t) => {
  const directory = await temporaryDirectory(t);
  await saveOAuthCredential(directory, credentials[0]!);
  await saveOAuthCredential(directory, credentials[1]!);

  await deleteOAuthCredential(directory, "openai");

  assert.equal(await loadOAuthCredential(directory, "openai"), undefined);
  assert.deepEqual(
    await loadOAuthCredential(directory, "anthropic"),
    credentials[1],
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
    loadOAuthCredential(directory, "openai"),
    /OAuth credential store is invalid/i,
  );
});

test("OAuth credential storage requires an Ableton storage directory", async () => {
  await assert.rejects(
    saveOAuthCredential(undefined, credentials[0]!),
    /storage directory/i,
  );
  await assert.rejects(
    loadOAuthCredential(undefined, "openai"),
    /storage directory/i,
  );
});
