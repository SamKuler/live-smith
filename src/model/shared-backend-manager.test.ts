import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { modelAuthSendFenceForStorage } from "../app/model-auth-send-fence.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
import {
  ModelBackendShutdownError,
  type CodexSubscriptionBackend,
} from "./provider.js";
import { createHostAbortController } from "../runtime/host.js";
import {
  acquireSharedModelBackendManager,
} from "./shared-backend-manager.js";

function fakeManagedBackend(): CodexSubscriptionBackend & { closeCalls: number } {
  return {
    kind: "codex-subscription",
    closeCalls: 0,
    async listModels() {
      return [];
    },
    async createToolTurn() {
      return { content: "ok", toolCalls: [] };
    },
    onTerminal() {
      return () => undefined;
    },
    reserveToolTurn() {
      return {
        createToolTurn: (request) => this.createToolTurn(request),
        async release() {},
      };
    },
    async readAuthState() {
      return { status: "signed-out" } as const;
    },
    async beginLogin() {
      return { status: "signed-out" } as const;
    },
    async logout() {
      return { status: "signed-out" } as const;
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

test("real and symlinked storage paths concurrently acquire one shared manager", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "live-smith-shared-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const storage = path.join(tempRoot, "storage");
  const storageAlias = path.join(tempRoot, "storage-alias");
  await mkdir(storage);
  await symlink(storage, storageAlias);
  const backend = fakeManagedBackend();
  let starts = 0;
  const options = {
    startCodexBackend: async () => {
      starts += 1;
      return backend;
    },
  };

  const [first, second] = await Promise.all([
    acquireSharedModelBackendManager(storage, options),
    acquireSharedModelBackendManager(storageAlias, options),
  ]);

  assert.equal(first.manager, second.manager);
  assert.equal(await first.manager.codex(), backend);
  assert.equal(await second.manager.codex(), backend);
  assert.equal(starts, 1);

  await first.release();
  await first.release();
  assert.equal(backend.closeCalls, 0);
  await second.release();
  assert.equal(backend.closeCalls, 1);
});

test("missing storage below a symlinked ancestor stays shared after creation", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "live-smith-shared-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const physicalParent = path.join(tempRoot, "physical-parent");
  const parentAlias = path.join(tempRoot, "parent-alias");
  await mkdir(physicalParent);
  await symlink(physicalParent, parentAlias);
  const physicalStorage = path.join(physicalParent, "missing", "storage");
  const aliasedStorage = path.join(parentAlias, "missing", "storage");
  const backend = fakeManagedBackend();
  let starts = 0;
  const options = {
    startCodexBackend: async () => {
      starts += 1;
      return backend;
    },
  };

  const [physicalBeforeCreation, aliasBeforeCreation] = await Promise.all([
    acquireSharedModelBackendManager(physicalStorage, options),
    acquireSharedModelBackendManager(aliasedStorage, options),
  ]);
  assert.equal(physicalBeforeCreation.manager, aliasBeforeCreation.manager);

  await mkdir(physicalStorage, { recursive: true });
  const aliasAfterCreation = await acquireSharedModelBackendManager(
    aliasedStorage,
    options,
  );
  assert.equal(aliasAfterCreation.manager, physicalBeforeCreation.manager);
  await Promise.all([
    physicalBeforeCreation.manager.codex(),
    aliasBeforeCreation.manager.codex(),
    aliasAfterCreation.manager.codex(),
  ]);
  assert.equal(starts, 1);

  await physicalBeforeCreation.release();
  await aliasBeforeCreation.release();
  await aliasAfterCreation.release();
  assert.equal(backend.closeCalls, 1);
});

test("a dangling storage alias keeps one shared manager after its target appears", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "live-smith-shared-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const targetParent = path.join(tempRoot, "target");
  const aliasParent = path.join(tempRoot, "alias");
  const targetStorage = path.join(targetParent, "storage");
  const aliasStorage = path.join(aliasParent, "storage");
  await symlink(path.basename(targetParent), aliasParent, "dir");
  const backend = fakeManagedBackend();
  let starts = 0;
  const options = {
    startCodexBackend: async () => {
      starts += 1;
      return backend;
    },
  };

  const aliasLease = await acquireSharedModelBackendManager(
    aliasStorage,
    options,
  );
  await mkdir(targetStorage, { recursive: true });
  const targetLease = await acquireSharedModelBackendManager(
    targetStorage,
    options,
  );

  assert.equal(aliasLease.manager, targetLease.manager);
  assert.equal(await aliasLease.manager.codex(), backend);
  assert.equal(await targetLease.manager.codex(), backend);
  assert.equal(starts, 1);

  await aliasLease.release();
  assert.equal(backend.closeCalls, 0);
  await targetLease.release();
  assert.equal(backend.closeCalls, 1);
});

test("an acquire at zero refs waits for confirmed close before replacement", async () => {
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const closeStartedPromise = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const firstBackend = fakeManagedBackend();
  firstBackend.close = async function close() {
    this.closeCalls += 1;
    closeStarted();
    await closeGate;
  };
  const secondBackend = fakeManagedBackend();
  const storage = "/private/live-smith-shared-close/storage";
  const first = await acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => firstBackend,
  });
  await first.manager.codex();

  const closing = first.release();
  await closeStartedPromise;
  let acquired = false;
  const replacementPromise = acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => secondBackend,
  }).then((lease) => {
    acquired = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(acquired, false);

  releaseClose();
  await closing;
  const replacement = await replacementPromise;
  assert.notEqual(replacement.manager, first.manager);
  assert.equal(await replacement.manager.codex(), secondBackend);
  await replacement.release();
});

