import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  acquireSharedModelBackendManager,
} from "./shared-backend-manager.js";
import type { OAuthSubscriptionBackend } from "./provider.js";

function backend(): OAuthSubscriptionBackend & { closeCalls: number } {
  return {
    kind: "oauth-subscription",
    closeCalls: 0,
    async listModels() { return []; },
    async createToolTurn() { return { content: "ok", toolCalls: [] }; },
    async readAuthState() { return { status: "signed-out" } as const; },
    async beginLogin() { return { status: "signed-out" } as const; },
    async logout() { return { status: "signed-out" } as const; },
    async close() { this.closeCalls += 1; },
  };
}

test("canonical storage paths share one OAuth backend manager until the final release", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-shared-oauth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "storage");
  const alias = path.join(root, "alias");
  await fs.mkdir(storage);
  await fs.symlink(storage, alias);
  const instance = backend();
  let starts = 0;
  const options = {
    startOAuthBackend: async () => {
      starts += 1;
      return instance;
    },
  };

  const [first, second] = await Promise.all([
    acquireSharedModelBackendManager(storage, options),
    acquireSharedModelBackendManager(alias, options),
  ]);
  assert.equal(first.manager, second.manager);
  assert.equal(await first.manager.oauth("profile-shared", "openai"), instance);
  assert.equal(await second.manager.oauth("profile-shared", "openai"), instance);
  assert.equal(starts, 1);

  await first.release();
  assert.equal(instance.closeCalls, 0);
  await second.release();
  assert.equal(instance.closeCalls, 1);
});

test("different storage directories never share OAuth credentials or backends", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-shared-oauth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstDirectory = path.join(root, "first");
  const secondDirectory = path.join(root, "second");
  await fs.mkdir(firstDirectory);
  await fs.mkdir(secondDirectory);

  const first = await acquireSharedModelBackendManager(firstDirectory);
  const second = await acquireSharedModelBackendManager(secondDirectory);
  assert.notEqual(first.manager, second.manager);
  await first.release();
  await second.release();
});
