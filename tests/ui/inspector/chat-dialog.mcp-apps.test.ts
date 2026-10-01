import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { pluginParameterPanel } from "../../../src/plugins/parameter-panel.js";
import type { ChatBridgeState } from "../../../src/ui/chat-state.js";
import { commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const pluginId = "pattern-workbench";
const card = "#installedPlugin-" + pluginId;
const cardButton = card + " .plugin-open-app";
const toolName = "plg_pattern_workbench_pattern_lab";

function appState(): ChatBridgeState {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.plugins = [{ id: pluginId, sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0", version: "1.0.0",
    description: "A local pattern workbench", enabled: true, skillCount: 0, skills: [], unsupportedComponents: [], issues: [],
    mcpServers: [{ id: "fixture", type: "stdio", approved: true, artifactInputApproved: false, artifactOutputApproved: false,
      target: "node", args: ["server.mjs"], envNames: [], credentialFields: [] }],
  }];
  delete state.sessionToolCatalog;
  return state;
}

function withCatalog(state: ChatBridgeState, name = "pattern_lab", signature = "b".repeat(64), loadedAt = "2026-09-28T00:00:00.000Z"): ChatBridgeState {
  const panel = pluginParameterPanel(toolName, { type: "object", additionalProperties: false,
    properties: { bars: { type: "number", title: "Bars", minimum: 1, maximum: 8, default: 4 } }, required: ["bars"],
  }, {})!;
  return { ...state, sessionToolCatalog: { sessionId: state.activeSessionId, loadedAt,
    modelToolsSupported: true, truncated: false, issues: [], groups: [{ kind: "mcp", pluginId, serverId: "fixture",
      tools: [{ name, description: "Preview a deterministic pattern.", panel,
        app: { resourceUri: "ui://pattern-lab/app.html", signature, toolName } }],
    }],
  } };
}

function showPlugins(h: Harness): void {
  h.click("#settingsButton");
  h.click("#extensionsTab");
  h.click("#pluginsExtensionTab");
  assert.equal(h.document.querySelector<HTMLElement>("#pluginManager")!.hidden, false);
}

function rejectAppOpens(h: Harness): void {
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname !== "/plugin-apps/open") return response;
    return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "App opening rejected by the fixture." }) };
  } });
}

async function expectFailedOpen(h: Harness, selector: string, sessionId: string, signature: string): Promise<void> {
  const previous = jsonCalls(h, "/plugin-apps/open").length;
  h.click(selector);
  await waitForCondition(() => h.document.querySelector(".plugin-app-status")?.textContent === "MCP App could not load.",
    "Expected the deliberately rejected App open to finish.");
  const opens = jsonCalls(h, "/plugin-apps/open");
  assert.equal(opens.length, previous + 1);
  const body = opens.at(-1)!.body as { id: string };
  assert.match(body.id, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.deepEqual(body, { id: body.id, sessionId, toolName, signature });
  assert.equal(h.document.querySelector(".plugin-app-frame"), null);
  assert.equal(h.calls.some((call) => call.path === "/plugin-apps/call" || call.path === "/send"), false);
  assert.equal(commandCalls(h).some((call) => (call.body as { kind: string }).kind === "run_plugin_tool"), false);
  h.click(".plugin-app-close");
  await waitForCondition(() => h.document.querySelector(".plugin-app-dialog") === null, "Expected the App error dialog to close.");
}

test("automatic App discovery adds the Plugin card entry without visiting Tools and preserves the native fallback panel", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const state = appState();
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => {
    await pending;
    return withCatalog(snapshot);
  } });
  try {
    rejectAppOpens(h);
    showPlugins(h);
    assert.equal(h.document.querySelector(cardButton), null);
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    release();
    await waitForCondition(() => h.document.querySelector(cardButton)?.textContent === "Open interface: pattern_lab",
      "Expected asynchronous discovery to update the already visible Plugin card.");
    assert.equal(h.document.querySelector<HTMLElement>("#pluginManager")!.hidden, false);
    assert.equal(commandCalls(h).length, 0);
    await expectFailedOpen(h, cardButton, state.activeSessionId, "b".repeat(64));
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    h.click(".tool-group > summary");
    h.click(".tool-entry > summary");
    const entry = h.document.querySelector(".tool-entry")!;
    assert.equal(entry.querySelector(".plugin-open-app")!.textContent, "Open interface");
    const parameterLabel = entry.querySelector<HTMLLabelElement>('.plugin-parameters label[for]')!;
    assert.ok(entry.querySelector("#" + parameterLabel.htmlFor));
    assert.equal(entry.querySelector<HTMLDetailsElement>(".tool-parameter-fallback")!.open, false);
    assert.equal(entry.querySelector<HTMLDetailsElement>(".tool-information")!.open, false);
    assert.equal(entry.querySelector('.plugin-parameters button[type="submit"]')!.textContent, "Run tool");
    await expectFailedOpen(h, ".tool-entry .plugin-open-app", state.activeSessionId, "b".repeat(64));
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { release(); await h.settle(); h.close(); }
});

