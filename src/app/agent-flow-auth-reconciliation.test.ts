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
  DraftProfile,
  OAuthSubscriptionProvider,
  SavedProfile,
} from "../model/profile.js";
import {
  deleteSavedProfile,
  loadAgentSettings,
  prepareOAuthCredentialStoreForSavedProfiles,
  saveSavedProfile,
  savedProfileRevision,
} from "../storage/settings.js";
import {
  loadOAuthCredential,
  saveOAuthCredential,
} from "../storage/oauth-credentials.js";
import { StorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import {
  modelAuthSendFenceForStorage,
  type ModelAuthSendFence,
} from "./model-auth-send-fence.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

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

const secondSubscriptionProfile: SavedProfile = {
  id: "second-chatgpt-subscription",
  name: "Second ChatGPT subscription",
  connection: { kind: "oauth-subscription", provider: "openai" },
  defaultModel: "gpt-second-subscription-model",
  models: [{
    model: "gpt-second-subscription-model",
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

function assertOAuthScope(
  profileId: string,
  provider: OAuthSubscriptionProvider,
  expectedProfileId = subscriptionProfile.id,
  expectedProvider: OAuthSubscriptionProvider = "openai",
): void {
  assert.equal(profileId, expectedProfileId);
  assert.equal(provider, expectedProvider);
}

test("a signed-in OAuth Profile does not project or authorize another Profile", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-profile-auth-isolation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  await saveSavedProfile(directory, secondSubscriptionProfile);

  const authByProfileId = new Map<string, OAuthAuthState>([
    [subscriptionProfile.id, {
      status: "signed-in",
      accountLabel: "first@example.test",
      planType: "pro",
      subscriptionEligible: true,
    }],
    [secondSubscriptionProfile.id, { status: "signed-out" }],
  ]);
  const managerCalls: Array<{
    method: "oauth" | "oauthLease";
    profileId: string;
    provider: OAuthSubscriptionProvider;
  }> = [];
  const backends = new Map<string, OAuthSubscriptionBackend>();
  const backendFor = (
    profileId: string,
    provider: OAuthSubscriptionProvider,
  ): OAuthSubscriptionBackend => {
    assert.equal(provider, "openai");
    const existing = backends.get(profileId);
    if (existing) return existing;
    const backend: OAuthSubscriptionBackend = {
      kind: "oauth-subscription",
      async listModels(profile) {
        assert.equal(profile.id, profileId);
        return [{
          id: profile.defaultModel,
          displayName: profile.defaultModel,
          capabilities: { tools: true, streaming: true },
        }];
      },
      async createToolTurn() {
        throw new Error("a signed-out Profile must not start a model request");
      },
      async readAuthState() {
        return authByProfileId.get(profileId)!;
      },
      async beginLogin() {
        throw new Error("unused");
      },
      async logout() {
        authByProfileId.set(profileId, { status: "signed-out" });
        return authByProfileId.get(profileId)!;
      },
      async close() {},
    };
    backends.set(profileId, backend);
    return backend;
  };
  const manager = {
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      managerCalls.push({ method: "oauth", profileId, provider });
      return backendFor(profileId, provider);
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      managerCalls.push({ method: "oauthLease", profileId, provider });
      return {
        backend: backendFor(profileId, provider),
        async retire() { return true; },
      };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.connection.kind, "oauth-subscription");
      return backendFor(profile.id, profile.connection.provider);
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      backendFor(profileId, provider);
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
        const secondInitial = await getState(url);
        assert.equal(secondInitial.oauthAuthProfileId, secondSubscriptionProfile.id);
        assert.equal(secondInitial.oauthAuthProvider, "openai");
        assert.equal(secondInitial.oauthAuth?.status, "signed-out");

        const firstActivation = await command(url, {
          kind: "activate_profile",
          profileId: subscriptionProfile.id,
        });
        assert.equal(firstActivation.status, 200, await firstActivation.clone().text());
        const firstState = await firstActivation.json() as ChatDialogState;
        assert.equal(firstState.oauthAuthProfileId, subscriptionProfile.id);
        assert.equal(firstState.oauthAuth?.status, "signed-in");

        const secondActivation = await command(url, {
          kind: "activate_profile",
          profileId: secondSubscriptionProfile.id,
        });
        assert.equal(
          secondActivation.status,
          200,
          await secondActivation.clone().text(),
        );
        const secondState = await secondActivation.json() as ChatDialogState;
        assert.equal(secondState.oauthAuthProfileId, secondSubscriptionProfile.id);
        assert.equal(secondState.oauthAuthProvider, "openai");
        assert.equal(secondState.oauthAuth?.status, "signed-out");

        managerCalls.length = 0;
        const blockedSend = await send(
          url,
          secondState.activeSessionId,
          "second-profile-must-not-inherit-auth",
        );
        assert.equal(blockedSend.status, 409, await blockedSend.clone().text());
        assert.deepEqual(managerCalls, [{
          method: "oauthLease",
          profileId: secondSubscriptionProfile.id,
          provider: "openai",
        }]);
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });
});

test("Direct state does not project or read a prior Profile OAuth scope", async (t) => {
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
    pendingLoginProvider() {
      return undefined;
    },
    hasAuthActivity() {
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
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return backend;
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      throw new Error("unused");
    },
    async forProfile(
      _profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      throw new Error("unused");
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      assertOAuthScope(profileId, provider);
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
        const activationState = await activation.json() as ChatDialogState;
        assert.equal("oauthAuth" in activationState, false);
        assert.equal(activationState.oauthAuthGeneration, 0);

        generation = 1;
        oauthReads = 0;
        healthCheckedGenerationReads = 0;
        projectedGenerationReads = 0;
        const directState = await getState(url);
        assert.equal(directState.oauthAuthGeneration, 0);
        assert.equal("oauthAuth" in directState, false);
        assert.equal(oauthReads, 0);
        assert.equal(healthCheckedGenerationReads, 0);
        assert.equal(projectedGenerationReads, 0);
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
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return backend;
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return {
        backend,
        async retire() {
          retireCalls += 1;
          return true;
        },
      };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.id, subscriptionProfile.id);
      return backend;
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      assertOAuthScope(profileId, provider);
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
          profileId: subscriptionProfile.id,
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
          modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
            .hasPendingLogin(),
          false,
        );

        const retriedLogin = await command(url, {
          kind: "start_oauth_login",
          profileId: subscriptionProfile.id,
          provider: "openai",
        });
        assert.equal(retriedLogin.status, 200, await retriedLogin.clone().text());
        const retriedState = await retriedLogin.json() as ChatDialogState;
        assert.equal(retriedState.oauthAuth?.status, "pending");
        assert.equal(beginCalls, 2);
        assert.equal(retireCalls, 0);

        const overlappingProvider = await command(url, {
          kind: "start_oauth_login",
          profileId: subscriptionProfile.id,
          provider: "google",
        });
        assert.equal(overlappingProvider.status, 409);
        assert.match(
          String((await overlappingProvider.json() as { error?: string }).error),
          /pending sign-in/i,
        );
        assert.equal(beginCalls, 2);

        const logout = await command(url, {
          kind: "logout_oauth",
          profileId: subscriptionProfile.id,
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

test("unknown Profile mutations reconcile OAuth cleanup from saved state", async (t) => {
  for (const operation of ["save", "delete"] as const) {
    for (const committed of [false, true]) {
      await t.test(`${operation} ${committed ? "committed" : "not committed"}`, async (t) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `live-smith-unknown-profile-save-${committed}-`),
      );
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      await saveSavedProfile(directory, subscriptionProfile);
      await saveOAuthCredential(directory, subscriptionProfile.id, {
        provider: "openai",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 2_000_000_000_000,
        accountId: "account-1",
      });
      const target: SavedProfile = {
        ...directProfile,
        id: subscriptionProfile.id,
        name: "Converted Direct Profile",
      };
      const backend: OAuthSubscriptionBackend = {
        kind: "oauth-subscription",
        async listModels() { return []; },
        async createToolTurn() { return { content: null, toolCalls: [] }; },
        async readAuthState() {
          return {
            status: "signed-in",
            accountLabel: "listener@example.test",
            planType: "pro",
            subscriptionEligible: true,
          };
        },
        async beginLogin() { throw new Error("unused"); },
        async logout() { return { status: "signed-out" }; },
        async close() {},
      };
      const manager = {
        async oauth(
          profileId: string,
          provider: OAuthSubscriptionProvider,
        ) {
          assertOAuthScope(profileId, provider);
          return backend;
        },
        async oauthLease() { throw new Error("unused"); },
        async forProfile() { return backend; },
        async invalidateOAuth() {},
        async close() {},
      };
      const interaction: LiveInteractionContext = {
        presentation: liveContextPresentationFixture("Lead"),
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
            await getState(url);
            const response = await command(
              url,
              operation === "save"
                ? {
                    kind: "save_profile",
                    profile: target,
                    expectedProfileRevision:
                      savedProfileRevision(subscriptionProfile),
                  }
                : {
                    kind: "delete_profile",
                    profileId: subscriptionProfile.id,
                  },
            );
            assert.notEqual(response.status, 200);
          },
        },
      } as never, interaction, {
        renderHtml: () => "<html></html>",
        modelBackendManager: manager,
        saveSavedProfile: async (storageDirectory, profile, options) => {
          assert.equal(operation, "save");
          if (committed) {
            await saveSavedProfile(storageDirectory, profile, options);
          }
          throw new StorageCommitOutcomeUnknownError(
            new Error("Injected unknown Profile save outcome"),
          );
        },
        deleteSavedProfile: async (storageDirectory, profileId) => {
          assert.equal(operation, "delete");
          if (committed) {
            await deleteSavedProfile(storageDirectory, profileId);
          }
          throw new StorageCommitOutcomeUnknownError(
            new Error("Injected unknown Profile delete outcome"),
          );
        },
      });

      const settings = await loadAgentSettings(directory);
      const saved = settings.profiles.find((profile) => profile.id === target.id);
      assert.equal(saved?.connection.kind, committed
        ? operation === "save" ? "direct-api" : undefined
        : "oauth-subscription");
      assert.equal(
        (await loadOAuthCredential(directory, target.id, "openai")) !== undefined,
        !committed,
      );
      });
    }
  }
});

