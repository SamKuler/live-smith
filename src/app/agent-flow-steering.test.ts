import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { resolveModelCapabilities } from "../model/capabilities.js";
import type { SavedProfile } from "../model/profile.js";
import {
  appendSessionEvent,
  loadSessionEvents,
  type SessionEvent,
} from "../storage/events.js";
import { StorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import { createSession } from "../storage/sessions.js";
import { handleAgentRequest } from "./agent-flow.js";
import {
  SteeringChannel,
  SteeringClosedError,
  SteeringPersistenceOutcomeUnknownError,
} from "./steering.js";

const profile: SavedProfile = {
  id: "steering-profile",
  name: "Provider",
  apiFamily: "openai",
  apiMode: "responses",
  apiKey: "key",
  baseUrl: "https://example.test/v1",
  model: "custom-model",
  parameters: {
    maxOutputTokens: 1024,
    reasoning: { mode: "default" },
  },
  advanced: {},
};

test("handleAgentRequest persists steering, discards the interrupted turn, and replans", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-flow-",
  ));
  const session = await createSession(directory, {
    title: "Steering",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const steering = new SteeringChannel();
  const parent = new AbortController();
  const firstCallStarted = deferred<AbortSignal>();
  const modelInputs: Parameters<NonNullable<Parameters<typeof handleAgentRequest>[7]>>[0][] = [];
  const publishedEvents: SessionEvent[] = [];
  let appendCount = 0;
  let assistantResetCount = 0;

  const request = handleAgentRequest(
    { environment: { storageDirectory: directory } } as never,
    interaction(),
    "Make the Lead brighter.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: parent.signal,
      steering,
      steeringSendId: "send-steering-flow",
      onDelta: () => {},
      onAssistantReset: () => {
        assistantResetCount += 1;
      },
      onProgress: () => {},
      onSessionEvent: (event) => {
        publishedEvents.push(event);
      },
      confirmActions: async () => true,
    },
    async (input) => {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        firstCallStarted.resolve(input.signal);
        await waitForAbort(input.signal);
        return { content: "This stale answer must be discarded.", toolCalls: [] };
      }
      return { content: "Changed direction.", toolCalls: [] };
    },
    async (storageDirectory, sessionId, input) => {
      appendCount += 1;
      const event = await appendSessionEvent(storageDirectory, sessionId, input);
      if (appendCount === 2) {
        throw new StorageCommitOutcomeUnknownError(
          new Error("injected directory sync uncertainty"),
        );
      }
      return event;
    },
  );

  const modelSignal = await firstCallStarted.promise;
  assert.notStrictEqual(modelSignal, parent.signal);
  const submitted = steering.submit(
    "steer-1",
    "Keep it warm; use the Rhythm track instead.",
  );

  await submitted;
  assert.equal(await request, "Changed direction.");
  assert.equal(parent.signal.aborted, false);
  assert.equal(modelSignal.aborted, true);
  assert.equal(assistantResetCount, 1);
  assert.equal(modelInputs.length, 2);
  assert.deepEqual(modelInputs[1]?.agentMessages, [{
    role: "user",
    content: "Keep it warm; use the Rhythm track instead.",
  }]);

  const events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(
    events.filter((event) => event.kind === "user").map((event) => event.content),
    [
      "Make the Lead brighter.",
      "Keep it warm; use the Rhythm track instead.",
    ],
  );
  assert.equal(
    publishedEvents.filter((event) => event.kind === "user").length,
    2,
  );
  assert.equal(
    events.some((event) => event.content.includes("stale answer")),
    false,
  );
  assert.deepEqual(
    events.find((event) => event.content.startsWith("Keep it warm"))
      ?.steeringReceipt,
    {
      sendId: "send-steering-flow",
      id: "steer-1",
      sha256: "4c43d46d31d62f60d1aaf393b7f0631de1630d9d62e150f1949146d694a7575b",
    },
  );
  steering.close();
});

