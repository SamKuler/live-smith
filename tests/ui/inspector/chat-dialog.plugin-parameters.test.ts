import assert from "node:assert/strict";
import test from "node:test";
import { pluginParameterPanel } from "../../../src/plugins/parameter-panel.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

function panelState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.integrationConnections = { revision: "1", connections: [{
    id: "generator", name: "Pattern generator", enabled: true,
    mcp: { type: "stdio", command: "node", args: ["server.mjs"] }, configuredSecrets: [],
    artifactInputApproved: false, artifactOutputApproved: false,
  }] };
  const panel = pluginParameterPanel("mcp_generator_generate", {
    type: "object", additionalProperties: false,
    properties: {
      bars: { type: "integer", title: "Bars", minimum: 1, maximum: 8, default: 4 },
      density: { type: "number", title: "Density", minimum: 0, maximum: 1, multipleOf: 0.1, default: 0.5 },
      division: { type: "integer", title: "Division", enum: [4, 8, 16], default: 8 },
      keepDrums: { type: "boolean", title: "Keep drums", default: true },
      note: { type: "string", title: "Note", minLength: 2, maxLength: 8 },
    }, required: ["bars", "division", "keepDrums"],
  }, {})!;
  state.sessionToolCatalog = {
    sessionId: state.activeSessionId, loadedAt: "2026-09-28T00:00:00.000Z",
    modelToolsSupported: false, truncated: false, issues: [],
    groups: [{ kind: "mcp", serverId: "server", connectionId: "generator", connectionName: "Pattern generator",
      tools: [{ name: "generate", description: "Generate one pattern.", panel }] }],
  };
  return state;
}

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const form = ".plugin-parameters";
function controlFor(h: Harness, title: string) {
  const label = [...h.document.querySelectorAll<HTMLLabelElement>(`${form} label[for]`)]
    .find((entry) => entry.textContent === title);
  return label ? h.document.getElementById(label.htmlFor) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null : null;
}
function field(h: Harness, title: string): string {
  const control = controlFor(h, title);
  assert.ok(control, `Expected the control labelled ${title}.`);
  return "#" + control.id;
}
function openPanel(h: Harness) {
  h.click("#sessionInspectorScope");
  h.click("#toolsTab");
  h.click('.tool-group > summary');
  h.click('.tool-entry > summary');
}

