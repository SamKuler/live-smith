import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ModelHostedWebSearch } from "../model/contracts.js";
import { ModelConnectionError } from "../model/connection-error.js";
import type { ModelTool } from "../model/provider.js";
import type { SavedProfile } from "../model/profile.js";
import { loadSessionEvents, type SessionEvent } from "../storage/events.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-request.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import { SteeringChannel } from "./steering.js";

const profile: SavedProfile = {
  id: "reconnect-profile",
  name: "Reconnect Provider",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
  defaultModel: "model-a",
  models: [{
    model: "model-a",
    parameters: {
      maxOutputTokens: 1_024,
      reasoning: { mode: "default" },
    },
    advanced: { hostedTools: { webSearch: true } },
  }],
};

test("agent request rebuilds only the current model turn while reconnecting", {
  timeout: 3_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-model-reconnect-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Reconnect",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const events: string[] = [];
  const published: SessionEvent[] = [];
  const requestInputs: object[] = [];
  const reconnectStates: Array<object | undefined> = [];
  const hostedAllowances: number[] = [];
  const acceptedUsage: unknown[] = [];
  let modelCalls = 0;

  const result = await handleAgentRequest(
    { environment: { storageDirectory } } as never,
    storageDirectory,
    {
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    "Recover this request",
    runtimeProfileForSavedProfile(profile),
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      onDelta: (delta) => {
        events.push(`delta:${delta}`);
      },
      onAssistantReset: () => {
        events.push("reset");
      },
      onModelTurnAccepted: (usage) => {
        acceptedUsage.push(usage);
      },
      onProgress: (message) => {
        events.push(`progress:${message}`);
      },
      onWebSearchUpdate: (update) => {
        events.push(`search:${update.id}`);
      },
      onSessionEvent: (event) => {
        published.push(event);
      },
      confirmActions: async () => true,
    },
    async (input) => {
      modelCalls += 1;
      requestInputs.push(input);
      reconnectStates.push(input.reconnectState);
      hostedAllowances.push(hostedWebSearchAllowance(input.tools));
      if (modelCalls === 1) {
        await input.onDelta("partial");
        await input.onHostedWebSearch?.(searchingWebSearch("search-before-drop"));
        throw new ModelConnectionError();
      }
      await input.onDelta("fresh");
      return {
        content: "Recovered response.",
        toolCalls: [],
        contextUsage: { usedTokens: 640, contextWindowTokens: 16_000 },
      };
    },
  );

  assert.equal(result, "Recovered response.");
  assert.equal(modelCalls, 2);
  assert.notEqual(requestInputs[0], requestInputs[1]);
  assert.ok(reconnectStates[0]);
  assert.equal(reconnectStates[0], reconnectStates[1]);
  assert.deepEqual(hostedAllowances, [20, 19]);
  assert.deepEqual(acceptedUsage, [
    { usedTokens: 640, contextWindowTokens: 16_000 },
  ]);
  const resetIndex = events.indexOf("reset");
  const reconnectingIndex = events.indexOf(
    "progress:Model connection lost. Reconnecting (1/5)…",
  );
  const reconnectedIndex = events.indexOf(
    "progress:Reconnected. Reading model response",
  );
  const freshDeltaIndex = events.indexOf("delta:fresh");
  assert.equal(resetIndex > events.indexOf("delta:partial"), true);
  assert.equal(reconnectingIndex > resetIndex, true);
  assert.equal(reconnectedIndex > reconnectingIndex, true);
  assert.equal(freshDeltaIndex > reconnectedIndex, true);
  assert.equal(
    events.slice(reconnectedIndex + 1).includes("progress:Reading model response"),
    false,
  );

  const storedEvents = await loadSessionEvents(storageDirectory, session.id);
  assert.equal(storedEvents.filter((event) => event.kind === "user").length, 1);
  assert.equal(storedEvents.filter((event) => event.kind === "assistant").length, 1);
  assert.equal(storedEvents.some((event) => event.kind === "error"), false);
  assert.equal(storedEvents.some((event) => event.kind === "web_search"), false);
  assert.equal(published.filter((event) => event.kind === "user").length, 1);
});

