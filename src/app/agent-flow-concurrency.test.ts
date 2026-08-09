import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ClipSlot, MidiTrack } from "@ableton-extensions/sdk";

import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  type LiveInteractionContext,
} from "../live/context.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import type { SavedProfile } from "../model/profile.js";
import {
  listSessionAttachments,
  saveSessionAttachment,
} from "../storage/attachments.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveModelCache } from "../storage/model-cache.js";
import { createSession, listSessions } from "../storage/sessions.js";
import { saveGlobalSettings, saveSavedProfile } from "../storage/settings.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { modelStateSourceForProfile } from "../ui/chat-state.js";
import {
  decidePlanApproval,
  runAgentFlow,
} from "./agent-flow.js";
import { getOrCreateDefaultSession } from "./session-context.js";

test("approval decisions follow Manual, Low Risk, and Accept Everything modes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-approval-decision-"));
  const lowRiskPlan = {
    message: "Set tempo",
    actions: [{ type: "set_tempo" as const, tempo: 128 }],
  };
  const explicitPlan = {
    message: "Delete Bass",
    actions: [{ type: "delete_track" as const, trackName: "Bass" }],
  };
  let promptCalls = 0;
  const requestConfirmation = async () => {
    promptCalls += 1;
    return true;
  };

  await saveGlobalSettings(directory, { approvalMode: "manual" });
  assert.deepEqual(
    await decidePlanApproval(directory, lowRiskPlan, requestConfirmation),
    { confirmed: true, source: "user" },
  );
  assert.deepEqual(
    await decidePlanApproval(directory, explicitPlan, requestConfirmation),
    { confirmed: true, source: "user" },
  );
  assert.equal(promptCalls, 2);

  await saveGlobalSettings(directory, { approvalMode: "low-risk" });
  assert.deepEqual(
    await decidePlanApproval(directory, lowRiskPlan, requestConfirmation),
    { confirmed: true, source: "automatic", mode: "low-risk" },
  );
  assert.equal(promptCalls, 2);
  assert.deepEqual(
    await decidePlanApproval(directory, explicitPlan, requestConfirmation),
    { confirmed: true, source: "user" },
  );
  assert.equal(promptCalls, 3);

  await saveGlobalSettings(directory, { approvalMode: "everything" });
  assert.deepEqual(
    await decidePlanApproval(directory, lowRiskPlan, requestConfirmation),
    { confirmed: true, source: "automatic", mode: "everything" },
  );
  assert.deepEqual(
    await decidePlanApproval(directory, explicitPlan, requestConfirmation),
    { confirmed: true, source: "automatic", mode: "everything" },
  );
  assert.equal(promptCalls, 3);
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

test("session deletion removes attachments only after events and metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-attachments-"));
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
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        deletedSessionId = initial.activeSessionId;
        await saveSessionAttachment(directory, deletedSessionId, {
          fileName: "reference.png",
          bytes: new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
          ]),
        });

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });

        assert.equal(response.status, 200);
        assert.ok(!(await listSessions(directory)).some(
          (session) => session.id === deletedSessionId,
        ));
        assert.deepEqual(await listSessionAttachments(directory, deletedSessionId), []);
      },
    },
  };

  await runAgentFlow(context as never, {
    defaultPrompt: "Test prompt",
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  }, { renderHtml: () => "<html></html>" });
  assert.ok(deletedSessionId);
});

test("session deletion attachment cleanup failure leaves the Session deleted", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-delete-orphan-"));
  let deletedSessionId = "";
  let attachmentRoot = "";
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
        deletedSessionId = initial.activeSessionId;
        await saveSessionAttachment(directory, deletedSessionId, {
          fileName: "reference.png",
          bytes: new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
          ]),
        });
        attachmentRoot = path.join(directory, "live-smith-attachments");
        await fs.chmod(attachmentRoot, 0o500);

        const response = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "delete_session", sessionId: deletedSessionId }),
        });

        assert.equal(response.status, 500);
        assert.ok(!(await listSessions(directory)).some(
          (session) => session.id === deletedSessionId,
        ));
      },
    },
  };

  try {
    await runAgentFlow(context as never, {
      defaultPrompt: "Test prompt",
      summary: "Track: Lead",
      target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    }, { renderHtml: () => "<html></html>" });
  } finally {
    if (attachmentRoot) await fs.chmod(attachmentRoot, 0o700).catch(() => undefined);
  }
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
        assert.equal(body.state?.sessions[0]?.title, "");
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

