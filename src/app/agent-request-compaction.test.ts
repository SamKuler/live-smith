import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { RuntimeProfile } from "../model/provider.js";
import type { SavedProfile } from "../model/profile.js";
import {
  appendSessionEvent,
  loadSessionEvents,
  type SessionEvent,
} from "../storage/events.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";

function profiles(): SavedProfile[] {
  const direct: SavedProfile = {
    id: "direct-compaction",
    name: "Direct compaction",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "model-direct",
    models: [{
      model: "model-direct",
      parameters: {
        maxOutputTokens: 1024,
        contextWindowTokens: 1_000,
        autoCompactTokenLimit: 1,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
  const subscriptions: SavedProfile[] = (
    ["openai", "anthropic", "google"] as const
  ).map((provider) => ({
    id: `subscription-compaction-${provider}`,
    name: `${provider} subscription compaction`,
    connection: { kind: "oauth-subscription", provider },
    defaultModel: `model-subscription-${provider}`,
    models: [{
      model: `model-subscription-${provider}`,
      parameters: {
        contextWindowTokens: 1_000,
        autoCompactTokenLimit: 1,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  }));
  return [direct, ...subscriptions];
}

for (const profile of profiles()) {
  const connectionLabel = profile.connection.kind === "oauth-subscription"
    ? `oauth-${profile.connection.provider}`
    : "direct-api";
  test(`${connectionLabel} compacts before sampling through the same model requester`, async (t) => {
    const storageDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "live-smith-context-compaction-"),
    );
    t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
    const session = await createSession(storageDirectory, {
      title: "Compaction",
      projectKey: "project-context",
      scope: { kind: "track", identity: "track-1", label: "Bass" },
    });
    await appendSessionEvent(storageDirectory, session.id, {
      kind: "user",
      content: "An older request that should be checkpointed",
    });
    await appendSessionEvent(storageDirectory, session.id, {
      kind: "assistant",
      content: "An older response that should be checkpointed",
    });

    const requests: Parameters<
      NonNullable<Parameters<typeof handleAgentRequest>[8]>
    >[0][] = [];
    const published: SessionEvent[] = [];
    const acceptedUsage: unknown[] = [];
    const runtime = runtimeProfileForSavedProfile(profile) as RuntimeProfile;

    const result = await handleAgentRequest(
      { environment: { storageDirectory } } as never,
      storageDirectory,
      {
        summary: "Track: Bass",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Bass" },
      },
      "Continue the Bass arrangement",
      runtime,
      "project-context",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onModelTurnAccepted: (usage) => {
          acceptedUsage.push(usage);
        },
        onProgress: () => {},
        onSessionEvent: (event) => {
          published.push(event);
        },
        confirmActions: async () => true,
      },
      async (input) => {
        requests.push(input);
        if (requests.length === 1) {
          assert.deepEqual(input.tools, []);
          assert.match(
            input.agentMessages.at(-1)?.role === "user"
              ? input.agentMessages.at(-1)?.content ?? ""
              : "",
            /CONTEXT CHECKPOINT COMPACTION/,
          );
          return { content: "Checkpoint: preserve the Bass arrangement decisions.", toolCalls: [] };
        }
        assert.notDeepEqual(input.tools, []);
        assert.match(JSON.stringify(input.history), /Checkpoint: preserve/);
        assert.doesNotMatch(JSON.stringify(input.history), /older request|older response/i);
        return {
          content: "Continued after compaction.",
          toolCalls: [],
          contextUsage: { usedTokens: 200, contextWindowTokens: 1_000 },
        };
      },
    );

    assert.equal(result, "Continued after compaction.");
    assert.equal(requests.length, 2);
    assert.deepEqual(acceptedUsage, [
      undefined,
      { usedTokens: 200, contextWindowTokens: 1_000 },
    ]);
    const stored = await loadSessionEvents(storageDirectory, session.id);
    assert.deepEqual(
      stored.map((event) => event.kind),
      ["user", "assistant", "user", "compaction", "assistant"],
    );
    assert.equal(
      published.filter((event) => event.kind === "compaction").length,
      1,
    );
  });
}

test("a tool turn above the threshold compacts before the next sampling turn", async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-mid-turn-compaction-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Mid-turn compaction",
    projectKey: "project-context",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
  });
  const profile = profiles()[0]!;
  const parameters = profile.models[0]!.parameters;
  parameters.contextWindowTokens = 10_000_000;
  parameters.autoCompactTokenLimit = 9_000_000;
  const requests: Parameters<
    NonNullable<Parameters<typeof handleAgentRequest>[8]>
  >[0][] = [];

  const result = await handleAgentRequest(
    { environment: { storageDirectory } } as never,
    storageDirectory,
    {
      summary: "Track: Bass",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Bass" },
    },
    "Continue the Bass arrangement",
    runtimeProfileForSavedProfile(profile),
    "project-context",
    session.id,
    {
      signal: new AbortController().signal,
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      requests.push(input);
      if (requests.length === 1) {
        assert.notDeepEqual(input.tools, []);
        return {
          content: null,
          toolCalls: [{
            id: "call-invalid-apply",
            name: "apply_live_actions",
            arguments: "{}",
          }],
          contextUsage: {
            usedTokens: 9_500_000,
            contextWindowTokens: 10_000_000,
          },
        };
      }
      if (requests.length === 2) {
        assert.deepEqual(input.tools, []);
        assert.match(JSON.stringify(input.agentMessages), /call-invalid-apply/);
        return { content: "Checkpoint after invalid Apply input.", toolCalls: [] };
      }
      assert.notDeepEqual(input.tools, []);
      assert.match(JSON.stringify(input.history), /Checkpoint after invalid Apply input/);
      assert.doesNotMatch(JSON.stringify(input.agentMessages), /call-invalid-apply/);
      return { content: "Continued after the checkpoint.", toolCalls: [] };
    },
  );

  assert.equal(result, "Continued after the checkpoint.");
  assert.equal(requests.length, 3);
  assert.equal(
    (await loadSessionEvents(storageDirectory, session.id))
      .filter((event) => event.kind === "compaction").length,
    1,
  );
});

test("a post-checkpoint tool turn can compact again in the same send", async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-repeated-compaction-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Repeated compaction",
    projectKey: "project-context",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
  });
  const requests: Parameters<
    NonNullable<Parameters<typeof handleAgentRequest>[8]>
  >[0][] = [];

  const result = await handleAgentRequest(
    { environment: { storageDirectory } } as never,
    storageDirectory,
    {
      summary: "Track: Bass",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Bass" },
    },
    "Continue the Bass arrangement",
    runtimeProfileForSavedProfile(profiles()[0]!),
    "project-context",
    session.id,
    {
      signal: new AbortController().signal,
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      requests.push(input);
      if (requests.length === 1 || requests.length === 3) {
        assert.deepEqual(input.tools, []);
        return {
          content: `Checkpoint ${requests.length === 1 ? "one" : "two"}`,
          toolCalls: [],
        };
      }
      if (requests.length === 2) {
        assert.notDeepEqual(input.tools, []);
        return {
          content: null,
          toolCalls: [{
            id: "call-invalid-apply",
            name: "apply_live_actions",
            arguments: "{}",
          }],
        };
      }
      assert.notDeepEqual(input.tools, []);
      assert.match(JSON.stringify(input.history), /Checkpoint two/);
      return { content: "Finished after two checkpoints.", toolCalls: [] };
    },
  );

  assert.equal(result, "Finished after two checkpoints.");
  assert.equal(requests.length, 4);
  assert.equal(
    (await loadSessionEvents(storageDirectory, session.id))
      .filter((event) => event.kind === "compaction").length,
    2,
  );
});

