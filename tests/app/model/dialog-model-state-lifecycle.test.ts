import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createDialogModelState } from "../../../src/app/model/dialog-model-state.js";
import { loadAgentSettings, prepareOAuthCredentialStoreForSavedProfiles } from "../../../src/storage/settings.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { readStoredText, writeStoredBytes } from "../../../src/storage/sqlite.js";
import { Buffer } from "node:buffer";

test("concurrent model-state shutdowns drain queued credential preparation after closing their backends", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "model-state-preparation-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await loadAgentSettings(directory);
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withStorageTransaction(directory, async () => {
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  const backendClosed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const states = backendClosed.map((closed) => createDialogModelState({
    storageDirectory: directory,
    dependencies: { modelBackendManager: {
      forProfile: () => { throw new Error("Unexpected model request"); },
      oauth: () => { throw new Error("Unexpected OAuth request"); },
      oauthLease: () => { throw new Error("Unexpected OAuth lease"); },
      invalidateOAuth: async () => {},
      close: async () => { closed.resolve(); },
    } },
    withRequestConfiguration: (_signal, operation) => operation(),
    notifyOAuthAuthStateChanged: () => {},
  }));
  let prepared = false;
  const preparation = prepareOAuthCredentialStoreForSavedProfiles(directory).then(() => { prepared = true; });
  const completed: number[] = [];
  const closing = states.map(async (state, index) => {
    await state.stopBrowserLaunches();
    await state.close();
    completed.push(index);
  });
  try {
    await Promise.all(backendClosed.map(({ promise }) => promise));
    await setImmediate();
    assert.equal(prepared, false);
    assert.deepEqual(completed, [], "shutdown retains ownership of its queued storage preparation");
    release.resolve();
    await Promise.all(closing);
    assert.equal(prepared, true);
    assert.deepEqual(completed.sort(), [0, 1]);
  } finally {
    release.resolve();
    await holding;
    await preparation;
    await Promise.allSettled(closing);
  }
});

test("failed credential preparation preserves its record and does not turn normal model-state shutdown into an OAuth error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "model-state-invalid-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeStoredBytes(directory, "oauth/credentials.json", Buffer.from("{invalid"));
  const state = createDialogModelState({
    storageDirectory: directory,
    dependencies: {},
    withRequestConfiguration: (_signal, operation) => operation(),
    notifyOAuthAuthStateChanged: () => {},
  });
  await state.stopBrowserLaunches();
  await state.close();
  assert.equal(await readStoredText(directory, "oauth/credentials.json"), "{invalid");
});