test("opening an Arrangement selection keeps its bounded selection context", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-context-"),
  );
  await saveSavedProfile(directory, profile({
    baseUrl: "https://selection-context.test/v1",
    apiKey: "selection-context-key",
    model: "selection-context-model",
  }));
  let modelLiveContext = "";
  const track = fakeMidiTrack(101n, "Bass");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [track], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => track,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const state = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;

        assert.match(state.contextSummary, /Arrangement selection: beats 8 to 16/);
        assert.match(state.contextSummary, /Lane 1: MIDI track "Bass"/);
        assert.equal(
          state.defaultPrompt,
          "Analyze this arrangement selection and suggest the next useful production move.",
        );
        const send = await fetch(`${chatUrl.origin}/send?token=${token}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "send-selection-context",
          },
          body: JSON.stringify({
            prompt: "Work with this selection",
            sessionId: state.activeSessionId,
          }),
        });
        assert.equal(send.status, 200);
        assert.match(modelLiveContext, /Arrangement selection: beats 8 to 16/);

        const newSelectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "new_session" }),
          },
        );
        const newSelectionState = await newSelectionResponse.json() as ChatDialogState;
        assert.notEqual(newSelectionState.activeSessionId, state.activeSessionId);
        assert.match(
          newSelectionState.contextSummary,
          /Arrangement selection: beats 8 to 16/,
        );

        const ordinarySession = await createSession(directory, {
          title: "Ordinary Bass Session",
          projectKey: state.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "101", label: "Bass" },
        });
        const ordinaryResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "select_session",
              sessionId: ordinarySession.id,
            }),
          },
        );
        const ordinaryState = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinaryState.contextSummary, /MIDI track "Bass"/);
        assert.doesNotMatch(ordinaryState.contextSummary, /Arrangement selection/);

        track.name = "Bass renamed";
        const refreshedOrdinary = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(refreshedOrdinary.contextSummary, /MIDI track "Bass renamed"/);

        const selectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "select_session",
              sessionId: state.activeSessionId,
            }),
          },
        );
        const selectionState = await selectionResponse.json() as ChatDialogState;
        assert.match(selectionState.contextSummary, /Arrangement selection/);

        context.application.song.tracks.splice(0, 1);
        const unavailable = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [track.handle],
      time_selection_start: 8,
      time_selection_end: 16,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    requestModelTurn: async (request) => {
      modelLiveContext = request.liveContext;
      return { content: "Selection received.", toolCalls: [] };
    },
  });
});

test("a concurrent Session switch cannot capture an unresolved invocation selection", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-selection-bind-race-"),
  );
  const initialLookupStarted = deferred<string>();
  const releaseInitialLookup = deferred<void>();
  let lookupCount = 0;
  const bass = fakeMidiTrack(101n, "Bass");
  const lead = fakeMidiTrack(202n, "Lead");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [bass, lead], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => bass,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const lateInitialState = fetch(endpoint("/state"));
        const projectKey = await initialLookupStarted.promise;
        const leadSession = await createSession(directory, {
          title: "Ordinary Lead Session",
          projectKey,
          scope: { kind: "track", identity: "202", label: "Lead" },
        });

        let selectedState: ChatDialogState;
        try {
          const selected = await fetch(endpoint("/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "select_session",
              sessionId: leadSession.id,
            }),
          });
          selectedState = await selected.json() as ChatDialogState;
        } finally {
          releaseInitialLookup.resolve();
        }

        const reconciled = await (await lateInitialState).json() as ChatDialogState;
        assert.equal(selectedState.activeSessionId, leadSession.id);
        assert.match(selectedState.contextSummary, /MIDI track "Lead"/);
        assert.doesNotMatch(selectedState.contextSummary, /Arrangement selection/);
        assert.equal(reconciled.activeSessionId, leadSession.id);
        assert.match(reconciled.contextSummary, /MIDI track "Lead"/);
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [bass.handle],
      time_selection_start: 8,
      time_selection_end: 16,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    getOrCreateDefaultSession: async (...args) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        initialLookupStarted.resolve(args[2]);
        await releaseInitialLookup.promise;
      }
      return getOrCreateDefaultSession(...args);
    },
  });
});

test("restoring a historical Session binds only that Session to the current selection", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-selection-restore-"),
  );
  const historical = await createSession(directory, {
    title: "Historical arrangement work",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-track", label: "Old track" },
  });
  const bass = fakeMidiTrack(101n, "Bass");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [bass], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => bass,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(initial.contextSummary, /Arrangement selection: beats 4 to 12/);

        const restoredResponse = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: historical.id,
          }),
        });
        const restored = await restoredResponse.json() as ChatDialogState;
        assert.equal(restored.activeSessionId, historical.id);
        assert.match(restored.contextSummary, /Arrangement selection: beats 4 to 12/);
        assert.deepEqual(
          restored.sessions.find((session) => session.id === historical.id)?.scope,
          { kind: "track", identity: "101", label: "Bass" },
        );

        const ordinarySession = await createSession(directory, {
          title: "Ordinary Bass Session",
          projectKey: restored.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "101", label: "Bass" },
        });
        const ordinaryResponse = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "select_session",
            sessionId: ordinarySession.id,
          }),
        });
        const ordinary = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinary.contextSummary, /MIDI track "Bass"/);
        assert.doesNotMatch(ordinary.contextSummary, /Arrangement selection/);
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [bass.handle],
      time_selection_start: 4,
      time_selection_end: 12,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });
});

test("a cross-track Clip Slot selection becomes unavailable when any selected Track disappears", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-clip-slot-context-"),
  );
  const bass = fakeMidiTrackWithSlots(301n, "Bass", 2);
  const lead = fakeMidiTrackWithSlots(302n, "Lead", 2);
  const selectedBassSlot = bass.slots[1]!;
  const selectedLeadSlot = lead.slots[0]!;
  const slotsById = new Map(
    [...bass.slots, ...lead.slots].map((slot) => [slot.handle.id, slot]),
  );
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tracks: [bass.track, lead.track],
        scenes: [],
      },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: (handle: { id: bigint }) => slotsById.get(handle.id),
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(initial.contextSummary, /track "Bass", slotIndex=1/);
        assert.match(initial.contextSummary, /track "Lead", slotIndex=0/);

        bass.slots.reverse();
        const reordered = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(reordered.contextSummary, /track "Bass", slotIndex=0/);

        context.application.song.tracks.splice(1, 1);
        const unavailable = await (
          await fetch(endpoint("/state"))
        ).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
      },
    },
  };
  const interaction = clipSlotSelectionInteractionContext(
    context as never,
    {
      selected_clip_slots: [selectedBassSlot.handle, selectedLeadSlot.handle],
    },
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });
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
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
  });
  const obsolete = await createSession(directory, {
    title: "Obsolete clip notes",
    projectKey: "previous-activation",
    scope: { kind: "clip", identity: "old-clip-handle", label: "Chorus" },
  });
  const currentTrack = fakeMidiTrack(20n, "Drums");
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
        assert.deepEqual(initial.sessionContinueTarget, {
          kind: "track",
          label: "Drums",
        });
        assert.deepEqual(
          initial.previousSessions.map((session) => session.id),
          [obsolete.id, previous.id],
        );
        assert.deepEqual(initial.archivedSessions, []);

        const deleted = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "delete_session", sessionId: obsolete.id }),
        });
        assert.equal(deleted.status, 200);
        assert.deepEqual(
          (await deleted.json() as ChatDialogState).previousSessions.map(
            (session) => session.id,
          ),
          [previous.id],
        );

        const renamed = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "rename_session",
            sessionId: previous.id,
            title: "Renamed previous Session",
          }),
        });
        assert.equal(renamed.status, 200);
        assert.equal(
          ((await renamed.json() as ChatDialogState).previousSessions[0]?.title),
          "Renamed previous Session",
        );

        const archived = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "archive_session", sessionId: previous.id }),
        });
        assert.equal(archived.status, 200);
        const archivedState = await archived.json() as ChatDialogState;
        assert.deepEqual(archivedState.previousSessions, []);
        assert.equal(archivedState.archivedSessions[0]?.id, previous.id);

        const unarchived = await fetch(endpoint("/command"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "unarchive_session", sessionId: previous.id }),
        });
        assert.equal(unarchived.status, 200);
        const unarchivedState = await unarchived.json() as ChatDialogState;
        assert.equal(unarchivedState.previousSessions[0]?.id, previous.id);
        assert.deepEqual(unarchivedState.archivedSessions, []);

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
        assert.deepEqual(restored.previousSessions, []);
        const restoredSession = restored.sessions.find(
          (session) => session.id === previous.id,
        );
        assert.equal(restoredSession?.projectKey, currentProjectKey);
        assert.deepEqual(restoredSession?.scope, {
          kind: "track",
          identity: "20",
          label: "Drums",
        });
        assert.deepEqual(restoredSession?.originScope, previous.scope);
        assert.match(restored.status ?? "", /ready on the current track.*Drums/i);
      },
    },
  };

  await runAgentFlow(
    context as never,
    {
      defaultPrompt: "Test prompt",
      summary: "MIDI track Drums",
      target: { track: currentTrack },
      scope: { kind: "track", identity: "20", label: "Drums" },
    },
    { renderHtml: () => "<html></html>" },
  );

  const persisted = (await listSessions(directory)).find(
    (session) => session.id === previous.id,
  );
  assert.equal(
    (await listSessions(directory)).some((session) => session.id === obsolete.id),
    false,
  );
  assert.equal(persisted?.projectKey, currentProjectKey);
  assert.deepEqual(persisted?.scope, {
    kind: "track",
    identity: "20",
    label: "Drums",
  });
  assert.deepEqual(persisted?.originScope, previous.scope);
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

function fakeMidiTrackWithSlots(
  id: bigint,
  name: string,
  slotCount: number,
): { track: MidiTrack<"1.0.0">; slots: ClipSlot<"1.0.0">[] } {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: name },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
  const slots = Array.from({ length: slotCount }, (_, index) =>
    Object.defineProperties(Object.create(ClipSlot.prototype), {
      handle: { enumerable: true, value: { id: id * 100n + BigInt(index) } },
      clip: { enumerable: true, value: null },
      parent: { enumerable: true, value: track },
    }) as ClipSlot<"1.0.0">
  );
  Object.defineProperty(track, "clipSlots", { enumerable: true, value: slots });
  return { track, slots };
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
