import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type {
  CodexSubscriptionBackend,
  DiscoveredModelInfo,
  ManagedAuthState,
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
import type { ChatDialogState } from "../ui/chat-state.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";
import { runAgentFlow } from "./agent-flow.js";

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

test("subscription Save consumes only the current auth-generation catalog", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-subscription-capability-save-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fence = modelAuthSendFenceForStorage(undefined);
  const peerOwner = Symbol("peer auth owner");
  const baseProfile: SavedProfile = {
    id: "subscription-capability-save",
    name: "Subscription capability save",
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "subscription-model",
    models: [{
      model: "subscription-model",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
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
  }];
  const auth: ManagedAuthState = {
    status: "signed-in",
    accountLabel: null,
    planType: "pro",
    subscriptionEligible: true,
  };
  const backend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
    async listModels(_profile: DraftProfile) {
      return catalog;
    },
    async createToolTurn() {
      return { content: null, toolCalls: [] };
    },
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
    async codex() {
      return backend;
    },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async invalidateCodex() {},
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

        fence.updateAuthState(peerOwner, "signed-in", true);
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
