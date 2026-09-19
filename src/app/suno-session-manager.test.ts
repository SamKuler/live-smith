import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { SunoSessionIdentity } from "../audio-services/suno-session-contracts.js";
import { SunoSessionExpiredError } from "../audio-services/suno-session.js";
import { createHostAbortController } from "../runtime/host.js";
import { isStorageCommitOutcomeUnknownError, StorageCommitOutcomeUnknownError, withStorageTransaction } from "../storage/persistence.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { SunoSessions, SunoSessionStorageError } from "../storage/suno-sessions.js";
import { persistRotatedSunoSession, SunoSessionManager } from "./suno-session-manager.js";
import { integrationConnectionFixture } from "./integration-connection-test-helpers.js";

const token = "__client=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj";
const replacement = "__client=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXBsYWNlbWVudCJ9.c3ludGhldGlj";
const connection = integrationConnectionFixture({
  id: "suno-one", name: "Suno", provider: "suno", enabled: false, apiKey: "",
});
async function harness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-session-manager-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection } });
  let identity: SunoSessionIdentity = { accountId: "user_fixture", accountName: "Fixture" };
  let failure: Error | undefined;
  const calls: string[] = [];
  const verify = async (value: string) => { calls.push(value); if (failure) throw failure; return identity; };
  return { directory, calls, verify, manager: new SunoSessionManager(directory, verify),
    signal: createHostAbortController().signal, identity(value: SunoSessionIdentity) { identity = value; },
    fail(error: Error | undefined) { failure = error; } };
}

test("views never fetch; disk-only evidence is saved and live verification is shared", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.manager.views([connection]), [{ serviceId: connection.id, status: "signed_out" }]);
  await new SunoSessions(h.directory).save(connection.id, { clientToken: token, accountId: "user_fixture", accountName: "Fixture" });
  assert.deepEqual(await h.manager.views([connection]), [{ serviceId: connection.id, status: "saved", accountId: "user_fixture", accountName: "Fixture" }]);
  assert.equal(h.calls.length, 0);
  await h.manager.importSession(connection.id, token, h.signal);
  assert.deepEqual(h.calls, [token]);
  assert.deepEqual(await h.manager.views([connection]), [{ serviceId: connection.id, status: "signed_in", accountId: "user_fixture", accountName: "Fixture" }]);
  const peer = new SunoSessionManager(h.directory, h.verify);
  assert.deepEqual(await peer.views([connection]), [{ serviceId: connection.id, status: "signed_in", accountId: "user_fixture", accountName: "Fixture" }]);
  assert.equal(h.calls.length, 1);
  assert.ok(!JSON.stringify(await loadAgentSettings(h.directory)).includes(token));
});

test("verified Cookie rotation persists atomically without overwriting a concurrent reimport", async (t) => {
  const h = await harness(t);
  const store = new SunoSessions(h.directory);
  await store.save(connection.id, { clientToken: token, accountId: "user_fixture", accountName: "Fixture" });
  await persistRotatedSunoSession(h.directory, connection.id, "user_fixture", token, replacement, h.signal);
  assert.equal((await store.load(connection.id))?.clientToken, replacement);
  assert.equal((await h.manager.views([connection]))[0]?.status, "signed_in");

  const concurrent = "__client=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb25jdXJyZW50In0.c3ludGhldGlj";
  await store.save(connection.id, { clientToken: concurrent, accountId: "user_fixture", accountName: "Fixture" });
  await persistRotatedSunoSession(h.directory, connection.id, "user_fixture", token, replacement, h.signal);
  assert.equal((await store.load(connection.id))?.clientToken, concurrent);

  await store.save(connection.id, { clientToken: concurrent, accountId: "user_other" });
  await assert.rejects(
    persistRotatedSunoSession(h.directory, connection.id, "user_fixture", concurrent, replacement, h.signal),
  );
  assert.equal((await store.load(connection.id))?.accountId, "user_other");
});

