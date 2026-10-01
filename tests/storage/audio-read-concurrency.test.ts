import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { platform } from "node:process";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { createHostAbortController } from "../../src/runtime/host.js";
import { readAudioAsset } from "../../src/storage/audio-assets.js";
import { AudioStorageError, bindAudioDirectory, listAudioJobs, readBoundedAudioFile } from "../../src/storage/audio-jobs.js";
import { audioStorageHarness, waveBytes } from "./support/audio-storage-test-helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  const name = `${asset.id}.audio`;
  const target = path.join(h.directory, name);
  const binding = (await bindAudioDirectory(h.storage, h.session.id))!;
  const probe = await fs.open(target, "r");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const identity = await probe.stat();
  await probe.close();
  const owns = (handle: fs.FileHandle) => {
    const actual = fstatSync(handle.fd);
    return actual.dev === identity.dev && actual.ino === identity.ino;
  };
  return { ...h, asset, name, target, binding, prototype, owns,
    read: (signal?: AbortSignal, fileName = name) => readBoundedAudioFile(binding, fileName, asset.byteLength, signal) };
}

for (const mode of [0o600, 0o644]) {
  for (const alias of [false, true]) {
    test(`readers coordinate a ${mode.toString(8)} file through ${alias ? "hard-linked paths" : "the same path"}`, {
      skip: platform === "win32", timeout: 10_000,
    }, async (t) => {
      const h = await fixture(t);
      const peerName = alias ? "alias.audio" : h.name;
      if (alias) await fs.link(h.target, path.join(h.directory, peerName));
      await fs.chmod(h.target, mode);
      const paused = deferred();
      const release = deferred();
      const peerInspected = deferred();
      let holding = false;
      let held = false;
      let overlappingOpens = 0;
      const open = fs.open;
      const lstat = fs.lstat;
      const point = mode === 0o600 ? "read" : "chmod";
      const original = h.prototype[point];
      // Hold the first private read or first permission tightening. The peer's
      // path inspection remains observable even when it waits for this inode.
      t.mock.method(h.prototype, point, async function (this: fs.FileHandle, ...args: unknown[]) {
        if (!held && h.owns(this)) {
          held = true;
          holding = true;
          paused.resolve();
          await release.promise;
          holding = false;
        }
        return Reflect.apply(original, this, args);
      });
      t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => {
        if (holding && [h.target, path.join(h.directory, peerName)].includes(String(args[0]))) overlappingOpens++;
        return Reflect.apply(open, fs, args);
      });
      t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        const result = await Reflect.apply(lstat, fs, args);
        if (holding && String(args[0]) === path.join(h.directory, peerName)) peerInspected.resolve();
        return result;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const first = h.read();
      await paused.promise;
      const second = h.read(undefined, peerName);
      const results = Promise.allSettled([first, second]);
      try {
        await peerInspected.promise;
        // Drain continuations after the peer's completed lstat, without waiting
        // for a second open (which correctly never occurs while held).
        await setImmediate();
        assert.equal(overlappingOpens, 0, "another reader opened this inode during normalization or snapshot reading");
      } finally {
        release.resolve();
        const settled = await results;
        for (const result of settled) {
          assert.equal(result.status, "fulfilled");
          if (result.status === "fulfilled") assert.deepEqual(result.value, waveBytes());
        }
      }
      assert.equal((await fs.stat(h.target)).mode & 0o7777, 0o600);
    });
  }
}

test("queued reads cancel promptly, leave other inodes available, and release after completion", { timeout: 10_000 }, async (t) => {
  const h = await fixture(t);
  const otherName = "independent.audio";
  await fs.writeFile(path.join(h.directory, otherName), waveBytes(), { mode: 0o600 });
  const paused = deferred();
  const release = deferred();
  let held = false;
  const original = h.prototype.read;
  const mocked = t.mock.method(h.prototype, "read", async function (this: fs.FileHandle, ...args: unknown[]) {
    if (!held && h.owns(this)) {
      held = true;
      paused.resolve();
      await release.promise;
    }
    return Reflect.apply(original, this, args);
  });
  const first = h.read();
  await paused.promise;
  try {
    const abort = createHostAbortController();
    const reason = new Error("cancel queued fixture read");
    const cancelled = assert.rejects(h.read(abort.signal), (error) => error === reason);
    abort.abort(reason);
    await cancelled;
    assert.deepEqual(await h.read(undefined, otherName), waveBytes());
  } finally {
    release.resolve();
    await first;
    mocked.mock.restore();
  }
  assert.deepEqual(await h.read(), waveBytes());
  await assert.rejects(readBoundedAudioFile(h.binding, h.name, h.asset.byteLength - 1), AudioStorageError);
  assert.deepEqual(await h.read(), waveBytes());
});

test("job listings and asset readers share permission normalization and preserve already-private ctime", {
  skip: platform === "win32",
}, async (t) => {
  const h = await fixture(t);
  const files = [h.target, path.join(h.directory, `${h.asset.id}.asset.json`), path.join(h.directory, `${h.job.id}.job.json`)];
  for (const mode of [0o600, 0o644]) {
    for (const target of files) await fs.chmod(target, mode);
    const before = await fs.stat(h.target, { bigint: true });
    await Promise.all(Array.from({ length: 4 }, async () => {
      const [jobs, asset] = await Promise.all([
        listAudioJobs(h.storage, h.session.id), readAudioAsset(h.storage, h.session.id, h.asset.id),
      ]);
      assert.deepEqual(jobs, [h.job]);
      assert.deepEqual(asset, { asset: h.asset, bytes: waveBytes() });
    }));
    for (const target of files) assert.equal((await fs.stat(target)).mode & 0o7777, 0o600);
    if (mode === 0o600) assert.equal((await fs.stat(h.target, { bigint: true })).ctimeNs, before.ctimeNs);
  }
});

test("snapshot reads still reject external ctime changes and replacements and recover after failure", {
  skip: platform === "win32",
}, async (t) => {
  for (const change of ["permissions", "replacement"] as const) {
    const h = await fixture(t);
    const original = h.prototype.read;
    let changed = false;
    const mocked = t.mock.method(h.prototype, "read", async function (this: fs.FileHandle, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args);
      if (!changed && h.owns(this)) {
        changed = true;
        if (change === "permissions") await fs.chmod(h.target, 0o640);
        else {
          const replacement = `${h.target}.replacement`;
          await fs.writeFile(replacement, waveBytes(), { mode: 0o600 });
          await fs.rename(replacement, h.target);
        }
      }
      return result;
    });
    try { await assert.rejects(h.read(), AudioStorageError); }
    finally { mocked.mock.restore(); }
    assert.equal(changed, true);
    assert.deepEqual(await h.read(), waveBytes());
    assert.equal((await fs.stat(h.target)).mode & 0o7777, 0o600);
    await fs.rename(h.target, `${h.target}.original`);
    await fs.symlink(`${h.target}.original`, h.target);
    await assert.rejects(h.read(), AudioStorageError);
  }
});