test("a later modal retries unknown Profile OAuth cleanup after the owner closes", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-cross-modal-oauth-reconcile-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  await saveOAuthCredential(directory, subscriptionProfile.id, {
    provider: "openai",
    accessToken: "openai-access",
    refreshToken: "openai-refresh",
    expiresAt: 2_000_000_000_000,
    accountId: "account-1",
  });
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const target: SavedProfile = {
    ...directProfile,
    id: subscriptionProfile.id,
    name: "Converted Direct Profile",
  };
  const auth: OAuthAuthState = {
    status: "signed-in",
    accountLabel: "owner@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() { return auth; },
    async beginLogin() { throw new Error("unused"); },
    async logout() { return { status: "signed-out" }; },
    async close() {},
  };
  let invalidations = 0;
  const manager = {
    async oauth() { return backend; },
    async oauthLease() { return { backend, async retire() { return true; } }; },
    async forProfile() { return backend; },
    async invalidateOAuth() { invalidations += 1; },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let committedSettings = "";

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const response = await command(url, {
          kind: "save_profile",
          profile: target,
          expectedProfileRevision: savedProfileRevision(subscriptionProfile),
        });
        assert.equal(response.status, 500);
        assert.notEqual(committedSettings, "");
        await fs.writeFile(settingsPath, committedSettings, "utf8");
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    saveSavedProfile: async (storageDirectory, profile, options) => {
      await saveSavedProfile(storageDirectory, profile, options);
      committedSettings = await fs.readFile(settingsPath, "utf8");
      await fs.writeFile(settingsPath, "{invalid", "utf8");
      throw new StorageCommitOutcomeUnknownError(
        new Error("Injected unknown Profile save outcome"),
      );
    },
  });

  assert.ok(await loadOAuthCredential(directory, target.id, "openai"));
  const invalidationsBeforeRetry = invalidations;
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const state = await getState(url);
        assert.equal(
          state.settings.profiles.find((profile) => profile.id === target.id)
            ?.connection.kind,
          "direct-api",
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });

  assert.ok(invalidations > invalidationsBeforeRetry);
  assert.equal(
    await loadOAuthCredential(directory, target.id, "openai"),
    undefined,
  );
});

