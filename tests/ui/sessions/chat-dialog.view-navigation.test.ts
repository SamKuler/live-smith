import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture, jsonCalls, cloneState, waitForCondition } from "../support/chat-dialog.test-harness.js";
import { createChatBridge, type ChatBridgeOptions } from "../../../src/app/chat/chat-bridge.js";
import { openBridgeEvents, type BridgeEvents } from "../../app/chat/support/bridge-events.js";
import type { ChatBridgeState, ChatSessionEvent } from "../../../src/ui/chat-state.js";

const bridge = { baseUrl: "http://bridge.test", token: "test-token", viewId: "view-1" };
const peerCommand = { id: "peer-import", sessionId: "session-1", stopping: false };

function sessionsState() {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.sessions[1]!.title = "Second Session";
  return state;
}

test("the page URL restores only the canonical Session while requests retain this document's view identity", async () => {
  const h = await createDialogHarness(sessionsState(), bridge, { beforeParse(window) {
    window.history.replaceState(null, "", "/chat?token=test-token&sessionId=old-selection");
  } });
  try {
    const pageUrl = () => new URL(h.window.location.href);
    assert.equal(pageUrl().searchParams.get("sessionId"), "session-1");
    assert.equal(pageUrl().searchParams.has("viewId"), false);
    assert.equal(pageUrl().searchParams.get("token"), "test-token");
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(pageUrl().searchParams.get("sessionId"), "session-2");
    assert.equal(pageUrl().searchParams.has("viewId"), false);
    const selected = h.calls.filter(call => call.path === "/view-session").at(-1)!;
    assert.equal(new Headers(selected.headers).get("X-Live-Smith-View-Id"), bridge.viewId);
    assert.equal(new URL(h.eventStreamUrls[0]!).searchParams.get("viewId"), bridge.viewId);
    h.emitServerEventError(); h.emitServerEventOpen(); await h.settle();
    assert.equal(pageUrl().searchParams.get("sessionId"), "session-2");
    assert.equal(new Headers(h.calls.filter(call => call.path === "/state").at(-1)!.headers).get("X-Live-Smith-View-Id"), bridge.viewId);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const kind of ["command", "send"] as const) {
  test(`a peer ${kind} terminal preserves this view's loaded tool catalog in the same Session`, async () => {
    const state = sessionsState();
    state.status = "Local view status";
    state.sessionToolCatalog = { sessionId: state.activeSessionId, loadedAt: "2026-10-30T00:00:00.000Z",
      modelToolsSupported: true, truncated: false, issues: [], groups: [
        { kind: "live", tools: [{ name: "local_view_tool", description: "This view's loaded catalog" }] },
      ] };
    const h = await createDialogHarness(state, bridge);
    try {
      h.click("#sessionInspectorScope"); h.click("#toolsTab"); await h.settle();
      assert.match(h.document.querySelector("#sessionToolCatalog")?.textContent ?? "", /Local view tool/);
      if (kind === "command") h.emitServerEvent({ type: "command_activity", command: peerCommand, bridgeStateRevision: "100" });
      else h.emitServerEvent({ type: "send_activity", sendId: "peer-send", sessionId: "session-1",
        activity: { status: "running", message: "Peer is working" }, bridgeStateRevision: "100" });
      const terminal = cloneState(state);
      terminal.status = "Other view private status";
      terminal.sessionToolCatalog!.groups[0]!.tools = [{ name: "peer_view_tool", description: "Another view's catalog" }];
      terminal.sessionActivities = [{ sessionId: "session-1", sendId: "peer-send", status: "completed", message: "Completed", unread: false }];
      h.emitServerEvent(kind === "command"
        ? { type: "state", commandId: peerCommand.id, state: terminal }
        : { type: "done", sendId: "peer-send", sessionId: "session-1", state: terminal });
      await h.settle();
      assert.match(h.document.querySelector("#sessionToolCatalog")?.textContent ?? "", /Local view tool/);
      assert.doesNotMatch(h.document.querySelector("#sessionToolCatalog")?.textContent ?? "", /Peer view tool/);
      assert.doesNotMatch(h.document.querySelector("#status")?.textContent ?? "", /Other view private status/);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("view navigation preserves a peer command's pending approval and Stop ownership", async () => {
  const h = await createDialogHarness(sessionsState(), bridge);
  try {
    h.input("#prompt", "Session one draft");
    h.emitServerEvent({ type: "command_activity", command: peerCommand, bridgeStateRevision: "100" });
    h.emitServerEvent({ type: "command_confirm_request", commandId: peerCommand.id, sessionId: peerCommand.sessionId,
      id: "confirm-peer-import", kind: "apply", operationId: "apply-peer-import", message: "Import MIDI", groups: [{ title: "Track", rows: ["Import MIDI"] }] });
    await h.settle();
    const second = h.document.querySelector<HTMLButtonElement>('[data-session-id="session-2"] .session-row')!;
    assert.equal(second.disabled, false);
    assert.equal(h.document.querySelector<HTMLButtonElement>('[data-session-id="session-2"] .session-menu-button')!.disabled, true);
    second.click(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/view-session").map(call => call.body), [{ kind: "select_session", sessionId: "session-2" }]);
    assert.equal(h.document.querySelector('[data-session-id="session-2"] .session-row')?.getAttribute("aria-pressed"), "true");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "");
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    await h.acceptAppConfirmation(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/confirm").at(-1)?.body, { id: "confirm-peer-import", apply: true });
    h.click("#sendButton"); await h.settle();
    assert.deepEqual(h.commandStopIds, [peerCommand.id]);
    assert.equal(jsonCalls(h, "/command").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("one view serializes its own navigation while a peer command remains active", async () => {
  const h = await createDialogHarness(sessionsState(), bridge);
  let released = false;
  try {
    h.emitServerEvent({ type: "command_activity", command: peerCommand, bridgeStateRevision: "100" }); await h.settle();
    h.holdNextCommandResponse();
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    h.click('[data-session-id="session-1"] .session-row');
    h.click("#newSessionButton"); await h.settle();
    assert.equal(jsonCalls(h, "/view-session").length, 1);
    h.releaseHeldCommandResponse(); released = true; await h.settle();
    assert.equal(h.document.querySelector('[data-session-id="session-2"] .session-row')?.getAttribute("aria-pressed"), "true");
    assert.equal(h.document.querySelector<HTMLButtonElement>("#newSessionButton")!.disabled, false);
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.deepEqual(h.errors, []);
  } finally { if (!released) h.releaseHeldCommandResponse(); h.close(); }
});

test("a lost view selection response reconciles the selected Session without resubmitting", async () => {
  const h = await createDialogHarness(sessionsState(), bridge);
  try {
    h.emitServerEvent({ type: "command_activity", command: peerCommand, bridgeStateRevision: "100" }); await h.settle();
    h.rejectNextCommandResponse("Connection closed after selection");
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(jsonCalls(h, "/view-session").length, 1);
    assert.ok(h.calls.some(call => call.path === "/state"));
    assert.equal(h.document.querySelector('[data-session-id="session-2"] .session-row')?.getAttribute("aria-pressed"), "true");
    assert.equal(h.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("two real dialogs retain their own selection through peer state, confirmation, done and invalidation events", { timeout: 15000 }, async () => {
  const shared = sessionsState();
  const sessionEvents = new Map<string, ChatSessionEvent[]>();
  const sendReachedConfirmation = Promise.withResolvers<void>();
  const sendCompleted = Promise.withResolvers<void>();
  function createView(): ChatBridgeOptions {
    let selected = "session-1";
    const state = () => ({ ...cloneState(shared), activeSessionId: selected,
      liveContext: { ...cloneState(shared.liveContext!), sessionId: selected },
      approvalMode: shared.sessions.find(session => session.id === selected)?.approvalMode ?? "manual",
      events: cloneState(sessionEvents.get(selected) ?? []),
      sessionToolCatalog: { sessionId: selected, loadedAt: "2026-10-30T00:00:00.000Z", modelToolsSupported: true, truncated: false, issues: [], groups: [] },
    });
    return {
      buildState: async () => state(), renderHtml: (state, bridge) => JSON.stringify({ state, bridge }),
      handleCommand: async input => {
        if (input.kind === "select_session") selected = input.sessionId;
        if (input.kind === "rename_session") shared.sessions.find(session => session.id === input.sessionId)!.title = input.title;
        return state();
      },
      handleSend: async (input, stream) => {
        await stream.assistantDelta("Peer response");
        const approved = stream.requestConfirmation({ kind: "apply", message: "Apply peer plan?", groups: [{ title: "Track", rows: ["Apply peer plan"] }] });
        sendReachedConfirmation.resolve();
        await approved;
        sessionEvents.set(input.sessionId, [{ id: "peer-done", kind: "assistant", content: "Peer completed", createdAt: "2026-10-30T00:00:00.000Z" }]);
        sendCompleted.resolve();
        return state();
      },
    };
  }
  const server = await createChatBridge({ ...createView(), createView });
  const pages: Array<{ dialog: Awaited<ReturnType<typeof createDialogHarness>>; events: BridgeEvents; pump: Promise<void>; viewId: string; pendingHttp: Set<Promise<Response>> }> = [];
  const selected = (dialog: Awaited<ReturnType<typeof createDialogHarness>>, sessionId: string) =>
    dialog.document.querySelector(`[data-session-id="${sessionId}"] .session-row`)?.getAttribute("aria-pressed") === "true";
  const openPage = async () => {
    const opened = await (await fetch(server.url)).json() as { state: ChatBridgeState; bridge: { baseUrl: string; token: string; viewId: string } };
    const dialog = await createDialogHarness(opened.state, opened.bridge);
    const pendingHttp = new Set<Promise<Response>>();
    Object.defineProperty(dialog.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      dialog.calls.push({ path: url.pathname, url: url.toString(), ...(init?.headers ? { headers: init.headers } : {}), body: init?.body });
      const request = fetch(url, init);
      pendingHttp.add(request);
      try { return await request; } finally { pendingHttp.delete(request); }
    } });
    const eventsUrl = new URL(server.url); eventsUrl.pathname = "/events"; eventsUrl.searchParams.set("viewId", opened.bridge.viewId);
    const events = await openBridgeEvents(eventsUrl);
    let closing = false;
    events.socket.once("close", () => { closing = true; });
    const pump = (async () => {
      for (;;) {
        try { dialog.emitRawServerEvent(await events.next()); }
        catch (error) { if (closing) return; throw error; }
      }
    })();
    const page = { dialog, events, pump, viewId: opened.bridge.viewId, pendingHttp }; pages.push(page);
    return page;
  };
  try {
    const a = await openPage(); const b = await openPage();
    a.dialog.click('[data-session-id="session-2"] .session-row');
    await waitForCondition(() => selected(a.dialog, "session-2"), "first page selection");
    assert.equal(selected(b.dialog, "session-1"), true);

    const commandUrl = new URL(server.url); commandUrl.pathname = "/command";
    const renamed = await fetch(commandUrl, { method: "POST", headers: { "Content-Type": "application/json",
      "X-Live-Smith-View-Id": a.viewId, "X-Live-Smith-Command-Id": "peer-rename" },
      body: JSON.stringify({ kind: "rename_session", sessionId: "session-2", title: "Shared renamed Session" }) });
    assert.equal(renamed.status, 200);
    server.publishGlobalStateInvalidation();
    await waitForCondition(() => b.dialog.document.querySelector('[data-session-id="session-2"] .session-title')?.textContent === "Shared renamed Session", "peer state refresh");
    assert.equal(selected(a.dialog, "session-2"), true);
    assert.equal(selected(b.dialog, "session-1"), true);

    a.dialog.click('[data-session-id="session-1"] .session-row');
    await waitForCondition(() => selected(a.dialog, "session-1"), "first page returning to send Session");
    a.dialog.input("#prompt", "Continue"); a.dialog.click("#sendButton");
    await sendReachedConfirmation.promise;
    await waitForCondition(() => Boolean(b.dialog.document.querySelector(".confirm-card")), "peer approval projection");
    b.dialog.click('[data-session-id="session-2"] .session-row');
    await waitForCondition(() => selected(b.dialog, "session-2"), "second page navigation during peer approval");
    assert.equal(selected(a.dialog, "session-1"), true);
    await waitForCondition(() => Boolean(a.dialog.document.querySelector(".confirm-card .primary")), "origin approval card");
    a.dialog.click(".confirm-card .primary");
    await sendCompleted.promise;
    await waitForCondition(() => a.dialog.document.querySelector("#sendButton")?.textContent === "Send", "terminal send publication");
    server.publishGlobalStateInvalidation();
    await Promise.all([a.dialog.settle(), b.dialog.settle()]);
    assert.equal(selected(a.dialog, "session-1"), true);
    assert.equal(selected(b.dialog, "session-2"), true);
    assert.deepEqual(a.dialog.errors, []); assert.deepEqual(b.dialog.errors, []);
  } finally {
    for (const page of pages) { await page.events.close(); await page.pump; }
    for (const page of pages) {
      while (page.pendingHttp.size) await Promise.allSettled([...page.pendingHttp]);
      await page.dialog.settle();
      page.dialog.close();
    }
    await server.close();
  }
});
