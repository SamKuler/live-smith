import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { createAgentRuntime, type AgentFlowDependencies } from "../../../src/app/agent-flow.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { loadAgentSettings, saveSavedProfile } from "../../../src/storage/settings.js";
import { createSession } from "../../../src/storage/sessions.js";
import type { ChatBridgeState } from "../../../src/ui/chat-state.js";
import { openBridgeEvents, readEvent } from "../chat/support/bridge-events.js";

const interaction: LiveInteractionContext = {
  summary: "Set", presentation: { origin: "object", objectKind: "other", title: "Set", details: [] },
  scope: { kind: "object", identity: "song", label: "Set" }, target: {},
};

async function fixture(dependencies: AgentFlowDependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-views-"));
  await saveSavedProfile(directory, {
    id: "views-profile", name: "Provider", connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "fixture-key" },
    defaultModel: "model", models: [{ model: "model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: directory } };
  const runtime = await createAgentRuntime(context as never, interaction, {
    requestModelTurn: async () => ({ content: "Completed", toolCalls: [] }),
    ...dependencies, renderHtml: (state, bridge) => JSON.stringify({ state, viewId: bridge.viewId }),
  }, "browser");
  let sequence = 0;
  const endpoint = (pathname: string) => { const url = new URL(runtime.url); url.pathname = pathname; return url; };
  const open = async (sessionId?: string) => {
    const url = new URL(runtime.url);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ state: ChatBridgeState; viewId: string }>;
  };
  const state = async (viewId: string) => {
    const response = await fetch(endpoint("/state"), { headers: { "X-Live-Smith-View-Id": viewId } });
    assert.equal(response.status, 200);
    return response.json() as Promise<ChatBridgeState>;
  };
  const command = async (viewId: string, body: Record<string, unknown>, pathname = "/command") => {
    const response = await fetch(endpoint(pathname), { method: "POST", headers: {
      "Content-Type": "application/json", "X-Live-Smith-View-Id": viewId, "X-Live-Smith-Command-Id": `view-command-${++sequence}`,
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<ChatBridgeState>;
  };
  return { directory, runtime, endpoint, open, state, command, close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("pages retain independent Session selections, tool catalogs, reloads and shared metadata", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.open(); const b = await f.open();
    assert.notEqual(a.viewId, b.viewId);
    assert.equal(a.state.activeSessionId, b.state.activeSessionId);
    const loaded = await f.command(a.viewId, { kind: "load_session_tools", sessionId: a.state.activeSessionId }, "/session-tools");
    assert.ok(loaded.sessionToolCatalog);
    assert.equal((await f.state(b.viewId)).sessionToolCatalog, undefined);
    const created = await f.command(b.viewId, { kind: "new_session" }, "/view-session");
    assert.notEqual(created.activeSessionId, a.state.activeSessionId, "another view's empty Session remains claimed");
    assert.equal((await f.state(a.viewId)).activeSessionId, a.state.activeSessionId);
    const reloaded = await f.open(created.activeSessionId);
    assert.notEqual(reloaded.viewId, b.viewId);
    assert.equal(reloaded.state.activeSessionId, created.activeSessionId);
    await f.runtime.reopen(a.state.activeSessionId);
    assert.equal((await f.state(b.viewId)).activeSessionId, created.activeSessionId, "opening another page does not select in an existing page");

    const eventsUrl = f.endpoint("/events"); eventsUrl.searchParams.set("viewId", b.viewId);
    const events = await openBridgeEvents(eventsUrl);
    try {
      await f.command(a.viewId, { kind: "rename_session", sessionId: a.state.activeSessionId, title: "Shared title" });
      let invalidated;
      do { invalidated = await readEvent(events, "session_state_invalidated"); } while (invalidated.sessionId !== a.state.activeSessionId);
      const refreshed = await f.state(b.viewId);
      assert.equal(refreshed.activeSessionId, created.activeSessionId);
      assert.equal(refreshed.sessions.find(session => session.id === a.state.activeSessionId)?.title, "Shared title");
      await f.command(a.viewId, { kind: "save_global_settings", customInstructions: "Shared instructions" });
      await readEvent(events, "global_settings_changed");
      assert.equal((await f.state(b.viewId)).settings.customInstructions, "Shared instructions");
    } finally { await events.close(); }

    const invalid = await fetch(f.endpoint("/state"), { headers: { "X-Live-Smith-View-Id": "unregistered-view" } });
    assert.equal(invalid.status, 409);
    const forbidden = f.endpoint("/state"); forbidden.searchParams.set("token", "wrong");
    assert.equal((await fetch(forbidden, { headers: { "X-Live-Smith-View-Id": a.viewId } })).status, 403);
  } finally { await f.close(); }
});

test("copied and reloaded documents restore selection with fresh owners while old event sockets stay connected", { timeout: 10000 }, async () => {
  const f = await fixture();
  const events: Awaited<ReturnType<typeof openBridgeEvents>>[] = [];
  const connect = async (viewId: string) => {
    const url = f.endpoint("/events"); url.searchParams.set("viewId", viewId);
    const connected = await openBridgeEvents(url); events.push(connected); return connected;
  };
  try {
    const source = await f.open();
    await connect(source.viewId);
    const selected = await f.command(source.viewId, { kind: "new_session" }, "/view-session");
    await f.command(source.viewId, { kind: "load_session_tools", sessionId: selected.activeSessionId }, "/session-tools");

    const copied = await f.open(selected.activeSessionId);
    assert.notEqual(copied.viewId, source.viewId);
    assert.equal(copied.state.activeSessionId, selected.activeSessionId);
    assert.equal(copied.state.sessionToolCatalog, undefined);
    const copiedEvents = await connect(copied.viewId);
    await f.command(copied.viewId, { kind: "select_session", sessionId: source.state.activeSessionId }, "/view-session");
    assert.equal((await f.state(source.viewId)).activeSessionId, selected.activeSessionId);
    assert.equal((await f.state(copied.viewId)).activeSessionId, source.state.activeSessionId);

    // A reload can reach the server before the old document's socket closes.
    const reloaded = await f.open(selected.activeSessionId);
    assert.notEqual(reloaded.viewId, source.viewId);
    assert.notEqual(reloaded.viewId, copied.viewId);
    assert.equal(reloaded.state.activeSessionId, selected.activeSessionId);
    assert.equal(reloaded.state.sessionToolCatalog, undefined);
    await connect(reloaded.viewId);
    await f.command(reloaded.viewId, { kind: "select_session", sessionId: source.state.activeSessionId }, "/view-session");
    assert.equal((await f.state(source.viewId)).activeSessionId, selected.activeSessionId);
    assert.ok((await f.state(source.viewId)).sessionToolCatalog);

    await f.command(source.viewId, { kind: "rename_session", sessionId: selected.activeSessionId, title: "Shared after copying" });
    const invalidated = await readEvent(copiedEvents, "session_state_invalidated", event => event.sessionId === selected.activeSessionId);
    assert.equal(invalidated.sessionId, selected.activeSessionId);
  } finally { await Promise.all(events.map(event => event.close())); await f.close(); }
});

test("page restoration validates its Session reference and falls back for unavailable Sessions", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.open();
    for (const query of ["sessionId=", "sessionId=../escape", "sessionId=one&sessionId=two", `viewId=${page.viewId}`]) {
      const url = f.endpoint("/chat"); url.search += `&${query}`;
      assert.equal((await fetch(url)).status, 400, query);
    }
    const foreign = await createSession(f.directory, { title: "Foreign", projectKey: "foreign-project", scope: interaction.scope });
    const created = await f.command(page.viewId, { kind: "new_session" }, "/view-session");
    await f.command(page.viewId, { kind: "archive_session", sessionId: created.activeSessionId });
    for (const sessionId of ["missing-session", foreign.id, created.activeSessionId]) {
      const restored = await f.open(sessionId);
      assert.notEqual(restored.state.activeSessionId, sessionId);
      assert.ok(restored.state.sessions.some(session => session.id === restored.state.activeSessionId && !session.archivedAt));
    }
  } finally { await f.close(); }
});

test("a view's own committed change keeps admission current while peer views must reconcile it", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.open(); const b = await f.open();
    const renamed = await f.command(a.viewId, { kind: "rename_session", sessionId: a.state.activeSessionId, title: "Updated" });
    const send = async (viewId: string, state: ChatBridgeState, id: string) => fetch(f.endpoint("/send"), {
      method: "POST", headers: {
        "Content-Type": "application/json", "X-Live-Smith-View-Id": viewId, "X-Live-Smith-Send-Id": id,
        "X-Live-Smith-Global-State-Covered-Through": state.bridgeStateCoveredThroughRevision,
        "X-Live-Smith-Session-State-Covered-Through": state.bridgeStateCoveredThroughRevision,
      }, body: JSON.stringify({ prompt: "Work", sessionId: state.activeSessionId }),
    });
    assert.equal((await send(a.viewId, renamed, "own-commit")).status, 200);
    const stale = await send(b.viewId, b.state, "peer-stale");
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).sendFailureKind, "state_stale");
    assert.equal((await send(b.viewId, await f.state(b.viewId), "peer-refreshed")).status, 200);
  } finally { await f.close(); }
});

