import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { TextDecoder } from "node:util";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  OAuthSubscriptionBackend,
  OAuthAuthState,
  ModelTurnExecutor,
  TransportRequest,
} from "../model/provider.js";
import type {
  DraftProfile,
  OAuthSubscriptionProvider,
  SavedProfile,
} from "../model/profile.js";
import { acquireSharedModelBackendManager } from "../model/shared-backend-manager.js";
import { createOpenAIResponsesTransport } from "../model/transports/openai-responses.js";
import { waitForPromiseWithSignal } from "../runtime/host.js";
import { NetworkProxyError } from "../runtime/network-proxy-error.js";
import { loadSessionEvents } from "../storage/events.js";
import { loadModelCache, saveModelCache } from "../storage/model-cache.js";
import {
  saveSavedProfile,
  savedProfileRevision,
} from "../storage/settings.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
import {
  loadOAuthCredential,
  saveOAuthCredential,
} from "../storage/oauth-credentials.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import {
  modelAuthSendFenceForStorage,
  type ModelAuthSendFence,
} from "./model-auth-send-fence.js";
import { subscribeGlobalStateInvalidations } from "./session-state-events.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

let bridgeRequestSequence = 0;

function bridgeJsonHeaders(): Record<string, string> {
  bridgeRequestSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `backend-command-${bridgeRequestSequence}`,
    "X-Live-Smith-Send-Id": `backend-send-${bridgeRequestSequence}`,
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
  name: "Direct profile",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
  defaultModel: "test-model",
  models: [{
    model: "test-model",
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  }],
};

function oauthLifecycleDefaults(): Pick<
  OAuthSubscriptionBackend,
  "readAuthState" | "beginLogin" | "logout"
> {
  return {
    async readAuthState() {
      return { status: "signed-out" };
    },
    async beginLogin() {
      return { status: "signed-out" };
    },
    async logout() {
      return { status: "signed-out" };
    },
  };
}

