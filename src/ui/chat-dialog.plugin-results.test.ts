import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { pluginParameterPanel } from "../plugins/parameter-panel.js";
import { commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "./chat-dialog.test-harness.js";

async function fixture(withApp = false, result: unknown = { content: [{ type: "text", text: "Three bars saved <img src=x>" }],
  artifacts: [{ kind: "midi", artifactRef: "midi-one", label: "Pattern", noteCount: 24, durationBeats: 12 }] }) {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.integrationConnections = { revision: "1", connections: [{ id: "patterns", name: "Patterns", enabled: true,
    mcp: { type: "stdio", command: "node", args: ["server.mjs"] }, configuredSecrets: [],
    artifactInputApproved: false, artifactOutputApproved: true }] };
  const panel = pluginParameterPanel("mcp_pattern", { type: "object", properties: {}, additionalProperties: false }, {})!;
  state.sessionToolCatalog = { sessionId: state.activeSessionId, loadedAt: "2026-09-30T00:00:00.000Z",
    modelToolsSupported: true, truncated: false, issues: [], groups: [{ kind: "mcp", serverId: "patterns", connectionId: "patterns", connectionName: "Patterns", tools: [
      { name: "pattern", description: "Saved pattern", panel,
        ...(withApp ? { app: { resourceUri: "ui://pattern/view", signature: "b".repeat(64), toolName: "mcp_pattern" } } : {}) },
    ] }] };
  state.events.push({ id: "result-one", createdAt: "2026-09-30T00:01:00.000Z", kind: "tool_result", name: "mcp_pattern",
    content: JSON.stringify(result) });
  const h = await createDialogHarness(state);
  h.click("#sessionInspectorScope"); h.click("#toolsTab");
  h.click(".tool-group > summary"); h.click(".tool-entry > summary");
  return { h, state };
}

test("saved tool result enters the composer without sending or losing existing text", async () => {
  const { h } = await fixture();
  try {
    h.input("#prompt", "Keep the bass line.");
    h.click(".plugin-result-chat");
    await h.settle();
    const prompt = h.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    assert.match(prompt.value, /^Keep the bass line\.\n\n/);
    assert.match(prompt.value, /mcp_pattern/);
    assert.match(prompt.value, /midi-one/);
    assert.equal(h.document.activeElement, prompt);
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.equal(commandCalls(h).length, 0);
    assert.equal(h.document.querySelector(".plugin-result-card img"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("structured-only results display literal bounded JSON and preserve artifact actions", async () => {
  const structuredContent = { tempo: 115, tracks: ["Lead", "<img src=x onerror=alert(1)>"] };
  const artifact = { kind: "midi", artifactRef: "structured-midi", label: "Structured pattern", noteCount: 24, durationBeats: 12 };
  const { h } = await fixture(false, { content: [], structuredContent,
    _meta: { "io.github.samkuler/live-smith-artifacts": { version: 1, artifacts: [artifact] } } });
  try {
    assert.equal(h.document.querySelector(".plugin-result-summary")!.textContent, JSON.stringify(structuredContent, null, 2));
    assert.equal(h.document.querySelector(".plugin-result-summary")!.tagName, "PRE");
    assert.equal(h.document.querySelector(".plugin-result-card img"), null);
    assert.equal(h.document.querySelector<HTMLOptionElement>(".plugin-result-artifact option")!.value, "structured-midi");
    h.click(".plugin-result-chat");
    await h.settle();
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /structured-midi/);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }

  const large = await fixture(false, { content: [], structuredContent: { data: "x".repeat(8_000) } });
  try {
    const summary = large.h.document.querySelector(".plugin-result-summary")!.textContent!;
    assert.match(summary, /^\{\n  "data": "x/u);
    assert.equal(summary.length, 2000);
    assert.deepEqual(large.h.errors, []);
  } finally { large.h.close(); }
});

test("structured errors retain their failure state and text results remain the summary", async () => {
  const structuredContent = { error: "<script>fixture()</script>", code: "invalid_pattern" };
  const failed = await fixture(false, { content: [], structuredContent, isError: true,
    artifacts: [{ kind: "midi", artifactRef: "failed-midi", label: "Failed pattern", noteCount: 0, durationBeats: 0 }] });
  try {
    assert.equal(failed.h.document.querySelector(".plugin-result-title")!.textContent, "Tool reported an error");
    assert.equal(failed.h.document.querySelector(".plugin-result-summary")!.textContent, JSON.stringify(structuredContent, null, 2));
    assert.equal(failed.h.document.querySelector(".plugin-result-card script"), null);
    assert.equal(failed.h.document.querySelector(".plugin-result-apply"), null);
    assert.ok(failed.h.document.querySelector(".plugin-result-chat"));
    assert.deepEqual(failed.h.errors, []);
  } finally { failed.h.close(); }

  const text = await fixture(false, { content: [{ type: "text", text: "Literal <img src=x> result" }], structuredContent });
  try {
    assert.equal(text.h.document.querySelector(".plugin-result-summary")!.textContent, "Literal <img src=x> result");
    assert.equal(text.h.document.querySelector(".plugin-result-card img"), null);
    assert.deepEqual(text.h.errors, []);
  } finally { text.h.close(); }
});

test("a delayed App close cannot place its result in another Session's composer", async () => {
  const { h } = await fixture(true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let closing = false;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/plugin-apps/open") return { ok: true, json: async () => ({ id: "app-one", toolName: "pattern",
      resourceUri: "ui://pattern/view", html: "<p>Pattern</p>", sandboxUrl: "http://127.0.0.1:32123/apps/test" }) };
    if (path === "/plugin-apps/close") { closing = true; await pending; return { ok: true, json: async () => ({}) }; }
    return originalFetch(input, init);
  } });
  try {
    h.click(".plugin-open-app");
    await waitForCondition(() => Boolean(h.document.querySelector<HTMLIFrameElement>(".plugin-app-frame")?.src), "Expected open App resource.");
    h.click(".plugin-result-chat");
    await waitForCondition(() => closing && !h.document.querySelector(".plugin-app-dialog"), "Expected delayed backend close after modal removal.");
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await h.settle();
    h.input("#prompt", "New Session draft");
    release();
    await h.settle();
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "New Session draft");
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { release(); await h.settle(); h.close(); }
});

test("MIDI result requests a scoped import with host confirmation and never reruns generation", async () => {
  const { h, state } = await fixture();
  let held = false;
  try {
    h.click(".plugin-result-import > summary");
    h.input(".plugin-result-track", "Lead");
    h.input(".plugin-result-beat", "9");
    h.holdNextCommand(); held = true;
    h.click(".plugin-result-apply");
    await waitForCondition(() => commandCalls(h).length === 1, "Expected explicit MIDI import command.");
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "import_midi_artifact", sessionId: state.activeSessionId,
      artifactRef: "midi-one", trackName: "Lead", startBeat: 8 });
    const event = { type: "command_confirm_request", commandId: h.commandIds.at(-1), sessionId: state.activeSessionId,
      id: "approval-one", kind: "apply", message: "Import this MIDI clip", groups: [{ title: "Lead", rows: ["Create clip at beat 9"] }] };
    h.emitRawServerEvent({ ...event, commandId: "wrong-command" });
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    h.emitRawServerEvent(event);
    await waitForCondition(() => !h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, "Expected import preview approval.");
    assert.match(h.document.querySelector("#appConfirmationDetails")!.textContent!, /Create clip at beat 9/);
    h.emitRawServerEvent(event);
    await h.acceptAppConfirmation();
    assert.deepEqual(jsonCalls(h, "/confirm").map((call) => call.body), [{ id: "approval-one", apply: true }]);
    assert.equal(commandCalls(h).length, 1);
    h.releaseHeldCommand(); held = false;
    await h.settle();
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("resolved command approval closes its dialog and cannot send a late acceptance", async () => {
  const { h, state } = await fixture();
  let held = false;
  try {
    h.input(".plugin-result-track", "Lead");
    h.holdNextCommand(); held = true;
    h.click(".plugin-result-apply");
    await waitForCondition(() => commandCalls(h).length === 1, "Expected MIDI import command.");
    const ids = { commandId: h.commandIds.at(-1), sessionId: state.activeSessionId, id: "approval-two" };
    h.emitRawServerEvent({ type: "command_confirm_request", ...ids, kind: "apply", message: "Import MIDI", groups: [{ title: "Lead", rows: ["Create MIDI clip"] }] });
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    h.emitRawServerEvent({ type: "command_confirm_resolved", ...ids });
    await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.document.querySelector(".app")!.hasAttribute("inert"), false);
    h.click("#appConfirmationAccept");
    assert.equal(jsonCalls(h, "/confirm").length, 0);
    h.releaseHeldCommand(); held = false;
    await h.settle();
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});