test("exact provider usage includes only the estimated context added after that turn", async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-context-usage-delta-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Context usage delta",
    projectKey: "project-context",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
  });
  const profile = profiles()[0]!;
  profile.models[0]!.parameters.contextWindowTokens = 10_000_000;
  profile.models[0]!.parameters.autoCompactTokenLimit = 9_000_000;
  const requests: Parameters<
    NonNullable<Parameters<typeof handleAgentRequest>[8]>
  >[0][] = [];

  const result = await handleAgentRequest(
    { environment: { storageDirectory } } as never,
    storageDirectory,
    {
      summary: "Track: Bass",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Bass" },
    },
    "Continue the Bass arrangement",
    runtimeProfileForSavedProfile(profile),
    "project-context",
    session.id,
    {
      signal: new AbortController().signal,
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      requests.push(input);
      if (requests.length === 1) {
        assert.notDeepEqual(input.tools, []);
        return {
          content: null,
          toolCalls: [{
            id: "call-invalid-apply",
            name: "apply_live_actions",
            arguments: "{}",
          }],
          contextUsage: {
            usedTokens: 8_999_999,
            contextWindowTokens: 10_000_000,
          },
        };
      }
      if (requests.length === 2) {
        assert.deepEqual(input.tools, []);
        return { content: "Checkpoint after the added tool result.", toolCalls: [] };
      }
      assert.notDeepEqual(input.tools, []);
      return { content: "Continued after delta-aware compaction.", toolCalls: [] };
    },
  );

  assert.equal(result, "Continued after delta-aware compaction.");
  assert.equal(requests.length, 3);
});

test("a failed compaction writes no checkpoint boundary", async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-failed-compaction-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Failed compaction",
    projectKey: "project-context",
    scope: { kind: "track", identity: "track-1", label: "Bass" },
  });

  await assert.rejects(
    handleAgentRequest(
      { environment: { storageDirectory } } as never,
      storageDirectory,
      {
        summary: "Track: Bass",
        target: {},
        scope: { kind: "track", identity: "track-1", label: "Bass" },
      },
      "Continue the Bass arrangement",
      runtimeProfileForSavedProfile(profiles()[0]!),
      "project-context",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onProgress: () => {},
        onSessionEvent: () => {},
        confirmActions: async () => true,
      },
      async () => ({ content: "", toolCalls: [] }),
    ),
    /empty checkpoint/i,
  );

  const stored = await loadSessionEvents(storageDirectory, session.id);
  assert.equal(stored.some((event) => event.kind === "compaction"), false);
  assert.equal(stored.some((event) => event.kind === "error"), true);
});