test("agent flow shares one OAuth backend across auth and discovery, then closes it", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-flow-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: OAuthAuthState = { status: "signed-out" };
  let readinessError: Error | undefined;
  let managerOAuthCalls = 0;
  let managerProfileCalls = 0;
  let managerCloseCalls = 0;
  const authReadiness: boolean[] = [];
  const openedUrls: string[] = [];
  const browserLaunchStarted = deferred<string>();
  const releaseBrowserLaunch = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    ...oauthLifecycleDefaults(),
    async listModels(profile: DraftProfile) {
      assert.equal(profile.connection.kind, "oauth-subscription");
      return [{
        id: "gpt-subscription-model",
        displayName: "Subscription model",
        capabilities: {
          tools: true,
          streaming: false,
          temperature: "unsupported",
          inputs: { image: true, audio: false, pdf: false },
        },
      }];
    },
    async createToolTurn(_request: TransportRequest) {
      return { content: "unused", toolCalls: [] };
    },
    async readAuthState(_signal, options) {
      authReadiness.push(options?.readiness === true);
      if (options?.readiness === true && readinessError) throw readinessError;
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
  const modelBackendManager = {
    async oauth() {
      managerOAuthCalls += 1;
      return backend;
    },
    async oauthLease() {
      managerOAuthCalls += 1;
      return { backend, async retire() { return true; } };
    },
    async forProfile(profile: DraftProfile | SavedProfile) {
      managerProfileCalls += 1;
      assert.equal(profile.connection.kind, "oauth-subscription");
      return backend;
    },
    async invalidateOAuth() {},
    async close() {
      managerCloseCalls += 1;
    },
  };

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const command = async (body: unknown) => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: bridgeJsonHeaders(),
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200);
          return response.json() as Promise<ChatDialogState>;
        };

        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.deepEqual(initial.oauthAuth, { status: "signed-out" });

        const pending = await command({
          kind: "start_oauth_login",
          profileId: subscriptionProfile.id,
          provider: "openai",
        });
        assert.ok(pending.oauthAuthGeneration > initial.oauthAuthGeneration);
        assert.deepEqual(pending.oauthAuth, {
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        });
        assert.equal(
          pending.status,
          "Complete ChatGPT sign-in in your browser, then check again. " +
            "If the browser did not open, use the sign-in link below.",
        );
        assert.equal(
          await browserLaunchStarted.promise,
          "https://auth.openai.com/codex/device",
        );
        releaseBrowserLaunch.resolve();

        auth = {
          status: "signed-in",
          accountLabel: "studio@example.test",
          planType: "pro",
          subscriptionEligible: true,
        };
        const signedIn = await command({
          kind: "refresh_oauth_account",
          profileId: subscriptionProfile.id,
          provider: "openai",
        });
        assert.ok(signedIn.oauthAuthGeneration > pending.oauthAuthGeneration);
        assert.deepEqual(signedIn.oauthAuth, auth);

        const discovered = await command({
          kind: "discover_models",
          profile: subscriptionProfile,
        });
        assert.deepEqual(
          discovered.availableModels.map((model) => model.id),
          ["gpt-subscription-model"],
        );

        const saved = await command({
          kind: "save_profile",
          profile: subscriptionProfile,
          expectedProfileRevision: savedProfileRevision(subscriptionProfile),
        });
        assert.deepEqual(
          saved.availableModels.map((model) => model.id),
          ["gpt-subscription-model"],
        );
        assert.equal(saved.runtimeProfile?.capabilities.inputs.image, true);

        const proxyMessage =
          "macOS automatic proxy configuration is not supported; choose Manual proxy instead.";
        readinessError = new NetworkProxyError(proxyMessage);
        const rejectedSend = await fetch(endpoint("/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "system-proxy-auth-send-gate",
          },
          body: JSON.stringify({
            prompt: "Must not persist while the proxy route is unavailable",
            sessionId: saved.activeSessionId,
          }),
        });
        const rejectedBody = await rejectedSend.json() as {
          error?: string;
          promptPersistence?: string;
        };
        assert.equal(rejectedSend.status, 409);
        assert.equal(rejectedBody.error, proxyMessage);
        assert.equal(rejectedBody.promptPersistence, "not_persisted");
        assert.equal(
          (await loadSessionEvents(directory, saved.activeSessionId)).some(
            (event) => event.kind === "user",
          ),
          false,
        );
        readinessError = undefined;

        const signedOut = await command({
          kind: "logout_oauth",
          profileId: subscriptionProfile.id,
          provider: "openai",
        });
        assert.ok(signedOut.oauthAuthGeneration > signedIn.oauthAuthGeneration);
        assert.deepEqual(signedOut.oauthAuth, { status: "signed-out" });
        assert.deepEqual(signedOut.availableModels, []);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
    openOAuthAuthorizationUrl: async (url, signal) => {
      openedUrls.push(url);
      browserLaunchStarted.resolve(url);
      await waitForPromiseWithSignal(releaseBrowserLaunch.promise, signal);
    },
  });

  assert.equal(managerProfileCalls, 1);
  assert.equal(managerOAuthCalls, 6);
  assert.equal(managerCloseCalls, 1);
  assert.deepEqual(authReadiness, [false, true, true, true]);
  assert.deepEqual(openedUrls, ["https://auth.openai.com/codex/device"]);
});

