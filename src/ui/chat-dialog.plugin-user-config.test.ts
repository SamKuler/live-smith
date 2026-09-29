import assert from "node:assert/strict";
import test from "node:test";

import type { PluginConfigView } from "../plugins/user-config.js";
import type { ChatBridgeState } from "./chat-state.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const panel = "#pluginUserConfig-studio-tools";
const form = `${panel} form`;
const field = (name: string) => `${form} [name="${name}"]`;
const control = (h: Harness, name: string) => h.document.querySelector<HTMLInputElement>(field(name))!;
const config = (state: ChatBridgeState) => state.plugins[0]!.userConfig!;

function configState(): ChatBridgeState {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const userConfig: PluginConfigView = {
    revision: "1",
    fields: [
      { name: "directory", type: "directory", title: "Output directory", description: "Local destination", required: true, default: "/Music" },
      { name: "configFile", type: "file", title: "Config file", description: "Optional source file" },
      { name: "amount", type: "number", title: "Amount", description: "Fractional amount", min: 0, max: 1, default: 0.25, required: true },
      { name: "enabled", type: "boolean", title: "Enabled", description: "Apply processing", default: false, required: true },
      { name: "mode", type: "string", title: "Mode", description: "Processing mode", options: ["steady", "swing"], default: "steady" },
      { name: "tags", type: "string", title: "Tags", description: "Independent text values", multiple: true, default: ["drums\nbass", "lead"] },
      { name: "note", type: "string", title: "Note", description: "Optional note" },
      { name: "token", type: "string", title: "Access token", description: "Private access credential", sensitive: true },
    ],
    values: { directory: "/Saved", configFile: "/Saved/settings.json", amount: 0.5, enabled: false, mode: "steady", tags: ["drums\nbass", "lead"] },
    configuredSecrets: ["token"],
    invalidFields: [],
  };
  state.plugins = [{
    id: "studio-tools", sha256: "a".repeat(64), version: "1.0.0", sourceFormat: "claude", enabled: false,
    skillCount: 0, skills: [], mcpServers: [], unsupportedComponents: [], issues: [], userConfig,
  }];
  return state;
}

function open(h: Harness): void {
  h.click("#extensionsTab");
  h.click("#pluginsExtensionTab");
  h.click(`${panel} > summary`);
}

async function idle(h: Harness): Promise<void> {
  await waitForCondition(() => h.document.querySelector<HTMLFieldSetElement>(`${form} fieldset`)?.disabled === false,
    "Expected the Plugin configuration command to release the form.");
  await h.settle();
}

async function refresh(h: Harness, state: ChatBridgeState, ready: () => boolean): Promise<void> {
  h.setServerState(state);
  h.emitServerEvent({ type: "global_state_invalidated" });
  await waitForCondition(ready, "Expected the Plugin configuration snapshot to refresh.");
}