test("import and refresh require the exact saved Suno owner before contacting the verifier", async (t) => {
  const h = await harness(t);
  await saveGlobalSettings(h.directory, { integrationConnections: {
    action: "upsert",
    expectedRevision: "1",
    connection: integrationConnectionFixture({
      id: "other", name: "Other", provider: "elevenlabs", enabled: false, apiKey: "",
    }),
  } });
  for (const id of ["missing", "other"]) {
    await assert.rejects(h.manager.importSession(id, token, h.signal), /Save this Suno/);
    await assert.rejects(h.manager.refresh(id, h.signal), /Save this Suno/);
  }
  await assert.rejects(h.manager.importSession(connection.id, "wrong", h.signal));
  await assert.rejects(h.manager.refresh(connection.id, h.signal), /Import a Suno session/);
  assert.equal(h.calls.length, 0);
});

test("failed replacement preserves the prior good credential and status; refresh records expired versus unavailable", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  for (const error of [new SunoSessionExpiredError(), new Error(replacement, { cause: new Error(token) })]) {
    h.fail(error);
    await assert.rejects(h.manager.importSession(connection.id, replacement, h.signal), (caught) => {
      assert.equal((caught as Error).cause, undefined);
      assert.ok(!String((caught as Error).stack).includes(replacement)); return true;
    });
    assert.equal((await new SunoSessions(h.directory).load(connection.id))?.clientToken, token);
    assert.equal((await h.manager.views([connection]))[0]?.status, "signed_in");
    await assert.rejects(h.manager.refresh(connection.id, h.signal));
    assert.equal((await h.manager.views([connection]))[0]?.status, error instanceof SunoSessionExpiredError ? "expired" : "unavailable");
    h.fail(undefined); await h.manager.refresh(connection.id, h.signal);
  }
});

test("refresh cannot switch accounts but explicit verified replacement can; peer caches follow disk identity", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  h.identity({ accountId: "user_other", accountName: "Other" });
  await assert.rejects(h.manager.refresh(connection.id, h.signal));
  assert.equal((await new SunoSessions(h.directory).load(connection.id))?.accountId, "user_fixture");
  const peer = new SunoSessionManager(h.directory, h.verify);
  await peer.importSession(connection.id, replacement, h.signal);
  assert.deepEqual(await h.manager.views([connection]), [{ serviceId: connection.id, status: "signed_in", accountId: "user_other", accountName: "Other" }]);
  await withStorageTransaction(h.directory, (transaction) => peer.clear(connection.id, transaction));
  assert.deepEqual(await h.manager.views([connection]), [{ serviceId: connection.id, status: "signed_out" }]);
});

test("cancelled verification cannot commit or replace prior evidence and abort reasons are safe", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  const controller = createHostAbortController();
  const manager = new SunoSessionManager(h.directory, async () => {
    controller.abort(new Error(replacement)); return { accountId: "user_other" };
  });
  await assert.rejects(manager.importSession(connection.id, replacement, controller.signal), (error) => {
    assert.equal((error as Error).name, "AbortError");
    assert.ok(!String((error as Error).stack).includes(replacement)); return true;
  });
  assert.equal((await new SunoSessions(h.directory).load(connection.id))?.clientToken, token);
});

test("corrupt private files produce a credential-free unavailable view without blocking other accounts", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  await fs.writeFile(`${h.directory}/suno-session-${connection.id}.json`, token);
  assert.deepEqual(await h.manager.views([connection, { ...connection, id: "missing" }]), [
    { serviceId: connection.id, status: "unavailable" }, { serviceId: "missing", status: "signed_out" },
  ]);
  assert.equal(h.calls.length, 1);
});