test("browser failure stays retryable and Antigravity code submission notifies peers", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-browser-failure-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "gemini-browser-failure",
    name: "Gemini browser failure",
    connection: { kind: "oauth-subscription", provider: "google" },
    defaultModel: "gemini-test",
    models: [{
      model: "gemini-test",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
  await saveSavedProfile(directory, profile);

  let auth: OAuthAuthState = { status: "signed-out" };
  let browserOpenCalls = 0;
  let peerStateInvalidations = 0;
  const storageKey = await canonicalStorageDirectory(directory);
  t.after(subscribeGlobalStateInvalidations(storageKey, () => {
    peerStateInvalidations += 1;
  }));
  const failFirstBrowserLaunch = deferred<void>();
  const thirdBrowserLaunchStarted = deferred<void>();
  const holdThirdBrowserLaunch = deferred<void>();
  const thirdBrowserLaunchSettled = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async readAuthState() { return auth; },
    async beginLogin() {
      auth = {
        status: "pending",
        verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
        authorizationCodeInput: true,
      };
      return auth;
    },
    async setPendingLoginBrowserLaunchFailed(failed) {
      if (auth.status === "pending") {
        if (failed) auth = { ...auth, browserLaunchFailed: true };
        else {
          const pending = { ...auth };
          delete pending.browserLaunchFailed;
          auth = pending;
        }
      }
      return auth;
    },
    async submitLoginCode(code) {
      assert.equal(code, "4/agent-flow-code");
      if (auth.status !== "pending") throw new Error("login is not pending");
      const pending = { ...auth };
      delete pending.authorizationCodeInput;
      delete pending.browserLaunchFailed;
      auth = pending;
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
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const command = (body: unknown) => fetch(bridgeEndpoint(url, "/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify(body),
        });
        const events = await fetch(bridgeEndpoint(url, "/events"));
        const browserFailurePublished = readSsePayload(
          events,
          "oauth_auth_changed",
        );
        const started = await command({
          kind: "start_oauth_login",
          profileId: profile.id,
          provider: "google",
        });
        assert.equal(started.status, 200);
        const startedState = await started.json() as ChatDialogState;
        assert.equal(startedState.oauthAuth?.status, "pending");
        assert.equal(startedState.oauthAuth.browserLaunchFailed, undefined);

        failFirstBrowserLaunch.resolve(undefined);
        const browserFailure = await browserFailurePublished;
        assert.deepEqual(
          {
            ...browserFailure,
            bridgeStateRevision: "",
          },
          {
            type: "oauth_auth_changed",
            profileId: profile.id,
            provider: "google",
            oauthAuthGeneration: startedState.oauthAuthGeneration,
            oauthAuth: {
              status: "pending",
              verificationUrl:
                "https://accounts.google.com/o/oauth2/v2/auth?state=test",
              authorizationCodeInput: true,
              browserLaunchFailed: true,
            },
            bridgeStateRevision: "",
          },
        );
        const stateResponse = await fetch(bridgeEndpoint(url, "/state"));
        assert.equal(stateResponse.status, 200);
        const state = await stateResponse.json() as ChatDialogState;
        assert.deepEqual(state.oauthAuth, {
          status: "pending",
          verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
          authorizationCodeInput: true,
          browserLaunchFailed: true,
        });
        await events.body?.cancel();

        const invalidationsBeforeRetry = peerStateInvalidations;
        const fallback = await command({
          kind: "open_oauth_authorization",
          profileId: profile.id,
          provider: "google",
        });
        assert.equal(fallback.status, 200);
        assert.equal(peerStateInvalidations, invalidationsBeforeRetry + 1);
        const retried = await fallback.json() as ChatDialogState;
        assert.deepEqual(retried.oauthAuth, {
          status: "pending",
          verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
          authorizationCodeInput: true,
        });

        const invalidationsBeforeSubmit = peerStateInvalidations;
        const submitted = await command({
          kind: "submit_oauth_authorization_code",
          profileId: profile.id,
          provider: "google",
          authorizationCode: "4/agent-flow-code",
        });
        assert.equal(submitted.status, 200);
        assert.equal(peerStateInvalidations, invalidationsBeforeSubmit + 1);
        const submittedState = await submitted.json() as ChatDialogState;
        assert.deepEqual(submittedState.oauthAuth, {
          status: "pending",
          verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
        });

        auth = {
          status: "signed-in",
          accountLabel: "listener@example.test",
          planType: "Google Antigravity",
          subscriptionEligible: true,
        };
        const completedOpen = await command({
          kind: "open_oauth_authorization",
          profileId: profile.id,
          provider: "google",
        });
        assert.equal(completedOpen.status, 200);
        assert.equal(
          ((await completedOpen.json()) as ChatDialogState).oauthAuth?.status,
          "signed-in",
        );

        const loggedOut = await command({
          kind: "logout_oauth",
          profileId: profile.id,
          provider: "google",
        });
        assert.equal(loggedOut.status, 200);
        const restarted = await command({
          kind: "start_oauth_login",
          profileId: profile.id,
          provider: "google",
        });
        assert.equal(restarted.status, 200);
        await thirdBrowserLaunchStarted.promise;
        const resubmitted = await command({
          kind: "submit_oauth_authorization_code",
          profileId: profile.id,
          provider: "google",
          authorizationCode: "4/agent-flow-code",
        });
        assert.equal(resubmitted.status, 200);
        await thirdBrowserLaunchSettled.promise;
        const afterLateLaunch = await fetch(bridgeEndpoint(url, "/state"));
        assert.equal(afterLateLaunch.status, 200);
        assert.deepEqual(
          ((await afterLateLaunch.json()) as ChatDialogState).oauthAuth,
          {
            status: "pending",
            verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
          },
        );
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    openOAuthAuthorizationUrl: async (_url, signal) => {
      browserOpenCalls += 1;
      if (browserOpenCalls === 1) {
        await failFirstBrowserLaunch.promise;
        throw new Error("host opener failed with private URL details");
      }
      if (browserOpenCalls === 3) {
        thirdBrowserLaunchStarted.resolve(undefined);
        try {
          await waitForPromiseWithSignal(holdThirdBrowserLaunch.promise, signal);
        } finally {
          thirdBrowserLaunchSettled.resolve(undefined);
        }
      }
    },
  });
  assert.equal(browserOpenCalls, 3);
});

