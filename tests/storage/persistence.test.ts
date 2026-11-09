import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  requireActiveStorageTransaction,
  trackStorageTransactionOperation,
  withStorageTransaction,
} from "../../src/storage/persistence.js";

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
