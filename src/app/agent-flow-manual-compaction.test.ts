import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { LiveInteractionContext } from "../live/context.js";
import type {
  ModelBackend,
  OAuthSubscriptionBackend,
  TransportRequest,
} from "../model/provider.js";
import { ModelConnectionError } from "../model/connection-error.js";
import type {
  OAuthSubscriptionProvider,
  SavedProfile,
} from "../model/profile.js";
import {
  appendSessionEvent,
  loadSessionEvents,
} from "../storage/events.js";
import { saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

let commandSequence = 0;

function profileFor(provider: "direct" | OAuthSubscriptionProvider): SavedProfile {
  const model = `model-${provider}`;
  const overrideModel = `${model}-override`;
  return provider === "direct"
    ? {
        id: "profile-direct-compact",
        name: "Direct compact",
        connection: {
          kind: "direct-api",
          apiFamily: "openai",
          apiMode: "responses",
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
        },
        defaultModel: model,
        models: [model, overrideModel].map((configuredModel) => ({
          model: configuredModel,
          parameters: {
            maxOutputTokens: 4096,
            reasoning: { mode: "default" as const },
          },
          advanced: {},
        })),
      }
    : {
        id: `profile-${provider}-compact`,
        name: `${provider} compact`,
        connection: { kind: "oauth-subscription", provider },
        defaultModel: model,
        models: [model, overrideModel].map((configuredModel) => ({
          model: configuredModel,
          parameters: { reasoning: { mode: "default" as const } },
          advanced: {},
        })),
      };
}

for (const provider of ["direct", "openai", "anthropic", "google"] as const) {
  test(`/${"compact"} uses the active ${provider} model without creating a user turn`, async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `live-smith-manual-compact-${provider}-`),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const profile = profileFor(provider);
    await saveSavedProfile(directory, profile);
    const requests: TransportRequest[] = [];
    const backend = backendFor(profile, requests);
    const modelBackendManager = backendManagerFor(backend);
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
          const state = await (
            await fetch(endpoint(url, "/state"))
          ).json() as ChatDialogState;
          await appendSessionEvent(directory, state.activeSessionId, {
            kind: "user",
            content: "Build a 64-bar arrangement",
          });
          await appendSessionEvent(directory, state.activeSessionId, {
            kind: "assistant",
            content: "The first arrangement pass is complete.",
          });

          const overrideModel = `${profile.defaultModel}-override`;
          commandSequence += 1;
          const capabilities = await fetch(
            endpoint(url, "/session-model-capabilities"),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Live-Smith-Command-Id":
                  `capabilities-command-${commandSequence}`,
              },
              body: JSON.stringify({
                kind: "load_session_model_capabilities",
                sessionId: state.activeSessionId,
                profileId: profile.id,
              }),
            },
          );
          assert.equal(capabilities.status, 200, await capabilities.text());

          commandSequence += 1;
          const selection = await fetch(endpoint(url, "/command"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Live-Smith-Command-Id": `model-command-${commandSequence}`,
            },
            body: JSON.stringify({
              kind: "set_session_model_selection",
              sessionId: state.activeSessionId,
              profileId: profile.id,
              model: overrideModel,
              reasoningEffort: null,
            }),
          });
          assert.equal(selection.status, 200, await selection.text());

          commandSequence += 1;
          const commandId = `compact-command-${commandSequence}`;
          const body = JSON.stringify({
            kind: "compact_session",
            sessionId: state.activeSessionId,
            instructions: "Preserve exact bar ranges.",
          });
          const response = await fetch(endpoint(url, "/command"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Live-Smith-Command-Id": commandId,
            },
            body,
          });
          const responseText = await response.text();
          assert.equal(response.status, 200, responseText);
          const result = JSON.parse(responseText) as ChatDialogState;
          assert.equal(result.status, "Session context compacted.");

          const redundant = await fetch(endpoint(url, "/command"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Live-Smith-Command-Id": `${commandId}-new`,
            },
            body,
          });
          assert.equal(redundant.status, 409, await redundant.text());

          const events = await loadSessionEvents(directory, state.activeSessionId);
          assert.deepEqual(events.map((event) => event.kind), [
            "user",
            "assistant",
            "compaction",
          ]);
          assert.equal(events.at(-1)?.content, "Manual checkpoint");
        },
      },
    };

    await runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      modelBackendManager,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.tools, []);
    assert.match(JSON.stringify(requests[0]?.history), /64-bar arrangement/);
    assert.match(
      JSON.stringify(requests[0]?.agentMessages),
      /Preserve exact bar ranges/,
    );
    assert.equal(requests[0]?.runtimeProfile.profile.id, profile.id);
    assert.equal(
      requests[0]?.runtimeProfile.model.model,
      `${profile.defaultModel}-override`,
    );
  });
}