test("canceling one acquire wait does not cancel the shared close", async () => {
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const closeStartedPromise = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeFinished = false;
  const firstBackend = fakeManagedBackend();
  firstBackend.close = async function close() {
    this.closeCalls += 1;
    closeStarted();
    await closeGate;
    closeFinished = true;
  };
  const secondBackend = fakeManagedBackend();
  const storage = "/private/live-smith-shared-canceled-acquire/storage";
  const first = await acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => firstBackend,
  });
  await first.manager.codex();

  const closing = first.release();
  await closeStartedPromise;
  const controller = createHostAbortController();
  const canceledAcquire = acquireSharedModelBackendManager(
    storage,
    { startCodexBackend: async () => secondBackend },
    controller.signal,
  );
  const cancelReason = new Error("This acquire is no longer needed.");
  controller.abort(cancelReason);

  try {
    const outcome = await Promise.race([
      canceledAcquire.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "waiting" }>((resolve) => {
        setTimeout(() => resolve({ kind: "waiting" }), 50);
      }),
    ]);
    assert.deepEqual(outcome, { kind: "rejected", error: cancelReason });
    assert.equal(closeFinished, false);
    assert.equal(firstBackend.closeCalls, 1);
  } finally {
    releaseClose();
    await closing;
  }
  const replacement = await acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => secondBackend,
  });
  assert.equal(await replacement.manager.codex(), secondBackend);
  await replacement.release();
});

test("a failed last close poisons the storage owner and forbids replacement", {
  timeout: 1_000,
}, async () => {
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const closeStartedPromise = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const shutdownError = new Error("Codex shutdown was not confirmed");
  const backend = fakeManagedBackend();
  backend.close = async function close() {
    this.closeCalls += 1;
    closeStarted();
    await closeGate;
    throw shutdownError;
  };
  const firstPoison: Error[] = [];
  const laterPoison: Error[] = [];
  let replacementStarts = 0;
  const storage = "/private/live-smith-shared-poison/storage";
  const first = await acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => backend,
    onPoison: (error) => firstPoison.push(error),
  });
  const second = await acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => {
      replacementStarts += 1;
      return fakeManagedBackend();
    },
    onPoison: (error) => laterPoison.push(error),
  });
  assert.equal(second.manager, first.manager);
  await first.manager.codex();

  await first.release();
  const failingRelease = second.release();
  await closeStartedPromise;
  const waitingAcquire = acquireSharedModelBackendManager(storage, {
    startCodexBackend: async () => {
      replacementStarts += 1;
      return fakeManagedBackend();
    },
  });
  releaseClose();

  await assert.rejects(failingRelease, (error: unknown) => error === shutdownError);
  await assert.rejects(waitingAcquire, (error: unknown) => error === shutdownError);
  await assert.rejects(
    acquireSharedModelBackendManager(storage),
    (error: unknown) => error === shutdownError,
  );
  assert.deepEqual(firstPoison, [shutdownError]);
  assert.deepEqual(laterPoison, []);
  assert.equal(replacementStarts, 0);
  assert.equal(backend.closeCalls, 1);
});

test("last-owner shutdown poison permanently fences canonical auth and subscription use", async (t) => {
  const storage = await mkdtemp(
    path.join(tmpdir(), "live-smith-shared-fence-poison-"),
  );
  t.after(() => rm(storage, { recursive: true, force: true }));
  const storageKey = await canonicalStorageDirectory(storage);
  const fence = modelAuthSendFenceForStorage(storageKey);
  const shutdownError = new ModelBackendShutdownError(
    "Codex App Server resources could not be stopped.",
  );
  const backend = fakeManagedBackend();
  backend.close = async function close() {
    this.closeCalls += 1;
    throw shutdownError;
  };
  const published: Error[] = [];
  const options = {
    startCodexBackend: async () => backend,
    onPoison(error: Error) {
      published.push(error);
      fence.poison(error);
    },
  };
  const first = await acquireSharedModelBackendManager(storage, options);
  const second = await acquireSharedModelBackendManager(storageKey, options);

  assert.equal(first.manager, second.manager);
  assert.equal(await first.manager.codex(), backend);
  await first.release();
  const releaseRead = await fence.enterRead();
  releaseRead();

  await assert.rejects(
    second.release(),
    (error: unknown) => error === shutdownError,
  );
  assert.deepEqual(published, [shutdownError]);
  assert.equal(backend.closeCalls, 1);

  const persistentFence = modelAuthSendFenceForStorage(storageKey);
  assert.equal(persistentFence, fence);
  const isPermanentShutdownPoison = (error: unknown): boolean => {
    assert.equal(error instanceof Error, true);
    assert.match((error as Error).message, /restart the Live Smith extension/i);
    assert.equal((error as Error & { cause?: unknown }).cause, shutdownError);
    return true;
  };
  await assert.rejects(persistentFence.enterRead(), isPermanentShutdownPoison);
  await assert.rejects(
    persistentFence.enterManagedUse(),
    isPermanentShutdownPoison,
  );
  await assert.rejects(
    persistentFence.enterAuth(Symbol("poisoned owner")),
    isPermanentShutdownPoison,
  );
});

test("undefined storage acquires isolated managers", async () => {
  const first = await acquireSharedModelBackendManager(undefined);
  const second = await acquireSharedModelBackendManager(undefined);

  assert.notEqual(first.manager, second.manager);
  await first.release();
  await first.release();
  await second.release();
});