test("late verification cannot recreate a cleared credential or claim a removed saved connection", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  const manager = new SunoSessionManager(h.directory, async () => {
    await h.manager.clear(connection.id); return { accountId: "user_other" };
  });
  await assert.rejects(manager.importSession(connection.id, replacement, h.signal));
  assert.equal(await new SunoSessions(h.directory).load(connection.id), undefined);
  const removed = new SunoSessionManager(h.directory, async () => {
    await saveGlobalSettings(h.directory, { integrationConnections: {
      action: "remove", connectionId: connection.id, expectedRevision: "1",
    } });
    return { accountId: "user_other" };
  });
  await assert.rejects(removed.importSession(connection.id, token, h.signal), /Save this Suno/);
  assert.equal(await new SunoSessions(h.directory).load(connection.id), undefined);
});

test("invalid verified identity cannot replace a good session or project the raw token", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  h.identity({ accountId: "user_other", accountName: replacement });
  await assert.rejects(h.manager.importSession(connection.id, replacement, h.signal));
  assert.equal((await h.manager.views([connection]))[0]?.status, "signed_in");
  assert.equal((await new SunoSessions(h.directory).load(connection.id))?.clientToken, token);
});

test("refresh preserves uncertain commit classification without propagating a raw cause", async (t) => {
  const h = await harness(t);
  await h.manager.importSession(connection.id, token, h.signal);
  const save = SunoSessions.prototype.save;
  t.mock.method(SunoSessions.prototype, "save", async function (this: SunoSessions, ...args: Parameters<typeof save>) {
    await save.apply(this, args);
    throw new StorageCommitOutcomeUnknownError(new Error(token));
  });
  await assert.rejects(h.manager.refresh(connection.id, h.signal), (error) => {
    assert.ok(isStorageCommitOutcomeUnknownError(error));
    assert.ok(error.cause instanceof SunoSessionStorageError);
    assert.equal(error.cause.cause, undefined); return true;
  });
});

for (const status of ["expired", "unavailable"] as const) {
  test(`a peer's ${status} refresh supersedes signed-in evidence for the unchanged cookie`, async (t) => {
    const h = await harness(t);
    const unrelated = await harness(t);
    await h.manager.importSession(connection.id, token, h.signal);
    await unrelated.manager.importSession(connection.id, token, unrelated.signal);
    const before = await fs.readFile(`${h.directory}/suno-session-${connection.id}.json`, "utf8");
    const peer = new SunoSessionManager(`${h.directory}/.`, h.verify);
    h.fail(status === "expired" ? new SunoSessionExpiredError() : new Error(token));
    await assert.rejects(peer.refresh(connection.id, h.signal));
    for (const manager of [h.manager, peer]) {
      assert.deepEqual(await manager.views([connection]), [{ serviceId: connection.id, status }]);
    }
    assert.equal((await unrelated.manager.views([connection]))[0]?.status, "signed_in");
    assert.equal(await fs.readFile(`${h.directory}/suno-session-${connection.id}.json`, "utf8"), before);
    assert.equal(h.calls.length, 2, "views do not perform another verification");
    h.fail(undefined);
    await h.manager.refresh(connection.id, h.signal);
    assert.equal((await peer.views([connection]))[0]?.status, "signed_in");
  });
}

test("shared evidence is pruned for retired connections and follows changed or cleared stored fingerprints", async (t) => {
  const h = await harness(t);
  const peer = new SunoSessionManager(h.directory, h.verify);
  const store = new SunoSessions(h.directory);
  const saved = { clientToken: token, accountId: "user_fixture", accountName: "Fixture" };
  await h.manager.importSession(connection.id, token, h.signal);
  assert.deepEqual(await peer.views([]), []);
  assert.equal((await h.manager.views([connection]))[0]?.status, "saved");
  await h.manager.refresh(connection.id, h.signal);
  await store.save(connection.id, { ...saved, clientToken: replacement });
  assert.equal((await peer.views([connection]))[0]?.status, "saved");
  await store.save(connection.id, saved);
  assert.equal((await h.manager.views([connection]))[0]?.status, "saved", "old fingerprint evidence was pruned");
  await h.manager.refresh(connection.id, h.signal);
  await peer.clear(connection.id);
  await store.save(connection.id, saved);
  assert.equal((await h.manager.views([connection]))[0]?.status, "saved", "clear retires the shared evidence");
});