test("/compact publishes correlated reconnect progress without persisting it", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-manual-compact-progress-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = profileFor("direct");
  await saveSavedProfile(directory, profile);
  const requests: TransportRequest[] = [];
  const baseBackend = backendFor(profile, []);
  let requestCount = 0;
  const backend: ModelBackend = {
    ...baseBackend,
    async createToolTurn(request) {
      requests.push(request);
      requestCount += 1;
      if (requestCount === 1) throw new ModelConnectionError();
      return { content: "Recovered checkpoint", toolCalls: [] };
    },
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
        const state = await (
          await fetch(endpoint(url, "/state"))
        ).json() as ChatDialogState;
        await appendSessionEvent(directory, state.activeSessionId, {
          kind: "user",
          content: "Preserve this context",
        });
        const events = await fetch(endpoint(url, "/events"));
        commandSequence += 1;
        const commandId = `compact-progress-${commandSequence}`;
        const progress = readSsePayloads(events, "command_progress", 2);
        const response = await fetch(endpoint(url, "/command"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": commandId,
          },
          body: JSON.stringify({
            kind: "compact_session",
            sessionId: state.activeSessionId,
          }),
        });
        assert.equal(response.status, 200, await response.text());
        assert.deepEqual(await progress, [
          {
            type: "command_progress",
            commandId,
            message:
              "The model connection was interrupted. Reconnecting (1/5) in 500 ms…",
          },
          {
            type: "command_progress",
            commandId,
            message: "Reconnected. Reading model response",
          },
        ]);
        assert.deepEqual(
          (await loadSessionEvents(directory, state.activeSessionId)).map(
            (event) => event.kind,
          ),
          ["user", "compaction"],
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: backendManagerFor(backend),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.reconnectState, requests[1]?.reconnectState);
});

test("/compact Stop aborts the correlated provider request before persistence", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-manual-compact-stop-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = profileFor("direct");
  await saveSavedProfile(directory, profile);
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const baseBackend = backendFor(profile, []);
  const backend: ModelBackend = {
    ...baseBackend,
    async createToolTurn(request) {
      providerStarted();
      if (!request.signal?.aborted) {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { content: "Late checkpoint", toolCalls: [] };
    },
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
        const state = await (
          await fetch(endpoint(url, "/state"))
        ).json() as ChatDialogState;
        await appendSessionEvent(directory, state.activeSessionId, {
          kind: "user",
          content: "Preserve this context",
        });
        commandSequence += 1;
        const commandId = `compact-stop-${commandSequence}`;
        const command = fetch(endpoint(url, "/command"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": commandId,
          },
          body: JSON.stringify({
            kind: "compact_session",
            sessionId: state.activeSessionId,
          }),
        });
        await started;
        const stop = await fetch(endpoint(url, "/stop"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": commandId,
          },
          body: "{}",
        });
        assert.deepEqual(await stop.json(), {
          ok: true,
          terminal: false,
          commandId,
        });
        const response = await command;
        const body = await response.json() as Record<string, unknown>;
        assert.equal(response.status, 409);
        assert.equal(body.commandId, commandId);
        assert.equal(body.commandOutcome, "stopped");
        assert.deepEqual(
          (await loadSessionEvents(directory, state.activeSessionId)).map(
            (event) => event.kind,
          ),
          ["user"],
        );
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: backendManagerFor(backend),
  });
});