test("a Direct API send does not enter the OAuth account fence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-auth-boundary-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  await fs.mkdir(path.join(directory, "oauth"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "oauth", "credentials.json"),
    "not valid JSON",
  );

  let enterReadCalls = 0;
  let enterOAuthUseCalls = 0;
  let authGenerationCalls = 0;
  const authFence: ModelAuthSendFence = {
    async enterRead() {
      enterReadCalls += 1;
      return () => undefined;
    },
    async enterOAuthUse() {
      enterOAuthUseCalls += 1;
      return null;
    },
    async enterAuth() {
      return null;
    },
    async enterPendingOwnerCleanup() {
      return null;
    },
    hasPendingLogin() {
      return true;
    },
    pendingLoginProvider() {
      return "openai";
    },
    hasAuthActivity() {
      return true;
    },
    async reconcilePendingAuthState() {
      return undefined;
    },
    updateAuthState() {},
    peekAuthGeneration() {
      return 0;
    },
    authGeneration() {
      authGenerationCalls += 1;
      return 0;
    },
    poison() {},
    releaseOwner() {},
  };
  const directBackend = {
    kind: "direct-api" as const,
    async listModels() {
      return [];
    },
    async createToolTurn() {
      throw new Error("The injected model requester owns this test turn.");
    },
    async close() {},
  };
  const manager = {
    async forProfile() {
      return directBackend;
    },
    async oauth() {
      throw new Error("Direct API send must not start OAuth.");
    },
    async oauthLease() {
      throw new Error("Direct API send must not lease OAuth.");
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
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initial = await (
          await fetch(bridgeEndpoint(url, "/state"))
        ).json() as ChatDialogState;
        const response = await fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "direct-send-with-pending-chatgpt-login",
          },
          body: JSON.stringify({
            prompt: "Answer without using the OAuth backend",
            sessionId: initial.activeSessionId,
          }),
        });
        assert.equal(response.status, 200, await response.text());
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    modelAuthSendFence: authFence,
    requestModelTurn: async () => ({ content: "Done", toolCalls: [] }),
  });

  assert.equal(enterReadCalls, 0);
  assert.equal(enterOAuthUseCalls, 0);
  assert.equal(authGenerationCalls, 0);
});

test("Profile Save and Delete retire only OAuth state owned by that Profile", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-profile-oauth-lifecycle-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const invalidations: Array<{
    profileId: string;
    provider: OAuthSubscriptionProvider;
  }> = [];
  const manager = {
    async forProfile() { throw new Error("unused"); },
    async oauth() { throw new Error("unused"); },
    async oauthLease() { throw new Error("unused"); },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      invalidations.push({ profileId, provider });
    },
    async close() {},
  };
  const storageKey = await canonicalStorageDirectory(directory);
  const fence = modelAuthSendFenceForStorage(storageKey, directProfile.id);
  const peerOwner = Symbol("unsaved OAuth Draft owner");
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
        const chatUrl = new URL(url);
        const commandUrl = `${chatUrl.origin}/command?token=${chatUrl.searchParams.get("token")}`;
        const runCommand = async (body: unknown) => {
          const response = await fetch(commandUrl, {
            method: "POST",
            headers: bridgeJsonHeaders(),
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200, await response.clone().text());
          return response.json() as Promise<ChatDialogState>;
        };

        await fetch(`${chatUrl.origin}/state?token=${chatUrl.searchParams.get("token")}`);
        await saveOAuthCredential(directory, directProfile.id, {
          provider: "google",
          accessToken: "google-access",
          refreshToken: "google-refresh",
          expiresAt: 2_000_000_000_000,
          projectId: "project-1",
          accountLabel: "listener@example.test",
        });
        const releaseForeignLogin = await fence.enterAuth(peerOwner, "google");
        assert.ok(releaseForeignLogin);

        const renamed = { ...directProfile, name: "Renamed Direct Profile" };
        let saveSettled = false;
        const save = runCommand({
          kind: "save_profile",
          profile: renamed,
          expectedProfileRevision: savedProfileRevision(directProfile),
        }).finally(() => {
          saveSettled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(saveSettled, false);
        fence.updateAuthState(peerOwner, "google", "signed-in", true);
        releaseForeignLogin();
        await save;
        assert.equal(
          await loadOAuthCredential(directory, directProfile.id, "google"),
          undefined,
        );

        await saveOAuthCredential(directory, directProfile.id, {
          provider: "anthropic",
          accessToken: "anthropic-access",
          refreshToken: "anthropic-refresh",
          expiresAt: 2_000_000_000_000,
        });
        fence.updateAuthState(peerOwner, "anthropic", "signed-in", true);
        await runCommand({ kind: "delete_profile", profileId: directProfile.id });
        assert.equal(
          await loadOAuthCredential(directory, directProfile.id, "anthropic"),
          undefined,
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });

  assert.deepEqual(invalidations, ["openai", "anthropic", "google", "openai", "anthropic", "google"].map(
    (provider) => ({
      profileId: directProfile.id,
      provider: provider as OAuthSubscriptionProvider,
    }),
  ));
});

