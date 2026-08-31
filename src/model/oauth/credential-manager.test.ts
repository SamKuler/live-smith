import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";

import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import {
  loadOAuthCredential,
  saveOAuthCredential,
} from "../../storage/oauth-credentials.js";
import { withStorageTransaction } from "../../storage/persistence.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  OAuthCredentialManager,
  type OAuthLoginAttempt,
  type OAuthProviderAdapter,
} from "./credential-manager.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-manager-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function openAICredential(expiresAt = Date.now() + 3_600_000): OAuthCredential {
  return {
    provider: "openai",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt,
    accountId: "account-1",
  };
}

test("OAuth login publishes pending state then persists the completed credential", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  let canceled = false;
  const attempt: OAuthLoginAttempt = {
    pending: {
      status: "pending",
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    },
    completion: completion.promise,
    cancel() {
      canceled = true;
    },
  };
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return attempt;
    },
    async refresh(credential) {
      return credential;
    },
    authState(credential) {
      return {
        status: "signed-in",
        accountLabel: credential.provider === "openai"
          ? credential.accountId
          : null,
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);

  assert.deepEqual(await manager.beginLogin(), attempt.pending);
  assert.deepEqual(await manager.readAuthState(), attempt.pending);

  completion.resolve(openAICredential());
  await waitForStoredCredential(directory);
  assert.equal(canceled, false);
  assert.deepEqual(await manager.readAuthState(), {
    status: "signed-in",
    accountLabel: "account-1",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  });
});