test("pending Profile cleanup and same-Profile Save use one lock order", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-profile-cleanup-lock-order-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const settingsPath = path.join(directory, "live-smith-settings.json");
  const storageKey = await canonicalStorageDirectory(directory);
  const target: SavedProfile = {
    ...directProfile,
    id: subscriptionProfile.id,
    name: "Converted Direct Profile",
  };
  const underlyingFence = modelAuthSendFenceForStorage(
    storageKey,
    subscriptionProfile.id,
  );
  const retryEnterStarted = deferred<void>();
  const releaseRetryEnter = deferred<void>();
  let interceptRetry = false;
  let interceptedAuthEntries = 0;
  const fence: ModelAuthSendFence = {
    enterRead: (signal) => underlyingFence.enterRead(signal),
    enterOAuthUse: (signal) => underlyingFence.enterOAuthUse(signal),
    async enterAuth(owner, provider, signal, allowPendingOwner) {
      if (interceptRetry) {
        interceptedAuthEntries += 1;
        if (interceptedAuthEntries === 1) {
          retryEnterStarted.resolve();
          await releaseRetryEnter.promise;
        }
      }
      return underlyingFence.enterAuth(
        owner,
        provider,
        signal,
        allowPendingOwner,
      );
    },
    enterPendingOwnerCleanup: (owner, provider, signal) =>
      underlyingFence.enterPendingOwnerCleanup(owner, provider, signal),
    hasPendingLogin: (provider) => underlyingFence.hasPendingLogin(provider),
    pendingLoginProvider: () => underlyingFence.pendingLoginProvider(),
    hasAuthActivity: (provider) => underlyingFence.hasAuthActivity(provider),
    reconcilePendingAuthState: (provider, readAuthState, signal) =>
      underlyingFence.reconcilePendingAuthState(provider, readAuthState, signal),
    updateAuthState: (owner, provider, status, mutationAttempted) =>
      underlyingFence.updateAuthState(
        owner,
        provider,
        status,
        mutationAttempted,
      ),
    peekAuthGeneration: (provider) =>
      underlyingFence.peekAuthGeneration(provider),
    authGeneration: (provider) => underlyingFence.authGeneration(provider),
    poison: (cause) => underlyingFence.poison(cause),
    releaseOwner: (owner) => underlyingFence.releaseOwner(owner),
  };
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() { return { status: "signed-out" }; },
    async beginLogin() { throw new Error("unused"); },
    async logout() { return { status: "signed-out" }; },
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() { return { backend, async retire() { return true; } }; },
    async forProfile() { return backend; },
    async invalidateOAuth() {},
    async close() {},
  };
  const firstUrl = deferred<string>();
  const secondUrl = deferred<string>();
  const closeFirst = deferred<void>();
  const closeSecond = deferred<void>();
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let committedSettings = "";
  let injectUnknownSave = true;
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
  const firstFlow = runAgentFlow(
    contextFor(firstUrl, closeFirst) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: manager,
      modelAuthSendFence: fence,
      saveSavedProfile: async (storageDirectory, profile, options) => {
        const settings = await saveSavedProfile(storageDirectory, profile, options);
        if (!injectUnknownSave) return settings;
        injectUnknownSave = false;
        committedSettings = await fs.readFile(settingsPath, "utf8");
        await fs.writeFile(settingsPath, "{invalid", "utf8");
        throw new StorageCommitOutcomeUnknownError(
          new Error("Injected unknown Profile save outcome"),
        );
      },
    },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondUrl, closeSecond) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: manager,
      modelAuthSendFence: fence,
    },
  );
  let pendingState: Promise<Response> | undefined;
  let concurrentSave: Promise<Response> | undefined;

  try {
    const [firstDialogUrl, secondDialogUrl] = await resolvesWithin(
      Promise.all([firstUrl.promise, secondUrl.promise]),
      "modal bridge startup",
    );
    const unknownSave = await command(firstDialogUrl, {
      kind: "save_profile",
      profile: target,
      expectedProfileRevision: savedProfileRevision(subscriptionProfile),
    });
    assert.equal(unknownSave.status, 500);
    await fs.writeFile(settingsPath, committedSettings, "utf8");
    const current = await loadAgentSettings(directory);
    const saved = current.profiles.find((profile) => profile.id === target.id);
    assert.ok(saved);
    assert.equal(saved.connection.kind, "direct-api");

    interceptRetry = true;
    pendingState = fetch(endpoint(secondDialogUrl, "/state"));
    await resolvesWithin(retryEnterStarted.promise, "pending cleanup entry");
    concurrentSave = command(firstDialogUrl, {
      kind: "save_profile",
      profile: saved,
      expectedProfileRevision: savedProfileRevision(saved),
    });
    const saveResponse = await resolvesWithin(
      concurrentSave,
      "same-Profile Save while cleanup entry is paused",
      500,
    );
    assert.equal(saveResponse.status, 200, await saveResponse.clone().text());

    releaseRetryEnter.resolve();
    const stateResponse = await resolvesWithin(
      pendingState,
      "pending cleanup state retry",
    );
    assert.equal(stateResponse.status, 200, await stateResponse.clone().text());
  } finally {
    releaseRetryEnter.resolve();
    closeFirst.resolve();
    closeSecond.resolve();
    await Promise.allSettled([
      ...(pendingState ? [pendingState] : []),
      ...(concurrentSave ? [concurrentSave] : []),
      firstFlow,
      secondFlow,
    ]);
  }
});