test("a malformed provider catalog preserves the prior Direct API cache", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-invalid-direct-catalog-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const cachedModels = [{
    id: directProfile.defaultModel,
    displayName: "Cached direct model",
    capabilities: { tools: true, streaming: true },
  }];
  await saveModelCache(directory, directProfile, cachedModels);

  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initial = await (
          await fetch(bridgeEndpoint(url, "/state"))
        ).json() as ChatDialogState;
        assert.deepEqual(
          initial.availableModels.map((model) => model.id),
          [directProfile.defaultModel],
        );
        assert.equal(initial.modelCatalogLoadReceipt, undefined);

        const response = await fetch(bridgeEndpoint(url, "/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "discover_models",
            profile: directProfile,
          }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const state = await response.json() as ChatDialogState;
        assert.match(
          formatUiMessage(state.status ?? ""),
          /model discovery failed: .*invalid model entry/,
        );
        assert.deepEqual(
          state.availableModels.map((model) => model.id),
          [directProfile.defaultModel],
        );
        assert.equal(state.modelCatalogLoadReceipt, undefined);
      },
    },
  };

  const transport = createOpenAIResponsesTransport({
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "fresh-valid-model" }, {}],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: (profile, signal) => transport.listModels(profile, signal),
  });

  assert.deepEqual(
    await loadModelCache(directory, directProfile),
    cachedModels,
  );
});

test("unsaved Direct discovery cannot evict the saved connection across modal restart", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-draft-cache-isolation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const savedModels = [{
    id: directProfile.defaultModel,
    displayName: "Saved connection model",
    capabilities: { tools: true, streaming: true },
  }];
  await saveModelCache(directory, directProfile, savedModels);
  const draftConnection: DraftProfile = {
    ...directProfile,
    connection: {
      ...directProfile.connection,
      baseUrl: "https://draft.example.test/v1",
      apiKey: "draft-key",
    },
  };
  const draftModels = [{
    id: "draft-only-model",
    displayName: "Draft connection model",
    capabilities: { tools: true, streaming: true },
  }];
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
        const response = await fetch(bridgeEndpoint(url, "/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "discover_models",
            profile: draftConnection,
          }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const discovered = await response.json() as ChatDialogState;
        assert.deepEqual(
          discovered.availableModels.map((model) => model.id),
          ["draft-only-model"],
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: async () => draftModels,
  });

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const state = await (
          await fetch(bridgeEndpoint(url, "/state"))
        ).json() as ChatDialogState;
        assert.deepEqual(
          state.availableModels.map((model) => model.id),
          [directProfile.defaultModel],
        );
      },
    },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});

