import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import {
  arrangementSelectionInteractionContext,
  interactionContextForScope,
  type LiveInteractionContext,
} from "../live/context.js";
import type { SavedProfile } from "../model/profile.js";
import { loadSessionEvents } from "../storage/events.js";
import { saveSavedProfile } from "../storage/settings.js";
import { createSession, updateSession } from "../storage/sessions.js";
import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow, type AgentFlowDependencies } from "./agent-flow.js";

test("two open modals do not automatically share a claimed empty transient Session", async (t) => {
  const fixture = await openTwoDialogs({}, {});
  t.after(fixture.close);
  assert.notEqual(fixture.firstState.activeSessionId, fixture.secondState.activeSessionId);

  const selected = await fetch(fixture.second.endpoint("/command"), {
    method: "POST",
    headers: jsonHeaders("select-shared-empty"),
    body: JSON.stringify({
      kind: "select_session",
      sessionId: fixture.firstState.activeSessionId,
    }),
  });
  assert.equal(selected.status, 200);
  assert.equal(
    (await selected.json() as ChatDialogState).activeSessionId,
    fixture.firstState.activeSessionId,
  );
});

test("switching to another modal's Session projects its bound object and never a same-name replacement", async (t) => {
  const bass = fakeMidiTrack(2n, "Bass");
  const fixture = await openTwoDialogs({}, {}, false, bass);
  t.after(fixture.close);
  const leadSessionId = fixture.firstState.activeSessionId;
  assert.equal(fixture.secondState.liveContext.availability, "available");
  assert.equal(fixture.secondState.liveContext.value.title, "Bass");

  const selected = await fetch(fixture.second.endpoint("/command"), {
    method: "POST",
    headers: jsonHeaders("select-other-object"),
    body: JSON.stringify({ kind: "select_session", sessionId: leadSessionId }),
  });
  assert.equal(selected.status, 200);
  const leadState = await selected.json() as ChatDialogState;
  assert.equal(leadState.activeSessionId, leadSessionId);
  assert.match(leadState.contextSummary, /MIDI track "Lead"/);
  assert.deepEqual(leadState.liveContext, {
    sessionId: leadSessionId,
    availability: "available",
    value: { origin: "object", objectKind: "track", title: "Lead", details: ["MIDI track"] },
  });
  assert.equal(leadState.sessionContinueTarget.label, "Bass");

  fixture.tracks[0]!.name = "Lead renamed";
  const renamed = await state(fixture.second);
  assert.match(renamed.contextSummary, /MIDI track "Lead renamed"/);
  assert.equal(renamed.liveContext.availability, "available");
  assert.equal(renamed.liveContext.value.title, "Lead renamed");
  assert.equal(renamed.liveContext.sessionId, renamed.activeSessionId);

  fixture.tracks.splice(0, 1, fakeMidiTrack(3n, "Lead"));
  const unavailable = await state(fixture.second);
  assert.equal(unavailable.activeSessionId, leadSessionId);
  assert.match(unavailable.contextSummary, /Live object.*unavailable.*Lead/);
  assert.deepEqual(unavailable.liveContext, {
    sessionId: leadSessionId, availability: "unavailable", label: "Lead",
  });
});

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

