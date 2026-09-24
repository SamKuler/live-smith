import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import {
  arrangementSelectionInteractionContext,
  type LiveInteractionContext,
} from "../live/context.js";
import type { SavedProfile } from "../model/profile.js";
import { saveSavedProfile } from "../storage/settings.js";
import { createSession } from "../storage/sessions.js";
import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";

test("state summary and presentation consume the same resolved selection interaction", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-context-projection-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let refreshCount = 0;
  const interaction: LiveInteractionContext = {
    summary: "Opening selection",
    presentation: {
      origin: "arrangement-selection", objectKind: "other", title: "Opening selection", details: [],
    },
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
    selectionContext: {
      refresh: () => {
        const observation = `Observation ${++refreshCount}`;
        return {
          ...interaction,
          summary: observation,
          presentation: { ...interaction.presentation, title: observation },
        };
      },
    },
  };
  const context = {
    application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const projected = await state(endpoint(url));
      assert.equal(projected.liveContext.availability, "available");
      assert.equal(projected.liveContext.sessionId, projected.activeSessionId);
      assert.equal(projected.liveContext.value.title, projected.contextSummary);
      assert.notEqual(projected.contextSummary, interaction.summary);
    } },
  };
  await runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
});

test("opening an Arrangement selection keeps its bounded selection context", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-context-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, profile());
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
        assert.deepEqual(state.liveContext, {
          sessionId: state.activeSessionId,
          availability: "available",
          value: {
            origin: "arrangement-selection", objectKind: "other", title: "Arrangement selection",
            details: ['MIDI track "Bass"'],
            range: { coordinate: "arrangement-beats", start: 8, end: 16 },
          },
        });
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
        assert.equal(modelLiveContext, state.contextSummary);

        const newSelectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-1"),
            body: JSON.stringify({ kind: "new_session" }),
          },
        );
        const newSelectionState = await newSelectionResponse.json() as ChatDialogState;
        assert.notEqual(newSelectionState.activeSessionId, state.activeSessionId);
        assert.match(
          newSelectionState.contextSummary,
          /Arrangement selection: beats 8 to 16/,
        );
        assert.deepEqual(newSelectionState.liveContext, {
          ...state.liveContext, sessionId: newSelectionState.activeSessionId,
        });

        const ordinarySession = await createSession(directory, {
          title: "Ordinary Bass Session",
          projectKey: state.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "101", label: "Bass" },
        });
        const ordinaryResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-2"),
            body: JSON.stringify({
              kind: "select_session",
              sessionId: ordinarySession.id,
            }),
          },
        );
        const ordinaryState = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinaryState.contextSummary, /MIDI track "Bass"/);
        assert.doesNotMatch(ordinaryState.contextSummary, /Arrangement selection/);
        assert.deepEqual(ordinaryState.liveContext, {
          sessionId: ordinarySession.id,
          availability: "available",
          value: { origin: "object", objectKind: "track", title: "Bass", details: ["MIDI track"] },
        });

        track.name = "Bass renamed";
        const refreshedOrdinary = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(refreshedOrdinary.contextSummary, /MIDI track "Bass renamed"/);

        const selectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-3"),
            body: JSON.stringify({
              kind: "select_session",
              sessionId: state.activeSessionId,
            }),
          },
        );
        const selectionState = await selectionResponse.json() as ChatDialogState;
        assert.match(selectionState.contextSummary, /Arrangement selection/);
        assert.equal(selectionState.liveContext.availability, "available");
        assert.equal(selectionState.liveContext.value.origin, "arrangement-selection");
        assert.deepEqual(selectionState.liveContext.value.details, ['MIDI track "Bass renamed"']);

        context.application.song.tracks.splice(0, 1);
        const unavailable = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
        assert.deepEqual(unavailable.liveContext, {
          sessionId: state.activeSessionId, availability: "unavailable", label: "Bass",
        });
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

test("restoring a historical Session binds only that Session to the current selection", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-selection-restore-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const historical = await createSession(directory, {
    title: "Historical arrangement work",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-track", label: "Bass" },
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
        assert.notEqual(initial.activeSessionId, historical.id);
        assert.equal(initial.liveContext.sessionId, initial.activeSessionId);
        assert.deepEqual(initial.previousSessions[0]?.scope, historical.scope);

        const restoredResponse = await fetch(endpoint("/command"), {
          method: "POST",
          headers: jsonHeaders("context-command-4"),
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: historical.id,
          }),
        });
        const restored = await restoredResponse.json() as ChatDialogState;
        assert.equal(restored.activeSessionId, historical.id);
        assert.match(restored.contextSummary, /Arrangement selection: beats 4 to 12/);
        assert.deepEqual(restored.liveContext, {
          ...initial.liveContext, sessionId: historical.id,
        });
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
          headers: jsonHeaders("context-command-5"),
          body: JSON.stringify({
            kind: "select_session",
            sessionId: ordinarySession.id,
          }),
        });
        const ordinary = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinary.contextSummary, /MIDI track "Bass"/);
        assert.doesNotMatch(ordinary.contextSummary, /Arrangement selection/);
        assert.equal(ordinary.liveContext.availability, "available");
        assert.equal(ordinary.liveContext.sessionId, ordinarySession.id);
        assert.equal(ordinary.liveContext.value.origin, "object");
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

interface DialogEndpoint {
  endpoint(pathname: string): string;
}

function endpoint(chatUrl: string): DialogEndpoint {
  const url = new URL(chatUrl);
  const token = url.searchParams.get("token")!;
  return {
    endpoint: (pathname) =>
      `${url.origin}${pathname}?token=${encodeURIComponent(token)}`,
  };
}

async function state(
  dialog: DialogEndpoint,
  sessionId?: string,
): Promise<ChatBridgeState> {
  const url = dialog.endpoint("/state") + (sessionId === undefined
    ? ""
    : `&sessionId=${encodeURIComponent(sessionId)}`);
  return await (await fetch(url)).json() as ChatBridgeState;
}

function jsonHeaders(id: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": id,
    "X-Live-Smith-Send-Id": id,
  };
}

function fakeMidiTrack(id = 1n, name = "Lead"): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: name, writable: true },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: null },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
}

function profile(): SavedProfile {
  return {
    id: "profile-1",
    name: "Provider",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: {
        maxOutputTokens: 1_000,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}
