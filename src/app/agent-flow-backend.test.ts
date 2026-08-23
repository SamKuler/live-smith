import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  CodexSubscriptionBackend,
  ManagedAuthState,
  ModelTurnExecutor,
  TransportRequest,
} from "../model/provider.js";
import type { DraftProfile, SavedProfile } from "../model/profile.js";
import { ModelBackendManager } from "../model/backend-registry.js";
import { acquireSharedModelBackendManager } from "../model/shared-backend-manager.js";
import { createOpenAIResponsesTransport } from "../model/transports/openai-responses.js";
import { loadSessionEvents } from "../storage/events.js";
import { loadModelCache, saveModelCache } from "../storage/model-cache.js";
import {
  saveSavedProfile,
  savedProfileRevision,
} from "../storage/settings.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
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
    "X-Live-Smith-Command-Id": `backend-command-${bridgeRequestSequence}`,
    "X-Live-Smith-Send-Id": `backend-send-${bridgeRequestSequence}`,
  };
}

const subscriptionProfile: SavedProfile = {
  id: "chatgpt-subscription",
  name: "ChatGPT subscription",
  connection: { kind: "codex-subscription", provider: "openai" },
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

function managedLifecycleDefaults(): Pick<
  CodexSubscriptionBackend,
  "onTerminal" | "reserveToolTurn" | "readAuthState" | "beginLogin" | "logout"
> {
  return {
    onTerminal() {
      return () => undefined;
    },
    reserveToolTurn() {
      return {
        async createToolTurn() {
          return { content: null, toolCalls: [] };
        },
        async release() {},
      };
    },
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

test("agent flow shares one Codex backend across auth and discovery, then closes it", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-flow-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: ManagedAuthState = { status: "signed-out" };
  let managerCodexCalls = 0;
  let managerProfileCalls = 0;
  let managerCloseCalls = 0;
  const authReadiness: boolean[] = [];
  const backend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels(profile: DraftProfile) {
      assert.equal(profile.connection.kind, "codex-subscription");
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
    async codex() {
      managerCodexCalls += 1;
      return backend;
    },
    async codexLease() {
      managerCodexCalls += 1;
      return { backend, async retire() { return true; } };
    },
    async forProfile(profile: DraftProfile | SavedProfile) {
      managerProfileCalls += 1;
      assert.equal(profile.connection.kind, "codex-subscription");
      return backend;
    },
    async invalidateCodex() {},
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
        assert.deepEqual(initial.codexAuth, { status: "signed-out" });

        const pending = await command({ kind: "start_codex_login" });
        assert.deepEqual(pending.codexAuth, {
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        });
        assert.equal(
          pending.status,
          "Complete ChatGPT sign-in in your browser, then check again.",
        );

        auth = {
          status: "signed-in",
          accountLabel: "studio@example.test",
          planType: "pro",
          subscriptionEligible: true,
        };
        const signedIn = await command({ kind: "refresh_codex_account" });
        assert.deepEqual(signedIn.codexAuth, auth);

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

        const signedOut = await command({ kind: "logout_codex" });
        assert.deepEqual(signedOut.codexAuth, { status: "signed-out" });
        assert.deepEqual(signedOut.availableModels, []);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
  });

  assert.equal(managerProfileCalls, 1);
  assert.equal(managerCodexCalls, 5);
  assert.equal(managerCloseCalls, 1);
  assert.deepEqual(authReadiness, [false, true, true]);
});

test("a Direct API send does not enter the managed ChatGPT auth fence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-auth-boundary-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);

  let enterReadCalls = 0;
  let enterManagedUseCalls = 0;
  let authGenerationCalls = 0;
  const authFence: ModelAuthSendFence = {
    async enterRead() {
      enterReadCalls += 1;
      return () => undefined;
    },
    async enterManagedUse() {
      enterManagedUseCalls += 1;
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
    async reconcilePendingAuthState() {
      return undefined;
    },
    updateAuthState() {},
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
    async codex() {
      throw new Error("Direct API send must not start Codex.");
    },
    async codexLease() {
      throw new Error("Direct API send must not lease Codex.");
    },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
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
            prompt: "Answer without using the managed backend",
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
  assert.equal(enterManagedUseCalls, 0);
  assert.equal(authGenerationCalls, 0);
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
          state.status ?? "",
          /model discovery failed: .*invalid model entry/,
        );
        assert.deepEqual(
          state.availableModels.map((model) => model.id),
          [directProfile.defaultModel],
        );
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

test("Direct API state, discovery, and send survive managed poison or concurrent auth", {
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
      const fence = modelAuthSendFenceForStorage(storageKey);
      let releasePeerAuth: (() => void) | undefined;
      if (mode === "poisoned") {
        fence.poison(new Error("injected managed shutdown failure"));
      } else {
        releasePeerAuth = await fence.enterAuth(Symbol("peer auth owner")) ??
          undefined;
        assert.ok(releasePeerAuth);
      }

      const interaction: LiveInteractionContext = {
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

            const discoveryResponse = await fetch(
              bridgeEndpoint(url, "/command"),
              {
                method: "POST",
                headers: bridgeJsonHeaders(),
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

test("a production Direct flow bypasses a failed shared managed shutdown", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-shared-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);
  const storageKey = await canonicalStorageDirectory(directory);
  const fence = modelAuthSendFenceForStorage(storageKey);
  const shutdownError = new Error("managed shutdown was not confirmed");
  const managedBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async close() { throw shutdownError; },
  };
  const poisonedLease = await acquireSharedModelBackendManager(directory, {
    startCodexBackend: async () => managedBackend,
    onPoison: (error) => fence.poison(error),
  });
  assert.equal(await poisonedLease.manager.codex(), managedBackend);
  await assert.rejects(
    poisonedLease.release(),
    (error: unknown) => error === shutdownError,
  );

  const interaction: LiveInteractionContext = {
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
            prompt: "Use Direct API after managed shutdown failure",
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
    acquireSharedModelBackendManager(storageKey),
    (error: unknown) => error === shutdownError,
  );
});

test("production subscription flows lazily share and release one managed lease", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-lazy-managed-lease-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  let backendStarts = 0;
  let backendCloseCalls = 0;
  const managedBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async close() { backendCloseCalls += 1; },
  };
  const seedLease = await acquireSharedModelBackendManager(directory, {
    startCodexBackend: async () => {
      backendStarts += 1;
      return managedBackend;
    },
  });
  t.after(() => seedLease.release().catch(() => undefined));
  const firstUrl = deferred<string>();
  const secondUrl = deferred<string>();
  const closeFirst = deferred<void>();
  const closeSecond = deferred<void>();
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
  const firstFlow = runAgentFlow(
    contextFor(firstUrl, closeFirst) as never,
    interaction,
    { renderHtml: () => "<html></html>" },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondUrl, closeSecond) as never,
    interaction,
    { renderHtml: () => "<html></html>" },
  );

  try {
    const urls = await Promise.all([firstUrl.promise, secondUrl.promise]);
    const states = await Promise.all(urls.map((url) =>
      fetch(bridgeEndpoint(url, "/state"))
    ));
    assert.deepEqual(states.map((response) => response.status), [200, 200]);
    assert.equal(backendStarts, 1);
    assert.equal(backendCloseCalls, 0);
  } finally {
    closeFirst.resolve();
    closeSecond.resolve();
    await Promise.all([firstFlow, secondFlow]);
  }
  assert.equal(backendCloseCalls, 0);
  await seedLease.release();
  assert.equal(backendCloseCalls, 1);
});

test("closing a modal aborts its first subscription state backend acquisition", {
  timeout: 2_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-startup-close-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);
  const startupStarted = deferred<void>();
  const startupAborted = deferred<void>();
  let managerCloseCalls = 0;
  const manager = {
    async codex(signal?: AbortSignal): Promise<CodexSubscriptionBackend> {
      assert.ok(signal, "subscription state acquisition requires its read signal");
      startupStarted.resolve();
      return await new Promise<CodexSubscriptionBackend>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          startupAborted.resolve();
          reject(signal.reason);
        }, { once: true });
      });
    },
    async codexLease() { throw new Error("unused"); },
    async forProfile() { throw new Error("unused"); },
    async invalidateCodex() {},
    async close() { managerCloseCalls += 1; },
  };
  const interaction: LiveInteractionContext = {
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
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  const oldBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async close() {
      closeStarted.resolve();
      await releaseClose.promise;
    },
  };
  const oldLease = await acquireSharedModelBackendManager(directory, {
    startCodexBackend: async () => oldBackend,
  });
  await oldLease.manager.codex();
  const oldClosing = oldLease.release();
  await closeStarted.promise;

  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const stateReadStarted = deferred<void>();
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
        stateReadStarted.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      },
    },
  };
  const flow = runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });

  try {
    await stateReadStarted.promise;
    const closeOutcome = await Promise.race([
      flow.then(() => "closed" as const),
      new Promise<"waiting">((resolve) => {
        setTimeout(() => resolve("waiting"), 100);
      }),
    ]);
    assert.equal(
      closeOutcome,
      "closed",
      "modal close must not wait for another modal's shared backend close",
    );
    assert.equal(await stateRequest, "error");
  } finally {
    releaseClose.resolve();
    await Promise.allSettled([oldClosing, flow]);
  }
});

