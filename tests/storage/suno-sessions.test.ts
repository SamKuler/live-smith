import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { isStorageCommitOutcomeUnknownError, withStorageTransaction } from "../../src/storage/persistence.js";
import { SunoSessions, SunoSessionStorageError } from "../../src/storage/suno-sessions.js";

const rawClient = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj";
const record = { clientToken: `__client=${rawClient}`, accountId: "user_fixture", accountName: "Fixture" };
async function harness(t: TestContext) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-session-storage-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new SunoSessions(directory) };
}

test("private per-service atomic records isolate owners and strict public identity from the token", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  await h.store.save("two", { ...record, accountId: "user_other" });
  assert.deepEqual(await h.store.load("one"), record);
  const files = await fs.readdir(h.directory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const stat = await fs.lstat(path.join(h.directory, file));
    assert.ok(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o700);
  assert.equal(await withStorageTransaction(h.directory, (transaction) => h.store.clear("one", transaction)), true);
  assert.equal(await h.store.load("one"), undefined);
  assert.equal((await h.store.load("two"))?.accountId, "user_other");
  assert.equal(await h.store.clear("one"), false);
});

test("legacy raw __client records are projected into the canonical private Cookie form", async (t) => {
  const h = await harness(t);
  await fs.writeFile(path.join(h.directory, "suno-session-one.json"), JSON.stringify({
    schemaVersion: 1, serviceId: "one", accountId: "user_fixture", clientToken: rawClient,
  }));
  assert.deepEqual(await h.store.load("one"), { accountId: "user_fixture", clientToken: `__client=${rawClient}` });
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

test("an already-private storage root is accepted without chmod", async (t) => {
  const h = await harness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  let directoryChmods = 0;
  const chmod = prototype.chmod;
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle, mode: number) {
    if ((await this.stat()).isDirectory()) directoryChmods++;
    return chmod.call(this, mode);
  });
  assert.equal(await h.store.load("one"), undefined);
  assert.equal(directoryChmods, 0);
});

test("a permissive storage root is tightened and revalidated", async (t) => {
  const h = await harness(t);
  await fs.chmod(h.directory, 0o755);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  let directoryChmods = 0;
  const chmod = prototype.chmod;
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle, mode: number) {
    if ((await this.stat()).isDirectory()) directoryChmods++;
    return chmod.call(this, mode);
  });
  assert.equal(await h.store.load("one"), undefined);
  assert.equal(directoryChmods, 1);
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o700);
});

test("a permissive storage root fails closed when tightening fails", async (t) => {
  const h = await harness(t);
  await fs.chmod(h.directory, 0o755);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error(record.clientToken);
  });
  await assert.rejects(h.store.load("one"), (error) => {
    assert.ok(error instanceof SunoSessionStorageError);
    assert.ok(!String(error.stack).includes(record.clientToken));
    return true;
  });
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o755);
});

test("a permissive storage root fails closed when tightening is ineffective", async (t) => {
  const h = await harness(t);
  await fs.chmod(h.directory, 0o755);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  t.mock.method(prototype, "chmod", async () => undefined);
  await assert.rejects(h.store.load("one"), SunoSessionStorageError);
  assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o755);
});

test("an already-private credential record is accepted without chmod", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  let fileChmods = 0;
  const chmod = prototype.chmod;
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle, mode: number) {
    if ((await this.stat()).isFile()) fileChmods++;
    return chmod.call(this, mode);
  });
  assert.deepEqual(await h.store.load("one"), record);
  assert.equal(fileChmods, 0);
});

test("a permissive credential record is tightened and revalidated", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, "suno-session-one.json");
  await fs.chmod(target, 0o644);
  assert.deepEqual(await h.store.load("one"), record);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test("a permissive credential record fails closed when tightening fails", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, "suno-session-one.json");
  await fs.chmod(target, 0o644);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle) {
    if ((await this.stat()).isFile()) throw new Error(record.clientToken);
  });
  await assert.rejects(h.store.load("one"), (error) => {
    assert.ok(error instanceof SunoSessionStorageError);
    assert.ok(!String(error.stack).includes(record.clientToken));
    return true;
  });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});

test("a permissive credential record fails closed when tightening is ineffective", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, "suno-session-one.json");
  await fs.chmod(target, 0o644);
  const probe = await fs.open(target);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  t.mock.method(prototype, "chmod", async () => undefined);
  await assert.rejects(h.store.load("one"), SunoSessionStorageError);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});

test("multiply linked credential records remain rejected", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, "suno-session-one.json");
  await fs.link(target, path.join(h.directory, "linked-record.json"));
  await assert.rejects(h.store.load("one"), SunoSessionStorageError);
});

test("a credential record linked after initial metadata validation is rejected", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const target = path.join(h.directory, "suno-session-one.json");
  const linked = path.join(h.directory, "late-linked-record.json");
  const probe = await fs.open(target);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const stat = prototype.stat;
  let linkCreated = false;
  t.mock.method(prototype, "stat", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["stat"]>) {
    const metadata = await stat.call(this, ...args);
    if (!linkCreated && metadata.isFile()) {
      fsSync.linkSync(target, linked);
      linkCreated = true;
    }
    return metadata;
  });

  await assert.rejects(h.store.load("one"), SunoSessionStorageError);
  assert.equal(linkCreated, true);
  assert.equal((await fs.lstat(target)).nlink, 2);
});

