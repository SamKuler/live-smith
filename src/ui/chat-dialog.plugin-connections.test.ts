import assert from "node:assert/strict";
import test from "node:test";

import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import { commandCalls, createDialogHarness, stateFixture, waitForCondition } from "./chat-dialog.test-harness.js";

test("audio and MCP connection entries describe distinct setup paths", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "tool-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "transcribe", type: "stdio", target: "./bin/transcribe", args: [], envNames: [], approved: true,
        artifactInputApproved: false, artifactOutputApproved: false, credentialFields: [] },
      { id: "private-api", type: "streamable-http", target: "https://example.test", approved: true,
        artifactInputApproved: false, artifactOutputApproved: false,
        credentialFields: [{ name: "TOKEN", required: true }] },
    ] }];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector("#audioSettingsHeading")?.textContent, "Audio services");
    assert.equal(harness.document.querySelector("#addAudioServiceButton")?.textContent, "Add audio connection");
    const servers = [...harness.document.querySelectorAll(".plugin-server-group")];
    assert.equal(servers[0]?.querySelector(".plugin-add-connection"), null);
    assert.match(servers[0]?.textContent ?? "", /No connection setup needed/u);
    assert.equal(servers[1]?.querySelector(".plugin-add-connection")?.textContent, "Add MCP connection");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("MCP connection errors stay visible in Plugin settings and required credentials are checked before saving", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "tool-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "private-api", type: "streamable-http", target: "https://example.test", approved: true,
        artifactInputApproved: false, artifactOutputApproved: false,
        credentialFields: [{ name: "TOKEN", required: true }] },
    ] }];
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-add-connection");
    harness.input('.plugin-connection-editor [name="connectionName"]', "Primary");
    harness.click('.plugin-connection-editor button[type="submit"]');
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);
    assert.match(harness.document.querySelector(".plugin-connection-feedback")?.textContent ?? "", /TOKEN/u);
    harness.input('.plugin-connection-editor [name="TOKEN"]', "secret");
    harness.failNextCommand("Unable to save this connection", "integrationConnections");
    harness.click('.plugin-connection-editor button[type="submit"]');
    await harness.settle();
    assert.match(harness.document.querySelector(".plugin-connection-feedback")?.textContent ?? "", /Unable to save this connection/u);
    assert.doesNotMatch(harness.document.querySelector("#status")?.textContent ?? "", /Unable to save this connection/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("saved MCP connection actions identify their account and keep state separate from its name", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "tool-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "private-api", type: "streamable-http", target: "https://example.test", approved: true,
        artifactInputApproved: false, artifactOutputApproved: false,
        credentialFields: [{ name: "TOKEN", required: true }] },
    ] }];
  state.integrationConnections = { revision: "1", connections: [{ id: "primary", name: "A long named account",
    pluginId: "tool-plugin", enabled: true,
    configuration: { serverId: "private-api", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    const row = harness.document.querySelector(".plugin-connection-row");
    assert.equal(row?.querySelector(".plugin-connection-name")?.textContent, "A long named account");
    assert.equal(row?.querySelector(".plugin-connection-state")?.textContent, "Enabled");
    assert.match(row?.querySelector<HTMLButtonElement>("button.secondary")?.getAttribute("aria-label") ?? "",
      /Edit.*A long named account/u);
    assert.match(row?.querySelector<HTMLButtonElement>("button.danger-action")?.getAttribute("aria-label") ?? "",
      /Remove.*A long named account/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("clearing a required MCP credential first requires disabling its saved connection", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "tool-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "private-api", type: "streamable-http", target: "https://example.test", approved: true,
        artifactInputApproved: false, artifactOutputApproved: false,
        credentialFields: [{ name: "TOKEN", required: true }] },
    ] }];
  state.integrationConnections = { revision: "1", connections: [{ id: "primary", name: "Primary",
    pluginId: "tool-plugin", enabled: true,
    configuration: { serverId: "private-api", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-connection-row button.secondary");
    harness.click(".plugin-clear-secret input");
    harness.click('.plugin-connection-editor button[type="submit"]');
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);
    assert.match(harness.document.querySelector(".plugin-connection-feedback")?.textContent ?? "", /TOKEN/u);
    harness.click('.plugin-connection-editor [name="connectionEnabled"]');
    harness.click('.plugin-connection-editor button[type="submit"]');
    await harness.settle();
    const connection = (commandCalls(harness).at(-1)?.body as any)?.integrationConnections?.connection;
    assert.equal(connection.enabled, false);
    assert.equal(connection.secrets.TOKEN, "");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("historical no-credential MCP connections remain removable without offering new ones", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "tool-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: false, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "transcribe", type: "stdio", target: "./bin/transcribe", args: [], envNames: [], approved: false,
        artifactInputApproved: false, artifactOutputApproved: false, credentialFields: [] },
    ] }];
  state.integrationConnections = { revision: "1", connections: [{ id: "legacy", name: "Legacy",
    pluginId: "tool-plugin", enabled: true,
    configuration: { serverId: "transcribe", pluginDigest: "a".repeat(64) }, configuredSecrets: [] }] };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector(".plugin-add-connection"), null);
    assert.match(harness.document.querySelector(".plugin-connection-row")?.textContent ?? "", /Legacy/u);
    harness.click(".plugin-connection-row .danger-action");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal((commandCalls(harness).at(-1)?.body as any)?.integrationConnections?.action, "remove");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Plugin manager saves two named server connections without dropping an audio connection", async () => {
  const state = stateFixture();
  state.plugins = [{
    id: "accounts-plugin", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [],
    mcpServers: [{ id: "remote", type: "streamable-http", target: "https://example.test",
      approved: true, artifactInputApproved: false, artifactOutputApproved: false,
      credentialFields: [{ name: "TOKEN", required: true }] }],
  }];
  state.integrationConnections = { revision: "0", connections: [{
    id: "audio-existing", name: "Existing audio", pluginId: builtInAudioPluginId("lalal"),
    enabled: false, configuration: {}, configuredSecrets: [],
  }] };
  const harness = await createDialogHarness(state);
  try {
    const add = () => harness.click('[data-plugin-id="accounts-plugin"] .plugin-add-connection');
    const save = async (name: string, token: string) => {
      add();
      harness.input('.plugin-connection-editor [name="connectionName"]', name);
      harness.input('.plugin-connection-editor [name="TOKEN"]', token);
      harness.click('.plugin-connection-editor button[type="submit"]');
      await harness.settle();
    };
    await save("First account", "first-secret");
    await waitForCondition(() => harness.document.querySelectorAll(".plugin-connection-row").length === 1,
      "Expected the first named connection.");
    await save("Second account", "second-secret");
    await waitForCondition(() => harness.document.querySelectorAll(".plugin-connection-row").length === 2,
      "Expected both named connections.");
    const writes = commandCalls(harness).filter((call) =>
      (call.body as { kind?: string }).kind === "save_global_settings");
    assert.equal(writes.length, 2);
    assert.notEqual((writes[0]!.body as any).integrationConnections.connection.id,
      (writes[1]!.body as any).integrationConnections.connection.id);
    assert.equal((writes[0]!.body as any).integrationConnections.connection.secrets.TOKEN, "first-secret");
    assert.equal((writes[1]!.body as any).integrationConnections.connection.secrets.TOKEN, "second-secret");
    assert.match(harness.document.querySelector(".plugin-server-connections")?.textContent ?? "", /First account.*Second account/su);
    assert.doesNotMatch(harness.document.body.textContent ?? "", /first-secret|second-secret/u);
    assert.equal(harness.document.querySelector("#audioServiceSelector")?.textContent?.includes("Existing audio"), true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a connection for a removed MCP server remains visible and removable", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts-plugin", sha256: "b".repeat(64),
    sourceFormat: "agent-plugins-1.0", enabled: false, skillCount: 0,
    mcpServers: [], unsupportedComponents: [], issues: [] }];
  state.integrationConnections = { revision: "4", lastChangeTouchesAudio: false,
    connections: [{ id: "old-account", name: "Old account", pluginId: "accounts-plugin",
      enabled: true, configuration: { serverId: "removed", pluginDigest: "a".repeat(64) },
      configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    assert.match(harness.document.querySelector(".plugin-orphan-connections")?.textContent ?? "", /Old account.*removed/u);
    assert.equal(harness.document.querySelector<HTMLButtonElement>(".plugin-card-actions .danger-action")?.disabled, true);
    harness.click(".plugin-orphan-connections .danger-action");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, { kind: "save_global_settings",
      integrationConnections: { action: "remove", expectedRevision: "4", connectionId: "old-account" } });
    assert.equal(harness.document.querySelector(".plugin-orphan-connections"), null);
    assert.equal(harness.document.querySelector<HTMLButtonElement>(".plugin-card-actions .danger-action")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a stale remove confirmation cannot delete a connection changed by a peer", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts-plugin", sha256: "b".repeat(64),
    sourceFormat: "agent-plugins-1.0", enabled: false, skillCount: 0,
    mcpServers: [], unsupportedComponents: [], issues: [] }];
  state.integrationConnections = { revision: "3", lastChangeTouchesAudio: false,
    connections: [{ id: "account", name: "Account", pluginId: "accounts-plugin", enabled: false,
      configuration: { serverId: "removed", pluginDigest: "a".repeat(64) },
      configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-orphan-connections .danger-action");
    const changed = { ...state, integrationConnections: { revision: "4", lastChangeTouchesAudio: false,
      connections: [{ ...state.integrationConnections.connections[0]!, name: "Changed account" }] } };
    harness.setServerState(changed);
    harness.emitServerEvent({ type: "global_state_invalidated" });
    await harness.settle();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(commandCalls(harness).filter((call) =>
      (call.body as { kind?: string }).kind === "save_global_settings").length, 0);
    assert.match(harness.document.querySelector(".plugin-orphan-connections")?.textContent ?? "", /Changed account/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Plugin editor clears an optional saved credential and submits an own-key placeholder", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts-plugin", sha256: "a".repeat(64),
    sourceFormat: "agent-plugins-1.0", enabled: true, skillCount: 0,
    unsupportedComponents: [], issues: [], mcpServers: [{ id: "remote", type: "streamable-http",
      target: "https://example.test", approved: true, artifactInputApproved: false,
      artifactOutputApproved: false, credentialFields: [{ name: "TOKEN", required: false },
        { name: "__proto__", required: true }] }] }];
  state.integrationConnections = { revision: "3", lastChangeTouchesAudio: false,
    connections: [{ id: "account", name: "Account", pluginId: "accounts-plugin", enabled: false,
      configuration: { serverId: "remote", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-connection-row button.secondary");
    assert.equal((harness.document.activeElement as HTMLInputElement).name, "connectionName");
    harness.click(".plugin-clear-secret input");
    harness.input('.plugin-connection-editor [name="__proto__"]', "owned-secret");
    harness.click('.plugin-connection-editor button[type="submit"]');
    await harness.settle();
    const body = commandCalls(harness).at(-1)?.body as { integrationConnections?: {
      connection?: { secrets?: Record<string, string> } } };
    const secrets = body.integrationConnections?.connection?.secrets;
    assert.ok(secrets);
    assert.equal(Object.hasOwn(secrets, "__proto__"), true);
    assert.equal(secrets.__proto__, "owned-secret");
    assert.equal(secrets.TOKEN, "");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a package replacement cannot silently bind an open editor's credential draft to the new package", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts-plugin", sha256: "a".repeat(64),
    sourceFormat: "agent-plugins-1.0", enabled: false, skillCount: 0,
    unsupportedComponents: [], issues: [], mcpServers: [{ id: "remote", type: "streamable-http",
      target: "https://example.test", approved: false, artifactInputApproved: false,
      artifactOutputApproved: false, credentialFields: [{ name: "TOKEN", required: true }] }] }];
  state.integrationConnections = { revision: "3", lastChangeTouchesAudio: false,
    connections: [{ id: "account", name: "Account", pluginId: "accounts-plugin", enabled: false,
      configuration: { serverId: "remote", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-connection-row button.secondary");
    harness.input('.plugin-connection-editor [name="TOKEN"]', "draft-for-old-package");
    harness.setServerState({ ...state, plugins: [{ ...state.plugins[0]!, sha256: "b".repeat(64) }] });
    harness.emitServerEvent({ type: "global_state_invalidated" });
    await harness.settle();
    const submit = harness.document.querySelector<HTMLButtonElement>('.plugin-connection-editor button[type="submit"]');
    submit?.click();
    await harness.settle();
    assert.equal(commandCalls(harness).filter((call) =>
      (call.body as { kind?: string }).kind === "save_global_settings").length, 0);
    assert.equal(harness.document.querySelector('.plugin-connection-editor [name="TOKEN"]'), null);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an unrelated Plugin state refresh keeps a pending credential visible in its editor", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts-plugin", sha256: "a".repeat(64), description: "Old description",
    sourceFormat: "agent-plugins-1.0", enabled: false, skillCount: 0,
    unsupportedComponents: [], issues: [], mcpServers: [{ id: "remote", type: "streamable-http",
      target: "https://example.test", approved: false, artifactInputApproved: false,
      artifactOutputApproved: false, credentialFields: [{ name: "TOKEN", required: true }] }] }];
  state.integrationConnections = { revision: "3", lastChangeTouchesAudio: false,
    connections: [{ id: "account", name: "Account", pluginId: "accounts-plugin", enabled: false,
      configuration: { serverId: "remote", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"] }] };
  const harness = await createDialogHarness(state);
  try {
    harness.click(".plugin-connection-row button.secondary");
    harness.input('.plugin-connection-editor [name="TOKEN"]', "pending-secret");
    harness.setServerState({ ...state, plugins: [{ ...state.plugins[0]!, description: "Updated description" }] });
    harness.emitServerEvent({ type: "global_state_invalidated" });
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>('.plugin-connection-editor [name="TOKEN"]')?.value,
      "pending-secret");
    assert.equal(commandCalls(harness).filter((call) =>
      (call.body as { kind?: string }).kind === "save_global_settings").length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