test("two dialogs exclude ChatGPT auth while either dialog has an active subscription send", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-fence-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const modelStarted = deferred<void>();
  let beginLoginCalls = 0;
  let logoutCalls = 0;
  let authState: ManagedAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const authBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() {
      return [{
        id: subscriptionProfile.defaultModel,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: false },
      }];
    },
    async createToolTurn() {
      return { content: null, toolCalls: [] };
    },
    async readAuthState() {
      return authState;
    },
    async beginLogin() {
      beginLoginCalls += 1;
      authState = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
      return authState;
    },
    async logout() {
      logoutCalls += 1;
      authState = { status: "signed-out" };
      return authState;
    },
    async close() {},
  };
  const inertManager = {
    async codex() {
      return authBackend;
    },
    async codexLease() {
      return { backend: authBackend, async retire() { return true; } };
    },
    async forProfile() {
      return authBackend;
    },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });

  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: inertManager,
      requestModelTurn: async (input) => {
        modelStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(input.signal.reason);
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        });
        throw new Error("unreachable");
      },
    },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: inertManager,
    },
  );

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    const initial = await (
      await fetch(bridgeEndpoint(firstUrl, "/state"))
    ).json() as ChatDialogState;
    const sendId = "cross-dialog-send";
    const sendResponse = fetch(bridgeEndpoint(firstUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: JSON.stringify({
        prompt: "Wait until stopped",
        sessionId: initial.activeSessionId,
      }),
    });
    const sendTerminal = sendResponse.then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    const sendStartOutcome = await Promise.race([
      modelStarted.promise.then(() => null),
      sendTerminal,
    ]);
    assert.equal(
      sendStartOutcome,
      null,
      `send ended before reaching the model: ${JSON.stringify(sendStartOutcome)}`,
    );

    const blockedAuth = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(blockedAuth.status, 409);
    assert.match(
      JSON.stringify(await blockedAuth.json()),
      /Stop every active agent request/i,
    );
    assert.equal(beginLoginCalls, 0);

    const stopped = await fetch(bridgeEndpoint(firstUrl, "/stop"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: "{}",
    });
    assert.equal(stopped.status, 200);
    await sendTerminal;

    const allowedAuth = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(allowedAuth.status, 200);
    assert.equal(beginLoginCalls, 1);

    const otherModalAuth = await fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    assert.equal(otherModalAuth.status, 409);
    assert.equal(beginLoginCalls, 1);

    const sendDuringLogin = await fetch(bridgeEndpoint(firstUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-during-login",
      },
      body: JSON.stringify({
        prompt: "Must remain pending",
        sessionId: initial.activeSessionId,
      }),
    });
    assert.equal(sendDuringLogin.status, 409);
    assert.match(await sendDuringLogin.text(), /sign-in operation/i);

    const logout = await fetch(bridgeEndpoint(secondUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 200);
    assert.equal(logoutCalls, 1);
  } finally {
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("an auth change closes another dialog's cached Codex process before state reuse", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-generation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let sharedSignedIn = true;
  type BackendRecord = {
    closed: boolean;
    createCalls: number;
    readCalls: number;
  };
  const records: { first: BackendRecord[]; second: BackendRecord[] } = {
    first: [],
    second: [],
  };
  const managerFor = (owner: "first" | "second") => new ModelBackendManager(
    directory,
    {
      startCodexBackend: async () => {
        const capturedSignedIn = sharedSignedIn;
        const record = { closed: false, createCalls: 0, readCalls: 0 };
        records[owner].push(record);
        return {
          kind: "codex-subscription" as const,
          ...managedLifecycleDefaults(),
          async listModels() {
            return [];
          },
          async createToolTurn() {
            record.createCalls += 1;
            return { content: null, toolCalls: [] };
          },
          async readAuthState(): Promise<ManagedAuthState> {
            record.readCalls += 1;
              return capturedSignedIn
              ? {
                  status: "signed-in",
                  accountLabel: `${owner}@example.test`,
                  planType: "pro",
                  subscriptionEligible: true,
                }
              : { status: "signed-out" };
          },
          async logout(): Promise<ManagedAuthState> {
            sharedSignedIn = false;
            throw new Error("logout response was lost after the side effect");
          },
          async close() {
            record.closed = true;
          },
        };
      },
    },
  );
  const firstManager = managerFor("first");
  const secondManager = managerFor("second");
  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });
  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: secondManager },
  );

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    const [firstInitial, secondInitial] = await Promise.all([
      fetch(bridgeEndpoint(firstUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(secondUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(firstInitial.codexAuth?.status, "signed-in");
    assert.equal(secondInitial.codexAuth?.status, "signed-in");
    const secondOldBackend = records.second[0]!;

    const logout = await fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 200);
    assert.equal(
      ((await logout.json()) as ChatDialogState).codexAuth?.status,
      "signed-out",
    );
    assert.equal(records.first[0]?.closed, true);
    assert.equal(records.first.length, 2);

    const secondAfterLogout = await (
      await fetch(bridgeEndpoint(secondUrl, "/state"))
    ).json() as ChatDialogState;
    assert.equal(secondOldBackend.closed, true);
    assert.equal(secondOldBackend.createCalls, 0);
    assert.equal(records.second.length, 2);
    assert.equal(records.second[1]?.readCalls, 1);
    assert.equal(secondAfterLogout.codexAuth?.status, "signed-out");
  } finally {
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("closing a modal during initial Codex login retires before peers reuse auth", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-abort-generation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  const loginStarted = deferred<void>();
  const firstCloseStarted = deferred<void>();
  const releaseFirstClose = deferred<void>();
  type BackendRecord = { closed: boolean; readCalls: number };
  const records: { first: BackendRecord[]; second: BackendRecord[] } = {
    first: [],
    second: [],
  };
  const managerFor = (owner: "first" | "second") => new ModelBackendManager(
    directory,
    {
      startCodexBackend: async () => {
        const record = { closed: false, readCalls: 0 };
        const index = records[owner].push(record) - 1;
        return {
          kind: "codex-subscription" as const,
          ...managedLifecycleDefaults(),
          async listModels() {
            return [];
          },
          async createToolTurn() {
            return { content: null, toolCalls: [] };
          },
          async readAuthState(): Promise<ManagedAuthState> {
            record.readCalls += 1;
            return { status: "signed-out" };
          },
          async beginLogin(signal?: AbortSignal): Promise<ManagedAuthState> {
            if (owner !== "first" || index !== 0) {
              return {
                status: "pending",
                verificationUrl: "https://auth.openai.com/codex/device",
                userCode: "ABCD-EFGH",
              };
            }
            loginStarted.resolve();
            await new Promise<never>((_resolve, reject) => {
              const onAbort = () => reject(signal?.reason);
              signal?.addEventListener("abort", onAbort, { once: true });
              if (signal?.aborted) onAbort();
            });
            throw new Error("unreachable login completion");
          },
          async close() {
            record.closed = true;
            if (owner === "first" && index === 0) {
              firstCloseStarted.resolve();
              await releaseFirstClose.promise;
            }
          },
        };
      },
    },
  );
  const firstManager = managerFor("first");
  const secondManager = managerFor("second");
  const firstDialogUrl = deferred<string>();
  const secondDialogUrl = deferred<string>();
  const closeFirstDialog = deferred<void>();
  const closeSecondDialog = deferred<void>();
  const interaction: LiveInteractionContext = {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const contextFor = (
    urlReady: ReturnType<typeof deferred<string>>,
    closeDialog: ReturnType<typeof deferred<void>>,
  ) => ({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        urlReady.resolve(url);
        await closeDialog.promise;
      },
    },
  });
  const firstFlow = runAgentFlow(
    contextFor(firstDialogUrl, closeFirstDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const secondFlow = runAgentFlow(
    contextFor(secondDialogUrl, closeSecondDialog) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: secondManager },
  );
  let loginRequest: Promise<Response> | undefined;

  try {
    const [firstUrl, secondUrl] = await Promise.all([
      firstDialogUrl.promise,
      secondDialogUrl.promise,
    ]);
    await Promise.all([
      fetch(bridgeEndpoint(firstUrl, "/state")),
      fetch(bridgeEndpoint(secondUrl, "/state")),
    ]);
    const secondOldBackend = records.second[0]!;

    loginRequest = fetch(bridgeEndpoint(firstUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "start_codex_login" }),
    });
    await loginStarted.promise;
    closeFirstDialog.resolve();
    await firstCloseStarted.promise;

    let peerStateSettled = false;
    const peerStateRequest = fetch(bridgeEndpoint(secondUrl, "/state"))
      .then(async (response) => {
        peerStateSettled = true;
        assert.equal(response.status, 200);
        return response.json() as Promise<ChatDialogState>;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      peerStateSettled,
      false,
      "peer state must wait until exact backend retirement is confirmed",
    );

    releaseFirstClose.resolve();
    await firstFlow;
    await loginRequest.catch(() => undefined);

    const reconciled = await peerStateRequest;
    assert.equal(reconciled.codexAuth?.status, "signed-out");
    assert.equal(secondOldBackend.closed, true);
    assert.equal(records.second.length, 2);
    assert.equal(records.second[1]?.readCalls, 1);
  } finally {
    releaseFirstClose.resolve();
    closeFirstDialog.resolve();
    closeSecondDialog.resolve();
    await loginRequest?.catch(() => undefined);
    await Promise.allSettled([firstFlow, secondFlow]);
  }
});

test("a failed auth retirement permanently poisons peer auth, state, discovery, and send", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-shutdown-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let ownerManagerCalls = 0;
  let peerManagerCalls = 0;
  let peerModelCalls = 0;
  const signedIn = (): ManagedAuthState => ({
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  });
  const ownerBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() { return { content: null, toolCalls: [] }; },
    async readAuthState() { return signedIn(); },
    async logout() {
      throw new Error("logout outcome is unknown");
    },
    async close() {},
  };
  const peerBackend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() { return []; },
    async createToolTurn() {
      peerModelCalls += 1;
      return { content: "must not run", toolCalls: [] };
    },
    async readAuthState() { return signedIn(); },
    async beginLogin() { return signedIn(); },
    async close() {},
  };
  const ownerManager = {
    async codex() {
      ownerManagerCalls += 1;
      return ownerBackend;
    },
    async codexLease() {
      ownerManagerCalls += 1;
      return {
        backend: ownerBackend,
        async retire() {
          throw new Error("Codex child did not exit after SIGKILL");
        },
      };
    },
    async forProfile() {
      ownerManagerCalls += 1;
      return ownerBackend;
    },
    async invalidateCodex() {
      ownerManagerCalls += 1;
    },
    async close() {},
  };
  const peerManager = {
    async codex() {
      peerManagerCalls += 1;
      return peerBackend;
    },
    async codexLease() {
      peerManagerCalls += 1;
      return { backend: peerBackend, async retire() { return true; } };
    },
    async forProfile() {
      peerManagerCalls += 1;
      return peerBackend;
    },
    async invalidateCodex() {
      peerManagerCalls += 1;
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
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: ownerManager },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: peerManager,
      requestModelTurn: async () => {
        peerModelCalls += 1;
        return { content: "must not run", toolCalls: [] };
      },
    },
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const [ownerInitial, peerInitial] = await Promise.all([
      fetch(bridgeEndpoint(ownerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(peerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(ownerInitial.codexAuth?.status, "signed-in");
    assert.equal(peerInitial.codexAuth?.status, "signed-in");

    const logout = await fetch(bridgeEndpoint(ownerDialogUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    assert.equal(logout.status, 500);
    const peerCallsBeforePoisonChecks = peerManagerCalls;

    const stateResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/state"));
    assert.equal(stateResponse.status, 500);
    const authResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "refresh_codex_account" }),
    });
    assert.equal(authResponse.status, 500);
    const discoveryResponse = await fetch(
      bridgeEndpoint(peerDialogUrl, "/command"),
      {
        method: "POST",
        headers: bridgeJsonHeaders(),
        body: JSON.stringify({
          kind: "discover_models",
          profile: subscriptionProfile,
        }),
      },
    );
    assert.equal(discoveryResponse.status, 500);
    const sendResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "poisoned-peer-send",
      },
      body: JSON.stringify({
        prompt: "Must not be persisted",
        sessionId: peerInitial.activeSessionId,
      }),
    });
    assert.equal(sendResponse.status, 500);
    assert.equal(
      ((await sendResponse.json()) as { promptPersistence?: string })
        .promptPersistence,
      "not_persisted",
    );
    assert.equal(peerManagerCalls, peerCallsBeforePoisonChecks);
    assert.equal(peerModelCalls, 0);
    assert.equal(
      (await loadSessionEvents(directory, peerInitial.activeSessionId)).some(
        (event) => event.kind === "user",
      ),
      false,
    );
  } finally {
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

test("a peer subscription send waits for logout and fails before prompt persistence", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-send-preflight-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let auth: ManagedAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const logoutStarted = deferred<void>();
  const releaseLogout = deferred<void>();
  let peerListCalls = 0;
  let peerModelCalls = 0;
  const backendFor = (owner: "owner" | "peer"): CodexSubscriptionBackend => ({
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() {
      if (owner === "peer") peerListCalls += 1;
      return [{
        id: subscriptionProfile.defaultModel,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() {
      if (owner === "peer") peerModelCalls += 1;
      return { content: "must not run", toolCalls: [] };
    },
    async readAuthState() { return auth; },
    async logout() {
      logoutStarted.resolve();
      await releaseLogout.promise;
      auth = { status: "signed-out" };
      return auth;
    },
    async close() {},
  });
  const managerFor = (owner: "owner" | "peer") => {
    const backend = backendFor(owner);
    return {
      async codex() { return backend; },
      async codexLease() {
        return { backend, async retire() { return true; } };
      },
      async forProfile() { return backend; },
      async invalidateCodex() {},
      async close() {},
    };
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
  const ownerFlow = runAgentFlow(
    contextFor(ownerUrl, closeOwner) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: managerFor("owner"),
    },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: managerFor("peer"),
      requestModelTurn: async () => {
        peerModelCalls += 1;
        return { content: "must not run", toolCalls: [] };
      },
    },
  );

  try {
    const [ownerDialogUrl, peerDialogUrl] = await Promise.all([
      ownerUrl.promise,
      peerUrl.promise,
    ]);
    const [ownerInitial, peerInitial] = await Promise.all([
      fetch(bridgeEndpoint(ownerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
      fetch(bridgeEndpoint(peerDialogUrl, "/state")).then(
        (response) => response.json() as Promise<ChatDialogState>,
      ),
    ]);
    assert.equal(ownerInitial.codexAuth?.status, "signed-in");
    assert.equal(peerInitial.codexAuth?.status, "signed-in");

    const logoutRequest = fetch(bridgeEndpoint(ownerDialogUrl, "/command"), {
      method: "POST",
      headers: bridgeJsonHeaders(),
      body: JSON.stringify({ kind: "logout_codex" }),
    });
    await logoutStarted.promise;
    let sendSettled = false;
    const sendRequest = fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-after-cross-modal-logout",
      },
      body: JSON.stringify({
        prompt: "Must remain queued until auth settles",
        sessionId: peerInitial.activeSessionId,
      }),
    }).then((response) => {
      sendSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(sendSettled, false);

    releaseLogout.resolve();
    assert.equal((await logoutRequest).status, 200);
    const sendResponse = await sendRequest;
    assert.notEqual(sendResponse.status, 200);
    const sendBody = await sendResponse.json() as {
      error?: string;
      promptPersistence?: string;
    };
    assert.equal(sendBody.promptPersistence, "not_persisted");
    assert.match(sendBody.error ?? "", /eligible ChatGPT subscription|sign in/i);
    assert.equal(peerListCalls, 1);
    assert.equal(peerModelCalls, 0);
    assert.equal(
      (await loadSessionEvents(directory, peerInitial.activeSessionId)).some(
        (event) => event.kind === "user",
      ),
      false,
    );
  } finally {
    releaseLogout.resolve();
    closeOwner.resolve();
    closePeer.resolve();
    await Promise.allSettled([ownerFlow, peerFlow]);
  }
});

test("every subscription send refreshes its catalog and rejects a missing model before persistence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-send-catalog-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, subscriptionProfile);

  let sessionId = "";
  let listCalls = 0;
  let modelCalls = 0;
  let managerProfileCalls = 0;
  let selectedModelAvailable = true;
  const turnExecutors: ModelTurnExecutor[] = [];
  const authReadiness: boolean[] = [];
  const continuationStarted = deferred<void>();
  const releaseContinuation = deferred<void>();
  let reservationReleaseCalls = 0;
  const firstTurnReservation = {
    async createToolTurn() {
      throw new Error("the injected turn function owns this test");
    },
    async release() {
      reservationReleaseCalls += 1;
    },
  };
  const backend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() {
      listCalls += 1;
      assert.equal(
        (await loadSessionEvents(directory, sessionId)).filter(
          (event) => event.kind === "user",
        ).length,
        listCalls === 1 ? 0 : 1,
        "catalog preflight must finish before the prompt is appended",
      );
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
    reserveToolTurn() {
      return firstTurnReservation;
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
  const replacementBackend: CodexSubscriptionBackend = {
    ...backend,
    async close() {},
  };
  const manager = {
    async codex() { return backend; },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() {
      managerProfileCalls += 1;
      return replacementBackend;
    },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
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
  assert.equal(listCalls, 2);
  assert.equal(modelCalls, 2);
  assert.equal(managerProfileCalls, 1);
  assert.deepEqual(turnExecutors, [firstTurnReservation, replacementBackend]);
  assert.equal(reservationReleaseCalls, 1);
  assert.deepEqual(authReadiness, [false, false, false]);
});

test("threshold reservation cleanup preserves a pre-first-turn caller abort and poisons reuse", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-reservation-abort-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storageKey = await canonicalStorageDirectory(directory);
  await saveSavedProfile(directory, subscriptionProfile);

  const modelStarted = deferred<void>();
  const releaseError = new Error("threshold recycle close failed");
  let reservationCreateCalls = 0;
  let reservationReleaseCalls = 0;
  const backend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    ...managedLifecycleDefaults(),
    async listModels() {
      return [{
        id: subscriptionProfile.defaultModel,
        displayName: "Subscription model",
        capabilities: { tools: true, streaming: true },
      }];
    },
    async createToolTurn() {
      throw new Error("the reserved first turn must own this request");
    },
    reserveToolTurn() {
      return {
        async createToolTurn() {
          reservationCreateCalls += 1;
          throw new Error("the injected turn must abort before consumption");
        },
        async release() {
          reservationReleaseCalls += 1;
          throw releaseError;
        },
      };
    },
    async readAuthState() {
      return {
        status: "signed-in",
        accountLabel: "studio@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
    },
    async close() {},
  };
  const manager = {
    async codex() { return backend; },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async forProfile() { return backend; },
    async invalidateCodex() {},
    async close() {},
  };
  const interaction: LiveInteractionContext = {
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
        const initial = await fetch(bridgeEndpoint(url, "/state")).then(
          (response) => response.json() as Promise<ChatDialogState>,
        );
        const sendId = "reservation-abort-send";
        const send = fetch(bridgeEndpoint(url, "/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": sendId,
          },
          body: JSON.stringify({
            prompt: "Stop before the reserved turn is consumed",
            sessionId: initial.activeSessionId,
          }),
        });
        await modelStarted.promise;
        const stopped = await fetch(bridgeEndpoint(url, "/stop"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": sendId,
          },
          body: "{}",
        });
        assert.equal(stopped.status, 200);

        const response = await send;
        const body = await response.text();
        assert.notEqual(response.status, 200);
        assert.match(body, /Stopped by user/i);
        assert.doesNotMatch(body, /threshold recycle close failed/i);
      },
    },
  };

  await assert.rejects(
    runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      modelBackendManager: manager,
      requestModelTurn: async (input) => {
        modelStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(input.signal.reason);
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        });
        throw new Error("unreachable");
      },
    }),
    /could not be shut down safely/i,
  );
  await assert.rejects(
    modelAuthSendFenceForStorage(storageKey).enterRead(),
    /could not be shut down safely/i,
  );
  assert.equal(reservationCreateCalls, 0);
  assert.equal(reservationReleaseCalls, 1);
});