test("a peer event or attachment invalidation rejects send before unseen state is consumed", async (t) => {
  let secondModelCalls = 0;
  const fixture = await openTwoDialogs(
    {
      requestModelTurn: async () => ({ content: "Peer reply", toolCalls: [] }),
    },
    {
      requestModelTurn: async () => {
        secondModelCalls += 1;
        return { content: "Second reply", toolCalls: [] };
      },
    },
    true,
  );
  t.after(fixture.close);
  const sessionId = fixture.firstState.activeSessionId;
  assert.equal(fixture.secondState.activeSessionId, sessionId);

  const firstSend = await fetch(fixture.first.endpoint("/send"), {
    method: "POST",
    headers: jsonHeaders("peer-send"),
    body: JSON.stringify({ prompt: "Persist this elsewhere", sessionId }),
  });
  assert.equal(firstSend.status, 200);

  const staleEventSend = await fetch(fixture.second.endpoint("/send"), {
    method: "POST",
    headers: jsonHeaders("stale-event-send"),
    body: JSON.stringify({ prompt: "Must first see the peer turn", sessionId }),
  });
  assert.equal(staleEventSend.status, 409);
  const staleEventBody = await staleEventSend.json() as {
    promptPersistence?: string;
    sendFailureKind?: string;
    state?: ChatDialogState;
  };
  assert.equal(staleEventBody.promptPersistence, "not_persisted");
  assert.equal(staleEventBody.sendFailureKind, "state_stale");
  assert.equal(staleEventBody.state, undefined);
  assert.equal(secondModelCalls, 0);
  const reviewedEventState = await state(fixture.second, sessionId);
  assert.deepEqual(
    reviewedEventState.events.map(({ content }) => content),
    ["Persist this elsewhere", "Peer reply"],
  );

  const uploadBytes = pngBytes();
  const upload = await fetch(
    fixture.first.endpoint("/attachments") +
      `&sessionId=${encodeURIComponent(sessionId)}&fileName=peer.png`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Live-Smith-File-Type": "image/png",
      },
      body: uploadBytes.buffer.slice(
        uploadBytes.byteOffset,
        uploadBytes.byteOffset + uploadBytes.byteLength,
      ) as ArrayBuffer,
    },
  );
  assert.equal(upload.status, 201);

  const staleAttachmentSend = await fetch(fixture.second.endpoint("/send"), {
    method: "POST",
    headers: coveredSendHeaders("stale-attachment-send", reviewedEventState),
    body: JSON.stringify({ prompt: "Must first see the attachment", sessionId }),
  });
  assert.equal(staleAttachmentSend.status, 409);
  const staleAttachmentBody = await staleAttachmentSend.json() as {
    state?: ChatDialogState;
  };
  assert.equal(staleAttachmentBody.state, undefined);
  assert.equal(secondModelCalls, 0);
  const reviewedAttachmentState = await state(fixture.second, sessionId);
  assert.deepEqual(
    reviewedAttachmentState.pendingAttachments.map(({ fileName }) => fileName),
    ["peer.png"],
  );
  assert.deepEqual(
    (await loadSessionEvents(fixture.directory, sessionId)).map(({ content }) => content),
    ["Persist this elsewhere", "Peer reply"],
  );
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

async function openTwoDialogs(
  firstDependencies: AgentFlowDependencies,
  secondDependencies: AgentFlowDependencies,
  shareFirstSession = false,
  secondTrack?: MidiTrack<"1.0.0">,
): Promise<{
  directory: string;
  first: DialogEndpoint;
  second: DialogEndpoint;
  firstState: ChatDialogState;
  secondState: ChatDialogState;
  tracks: MidiTrack<"1.0.0">[];
  close(): Promise<void>;
}> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-consistency-"),
  );
  await saveSavedProfile(directory, profile());
  const firstDialog = Promise.withResolvers<string>();
  const secondDialog = Promise.withResolvers<string>();
  const closeFirst = Promise.withResolvers<void>();
  const closeSecond = Promise.withResolvers<void>();
  let dialogCount = 0;
  const track = fakeMidiTrack();
  const tracks = [track, ...(secondTrack ? [secondTrack] : [])];
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks, scenes: [] },
    },
    environment: { storageDirectory: directory },
    ui: {
      showModalDialog: async (url: string) => {
        const first = dialogCount++ === 0;
        (first ? firstDialog : secondDialog).resolve(url);
        await (first ? closeFirst : closeSecond).promise;
      },
    },
  };
  const interaction = interactionContextForScope(context as never, {
    kind: "track", identity: "1", label: "Lead",
  })!;
  const firstFlow = runAgentFlow(context as never, interaction, {
    ...firstDependencies,
    renderHtml: () => "<html></html>",
  });
  let secondFlow: Promise<void> | undefined;
  try {
    const first = endpoint(await firstDialog.promise);
    const firstState = await state(first);
    if (shareFirstSession) {
      await updateSession(directory, firstState.activeSessionId, {
        title: "Shared Session",
      });
    }
    const secondInteraction = secondTrack ? interactionContextForScope(context as never, {
      kind: "track", identity: secondTrack.handle.id.toString(), label: secondTrack.name,
    })! : interaction;
    secondFlow = runAgentFlow(context as never, secondInteraction, {
      ...secondDependencies,
      renderHtml: () => "<html></html>",
    });
    const second = endpoint(await secondDialog.promise);
    const secondState = await state(second);
    let closed = false;
    return {
      directory,
      first,
      second,
      firstState,
      secondState,
      tracks,
      close: async () => {
        if (closed) return;
        closed = true;
        closeFirst.resolve();
        closeSecond.resolve();
        await Promise.allSettled([firstFlow, secondFlow!]);
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closeFirst.resolve();
    closeSecond.resolve();
    await Promise.allSettled([firstFlow, ...(secondFlow ? [secondFlow] : [])]);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
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

function coveredSendHeaders(
  id: string,
  state: ChatBridgeState,
): Record<string, string> {
  return {
    ...jsonHeaders(id),
    "X-Live-Smith-Global-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
    "X-Live-Smith-Session-State-Covered-Through":
      state.bridgeStateCoveredThroughRevision,
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

function pngBytes(): Uint8Array {
  const bytes = Buffer.alloc(24);
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
  return new Uint8Array(bytes);
}
