import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { isStorageCommitOutcomeUnknownError, withStorageTransaction } from "../../src/storage/persistence.js";
import { SunoSessions, SunoSessionStorageError } from "../../src/storage/suno-sessions.js";
import { MEDIA_DIRECTORY_NAME } from "../../src/storage/media-files.js";
import { listStoredEntries, writeStoredBytes, STORAGE_DATABASE_NAME } from "../../src/storage/sqlite.js";

const rawClient = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj";
const record = { clientToken: `__client=${rawClient}`, accountId: "user_fixture", accountName: "Fixture" };
async function harness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-session-storage-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new SunoSessions(directory) };
}


test("private per-service records isolate owners and strict public identity from the token", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  await h.store.save("two", { ...record, accountId: "user_other" });
  assert.deepEqual(await h.store.load("one"), record);
  assert.equal((await listStoredEntries(h.directory)).length, 2);
  const files = await fs.readdir(h.directory);
  assert.deepEqual(files.sort(), [MEDIA_DIRECTORY_NAME, STORAGE_DATABASE_NAME].sort());
  assert.deepEqual(await fs.readdir(path.join(h.directory, MEDIA_DIRECTORY_NAME)), []);
  assert.equal((await fs.stat(path.join(h.directory, STORAGE_DATABASE_NAME))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o700);
  assert.equal(await withStorageTransaction(h.directory, (transaction) => h.store.clear("one", transaction)), true);
  assert.equal(await h.store.load("one"), undefined);
  assert.equal((await h.store.load("two"))?.accountId, "user_other");
  assert.equal(await h.store.clear("one"), false);
});

test("legacy raw __client records are projected into the canonical private Cookie form while preserving the source", async (t) => {
  const h = await harness(t);
  const file = path.join(h.directory, "suno-session-one.json");
  const original = JSON.stringify({ schemaVersion: 1, serviceId: "one", accountId: "user_fixture", clientToken: rawClient });
  await fs.writeFile(file, original);
  assert.deepEqual(await h.store.load("one"), { accountId: "user_fixture", clientToken: `__client=${rawClient}` });
  await h.store.save("one", record);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("invalid IDs, missing storage and foreign transactions fail without secrets or filesystem paths", async (t) => {
  const h = await harness(t);
  for (const id of ["../outside", "/tmp/elsewhere", "", "a".repeat(129)]) {
    await assert.rejects(h.store.save(id, record), SunoSessionStorageError);
  }
  await assert.rejects(new SunoSessions(undefined).save("one", record), SunoSessionStorageError);
  await withStorageTransaction(undefined, async (transaction) => {
    await assert.rejects(h.store.clear("one", transaction), SunoSessionStorageError);
  });
});

test("permissive storage root and database modes are tightened before credentials are read", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const database = path.join(h.directory, STORAGE_DATABASE_NAME);
  await fs.chmod(h.directory, 0o755);
  await fs.chmod(database, 0o644);
  assert.deepEqual(await h.store.load("one"), record);
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(database)).mode & 0o777, 0o600);
});

test("multiply linked database files fail closed before credentials can be changed", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, STORAGE_DATABASE_NAME);
  await fs.link(target, path.join(h.directory, "linked-database"));
  await assert.rejects(h.store.load("one"), SunoSessionStorageError);
  await assert.rejects(h.store.clear("one"), SunoSessionStorageError);
});

test("symlink credential sources are rejected during import without reading or changing their target", async (t) => {
  const h = await harness(t);
  const outside = `${h.directory}-outside`;
  t.after(() => fs.rm(outside, { force: true }));
  const original = JSON.stringify(record);
  await fs.writeFile(outside, original, { mode: 0o644 });
  const target = path.join(h.directory, "suno-session-one.json");
  await fs.symlink(outside, target);
  for (const operation of [() => h.store.load("one"), () => h.store.save("one", record), () => h.store.clear("one")]) {
    await assert.rejects(operation(), SunoSessionStorageError);
  }
  assert.equal(await fs.readFile(outside, "utf8"), original);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  assert.ok((await fs.lstat(target)).isSymbolicLink());
});

test("oversized, corrupt, invalid UTF-8 and foreign-owner records fail with safe errors", async (t) => {
  const h = await harness(t);
  const target = "suno-session-one.json";
  const original = { schemaVersion: 1, serviceId: "one", ...record };
  for (const raw of ["x".repeat(40 * 1024), record.clientToken, JSON.stringify({ ...original, serviceId: "two" }),
    JSON.stringify({ ...original, extra: "secret" }), JSON.stringify({ ...original, clientToken: `__client=${record.clientToken}` }),
    JSON.stringify({ ...original, clientToken: `${record.clientToken}; ignored=browser-cookie` }),
    JSON.stringify({ ...original, accountName: record.clientToken }), Buffer.from([0xff, 0xfe])]) {
    await writeStoredBytes(h.directory, target, typeof raw === "string" ? Buffer.from(raw) : raw);
    await assert.rejects(h.store.load("one"), (error) => {
      assert.ok(error instanceof SunoSessionStorageError);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes(record.clientToken));
      assert.ok(!String(error.stack).includes(h.directory));
      return true;
    });
  }
});

test("explicit clear recovers corrupt or oversized records without parsing them", async (t) => {
  const h = await harness(t);
  for (const contents of [record.clientToken, "x".repeat(40 * 1024)]) {
    await writeStoredBytes(h.directory, "suno-session-one.json", Buffer.from(contents));
    await assert.rejects(h.store.load("one"), SunoSessionStorageError);
    await assert.rejects(h.store.save("one", record), SunoSessionStorageError);
    assert.equal(await withStorageTransaction(h.directory, (transaction) => h.store.clear("one", transaction)), true);
    assert.equal(await h.store.load("one"), undefined);
  }
  await h.store.save("one", record);
  assert.deepEqual(await h.store.load("one"), record);
});

test("a corrupt database remains unreadable and credential errors omit storage details", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  await fs.writeFile(path.join(h.directory, STORAGE_DATABASE_NAME), record.clientToken);
  for (const operation of [() => h.store.load("one"), () => h.store.save("one", record), () => h.store.clear("one")]) {
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof SunoSessionStorageError);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes(record.clientToken));
      return true;
    });
  }
});

test("clear reports false when the initialized database has no matching credential", async (t) => {
  const h = await harness(t);
  assert.equal(await h.store.clear("one"), false);
  assert.deepEqual(await listStoredEntries(h.directory), []);
});


test("uncertain database commits preserve Suno outcome classification with a safe cause", async (t) => {
  const h = await harness(t);
  await h.store.load("one");
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "COMMIT") throw new Error(record.clientToken);
  });
  const check = (error: unknown) => {
    assert.ok(isStorageCommitOutcomeUnknownError(error));
    assert.ok(error.cause instanceof SunoSessionStorageError);
    assert.equal(error.cause.cause, undefined);
    assert.ok(!String(error.stack).includes(record.clientToken));
    return true;
  };
  await assert.rejects(h.store.save("one", record), check);
  assert.deepEqual(await h.store.load("one"), record);
  await assert.rejects(h.store.clear("one"), check);
  assert.equal(await h.store.load("one"), undefined);
});