test("a delayed OAuth read cannot project Profile A auth onto Profile B", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-delayed-profile-auth-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalStorageDirectory(directory);
  const delayedAReadStarted = deferred<void>();
  const releaseDelayedARead = deferred<void>();
  const authA: OAuthAuthState = {
    status: "signed-in",
    accountLabel: "profile-a@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const authB: OAuthAuthState = { status: "signed-out" };
  let profileAReads = 0;
  const backendFor = (profileId: string): OAuthSubscriptionBackend => ({
    kind: "oauth-subscription",
    async listModels(profile) {
      return [{
        id: profile.defaultModel,
        displayName: profile.defaultModel,
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() {
      if (profileId === subscriptionProfile.id) {
        profileAReads += 1;
        if (profileAReads > 1) {
          delayedAReadStarted.resolve();
          await releaseDelayedARead.promise;
        }
        return authA;
      }
      return authB;
    },
    async beginLogin() { throw new Error("unused"); },
    async logout() { return { status: "signed-out" }; },
    async close() {},
  });
  const backends = new Map<string, OAuthSubscriptionBackend>();
  const manager = {
    async oauth(profileId: string) {
      let backend = backends.get(profileId);
      if (!backend) {
        backend = backendFor(profileId);
        backends.set(profileId, backend);
      }
      return backend;
    },
    async oauthLease(profileId: string) {
      return {
        backend: await this.oauth(profileId),
        async retire() { return true; },
      };
    },
    async forProfile(profile: DraftProfile | SavedProfile) {
      return this.oauth(profile.id);
    },
    async invalidateOAuth() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
        assert.equal(initial.oauthAuthProfileId, subscriptionProfile.id);
        assert.equal(initial.oauthAuth?.status, "signed-in");

        const fenceA = modelAuthSendFenceForStorage(
          storageKey,
          subscriptionProfile.id,
        );
        const peerOwner = Symbol("Profile A account changed");
        const releasePeer = await fenceA.enterAuth(peerOwner, "openai");
        assert.ok(releasePeer);
        fenceA.updateAuthState(peerOwner, "openai", "signed-out", true);
        releasePeer();

        const delayedAState = fetch(endpoint(url, "/state"));
        await resolvesWithin(delayedAReadStarted.promise, "delayed Profile A read");
        const firstBDiscovery = await command(url, {
          kind: "discover_models",
          profile: secondSubscriptionProfile,
        });
        assert.equal(
          firstBDiscovery.status,
          200,
          await firstBDiscovery.clone().text(),
        );
        const firstBState = await firstBDiscovery.json() as ChatDialogState;
        assert.equal(firstBState.oauthAuthProfileId, secondSubscriptionProfile.id);
        assert.deepEqual(firstBState.oauthAuth, authB);

        releaseDelayedARead.resolve();
        const profileAResponse = await resolvesWithin(
          delayedAState,
          "Profile A state response",
        );
        assert.equal(profileAResponse.status, 200);
        const profileAState = await profileAResponse.json() as ChatDialogState;
        assert.equal(profileAState.oauthAuthProfileId, subscriptionProfile.id);
        assert.deepEqual(profileAState.oauthAuth, authA);

        const secondBDiscovery = await command(url, {
          kind: "discover_models",
          profile: secondSubscriptionProfile,
        });
        assert.equal(
          secondBDiscovery.status,
          200,
          await secondBDiscovery.clone().text(),
        );
        const secondBState = await secondBDiscovery.json() as ChatDialogState;
        assert.equal(secondBState.oauthAuthProfileId, secondSubscriptionProfile.id);
        assert.deepEqual(secondBState.oauthAuth, authB);
        fenceA.releaseOwner(peerOwner);
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });
});

test("known Profile commits report failed OAuth cleanup as unknown and retry safely", async (t) => {
  for (const operation of ["save", "delete"] as const) {
    await t.test(operation, { timeout: 5_000 }, async (t) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `live-smith-known-${operation}-cleanup-`),
      );
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      await saveSavedProfile(directory, subscriptionProfile);
      await saveOAuthCredential(directory, subscriptionProfile.id, {
        provider: "openai",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 2_000_000_000_000,
        accountId: "account-1",
      });
      const credentialsPath = path.join(directory, "oauth", "credentials.json");
      const validCredentialStore = await fs.readFile(credentialsPath, "utf8");
      const target: SavedProfile = {
        ...directProfile,
        id: subscriptionProfile.id,
        name: "Converted Direct Profile",
      };
      const backend: OAuthSubscriptionBackend = {
        kind: "oauth-subscription",
        async listModels() { return []; },
        async createToolTurn() { return { content: null, toolCalls: [] }; },
        async readAuthState() { return { status: "signed-out" }; },
        async beginLogin() { throw new Error("unused"); },
        async logout() { return { status: "signed-out" }; },
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
        presentation: liveContextPresentationFixture("Lead"),
        summary: "Track: Lead",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Lead" },
      };
      interaction.selectionContext = { refresh: () => interaction };
      const corruptCredentialsAfter = async <T>(mutation: Promise<T>): Promise<T> => {
        const result = await mutation;
        await fs.writeFile(credentialsPath, "{invalid", "utf8");
        return result;
      };

      await runAgentFlow({
        application: { song: { handle: { id: 1n } } },
        environment: { storageDirectory: directory },
        ui: {
          showModalDialog: async (url: string) => {
            const response = await command(
              url,
              operation === "save"
                ? {
                    kind: "save_profile",
                    profile: target,
                    expectedProfileRevision:
                      savedProfileRevision(subscriptionProfile),
                  }
                : {
                    kind: "delete_profile",
                    profileId: subscriptionProfile.id,
                  },
            );
            assert.equal(response.status, 500);
            const body = await response.json() as {
              error?: string;
              commandOutcome?: string;
              reconciliationRequired?: boolean;
              state?: ChatDialogState;
            };
            assert.equal(body.commandOutcome, "unknown");
            assert.equal(body.reconciliationRequired, true);
            assert.equal(body.state, undefined);
            assert.match(
              String(body.error),
              operation === "save"
                ? /Profile was saved.*Restart Live Smith/i
                : /Profile was deleted.*Restart Live Smith/i,
            );

            const committed = await loadAgentSettings(directory);
            const committedProfile = committed.profiles.find(
              (profile) => profile.id === subscriptionProfile.id,
            );
            assert.equal(
              committedProfile?.connection.kind,
              operation === "save" ? "direct-api" : undefined,
            );

            await fs.writeFile(credentialsPath, validCredentialStore, "utf8");
            const reconciled = await getState(url);
            assert.equal(
              reconciled.settings.profiles.find(
                (profile) => profile.id === subscriptionProfile.id,
              )?.connection.kind,
              operation === "save" ? "direct-api" : undefined,
            );
            assert.equal(
              await loadOAuthCredential(
                directory,
                subscriptionProfile.id,
                "openai",
              ),
              undefined,
            );
          },
        },
      } as never, interaction, {
        renderHtml: () => "<html></html>",
        modelBackendManager: manager,
        ...(operation === "save"
          ? {
              saveSavedProfile: (
                storageDirectory: string | undefined,
                profile: SavedProfile,
                options: Parameters<typeof saveSavedProfile>[2],
              ) => corruptCredentialsAfter(
                saveSavedProfile(storageDirectory, profile, options),
              ),
            }
          : {
              deleteSavedProfile: (
                storageDirectory: string | undefined,
                profileId: string,
              ) => corruptCredentialsAfter(
                deleteSavedProfile(storageDirectory, profileId),
              ),
            }),
      });
    });
  }
});

