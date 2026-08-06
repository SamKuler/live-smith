import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  isStorageCommitOutcomeUnknownError,
  removeFileDurably,
  writeJsonAtomically,
} from "./persistence.js";

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