test("Direct API state, discovery, and send survive OAuth poison or concurrent auth", {
  timeout: 5_000,
}, async (t) => {
  for (const mode of ["poisoned", "auth-active"] as const) {
    await t.test(mode, async (t) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `live-smith-direct-${mode}-`),
      );
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      await saveSavedProfile(directory, directProfile);
      const storageKey = await canonicalStorageDirectory(directory);
      const fence = modelAuthSendFenceForStorage(storageKey, "openai");
      let releasePeerAuth: (() => void) | undefined;
      if (mode === "poisoned") {
        fence.poison(new Error("injected OAuth backend shutdown failure"));
      } else {
        releasePeerAuth = await fence.enterAuth(
          Symbol("peer auth owner"),
          "openai",
        ) ??
          undefined;
        assert.ok(releasePeerAuth);
      }

      const interaction: LiveInteractionContext = {
        presentation: liveContextPresentationFixture("Lead"),
        summary: "Track: Lead",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Lead" },
      };
      interaction.selectionContext = { refresh: () => interaction };
      const context = {
        application: { song: { handle: { id: 1n } } },
        environment: { storageDirectory: directory },
        ui: {
          showModalDialog: async (url: string) => {
            const initialResponse = await fetch(bridgeEndpoint(url, "/state"));
            assert.equal(
              initialResponse.status,
              200,
              await initialResponse.clone().text(),
            );
            const initial = await initialResponse.json() as ChatDialogState;

            const discoveryHeaders = bridgeJsonHeaders();
            const discoveryResponse = await fetch(
              bridgeEndpoint(url, "/command"),
              {
                method: "POST",
                headers: discoveryHeaders,
                body: JSON.stringify({
                  kind: "discover_models",
                  profile: directProfile,
                }),
              },
            );
            assert.equal(
              discoveryResponse.status,
              200,
              await discoveryResponse.clone().text(),
            );
            const discovered = await discoveryResponse.json() as ChatDialogState;
            assert.deepEqual(
              discovered.availableModels.map((model) => model.id),
              [directProfile.defaultModel],
            );
            assert.equal(
              discovered.modelCatalogLoadReceipt,
              discoveryHeaders["X-Live-Smith-Command-Id"],
            );

            const sendResponse = await fetch(bridgeEndpoint(url, "/send"), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Live-Smith-Send-Id": `direct-${mode}-send`,
              },
              body: JSON.stringify({
                prompt: "Answer through Direct API",
                sessionId: initial.activeSessionId,
              }),
            });
            assert.equal(
              sendResponse.status,
              200,
              await sendResponse.clone().text(),
            );
            const sendBody = await sendResponse.json() as {
              state: ChatDialogState;
            };
            assert.equal(
              sendBody.state.events.some((event) => event.kind === "assistant"),
              true,
            );
          },
        },
      };

      try {
        await runAgentFlow(context as never, interaction, {
          renderHtml: () => "<html></html>",
          listModels: async (profile) => {
            assert.equal(profile.connection.kind, "direct-api");
            return [{
              id: directProfile.defaultModel,
              displayName: "Direct model",
              capabilities: { tools: true, streaming: true },
            }];
          },
          requestModelTurn: async () => ({ content: "Done", toolCalls: [] }),
        });
      } finally {
        releasePeerAuth?.();
      }
    });
  }
});

test("a production Direct flow bypasses a failed shared OAuth backend shutdown", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-shared-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const shutdownError = new Error("OAuth backend shutdown was not confirmed");
  const oauthBackend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    ...oauthLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async close() { throw shutdownError; },
  };
  const poisonedLease = await acquireSharedModelBackendManager(directory, {
    startOAuthBackend: async () => oauthBackend,
  });
  assert.equal(
    await poisonedLease.manager.oauth("poisoned-profile", "openai"),
    oauthBackend,
  );
  await assert.rejects(
    poisonedLease.release(),
    (error: unknown) => error === shutdownError,
  );

  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let modelTurns = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initialResponse = await fetch(bridgeEndpoint(url, "/state"));
        assert.equal(
          initialResponse.status,
          200,
          await initialResponse.clone().text(),
        );
        const initial = await initialResponse.json() as ChatDialogState;

        const discoveryResponse = await fetch(bridgeEndpoint(url, "/command"), {
          method: "POST",
          headers: bridgeJsonHeaders(),
          body: JSON.stringify({
            kind: "discover_models",
            profile: directProfile,
          }),
        });
        assert.equal(
          discoveryResponse.status,
          200,
          await discoveryResponse.clone().text(),
        );

        const sendResponse = await fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "direct-production-poison-send",
          },
          body: JSON.stringify({
            prompt: "Use Direct API after OAuth backend shutdown failure",
            sessionId: initial.activeSessionId,
          }),
        });
        assert.equal(
          sendResponse.status,
          200,
          await sendResponse.clone().text(),
        );
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: async () => [{
      id: directProfile.defaultModel,
      displayName: "Direct model",
      capabilities: { tools: true, streaming: true },
    }],
    requestModelTurn: async () => {
      modelTurns += 1;
      return { content: "Done", toolCalls: [] };
    },
  });

  assert.equal(modelTurns, 1);
  await assert.rejects(
    acquireSharedModelBackendManager(directory),
    (error: unknown) => error === shutdownError,
  );
});