test("Plugin configuration uses typed native controls and preserves independent multiline list values", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  let held = false;
  try {
    open(h);
    assert.equal(h.document.querySelector(`${panel} > summary`)!.textContent, "Plugin parameters");
    assert.equal(control(h, "token").type, "password");
    assert.equal(control(h, "token").value, "");
    assert.equal(control(h, "note").disabled, true);
    assert.equal(control(h, "enabled").getAttribute("role"), "switch");
    h.input(field("directory"), "/Projects/Final");
    h.input(field("amount"), "0.75");
    h.click(field("enabled"));
    h.select(field("mode"), "swing");
    h.click(`${form} [aria-label="Include Config file"]`);
    h.click(`${form} [aria-label="Include Note"]`);
    h.input(field("note"), "<img src=x>\nKeep timing");
    h.click(`${form} [aria-label="Add Tags item"]`);
    h.input(`${field("tags")}[data-item-index="2"]`, "kick\nsnare");
    const values = { directory: "/Projects/Final", amount: 0.75, enabled: true, mode: "swing",
      tags: ["drums\nbass", "lead", "kick\nsnare"], note: "<img src=x>\nKeep timing" };
    const saved = cloneState(state);
    config(saved).revision = "2";
    config(saved).values = values;
    h.setServerState(saved);
    h.holdNextCommand(); held = true;
    h.click(`${form} [data-config-action="save"]`);
    await h.settle();
    assert.equal(h.document.querySelector<HTMLFieldSetElement>(`${form} fieldset`)!.disabled, true);
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "set_plugin_user_config", pluginId: "studio-tools",
      sha256: state.plugins[0]!.sha256, revision: "1", values, secretUpdates: {} });
    h.releaseHeldCommand(); held = false;
    await idle(h);
    assert.equal(control(h, "amount").value, "0.75");
    assert.equal(control(h, "token").value, "");
    assert.equal(h.document.querySelector<HTMLDetailsElement>(panel)!.open, true);
    assert.equal(h.document.querySelector(`${form} img`), null);
    assert.equal(h.calls.some((call) => call.path === "/send"), false);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("number bounds, required text and list edits validate before a configuration command", async () => {
  const h = await createDialogHarness(configState());
  try {
    open(h);
    for (const value of ["", "-0.1", "1.1"]) {
      h.input(field("amount"), value);
      h.click(`${form} [data-config-action="save"]`);
      await h.settle();
      assert.equal(commandCalls(h).length, 0);
      assert.equal(control(h, "amount").getAttribute("aria-invalid"), "true");
      assert.match(h.document.querySelector('[data-config-field="amount"] .error')!.textContent!, /Amount/);
    }
    h.input(field("amount"), "0.125");
    h.input(field("directory"), "  ");
    h.click(`${form} [data-config-action="save"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 0);
    assert.equal(h.document.activeElement, control(h, "directory"));
    h.input(field("directory"), "/Music");
    h.click(`${form} [aria-label="Remove Tags item 1"]`);
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    const submitted = commandCalls(h)[0]!.body as { values: Record<string, unknown> };
    assert.equal(submitted.values.amount, 0.125);
    assert.deepEqual(submitted.values.tags, ["lead"]);
    assert.equal(submitted.values.enabled, false, "a required boolean may be false");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("secrets remain write-only, survive a failed save as drafts, and clear only by explicit choice", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  try {
    open(h);
    assert.equal(h.document.querySelector('[data-config-field="token"] .plugin-user-config-secret-status')!.textContent, "Configured");
    h.input(field("token"), "replacement-fixture");
    h.failNextCommand("Configuration storage is unavailable.");
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.equal(control(h, "token").value, "replacement-fixture");
    assert.match(h.document.querySelector(`${form} .plugin-user-config-status`)!.textContent!, /storage is unavailable/);
    const saved = cloneState(state);
    config(saved).revision = "2";
    h.setServerState(saved);
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[1]!.body as { secretUpdates: unknown }).secretUpdates, { token: "replacement-fixture" });
    assert.equal(control(h, "token").value, "");
    assert.doesNotMatch(h.document.querySelector(panel)!.textContent!, /replacement-fixture/);
    h.click(`${form} [aria-label="Clear Access token"]`);
    assert.equal(control(h, "token").disabled, true);
    const cleared = cloneState(saved);
    config(cleared).revision = "3";
    config(cleared).configuredSecrets = [];
    h.setServerState(cleared);
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[2]!.body as { secretUpdates: unknown }).secretUpdates, { token: null });
    assert.equal(h.document.querySelector('[data-config-field="token"] .plugin-user-config-secret-status')!.textContent, "Not configured");
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[3]!.body as { secretUpdates: unknown }).secretUpdates, {});
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("discard restores saved values and defaults preserve pending secret replacements", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  try {
    open(h);
    h.input(field("directory"), "/Draft");
    h.input(field("token"), "discarded-fixture");
    h.click(`${form} [data-config-action="discard"]`);
    assert.equal(control(h, "directory").value, "/Saved");
    assert.equal(control(h, "token").value, "");
    h.input(field("token"), "retained-fixture");
    h.click(`${form} [aria-label="Include Note"]`);
    h.input(field("note"), "Draft note");
    h.click(`${form} [data-config-action="defaults"]`);
    assert.equal(control(h, "directory").value, "/Music");
    assert.equal(control(h, "amount").value, "0.25");
    assert.equal(control(h, "configFile").disabled, true);
    assert.equal(control(h, "note").disabled, true);
    assert.equal(control(h, "token").value, "retained-fixture");
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "set_plugin_user_config", pluginId: "studio-tools",
      sha256: state.plugins[0]!.sha256, revision: "1", values: { directory: "/Music", amount: 0.25,
        enabled: false, mode: "steady", tags: ["drums\nbass", "lead"] }, secretUpdates: { token: "retained-fixture" } });
    assert.equal(control(h, "token").value, "", "known success clears secrets even when a test host echoes the same revision");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("an unknown save outcome preserves the current draft and its private replacement", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  try {
    open(h);
    h.input(field("directory"), "/Unconfirmed");
    h.input(field("token"), "unconfirmed-fixture");
    h.failNextCommand("The save outcome is unknown.", undefined, { commandOutcome: "unknown", state });
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.equal(control(h, "directory").value, "/Unconfirmed");
    assert.equal(control(h, "token").value, "unconfirmed-fixture");
    assert.match(h.document.querySelector(`${form} .plugin-user-config-status`)!.textContent!, /outcome is unknown/);
    h.click(`${form} [data-config-action="discard"]`);
    assert.equal(control(h, "directory").value, "/Saved");
    assert.equal(control(h, "token").value, "");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("sensitive numeric, boolean and list fields submit only explicit typed replacements", async () => {
  const state = configState();
  config(state).fields.push(
    { name: "privateAmount", type: "number", title: "Private amount", description: "", sensitive: true, min: 0, max: 1 },
    { name: "privateFlag", type: "boolean", title: "Private flag", description: "", sensitive: true },
    { name: "privateList", type: "string", title: "Private list", description: "", sensitive: true, multiple: true },
  );
  config(state).configuredSecrets.push("privateAmount", "privateFlag", "privateList");
  const h = await createDialogHarness(state);
  try {
    open(h);
    assert.equal(control(h, "privateAmount").type, "password");
    assert.equal(control(h, "privateAmount").inputMode, "decimal");
    assert.equal(control(h, "privateAmount").value, "");
    assert.equal(control(h, "privateFlag").type, "password");
    assert.equal(control(h, "privateFlag").value, "");
    assert.equal(control(h, "privateFlag").getAttribute("role"), null);
    assert.equal(h.document.querySelector(field("privateList")), null);
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[0]!.body as { secretUpdates: unknown }).secretUpdates, {});
    h.input(field("privateFlag"), "false");
    h.click(`${form} [aria-label="Add Private list item"]`);
    assert.equal(control(h, "privateList").type, "password");
    h.input(field("privateList"), "list-fixture");
    for (const value of ["not-a-number", "1.25", "Infinity"]) {
      h.input(field("privateAmount"), value);
      h.click(`${form} [data-config-action="save"]`);
      await h.settle();
      assert.equal(commandCalls(h).length, 1);
      assert.equal(control(h, "privateAmount").getAttribute("aria-invalid"), "true");
    }
    h.input(field("privateAmount"), "0.625");
    h.input(field("privateFlag"), "unknown");
    h.click(`${form} [data-config-action="save"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 1);
    assert.equal(control(h, "privateFlag").getAttribute("aria-invalid"), "true");
    h.input(field("privateFlag"), "false");
    h.click(`${form} [aria-label="Clear Access token"]`);
    h.click(`${form} [aria-label="Clear Access token"]`);
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[1]!.body as { secretUpdates: unknown }).secretUpdates,
      { privateAmount: 0.625, privateFlag: false, privateList: ["list-fixture"] });
    assert.equal(control(h, "privateAmount").value, "");
    assert.equal(control(h, "privateFlag").value, "");
    assert.equal(h.document.querySelector(field("privateList")), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("configuration drafts survive redraws and Session changes only while their package and revision match", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  try {
    open(h);
    h.input(field("directory"), "/Draft");
    h.input(field("token"), "draft-fixture");
    const redrawn = cloneState(state);
    redrawn.plugins[0]!.description = "Updated package description";
    await refresh(h, redrawn, () => h.document.querySelector("#installedPlugin-studio-tools")!.textContent!.includes("Updated package description"));
    assert.equal(control(h, "directory").value, "/Draft");
    assert.equal(control(h, "token").value, "draft-fixture");
    assert.equal(h.document.querySelector<HTMLDetailsElement>(panel)!.open, true);
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await h.settle();
    assert.equal(control(h, "directory").value, "/Draft");
    assert.equal(control(h, "token").value, "draft-fixture");
    const obsolete = h.document.querySelector<HTMLFormElement>(form)!;
    const revised = cloneState(redrawn);
    config(revised).revision = "2";
    config(revised).values.directory = "/Current";
    await refresh(h, revised, () => control(h, "directory").value === "/Current");
    assert.equal(control(h, "token").value, "");
    const before = commandCalls(h).length;
    obsolete.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    await h.settle();
    assert.equal(commandCalls(h).length, before);
    h.input(field("directory"), "/Next draft");
    const replaced = cloneState(revised);
    replaced.plugins[0]!.sha256 = "b".repeat(64);
    await refresh(h, replaced, () => control(h, "directory").value === "/Current");
    h.input(field("directory"), "/Removed draft");
    const removed = cloneState(replaced);
    removed.plugins = [];
    await refresh(h, removed, () => h.document.querySelector(panel) === null);
    await refresh(h, replaced, () => h.document.querySelector(panel) !== null);
    assert.equal(control(h, "directory").value, "/Current");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("marked schema drift remains editable while an unconfigured required secret blocks saving", async () => {
  const state = configState();
  config(state).values.amount = "obsolete value";
  config(state).invalidFields = ["amount", "token"];
  config(state).configuredSecrets = [];
  config(state).fields.find((field) => field.name === "token")!.required = true;
  const h = await createDialogHarness(state);
  try {
    open(h);
    assert.equal(control(h, "amount").getAttribute("aria-invalid"), "true");
    h.input(field("amount"), "0.5");
    h.click(`${form} [data-config-action="save"]`);
    await h.settle();
    assert.equal(commandCalls(h).length, 0);
    assert.equal(h.document.activeElement, control(h, "token"));
    h.input(field("token"), "configured-fixture");
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("declared parameter names do not collide with object prototypes or native form methods", async () => {
  const state = configState();
  config(state).fields = ["constructor", "append", "addEventListener"].map((name) => ({
    name, type: "string", title: name, description: "", required: false,
  }));
  config(state).values = {};
  config(state).configuredSecrets = [];
  const h = await createDialogHarness(state);
  try {
    open(h);
    assert.equal(control(h, "constructor").disabled, true);
    assert.equal(control(h, "constructor").value, "");
    for (const name of ["constructor", "append", "addEventListener"]) {
      h.click(`${form} [aria-label="Include ${name}"]`);
      h.input(field(name), name + " value");
    }
    h.click(`${form} [data-config-action="save"]`);
    await idle(h);
    assert.deepEqual((commandCalls(h)[0]!.body as { values: unknown }).values,
      { constructor: "constructor value", append: "append value", addEventListener: "addEventListener value" });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("configuration wire validation rejects secret disclosure and malformed field contracts", async () => {
  const state = configState();
  const h = await createDialogHarness(state);
  let held = false;
  try {
    h.holdNextSend(); held = true;
    h.input("#prompt", "Inspect the current track");
    h.click("#sendButton");
    await h.settle();
    const view = config(state);
    const amount = view.fields.find((field) => field.name === "amount")!;
    const token = view.fields.find((field) => field.name === "token")!;
    const invalid = [
      null, {}, { ...view, revision: "01" }, { ...view, revision: "-1" }, { ...view, extra: true },
      { ...view, values: { ...view.values, token: "forbidden-fixture" } },
      { ...view, values: { ...view.values, missing: "undeclared" } },
      { ...view, values: { ...view.values, amount: 2 } },
      { ...view, values: { ...view.values, amount: "0.5" } },
      { ...view, values: { ...view.values, tags: [null] } },
      { ...view, fields: [...view.fields, amount] },
      { ...view, fields: [{ ...amount, default: 2 }] },
      { ...view, fields: [{ ...amount, min: 1, max: 0 }] },
      { ...view, fields: [{ ...amount, required: "yes" }] },
      { ...view, fields: [{ ...amount, multiple: true }] },
      { ...view, fields: [{ ...token, default: "forbidden-fixture" }] },
      { ...view, fields: [{ ...token, options: ["one"] }] },
      { ...view, fields: [{ ...token, extra: "forbidden-fixture" }] },
      { ...view, configuredSecrets: ["directory"] },
      { ...view, configuredSecrets: ["token", "token"] },
      { ...view, invalidFields: ["missing"] },
      { ...view, invalidFields: ["amount", "amount"] },
    ];
    for (const userConfig of invalid) {
      h.emitServerEvent({ type: "done", sendId: h.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, plugins: [{ ...state.plugins[0], userConfig }] } });
      await h.settle();
      assert.match(h.document.querySelector("#sendButton")!.textContent!, /Stop/, JSON.stringify(userConfig));
      assert.equal(control(h, "directory").value, "/Saved");
      assert.doesNotMatch(JSON.stringify(h.readBootstrappedClientStateReference()), /forbidden-fixture/);
    }
    h.releaseHeldSend(); held = false;
    await h.settle();
    assert.match(h.document.querySelector("#sendButton")!.textContent!, /Send/);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldSend(); await h.settle(); h.close(); }
});
