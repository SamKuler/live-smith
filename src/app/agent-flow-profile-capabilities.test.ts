import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type {
  OAuthSubscriptionBackend,
  DiscoveredModelInfo,
  OAuthAuthState,
} from "../model/provider.js";
import {
  isDirectApiProfile,
  type DraftProfile,
  type SavedProfile,
} from "../model/profile.js";
import {
  loadAgentSettings,
  saveSavedProfile,
  savedProfileRevision,
} from "../storage/settings.js";
import { createSession, listSessions } from "../storage/sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";
import { runAgentFlow } from "./agent-flow.js";
import { projectKeyForContext } from "./session-context.js";

const interaction = {
  summary: "Track: Capability Probe",
  target: {},
  scope: {
    kind: "track" as const,
    identity: "track-capability-probe",
    label: "Capability Probe",
  },
};

function commandHeaders(id: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-live-smith-command-id": id,
  };
}

async function command(
  endpoint: (pathname: string) => string,
  id: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(endpoint("/command"), {
    method: "POST",
    headers: commandHeaders(id),
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json() as Record<string, unknown>,
  };
}

function endpointForDialog(url: string): (pathname: string) => string {
  const dialogUrl = new URL(url);
  const token = dialogUrl.searchParams.get("token");
  assert.ok(token);
  return (pathname) => `${dialogUrl.origin}${pathname}?token=${token}`;
}

test("Direct discovery evidence survives Save and a reopened modal", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-direct-capability-save-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "direct-capability-save",
    name: "Direct capability save",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "",
    },
    defaultModel: "model-capable",
    models: [{
      model: "model-capable",
      parameters: {
        maxOutputTokens: 4096,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
  const catalog: DiscoveredModelInfo[] = [{
    id: profile.defaultModel,
    displayName: "Capable model",
    capabilities: {
      temperature: "unsupported",
      maxOutputTokens: 32_000,
      contextWindowTokens: 200_000,
      reasoning: { supported: false },
      inputs: { image: true, audio: false, pdf: true },
    },
  }];

  let savedState: ChatDialogState | undefined;
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = endpointForDialog(url);
        const discovered = await command(endpoint, "direct-discover", {
          kind: "discover_models",
          profile: {
            ...profile,
            defaultModel: "",
            models: profile.models.map((model) => ({ ...model, model: "" })),
          },
        });
        assert.equal(discovered.response.status, 200);
        const saved = await command(endpoint, "direct-save", {
          kind: "save_profile",
          profile,
          expectedProfileRevision: null,
        });
        assert.equal(saved.response.status, 200);
        savedState = saved.body as unknown as ChatDialogState;

        const currentProfile = (await loadAgentSettings(directory)).profiles[0]!;
        if (!isDirectApiProfile(currentProfile)) {
          throw new Error("Expected the saved Direct API Profile.");
        }
        await saveSavedProfile(directory, {
          ...currentProfile,
          models: [
            ...currentProfile.models,
            {
              model: "model-added-elsewhere",
              parameters: {
                maxOutputTokens: 4096,
                reasoning: { mode: "default" },
              },
              advanced: {},
            },
          ],
        }, {
          expectedCurrentProfileRevision: savedProfileRevision(currentProfile),
        });
        const staleSave = await command(endpoint, "direct-stale-save", {
          kind: "save_profile",
          profile: { ...profile, name: "Stale rename" },
          expectedProfileRevision: savedProfileRevision(profile),
        });
        assert.equal(staleSave.response.status, 409);
        assert.match(String(staleSave.body.error), /changed in another/i);
        assert.deepEqual(
          (await loadAgentSettings(directory)).profiles[0]?.models.map(
            (model) => model.model,
          ),
          ["model-capable", "model-added-elsewhere"],
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: async () => catalog,
  });

  assert.deepEqual(savedState?.capabilityEvidence, {
    temperature: "unsupported",
    maxOutputTokens: "verified",
    contextWindowTokens: "verified",
    reasoning: "unsupported",
    inputs: {
      image: "supported",
      audio: "unsupported",
      pdf: "supported",
    },
  });
  assert.equal(savedState?.activeProfileRevision, savedProfileRevision(profile));

  let reopenedState: ChatDialogState | undefined;
  await runAgentFlow({
    application: { song: { handle: { id: 2n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = endpointForDialog(url);
        const response = await fetch(endpoint("/state"));
        assert.equal(response.status, 200);
        reopenedState = await response.json() as ChatDialogState;
      },
    },
  } as never, interaction, { renderHtml: () => "<html></html>" });

  assert.deepEqual(
    reopenedState?.availableModels[0]?.capabilityEvidence,
    savedState?.capabilityEvidence,
  );
  assert.deepEqual(
    reopenedState?.runtimeProfile?.inputCapabilityEvidence,
    savedState?.capabilityEvidence.inputs,
  );
  const reopenedProfile = (await loadAgentSettings(directory)).profiles[0]!;
  assert.equal(
    reopenedState?.activeProfileRevision,
    savedProfileRevision(reopenedProfile),
  );
});

test("subscription capability loading restores a reopened modal without saving settings", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-subscription-capability-reopen-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile: SavedProfile = {
    id: "subscription-capability-reopen",
    name: "Subscription capability reopen",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "subscription-image",
    models: ["subscription-image", "subscription-audio"].map((model) => ({
      model,
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    })),
  };
  const catalog: DiscoveredModelInfo[] = [
    {
      id: "subscription-image",
      displayName: "Image model",
      capabilities: {
        temperature: "unsupported",
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: true, audio: false, pdf: false },
      },
    },
    {
      id: "subscription-audio",
      displayName: "Audio model",
      capabilities: {
        temperature: "unsupported",
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: false, audio: true, pdf: false },
      },
    },
  ];
  const auth: OAuthAuthState = {
    status: "signed-in",
    accountLabel: null,
    planType: "pro",
    subscriptionEligible: true,
  };
  const unverifiedInputs = {
    image: "unverified",
    audio: "unverified",
    pdf: "unverified",
  };
  const imageEvidence = {
    image: "supported",
    audio: "unsupported",
    pdf: "unsupported",
  };
  const audioEvidence = {
    image: "unsupported",
    audio: "supported",
    pdf: "unsupported",
  };
  let opening = 0;
  let listModelsCalls = 0;
  let closedManagers = 0;
  let firstLoadedState: ChatDialogState | undefined;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = endpointForDialog(url);
        const initialResponse = await fetch(endpoint("/state"));
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json() as ChatDialogState;
        assert.equal(initial.activeSessionId, session.id);
        assert.deepEqual(initial.oauthAuth, auth);
        assert.equal(initial.configuredModelsReady, false);
        assert.deepEqual(initial.availableModels, []);
        assert.deepEqual(initial.capabilityEvidence.inputs, unverifiedInputs);
        assert.deepEqual(
          initial.runtimeProfile?.inputCapabilityEvidence,
          unverifiedInputs,
        );
        assert.equal(listModelsCalls, opening);

        const loaded = await command(
          endpoint,
          `subscription-load-${opening}`,
          opening === 0
            ? { kind: "discover_models", profile }
            : {
                kind: "load_session_model_capabilities",
                sessionId: session.id,
                profileId: profile.id,
              },
        );
        assert.equal(loaded.response.status, 200);
        const loadedState = loaded.body as unknown as ChatDialogState;
        assert.equal(loadedState.configuredModelsReady, true);
        assert.deepEqual(loadedState.availableModels.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          inputs: model.capabilityEvidence.inputs,
        })), [
          {
            id: "subscription-image",
            displayName: "Image model",
            inputs: imageEvidence,
          },
          {
            id: "subscription-audio",
            displayName: "Audio model",
            inputs: audioEvidence,
          },
        ]);
        assert.deepEqual(loadedState.capabilityEvidence.inputs, imageEvidence);
        assert.equal(
          loadedState.runtimeProfile?.selection.model,
          "subscription-audio",
        );
        assert.deepEqual(loadedState.runtimeProfile?.selection.reasoning, {
          mode: "enabled",
          effort: "high",
        });
        assert.deepEqual(
          loadedState.runtimeProfile?.inputCapabilityEvidence,
          audioEvidence,
        );
        assert.equal(listModelsCalls, opening + 1);
        if (firstLoadedState) {
          assert.deepEqual(
            loadedState.availableModels,
            firstLoadedState.availableModels,
          );
          assert.deepEqual(
            loadedState.configuredModels,
            firstLoadedState.configuredModels,
          );
          assert.deepEqual(
            loadedState.runtimeProfile,
            firstLoadedState.runtimeProfile,
          );
        } else {
          firstLoadedState = loadedState;
        }

        const repeated = await command(endpoint, `subscription-repeat-${opening}`, {
          kind: "load_session_model_capabilities",
          sessionId: session.id,
          profileId: profile.id,
        });
        assert.equal(repeated.response.status, 200);
        assert.deepEqual(repeated.body.availableModels, loadedState.availableModels);
        assert.equal(listModelsCalls, opening + 1);
      },
    },
  };
  await saveSavedProfile(directory, profile);
  const savedSettings = await loadAgentSettings(directory);
  const session = await createSession(directory, {
    title: "Saved non-default selection",
    projectKey: projectKeyForContext(context as never),
    scope: interaction.scope,
    modelSelection: {
      profileId: profile.id,
      model: "subscription-audio",
      reasoningEffort: "high",
    },
  });
  const savedSessions = await listSessions(directory);

  for (; opening < 2; opening += 1) {
    const backend: OAuthSubscriptionBackend = {
      kind: "oauth-subscription",
      async listModels() {
        listModelsCalls += 1;
        return catalog;
      },
      async createToolTurn() {
        throw new Error("Capability restoration must not start a model turn.");
      },
      async readAuthState() { return auth; },
      async beginLogin() { throw new Error("Sign-in must not be restarted."); },
      async logout() { throw new Error("Sign-in must not be changed."); },
      async close() {},
    };
    await runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      modelBackendManager: {
        async forProfile() { return backend; },
        async oauth() { return backend; },
        async oauthLease() {
          return { backend, async retire() { return true; } };
        },
        async invalidateOAuth() {},
        async close() { closedManagers += 1; },
      },
    });
    assert.equal(closedManagers, opening + 1);
    assert.deepEqual(await loadAgentSettings(directory), savedSettings);
    assert.deepEqual(await listSessions(directory), savedSessions);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) =>
        name.startsWith("live-smith-models-")
      ),
      [],
    );
  }
  assert.equal(listModelsCalls, 2);
});

