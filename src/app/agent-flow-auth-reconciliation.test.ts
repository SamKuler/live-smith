import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  OAuthSubscriptionBackend,
  OAuthAuthState,
} from "../model/provider.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
import type {
  OAuthSubscriptionProvider,
  SavedProfile,
} from "../model/profile.js";
import { saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import {
  modelAuthSendFenceForStorage,
  type ModelAuthSendFence,
} from "./model-auth-send-fence.js";

let bridgeRequestSequence = 0;

function bridgeJsonHeaders(): Record<string, string> {
  bridgeRequestSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `auth-command-${bridgeRequestSequence}`,
    "X-Live-Smith-Send-Id": `auth-send-${bridgeRequestSequence}`,
  };
}

const subscriptionProfile: SavedProfile = {
  id: "chatgpt-subscription",
  name: "ChatGPT subscription",
  connection: { kind: "oauth-subscription", provider: "openai" },
  defaultModel: "gpt-subscription-model",
  models: [{
    model: "gpt-subscription-model",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  }],
};

const directProfile: SavedProfile = {
  id: "direct-profile",
  name: "Direct API",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
  defaultModel: "direct-model",
  models: [{
    model: "direct-model",
    parameters: {
      maxOutputTokens: 8_192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  }],
};

test("Direct state does not pair stale OAuth auth with a newer generation", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-auth-projection-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  await saveSavedProfile(directory, subscriptionProfile);

  let generation = 0;
  let oauthReads = 0;
  let healthCheckedGenerationReads = 0;
  let projectedGenerationReads = 0;
  const fence: ModelAuthSendFence = {
    async enterRead() {
      oauthReads += 1;
      return () => undefined;
    },
    async enterOAuthUse() {
      throw new Error("unused");
    },
    async enterAuth() {
      throw new Error("unused");
    },
    async enterPendingOwnerCleanup() {
      return null;
    },
    hasPendingLogin() {
      return false;
    },
    async reconcilePendingAuthState() {
      return undefined;
    },
    updateAuthState() {},
    peekAuthGeneration() {
      projectedGenerationReads += 1;
      return generation;
    },
    authGeneration() {
      healthCheckedGenerationReads += 1;
      return generation;
    },
    poison() {},
    releaseOwner() {},
  };
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() {
      return [];
    },
    async createToolTurn() {
      throw new Error("unused");
    },
    async readAuthState() {
      return {
        status: "signed-in",
        accountLabel: "old-account@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
    },
    async beginLogin() {
      throw new Error("unused");
    },
    async logout() {
      throw new Error("unused");
    },
    async close() {},
  };
  const manager = {
    async oauth() {
      return backend;
    },
    async oauthLease() {
      throw new Error("unused");
    },
    async forProfile() {
      throw new Error("unused");
    },
    async invalidateOAuth() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initial = await getState(url);
        assert.equal(initial.oauthAuth?.status, "signed-in");
        assert.equal(initial.oauthAuthGeneration, 0);

        const activation = await command(url, {
          kind: "activate_profile",
          profileId: directProfile.id,
        });
        assert.equal(activation.status, 200, await activation.clone().text());
        assert.equal(
          (await activation.json() as ChatDialogState).oauthAuth?.status,
          "signed-in",
        );

        generation = 1;
        oauthReads = 0;
        healthCheckedGenerationReads = 0;
        projectedGenerationReads = 0;
        const directState = await getState(url);
        assert.equal(directState.oauthAuthGeneration, 1);
        assert.equal("oauthAuth" in directState, false);
        assert.equal(oauthReads, 0);
        assert.equal(healthCheckedGenerationReads, 0);
        assert.equal(projectedGenerationReads, 1);
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    modelAuthSendFence: fence,
  });
});

