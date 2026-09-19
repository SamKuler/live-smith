import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { loadAgentSettings, saveGlobalSettings } from "./settings.js";
import { SunoSessions } from "./suno-sessions.js";
import { isStorageCommitOutcomeUnknownError } from "./persistence.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import { migrateAudioServiceConnection } from "../plugins/integration-connections.js";

const account = { id: "suno-one", name: "Suno", provider: "suno" as const, enabled: false, apiKey: "" };
const storedAccount = migrateAudioServiceConnection(account);
const cookie = { clientToken: "__client=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c3ludGhldGlj", accountId: "user_fixture" };
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-settings-suno-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: "0", connection: storedAccount,
  } });
  const store = new SunoSessions(directory);
  await store.save(account.id, cookie);
  await store.save("other", { ...cookie, accountId: "user_other" });
  return { directory, store };
}

test("invalid and conflicting audio edits cannot clear Suno credentials", async (t) => {
  const h = await fixture(t);
  for (const patch of [
    { action: "remove" as const, expectedRevision: "0", connectionId: account.id },
    { action: "upsert" as const, expectedRevision: "1", connection: {
      ...storedAccount,
      pluginId: builtInAudioPluginId("elevenlabs"),
      name: "",
    } },
  ]) {
    await assert.rejects(saveGlobalSettings(h.directory, { integrationConnections: patch }));
    assert.deepEqual(await h.store.load(account.id), cookie);
  }
  assert.equal((await loadAgentSettings(h.directory)).integrationConnections!.revision, "1");
});

for (const change of ["rename", "remove", "replace"] as const) {
  test(`settings owns Suno Cookie cleanup for ${change}, even without a dialog`, async (t) => {
    const h = await fixture(t);
    await saveGlobalSettings(h.directory, { integrationConnections: change === "remove"
      ? { action: "remove", expectedRevision: "1", connectionId: account.id }
      : { action: "upsert", expectedRevision: "1", connection: {
        ...storedAccount,
        name: "Renamed",
        pluginId: builtInAudioPluginId(change === "replace" ? "elevenlabs" : "suno"),
      } } });
    assert.deepEqual(await h.store.load(account.id), change === "rename" ? cookie : undefined);
    assert.equal((await h.store.load("other"))!.accountId, "user_other");
    assert.equal((await loadAgentSettings(h.directory)).integrationConnections!.revision, "2");
  });
}

for (const retainsCookie of [true, false]) {
  test(`failed settings persistence reports partial cleanup only when a Cookie was removed: ${retainsCookie}`, async (t) => {
    const h = await fixture(t);
    if (!retainsCookie) await h.store.clear(account.id);
    const handle = await fs.open(h.directory);
    const prototype = Object.getPrototypeOf(handle) as fs.FileHandle;
    await handle.close();
    t.mock.method(prototype, "writeFile", async () => { throw new Error("Injected settings write failure"); });
    await assert.rejects(saveGlobalSettings(h.directory, { integrationConnections: {
      action: "remove", expectedRevision: "1", connectionId: account.id,
    } }), (error: unknown) => {
      assert.equal(isStorageCommitOutcomeUnknownError(error), retainsCookie);
      return true;
    });
    assert.equal(await h.store.load(account.id), undefined);
    assert.equal((await loadAgentSettings(h.directory)).integrationConnections!.connections[0]!.id, account.id);
  });
}