test("inactive OAuth Profile mutations wait for legacy credential preparation", async (t) => {
  for (const operation of ["save", "delete"] as const) {
    await t.test(operation, { timeout: 5_000 }, async (t) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `live-smith-inactive-v1-${operation}-`),
      );
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      await saveSavedProfile(directory, subscriptionProfile);
      await saveSavedProfile(directory, directProfile);
      const credentialsPath = path.join(directory, "oauth", "credentials.json");
      await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          schemaVersion: 1,
          credentials: {
            openai: {
              provider: "openai",
              accessToken: "legacy-openai-access",
              refreshToken: "legacy-openai-refresh",
              expiresAt: 2_000_000_000_000,
              accountId: "legacy-account",
              unexpected: true,
            },
          },
        }),
        "utf8",
      );
      const converted: SavedProfile = {
        ...directProfile,
        id: subscriptionProfile.id,
        name: "Converted inactive Profile",
      };
      const interaction: LiveInteractionContext = {
        presentation: liveContextPresentationFixture("Lead"),
        summary: "Track: Lead",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Lead" },
      };
      interaction.selectionContext = { refresh: () => interaction };
      const backend: OAuthSubscriptionBackend = {
        kind: "oauth-subscription",
        async listModels() { return []; },
        async createToolTurn() { return { content: null, toolCalls: [] }; },
        async readAuthState() { return { status: "signed-out" }; },
        async beginLogin() { throw new Error("unused"); },
        async logout() { return { status: "signed-out" }; },
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
      let mutationWrites = 0;
      const mutation = operation === "save"
        ? {
            kind: "save_profile",
            profile: converted,
            expectedProfileRevision: savedProfileRevision(subscriptionProfile),
          }
        : {
            kind: "delete_profile",
            profileId: subscriptionProfile.id,
          };

      await runAgentFlow({
        application: { song: { handle: { id: 1n } } },
        environment: { storageDirectory: directory },
        ui: {
          showModalDialog: async (url: string) => {
            await assert.rejects(
              prepareOAuthCredentialStoreForSavedProfiles(directory),
              /OAuth credential store is invalid/i,
            );
            const rejected = await command(url, mutation);
            assert.equal(rejected.status, 500);
            assert.match(
              String((await rejected.json() as { error?: string }).error),
              /OAuth credential store is invalid/i,
            );
            assert.equal(mutationWrites, 0);
            const unchanged = await loadAgentSettings(directory);
            assert.equal(unchanged.activeProfileId, directProfile.id);
            assert.equal(
              unchanged.profiles.find(
                (profile) => profile.id === subscriptionProfile.id,
              )?.connection.kind,
              "oauth-subscription",
            );

            await fs.writeFile(
              credentialsPath,
              JSON.stringify({
                schemaVersion: 1,
                credentials: {
                  openai: {
                    provider: "openai",
                    accessToken: "legacy-openai-access",
                    refreshToken: "legacy-openai-refresh",
                    expiresAt: 2_000_000_000_000,
                    accountId: "legacy-account",
                  },
                },
              }),
              "utf8",
            );
            const retried = await command(url, mutation);
            assert.equal(retried.status, 200, await retried.clone().text());
            assert.equal(mutationWrites, 1);
            const committed = await loadAgentSettings(directory);
            assert.equal(
              committed.profiles.find(
                (profile) => profile.id === subscriptionProfile.id,
              )?.connection.kind,
              operation === "save" ? "direct-api" : undefined,
            );
            await assert.rejects(
              fs.readFile(credentialsPath, "utf8"),
              (error: unknown) =>
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT",
            );
          },
        },
      } as never, interaction, {
        renderHtml: () => "<html></html>",
        modelBackendManager: manager,
        ...(operation === "save"
          ? {
              saveSavedProfile: async (
                storageDirectory: string | undefined,
                profile: SavedProfile,
                options: Parameters<typeof saveSavedProfile>[2],
              ) => {
                mutationWrites += 1;
                return saveSavedProfile(storageDirectory, profile, options);
              },
            }
          : {
              deleteSavedProfile: async (
                storageDirectory: string | undefined,
                profileId: string,
              ) => {
                mutationWrites += 1;
                return deleteSavedProfile(storageDirectory, profileId);
              },
            }),
      });
    });
  }
});