test("a definitive login mutation owns its response state and can be retried", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-definitive-login-failure-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalStorageDirectory(directory);
  const failure: OAuthAuthState = {
    status: "unavailable",
    message: "ChatGPT sign-in did not complete.",
    definitive: true,
  };
  let auth: OAuthAuthState = { status: "signed-out" };
  let reads = 0;
  let beginCalls = 0;
  let retireCalls = 0;
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() {
      reads += 1;
      if (beginCalls === 1) {
        throw new Error("the definitive mutation result must own this projection");
      }
      return auth;
    },
    async beginLogin() {
      beginCalls += 1;
      auth = beginCalls === 1
        ? failure
        : {
            status: "pending",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
          };
      return auth;
    },
    async logout() {
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() {
      return {
        backend,
        async retire() {
          retireCalls += 1;
          return true;
        },
      };
    },
    async forProfile() { return backend; },
    async invalidateOAuth() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initial = await getState(url);
        assert.equal(initial.oauthAuth?.status, "signed-out");
        const initialGeneration = initial.oauthAuthGeneration;

        const failedLogin = await command(url, {
          kind: "start_oauth_login",
          provider: "openai",
        });
        assert.equal(failedLogin.status, 200, await failedLogin.clone().text());
        const failedState = await failedLogin.json() as ChatDialogState;
        assert.deepEqual(failedState.oauthAuth, failure);
        assert.equal(failedState.status, failure.message);
        assert.equal(failedState.oauthAuthGeneration, initialGeneration + 1);
        assert.equal(reads, 1);
        assert.equal(retireCalls, 0);
        assert.equal(
          modelAuthSendFenceForStorage(storageKey, "openai").hasPendingLogin(),
          false,
        );

        const retriedLogin = await command(url, {
          kind: "start_oauth_login",
          provider: "openai",
        });
        assert.equal(retriedLogin.status, 200, await retriedLogin.clone().text());
        const retriedState = await retriedLogin.json() as ChatDialogState;
        assert.equal(retriedState.oauthAuth?.status, "pending");
        assert.equal(beginCalls, 2);
        assert.equal(retireCalls, 0);

        const logout = await command(url, {
          kind: "logout_oauth",
          provider: "openai",
        });
        assert.equal(logout.status, 200, await logout.clone().text());
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });
});