test("unknown steering commit survives a failed reconciliation read for same-ID retry", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-unknown-",
  ));
  const session = await createSession(directory, {
    title: "Unknown steering receipt",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const steering = new SteeringChannel();
  const firstCallStarted = deferred<void>();
  let appendCount = 0;
  let reconciliationReadCount = 0;

  const request = handleAgentRequest(
    { environment: { storageDirectory: directory } } as never,
    interaction(),
    "Inspect Lead.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      steering,
      steeringSendId: "send-unknown-receipt",
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      firstCallStarted.resolve(undefined);
      await waitForAbort(input.signal);
      throw input.signal.reason;
    },
    async (storageDirectory, sessionId, input) => {
      appendCount += 1;
      const event = await appendSessionEvent(storageDirectory, sessionId, input);
      if (appendCount === 2) {
        throw new StorageCommitOutcomeUnknownError(
          new Error("injected directory sync uncertainty"),
        );
      }
      return event;
    },
    appendSessionEvent,
    async (storageDirectory, sessionId) => {
      reconciliationReadCount += 1;
      if (reconciliationReadCount === 1) {
        throw new Error("injected receipt reconciliation read failure");
      }
      return loadSessionEvents(storageDirectory, sessionId);
    },
  );

  await firstCallStarted.promise;
  const submitted = steering.submit(
    "steer-unknown-receipt",
    "Inspect Rhythm instead.",
  );
  await assert.rejects(
    submitted,
    (error: unknown) => error instanceof SteeringPersistenceOutcomeUnknownError,
  );
  await assert.rejects(
    request,
    (error: unknown) => error instanceof SteeringPersistenceOutcomeUnknownError,
  );

  const events = await loadSessionEvents(directory, session.id);
  const persisted = events.find((event) =>
    event.steeringReceipt?.id === "steer-unknown-receipt"
  );
  assert.ok(persisted?.steeringReceipt);
  const retried = await appendSessionEvent(directory, session.id, {
    kind: "user",
    content: "Inspect Rhythm instead.",
    steeringReceipt: persisted.steeringReceipt,
  });
  assert.equal(retried.id, persisted.id);
  assert.equal(
    (await loadSessionEvents(directory, session.id)).filter((event) =>
      event.steeringReceipt?.id === "steer-unknown-receipt"
    ).length,
    1,
  );
  steering.close();
});

test("steering at action index 0 does not create partial recovery without a mutation", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-action-boundary-",
  ));
  const session = await createSession(directory, {
    title: "Action boundary steering",
    projectKey: "project-a",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  const steering = new BoundarySteeringChannel(
    7,
    "steer-before-action-1",
    "Leave the tempo unchanged.",
  );
  const modelInputs: Parameters<NonNullable<Parameters<typeof handleAgentRequest>[7]>>[0][] = [];
  let modelCallCount = 0;
  let tempo = 120;
  let tempoWrites = 0;
  const song = {
    handle: { id: 1n },
    get tempo() {
      return tempo;
    },
    set tempo(value: number) {
      tempoWrites += 1;
      tempo = value;
    },
    gridQuantization: 0,
    gridIsTriplet: false,
    scaleMode: false,
    scaleName: "",
    rootNote: 0,
    tracks: [],
    scenes: [],
    cuePoints: [],
  };

  const result = await handleAgentRequest(
    {
      environment: { storageDirectory: directory },
      application: { song },
    } as never,
    {
      defaultPrompt: "Test",
      summary: "Live Set",
      target: {},
      scope: session.scope,
    },
    "Set the tempo to 128 BPM.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      steering,
      steeringSendId: "send-action-boundary",
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      modelInputs.push(input);
      modelCallCount += 1;
      return modelCallCount === 1
        ? {
            content: null,
            toolCalls: [{
              id: "apply-tempo",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Set the tempo",
                actions: [{ type: "set_tempo", tempo: 128 }],
              }),
            }],
          }
        : { content: "Tempo was left unchanged.", toolCalls: [] };
    },
  );

  await steering.waitForSubmission();
  assert.equal(result, "Tempo was left unchanged.");
  assert.equal(tempo, 120);
  assert.equal(tempoWrites, 0);
  assert.equal(modelInputs.length, 2);
  assert.deepEqual(modelInputs[1]?.agentMessages.at(-1), {
    role: "user",
    content: "Leave the tempo unchanged.",
  });

  const events = await loadSessionEvents(directory, session.id);
  const applyResults = events.filter((event) => event.kind === "apply_result");
  assert.equal(applyResults.length, 1);
  assert.doesNotMatch(
    applyResults[0]?.content ?? "",
    /partially completed|could not complete its first action/i,
  );
  assert.equal(applyResults[0]?.recovery, undefined);
  assert.equal(events.some((event) => event.kind === "error"), false);
  steering.close();
});