test("activating a Profile invalidates peer admission while the initiating view can continue", { timeout: 10000 }, async () => {
  let modelCalls = 0;
  const f = await fixture({ requestModelTurn: async () => { modelCalls++; return { content: "Completed", toolCalls: [] }; } });
  try {
    const settings = await loadAgentSettings(f.directory);
    await saveSavedProfile(f.directory, { ...settings.profiles[0]!, id: "other-profile", name: "Other" });
    const a = await f.open(); const b = await f.open();
    const profileId = a.state.settings.activeProfileId === "other-profile" ? "views-profile" : "other-profile";
    const activated = await f.command(a.viewId, { kind: "activate_profile", profileId });
    const send = async (viewId: string, state: ChatBridgeState, id: string) => fetch(f.endpoint("/send"), {
      method: "POST", headers: {
        "Content-Type": "application/json", "X-Live-Smith-View-Id": viewId, "X-Live-Smith-Send-Id": id,
        "X-Live-Smith-Global-State-Covered-Through": state.bridgeStateCoveredThroughRevision,
        "X-Live-Smith-Session-State-Covered-Through": state.bridgeStateCoveredThroughRevision,
      }, body: JSON.stringify({ prompt: "Work", sessionId: state.activeSessionId }),
    });
    assert.equal((await send(b.viewId, b.state, "stale-profile")).status, 409);
    assert.equal(modelCalls, 0);
    assert.equal((await send(a.viewId, activated, "own-profile")).status, 200);
    assert.equal(modelCalls, 1);
    const refreshed = await f.state(b.viewId);
    assert.equal(refreshed.settings.activeProfileId, profileId);
    assert.equal((await send(b.viewId, refreshed, "current-profile")).status, 200);
    assert.equal(modelCalls, 2);
  } finally { await f.close(); }
});