test("steering during reconnect backoff cancels the retry and replans", {
  timeout: 3_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-reconnect-steering-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Reconnect steering",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const steering = new SteeringChannel();
  t.after(() => steering.close());
  const backoffStarted = deferred<AbortSignal>();
  const progress: string[] = [];
  const modelInputs: Parameters<
    NonNullable<Parameters<typeof handleAgentRequest>[8]>
  >[0][] = [];
  let assistantResets = 0;

  const request = handleAgentRequest(
    { environment: { storageDirectory } } as never,
    storageDirectory,
    interaction(),
    "Recover and inspect Lead",
    runtimeProfileForSavedProfile(profile),
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      steering,
      steeringSendId: "send-reconnect-steering",
      onDelta: () => {},
      onAssistantReset: () => {
        assistantResets += 1;
      },
      onProgress: (message) => {
        progress.push(message);
      },
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      modelInputs.push(input);
      if (modelInputs.length === 1) throw new ModelConnectionError();
      return { content: "Replanned response.", toolCalls: [] };
    },
    undefined,
    undefined,
    undefined,
    async (_delayMs, signal) => {
      backoffStarted.resolve(signal);
      await waitForAbort(signal);
      throw new Error("injected wait rejected after steering");
    },
  );

  const backoffSignal = await backoffStarted.promise;
  const submitted = steering.submit(
    "steer-during-backoff",
    "Inspect Rhythm instead.",
  );

  await submitted;
  assert.equal(await request, "Replanned response.");
  assert.equal(backoffSignal.aborted, true);
  assert.equal(modelInputs.length, 2);
  assert.ok(modelInputs[0]?.reconnectState);
  assert.ok(modelInputs[1]?.reconnectState);
  assert.notEqual(
    modelInputs[0].reconnectState,
    modelInputs[1].reconnectState,
  );
  assert.deepEqual(modelInputs[1]?.agentMessages.at(-1), {
    role: "user",
    content: "Inspect Rhythm instead.",
  });
  assert.equal(assistantResets, 2);
  assert.equal(
    progress.includes("Model connection lost. Reconnecting (1/5)…"),
    true,
  );
  assert.equal(progress.includes("Replanning with new guidance"), true);
  const storedEvents = await loadSessionEvents(storageDirectory, session.id);
  assert.equal(storedEvents.some((event) => event.kind === "error"), false);
});

test("agent request exhausts five retries with one fixed durable error", {
  timeout: 3_000,
}, async (t) => {
  const storageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-reconnect-exhausted-"),
  );
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, {
    title: "Reconnect exhausted",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const published: SessionEvent[] = [];
  let modelRequests = 0;
  let assistantResets = 0;

  await assert.rejects(
    handleAgentRequest(
      { environment: { storageDirectory } } as never,
      storageDirectory,
      interaction(),
      "Keep trying",
      runtimeProfileForSavedProfile(profile),
      "project-a",
      session.id,
      {
        signal: new AbortController().signal,
        onDelta: () => {},
        onAssistantReset: () => {
          assistantResets += 1;
        },
        onProgress: () => {},
        onSessionEvent: (event) => {
          published.push(event);
        },
        confirmActions: async () => true,
      },
      async () => {
        modelRequests += 1;
        throw new ModelConnectionError();
      },
      undefined,
      undefined,
      undefined,
      async () => {},
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Model connection was lost after 5 reconnect attempts.",
  );

  assert.equal(modelRequests, 6);
  assert.equal(assistantResets, 5);
  const storedEvents = await loadSessionEvents(storageDirectory, session.id);
  const storedErrors = storedEvents.filter((event) => event.kind === "error");
  assert.equal(storedErrors.length, 1);
  assert.equal(
    storedErrors[0]?.content,
    "Model connection was lost after 5 reconnect attempts.",
  );
  assert.equal(published.filter((event) => event.kind === "error").length, 1);
});

function hostedWebSearchAllowance(tools: readonly ModelTool[]): number {
  return tools.find((tool) => tool.type === "hosted_web_search")?.maxUses ?? 0;
}

function searchingWebSearch(id: string): ModelHostedWebSearch {
  return {
    id,
    status: "searching",
    action: "search",
    queries: ["reconnect"],
    sources: [],
  };
}

function interaction() {
  return {
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track" as const, identity: "track-1", label: "Lead" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((targetResolve) => {
    resolve = targetResolve;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
