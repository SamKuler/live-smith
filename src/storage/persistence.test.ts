import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  ensurePrivateDirectoryDurably,
  isStorageCommitOutcomeUnknownError,
  removeDirectoryDurably,
  removeFileDurably,
  requireActiveStorageTransaction,
  trackStorageTransactionOperation,
  withStorageTransaction,
  writeBytesAtomically,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomically,
} from "./persistence.js";

test("storage transaction contexts are opaque, directory-bound, and callback-scoped", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-transaction-"));
  let retained: Parameters<typeof requireActiveStorageTransaction>[0] | undefined;

  await withStorageTransaction(directory, async (context) => {
    retained = context;
    assert.doesNotThrow(() => requireActiveStorageTransaction(context, directory));
    assert.throws(
      () => requireActiveStorageTransaction(context, `${directory}-other`),
      /invalid or no longer active/i,
    );
  });

  assert.ok(retained);
  const expired = retained;
  assert.throws(
    () => requireActiveStorageTransaction(expired, directory),
    /invalid or no longer active/i,
  );
});

test("storage transactions await detached registered operations before releasing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-detached-"));
  let finishDetached = (): void => undefined;
  let detachedFinished = false;
  const detachedGate = new Promise<void>((resolve) => {
    finishDetached = resolve;
  }).then(() => {
    detachedFinished = true;
  });

  const first = withStorageTransaction(directory, async (context) => {
    trackStorageTransactionOperation(context, directory, detachedGate);
  });
  await Promise.resolve();
  const second = withStorageTransaction(directory, async () => {
    assert.equal(detachedFinished, true);
  });

  await Promise.resolve();
  assert.equal(detachedFinished, false);
  finishDetached();
  await first;
  await second;
});

test("ensurePrivateDirectoryDurably syncs a newly created directory's parent", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durable-dir-"));
  const target = path.join(parent, "attachments");
  const synced: string[] = [];

  await ensurePrivateDirectoryDurably(target, {
    syncDirectory: async (directory) => {
      synced.push(directory);
    },
  });

  assert.deepEqual(synced, [parent]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  }

  await ensurePrivateDirectoryDurably(target, {
    syncDirectory: async () => {
      throw new Error("existing directories must not be re-committed");
    },
  });
});

test("ensurePrivateDirectoryDurably classifies a post-create sync failure", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-durable-dir-"));
  const target = path.join(parent, "attachments");

  await assert.rejects(
    ensurePrivateDirectoryDurably(target, {
      syncDirectory: async () => {
        throw Object.assign(new Error("sync failed"), { code: "EIO" });
      },
    }),
    (error: unknown) => isStorageCommitOutcomeUnknownError(error),
  );
  assert.equal((await fs.stat(target)).isDirectory(), true);
});

test("writeBytesAtomically durably replaces a private binary file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-bytes-"));
  const target = path.join(directory, "image.bin");

  await writeBytesAtomically(target, new Uint8Array([1, 2, 3]));

  assert.deepEqual(await fs.readFile(target), Buffer.from([1, 2, 3]));
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }
});

test("create-only atomic bytes never replace an existing target", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-create-only-"));
  const target = path.join(directory, "attachment.bin");
  await fs.writeFile(target, new Uint8Array([9, 9, 9]));

  await assert.rejects(
    writeBytesAtomicallyCreateOnly(target, new Uint8Array([1, 2, 3])),
    { code: "EEXIST" },
  );
  assert.deepEqual(await fs.readFile(target), Buffer.from([9, 9, 9]));
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    ["attachment.bin"],
  );
});

test("writeJsonAtomically classifies a directory sync failure after replacement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-atomic-"));
  const target = path.join(directory, "state.json");
  await fs.writeFile(target, JSON.stringify({ state: "old" }));
  const syncFailure = Object.assign(new Error("directory sync failed"), {
    code: "EIO",
  });

  let thrown: unknown;
  try {
    await writeJsonAtomically(
      target,
      { state: "sensitive-value" },
      {
        syncDirectory: async () => {
          throw syncFailure;
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.equal(isStorageCommitOutcomeUnknownError(thrown), true);
  assert.ok(isStorageCommitOutcomeUnknownError(thrown));
  assert.equal(thrown.cause, syncFailure);
  assert.doesNotMatch(thrown.message, /sensitive-value|state\.json/);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(thrown, "cause"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(thrown), /directory sync failed|sensitive-value/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(target, "utf8")) as unknown,
    { state: "sensitive-value" },
  );
});

test("removeFileDurably keeps an uncertain deletion retryable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-"));
  const target = path.join(directory, "events.json");
  await fs.writeFile(target, "[]");
  const syncFailure = Object.assign(new Error("directory sync failed"), {
    code: "EIO",
  });

  await assert.rejects(
    removeFileDurably(target, {
      syncDirectory: async () => {
        throw syncFailure;
      },
    }),
    (error: unknown) => isStorageCommitOutcomeUnknownError(error),
  );
  await removeFileDurably(target, { syncDirectory: async () => {} });
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("removeDirectoryDurably classifies parent sync failure after deletion", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-dir-"));
  const target = path.join(parent, "session-attachments");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "attachment.bin"), "bytes");
  const syncFailure = Object.assign(new Error("directory sync failed"), {
    code: "EIO",
  });

  await assert.rejects(
    removeDirectoryDurably(target, {
      syncDirectory: async () => {
        throw syncFailure;
      },
    }),
    (error: unknown) => isStorageCommitOutcomeUnknownError(error),
  );
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  await removeDirectoryDurably(target, { syncDirectory: async () => {} });
});
