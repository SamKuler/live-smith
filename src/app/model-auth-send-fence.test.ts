import assert from "node:assert/strict";
import test from "node:test";

import type { OAuthAuthState } from "../model/provider.js";
import { createHostAbortController } from "../runtime/host.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";

test("OAuth fences isolate pending login and OAuth use by Profile", async () => {
  const storage = `/tmp/live-smith-profile-fence-${Date.now()}`;
  const first = modelAuthSendFenceForStorage(storage, "profile-a");
  const second = modelAuthSendFenceForStorage(storage, "profile-b");
  const owner = Symbol("Profile A login owner");
  const releaseAuth = await first.enterAuth(owner, "openai");
  assert.ok(releaseAuth);
  first.updateAuthState(owner, "openai", "pending", true);
  releaseAuth();

  assert.equal(first.hasPendingLogin(), true);
  assert.equal(second.hasPendingLogin(), false);
  const releaseSecond = await second.enterOAuthUse();
  assert.ok(releaseSecond);
  releaseSecond();

  first.releaseOwner(owner);
});

test("OAuth fences reject invalid Profile IDs", () => {
  assert.throws(
    () => modelAuthSendFenceForStorage("/tmp/live-smith-fence", "bad profile"),
    /valid OAuth Profile ID/i,
  );
});

test("simultaneous auth entrants reserve the shared fence atomically", async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const first = fence.enterAuth(Symbol("first"), "openai");
  const second = fence.enterAuth(Symbol("second"), "openai");
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

test("a simultaneous auth mutation excludes reads and OAuth subscription uses", async () => {
  for (const kind of ["read", "oauth-use"] as const) {
    const fence = modelAuthSendFenceForStorage(undefined, "openai");
    const auth = fence.enterAuth(Symbol("auth"), "openai");
    const pending = kind === "read"
      ? fence.enterRead()
      : fence.enterOAuthUse();
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
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const releaseAuth = await fence.enterAuth(Symbol("auth"), "openai");
  const controller = createHostAbortController();
  const reason = new Error("stop waiting for shared auth");
  const pending = fence.enterOAuthUse(controller.signal);

  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  releaseAuth?.();
});

test("a definitive failed-login check clears the pending owner", async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const owner = Symbol("login owner");
  const releaseLogin = await fence.enterAuth(owner, "openai");
  fence.updateAuthState(owner, "openai", "pending");
  releaseLogin?.();
  assert.equal(await fence.enterOAuthUse(), null);

  const releaseCheck = await fence.enterAuth(owner, "openai", undefined, true);
  fence.updateAuthState(owner, "openai", "unavailable", true);
  releaseCheck?.();
  const releaseSend = await fence.enterOAuthUse();
  assert.equal(typeof releaseSend, "function");
  releaseSend?.();
});

test("a pending provider cannot be continued through another provider slot", async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "profile-a");
  const owner = Symbol("login owner");
  const releaseLogin = await fence.enterAuth(owner, "openai");
  fence.updateAuthState(owner, "openai", "pending");
  releaseLogin?.();

  const releaseRead = await fence.enterRead();
  assert.equal(
    await fence.reconcilePendingAuthState(
      "google",
      async () => assert.fail("another provider must not reconcile the login"),
    ),
    undefined,
  );
  releaseRead();
  assert.equal(
    await fence.enterAuth(owner, "google", undefined, true),
    null,
  );
  const releaseCancel = await fence.enterAuth(
    owner,
    "openai",
    undefined,
    true,
  );
  assert.equal(typeof releaseCancel, "function");
  assert.equal(fence.hasAuthActivity("openai"), true);
  fence.updateAuthState(owner, "openai", "signed-out", true);
  assert.equal(fence.hasAuthActivity("openai"), false);
  releaseCancel?.();
  fence.releaseOwner(owner);
});

test("only the exact pending owner can serialize close-time retirement", async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const owner = Symbol("pending owner");
  const peer = Symbol("peer");
  const releaseLogin = await fence.enterAuth(owner, "openai");
  fence.updateAuthState(owner, "openai", "pending");
  releaseLogin?.();
  assert.equal(await fence.enterPendingOwnerCleanup(peer, "openai"), null);
  assert.equal(await fence.enterPendingOwnerCleanup(owner, "google"), null);

  const releaseRead = await fence.enterRead();
  const cleanup = fence.enterPendingOwnerCleanup(owner, "openai");
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
    const fence = modelAuthSendFenceForStorage(undefined, "openai");
    const owner = Symbol("pending owner");
    const releaseLogin = await fence.enterAuth(owner, "openai");
    fence.updateAuthState(owner, "openai", "pending");
    releaseLogin?.();
    const generation = fence.authGeneration("openai");
    const auth = oauthAuthState(status, definitive);

    const releaseRead = await fence.enterRead();
    assert.equal(fence.hasPendingLogin(), true);
    assert.equal(
      await fence.reconcilePendingAuthState("openai", async () => auth),
      auth,
    );
    assert.equal(
      await fence.reconcilePendingAuthState("openai", async () => auth),
      undefined,
      "the same terminal observation must not advance generation twice",
    );
    releaseRead();

    assert.equal(fence.hasPendingLogin(), false);
    assert.equal(fence.authGeneration("openai"), generation + 1);
    const releaseSend = await fence.enterOAuthUse();
    assert.equal(typeof releaseSend, "function");
    releaseSend?.();
  }
});