test("symlink roots and files are never read, replaced, chmodded or deleted", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const [file] = await fs.readdir(h.directory);
  const target = path.join(h.directory, file!);
  const outside = `${h.directory}-outside`;
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, JSON.stringify(record), { mode: 0o644 });
  await fs.unlink(target); await fs.symlink(outside, target);
  for (const operation of [() => h.store.load("one"), () => h.store.save("one", record), () => h.store.clear("one")]) {
    await assert.rejects(operation(), SunoSessionStorageError);
  }
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  assert.ok((await fs.lstat(target)).isSymbolicLink());
  const alias = `${h.directory}-alias`;
  t.after(() => fs.unlink(alias)); await fs.symlink(h.directory, alias);
  await assert.rejects(new SunoSessions(alias).load("one"), SunoSessionStorageError);
});

test("oversized, corrupt, foreign-owner and credential-bearing identity records fail closed with safe errors", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const [file] = await fs.readdir(h.directory);
  const target = path.join(h.directory, file!);
  const original = JSON.parse(await fs.readFile(target, "utf8"));
  for (const raw of ["x".repeat(40 * 1024), record.clientToken, JSON.stringify({ ...original, serviceId: "two" }),
    JSON.stringify({ ...original, extra: "secret" }), JSON.stringify({ ...original, clientToken: `__client=${record.clientToken}` }),
    JSON.stringify({ ...original, clientToken: `${record.clientToken}; ignored=browser-cookie` }),
    JSON.stringify({ ...original, accountName: record.clientToken })]) {
    await fs.writeFile(target, raw);
    await assert.rejects(h.store.load("one"), (error) => {
      assert.ok(error instanceof SunoSessionStorageError);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes(record.clientToken)); return true;
    });
  }
});

test("explicit clear recovers corrupt or oversized records without parsing them", async (t) => {
  const h = await harness(t);
  const target = path.join(h.directory, "suno-session-one.json");
  for (const contents of [record.clientToken, "x".repeat(40 * 1024)]) {
    await fs.writeFile(target, contents);
    await assert.rejects(h.store.load("one"), SunoSessionStorageError);
    await assert.rejects(h.store.save("one", record), SunoSessionStorageError);
    assert.equal(await withStorageTransaction(h.directory, (transaction) => h.store.clear("one", transaction)), true);
    assert.equal(await h.store.load("one"), undefined);
  }
  await h.store.save("one", record);
  assert.deepEqual(await h.store.load("one"), record);
});

test("uncertain save and clear retain their classification with a new safe cause", async (t) => {
  const h = await harness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const sync = prototype.sync;
  const mock = t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error(record.clientToken);
    return sync.call(this);
  });
  const check = (error: unknown) => {
    assert.ok(isStorageCommitOutcomeUnknownError(error));
    assert.ok(error.cause instanceof SunoSessionStorageError);
    assert.equal(error.cause.cause, undefined);
    assert.ok(!String(error.stack).includes(record.clientToken)); return true;
  };
  await assert.rejects(h.store.save("one", record), check);
  assert.deepEqual(await h.store.load("one"), record);
  await assert.rejects(h.store.clear("one"), check);
  assert.equal(await h.store.load("one"), undefined);
  mock.mock.restore();
  let confirmations = 0;
  t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    if ((await this.stat()).isDirectory()) confirmations++;
    return sync.call(this);
  });
  assert.equal(await h.store.clear("one"), false);
  assert.equal(confirmations, 1, "retry confirms directory durability even when the file is already absent");
});

test("a directory replaced during one clear operation is not accepted as the original owner", async (t) => {
  const h = await harness(t);
  await h.store.save("one", record);
  const displaced = `${h.directory}-displaced`;
  t.after(() => fs.rm(displaced, { recursive: true, force: true }));
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const stat = prototype.stat;
  let swapped = false;
  let directoryStats = 0;
  const mock = t.mock.method(prototype, "stat", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["stat"]>) {
    const metadata = await stat.call(this, ...args);
    if (metadata.isDirectory() && ++directoryStats === 2) {
      swapped = true;
      fsSync.renameSync(h.directory, displaced);
      fsSync.mkdirSync(h.directory);
      fsSync.copyFileSync(path.join(displaced, "suno-session-one.json"), path.join(h.directory, "suno-session-one.json"));
    }
    return metadata;
  });
  await assert.rejects(h.store.clear("one"), SunoSessionStorageError);
  mock.mock.restore();
  assert.equal(swapped, true);
  assert.ok(await fs.stat(path.join(h.directory, "suno-session-one.json")));
  assert.ok(await fs.stat(path.join(displaced, "suno-session-one.json")));
});

test("clear reports false for a storage root that does not exist", async (t) => {
  const h = await harness(t);
  assert.equal(await new SunoSessions(path.join(h.directory, "absent")).clear("one"), false);
  assert.deepEqual(await fs.readdir(h.directory), []);
});