test("closing a modal aborts its first subscription state backend acquisition", {
  timeout: 2_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-startup-close-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const startupStarted = deferred<void>();
  const startupAborted = deferred<void>();
  let managerCloseCalls = 0;
  const manager = {
    async oauth(
      _profileId: string,
      _provider: "openai" | "anthropic" | "google",
      signal?: AbortSignal,
    ): Promise<OAuthSubscriptionBackend> {
      assert.ok(signal, "subscription state acquisition requires its read signal");
      startupStarted.resolve();
      return await new Promise<OAuthSubscriptionBackend>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          startupAborted.resolve();
          reject(signal.reason);
        }, { once: true });
      });
    },
    async oauthLease() { throw new Error("unused"); },
    async forProfile() { throw new Error("unused"); },
    async invalidateOAuth() {},
    async close() { managerCloseCalls += 1; },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let stateRequest: Promise<"response" | "error"> | undefined;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        stateRequest = fetch(bridgeEndpoint(url, "/state")).then(
          () => "response" as const,
          () => "error" as const,
        );
        await startupStarted.promise;
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
  });

  await startupAborted.promise;
  assert.equal(await stateRequest, "error");
  assert.equal(managerCloseCalls, 1);
});

test("closing a modal cancels a state read waiting for a prior shared close", {
  timeout: 2_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-shared-close-read-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const acquisitionWaitingForPriorClose = deferred<void>();
  const releasePriorClose = deferred<void>();
  let stateRequest: Promise<"response" | "error"> | undefined;
  const releaseBlockedWork = () => {
    acquisitionWaitingForPriorClose.resolve();
    releasePriorClose.resolve();
  };
  t.signal.addEventListener("abort", releaseBlockedWork, { once: true });
  t.after(() => {
    t.signal.removeEventListener("abort", releaseBlockedWork);
  });
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        stateRequest = fetch(bridgeEndpoint(url, "/state")).then(
          () => "response" as const,
          () => "error" as const,
        );
        await acquisitionWaitingForPriorClose.promise;
      },
    },
  };
  const flow = runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    acquireSharedModelBackendManager: async (_storage, _options, signal) => {
      const waitingForPriorClose = waitForPromiseWithSignal(
        releasePriorClose.promise,
        signal,
      );
      acquisitionWaitingForPriorClose.resolve();
      await waitingForPriorClose;
      throw new Error("The prior shared close unexpectedly completed.");
    },
  });

  try {
    await flow;
    assert.equal(await stateRequest, "error");
  } finally {
    releasePriorClose.resolve();
    await Promise.allSettled([flow]);
  }
});

test("closing a modal blocks a late pending browser launch", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-late-oauth-browser-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  const dialogUrl = deferred<string>();
  const closeDialog = deferred<void>();
  const loginStarted = deferred<void>();
  const loginAbortObserved = deferred<void>();
  const releaseLateLogin = deferred<void>();
  let browserOpenCalls = 0;
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    ...oauthLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() { return { status: "signed-out" }; },
    async beginLogin(signal) {
      loginStarted.resolve();
      const onAbort = () => loginAbortObserved.resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      await releaseLateLogin.promise;
      return {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
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
    openOAuthAuthorizationUrl: async () => {
      browserOpenCalls += 1;
    },
  });
  let loginRequest: Promise<Response> | undefined;

  try {
    const url = await dialogUrl.promise;
    await fetch(bridgeEndpoint(url, "/state"));
    loginRequest = fetch(bridgeEndpoint(url, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({
        kind: "start_oauth_login",
        profileId: subscriptionProfile.id,
        provider: "openai",
      }),
    });
    await loginStarted.promise;
    closeDialog.resolve();
    await loginAbortObserved.promise;
    releaseLateLogin.resolve();
    await Promise.allSettled([flow, loginRequest]);
    assert.equal(browserOpenCalls, 0);
  } finally {
    closeDialog.resolve();
    releaseLateLogin.resolve();
    await loginRequest?.catch(() => undefined);
    await flow.catch(() => undefined);
  }
});

