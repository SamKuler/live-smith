import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import type { LiveInteractionContext } from "../live/context.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import type { SavedProfile } from "../model/profile.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveModelCache } from "../storage/model-cache.js";
import { createSession, listSessions } from "../storage/sessions.js";
import { saveGlobalSettings, saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { modelStateSourceForProfile } from "../ui/chat-state.js";
import { autoApproveEnabledForPlan, runAgentFlow } from "./agent-flow.js";
import { getOrCreateDefaultSession } from "./session-context.js";

test("Auto approve is reread for each new plan and never bypasses explicit confirmation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-auto-approve-"));
  const undoablePlan = {
    message: "Set tempo",
    actions: [{ type: "set_tempo" as const, tempo: 128 }],
  };
  const destructivePlan = {
    message: "Delete Bass",
    actions: [{ type: "delete_track" as const, trackName: "Bass" }],
  };

  await saveGlobalSettings(directory, { autoApprove: false });
  assert.equal(await autoApproveEnabledForPlan(directory, undoablePlan), false);

  await saveGlobalSettings(directory, { autoApprove: true });
  assert.equal(await autoApproveEnabledForPlan(directory, undoablePlan), true);
  assert.equal(await autoApproveEnabledForPlan(directory, destructivePlan), false);
});

test("concurrent state and discovery responses each keep models, capabilities, and source from one profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-state-race-"));
  const profileA = profile({
    baseUrl: "https://provider-a.test/v1",
    apiKey: "key-a",
    model: "model-a",
  });
  const profileB = profile({
    baseUrl: "https://provider-b.test/v1",
    apiKey: "key-b",
    model: "model-b",
  });
  const modelsA = [discoveredModel("model-a", 1_111)];
  const modelsB = [discoveredModel("model-b", 2_222)];
  await saveSavedProfile(directory, profileA);
  await saveModelCache(directory, profileA, modelsA);

  const discoveryGate = deferred<void>();
  const discoveryStarted = deferred<void>();

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;

        const initialResponse = await fetch(endpoint("/state"));
        assert.equal(initialResponse.status, 200);
        const initialState = await initialResponse.json() as ChatDialogState;
        assertStateMatches(initialState, profileA, modelsA);

        const discoveryResponsePromise = fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "discover_models", profile: profileB }),
        });
        await discoveryStarted.promise;

        let concurrentStateSettled = false;
        const concurrentStatePromise = fetch(endpoint("/state")).then((response) => {
          concurrentStateSettled = true;
          return response;
        });
        const stateBeforeDiscoveryTerminal = await Promise.race([
          concurrentStatePromise.then(() => "settled" as const),
          new Promise<"pending">((resolve) => {
            setTimeout(() => resolve("pending"), 100);
          }),
        ]);
        assert.equal(stateBeforeDiscoveryTerminal, "pending");
        assert.equal(concurrentStateSettled, false);

        discoveryGate.resolve();
        const discoveryResponse = await discoveryResponsePromise;
        assert.equal(discoveryResponse.status, 200);
        const discoveryState = await discoveryResponse.json() as ChatDialogState;
        assertStateMatches(discoveryState, profileB, modelsB);

        const concurrentStateResponse = await concurrentStatePromise;
        assert.equal(concurrentStateResponse.status, 200);
        const concurrentState = await concurrentStateResponse.json() as ChatDialogState;
        assertStateMatches(concurrentState, profileA, modelsA);
      },
    },
  };
  const interaction: LiveInteractionContext = {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    listModels: async () => {
      discoveryStarted.resolve();
      await discoveryGate.promise;
      return modelsB;
    },
  });
});

test("model discovery accepts a Draft with blank name and model without changing Runtime", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-blank-draft-"));
  const active = profile({
    baseUrl: "https://active.test/v1",
    apiKey: "active-key",
    model: "active-model",
  });
  await saveSavedProfile(directory, active);
  const draft = {
    ...profile({
      baseUrl: "https://draft.test/v1",
      apiKey: "draft-key",
      model: "draft-model",
    }),
    name: "",
    model: "",
  };
  const discovered = [discoveredModel("draft-model", 4_096)];

  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const response = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "discover_models", profile: draft }),
          },
        );
        assert.equal(response.status, 200);
        const state = await response.json() as ChatDialogState;
        assert.equal(state.modelStateSource?.model, "");
        assert.deepEqual(state.availableModels.map((model) => model.id), ["draft-model"]);
        assert.equal(state.runtimeProfile?.profile.name, active.name);
        assert.equal(state.runtimeProfile?.profile.model, active.model);
      },
    },
  };

  await runAgentFlow(context as never, {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, {
    renderHtml: () => "<html></html>",
    listModels: async (receivedDraft) => {
      assert.equal(receivedDraft.name, "");
      assert.equal(receivedDraft.model, "");
      return discovered;
    },
  });
});