test("provisional OAuth credentials reconcile to authoritative saved Profiles", async (t) => {
  for (const ownership of ["unsaved", "foreign-provider"] as const) {
    for (const exit of ["discard-command", "modal-close"] as const) {
      await t.test(`${ownership} ${exit}`, { timeout: 5_000 }, async (t) => {
        const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), `live-smith-provisional-${ownership}-${exit}-`),
        );
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const provisionalProfileId = ownership === "unsaved"
          ? "unsaved-google-draft"
          : subscriptionProfile.id;
        if (ownership === "unsaved") {
          await saveSavedProfile(directory, directProfile);
        } else {
          await saveSavedProfile(directory, subscriptionProfile);
          await saveOAuthCredential(directory, subscriptionProfile.id, {
            provider: "openai",
            accessToken: "saved-openai-access",
            refreshToken: "saved-openai-refresh",
            expiresAt: 2_000_000_000_000,
            accountId: "saved-account",
          });
        }
        const backendFor = (
          profileId: string,
          provider: OAuthSubscriptionProvider,
        ): OAuthSubscriptionBackend => {
          const completeAuth = async (): Promise<OAuthAuthState> => {
            if (provider === "google") {
              await saveOAuthCredential(directory, profileId, {
                provider: "google",
                accessToken: "provisional-google-access",
                refreshToken: "provisional-google-refresh",
                expiresAt: 2_000_000_000_000,
                projectId: "provisional-project",
                accountLabel: "draft@example.test",
              });
            }
            return {
              status: "signed-in",
              accountLabel: provider === "google"
                ? "draft@example.test"
                : "saved@example.test",
              planType: "pro",
              subscriptionEligible: true,
            };
          };
          return {
          kind: "oauth-subscription",
          async listModels() { return []; },
          async createToolTurn() { return { content: null, toolCalls: [] }; },
          readAuthState: completeAuth,
          beginLogin: completeAuth,
          async logout() { return { status: "signed-out" }; },
          async close() {},
          };
        };
        const backends = new Map<string, OAuthSubscriptionBackend>();
        const manager = {
          async oauth(
            profileId: string,
            provider: OAuthSubscriptionProvider,
          ) {
            const key = `${profileId}:${provider}`;
            let backend = backends.get(key);
            if (!backend) {
              backend = backendFor(profileId, provider);
              backends.set(key, backend);
            }
            return backend;
          },
          async oauthLease(
            profileId: string,
            provider: OAuthSubscriptionProvider,
          ) {
            return {
              backend: await this.oauth(profileId, provider),
              async retire() { return true; },
            };
          },
          async forProfile(profile: DraftProfile | SavedProfile) {
            assert.equal(profile.connection.kind, "oauth-subscription");
            return this.oauth(profile.id, profile.connection.provider);
          },
          async invalidateOAuth() {},
          async close() {},
        };
        const interaction: LiveInteractionContext = {
          presentation: liveContextPresentationFixture("Lead"),
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
              const completed = await command(url, {
                kind: "start_oauth_login",
                profileId: provisionalProfileId,
                provider: "google",
              });
              assert.equal(completed.status, 200, await completed.clone().text());
              assert.ok(
                await loadOAuthCredential(
                  directory,
                  provisionalProfileId,
                  "google",
                ),
              );
              if (exit === "discard-command") {
                const discarded = await command(url, {
                  kind: "discard_profile_oauth",
                  profileId: provisionalProfileId,
                });
                assert.equal(
                  discarded.status,
                  200,
                  await discarded.clone().text(),
                );
              }
            },
          },
        } as never, interaction, {
          renderHtml: () => "<html></html>",
          modelBackendManager: manager,
        });

        assert.equal(
          await loadOAuthCredential(directory, provisionalProfileId, "google"),
          undefined,
        );
        if (ownership === "foreign-provider") {
          assert.equal(
            (await loadOAuthCredential(
              directory,
              subscriptionProfile.id,
              "openai",
            ))?.accessToken,
            "saved-openai-access",
          );
        }
      });
    }
  }
});