test("every subscription send refreshes its catalog and rejects a missing model before persistence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-oauth-send-catalog-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let sessionId = "";
  let listCalls = 0;
  let modelCalls = 0;
  let managerProfileCalls = 0;
  let selectedModelAvailable = true;
  let catalogFailure = false;
  const turnExecutors: ModelTurnExecutor[] = [];
  const authReadiness: boolean[] = [];
  const continuationStarted = deferred<void>();
  const releaseContinuation = deferred<void>();
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    ...oauthLifecycleDefaults(),
    async listModels() {
      listCalls += 1;
      assert.equal(
        (await loadSessionEvents(directory, sessionId)).filter(
          (event) => event.kind === "user",
        ).length,
        listCalls === 1 ? 0 : 1,
        "catalog preflight must finish before the prompt is appended",
      );
      if (catalogFailure) {
        throw new Error(
          "openai/responses model discovery failed: ChatGPT Codex HTTP 500: request failed",
        );
      }
      return [{
        id: selectedModelAvailable
          ? subscriptionProfile.defaultModel
          : "other-model",
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn(request) {
      assert.equal(
        request.runtimeProfile.model.model,
        subscriptionProfile.defaultModel,
      );
      throw new Error("the injected turn function owns this test");
    },
    async readAuthState(_signal, options) {
      authReadiness.push(options?.readiness === true);
      return {
        status: "signed-in",
        accountLabel: "studio@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
    },
    async close() {},
  };
  const replacementBackend: OAuthSubscriptionBackend = {
    ...backend,
    async close() {},
  };
  const manager = {
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() {
      managerProfileCalls += 1;
      return replacementBackend;
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
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const initialResponse = await fetch(bridgeEndpoint(url, "/state"));
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json() as ChatDialogState;
        sessionId = initial.activeSessionId;
        assert.deepEqual(initial.availableModels, []);

        let sendSettled = false;
        const sendRequest = fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "catalog-preflight-send",
          },
          body: JSON.stringify({
            prompt: "Use the subscription catalog",
            sessionId,
          }),
        }).then((response) => {
          sendSettled = true;
          return response;
        });
        await continuationStarted.promise;
        assert.equal(sendSettled, false);
        assert.equal(
          (await loadSessionEvents(directory, sessionId)).filter(
            (event) => event.kind === "user",
          ).length,
          1,
          "a waiting continuation must not duplicate or fail the persisted prompt",
        );
        releaseContinuation.resolve();
        const response = await sendRequest;
        assert.equal(response.status, 200, await response.text());

        selectedModelAvailable = false;
        const unavailable = await fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "missing-catalog-model-send",
          },
          body: JSON.stringify({
            prompt: "Do not persist this unavailable-model prompt",
            sessionId,
          }),
        });
        const unavailableBody = await unavailable.json() as {
          error?: string;
          promptPersistence?: string;
        };
        assert.equal(unavailable.status, 409, JSON.stringify(unavailableBody));
        assert.equal(unavailableBody.promptPersistence, "not_persisted");
        assert.match(unavailableBody.error ?? "", /model is not available/i);
        assert.equal(
          (await loadSessionEvents(directory, sessionId)).filter(
            (event) => event.kind === "user",
          ).length,
          1,
        );

        catalogFailure = true;
        const failedCatalog = await fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "failed-catalog-send",
          },
          body: JSON.stringify({
            prompt: "Do not misclassify this catalog failure",
            sessionId,
          }),
        });
        const failedCatalogBody = await failedCatalog.json() as {
          error?: string;
          promptPersistence?: string;
        };
        assert.notEqual(failedCatalog.status, 200);
        assert.equal(failedCatalogBody.promptPersistence, "not_persisted");
        assert.match(failedCatalogBody.error ?? "", /model discovery.*HTTP 500/i);
        assert.doesNotMatch(failedCatalogBody.error ?? "", /sign in|account status/i);
        const afterFailure = await fetch(bridgeEndpoint(url, "/state")).then(
          (stateResponse) => stateResponse.json() as Promise<ChatDialogState>,
        );
        assert.equal(afterFailure.oauthAuth?.status, "signed-in");
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: manager,
    requestModelTurn: async (input) => {
      modelCalls += 1;
      turnExecutors.push(input.turnExecutor);
      if (modelCalls === 1) {
        return {
          content: "Catalog ",
          toolCalls: [],
          continuation: { reason: "output_limit" },
          providerState: { replay: "first-turn" },
        };
      }
      continuationStarted.resolve();
      await releaseContinuation.promise;
      return { content: "ready", toolCalls: [] };
    },
  });
  assert.equal(listCalls, 3);
  assert.equal(modelCalls, 2);
  assert.equal(managerProfileCalls, 1);
  assert.deepEqual(turnExecutors, [backend, replacementBackend]);
  assert.deepEqual(authReadiness, [false, true, true, true]);
});

async function readSsePayload(
  response: Response,
  type: string,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assert.equal(done, false, `SSE ended before ${type}.`);
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as { type?: string };
        if (payload.type === type) return payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function bridgeEndpoint(dialogUrl: string, pathname: string): string {
  const url = new URL(dialogUrl);
  return `${url.origin}${pathname}?token=${url.searchParams.get("token")}`;
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