test("a peer state or Check reconciles completed device login ownership", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-auth-reconcile-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const aliasDirectory = `${directory}-alias`;
  await fs.symlink(directory, aliasDirectory, "dir");
  t.after(() => fs.unlink(aliasDirectory).catch(() => undefined));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalStorageDirectory(directory);

  let auth: OAuthAuthState = { status: "signed-out" };
  const signedIn = (): OAuthAuthState => ({
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  });
  let completeDuringStart = false;
  let blockConcurrentReadiness = false;
  let concurrentReadinessCalls = 0;
  const concurrentReadinessStarted = deferred<void>();
  const releaseConcurrentReadiness = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() {
      return [{
        id: subscriptionProfile.defaultModel,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() {
      throw new Error("the injected model turn owns this test");
    },
    async readAuthState(signal, options) {
      if (blockConcurrentReadiness && options?.readiness === true) {
        assert.ok(
          signal,
          "a shared pending-login refresh must own a fence-scoped signal",
        );
        concurrentReadinessCalls += 1;
        concurrentReadinessStarted.resolve();
        await releaseConcurrentReadiness.promise;
      }
      return auth;
    },
    async beginLogin() {
      const pending: OAuthAuthState = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      auth = completeDuringStart ? signedIn() : pending;
      return pending;
    },
    async logout() {
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() { return backend; },
    async invalidateOAuth() {},
    async close() {},
  };
  const ownerUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeOwner = deferred<void>();
  const closePeer = deferred<void>();
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    ready: ReturnType<typeof deferred<string>>,
    close: ReturnType<typeof deferred<void>>,
    storageDirectory: string,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: {
      showModalDialog: async (url: string) => {
        ready.resolve(url);
        await close.promise;
      },
    },
  });
  const dependencies = {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    requestModelTurn: async () => ({ content: "Ready", toolCalls: [] }),
  };
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner, directory) as never,
    interaction,
    dependencies,
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer, aliasDirectory) as never,
    interaction,
    dependencies,
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const peerInitial = await getState(peerDialogUrl);
    await getState(ownerDialogUrl);

    const firstPending = await command(ownerDialogUrl, {
      kind: "start_oauth_login",
      provider: "openai",
    });
    assert.equal(firstPending.status, 200);
    const firstPendingGeneration = modelAuthSendFenceForStorage(storageKey, "openai")
      .authGeneration();
    const blockedSend = await send(
      peerDialogUrl,
      peerInitial.activeSessionId,
      "send-before-login-completion",
    );
    assert.equal(blockedSend.status, 409);

    auth = signedIn();
    const peerAfterPassiveRead = await getState(peerDialogUrl);
    assert.equal(peerAfterPassiveRead.oauthAuth?.status, "signed-in");
    assert.equal(
      modelAuthSendFenceForStorage(storageKey, "openai").authGeneration(),
      firstPendingGeneration + 1,
    );

    auth = { status: "signed-out" };
    const secondPending = await command(ownerDialogUrl, {
      kind: "start_oauth_login",
      provider: "openai",
    });
    assert.equal(secondPending.status, 200);
    const secondPendingGeneration = modelAuthSendFenceForStorage(storageKey, "openai")
      .authGeneration();
    auth = signedIn();

    const peerCheck = await command(peerDialogUrl, {
      kind: "refresh_oauth_account",
      provider: "openai",
    });
    assert.equal(peerCheck.status, 200, await peerCheck.clone().text());
    const peerAfterCheck = await peerCheck.json() as ChatDialogState;
    assert.equal(peerAfterCheck.oauthAuth?.status, "signed-in");
    assert.equal(
      modelAuthSendFenceForStorage(storageKey, "openai").authGeneration(),
      secondPendingGeneration + 1,
    );

    const allowedSend = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-peer-reconciliation",
    );
    assert.equal(allowedSend.status, 200, await allowedSend.text());

    auth = { status: "signed-out" };
    completeDuringStart = true;
    const instantCompletion = await command(ownerDialogUrl, {
      kind: "start_oauth_login",
      provider: "openai",
    });
    assert.equal(
      instantCompletion.status,
      200,
      await instantCompletion.clone().text(),
    );
    const instantState = await instantCompletion.json() as ChatDialogState;
    assert.equal(instantState.oauthAuth?.status, "signed-in");
    const sendAfterInstantCompletion = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-instant-login-completion",
    );
    assert.equal(
      sendAfterInstantCompletion.status,
      200,
      await sendAfterInstantCompletion.text(),
    );

    completeDuringStart = false;
    auth = { status: "signed-out" };
    const pendingBeforeConcurrentChecks = await command(ownerDialogUrl, {
      kind: "start_oauth_login",
      provider: "openai",
    });
    assert.equal(
      pendingBeforeConcurrentChecks.status,
      200,
      await pendingBeforeConcurrentChecks.clone().text(),
    );
    blockConcurrentReadiness = true;
    const firstConcurrentCheck = command(ownerDialogUrl, {
      kind: "refresh_oauth_account",
      provider: "openai",
    });
    const secondConcurrentCheck = command(peerDialogUrl, {
      kind: "refresh_oauth_account",
      provider: "openai",
    });
    await concurrentReadinessStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      concurrentReadinessCalls,
      1,
      "pending-login reconciliation must share one readiness refresh",
    );
    const sendDuringConcurrentCheck = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-during-concurrent-login-check",
    );
    assert.equal(sendDuringConcurrentCheck.status, 409);
    releaseConcurrentReadiness.resolve();
    const concurrentChecks = await Promise.all([
      firstConcurrentCheck,
      secondConcurrentCheck,
    ]);
    assert.deepEqual(
      concurrentChecks.map((response) => response.status),
      [200, 200],
    );
    assert.equal(
      concurrentReadinessCalls,
      1,
      "building both Check responses must reuse the shared pending auth state",
    );
    const sendAfterConcurrentChecks = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-concurrent-login-checks",
    );
    assert.equal(sendAfterConcurrentChecks.status, 409);

    blockConcurrentReadiness = false;
    auth = signedIn();
    const completedAfterConcurrentChecks = await command(ownerDialogUrl, {
      kind: "refresh_oauth_account",
      provider: "openai",
    });
    assert.equal(
      completedAfterConcurrentChecks.status,
      200,
      await completedAfterConcurrentChecks.clone().text(),
    );
    const sendAfterCompletion = await send(
      peerDialogUrl,
      peerAfterCheck.activeSessionId,
      "send-after-concurrent-login-completion",
    );
    assert.equal(sendAfterCompletion.status, 200, await sendAfterCompletion.text());
  } finally {
    releaseConcurrentReadiness.resolve();
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

test("closing a pending-login owner aborts its state read before peer auth resumes", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-auth-owner-close-read-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: OAuthAuthState = { status: "signed-out" };
  let blockOwnerRead = false;
  let invalidations = 0;
  const blockedReadStarted = deferred<void>();
  const blockedReadAborted = deferred<void>();
  const forceReleaseRead = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState(signal, options) {
      if (blockOwnerRead && options?.readiness === true) {
        assert.ok(signal, "pending reconciliation must own a cancellation signal");
        blockedReadStarted.resolve();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            blockOwnerRead = false;
            blockedReadAborted.resolve();
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          forceReleaseRead.promise.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
      return auth;
    },
    async beginLogin() {
      auth = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      return auth;
    },
    async logout() {
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() { return backend; },
    async invalidateOAuth() {
      invalidations += 1;
      auth = { status: "signed-out" };
    },
    async close() {},
  };
  const ownerUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeOwner = deferred<void>();
  const closePeer = deferred<void>();
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    ready: ReturnType<typeof deferred<string>>,
    close: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        ready.resolve(url);
        await close.promise;
      },
    },
  });
  const dependencies = {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  };
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    dependencies,
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    dependencies,
  );
  let stateRead: Promise<"response" | "error"> | undefined;

  try {
    const [ownerDialogUrl, peerDialogUrl] = await resolvesWithin(
      Promise.all([ownerUrl.promise, peerUrl.promise]),
      "modal bridge startup",
    );
    await resolvesWithin(
      Promise.all([getState(ownerDialogUrl), getState(peerDialogUrl)]),
      "initial modal states",
    );
    const login = await resolvesWithin(
      command(ownerDialogUrl, {
        kind: "start_oauth_login",
        provider: "openai",
      }),
      "pending login command",
    );
    assert.equal(login.status, 200, await login.clone().text());

    blockOwnerRead = true;
    stateRead = fetch(endpoint(ownerDialogUrl, "/state")).then(
      () => "response" as const,
      () => "error" as const,
    );
    await resolvesWithin(blockedReadStarted.promise, "blocked OAuth state read");
    closeOwner.resolve();

    await resolvesWithin(ownerFlow, "pending-login owner close");
    await resolvesWithin(blockedReadAborted.promise, "OAuth state read abort");
    assert.equal(
      await resolvesWithin(stateRead, "closed OAuth state response"),
      "error",
    );
    assert.ok(invalidations > 0, "owner close must retire its pending backend");

    const peerRefresh = await resolvesWithin(
      command(peerDialogUrl, {
        kind: "refresh_oauth_account",
        provider: "openai",
      }),
      "peer auth refresh after owner close",
    );
    assert.equal(peerRefresh.status, 200, await peerRefresh.clone().text());
    assert.equal(
      (await peerRefresh.json() as ChatDialogState).oauthAuth?.status,
      "signed-out",
    );
  } finally {
    forceReleaseRead.resolve();
    closeOwner.resolve();
    closePeer.resolve();
    if (stateRead) {
      await resolvesWithin(
        stateRead.catch(() => "error" as const),
        "OAuth state response cleanup",
      );
    }
    await resolvesWithin(
      Promise.allSettled([ownerFlow, peerFlow]),
      "modal flow cleanup",
    );
  }
});