test("Session jobs remain shared while pages select independently and Stop from another page", { timeout: 10000 }, async () => {
  const gates = new Map<string, { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void>; aborted: boolean }>();
  for (const prompt of ["First", "Second"]) gates.set(prompt, { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), aborted: false });
  const f = await fixture({ requestModelTurn: async input => {
    const gate = gates.get(input.prompt)!;
    input.signal?.addEventListener("abort", () => { gate.aborted = true; gate.release.resolve(); }, { once: true });
    gate.started.resolve(); await gate.release.promise;
    return { content: "Completed", toolCalls: [] };
  } });
  const sends: Promise<Response>[] = [];
  try {
    const a = await f.open(); const b = await f.open();
    const other = await f.command(b.viewId, { kind: "new_session" }, "/view-session");
    const send = (viewId: string, sessionId: string, prompt: string) => fetch(f.endpoint("/send"), { method: "POST", headers: {
      "Content-Type": "application/json", "X-Live-Smith-View-Id": viewId, "X-Live-Smith-Send-Id": `send-${prompt}`,
    }, body: JSON.stringify({ prompt, sessionId }) });
    sends.push(send(a.viewId, a.state.activeSessionId, "First")); await gates.get("First")!.started.promise;
    sends.push(send(b.viewId, other.activeSessionId, "Second")); await gates.get("Second")!.started.promise;
    const selected = await f.command(a.viewId, { kind: "select_session", sessionId: other.activeSessionId }, "/view-session");
    assert.equal(selected.activeSessionId, other.activeSessionId);
    assert.equal(selected.sessionActivities!.filter(activity => activity.status === "running").length, 2);
    assert.equal(gates.get("First")!.aborted, false);
    const stopped = await fetch(f.endpoint("/stop"), { method: "POST", headers: {
      "Content-Type": "application/json", "X-Live-Smith-View-Id": a.viewId, "X-Live-Smith-Send-Id": "send-Second",
    }, body: "{}" });
    assert.equal(stopped.status, 200);
    assert.equal(gates.get("Second")!.aborted, true);
    assert.equal(gates.get("First")!.aborted, false);
    gates.get("First")!.release.resolve();
    await Promise.all(sends);
    assert.equal((await f.state(a.viewId)).activeSessionId, other.activeSessionId);
    assert.equal((await f.state(b.viewId)).activeSessionId, other.activeSessionId);
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    await f.close(); await Promise.allSettled(sends);
  }
});