test("a failed event-log deletion keeps session metadata available for retry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-retry-"));
  let deletedSessionId = "";
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initialState = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initialState.activeSessionId;
        const eventPath = path.join(
          directory,
          "live-smith-events",
          `${deletedSessionId}.json`,
        );
        await fs.mkdir(eventPath, { recursive: true });

        const failed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });
        assert.equal(failed.status, 500);
        assert.ok(
          (await listSessions(directory)).some((session) => session.id === deletedSessionId),
        );

        await fs.rmdir(eventPath);
        const retried = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });
        assert.equal(retried.status, 200);
        assert.ok(
          !(await listSessions(directory)).some((session) => session.id === deletedSessionId),
        );
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    { renderHtml: () => "<html></html>" },
  );
  assert.ok(deletedSessionId);
});

test("a post-commit state failure is reconciled as an unknown command outcome", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-command-reconcile-"));
  let sessionLookupCount = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const response = await fetch(`${chatUrl.origin}/command?token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "new_session" }),
        });
        const body = await response.json() as {
          commandOutcome?: string;
          reconciliationRequired?: boolean;
          state?: ChatDialogState;
        };

        assert.equal(response.status, 500);
        assert.equal(body.commandOutcome, "unknown");
        assert.equal(body.reconciliationRequired, undefined);
        assert.equal(body.state?.sessions.length, 1);
        assert.equal(body.state?.activeSessionId, body.state?.sessions[0]?.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    },
    {
      renderHtml: () => "<html></html>",
      getOrCreateDefaultSession: async (...args) => {
        sessionLookupCount += 1;
        if (sessionLookupCount === 1) throw new Error("state unavailable after commit");
        return getOrCreateDefaultSession(...args);
      },
    },
  );

  assert.equal((await listSessions(directory)).length, 1);
});

test("selecting a Track Session refreshes context from that Session's Live object", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-target-switch-"));
  const trackA = fakeMidiTrack(101n, "Bass");
  const trackB = fakeMidiTrack(202n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [trackA, trackB], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(initial.contextSummary, /MIDI track "Bass"/);
        const leadSession = await createSession(directory, {
          title: "Lead session",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "202", label: "Lead" },
        });

        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "select_session", sessionId: leadSession.id }),
        });
        const selectedState = await selected.json() as ChatDialogState;
        assert.equal(selectedState.activeSessionId, leadSession.id);
        assert.match(selectedState.contextSummary, /MIDI track "Lead"/);
        assert.doesNotMatch(selectedState.contextSummary, /MIDI track "Bass"/);

        trackB.name = "Lead renamed";
        const refreshed = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(refreshed.contextSummary, /Lead renamed/);

        context.application.song.tracks.splice(1, 1);
        const unavailable = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
        const send = await fetch(endpoint("/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Change this track", sessionId: leadSession.id }),
        });
        assert.equal(send.status, 500);
        assert.match((await send.json() as { error: string }).error, /no longer available/i);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "Opening Bass context",
      target: { track: trackA },
      scope: { kind: "track", identity: "101", label: "Bass" },
    },
    { renderHtml: () => "<html></html>" },
  );
});

test("a late state snapshot cannot roll active Session back after a switch", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-session-cas-"));
  const lookupStarted = deferred<void>();
  const releaseLookup = deferred<void>();
  let lookupCount = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionB = await createSession(directory, {
          title: "Session B",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "track-2", label: "Track B" },
        });

        const lateStatePromise = fetch(endpoint("/state"));
        await lookupStarted.promise;
        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "select_session", sessionId: sessionB.id }),
        });
        assert.equal((await selected.json() as ChatDialogState).activeSessionId, sessionB.id);

        releaseLookup.resolve();
        const lateState = await (await lateStatePromise).json() as ChatDialogState;
        assert.equal(lateState.activeSessionId, sessionB.id);
        const authoritative = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.equal(authoritative.activeSessionId, sessionB.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "Track A",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Track A" },
    },
    {
      renderHtml: () => "<html></html>",
      getOrCreateDefaultSession: async (...args) => {
        lookupCount += 1;
        if (lookupCount === 2) {
          lookupStarted.resolve();
          await releaseLookup.promise;
        }
        return getOrCreateDefaultSession(...args);
      },
    },
  );
});

test("a state snapshot retries when Session changes while its events are loading", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-cas-"));
  const eventsLoadStarted = deferred<void>();
  const releaseEventsLoad = deferred<void>();
  let eventsLoadCount = 0;
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        const sessionB = await createSession(directory, {
          title: "Session B",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "track-2", label: "Track B" },
        });

        const lateStatePromise = fetch(endpoint("/state"));
        await eventsLoadStarted.promise;
        const selected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "select_session", sessionId: sessionB.id }),
        });
        assert.equal((await selected.json() as ChatDialogState).activeSessionId, sessionB.id);

        releaseEventsLoad.resolve();
        const lateState = await (await lateStatePromise).json() as ChatDialogState;
        assert.equal(lateState.activeSessionId, sessionB.id);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "Track A",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Track A" },
    },
    {
      renderHtml: () => "<html></html>",
      loadSessionEvents: async (...args) => {
        eventsLoadCount += 1;
        if (eventsLoadCount === 2) {
          eventsLoadStarted.resolve();
          await releaseEventsLoad.promise;
        }
        return loadSessionEvents(...args);
      },
    },
  );
});

test("a prior-activation Session is restored only to the server-owned current Live object", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-restore-"));
  const previous = await createSession(directory, {
    title: "Previous Bass arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-bass-handle", label: "Bass" },
  });
  const currentTrack = fakeMidiTrack(20n, "Bass");
  let currentProjectKey = "";
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [currentTrack], scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        currentProjectKey = initial.sessions[0]!.projectKey;
        assert.deepEqual(
          initial.recoverableSessions.map((session) => session.id),
          [previous.id],
        );

        const rejected = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: previous.id,
            projectKey: "attacker-controlled",
            scope: { kind: "track", identity: "attacker-controlled", label: "Wrong" },
          }),
        });
        assert.equal(rejected.status, 400);

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: previous.id,
          }),
        });
        assert.equal(response.status, 200);
        const restored = await response.json() as ChatDialogState;
        assert.equal(restored.activeSessionId, previous.id);
        assert.deepEqual(restored.recoverableSessions, []);
        const restoredSession = restored.sessions.find(
          (session) => session.id === previous.id,
        );
        assert.equal(restoredSession?.projectKey, currentProjectKey);
        assert.deepEqual(restoredSession?.scope, {
          kind: "track",
          identity: "20",
          label: "Bass",
        });
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "MIDI track Bass",
      target: { track: currentTrack },
      scope: { kind: "track", identity: "20", label: "Bass" },
    },
    { renderHtml: () => "<html></html>" },
  );

  const persisted = (await listSessions(directory)).find(
    (session) => session.id === previous.id,
  );
  assert.equal(persisted?.projectKey, currentProjectKey);
  assert.deepEqual(persisted?.scope, {
    kind: "track",
    identity: "20",
    label: "Bass",
  });
});

function fakeMidiTrack(id: bigint, name: string): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { configurable: true, enumerable: true, value: name, writable: true },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
}

function profile(
  values: Pick<SavedProfile, "baseUrl" | "apiKey" | "model">,
): SavedProfile {
  return {
    id: "profile-1",
    name: "Provider",
    apiFamily: "openai",
    apiMode: "responses",
    ...values,
    parameters: {
      maxOutputTokens: 1_000,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

function discoveredModel(id: string, maxOutputTokens: number): DiscoveredModelInfo {
  return {
    id,
    displayName: id,
    capabilities: { maxOutputTokens },
  };
}

function assertStateMatches(
  state: ChatDialogState,
  expectedProfile: SavedProfile,
  expectedModels: DiscoveredModelInfo[],
): void {
  assert.deepEqual(state.modelStateSource, modelStateSourceForProfile(expectedProfile));
  assert.deepEqual(
    state.availableModels.map((model) => model.id),
    expectedModels.map((model) => model.id),
  );
  assert.equal(
    state.capabilities.maxOutputTokens,
    expectedModels[0]?.capabilities.maxOutputTokens,
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