test("steering before action 2 preserves completed mutation recovery", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-partial-boundary-",
  ));
  const session = await createSession(directory, {
    title: "Partial action boundary steering",
    projectKey: "project-a",
    scope: { kind: "selection", identity: "selection-1", label: "Live Set" },
  });
  const steering = new BoundarySteeringChannel(
    8,
    "steer-before-action-2",
    "Keep only the first tempo change.",
  );
  const modelInputs: Parameters<NonNullable<Parameters<typeof handleAgentRequest>[7]>>[0][] = [];
  let modelCallCount = 0;
  let tempo = 120;
  let tempoWrites = 0;
  const song = {
    handle: { id: 1n },
    get tempo() {
      return tempo;
    },
    set tempo(value: number) {
      tempoWrites += 1;
      tempo = value;
    },
    gridQuantization: 0,
    gridIsTriplet: false,
    scaleMode: false,
    scaleName: "",
    rootNote: 0,
    tracks: [],
    scenes: [],
    cuePoints: [],
  };

  const result = await handleAgentRequest(
    {
      environment: { storageDirectory: directory },
      application: { song },
    } as never,
    {
      defaultPrompt: "Test",
      summary: "Live Set",
      target: {},
      scope: session.scope,
    },
    "Set the tempo twice.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      steering,
      steeringSendId: "send-partial-boundary",
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      modelInputs.push(input);
      modelCallCount += 1;
      return modelCallCount === 1
        ? {
            content: null,
            toolCalls: [{
              id: "apply-tempo-twice",
              name: "apply_live_actions",
              arguments: JSON.stringify({
                message: "Set the tempo twice",
                actions: [
                  { type: "set_tempo", tempo: 121 },
                  { type: "set_tempo", tempo: 122 },
                ],
              }),
            }],
          }
        : { content: "Kept only the first tempo change.", toolCalls: [] };
    },
  );

  await steering.waitForSubmission();
  assert.match(result, /unfinished Live work/i);
  assert.equal(tempo, 121);
  assert.equal(tempoWrites, 1);
  assert.equal(modelInputs.length, 2);
  assert.deepEqual(modelInputs[1]?.agentMessages.at(-1), {
    role: "user",
    content: "Keep only the first tempo change.",
  });
  const recoveryToolResult = modelInputs[1]?.agentMessages.find(
    (message) => message.role === "tool",
  );
  assert.match(
    recoveryToolResult?.content ?? "",
    /partially completed after 1 action.*Current Live state after the failure:.*Tempo: 121 BPM/is,
  );

  const events = await loadSessionEvents(directory, session.id);
  const applyResults = events.filter((event) => event.kind === "apply_result");
  assert.equal(applyResults.length, 1);
  assert.match(
    applyResults[0]?.content ?? "",
    /partially completed after 1 action.*Completed: Set tempo to 121 BPM.*Failed action 2/is,
  );
  assert.equal(applyResults[0]?.recovery?.active, true);
  assert.ok(applyResults[0]?.recovery?.completedActionDigests.length);
  assert.equal(events.some((event) => event.kind === "error"), true);
  steering.close();
});