test("modal close retires every provider before reporting one cleanup failure", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-provider-auth-ownership-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalStorageDirectory(directory);
  const auth = new Map<OAuthSubscriptionProvider, OAuthAuthState>([
    ["openai", { status: "signed-out" }],
    ["anthropic", { status: "signed-out" }],
    ["google", { status: "signed-out" }],
  ]);
  const backends = new Map<OAuthSubscriptionProvider, OAuthSubscriptionBackend>();
  const backendFor = (provider: OAuthSubscriptionProvider): OAuthSubscriptionBackend => {
    let backend = backends.get(provider);
    if (backend) return backend;
    backend = {
      kind: "oauth-subscription",
      async listModels() { return []; },
      async createToolTurn() { return { content: null, toolCalls: [] }; },
      async readAuthState() { return auth.get(provider)!; },
      async beginLogin() {
        const pending: OAuthAuthState = {
          status: "pending",
          verificationUrl: provider === "openai"
            ? "https://auth.openai.com/codex/device"
            : "https://accounts.google.com/o/oauth2/v2/auth",
        };
        auth.set(provider, pending);
        return pending;
      },
      async logout() {
        const signedOut: OAuthAuthState = { status: "signed-out" };
        auth.set(provider, signedOut);
        return signedOut;
      },
      async close() {},
    };
    backends.set(provider, backend);
    return backend;
  };
  const invalidated: OAuthSubscriptionProvider[] = [];
  const manager = {
    async oauth(provider: OAuthSubscriptionProvider) { return backendFor(provider); },
    async oauthLease(provider: OAuthSubscriptionProvider) {
      return { backend: backendFor(provider), async retire() { return true; } };
    },
    async forProfile(profile: SavedProfile) {
      assert.equal(profile.connection.kind, "oauth-subscription");
      return backendFor(profile.connection.provider);
    },
    async invalidateOAuth(provider: OAuthSubscriptionProvider) {
      invalidated.push(provider);
      if (provider === "openai") {
        throw new Error("OpenAI retirement failed");
      }
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await assert.rejects(
    runAgentFlow({
      application: { song: { handle: { id: 1n } } },
      environment: { storageDirectory: directory },
      ui: {
        showModalDialog: async (url: string) => {
          await getState(url);
          const openAIPending = await command(url, {
            kind: "start_oauth_login",
            provider: "openai",
          });
          assert.equal(openAIPending.status, 200, await openAIPending.clone().text());

          const googleCheck = await command(url, {
            kind: "refresh_oauth_account",
            provider: "google",
          });
          assert.equal(googleCheck.status, 200, await googleCheck.clone().text());
          const googleState = await googleCheck.json() as ChatDialogState;
          assert.equal(googleState.oauthAuthProvider, "google");
          assert.equal(googleState.oauthAuth?.status, "signed-out");
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, "openai").hasPendingLogin(),
            true,
          );
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, "google").hasPendingLogin(),
            false,
          );

          const googlePending = await command(url, {
            kind: "start_oauth_login",
            provider: "google",
          });
          assert.equal(googlePending.status, 200, await googlePending.clone().text());
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, "openai").hasPendingLogin(),
            true,
          );
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, "google").hasPendingLogin(),
            true,
          );
        },
      },
    } as never, interaction, {
      renderHtml: () => "<html></html>",
      modelBackendManager: manager,
    }),
    /OpenAI retirement failed/,
  );

  assert.deepEqual([...invalidated].sort(), ["google", "openai"]);
  assert.throws(
    () => modelAuthSendFenceForStorage(storageKey, "openai").authGeneration(),
    /could not be shut down safely/i,
  );
  assert.doesNotThrow(
    () => modelAuthSendFenceForStorage(storageKey, "google").authGeneration(),
  );
  assert.equal(
    modelAuthSendFenceForStorage(storageKey, "openai").hasPendingLogin(),
    false,
  );
  assert.equal(
    modelAuthSendFenceForStorage(storageKey, "google").hasPendingLogin(),
    false,
  );
});

