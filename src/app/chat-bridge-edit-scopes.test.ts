import assert from "node:assert/strict";
import test from "node:test";

import { EDIT_SCOPES, type EditScope } from "../agent/edit-scopes.js";
import type { AgentSession } from "../storage/sessions.js";
import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
  createChatBridge,
} from "./chat-bridge.js";
import {
  invalidateSessionEditScopes,
  publishSessionEditScopesChange,
  subscribeSessionEditScopesChanges,
  subscribeSessionEditScopesInvalidations,
  type SessionEditScopesChange,
} from "./session-edit-scope-events.js";

function session(id: string, editScopes?: EditScope[]): AgentSession {
  return {
    id,
    title: `Session ${id}`,
    projectKey: "project-1",
    scope: { kind: "track", identity: id, label: id },
    approvalMode: "everything",
    ...(editScopes === undefined ? {} : { editScopes }),
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function stateWithScopes(editScopes?: EditScope[]): ChatDialogState {
  return {
    activeSessionId: "session-1",
    approvalMode: "everything",
    sessions: [session("session-1", editScopes)],
    previousSessions: [session("session-previous", editScopes)],
    archivedSessions: [session("session-archived", editScopes)],
  } as ChatDialogState;
}

function endpointFor(url: string): (pathname: string) => string {
  const chatUrl = new URL(url);
  return (pathname) =>
    `${chatUrl.origin}${pathname}?token=${chatUrl.searchParams.get("token")}`;
}

async function readSsePayloads(
  response: Response,
  type: string,
  count = 1,
): Promise<Array<Record<string, unknown>>> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let pending = "";
  const payloads: Array<Record<string, unknown>> = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assert.equal(done, false, `SSE ended before ${type}.`);
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload.type === type) payloads.push(payload);
        if (payloads.length === count) return payloads;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("Session edit-scope commands are strict, normalized, and available during a send", async () => {
  let releaseSend!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const received: unknown[] = [];
  const state = stateWithScopes();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, _signal, context) => {
      received.push({
        input,
        context: {
          commandId: context.commandId,
          progress: typeof context.progress,
        },
      });
      return state;
    },
    handleSend: async () => { markStarted(); await gate; },
  });
  const endpoint = endpointFor(bridge.url);
  let commandSequence = 0;
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": "scope-running-send",
    },
    body: JSON.stringify({ prompt: "Keep working", sessionId: "session-1" }),
  });
  const command = (body: unknown) => fetch(endpoint("/command"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": `scope-command-${++commandSequence}`,
    },
    body: JSON.stringify(body),
  });

  try {
    await started;
    for (const editScopes of [["mixer", "midi"], [], [...EDIT_SCOPES]]) {
      const response = await command({
        kind: "set_session_edit_scopes", sessionId: "session-1", editScopes,
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(received, [["midi", "mixer"], [], [...EDIT_SCOPES]].map(
      (editScopes, index) => ({
        input: { kind: "set_session_edit_scopes", sessionId: "session-1", editScopes },
        context: {
          commandId: `scope-command-${index + 1}`,
          progress: "function",
        },
      }),
    ));

    for (const editScopes of [undefined, null, false, "midi", ["unknown"], ["midi", "midi"]]) {
      assert.equal((await command({
        kind: "set_session_edit_scopes", sessionId: "session-1", editScopes,
      })).status, 400);
    }
    for (const extra of [{ extra: true }, { approvalMode: "everything" }, { profile: {} }, { writeBoundary: null }]) {
      assert.equal((await command({
        kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [], ...extra,
      })).status, 400);
    }
    for (const boundary of [null, { kind: "midi-candidate" }, { kind: "midi-clip-range", startBeat: 2, endBeat: 6 }]) {
      assert.equal((await command({
        kind: "set_session_write_boundary", sessionId: "session-1", boundary,
      })).status, 400);
    }
    assert.equal(received.length, 3);
  } finally {
    releaseSend();
    await send;
    await bridge.close();
  }
});

test("late snapshots overlay only newer Session scope patches across every collection", async () => {
  let releaseBuild!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const staleState = stateWithScopes([...EDIT_SCOPES]);
  let current = staleState;
  const bridge = await createChatBridge({
    buildState: async () => {
      const snapshot = current;
      markStarted();
      await gate;
      return snapshot;
    },
    renderHtml: () => "<html></html>",
    handleCommand: async () => current,
    handleSend: async () => {},
  });
  const endpoint = endpointFor(bridge.url);
  let events: Response | undefined;
  try {
    events = await fetch(endpoint("/events"));
    const pendingState = fetch(endpoint("/state"));
    await started;
    const published = readSsePayloads(events, "session_edit_scopes_changed", 4);
    const updatedAt = "2026-08-26T00:01:00.000Z";
    bridge.publishSessionEditScopes("session-1", [], updatedAt);
    bridge.publishSessionEditScopes("session-previous", ["audio"], updatedAt);
    bridge.publishSessionEditScopes("session-archived", ["midi"], updatedAt);
    bridge.publishSessionEditScopes("session-removed", [], updatedAt);
    const patches = await published;
    releaseBuild();
    const state = await (await pendingState).json() as ChatBridgeState;

    assert.deepEqual(state.sessions[0]?.editScopes, []);
    assert.deepEqual(state.previousSessions[0]?.editScopes, ["audio"]);
    assert.deepEqual(state.archivedSessions[0]?.editScopes, ["midi"]);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.approvalMode, "everything");
    assert.equal(state.sessions[0]?.approvalMode, "everything");
    assert.equal(state.sessions[0]?.updatedAt, updatedAt);
    assert.equal(Object.hasOwn(state, "editScopes"), false);
    assert.equal(state.bridgeStateCoveredThroughRevision, "0");
    for (const patch of patches) {
      assert.ok(BigInt(patch.bridgeStateRevision as string) < BigInt(state.bridgeStateRevision));
    }
    assert.deepEqual(staleState.sessions[0]?.editScopes, EDIT_SCOPES);

    current = stateWithScopes(["devices"]);
    const readback = await (await fetch(endpoint("/state"))).json() as ChatBridgeState;
    assert.deepEqual(readback.sessions[0]?.editScopes, ["devices"]);
    assert.ok(BigInt(readback.bridgeStateCoveredThroughRevision) >= BigInt(state.bridgeStateRevision));
  } finally {
    releaseBuild();
    await events?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("scope reconnect replays only the latest copied patch per Session", async () => {
  const state = stateWithScopes();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });
  const endpoint = endpointFor(bridge.url);
  let initial: Response | undefined;
  let reconnect: Response | undefined;
  try {
    initial = await fetch(endpoint("/events"));
    const initialPatch = readSsePayloads(initial, "session_edit_scopes_changed");
    bridge.publishSessionEditScopes("session-1", ["midi"], "2026-08-26T00:01:00.000Z");
    const [first] = await initialPatch;
    await initial.body?.cancel();
    const latestScopes: EditScope[] = ["mixer", "audio"];
    bridge.publishSessionEditScopes("session-1", latestScopes, "2026-08-26T00:02:00.000Z");
    bridge.publishSessionEditScopes("session-2", [], "2026-08-26T00:03:00.000Z");
    latestScopes.splice(0);

    reconnect = await fetch(endpoint("/events"));
    const replay = await readSsePayloads(reconnect, "session_edit_scopes_changed", 2);
    assert.deepEqual(replay.map(({ sessionId, editScopes }) => ({ sessionId, editScopes })), [
      { sessionId: "session-1", editScopes: ["audio", "mixer"] },
      { sessionId: "session-2", editScopes: [] },
    ]);
    assert.equal(replay[0]?.updatedAt, "2026-08-26T00:02:00.000Z");
    assert.ok(BigInt(replay[0]?.bridgeStateRevision as string) > BigInt(first?.bridgeStateRevision as string));
  } finally {
    await initial?.body?.cancel().catch(() => {});
    await reconnect?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("unknown scope-save outcomes preserve newer patches in their authoritative readback", async () => {
  const staleState = stateWithScopes([...EDIT_SCOPES]);
  const bridge = await createChatBridge({
    buildState: async () => staleState,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      bridge.publishSessionEditScopes("session-1", [], "2026-08-26T00:01:00.000Z");
      throw new ChatBridgeCommandOutcomeUnknownError("Scope save outcome unknown.", {
        authoritativeState: staleState,
      });
    },
    handleSend: async () => {},
  });
  const endpoint = endpointFor(bridge.url);
  let events: Response | undefined;
  try {
    events = await fetch(endpoint("/events"));
    const errorPatch = readSsePayloads(events, "error");
    const response = await fetch(endpoint("/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "scope-outcome-unknown",
      },
      body: JSON.stringify({ kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [] }),
    });
    assert.equal(response.status, 500);
    const body = await response.json() as { commandOutcome: string; state: ChatBridgeState };
    assert.equal(body.commandOutcome, "unknown");
    assert.deepEqual(body.state.sessions[0]?.editScopes, []);
    assert.equal(body.state.sessions[0]?.approvalMode, "everything");
    const [published] = await errorPatch;
    assert.deepEqual(published?.state, body.state);
    assert.equal(published?.commandId, "scope-outcome-unknown");
  } finally {
    await events?.body?.cancel().catch(() => {});
    await bridge.close();
  }
});

test("scope notifications isolate storage owners and defensively copy each listener's payload", (t) => {
  const directory = "/private/tmp/live-smith-scope-events";
  const changes: SessionEditScopesChange[] = [];
  const otherChanges: SessionEditScopesChange[] = [];
  t.after(subscribeSessionEditScopesChanges(directory, (change) => {
    change.editScopes.splice(0);
    throw new Error("A closed dialog must not interrupt publication.");
  }));
  const unsubscribe = subscribeSessionEditScopesChanges(
    `${directory}/../live-smith-scope-events`,
    (change) => changes.push(change),
  );
  t.after(unsubscribe);
  t.after(subscribeSessionEditScopesChanges(`${directory}-other`, (change) => {
    otherChanges.push(change);
  }));
  const change: SessionEditScopesChange = {
    sessionId: "session-1",
    editScopes: ["midi"],
    updatedAt: "2026-08-26T00:01:00.000Z",
  };

  publishSessionEditScopesChange(directory, change);
  assert.deepEqual(changes, [change]);
  assert.deepEqual(otherChanges, []);
  change.editScopes.splice(0);
  assert.deepEqual(changes[0]?.editScopes, ["midi"]);
  unsubscribe();
  publishSessionEditScopesChange(directory, change);
  assert.equal(changes.length, 1);
});

test("unknown scope invalidations synchronously isolate and unsubscribe request listeners", (t) => {
  const directory = "/private/tmp/live-smith-scope-invalidations";
  const invalidated: string[] = [];
  const otherInvalidated: string[] = [];
  const committed: SessionEditScopesChange[] = [];
  t.after(subscribeSessionEditScopesChanges(directory, (change) => committed.push(change)));
  t.after(subscribeSessionEditScopesInvalidations(directory, () => {
    throw new Error("One finished request must not stop the others.");
  }));
  const unsubscribe = subscribeSessionEditScopesInvalidations(
    `${directory}/../live-smith-scope-invalidations`,
    (sessionId) => invalidated.push(sessionId),
  );
  t.after(unsubscribe);
  t.after(subscribeSessionEditScopesInvalidations(`${directory}-other`, (sessionId) => {
    otherInvalidated.push(sessionId);
  }));

  invalidateSessionEditScopes(directory, "session-1");
  assert.deepEqual(invalidated, ["session-1"]);
  assert.deepEqual(otherInvalidated, []);
  assert.deepEqual(committed, []);
  publishSessionEditScopesChange(directory, {
    sessionId: "session-1",
    editScopes: [],
    updatedAt: "2026-08-26T00:01:00.000Z",
  });
  assert.deepEqual(invalidated, ["session-1"]);
  assert.equal(committed.length, 1);
  unsubscribe();
  invalidateSessionEditScopes(directory, "session-2");
  assert.deepEqual(invalidated, ["session-1"]);
});
