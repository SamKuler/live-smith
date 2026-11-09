import assert from "node:assert/strict";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test from "node:test";
import { listAudioAssets, readExpectedAudioAsset } from "../../src/storage/audio-assets.js";
import { listStoredChildren } from "../../src/storage/sqlite.js";
import { audioStorageHarness, waveBytes } from "./support/audio-storage-test-helpers.js";

test("a committed blob retains its recovery receipt when the commit acknowledgement fails", async (t) => {
  const h = await audioStorageHarness(t);
  let wroteBlob = false;
  const run = StatementSync.prototype.run;
  const write = t.mock.method(StatementSync.prototype, "run", function(this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL.startsWith("INSERT INTO entries") && String(args[0]).endsWith(".audio")) wroteBlob = true;
    return Reflect.apply(run, this, args);
  });
  const exec = DatabaseSync.prototype.exec;
  const commit = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === "COMMIT" && wroteBlob) throw new Error("commit acknowledgement interrupted");
    return result;
  });
  await assert.rejects(h.save(), /outcome|commit/i);
  commit.mock.restore(); write.mock.restore();
  assert.equal(wroteBlob, true);
  const assets = await listAudioAssets(h.storage, h.session.id);
  assert.equal(assets.length, 1);
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, assets[0]!), waveBytes());
  assert.deepEqual(await h.save(), assets[0]);
});

test("metadata-only receipts stay unavailable and an exact retry can finish their blob", async (t) => {
  const h = await audioStorageHarness(t);
  const run = StatementSync.prototype.run;
  const fault = t.mock.method(StatementSync.prototype, "run", function(this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL.startsWith("INSERT INTO entries") && String(args[0]).endsWith(".audio")) throw new Error("audio write interrupted");
    return Reflect.apply(run, this, args);
  });
  await assert.rejects(h.save(), /audio write interrupted/);
  fault.mock.restore();
  const names = await listStoredChildren(h.storage, h.directory);
  assert.equal(names.filter(name => name.endsWith(".asset.json")).length, 1);
  assert.equal(names.filter(name => name.endsWith(".audio")).length, 0);
  assert.deepEqual(await listAudioAssets(h.storage, h.session.id), []);
  await assert.rejects(h.save("source", waveBytes(2)), /differs/);
  const asset = await h.save();
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset), waveBytes());
});

test("failure to establish asset metadata never leaves an unindexed committed blob", async (t) => {
  const h = await audioStorageHarness(t);
  const run = StatementSync.prototype.run;
  const fault = t.mock.method(StatementSync.prototype, "run", function(this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL.startsWith("INSERT INTO entries") && String(args[0]).endsWith(".asset.json")) throw new Error("metadata unavailable");
    return Reflect.apply(run, this, args);
  });
  await assert.rejects(h.save(), /metadata unavailable/);
  fault.mock.restore();
  assert.equal((await listStoredChildren(h.storage, h.directory)).filter(name => name.endsWith(".audio")).length, 0);
});