test("same-provider credential managers isolate Profile auth and logout", async (t) => {
  const directory = await temporaryDirectory(t);
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh(credential) {
      return credential;
    },
    authState(credential) {
      return {
        status: "signed-in",
        accountLabel: credential.provider === "openai"
          ? credential.accountId
          : null,
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
  await saveOAuthCredential(directory, "profile-a", openAICredential());
  const secondCredential: Extract<OAuthCredential, { provider: "openai" }> = {
    provider: "openai",
    accessToken: "access-2",
    refreshToken: "refresh-2",
    expiresAt: Date.now() + 3_600_000,
    accountId: "account-2",
  };
  await saveOAuthCredential(directory, "profile-b", secondCredential);
  const first = new OAuthCredentialManager(directory, "profile-a", adapter);
  const second = new OAuthCredentialManager(directory, "profile-b", adapter);

  assert.deepEqual(await first.readAuthState(), {
    status: "signed-in",
    accountLabel: "account-1",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  });
  assert.deepEqual(await second.readAuthState(), {
    status: "signed-in",
    accountLabel: "account-2",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  });

  await first.logout();
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
  assert.equal(
    (await loadOAuthCredential(directory, "profile-b", "openai"))?.accessToken,
    "access-2",
  );
  await Promise.all([first.close(), second.close()]);
});

test("OAuth login acquisition failures are definitive, redacted, and immediately retryable", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  let beginCalls = 0;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      beginCalls += 1;
      if (beginCalls === 1) {
        throw new Error("Bearer secret-login-token failed at https://secret@example.test");
      }
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel(reason) {
          completion.reject(reason);
        },
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  const failure = {
    status: "unavailable",
    message: "ChatGPT sign-in did not complete.",
    definitive: true,
  } as const;

  assert.deepEqual(await manager.beginLogin(), failure);
  assert.deepEqual(await manager.readAuthState(), failure);
  assert.doesNotMatch(
    JSON.stringify(await manager.readAuthState()),
    /secret-login-token|secret@example\.test/u,
  );
  assert.deepEqual(await manager.beginLogin(), {
    status: "pending",
    verificationUrl: "https://auth.example.test/device",
  });
  assert.equal(beginCalls, 2);

  assert.deepEqual(await manager.logout(), { status: "signed-out" });
  await manager.close();
});

test("OAuth login preserves only an explicitly safe network proxy diagnosis", async (t) => {
  const directory = await temporaryDirectory(t);
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new NetworkProxyError(
        "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
      );
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  const failure = {
    status: "unavailable",
    message:
      "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
    definitive: true,
  } as const;

  assert.deepEqual(await manager.beginLogin(), failure);
  assert.deepEqual(await manager.readAuthState(), failure);
  await manager.close();
});

test("OAuth login completion preserves an explicitly safe network proxy diagnosis", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const error = new NetworkProxyError(
    "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
  const adapter: OAuthProviderAdapter = {
    provider: "google",
    displayName: "Gemini",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        },
        completion: completion.promise,
        cancel(reason) {
          completion.reject(reason);
        },
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  assert.equal((await manager.beginLogin()).status, "pending");
  completion.reject(error);

  let state = await manager.readAuthState();
  for (let attempt = 0; state.status === "pending" && attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    state = await manager.readAuthState();
  }
  assert.deepEqual(state, {
    status: "unavailable",
    message: error.message,
    definitive: true,
  });
  await manager.close();
});

test("concurrent OAuth readiness reads share one rotated refresh", async (t) => {
  const directory = await temporaryDirectory(t);
  let refreshes = 0;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh() {
      refreshes += 1;
      await Promise.resolve();
      return {
        ...openAICredential(),
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
      };
    },
    authState(credential) {
      return {
        status: "signed-in",
        accountLabel: credential.provider === "openai"
          ? credential.accountId
          : null,
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await saveOAuthCredential(directory, "profile-a", openAICredential(Date.now() - 1));

  const [first, second] = await Promise.all([
    manager.requireCredential(),
    manager.requireCredential(),
  ]);

  assert.equal(refreshes, 1);
  assert.equal(first.accessToken, "refreshed-access");
  assert.deepEqual(second, first);
});

test("OAuth logout aborts a detached refresh before deleting its credential", async (t) => {
  const directory = await temporaryDirectory(t);
  const refresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  let refreshSignal: AbortSignal | undefined;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh(_credential, signal) {
      refreshSignal = signal;
      refreshStarted.resolve(undefined);
      return refresh.promise;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await saveOAuthCredential(directory, "profile-a", openAICredential(Date.now() - 1));
  const caller = new AbortController();
  const pendingCredential = manager.requireCredential(caller.signal);
  await refreshStarted.promise;
  caller.abort(new Error("send canceled"));
  await assert.rejects(pendingCredential, /send canceled/);

  const loggedOut = manager.logout();
  await Promise.resolve();
  assert.equal(refreshSignal?.aborted, true);
  refresh.resolve({
    ...openAICredential(),
    accessToken: "late-refreshed-access",
  });
  assert.deepEqual(await loggedOut, { status: "signed-out" });
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
});

test("closing OAuth ownership aborts refresh and rejects its late credential write", async (t) => {
  const directory = await temporaryDirectory(t);
  const refresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  let refreshSignal: AbortSignal | undefined;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh(_credential, signal) {
      refreshSignal = signal;
      refreshStarted.resolve(undefined);
      return refresh.promise;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const original = openAICredential(Date.now() - 1);
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await saveOAuthCredential(directory, "profile-a", original);
  const caller = new AbortController();
  const pendingCredential = manager.requireCredential(caller.signal);
  await refreshStarted.promise;
  caller.abort(new Error("send canceled"));
  await assert.rejects(pendingCredential, /send canceled/);

  const closed = manager.close();
  await Promise.resolve();
  assert.equal(refreshSignal?.aborted, true);
  refresh.resolve({
    ...openAICredential(),
    accessToken: "late-refreshed-access",
  });
  await closed;
  assert.deepEqual(await loadOAuthCredential(directory, "profile-a", "openai"), original);
});

test("closing OAuth ownership rejects a refresh queued before its storage commit", async (t) => {
  const directory = await temporaryDirectory(t);
  const refresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  const transactionStarted = deferred<void>();
  const releaseTransaction = deferred<void>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh() {
      refreshStarted.resolve(undefined);
      return refresh.promise;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const original = openAICredential(Date.now() - 1);
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await saveOAuthCredential(directory, "profile-a", original);
  const pendingCredential = manager.requireCredential();
  await refreshStarted.promise;
  const heldTransaction = withStorageTransaction(directory, async () => {
    transactionStarted.resolve(undefined);
    await releaseTransaction.promise;
  });
  await transactionStarted.promise;

  refresh.resolve({
    ...openAICredential(),
    accessToken: "queued-refreshed-access",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closed = manager.close();
  releaseTransaction.resolve(undefined);
  await Promise.allSettled([pendingCredential, closed, heldTransaction]);

  assert.deepEqual(await loadOAuthCredential(directory, "profile-a", "openai"), original);
});

test("OAuth logout cancels pending login and removes persisted credentials", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel: () => completion.reject(new Error("login canceled")),
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await saveOAuthCredential(directory, "profile-a", openAICredential());
  await manager.beginLogin();

  assert.deepEqual(await manager.logout(), { status: "signed-out" });
  assert.deepEqual(await manager.readAuthState(), { status: "signed-out" });
  await manager.close();
});

test("closing OAuth ownership prevents a late login from persisting credentials", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel() {},
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await manager.beginLogin();
  const closed = manager.close();
  completion.resolve(openAICredential());
  await closed;

  const reopened = new OAuthCredentialManager(directory, "profile-a", adapter);
  assert.deepEqual(await reopened.readAuthState(), { status: "signed-out" });
  await reopened.close();
});

test("logout retires a login save queued behind another storage transaction", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const transactionStarted = deferred<void>();
  const releaseTransaction = deferred<void>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel() {},
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await manager.beginLogin();
  const heldTransaction = withStorageTransaction(directory, async () => {
    transactionStarted.resolve(undefined);
    await releaseTransaction.promise;
  });
  await transactionStarted.promise;
  completion.resolve(openAICredential());
  await new Promise<void>((resolve) => setImmediate(resolve));

  const caller = new AbortController();
  const logout = manager.logout(caller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  caller.abort(new Error("logout canceled"));
  await assert.rejects(logout, /logout canceled/);
  releaseTransaction.resolve(undefined);
  await heldTransaction;

  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
  await manager.close();
});

test("logout owns and cancels login adapter acquisition before it returns", async (t) => {
  const directory = await temporaryDirectory(t);
  const acquisition = deferred<OAuthLoginAttempt>();
  const acquisitionStarted = deferred<void>();
  const completion = deferred<OAuthCredential>();
  let acquisitionSignal: AbortSignal | undefined;
  let canceled = false;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin(signal) {
      acquisitionSignal = signal;
      acquisitionStarted.resolve(undefined);
      return acquisition.promise;
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  const login = manager.beginLogin();
  await acquisitionStarted.promise;
  const logout = manager.logout();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const acquisitionAbortedBeforeReturn = acquisitionSignal?.aborted;
  acquisition.resolve({
    pending: {
      status: "pending",
      verificationUrl: "https://auth.example.test/device",
    },
    completion: completion.promise,
    cancel(reason) {
      canceled = true;
      completion.reject(reason);
    },
  });
  const [loginResult, logoutResult] = await Promise.allSettled([login, logout]);
  try {
    assert.equal(acquisitionAbortedBeforeReturn, true);
    assert.equal(canceled, true);
    assert.equal(loginResult.status, "rejected");
    assert.deepEqual(
      logoutResult.status === "fulfilled" ? logoutResult.value : undefined,
      { status: "signed-out" },
    );
    assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
  } finally {
    await manager.close();
  }
});

test("logout called in the login admission turn sees ownership before acquisition", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  let beginCalls = 0;
  let canceled = false;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      beginCalls += 1;
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel(reason) {
          canceled = true;
          completion.reject(reason);
        },
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);

  const login = manager.beginLogin();
  const logout = manager.logout();
  const [loginResult, logoutResult] = await Promise.allSettled([login, logout]);

  assert.equal(loginResult.status, "rejected");
  assert.deepEqual(
    logoutResult.status === "fulfilled" ? logoutResult.value : undefined,
    { status: "signed-out" },
  );
  assert.equal(beginCalls, 0);
  assert.equal(canceled, false);
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
  await manager.close();
});

test("caller abort after logout settlement cannot start a resumed login", async (t) => {
  const directory = await temporaryDirectory(t);
  const firstCompletion = deferred<OAuthCredential>();
  const secondCompletion = deferred<OAuthCredential>();
  let beginCalls = 0;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      beginCalls += 1;
      const call = beginCalls;
      const completion = call === 1 ? firstCompletion : secondCompletion;
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel(reason) {
          if (call > 1) completion.reject(reason);
        },
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await manager.beginLogin();

  const abandonedCaller = new AbortController();
  const abandonedLogout = manager.logout(abandonedCaller.signal);
  abandonedCaller.abort(new Error("first logout caller closed"));
  await assert.rejects(abandonedLogout, /first logout caller closed/u);

  const cleanupObserver = manager.logout();
  const resumedCaller = new AbortController();
  const resumedAbort = new Error("resumed login caller closed");
  const abortAfterCleanup = cleanupObserver.then(() => {
    resumedCaller.abort(resumedAbort);
  });
  const resumedLogin = manager.beginLogin(resumedCaller.signal);
  firstCompletion.resolve(openAICredential());

  try {
    await cleanupObserver;
    await abortAfterCleanup;
    await assert.rejects(resumedLogin, (error: unknown) => error === resumedAbort);
    assert.equal(beginCalls, 1);
    assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
  } finally {
    await manager.close();
  }
});

test("close owns and cancels login adapter acquisition before it returns", async (t) => {
  const directory = await temporaryDirectory(t);
  const acquisition = deferred<OAuthLoginAttempt>();
  const acquisitionStarted = deferred<void>();
  const completion = deferred<OAuthCredential>();
  let acquisitionSignal: AbortSignal | undefined;
  let canceled = false;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin(signal) {
      acquisitionSignal = signal;
      acquisitionStarted.resolve(undefined);
      return acquisition.promise;
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  const login = manager.beginLogin();
  await acquisitionStarted.promise;
  let closeSettled = false;
  const closed = manager.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeSettledBeforeAcquisition = closeSettled;
  const acquisitionAbortedBeforeReturn = acquisitionSignal?.aborted;
  acquisition.resolve({
    pending: {
      status: "pending",
      verificationUrl: "https://auth.example.test/device",
    },
    completion: completion.promise,
    cancel(reason) {
      canceled = true;
      completion.reject(reason);
    },
  });
  const [loginResult] = await Promise.allSettled([login, closed]);

  assert.equal(closeSettledBeforeAcquisition, false);
  assert.equal(acquisitionAbortedBeforeReturn, true);
  assert.equal(canceled, true);
  assert.equal(loginResult.status, "rejected");
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
});

test("caller abort cancels an attempt returned after login acquisition lost ownership", async (t) => {
  const directory = await temporaryDirectory(t);
  const acquisition = deferred<OAuthLoginAttempt>();
  const acquisitionStarted = deferred<void>();
  const completion = deferred<OAuthCredential>();
  let canceled = false;
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      acquisitionStarted.resolve(undefined);
      return acquisition.promise;
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  const caller = new AbortController();
  const login = manager.beginLogin(caller.signal);
  await acquisitionStarted.promise;
  acquisition.resolve({
    pending: {
      status: "pending",
      verificationUrl: "https://auth.example.test/device",
    },
    completion: completion.promise,
    cancel(reason) {
      canceled = true;
      completion.reject(reason);
    },
  });
  caller.abort(new Error("login caller closed"));

  await assert.rejects(login, /login caller closed/);
  assert.equal(canceled, true);
  await manager.close();
});

test("concurrent close callers share login retirement completion", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel() {},
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await manager.beginLogin();
  let firstCloseSettled = false;
  const firstClose = manager.close().then(() => {
    firstCloseSettled = true;
  });
  let secondCloseSettled = false;
  const secondClose = manager.close().then(() => {
    secondCloseSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstSettledBeforeLogin = firstCloseSettled;
  const secondSettledBeforeLogin = secondCloseSettled;
  completion.resolve(openAICredential());
  await Promise.all([firstClose, secondClose]);

  assert.equal(firstSettledBeforeLogin, false);
  assert.equal(secondSettledBeforeLogin, false);
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
});

test("caller cancellation does not detach logout cleanup from backend close", async (t) => {
  const directory = await temporaryDirectory(t);
  const completion = deferred<OAuthCredential>();
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      return {
        pending: {
          status: "pending",
          verificationUrl: "https://auth.example.test/device",
        },
        completion: completion.promise,
        cancel() {},
      };
    },
    async refresh(credential) {
      return credential;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);
  await manager.beginLogin();

  const caller = new AbortController();
  const logout = manager.logout(caller.signal);
  caller.abort(new Error("logout caller closed"));
  await assert.rejects(logout, /logout caller closed/);

  let closeSettled = false;
  const closed = manager.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeSettledBeforeLogin = closeSettled;

  completion.resolve(openAICredential());
  await closed;

  assert.equal(closeSettledBeforeLogin, false);
  assert.equal(await loadOAuthCredential(directory, "profile-a", "openai"), undefined);
});

test("OAuth refresh replaces credential-bearing adapter errors", async (t) => {
  const directory = await temporaryDirectory(t);
  const credential = openAICredential(Date.now() - 1);
  await saveOAuthCredential(directory, "profile-a", credential);
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh() {
      throw new Error(
        `request failed with access=${credential.accessToken}&refresh=${credential.refreshToken}`,
      );
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);

  const error = await manager.requireCredential().then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error);
  assert.match(error.message, /ChatGPT OAuth credential refresh failed/u);
  assert.doesNotMatch(error.message, /access-1|refresh-1/u);
  assert.equal(error.cause, undefined);
  await manager.close();
});

test("OAuth refresh preserves an explicitly safe network proxy diagnosis", async (t) => {
  const directory = await temporaryDirectory(t);
  await saveOAuthCredential(directory, "profile-a", openAICredential(Date.now() - 1));
  const error = new NetworkProxyError(
    "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
  const adapter: OAuthProviderAdapter = {
    provider: "openai",
    displayName: "ChatGPT",
    async beginLogin() {
      throw new Error("unexpected login");
    },
    async refresh() {
      throw error;
    },
    authState() {
      throw new Error("unexpected state");
    },
  };
  const manager = new OAuthCredentialManager(directory, "profile-a", adapter);

  await assert.rejects(
    manager.requireCredential(),
    (failure: unknown) => failure === error,
  );
  await manager.close();
});

async function waitForStoredCredential(directory: string): Promise<OAuthCredential> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const credential = await loadOAuthCredential(directory, "profile-a", "openai");
    if (credential) return credential;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("OAuth login did not persist its credential.");
}