test("handleAgentRequest rejects an unpersisted steering submission", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-persistence-",
  ));
  const session = await createSession(directory, {
    title: "Steering failure",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const steering = new SteeringChannel();
  const firstCallStarted = deferred<void>();
  const persistenceFailure = new Error("injected steering persistence failure");
  let appendCount = 0;
  let modelCallCount = 0;

  const request = handleAgentRequest(
    { environment: { storageDirectory: directory } } as never,
    interaction(),
    "Inspect Lead.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: new AbortController().signal,
      steering,
      steeringSendId: "send-persistence-failure",
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      modelCallCount += 1;
      firstCallStarted.resolve(undefined);
      await waitForAbort(input.signal);
      throw input.signal.reason;
    },
    async (storageDirectory, sessionId, input) => {
      appendCount += 1;
      if (appendCount === 2) throw persistenceFailure;
      return appendSessionEvent(storageDirectory, sessionId, input);
    },
  );

  await firstCallStarted.promise;
  const submitted = steering.submit("steer-1", "Inspect Rhythm instead.");
  const submissionRejected = assert.rejects(
    submitted,
    /steering message could not be persisted/i,
  );

  await assert.rejects(request, persistenceFailure);
  await submissionRejected;
  assert.equal(modelCallCount, 1);
  const events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(
    events.filter((event) => event.kind === "user").map((event) => event.content),
    ["Inspect Lead."],
  );
  steering.close();
});

test("Stop lets an in-flight steering persistence report its real commit outcome", async () => {
  const directory = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "live-smith-steering-stop-race-",
  ));
  const session = await createSession(directory, {
    title: "Steering stop race",
    projectKey: "project-a",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  const steering = new SteeringChannel();
  const parent = new AbortController();
  const firstCallStarted = deferred<void>();
  const steeringAppendStarted = deferred<void>();
  const releaseSteeringAppend = deferred<void>();
  let appendCount = 0;

  const request = handleAgentRequest(
    { environment: { storageDirectory: directory } } as never,
    interaction(),
    "Inspect Lead.",
    { profile, capabilities: resolveModelCapabilities(profile) },
    "project-a",
    session.id,
    {
      signal: parent.signal,
      steering,
      steeringSendId: "send-stop-race",
      onDelta: () => {},
      onProgress: () => {},
      onSessionEvent: () => {},
      confirmActions: async () => true,
    },
    async (input) => {
      firstCallStarted.resolve(undefined);
      await waitForAbort(input.signal);
      throw input.signal.reason;
    },
    async (storageDirectory, sessionId, input) => {
      appendCount += 1;
      if (appendCount === 2) {
        steeringAppendStarted.resolve(undefined);
        await releaseSteeringAppend.promise;
      }
      return appendSessionEvent(storageDirectory, sessionId, input);
    },
  );

  await firstCallStarted.promise;
  const submitted = steering.submit("steer-stop", "Inspect Rhythm instead.");
  await steeringAppendStarted.promise;
  const stopped = new SteeringClosedError("Stopped by user.");
  steering.close(stopped);
  parent.abort(stopped);
  const requestStopped = assert.rejects(
    request,
    (error: unknown) => error === stopped,
  );

  assert.equal(await remainsPending(submitted), true);
  releaseSteeringAppend.resolve(undefined);
  await submitted;
  await requestStopped;

  const events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(
    events.filter((event) => event.kind === "user").map((event) => event.content),
    ["Inspect Lead.", "Inspect Rhythm instead."],
  );
});

function interaction() {
  return {
    defaultPrompt: "Inspect",
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

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
  ]);
}

class BoundarySteeringChannel extends SteeringChannel {
  private hasPendingCheckCount = 0;
  private submission: Promise<void> | undefined;

  constructor(
    private readonly submitOnCheck: number,
    private readonly steeringId: string,
    private readonly steeringPrompt: string,
  ) {
    super();
  }

  override hasPending(): boolean {
    this.hasPendingCheckCount += 1;
    // Model-turn setup and the loop perform six checks before the executor's
    // first per-action boundary, then one more check before each later action.
    if (this.hasPendingCheckCount === this.submitOnCheck) {
      this.submission = this.submit(this.steeringId, this.steeringPrompt);
    }
    return super.hasPending();
  }

  async waitForSubmission(): Promise<void> {
    assert.ok(this.submission, "Expected steering to reach the action boundary");
    await this.submission;
  }
}