test("Direct-only OAuth discard bypasses backend and credential storage", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-only-oauth-discard-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const credentialsPath = path.join(directory, "oauth", "credentials.json");
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, "{invalid", "utf8");
  let backendCalls = 0;
  const manager = {
    async oauth() { backendCalls += 1; throw new Error("unused"); },
    async oauthLease() { backendCalls += 1; throw new Error("unused"); },
    async forProfile() { backendCalls += 1; throw new Error("unused"); },
    async invalidateOAuth() { backendCalls += 1; },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
        const response = await command(url, {
          kind: "discard_profile_oauth",
          profileId: directProfile.id,
        });
        assert.equal(response.status, 200, await response.clone().text());
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });

  assert.equal(backendCalls, 0);
  assert.equal(await fs.readFile(credentialsPath, "utf8"), "{invalid");
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
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return backend;
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return { backend, async retire() { return true; } };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.id, subscriptionProfile.id);
      return backend;
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      assertOAuthScope(profileId, provider);
    },
    async close() {},
  };
  const ownerUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeOwner = deferred<void>();
  const closePeer = deferred<void>();
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
      profileId: subscriptionProfile.id,
      provider: "openai",
    });
    assert.equal(firstPending.status, 200);
    const firstPendingGeneration = modelAuthSendFenceForStorage(
      storageKey,
      subscriptionProfile.id,
    ).authGeneration("openai");
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
      modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
        .authGeneration("openai"),
      firstPendingGeneration + 1,
    );

    auth = { status: "signed-out" };
    const secondPending = await command(ownerDialogUrl, {
      kind: "start_oauth_login",
      profileId: subscriptionProfile.id,
      provider: "openai",
    });
    assert.equal(secondPending.status, 200);
    const secondPendingGeneration = modelAuthSendFenceForStorage(
      storageKey,
      subscriptionProfile.id,
    ).authGeneration("openai");
    auth = signedIn();

    const peerCheck = await command(peerDialogUrl, {
      kind: "refresh_oauth_account",
      profileId: subscriptionProfile.id,
      provider: "openai",
    });
    assert.equal(peerCheck.status, 200, await peerCheck.clone().text());
    const peerAfterCheck = await peerCheck.json() as ChatDialogState;
    assert.equal(peerAfterCheck.oauthAuth?.status, "signed-in");
    assert.equal(
      modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
        .authGeneration("openai"),
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
      profileId: subscriptionProfile.id,
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
      profileId: subscriptionProfile.id,
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
      profileId: subscriptionProfile.id,
      provider: "openai",
    });
    const secondConcurrentCheck = command(peerDialogUrl, {
      kind: "refresh_oauth_account",
      profileId: subscriptionProfile.id,
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
      profileId: subscriptionProfile.id,
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
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return backend;
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return { backend, async retire() { return true; } };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.id, subscriptionProfile.id);
      return backend;
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      assertOAuthScope(profileId, provider);
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
    presentation: liveContextPresentationFixture("Lead"),
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
        profileId: subscriptionProfile.id,
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
        profileId: subscriptionProfile.id,
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

test("modal close retires every Profile auth scope before reporting one cleanup failure", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-provider-auth-ownership-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const storageKey = await canonicalStorageDirectory(directory);
  const googleProfileId = "google-subscription-draft";
  const scopeKey = (
    profileId: string,
    provider: OAuthSubscriptionProvider,
  ): string => `${profileId}:${provider}`;
  const auth = new Map<string, OAuthAuthState>([
    [scopeKey(subscriptionProfile.id, "openai"), { status: "signed-out" }],
    [scopeKey(googleProfileId, "google"), { status: "signed-out" }],
  ]);
  const backends = new Map<string, OAuthSubscriptionBackend>();
  const backendFor = (
    profileId: string,
    provider: OAuthSubscriptionProvider,
  ): OAuthSubscriptionBackend => {
    const key = scopeKey(profileId, provider);
    let backend = backends.get(key);
    if (backend) return backend;
    backend = {
      kind: "oauth-subscription",
      async listModels() { return []; },
      async createToolTurn() { return { content: null, toolCalls: [] }; },
      async readAuthState() { return auth.get(key)!; },
      async beginLogin() {
        const pending: OAuthAuthState = {
          status: "pending",
          verificationUrl: provider === "openai"
            ? "https://auth.openai.com/codex/device"
            : "https://accounts.google.com/o/oauth2/v2/auth",
        };
        auth.set(key, pending);
        return pending;
      },
      async logout() {
        const signedOut: OAuthAuthState = { status: "signed-out" };
        auth.set(key, signedOut);
        return signedOut;
      },
      async close() {},
    };
    backends.set(key, backend);
    return backend;
  };
  const invalidated: string[] = [];
  const manager = {
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      return backendFor(profileId, provider);
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      return {
        backend: backendFor(profileId, provider),
        async retire() { return true; },
      };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.connection.kind, "oauth-subscription");
      return backendFor(profile.id, profile.connection.provider);
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      invalidated.push(scopeKey(profileId, provider));
      if (profileId === subscriptionProfile.id && provider === "openai") {
        throw new Error("OpenAI retirement failed");
      }
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
            profileId: subscriptionProfile.id,
            provider: "openai",
          });
          assert.equal(openAIPending.status, 200, await openAIPending.clone().text());

          const googleCheck = await command(url, {
            kind: "refresh_oauth_account",
            profileId: googleProfileId,
            provider: "google",
          });
          assert.equal(googleCheck.status, 200, await googleCheck.clone().text());
          const googleState = await googleCheck.json() as ChatDialogState;
          assert.equal(googleState.oauthAuthProvider, "google");
          assert.equal(googleState.oauthAuthProfileId, googleProfileId);
          assert.equal(googleState.oauthAuth?.status, "signed-out");
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
              .hasPendingLogin(),
            true,
          );
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, googleProfileId)
              .hasPendingLogin(),
            false,
          );

          const googlePending = await command(url, {
            kind: "start_oauth_login",
            profileId: googleProfileId,
            provider: "google",
          });
          assert.equal(googlePending.status, 200, await googlePending.clone().text());
          assert.equal(
            modelAuthSendFenceForStorage(storageKey, googleProfileId)
              .hasPendingLogin(),
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

  assert.deepEqual([...invalidated].sort(), [
    scopeKey(googleProfileId, "anthropic"),
    scopeKey(googleProfileId, "google"),
    scopeKey(googleProfileId, "openai"),
    scopeKey(subscriptionProfile.id, "openai"),
  ].sort());
  assert.throws(
    () =>
      modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
        .authGeneration("openai"),
    /could not be shut down safely/i,
  );
  assert.equal(
    modelAuthSendFenceForStorage(storageKey, subscriptionProfile.id)
      .hasPendingLogin(),
    false,
  );
  assert.doesNotThrow(
    () => modelAuthSendFenceForStorage(storageKey, googleProfileId)
      .authGeneration("google"),
  );
  assert.equal(
    modelAuthSendFenceForStorage(storageKey, googleProfileId).hasPendingLogin(),
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
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return backend;
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      _signal?: AbortSignal,
    ) {
      assertOAuthScope(profileId, provider);
      return { backend, async retire() { return true; } };
    },
    async forProfile(
      profile: DraftProfile | SavedProfile,
      _signal?: AbortSignal,
    ) {
      assert.equal(profile.id, subscriptionProfile.id);
      return backend;
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      assertOAuthScope(profileId, provider);
    },
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
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
      profileId: subscriptionProfile.id,
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
      profileId: subscriptionProfile.id,
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