test("pending and non-definitive reads preserve pending ownership", async () => {
  for (const [status, definitive] of [
    ["pending", false],
    ["unavailable", false],
  ] as const) {
    const fence = modelAuthSendFenceForStorage(undefined, "openai");
    const owner = Symbol("pending owner");
    const releaseLogin = await fence.enterAuth(owner, "openai");
    fence.updateAuthState(owner, "openai", "pending");
    releaseLogin?.();
    const generation = fence.authGeneration("openai");
    const auth = oauthAuthState(status, definitive);

    const releaseRead = await fence.enterRead();
    assert.equal(
      await fence.reconcilePendingAuthState("openai", async () => auth),
      auth,
    );
    releaseRead();

    assert.equal(fence.hasPendingLogin(), true);
    assert.equal(fence.authGeneration("openai"), generation);
    assert.equal(await fence.enterOAuthUse(), null);
    fence.releaseOwner(owner);
  }
});

test("the credential-free generation projection remains readable after poison", () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const generation = fence.peekAuthGeneration("openai");

  fence.poison(new Error("OAuth backend shutdown failed"));

  assert.equal(fence.peekAuthGeneration("openai"), generation);
  assert.throws(
    () => fence.authGeneration("openai"),
    /shared OAuth subscription backend could not be shut down safely/i,
  );
});

test("pending reconciliation isolates waiter cancellation from its single flight", async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const owner = Symbol("pending owner");
  const releaseLogin = await fence.enterAuth(owner, "openai");
  fence.updateAuthState(owner, "openai", "pending");
  releaseLogin?.();
  const generation = fence.authGeneration("openai");
  const releaseFirstRead = await fence.enterRead();
  const releaseSecondRead = await fence.enterRead();
  let finishRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  let readCalls = 0;
  const auth = oauthAuthState("signed-in", false);
  const readAuthState = async (): Promise<OAuthAuthState> => {
    readCalls += 1;
    await readGate;
    return auth;
  };
  const controller = createHostAbortController();
  const reason = new Error("leader modal closed");
  const leader = fence.reconcilePendingAuthState(
    "openai",
    readAuthState,
    controller.signal,
  );
  const follower = fence.reconcilePendingAuthState("openai", readAuthState);

  controller.abort(reason);
  await assert.rejects(leader, (error: unknown) => error === reason);
  assert.equal(readCalls, 1);
  assert.equal(await fence.enterOAuthUse(), null);

  finishRead();
  assert.equal(await follower, auth);
  releaseFirstRead();
  releaseSecondRead();
  assert.equal(fence.authGeneration("openai"), generation + 1);
  const releaseSend = await fence.enterOAuthUse();
  assert.equal(typeof releaseSend, "function");
  releaseSend?.();
});

test("pending owner cleanup aborts the shared reconciliation before waiting for reads", {
  timeout: 2_000,
}, async () => {
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const owner = Symbol("pending owner");
  const releaseLogin = await fence.enterAuth(owner, "openai");
  fence.updateAuthState(owner, "openai", "pending");
  releaseLogin?.();
  const releaseRead = await fence.enterRead();
  let operationSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const reconciliation = fence.reconcilePendingAuthState("openai", async (signal) => {
    operationSignal = signal;
    markStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    return { status: "signed-out" };
  });

  await started;
  const cleanup = fence.enterPendingOwnerCleanup(owner, "openai");
  await assert.rejects(
    reconciliation,
    /OAuth sign-in owner closed/,
  );
  assert.equal(operationSignal?.aborted, true);
  releaseRead();
  const releaseCleanup = await cleanup;
  assert.equal(typeof releaseCleanup, "function");
  releaseCleanup?.();
  fence.releaseOwner(owner);
});

function oauthAuthState(
  status: OAuthAuthState["status"],
  definitive: boolean,
): OAuthAuthState {
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
