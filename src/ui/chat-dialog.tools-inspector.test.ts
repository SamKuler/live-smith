import assert from "node:assert/strict";
import test from "node:test";
import type { SessionToolCatalog } from "./chat-state.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";

function toolsState() {
  const state = stateFixture();
  state.plugins = [{ id: "studio-tools", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [{
      id: "analysis", type: "stdio", target: "node", args: ["./server.mjs"], envNames: ["TOKEN"],
      approved: true, artifactInputApproved: false, artifactOutputApproved: false,
      credentialFields: [{ name: "TOKEN", required: true }],
    }] }];
  state.integrationConnections = { revision: "1", connections: [{
    id: "studio-account", name: "Studio account", pluginId: "studio-tools", enabled: true,
    configuration: { serverId: "analysis", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"],
  }] };
  return state;
}

function catalog(sessionId: string): SessionToolCatalog {
  return { sessionId, loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true, truncated: false,
    groups: [{ kind: "mcp", pluginId: "studio-tools", serverId: "analysis", connectionId: "studio-account",
      connectionName: "Studio account", tools: [{ name: "analyze_audio", description: "Analyze <img src=x onerror=alert(1)> safely." }] }], issues: [] };
}

test("Tools automatically loads a named MCP directory without executing a command", async () => {
  const state = toolsState();
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) =>
    ({ ...snapshot, sessionToolCatalog: catalog(snapshot.activeSessionId) }) });
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    assert.equal(h.document.querySelector<HTMLElement>("#toolsPanel")?.hidden, false);
    assert.equal(commandCalls(h).length, 0);
    assert.match(h.document.querySelector("#sessionToolSources")?.textContent ?? "", /Studio account/);
    await h.settle();
    assert.deepEqual(h.calls.find((call) => call.path === "/session-tools")?.jsonBody,
      { kind: "load_session_tools", sessionId: state.activeSessionId });
    const source = h.document.querySelector('[data-tool-source="mcp"]');
    assert.equal(source?.getAttribute("data-connection-id"), "studio-account");
    assert.match(source?.textContent ?? "", /analyze_audio/);
    assert.match(source?.querySelector("summary")?.textContent ?? "", /Studio account/);
    assert.equal(source?.querySelector("img"), null);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSessionToolsButton")?.disabled, false);
    assert.equal(h.document.querySelector("#sessionTools")?.getAttribute("aria-busy"), "false");
    assert.equal(h.calls.some((call) => call.path === "/send"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("standalone MCP sources and catalog updates use the named connection without a Plugin", async () => {
  const state = stateFixture();
  state.plugins = [];
  state.integrationConnections = { revision: "1", connections: [{
    id: "direct-mcp", name: "Local converter", enabled: true,
    mcp: { type: "stdio", command: "node", args: ["convert.mjs"] }, configuredSecrets: ["TOKEN"],
    artifactInputApproved: true, artifactOutputApproved: true,
  }] };
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    assert.match(h.document.querySelector("#sessionToolSources")?.textContent ?? "", /Local converter.*Standalone MCP/s);
    assert.equal(commandCalls(h).length, 0);
    const loaded = cloneState(state);
    loaded.sessionToolCatalog = {
      sessionId: state.activeSessionId, loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true,
      truncated: false,
      groups: [{ kind: "mcp", serverId: "server", connectionId: "direct-mcp", connectionName: "Local converter",
        tools: [{ name: "audio_to_midi", description: "Convert audio to MIDI." }] }],
      issues: [{ connectionId: "direct-mcp", serverId: "server", code: "invalid_tool", message: "A tool was skipped." }],
    };
    h.setServerState(loaded);
    h.click("#loadSessionToolsButton");
    await h.settle();
    const source = h.document.querySelector('[data-tool-source="mcp"][data-connection-id="direct-mcp"]');
    assert.equal(source?.hasAttribute("data-plugin-id"), false);
    assert.match(source?.querySelector("summary")?.textContent ?? "", /Local converter/);
    assert.match(source?.textContent ?? "", /audio_to_midi/);
    assert.match(h.document.querySelector(".tool-catalog-notice")?.textContent ?? "", /Local converter.*Some tool definitions/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a source change removes stale MCP tools and automatically reloads the directory", async () => {
  const state = toolsState();
  state.sessionToolCatalog = catalog(state.activeSessionId);
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    assert.ok(h.document.querySelector(".tool-entry"));
    const changed = cloneState(state);
    delete changed.sessionToolCatalog;
    changed.plugins[0]!.enabled = false;
    h.setServerState(changed);
    h.emitServerEvent({ type: "global_state_invalidated" });
    await h.settle();
    assert.equal(h.document.querySelector('[data-tool-source="mcp"]'), null);
    assert.ok(h.document.querySelector('[data-tool-source="live"] .tool-entry'));
    assert.match(h.document.querySelector("#sessionToolSources")?.textContent ?? "", /Plugin disabled/);
    assert.equal(h.document.querySelector("#loadSessionToolsButton")?.textContent, "Reload tools");
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("send completion refreshes an invalidated directory after foreground work finishes", async () => {
  const state = toolsState();
  state.openSettingsOnLoad = false;
  state.sessionToolCatalog = catalog(state.activeSessionId);
  const h = await createDialogHarness(state);
  let heldSend = false;
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    assert.ok(h.document.querySelector(".tool-entry"));
    h.holdNextSend();
    heldSend = true;
    h.input("#prompt", "Inspect the track");
    h.click("#sendButton");
    await Promise.resolve();
    const sendId = h.sendIds[0]!;
    const event = { id: "after-load-event", kind: "assistant" as const,
      content: "Inspected", createdAt: "2026-09-25T00:01:00.000Z" };
    h.emitServerEvent({ type: "session_event", sendId, sessionId: state.activeSessionId, event });
    const done = cloneState(state);
    delete done.sessionToolCatalog;
    done.events = [event];
    h.setServerState(done);
    h.emitServerEvent({ type: "done", sendId, sessionId: state.activeSessionId, state: done });
    heldSend = false;
    h.releaseHeldSend();
    await h.settle();
    assert.ok(h.document.querySelector('[data-tool-source="live"] .tool-entry'));
    assert.equal(h.document.querySelector("#loadSessionToolsButton")?.textContent, "Reload tools");
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { if (heldSend) h.releaseHeldSend(); h.close(); }
});

test("background Session progress does not discard a newly loaded active directory", async () => {
  const state = toolsState();
  state.openSettingsOnLoad = false;
  let hold = false;
  let release: (() => void) | undefined;
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return { ...snapshot, sessionToolCatalog: catalog(snapshot.activeSessionId) };
  } });
  let heldSend = false;
  try {
    h.holdNextSend();
    heldSend = true;
    h.input("#prompt", "Inspect the track");
    h.click("#sendButton");
    await Promise.resolve();
    const sendId = h.sendIds[0]!;
    hold = true;
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await h.settle();
    h.click("#settingsButton");
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    assert.ok(release);
    h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1",
      event: { id: "background-result", kind: "assistant", content: "Still working",
        createdAt: "2026-09-25T00:01:00.000Z" } });
    release();
    await h.settle();
    assert.ok(h.document.querySelector(".tool-entry"));
    assert.equal(h.document.querySelector("#loadSessionToolsButton")?.textContent, "Reload tools");
    assert.deepEqual(h.errors, []);
  } finally {
    release?.();
    if (heldSend) h.releaseHeldSend();
    h.close();
  }
});

test("a failed tool load unlocks retry and keeps the localized error inside Tools", async () => {
  const state = toolsState();
  state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async () => { throw new Error("Tool discovery failed."); } });
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    await h.settle();
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSessionToolsButton")?.disabled, false);
    assert.equal(h.document.querySelector("#loadSessionToolsButton")?.textContent, "加载工具");
    assert.equal(h.document.querySelector("#sessionToolsStatus")?.textContent, "工具列表未能加载，可以重试。");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