test("logout cancels the pending provider browser launch", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-browser-logout-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: OAuthAuthState = { status: "signed-out" };
  const browserStarted = deferred<void>();
  const browserAborted = deferred<unknown>();
  const dialogUrl = deferred<string>();
  const closeDialog = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async readAuthState() { return auth; },
    async beginLogin() {
      auth = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      return auth;
    },
    async logout() {
      auth = { status: "signed-out" };
      return auth;
    },
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() { return backend; },
    async invalidateOAuth() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const flow = runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        dialogUrl.resolve(url);
        await closeDialog.promise;
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    openOAuthAuthorizationUrl: async (_url, signal) => {
      assert.ok(signal);
      browserStarted.resolve();
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          browserAborted.resolve(signal.reason);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
  });

  try {
    const url = await dialogUrl.promise;
    const pendingResponse = await command(url, {
      kind: "start_oauth_login",
      provider: "openai",
    });
    assert.equal(pendingResponse.status, 200);
    assert.equal(
      ((await pendingResponse.json()) as ChatDialogState).oauthAuth?.status,
      "pending",
    );
    await browserStarted.promise;

    const logoutResponse = await command(url, {
      kind: "logout_oauth",
      provider: "openai",
    });
    assert.equal(logoutResponse.status, 200);
    assert.equal(
      ((await logoutResponse.json()) as ChatDialogState).oauthAuth?.status,
      "signed-out",
    );
    const abortReason = await browserAborted.promise;
    assert.ok(abortReason instanceof Error);
    assert.match(abortReason.message, /sign-in was canceled/i);
  } finally {
    closeDialog.resolve();
    await flow;
  }
});

function endpoint(dialogUrl: string, pathname: string): string {
  const url = new URL(dialogUrl);
  return `${url.origin}${pathname}?token=${url.searchParams.get("token")}`;
}

async function getState(dialogUrl: string): Promise<ChatDialogState> {
  const response = await fetch(endpoint(dialogUrl, "/state"));
  assert.equal(response.status, 200);
  return response.json() as Promise<ChatDialogState>;
}

function command(dialogUrl: string, body: unknown): Promise<Response> {
  return fetch(endpoint(dialogUrl, "/command"), {
    method: "POST",
    headers: bridgeJsonHeaders(),
    body: JSON.stringify(body),
  });
}

function send(
  dialogUrl: string,
  sessionId: string,
  sendId: string,
): Promise<Response> {
  return fetch(endpoint(dialogUrl, "/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": sendId,
    },
    body: JSON.stringify({ prompt: "Use the shared account", sessionId }),
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function resolvesWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not settle within ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