test("managed poison from a modal close leaves a Direct API peer operational", {
  timeout: 5_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-codex-modal-close-poison-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, directProfile);

  const firstUrl = deferred<string>();
  const peerUrl = deferred<string>();
  const closeFirst = deferred<void>();
  const closePeer = deferred<void>();
  let peerManagerCalls = 0;
  const peerDirectBackend = {
    kind: "direct-api" as const,
    async listModels() { return []; },
    async createToolTurn() {
      throw new Error("The injected model requester owns this test turn.");
    },
    async close() {},
  };
  const firstManager = {
    async codex() { throw new Error("unused"); },
    async codexLease() { throw new Error("unused"); },
    async forProfile() { throw new Error("unused"); },
    async invalidateCodex() {},
    async close() {
      throw new Error("Codex child shutdown could not be confirmed");
    },
  };
  const peerManager = {
    async codex() {
      peerManagerCalls += 1;
      throw new Error("must not start after poison");
    },
    async codexLease() {
      peerManagerCalls += 1;
      throw new Error("must not start after poison");
    },
    async forProfile(profile: DraftProfile) {
      peerManagerCalls += 1;
      assert.equal(profile.connection.kind, "direct-api");
      return peerDirectBackend;
    },
    async invalidateCodex() {
      peerManagerCalls += 1;
    },
    async close() {},
  };
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
  const firstFlow = runAgentFlow(
    contextFor(firstUrl, closeFirst) as never,
    interaction,
    { renderHtml: () => "<html></html>", modelBackendManager: firstManager },
  );
  const peerFlow = runAgentFlow(
    contextFor(peerUrl, closePeer) as never,
    interaction,
    {
      renderHtml: () => "<html></html>",
      modelBackendManager: peerManager,
      requestModelTurn: async () => ({ content: "Done", toolCalls: [] }),
    },
  );

  try {
    const [, peerDialogUrl] = await Promise.all([
      firstUrl.promise,
      peerUrl.promise,
    ]);
    const initialResponse = await fetch(bridgeEndpoint(peerDialogUrl, "/state"));
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as ChatDialogState;
    closeFirst.resolve();
    await assert.rejects(firstFlow, /shutdown could not be confirmed/i);

    assert.equal((await fetch(bridgeEndpoint(peerDialogUrl, "/state"))).status, 200);
    const send = await fetch(bridgeEndpoint(peerDialogUrl, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-after-modal-close-poison",
      },
      body: JSON.stringify({
        prompt: "Continue through Direct API",
        sessionId: initial.activeSessionId,
      }),
    });
    assert.equal(send.status, 200, await send.clone().text());
    assert.equal(peerManagerCalls, 1);
  } finally {
    closeFirst.resolve();
    closePeer.resolve();
    await Promise.allSettled([firstFlow, peerFlow]);
  }
});

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
