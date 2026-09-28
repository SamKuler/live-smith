import assert from "node:assert/strict";
import test from "node:test";
import type { StandaloneMcpConnectionView } from "../plugins/integration-connections.js";
import { audioState, service } from "./chat-dialog.audio-test-helpers.js";
import { commandCalls, createDialogHarness, stateFixture, waitForCondition } from "./chat-dialog.test-harness.js";

const direct: StandaloneMcpConnectionView = {
  id: "direct-one", name: "Studio MCP", enabled: true,
  mcp: { type: "streamable-http", url: "https://mcp.example.test/tools" },
  configuredSecrets: ["Authorization", "X-Optional"], artifactInputApproved: false, artifactOutputApproved: false,
};

function withDirect(connection = direct) {
  return { ...stateFixture(), integrationConnections: { revision: "3", connections: [connection] } };
}

const editor = '.plugin-connection-editor';
const field = (name: string) => `${editor} [name="${name}"]`;

test("audio and MCP have separate lists and preserve public drafts without starting a server on open", async () => {
  const state = audioState();
  const harness = await createDialogHarness({ ...state, integrationConnections: {
    revision: "3", connections: [...state.integrationConnections.connections, direct],
  } });
  try {
    harness.click("#extensionsTab");
    assert.equal(harness.document.querySelectorAll("#audioServiceSelector > [role=listitem]").length, 1);
    assert.equal(harness.document.querySelectorAll("#audioServiceSelector .connection-edit").length, 1);
    assert.equal(harness.document.querySelectorAll("#audioServiceSelector .connection-meta .audio-service-status").length, 1);
    assert.equal(harness.document.querySelectorAll("#mcpConnectionList > [role=listitem]").length, 1);
    assert.equal(harness.document.querySelector("#mcpConnectionList [data-audio-service-id]"), null);
    assert.equal(harness.document.querySelector('#audioServiceSelector [data-connection-id="direct-one"]'), null);
    assert.equal(harness.document.querySelector("#audioServiceSelector .connection-remove"), null);
    assert.equal(harness.document.querySelectorAll("#pluginList > *").length, 0);
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServicesSettings")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#mcpSettings")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("mcpUrl"))?.value, direct.mcp.type === "streamable-http" ? direct.mcp.url : "");
    harness.input(field("connectionName"), "MCP draft name");
    harness.input(field("secretValue-0"), "temporary-credential");
    harness.click(`[data-audio-service-id="${service.id}"]`);
    assert.equal(harness.document.querySelector<HTMLElement>("#mcpSettings")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServicesSettings")?.hidden, false);
    harness.click("#mcpExtensionTab");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("connectionName"))?.value, "MCP draft name");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.value, "");
    harness.click(`${editor} .editor-discard`);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("connectionName"))?.value, direct.name);
    harness.click("#addMcpConnectionButton");
    harness.click(`${editor} .editor-discard`);
    assert.equal(harness.document.activeElement?.id, "addConnectionButton");
    assert.equal(harness.document.querySelector<HTMLElement>("#mcpConnectionEditor")?.hidden, true);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("MCP editor actions follow public and credential changes and Discard restores the saved record", async () => {
  const harness = await createDialogHarness(withDirect());
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    const actions = () => [...harness.document.querySelectorAll<HTMLButtonElement>(`${editor} .editor-actions > button`)];
    assert.deepEqual(actions().map((button) => button.textContent), ["Remove", "Discard", "Save"]);
    assert.equal(actions()[2]?.getAttribute("aria-label"), "Save connection");
    assert.deepEqual(actions().map((button) => button.disabled), [false, true, true]);
    const name = harness.document.querySelector<HTMLInputElement>(field("connectionName"))!;
    name.focus();
    harness.input(field("connectionName"), "Draft name");
    assert.equal(harness.document.activeElement, name);
    assert.equal(harness.document.querySelector(field("connectionName")), name);
    assert.deepEqual(actions().map((button) => button.disabled), [false, false, false]);
    harness.input(field("connectionName"), direct.name);
    assert.deepEqual(actions().map((button) => button.disabled), [false, true, true]);
    harness.input(field("secretValue-0"), "replacement");
    assert.equal(actions()[2]?.disabled, false);
    harness.input(field("secretValue-0"), "");
    assert.equal(actions()[2]?.disabled, true);
    harness.click(field("clearSecret-0"));
    assert.equal(actions()[2]?.disabled, false);
    harness.click("#skillsExtensionTab");
    harness.click("#mcpExtensionTab");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("clearSecret-0"))?.checked, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.disabled, true);
    harness.click(`${editor} .editor-discard`);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("clearSecret-0"))?.checked, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.placeholder, "Saved; leave blank to keep");
    assert.deepEqual(actions().map((button) => button.disabled), [false, true, true]);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("audio and MCP lists retain one shared connection quota and unique names", async () => {
  const state = audioState();
  const full = await createDialogHarness({ ...state, integrationConnections: { revision: "3", connections: [
    ...state.integrationConnections.connections,
    ...Array.from({ length: 19 }, (_, index) => ({ ...direct, id: `mcp-${index}`, name: `MCP ${index}` })),
  ] } });
  try {
    assert.equal(full.document.querySelectorAll("#audioServiceSelector .connection-row").length, 1);
    assert.equal(full.document.querySelectorAll("#mcpConnectionList .connection-row").length, 19);
    assert.equal(full.document.querySelector<HTMLButtonElement>("#addAudioServiceButton")?.disabled, true);
    assert.equal(full.document.querySelector<HTMLButtonElement>("#addConnectionButton")?.disabled, true);
    assert.equal(commandCalls(full).length, 0);
    assert.deepEqual(full.errors, []);
  } finally { full.close(); }
  const harness = await createDialogHarness(state);
  try {
    harness.click("#addMcpConnectionButton");
    harness.input(field("connectionName"), service.name.toUpperCase());
    harness.input(field("mcpUrl"), "https://mcp.example.test");
    harness.click(`${editor} .editor-save`);
    await harness.settle();
    assert.match(harness.document.querySelector(".plugin-connection-feedback")?.textContent ?? "", /unique connection name/u);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a new MCP draft requires a name and target and Discard closes it without a write", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addConnectionButton");
    assert.equal(harness.document.activeElement?.id, "addMcpConnectionButton");
    harness.click("#addMcpConnectionButton");
    const save = () => harness.document.querySelector<HTMLButtonElement>(`${editor} .editor-save`)!;
    assert.equal(harness.document.querySelector(`${editor} .editor-remove`), null);
    assert.equal(save().disabled, true);
    harness.input(field("connectionName"), "New server");
    assert.equal(save().disabled, true);
    harness.input(field("mcpUrl"), "https://mcp.example.test");
    assert.equal(save().disabled, false);
    harness.select(field("mcpTransport"), "stdio");
    assert.equal(save().disabled, true);
    harness.input(field("mcpCommand"), "/opt/bin/server");
    assert.equal(save().disabled, false);
    harness.click(`${editor} .editor-discard`);
    assert.equal(harness.document.querySelector(editor), null);
    assert.equal(harness.document.activeElement?.id, "addConnectionButton");
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("new HTTP MCP saves an explicit endpoint after confirmation and keeps header values write-only", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addConnectionButton");
    harness.click("#addMcpConnectionButton");
    harness.input(field("connectionName"), "Remote tools");
    harness.input(field("mcpUrl"), "http://127.0.0.2:8181/mcp");
    harness.click(".mcp-secret-fields .plugin-section-heading button");
    harness.input(field("secretName-0"), "Authorization");
    harness.input(field("secretValue-0"), "Bearer private-fixture-value");
    harness.click(`${editor} button[type=submit]`);
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected explicit endpoint confirmation.");
    assert.match(harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "", /http:\/\/127\.0\.0\.2:8181\/mcp/u);
    assert.doesNotMatch(harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "", /private-fixture-value/u);
    assert.equal(commandCalls(harness).length, 0);
    await harness.acceptAppConfirmation();
    await harness.settle();
    const saved = (commandCalls(harness).at(-1)?.body as any).integrationConnections;
    assert.equal(saved.action, "upsert");
    assert.equal(saved.expectedRevision, "0");
    assert.deepEqual(saved.connection.mcp, { type: "streamable-http", url: "http://127.0.0.2:8181/mcp" });
    assert.equal(saved.connection.secrets.Authorization, "Bearer private-fixture-value");
    assert.equal(Object.hasOwn(saved.connection, "pluginId"), false);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0")), null);
    harness.click(`[data-connection-id="${saved.connection.id}"] .connection-choice`);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretName-0"))?.value, "Authorization");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.placeholder, "Saved; leave blank to keep");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("stdio review shows literal command arguments, cwd and env names with independent artifact grants", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addMcpConnectionButton");
    harness.input(field("connectionName"), "Local MIDI");
    harness.select(field("mcpTransport"), "stdio");
    harness.input(field("mcpCommand"), "/opt/local/bin/node");
    harness.input(field("mcpArgs"), "/opt/my server/main.js\n--label=two words\n$(literal)");
    harness.input(field("mcpCwd"), "/opt/my server");
    harness.click(".mcp-secret-fields .plugin-section-heading button");
    harness.input(field("secretName-0"), "ACCESS_TOKEN");
    harness.input(field("secretValue-0"), "private local value");
    harness.click(field("artifactOutputApproved"));
    harness.click(`${editor} button[type=submit]`);
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected local process confirmation.");
    const review = harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "";
    for (const value of ["/opt/local/bin/node", "/opt/my server/main.js", "--label=two words", "$(literal)", "/opt/my server", "ACCESS_TOKEN"]) {
      assert.ok(review.includes(value), value);
    }
    assert.doesNotMatch(review, /private local value/u);
    await harness.acceptAppConfirmation();
    await harness.settle();
    const connection = (commandCalls(harness).at(-1)?.body as any).integrationConnections.connection;
    assert.deepEqual(connection.mcp, { type: "stdio", command: "/opt/local/bin/node",
      args: ["/opt/my server/main.js", "--label=two words", "$(literal)"], cwd: "/opt/my server" });
    assert.equal(connection.artifactInputApproved, false);
    assert.equal(connection.artifactOutputApproved, true);
    assert.equal(Object.hasOwn(connection, "approved"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("saved MCP headers are omitted when unchanged and explicit clear removes only that header", async () => {
  const harness = await createDialogHarness(withDirect());
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.placeholder, "Saved; leave blank to keep");
    harness.input(field("connectionName"), "Renamed MCP");
    harness.click(`${editor} button[type=submit]`);
    await harness.settle();
    assert.equal(Object.hasOwn((commandCalls(harness).at(-1)?.body as any).integrationConnections.connection, "secrets"), false);
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.click(field("clearSecret-1"));
    harness.click(`${editor} button[type=submit]`);
    await harness.settle();
    assert.deepEqual((commandCalls(harness).at(-1)?.body as any).integrationConnections.connection.secrets, { "X-Optional": "" });
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    assert.equal(harness.document.querySelectorAll('.mcp-secret-row').length, 1);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretName-0"))?.value, "Authorization");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("retargeting clears typed credentials, withdraws keep hints, and confirms the new endpoint", async () => {
  const harness = await createDialogHarness(withDirect());
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.input(field("secretValue-0"), "unsaved-old-target-secret");
    harness.input(field("mcpUrl"), "https://new.example.test/mcp");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.placeholder, "");
    harness.click(`${editor} button[type=submit]`);
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected changed endpoint confirmation.");
    assert.match(harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "", /new\.example\.test/u);
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(Object.hasOwn((commandCalls(harness).at(-1)?.body as any).integrationConnections.connection, "secrets"), false);
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    assert.equal(harness.document.querySelectorAll('.mcp-secret-row').length, 0);
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("mcpUrl"))?.value, "https://new.example.test/mcp");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("enabling a saved standalone MCP connection requires reviewing its endpoint", async () => {
  const state = withDirect({ ...direct, enabled: false });
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.click(field("connectionEnabled"));
    harness.click(`${editor} button[type=submit]`);
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected enabling confirmation.");
    assert.equal(commandCalls(harness).length, 0);
    assert.match(harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "", /mcp\.example\.test\/tools/u);
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal((commandCalls(harness).at(-1)?.body as any).integrationConnections.connection.enabled, true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a failed MCP settings save retains the credential replacement for an explicit retry", async () => {
  const harness = await createDialogHarness(withDirect());
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.input(field("secretValue-0"), "Bearer replacement-fixture");
    harness.failNextCommand("Settings could not be saved", "integrationConnections");
    harness.click(`${editor} button[type=submit]`);
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("secretValue-0"))?.value, "Bearer replacement-fixture");
    harness.click(`${editor} button[type=submit]`);
    await harness.settle();
    const writes = commandCalls(harness).map((call) => (call.body as any).integrationConnections.connection);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(harness.document.querySelector(editor), null);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("restoring the saved MCP target reveals the credentials that will still be kept", async () => {
  const harness = await createDialogHarness(withDirect());
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.input(field("mcpUrl"), "https://other.example.test/mcp");
    harness.click('.mcp-secret-row button');
    harness.input(field("secretName-0"), "X-Other-Target");
    harness.input(field("secretValue-0"), "other-target-only");
    harness.input(field("mcpUrl"), "https://mcp.example.test/tools");
    const names = [...harness.document.querySelectorAll<HTMLInputElement>('[name^="secretName-"]')].map((input) => input.value);
    assert.deepEqual(names.sort(), ["Authorization", "X-Optional"]);
    assert.equal(harness.document.querySelectorAll('.mcp-secret-row input[placeholder="Saved; leave blank to keep"]').length, 2);
    assert.deepEqual([...harness.document.querySelectorAll<HTMLInputElement>('[name^="secretValue-"]')].map((input) => input.value), ["", ""]);
    assert.equal(harness.document.querySelector<HTMLButtonElement>(`${editor} .editor-save`)?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLButtonElement>(`${editor} .editor-discard`)?.disabled, true);
    harness.input(field("connectionName"), "Renamed after restoring target");
    harness.click(`${editor} button[type=submit]`);
    await harness.settle();
    assert.equal(Object.hasOwn((commandCalls(harness).at(-1)?.body as any).integrationConnections.connection, "secrets"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const action of ["save", "remove"] as const) test(`uncertain MCP ${action} keeps the editor and its warning after state reconciliation`, async () => {
  const state = withDirect();
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-connection-id="direct-one"] .connection-choice');
    harness.input(field("connectionName"), "Edited connection");
    const reconciled = { ...state, integrationConnections: { revision: "4",
      connections: action === "save" ? [{ ...direct, name: "Edited connection" }] : [] } };
    harness.failNextCommand("Settings outcome unknown.", undefined, { commandOutcome: "unknown", state: reconciled });
    if (action === "save") harness.click(`${editor} button[type=submit]`);
    else {
      harness.click(`${editor} .connection-remove`);
      await harness.acceptAppConfirmation();
    }
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>(field("connectionName"))?.value, "Edited connection");
    const feedback = harness.document.querySelector<HTMLElement>(".plugin-connection-feedback");
    assert.equal(feedback?.hidden, false);
    assert.match(feedback?.textContent ?? "", /Settings outcome unknown/u);
    assert.equal(commandCalls(harness).length, 1);
    harness.click(`${editor} .editor-discard`);
    if (action === "save") {
      assert.equal(harness.document.querySelector<HTMLInputElement>(field("connectionName"))?.value, "Edited connection");
      assert.equal(harness.document.querySelector<HTMLButtonElement>(`${editor} .editor-save`)?.disabled, true);
      harness.input(field("connectionName"), "Explicit next change");
      harness.click(`${editor} .editor-save`);
      await harness.settle();
      assert.equal((commandCalls(harness).at(-1)?.body as any).integrationConnections.expectedRevision, "4");
    } else {
      assert.equal(harness.document.querySelector(editor), null);
      assert.equal(commandCalls(harness).length, 1);
    }
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("switching from audio to MCP clears the entered audio key and a pure Skills Plugin needs no connection", async () => {
  const state = audioState();
  const harness = await createDialogHarness({ ...state, plugins: [{ id: "skills-only", sha256: "a".repeat(64),
    sourceFormat: "agent-plugins-1.0", enabled: true, skillCount: 1, mcpServers: [], unsupportedComponents: [], issues: [] }] });
  try {
    harness.input("#audioServiceApiKey", "audio-draft-secret");
    harness.click("#addMcpConnectionButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")?.value, "");
    assert.equal(harness.document.querySelector("#pluginManager .plugin-manage-connections"), null);
    assert.equal(harness.document.querySelector("#pluginConnectionSources")?.childElementCount, 0);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
