import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { listAudioAssets, readExpectedAudioAsset } from "../../src/storage/audio-assets.js";
import { audioStorageHarness, waveBytes } from "./support/audio-storage-test-helpers.js";

test("a blob committed before a directory-sync failure already has its recoverable metadata", async (t) => {
  const h = await audioStorageHarness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const original = prototype.sync;
  await probe.close();
  let interrupted = false;
  const fault = t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    if ((await this.stat()).isDirectory() && (await fs.readdir(h.directory)).some((name) => name.endsWith(".audio"))) {
      interrupted = true;
      throw new Error("blob committed, directory sync interrupted");
    }
    return original.call(this);
  });
  await assert.rejects(h.save(), /outcome|sync|commit/i);
  fault.mock.restore();
  assert.equal(interrupted, true);
  const assets = await listAudioAssets(h.storage, h.session.id);
  assert.equal(assets.length, 1, "committed bytes must never lack their recovery receipt");
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, assets[0]!), waveBytes());
});

test("metadata-only receipts stay unavailable and an exact retry can finish their blob", async (t) => {
  const h = await audioStorageHarness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const original = prototype.writeFile;
  await probe.close();
  const fault = t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
    if (args[0] instanceof Uint8Array) throw new Error("audio write interrupted");
    return original.apply(this, args);
  });
  await assert.rejects(h.save(), /audio write interrupted/);
  fault.mock.restore();
  const names = await fs.readdir(h.directory);
  assert.equal(names.filter((name) => name.endsWith(".asset.json")).length, 1);
  assert.equal(names.filter((name) => name.endsWith(".audio")).length, 0);
  assert.deepEqual(await listAudioAssets(h.storage, h.session.id), []);
  await assert.rejects(h.save("source", waveBytes(2)), /differs/);
  const asset = await h.save();
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset), waveBytes());
});

test("failure to establish asset metadata never leaves an unindexed committed blob", async (t) => {
  const h = await audioStorageHarness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const original = prototype.writeFile;
  await probe.close();
  const fault = t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
    if (typeof args[0] === "string" && args[0].includes('"sha256"')) throw new Error("metadata unavailable");
    return original.apply(this, args);
  });
  await assert.rejects(h.save(), /metadata unavailable/);
  fault.mock.restore();
  assert.equal((await fs.readdir(h.directory)).filter((name) => name.endsWith(".audio")).length, 0);
});