test("a replacement Session catalog refreshes the Plugin card label and binds opening to the current Session and signature", async () => {
  const pending: Array<{ state: ChatBridgeState; resolve(state: ChatBridgeState): void }> = [];
  const h = await createDialogHarness(appState(), undefined, { toolCatalogResponse: (state) =>
    new Promise((resolve) => { pending.push({ state, resolve }); }) });
  try {
    rejectAppOpens(h);
    showPlugins(h);
    assert.equal(pending.length, 1);
    pending[0]!.resolve(withCatalog(pending[0]!.state));
    await waitForCondition(() => h.document.querySelector(cardButton)?.textContent === "Open interface: pattern_lab", "Expected the first App entry.");
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => pending.length === 2, "Expected automatic discovery for the selected Session.");
    assert.equal(h.document.querySelector(cardButton), null, "the old Session's App entry is removed before its replacement loads");
    const replacement = withCatalog(pending[1]!.state, "updated_pattern", "c".repeat(64), "2026-09-28T00:01:00.000Z");
    pending[1]!.resolve(replacement);
    await waitForCondition(() => h.document.querySelector(cardButton)?.textContent === "Open interface: updated_pattern",
      "Expected the updated App entry without a manual Plugin or Tools redraw.");
    assert.equal(h.document.querySelectorAll(cardButton).length, 1);
    assert.equal(replacement.activeSessionId, "session-2");
    await expectFailedOpen(h, cardButton, "session-2", "c".repeat(64));
    assert.deepEqual(h.errors, []);
  } finally { for (const item of pending) item.resolve(withCatalog(item.state)); await h.settle(); h.close(); }
});

test("malformed App metadata cannot create Plugin or Tools interface entries", async () => {
  const h = await createDialogHarness(appState(), undefined, { toolCatalogResponse: async (state) => {
    const invalid = withCatalog(state);
    invalid.sessionToolCatalog!.groups[0]!.tools[0]!.app!.resourceUri = "https://untrusted.example/app.html";
    return invalid;
  } });
  try {
    showPlugins(h);
    await waitForCondition(() => h.document.querySelector("#sessionToolsStatus")!.textContent!.includes("not loaded"),
      "Expected invalid App metadata to reject the discovered catalog.");
    assert.equal(h.document.querySelector(cardButton), null);
    assert.equal(h.document.querySelector(".tool-entry .plugin-open-app"), null);
    assert.equal(jsonCalls(h, "/plugin-apps/open").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("closing a loading App cancels its HTTP open through the composed dialog", async () => {
  const h = await createDialogHarness(appState(), undefined, { toolCatalogResponse: async (state) => withCatalog(state) });
  let requestSignal: AbortSignal | undefined;
  let cancelled = false;
  let release!: (value: unknown) => void;
  const operations: string[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/plugin-apps/open") {
      operations.push("open"); requestSignal = init?.signal ?? undefined;
      const body = await new Promise((resolve, reject) => {
        release = resolve;
        requestSignal?.addEventListener("abort", () => { cancelled = true; reject(new Error("Opening cancelled")); }, { once: true });
      });
      return { ok: true, json: async () => body };
    }
    if (path === "/plugin-apps/close") { operations.push("close"); return { ok: true, json: async () => ({}) }; }
    return originalFetch(input, init);
  } });
  try {
    showPlugins(h);
    await waitForCondition(() => Boolean(h.document.querySelector(cardButton)), "Expected the App entry.");
    h.click(cardButton);
    await waitForCondition(() => operations.length > 0, "Expected the open request.");
    assert.ok(requestSignal, "The actual HTTP request must carry the opening signal.");
    h.click(".plugin-app-close");
    await waitForCondition(() => cancelled && !h.document.querySelector(".plugin-app-dialog"), "Closing must cancel pending discovery.");
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(operations, ["open", "close"]);
    await h.settle();
    assert.deepEqual(h.errors, []);
  } finally {
    release?.({ id: "late-instance", toolName: "pattern_lab", html: "<p>Pattern</p>", sandboxUrl: "http://127.0.0.1:31400/apps/fixture" });
    await h.settle(); h.close();
  }
});

test("closing during the App open response body releases the already created instance", async () => {
  const h = await createDialogHarness(appState(), undefined, { toolCatalogResponse: async (state) => withCatalog(state) });
  const instances = new Set<string>();
  const closed: string[] = [];
  let reading = false;
  let parsingRejected = false;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
    if (path === "/plugin-apps/open") {
      instances.add(body.id ?? "server-created-instance");
      reading = false; parsingRejected = false;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        reading = true;
        init?.signal?.addEventListener("abort", () => { parsingRejected = true; reject(new Error("Response reading cancelled")); }, { once: true });
      }) };
    }
    if (path === "/plugin-apps/close") {
      assert.ok(body.id);
      closed.push(body.id); instances.delete(body.id);
      return { ok: true, json: async () => ({}) };
    }
    return originalFetch(input, init);
  } });
  try {
    showPlugins(h);
    await waitForCondition(() => Boolean(h.document.querySelector(cardButton)), "Expected the App entry.");
    for (let attempt = 0; attempt < 4; attempt++) {
      reading = false; parsingRejected = false;
      h.click(cardButton);
      await waitForCondition(() => reading, "Expected the open response to begin parsing.");
      h.click(".plugin-app-close");
      await waitForCondition(() => parsingRejected && !h.document.querySelector(".plugin-app-dialog"), "Closing must stop response reading.");
      assert.equal(instances.size, 0, "The server-created instance must be addressable before its body is read.");
    }
    assert.equal(new Set(closed).size, 4);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