test("/compact does not persist a provider response after the dialog closes", {
  timeout: 2_000,
}, async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-manual-compact-abort-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = profileFor("direct");
  await saveSavedProfile(directory, profile);
  const requests: TransportRequest[] = [];
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  const backend: ModelBackend = {
    ...backendFor(profile, []),
    async createToolTurn(request) {
      requests.push(request);
      markProviderStarted();
      if (!request.signal?.aborted) {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      return { content: "Late checkpoint", toolCalls: [] };
    },
  };
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let sessionId = "";
  let commandOutcome: Promise<unknown> | undefined;

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const state = await (
          await fetch(endpoint(url, "/state"))
        ).json() as ChatDialogState;
        sessionId = state.activeSessionId;
        await appendSessionEvent(directory, sessionId, {
          kind: "user",
          content: "Preserve this context",
        });
        commandSequence += 1;
        commandOutcome = fetch(endpoint(url, "/command"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": `compact-abort-${commandSequence}`,
          },
          body: JSON.stringify({ kind: "compact_session", sessionId }),
        }).then(
          async (response) => ({ status: response.status, body: await response.text() }),
          (error: unknown) => ({ error }),
        );
        await providerStarted;
      },
    },
  } as never, interaction, {
    renderHtml: () => "<html></html>",
    modelBackendManager: backendManagerFor(backend),
  });

  await commandOutcome;
  assert.equal(requests.length, 1);
  assert.deepEqual(
    (await loadSessionEvents(directory, sessionId)).map((event) => event.kind),
    ["user"],
  );
});

function endpoint(url: string, pathname: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${pathname}?token=${parsed.searchParams.get("token")}`;
}

async function readSsePayloads(
  response: Response,
  type: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const payloads: Record<string, unknown>[] = [];
  let received = "";
  try {
    while (payloads.length < count) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Event stream ended before ${type}.`);
      received += NodeBuffer.from(chunk.value).toString("utf8");
      for (;;) {
        const boundary = received.indexOf("\n\n");
        if (boundary < 0) break;
        const block = received.slice(0, boundary);
        received = received.slice(boundary + 2);
        const data = block.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload.type === type) payloads.push(payload);
      }
    }
    return payloads;
  } finally {
    await reader.cancel();
  }
}

function backendManagerFor(backend: ModelBackend) {
  return {
    async forProfile() { return backend; },
    async oauth() { return backend as OAuthSubscriptionBackend; },
    async oauthLease() {
      return {
        backend: backend as OAuthSubscriptionBackend,
        async retire() { return true; },
      };
    },
    async invalidateOAuth() {},
    async close() {},
  };
}

function backendFor(
  profile: SavedProfile,
  requests: TransportRequest[],
): ModelBackend {
  const common = {
    async createToolTurn(request: TransportRequest) {
      requests.push(request);
      return { content: "Manual checkpoint", toolCalls: [] };
    },
    async listModels() {
      return profile.models.map((model) => ({
        id: model.model,
        displayName: model.model,
        capabilities: {
          tools: true,
          streaming: false,
          temperature: profile.connection.kind === "direct-api"
            ? "supported" as const
            : "unsupported" as const,
          inputs: { image: false, audio: false, pdf: false },
        },
      }));
    },
    async close() {},
  };
  if (profile.connection.kind === "direct-api") {
    return { kind: "direct-api", ...common };
  }
  return {
    kind: "oauth-subscription",
    ...common,
    async readAuthState() {
      return {
        status: "signed-in" as const,
        accountLabel: "studio@example.test",
        planType: "pro",
        subscriptionEligible: true,
      };
    },
    async beginLogin() { return { status: "signed-out" as const }; },
    async logout() { return { status: "signed-out" as const }; },
  };
}
