import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type { SavedProfile } from "../model/profile.js";
import type {
  CodexSubscriptionBackend,
  ManagedAuthState,
  RuntimeProfile,
} from "../model/provider.js";
import { saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { modelAuthSendFenceForStorage } from "./model-auth-send-fence.js";

let commandSequence = 0;

function commandHeaders(): Record<string, string> {
  commandSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": `model-selection-${commandSequence}`,
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
      async codex() { throw new Error("unexpected managed backend"); },
      async codexLease() { throw new Error("unexpected managed backend"); },
      async invalidateCodex() {},
      async close() {},
    },
    requestModelTurn: async (input) => {
      requestedRuntimes.push(input.runtimeProfile);
      return { content: "The track is ready.", toolCalls: [] };
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
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "gpt-capable",
    models: [{
      model: "gpt-capable",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  };
  await saveSavedProfile(directory, profile);

  const auth: ManagedAuthState = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  let listModelsCalls = 0;
  let readinessReads = 0;
  let passiveReads = 0;
  const backend: CodexSubscriptionBackend = {
    kind: "codex-subscription",
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
    async codex() { return backend; },
    async codexLease() {
      return { backend, async retire() { return true; } };
    },
    async invalidateCodex() {},
    async close() {},
  };
  const fence = modelAuthSendFenceForStorage(directory);
  const peerAuthOwner = Symbol("peer auth generation");
  const interaction: LiveInteractionContext = {
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
        const load = async (): Promise<ChatDialogState> => {
          const response = await fetch(endpoint("/command"), {
            method: "POST",
            headers: commandHeaders(),
            body: JSON.stringify({
              kind: "load_session_model_capabilities",
              sessionId: (await state()).activeSessionId,
              profileId: profile.id,
            }),
          });
          const body = await response.text();
          assert.equal(response.status, 200, body);
          return JSON.parse(body) as ChatDialogState;
        };

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

        const repeated = await load();
        assert.equal(repeated.configuredModelsReady, true);
        assert.equal(listModelsCalls, 1);
        assert.equal(readinessReads, 1);

        fence.updateAuthState(peerAuthOwner, "signed-in", true);
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
  });

  assert.ok(passiveReads > 0);
});
