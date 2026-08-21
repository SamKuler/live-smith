import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedAuthState } from "../model/provider.js";
import { createHostAbortController } from "../runtime/host.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";

test("simultaneous auth entrants reserve the shared fence atomically", async () => {
  const fence = modelAuthSendFenceForStorage(undefined);
  const first = fence.enterAuth(Symbol("first"));
  const second = fence.enterAuth(Symbol("second"));
  const releaseFirst = await first;
  assert.equal(typeof releaseFirst, "function");

  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  releaseFirst?.();
  const releaseSecond = await second;
  assert.equal(typeof releaseSecond, "function");
  releaseSecond?.();
});

test("a simultaneous auth mutation excludes reads and sends", async () => {
  for (const kind of ["read", "send"] as const) {
    const fence = modelAuthSendFenceForStorage(undefined);
    const auth = fence.enterAuth(Symbol("auth"));
    const pending = kind === "read"
      ? fence.enterRead()
      : fence.enterSend();
    const releaseAuth = await auth;
    assert.equal(typeof releaseAuth, "function");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, kind);

    releaseAuth?.();
    const releasePending = await pending;
    assert.equal(typeof releasePending, "function", kind);
    releasePending?.();
  }
});

test("an aborted fence waiter preserves the caller reason", async () => {
  const fence = modelAuthSendFenceForStorage(undefined);
  const releaseAuth = await fence.enterAuth(Symbol("auth"));
  const controller = createHostAbortController();
  const reason = new Error("stop waiting for shared auth");
  const pending = fence.enterSend(controller.signal);

  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  releaseAuth?.();
});

test("a definitive failed-login check clears the pending owner", async () => {
  const fence = modelAuthSendFenceForStorage(undefined);
  const owner = Symbol("login owner");
  const releaseLogin = await fence.enterAuth(owner);
  fence.updateAuthState(owner, "pending");
  releaseLogin?.();
  assert.equal(await fence.enterSend(), null);

  const releaseCheck = await fence.enterAuth(owner);
  fence.updateAuthState(owner, "unavailable", true);
  releaseCheck?.();
  const releaseSend = await fence.enterSend();
  assert.equal(typeof releaseSend, "function");
  releaseSend?.();
});

test("only the exact pending owner can serialize close-time retirement", async () => {
  const fence = modelAuthSendFenceForStorage(undefined);
  const owner = Symbol("pending owner");
  const peer = Symbol("peer");
  const releaseLogin = await fence.enterAuth(owner);
  fence.updateAuthState(owner, "pending");
  releaseLogin?.();
  assert.equal(await fence.enterPendingOwnerCleanup(peer), null);

  const releaseRead = await fence.enterRead();
  const cleanup = fence.enterPendingOwnerCleanup(owner);
  let cleanupSettled = false;
  void cleanup.then(() => {
    cleanupSettled = true;
  });
  await Promise.resolve();
  assert.equal(cleanupSettled, false);

  releaseRead();
  const releaseCleanup = await cleanup;
  assert.equal(typeof releaseCleanup, "function");
  releaseCleanup?.();
  fence.releaseOwner(owner);
});

test("an authoritative peer read clears a stale terminal pending owner once", async () => {
  for (const [status, definitive] of [
    ["signed-in", false],
    ["signed-out", false],
    ["unavailable", true],
  ] as const) {
    const fence = modelAuthSendFenceForStorage(undefined);
    const owner = Symbol("pending owner");
    const releaseLogin = await fence.enterAuth(owner);
    fence.updateAuthState(owner, "pending");
    releaseLogin?.();
    const generation = fence.authGeneration();
    const auth = managedAuthState(status, definitive);

    const releaseRead = await fence.enterRead();
    assert.equal(fence.hasPendingLogin(), true);
    assert.equal(
      await fence.reconcilePendingAuthState(async () => auth),
      auth,
    );
    assert.equal(
      await fence.reconcilePendingAuthState(async () => auth),
      undefined,
      "the same terminal observation must not advance generation twice",
    );
    releaseRead();

    assert.equal(fence.hasPendingLogin(), false);
    assert.equal(fence.authGeneration(), generation + 1);
    const releaseSend = await fence.enterSend();
    assert.equal(typeof releaseSend, "function");
    releaseSend?.();
  }
});

test("pending and non-definitive reads preserve pending ownership", async () => {
  for (const [status, definitive] of [
    ["pending", false],
    ["unavailable", false],
  ] as const) {
    const fence = modelAuthSendFenceForStorage(undefined);
    const owner = Symbol("pending owner");
    const releaseLogin = await fence.enterAuth(owner);
    fence.updateAuthState(owner, "pending");
    releaseLogin?.();
    const generation = fence.authGeneration();
    const auth = managedAuthState(status, definitive);

    const releaseRead = await fence.enterRead();
    assert.equal(
      await fence.reconcilePendingAuthState(async () => auth),
      auth,
    );
    releaseRead();

    assert.equal(fence.hasPendingLogin(), true);
    assert.equal(fence.authGeneration(), generation);
    assert.equal(await fence.enterSend(), null);
    fence.releaseOwner(owner);
  }
});

test("pending reconciliation isolates waiter cancellation from its single flight", async () => {
  const fence = modelAuthSendFenceForStorage(undefined);
  const owner = Symbol("pending owner");
  const releaseLogin = await fence.enterAuth(owner);
  fence.updateAuthState(owner, "pending");
  releaseLogin?.();
  const generation = fence.authGeneration();
  const releaseFirstRead = await fence.enterRead();
  const releaseSecondRead = await fence.enterRead();
  let finishRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  let readCalls = 0;
  const auth = managedAuthState("signed-in", false);
  const readAuthState = async (): Promise<ManagedAuthState> => {
    readCalls += 1;
    await readGate;
    return auth;
  };
  const controller = createHostAbortController();
  const reason = new Error("leader modal closed");
  const leader = fence.reconcilePendingAuthState(
    readAuthState,
    controller.signal,
  );
  const follower = fence.reconcilePendingAuthState(readAuthState);

  controller.abort(reason);
  await assert.rejects(leader, (error: unknown) => error === reason);
  assert.equal(readCalls, 1);
  assert.equal(await fence.enterSend(), null);

  finishRead();
  assert.equal(await follower, auth);
  releaseFirstRead();
  releaseSecondRead();
  assert.equal(fence.authGeneration(), generation + 1);
  const releaseSend = await fence.enterSend();
  assert.equal(typeof releaseSend, "function");
  releaseSend?.();
});

function managedAuthState(
  status: ManagedAuthState["status"],
  definitive: boolean,
): ManagedAuthState {
  switch (status) {
    case "signed-in":
      return {
        status,
        accountLabel: null,
        planType: "pro",
        subscriptionEligible: true,
      };
    case "signed-out":
      return { status };
    case "pending":
      return {
        status,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
    case "unavailable":
      return { status, message: "Unavailable", definitive };
  }
}
