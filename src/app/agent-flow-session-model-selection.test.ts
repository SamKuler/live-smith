import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type { SavedProfile } from "../model/profile.js";
import type {
  OAuthSubscriptionBackend,
  OAuthAuthState,
  RuntimeProfile,
} from "../model/provider.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

let commandSequence = 0;

function commandHeaders(): Record<string, string> {
  commandSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `model-selection-${commandSequence}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve,
  };
}

test("each Session resolves its own configured model and reasoning at send admission", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-model-selection-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "multi-model",
    name: "Multi model",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "gpt-5.4",
    models: [
      {
        model: "gpt-5.4",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
      {
        model: "gpt-5.4-mini",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "enabled", effort: "medium" },
        },
        advanced: {},
      },
    ],
  };
  await saveSavedProfile(directory, profile);

  const requestedRuntimes: RuntimeProfile[] = [];
  let invalidateNextSelection = false;
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
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const command = async (body: unknown): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify(body),
          });
          const responseBody = await response.text();
          assert.equal(response.status, 200, responseBody);
          return JSON.parse(responseBody) as ChatDialogState;
        };

        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        const firstSessionId = initial.activeSessionId;
        assert.deepEqual(
          initial.configuredModels.map((model) => model.model),
          ["gpt-5.4", "gpt-5.4-mini"],
        );
        assert.equal(initial.runtimeProfile?.selection.model, "gpt-5.4");

        const firstSelection = await command({
          kind: "set_session_model_selection",
          sessionId: firstSessionId,
          profileId: profile.id,
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
        });
        assert.equal(
          firstSelection.runtimeProfile?.selection.model,
          "gpt-5.4-mini",
        );
        assert.deepEqual(firstSelection.runtimeProfile?.selection.reasoning, {
          mode: "enabled",
          effort: "high",
        });

        const secondSession = await command({ kind: "new_session" });
        const secondSessionId = secondSession.activeSessionId;
        assert.notEqual(secondSessionId, firstSessionId);
        assert.equal(secondSession.runtimeProfile?.selection.model, "gpt-5.4");
        await command({
          kind: "set_session_model_selection",
          sessionId: secondSessionId,
          profileId: profile.id,
          model: "gpt-5.4",
          reasoningEffort: "low",
        });

        const restoredFirst = await command({
          kind: "select_session",
          sessionId: firstSessionId,
        });
        assert.equal(
          restoredFirst.runtimeProfile?.selection.model,
          "gpt-5.4-mini",
        );
        assert.equal(
          restoredFirst.runtimeProfile?.selection.reasoning.effort,
          "high",
        );

        const send = await fetch(endpoint("/send"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "session-model-send",
          },
          body: JSON.stringify({
            prompt: "Describe this track.",
            sessionId: firstSessionId,
          }),
        });
        assert.equal(send.status, 200, await send.text());

        invalidateNextSelection = true;
        const staleSelection = await fetch(endpoint("/command"), {
          method: "POST",
          headers: commandHeaders(),
          body: JSON.stringify({
            kind: "set_session_model_selection",
            sessionId: firstSessionId,
            profileId: profile.id,
            model: "gpt-5.4",
            reasoningEffort: "high",
          }),
        });
        assert.equal(staleSelection.status, 409, await staleSelection.text());
      },
    },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: {
      async forProfile() {
        return {
          kind: "direct-api" as const,
          async listModels() { return []; },
          async createToolTurn() {
            return { content: "unused", toolCalls: [] };
          },
          async close() {},
        };
      },
      async oauth() { throw new Error("unexpected OAuth backend"); },
      async oauthLease() { throw new Error("unexpected OAuth backend"); },
      async invalidateOAuth() {},
      async close() {},
    },
    requestModelTurn: async (input) => {
      requestedRuntimes.push(input.runtimeProfile);
      return { content: "The track is ready.", toolCalls: [] };
    },
    beforeSessionModelSelectionCommit: async () => {
      if (!invalidateNextSelection) return;
      invalidateNextSelection = false;
      await saveSavedProfile(directory, {
        ...profile,
        models: profile.models.map((model) =>
          model.model === "gpt-5.4"
            ? {
                ...model,
                advanced: {
                  capabilityOverrides: {
                    reasoning: {
                      supported: false,
                      canDisable: false,
                      efforts: [],
                      budgetTokens: false,
                      strategy: "none",
                    },
                  },
                },
              }
            : model
        ),
      });
    },
  });

  assert.equal(requestedRuntimes.length, 1);
  assert.equal(requestedRuntimes[0]!.model.model, "gpt-5.4-mini");
  assert.deepEqual(requestedRuntimes[0]!.model.parameters.reasoning, {
    mode: "enabled",
    effort: "high",
  });
});

test("subscription model capabilities load explicitly and remain auth-generation scoped", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-model-capabilities-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "subscription-model-capabilities",
    name: "Subscription model capabilities",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "gpt-capable",
    models: [{
      model: "gpt-capable",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
  await saveSavedProfile(directory, profile);

  const auth: OAuthAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  let listModelsCalls = 0;
  let readinessReads = 0;
  let passiveReads = 0;
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() {
      listModelsCalls += 1;
      return [{
        id: "gpt-capable",
        displayName: "GPT Capable",
        capabilities: {
          tools: true,
          streaming: false,
          temperature: "unsupported",
          reasoning: {
            supported: true,
            canDisable: false,
            efforts: ["low", "high"],
            budgetTokens: false,
            strategy: "effort",
          },
          inputs: { image: true, audio: false, pdf: false },
        },
      }];
    },
    async createToolTurn() {
      return { content: null, toolCalls: [] };
    },
    async readAuthState(_signal, options) {
      if (options?.readiness) readinessReads += 1;
      else passiveReads += 1;
      return auth;
    },
    async beginLogin() {
      return auth;
    },
    async logout() {
      return { status: "signed-out" };
    },
    async close() {},
  };
  const modelBackendManager = {
    async forProfile() { return backend; },
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async invalidateOAuth() {},
    async close() {},
  };
  const fence = modelAuthSendFenceForStorage(directory, "openai");
  const peerAuthOwner = Symbol("peer auth generation");
  let authMutationEnteredDuringSelection: boolean | undefined;
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };

  await runAgentFlow({
    application: { song: { handle: { id: 2n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        assert.ok(token);
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const state = async (): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/state"));
          assert.equal(response.status, 200);
          return response.json() as Promise<ChatDialogState>;
        };
        const postCommand = async (body: unknown): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify(body),
          });
          const responseBody = await response.text();
          assert.equal(response.status, 200, responseBody);
          return JSON.parse(responseBody) as ChatDialogState;
        };
        const load = async (): Promise<ChatDialogState> =>
          postCommand({
            kind: "load_session_model_capabilities",
            sessionId: (await state()).activeSessionId,
            profileId: profile.id,
          });

        const initial = await state();
        assert.equal(initial.configuredModelsReady, false);
        assert.equal(listModelsCalls, 0);
        assert.equal(readinessReads, 0);

        const first = await load();
        assert.equal(first.configuredModelsReady, true);
        assert.equal(first.configuredModels[0]?.label, "GPT Capable");
        assert.deepEqual(first.runtimeProfile?.capabilities.reasoning, {
          supported: true,
          canDisable: false,
          efforts: ["low", "high"],
          budgetTokens: false,
          strategy: "effort",
        });
        assert.equal(listModelsCalls, 1);
        assert.equal(readinessReads, 1);

        const selected = await postCommand({
          kind: "set_session_model_selection",
          sessionId: first.activeSessionId,
          profileId: profile.id,
          model: "gpt-capable",
          reasoningEffort: "high",
        });
        assert.equal(
          authMutationEnteredDuringSelection,
          false,
          "subscription Session selection must exclude an auth mutation",
        );
        assert.equal(
          selected.runtimeProfile?.selection.reasoning.effort,
          "high",
        );

        const repeated = await load();
        assert.equal(repeated.configuredModelsReady, true);
        assert.equal(listModelsCalls, 1);
        assert.equal(readinessReads, 1);

        fence.updateAuthState(
          peerAuthOwner,
          "openai",
          "signed-in",
          true,
        );
        const invalidated = await state();
        assert.equal(invalidated.configuredModelsReady, false);
        assert.equal(listModelsCalls, 1);
        assert.equal(readinessReads, 1);

        const refreshed = await load();
        assert.equal(refreshed.configuredModelsReady, true);
        assert.equal(listModelsCalls, 2);
        assert.equal(readinessReads, 2);
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
    modelAuthSendFence: fence,
    beforeSessionModelSelectionCommit: async () => {
      const releaseAuth = await fence.enterAuth(peerAuthOwner, "openai");
      authMutationEnteredDuringSelection = releaseAuth !== null;
      releaseAuth?.();
    },
  });

  assert.ok(passiveReads > 0);
});

test("concurrent catalog loading cannot mark a fallback Session runtime ready", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-catalog-snapshot-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "subscription-catalog-snapshot",
    name: "Subscription catalog snapshot",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "gpt-capable",
    models: [{
      model: "gpt-capable",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
  await saveSavedProfile(directory, profile);

  const auth: OAuthAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels() {
      return [{
        id: "gpt-capable",
        displayName: "GPT Capable",
        capabilities: {
          tools: true,
          streaming: false,
          temperature: "unsupported",
          reasoning: {
            supported: true,
            canDisable: false,
            efforts: ["low", "high"],
            budgetTokens: false,
            strategy: "effort",
          },
        },
      }];
    },
    async createToolTurn() {
      return { content: null, toolCalls: [] };
    },
    async readAuthState() {
      return auth;
    },
    async beginLogin() {
      return auth;
    },
    async logout() {
      return { status: "signed-out" };
    },
    async close() {},
  };
  const modelBackendManager = {
    async forProfile() { return backend; },
    async oauth() { return backend; },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async invalidateOAuth() {},
    async close() {},
  };
  const selectStateReadStarted = deferred<void>();
  const releaseSelectStateRead = deferred<void>();
  let blockNextSessionStateRead = false;
  let blockedSessionStateRead = false;
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };

  await runAgentFlow({
    application: { song: { handle: { id: 3n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        assert.ok(token);
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const state = async (): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/state"));
          assert.equal(response.status, 200);
          return response.json() as Promise<ChatDialogState>;
        };
        const postCommand = async (body: unknown): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify(body),
          });
          const responseBody = await response.text();
          assert.equal(response.status, 200, responseBody);
          return JSON.parse(responseBody) as ChatDialogState;
        };

        const initial = await state();
        const firstSessionId = initial.activeSessionId;
        await postCommand({
          kind: "rename_session",
          sessionId: firstSessionId,
          title: "First Session",
        });
        const created = await postCommand({ kind: "new_session" });
        const secondSessionId = created.activeSessionId;
        assert.notEqual(secondSessionId, firstSessionId);
        await postCommand({ kind: "select_session", sessionId: firstSessionId });

        blockNextSessionStateRead = true;
        const selecting = fetch(endpoint("/command"), {
          method: "POST",
          headers: commandHeaders(),
          body: JSON.stringify({
            kind: "select_session",
            sessionId: secondSessionId,
          }),
        });
        await selectStateReadStarted.promise;

        try {
          const capabilityResponse = await fetch(endpoint("/session-model-capabilities"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify({
              kind: "load_session_model_capabilities",
              sessionId: secondSessionId,
              profileId: profile.id,
            }),
          });
          const capabilityBody = await capabilityResponse.text();
          assert.equal(capabilityResponse.status, 200, capabilityBody);
          const capabilityState = JSON.parse(capabilityBody) as ChatDialogState;
          assert.equal(capabilityState.configuredModelsReady, true);
          assert.equal(
            capabilityState.runtimeProfile?.capabilities.reasoning.supported,
            true,
          );
        } finally {
          releaseSelectStateRead.resolve();
        }
        const selectResponse = await selecting;
        const selectBody = await selectResponse.text();
        assert.equal(selectResponse.status, 200, selectBody);
        const selectedState = JSON.parse(selectBody) as ChatDialogState;
        assert.equal(selectedState.activeSessionId, secondSessionId);
        assert.equal(
          selectedState.runtimeProfile?.capabilities.reasoning.supported,
          false,
          "the select response must retain its pre-catalog runtime snapshot",
        );
        assert.equal(
          selectedState.configuredModelsReady,
          false,
          "a fallback runtime snapshot must not claim that the catalog is ready",
        );

        const current = await state();
        assert.equal(current.configuredModelsReady, true);
        assert.equal(current.runtimeProfile?.capabilities.reasoning.supported, true);
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
    loadSessionEvents: async (storageDirectory, sessionId) => {
      if (blockNextSessionStateRead && !blockedSessionStateRead) {
        blockedSessionStateRead = true;
        selectStateReadStarted.resolve();
        await releaseSelectStateRead.promise;
      }
      return loadSessionEvents(storageDirectory, sessionId);
    },
  });
});