test("subscription Save consumes only the current auth-generation catalog", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-subscription-capability-save-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fence = modelAuthSendFenceForStorage(undefined, "openai");
  const peerOwner = Symbol("peer auth owner");
  const baseProfile: SavedProfile = {
    id: "subscription-capability-save",
    name: "Subscription capability save",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "subscription-model",
    models: [
      {
        model: "subscription-model",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      {
        model: "subscription-model-b",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
    ],
  };
  const catalog: DiscoveredModelInfo[] = [{
    id: baseProfile.defaultModel,
    displayName: "Subscription model",
    capabilities: {
      tools: true,
      streaming: false,
      temperature: "unsupported",
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["high"],
        budgetTokens: false,
        strategy: "effort",
      },
      inputs: { image: true, audio: true, pdf: false },
    },
  }, {
    id: "subscription-model-b",
    displayName: "Subscription model B",
    capabilities: {
      tools: true,
      streaming: false,
      temperature: "unsupported",
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["high"],
        budgetTokens: false,
        strategy: "effort",
      },
      inputs: { image: true, audio: true, pdf: false },
    },
  }];
  const auth: OAuthAuthState = {
    status: "signed-in",
    accountLabel: null,
    planType: "pro",
    subscriptionEligible: true,
  };
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    async listModels(_profile: DraftProfile) {
      return catalog;
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
    async forProfile() {
      return backend;
    },
    async oauth() {
      return backend;
    },
    async oauthLease() {
      return { backend, async retire() { return true; } };
    },
    async invalidateOAuth() {},
    async close() {},
  };

  let currentSavedState: ChatDialogState | undefined;
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = endpointForDialog(url);
        const discovered = await command(endpoint, "subscription-discover", {
          kind: "discover_models",
          profile: baseProfile,
        });
        assert.equal(discovered.response.status, 200);

        fence.updateAuthState(peerOwner, "openai", "signed-in", true);
        const staleReasoningSave = await command(
          endpoint,
          "subscription-stale-reasoning-save",
          {
            kind: "save_profile",
            expectedProfileRevision: null,
            profile: {
              ...baseProfile,
              models: baseProfile.models.map((model) => ({
                ...model,
                parameters: {
                  reasoning: { mode: "enabled", effort: "high" },
                },
              })),
            },
          },
        );
        assert.equal(staleReasoningSave.response.status, 409);
        assert.match(
          String(staleReasoningSave.body.error),
          /Load the current ChatGPT model catalog/i,
        );

        const currentDiscovery = await command(
          endpoint,
          "subscription-current-discover",
          { kind: "discover_models", profile: baseProfile },
        );
        assert.equal(currentDiscovery.response.status, 200);
        const freshSave = await command(
          endpoint,
          "subscription-current-save",
          {
            kind: "save_profile",
            expectedProfileRevision: null,
            profile: {
              ...baseProfile,
              models: baseProfile.models.map((model) => ({
                ...model,
                parameters: {
                  reasoning: { mode: "enabled", effort: "high" },
                },
              })),
            },
          },
        );
        assert.equal(freshSave.response.status, 200);
        currentSavedState = freshSave.body as unknown as ChatDialogState;
        const savedProfile = currentSavedState.settings.profiles.find(
          (profile) => profile.id === baseProfile.id,
        );
        assert.ok(savedProfile);

        fence.updateAuthState(peerOwner, "openai", "signed-in", true);
        const staleDefaultSave = await command(
          endpoint,
          "subscription-stale-default-save",
          {
            kind: "save_profile",
            expectedProfileRevision: currentSavedState.activeProfileRevision,
            profile: {
              ...savedProfile,
              defaultModel: "subscription-model-b",
            },
          },
        );
        assert.equal(staleDefaultSave.response.status, 409);
        assert.match(
          String(staleDefaultSave.body.error),
          /Load the current ChatGPT model catalog/i,
        );
        const rediscovered = await command(
          endpoint,
          "subscription-rediscover-before-empty-catalog",
          { kind: "discover_models", profile: savedProfile },
        );
        assert.equal(rediscovered.response.status, 200);

        catalog.splice(0, catalog.length);
        const emptyCurrentDiscovery = await command(
          endpoint,
          "subscription-empty-current-discover",
          { kind: "discover_models", profile: baseProfile },
        );
        assert.equal(emptyCurrentDiscovery.response.status, 200);
        const unavailableUnchangedModel = await command(
          endpoint,
          "subscription-unavailable-unchanged-model",
          {
            kind: "save_profile",
            expectedProfileRevision: currentSavedState.activeProfileRevision,
            profile: {
              ...savedProfile,
              name: "Must not preserve an unavailable model",
            },
          },
        );
        assert.equal(unavailableUnchangedModel.response.status, 400);
        assert.match(
          String(unavailableUnchangedModel.body.error),
          /not available for the signed-in ChatGPT account/i,
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager,
    modelAuthSendFence: fence,
  });

  assert.deepEqual(currentSavedState?.capabilityEvidence, {
    temperature: "unsupported",
    maxOutputTokens: "unverified",
    contextWindowTokens: "unverified",
    reasoning: "supported",
    inputs: {
      image: "supported",
      audio: "supported",
      pdf: "unsupported",
    },
  });
});