test("native parameter controls submit typed values directly and display the saved result", async () => {
  const state = panelState();
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => ({
    ...snapshot, sessionToolCatalog: state.sessionToolCatalog!,
  }) });
  try {
    openPanel(h);
    assert.equal(controlFor(h, "Bars")!.value, "4");
    assert.equal(controlFor(h, "Note")!.disabled, true);
    const densitySlider = h.document.querySelector<HTMLInputElement>(`${form} input[type="range"][aria-label="Density"]`)!;
    densitySlider.stepUp();
    densitySlider.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    assert.equal(controlFor(h, "Density")!.value, "0.6");
    h.input(field(h, "Bars"), "6");
    h.input(`${form} input[type="range"][aria-label="Density"]`, "0.7");
    h.select(field(h, "Division"), "2");
    h.click(field(h, "Keep drums"));
    const result = cloneState(state);
    result.events.push({ id: "panel-result", createdAt: "2026-09-28T00:01:00.000Z", kind: "tool_result",
      name: "mcp_generator_generate", content: JSON.stringify({ content: [{ type: "text", text: "Pattern ready <img src=x>" }] }) });
    delete result.sessionToolCatalog;
    h.setServerState(result);
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    await waitForCondition(() => Boolean(h.document.querySelector(".plugin-result-summary")),
      "Expected the completed tool result after directory refresh: " + h.document.querySelector("#sessionToolsStatus")?.textContent);
    const calls = commandCalls(h);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.body, { kind: "run_plugin_tool", sessionId: state.activeSessionId,
      toolName: "mcp_generator_generate", signature: state.sessionToolCatalog!.groups[0]!.tools[0]!.panel!.signature,
      arguments: { bars: 6, density: 0.7, division: 16, keepDrums: false } });
    assert.equal(h.calls.some((call) => call.path === "/send"), false);
    assert.match(h.document.querySelector(".plugin-result-summary")?.textContent ?? "", /Pattern ready <img src=x>/);
    assert.equal(h.document.querySelector(".plugin-result-card img"), null);
    assert.equal(controlFor(h, "Bars")!.value, "6");
    assert.equal(h.document.querySelector<HTMLDetailsElement>(".tool-entry")!.open, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("optional omission, constraints and reset preserve form semantics", async () => {
  const state = panelState();
  const h = await createDialogHarness(state);
  try {
    openPanel(h);
    h.input(field(h, "Bars"), "9");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 0);
    h.input(field(h, "Bars"), "3");
    h.click(`${form} [aria-label="Include Note"]`);
    h.input(field(h, "Note"), "x");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 0);
    h.click(`${form} [aria-label="Include Note"]`);
    h.click(`${form} [aria-label="Include Density"]`);
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.deepEqual((commandCalls(h)[0]!.body as { arguments: unknown }).arguments,
      { bars: 3, division: 8, keepDrums: true });
    await waitForCondition(() => h.document.querySelector<HTMLButtonElement>(`${form} button[type="submit"]`)?.disabled === false,
      "Expected the command to release parameter execution.");
    h.click(`${form} button[type="button"]`);
    assert.equal(controlFor(h, "Bars")!.value, "4");
    assert.equal(controlFor(h, "Density")!.disabled, false);
    assert.equal(controlFor(h, "Note")!.disabled, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("parameter drafts follow their Session and connection, and invalid remote panels stay unavailable", async () => {
  const state = panelState();
  const catalog = state.sessionToolCatalog!;
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => ({
    ...snapshot, sessionToolCatalog: { ...catalog, sessionId: snapshot.activeSessionId },
  }) });
  try {
    openPanel(h);
    h.input(field(h, "Bars"), "7");
    const stale = h.document.querySelector<HTMLFormElement>(form)!;
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => controlFor(h, "Bars")?.value === "4",
      "Expected the new Session to start with defaults.");
    stale.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(commandCalls(h).some((call) => (call.body as { kind: string }).kind === "run_plugin_tool"), false);
    h.input(field(h, "Bars"), "6");
    const changed = cloneState(state);
    changed.integrationConnections!.revision = "2";
    delete changed.sessionToolCatalog;
    h.setServerState(changed);
    h.emitServerEvent({ type: "global_state_invalidated" });
    await waitForCondition(() => controlFor(h, "Bars")?.value === "4",
      "Expected a changed connection to discard its old parameter draft.");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
  const invalid = cloneState(state);
  (invalid.sessionToolCatalog!.groups[0]!.tools[0]!.panel!.fields[0] as unknown as { default: unknown }).default = "wrong type";
  delete state.sessionToolCatalog;
  const rejected = await createDialogHarness(state, undefined, { toolCatalogResponse: async () => invalid });
  try {
    await rejected.settle();
    assert.equal(rejected.document.querySelector(form), null);
    assert.match(rejected.document.querySelector("#sessionToolsStatus")!.textContent ?? "", /not loaded/);
    assert.deepEqual(rejected.errors, []);
  } finally { rejected.close(); }
});

test("parameter execution uses the existing cancellable command lifecycle", async () => {
  const h = await createDialogHarness(panelState());
  let held = false;
  try {
    openPanel(h);
    h.holdNextCommand();
    held = true;
    h.click(`${form} button[type="submit"]`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.document.querySelector<HTMLFieldSetElement>(".plugin-parameters-fields")!.disabled, false);
    assert.equal(h.document.querySelector<HTMLButtonElement>(`${form} button[type="submit"]`)!.disabled, true);
    h.input(field(h, "Bars"), "6");
    h.document.querySelector<HTMLFormElement>(form)!
      .dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(commandCalls(h).length, 1);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    h.click("#sendButton");
    h.releaseHeldCommand();
    held = false;
    await h.settle();
    assert.equal(commandCalls(h).length, 1);
    assert.ok(h.calls.some((call) => call.path === "/stop"));
    await waitForCondition(() => h.document.querySelector<HTMLButtonElement>(`${form} button[type="submit"]`)?.disabled === false,
      "Expected Stop to release parameter execution.");
    assert.equal(h.document.querySelector<HTMLFieldSetElement>(".plugin-parameters-fields")!.disabled, false);
    assert.equal(controlFor(h, "Bars")!.value, "6");
    assert.equal(h.document.querySelector<HTMLButtonElement>(`${form} button[type="submit"]`)!.disabled, false);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("cached MCP parameters can be edited and reset during a model send while execution remains gated", async () => {
  const state = panelState();
  state.sessionToolCatalog!.groups[0]!.tools[0]!.app = {
    resourceUri: "ui://generator/app.html", signature: "b".repeat(64), toolName: "mcp_generator_generate",
  };
  const h = await createDialogHarness(state);
  let heldSend = false;
  try {
    h.holdNextSend(); heldSend = true;
    h.input("#prompt", "Inspect this track"); h.click("#sendButton");
    await h.settle();
    openPanel(h);
    const app = h.document.querySelector<HTMLButtonElement>(".plugin-open-app")!;
    assert.equal(app.disabled, true);
    app.click();
    assert.equal(h.calls.some((call) => call.path === "/plugin-apps/open"), false);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSessionToolsButton")!.disabled, true);
    h.click("#loadSessionToolsButton");
    h.click(".tool-parameter-fallback > summary");
    assert.equal(controlFor(h, "Bars")!.matches(":disabled"), false);
    h.input(field(h, "Bars"), "7");
    h.click(`${form} [aria-label="Include Note"]`);
    h.input(field(h, "Note"), "Draft");
    const reset = h.document.querySelector<HTMLButtonElement>(`${form} button[type="button"]`)!;
    assert.equal(reset.matches(":disabled"), false);
    reset.click();
    assert.equal(controlFor(h, "Bars")!.value, "4");
    assert.equal(controlFor(h, "Note")!.disabled, true);
    h.input(field(h, "Bars"), "6");
    h.input(`${form} input[type="range"][aria-label="Density"]`, "0.7");
    h.select(field(h, "Division"), "2");
    h.click(field(h, "Keep drums"));
    const run = h.document.querySelector<HTMLButtonElement>(`${form} button[type="submit"]`)!;
    assert.equal(run.disabled, true);
    h.document.querySelector<HTMLFormElement>(form)!
      .dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(commandCalls(h).length, 0);
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 0);
    h.releaseHeldSend(); heldSend = false;
    await h.settle();
    await waitForCondition(() => !run.disabled, "Expected MCP tool execution to resume when the send finishes.");
    assert.equal(app.disabled, false);
    assert.equal(controlFor(h, "Bars")!.value, "6");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.deepEqual(commandCalls(h).map((call) => call.body), [{
      kind: "run_plugin_tool", sessionId: state.activeSessionId, toolName: "mcp_generator_generate",
      signature: state.sessionToolCatalog!.groups[0]!.tools[0]!.panel!.signature,
      arguments: { bars: 6, density: 0.7, division: 16, keepDrums: false },
    }]);
    assert.equal(h.calls.filter((call) => call.path === "/send").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { if (heldSend) h.releaseHeldSend(); await h.settle(); h.close(); }
});

test("parameter labels localize while authored values and failed results remain literal", async () => {
  const state = panelState();
  state.settings.uiLanguage = "zh-CN";
  state.events.push({ id: "error-result", createdAt: "2026-09-28T00:00:00.000Z", kind: "tool_result",
    name: "mcp_generator_generate", content: "Remote tool unavailable" });
  const h = await createDialogHarness(state);
  try {
    openPanel(h);
    assert.equal(h.document.querySelector(`${form} button[type="submit"]`)!.textContent, "运行工具");
    assert.match(h.document.querySelector(form)!.textContent ?? "", /Bars/);
    assert.match(h.document.querySelector(".plugin-parameter-result")!.textContent ?? "", /Remote tool unavailable/);
    h.failNextCommand("Tool definition changed. Reload tools.");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("integer bounds use valid integral steps when the schema limits are fractional", async () => {
  const state = panelState();
  const panel = state.sessionToolCatalog!.groups[0]!.tools[0]!.panel!;
  panel.fields = [{ name: "bars", title: "Bars", type: "integer", minimum: 0.5, maximum: 5.5, required: true, default: 1 }];
  const h = await createDialogHarness(state);
  try {
    openPanel(h);
    const input = controlFor(h, "Bars")!;
    assert.equal(input.validity.stepMismatch, false);
    h.input(`${form} input[type="range"]`, "2");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.deepEqual((commandCalls(h)[0]!.body as { arguments: unknown }).arguments, { bars: 2 });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("non-aligned numeric multiples keep an editable number control without an invalid slider", async () => {
  const state = panelState();
  state.sessionToolCatalog!.groups[0]!.tools[0]!.panel!.fields = [{
    name: "bars", title: "Bars", type: "integer", minimum: 1, maximum: 9, multipleOf: 2, required: true, default: 2,
  }];
  const h = await createDialogHarness(state);
  try {
    openPanel(h);
    assert.equal(h.document.querySelector(`${form} input[type="range"]`), null);
    h.input(field(h, "Bars"), "4");
    h.click(`${form} button[type="submit"]`);
    await h.settle();
    assert.deepEqual((commandCalls(h)[0]!.body as { arguments: unknown }).arguments, { bars: 4 });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("schema parameter names stay separate from native form methods and retain typed payload keys", async () => {
  const definitions = new Map<string, Record<string, unknown>>([
    ["append", { type: "string", default: "Initial text" }],
    ["addEventListener", { type: "boolean", default: true }],
    ["reportValidity", { type: "integer", minimum: 1, maximum: 8, default: 4 }],
    ["constructor", { type: "number", minimum: 0, maximum: 1, multipleOf: 0.1, default: 0.5 }],
    ["__proto__", { type: "string", minLength: 1 }],
  ]);
  for (const names of [["append"], ["addEventListener"], ["reportValidity"], [...definitions.keys()]]) {
    const state = panelState();
    state.sessionToolCatalog!.groups[0]!.tools[0]!.panel = pluginParameterPanel("mcp_generator_generate", {
      type: "object", additionalProperties: false,
      properties: Object.fromEntries(names.map((name) => [name, definitions.get(name)])),
      required: names.filter((name) => name !== "__proto__"),
    }, {})!;
    const h = await createDialogHarness(state);
    try {
      openPanel(h);
      const nativeForm = h.document.querySelector<HTMLFormElement>(form)!;
      const expected = new Map<string, string | number | boolean>();
      for (const name of names) {
        assert.equal(nativeForm.elements.namedItem(name), null, `Schema name ${name} must not become a form property.`);
        if (name === "addEventListener") { h.click(field(h, name)); expected.set(name, false); }
        else {
          if (name === "__proto__") h.click(`${form} [aria-label="Include __proto__"]`);
          const value = name === "reportValidity" ? 6 : name === "constructor" ? 0.7 : "Edited " + name;
          h.input(field(h, name), String(value));
          expected.set(name, value);
        }
      }
      h.click(`${form} button[type="submit"]`);
      await h.settle();
      assert.equal(commandCalls(h).length, 1);
      assert.deepEqual((commandCalls(h)[0]!.body as { arguments: unknown }).arguments, Object.fromEntries(expected));
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});
