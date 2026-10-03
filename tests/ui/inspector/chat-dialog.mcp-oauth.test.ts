import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

function state() {
  const value = stateFixture();
  value.integrationConnections = { revision: "1", connections: [{ id: "mcp-account", name: "Workspace MCP", enabled: true,
    mcp: { type: "streamable-http", url: "https://mcp.example.test/mcp" }, oauth: {}, configuredSecrets: [],
    artifactInputApproved: false, artifactOutputApproved: false }] };
  value.mcpOAuthStates = [{ connectionId: "mcp-account", status: "signed-out", generation: "none" }];
  return value;
}

test("remote MCP sign-in/out use explicit saved-connection commands and render credential-free status", async (t) => {
  const harness = await createDialogHarness(state());
  t.after(() => harness.close());
  harness.click('[data-connection-id="mcp-account"] .connection-choice');
  assert.equal(harness.document.querySelector<HTMLSelectElement>('[name="mcpAuthentication"]')!.value, "oauth");
  assert.match(harness.document.querySelector(".mcp-oauth-state")!.textContent!, /Sign-in required/u);
  harness.click(".mcp-oauth-sign-in");
  await harness.settle();
  assert.deepEqual(commandCalls(harness).at(-1)?.body, { kind: "start_mcp_oauth", connectionId: "mcp-account" });
  assert.equal(harness.document.querySelector(".mcp-oauth-state")!.textContent, "Signed in");
  harness.click(".mcp-oauth-sign-out");
  await harness.settle();
  assert.deepEqual(commandCalls(harness).at(-1)?.body, { kind: "logout_mcp_oauth", connectionId: "mcp-account" });
  assert.equal(harness.document.querySelector(".mcp-oauth-state")!.textContent, "Sign-in required");
  assert.deepEqual(harness.errors, []);
});

test("OAuth cannot start from an unsaved connection draft or save a public client without its callback", async (t) => {
  const harness = await createDialogHarness(state());
  t.after(() => harness.close());
  harness.click('[data-connection-id="mcp-account"] .connection-choice');
  harness.input('[name="mcpOAuthClientId"]', "public-client");
  assert.equal(harness.document.querySelector<HTMLButtonElement>(".mcp-oauth-sign-in")!.disabled, true);
  harness.click(".mcp-oauth-sign-in");
  assert.equal(commandCalls(harness).length, 0);
  harness.click(".plugin-connection-editor .editor-save");
  await harness.settle();
  assert.match(harness.document.querySelector(".plugin-connection-feedback")!.textContent!, /callback port/u);
  assert.equal(commandCalls(harness).length, 0);
  harness.input('[name="mcpOAuthCallbackPort"]', "49321");
  harness.click(".plugin-connection-editor .editor-save");
  await harness.settle();
  const saved = commandCalls(harness).at(-1)?.body as { integrationConnections: { connection: { oauth: unknown } } };
  assert.deepEqual(saved.integrationConnections.connection.oauth, { clientId: "public-client", callbackPort: 49321 });
  assert.equal(commandCalls(harness).some((entry) => (entry.body as { kind: string }).kind === "start_mcp_oauth"), false);
});

test("Plugin OAuth connects with declared defaults in one save and preserves saved authentication choices", async (t) => {
  const value = pluginState();
  const h = await createDialogHarness(value);
  t.after(() => h.close());
  h.click(".plugin-add-connection");
  assert.equal(h.document.querySelector<HTMLSelectElement>('[name="mcpAuthentication"]')!.value, "oauth");
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="mcpOAuthClientId"]')!.value, "workspace-client");
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="mcpOAuthCallbackPort"]')!.value, "49321");
  assert.equal(h.document.querySelector('[name="mcpUrl"]'), null);
  h.select('[name="mcpAuthentication"]', "manual");
  h.select('[name="mcpAuthentication"]', "oauth");
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="mcpOAuthClientId"]')!.value, "workspace-client");
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="connectionName"]')!.value, "workspace");
  assert.equal(h.document.querySelector(".plugin-connection-editor .editor-save")!.textContent, "Connect and sign in");
  h.click(".plugin-connection-editor .editor-save");
  await h.settle();
  const commands = commandCalls(h);
  const saved = (commands[0]!.body as any).integrationConnections.connection;
  assert.equal(commands.length, 2);
  assert.deepEqual(saved.oauth, { clientId: "workspace-client", callbackPort: 49321 });
  assert.deepEqual(saved.configuration, { serverId: "remote", pluginDigest: "a".repeat(64) });
  assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "start_mcp_oauth", connectionId: saved.id });
  assert.equal(h.document.querySelector(".mcp-oauth-state")!.textContent, "Signed in");
  h.select('[name="mcpAuthentication"]', "manual");
  h.click(".plugin-connection-editor .editor-save");
  await h.settle();
  h.click(".plugin-manage-connections");
  assert.equal(h.document.querySelector<HTMLSelectElement>('[name="mcpAuthentication"]')!.value, "manual");
  assert.deepEqual(h.errors, []);
});

function pluginState() {
  const value = stateFixture();
  value.plugins = [{ id: "workspace", sha256: "a".repeat(64), sourceFormat: "claude", enabled: true,
    skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [{ id: "remote", type: "streamable-http",
      target: "https://example.test", approved: true, artifactInputApproved: false, artifactOutputApproved: false,
      credentialFields: [], oauth: { clientId: "workspace-client", callbackPort: 49321 } }] }];
  return value;
}


test("failed sign-in keeps the saved account for retry without another connection write", async (t) => {
  const value = pluginState();
  value.integrationConnections = { revision: "1", connections: [{ id: "existing", name: "WORKSPACE", enabled: true,
    mcp: { type: "streamable-http", url: "https://other.test/mcp" }, configuredSecrets: [],
    artifactInputApproved: false, artifactOutputApproved: false }] };
  const h = await createDialogHarness(value);
  t.after(() => h.close());
  h.click(".plugin-add-connection");
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="connectionName"]')!.value, "workspace 2");
  h.holdNextCommandResponse();
  h.click(".plugin-connection-editor .editor-save");
  await h.settle();
  assert.equal(commandCalls(h).length, 1, "sign-in waits until the save is confirmed");
  h.failNextCommand("Sign-in was cancelled.");
  h.releaseHeldCommandResponse();
  await h.settle();
  assert.equal(commandCalls(h).length, 2);
  assert.match(h.document.querySelector(".plugin-connection-feedback")!.textContent!, /cancelled/u);
  assert.equal(h.document.querySelector<HTMLInputElement>('[name="connectionName"]')!.value, "workspace 2");
  h.click(".mcp-oauth-sign-in");
  await h.settle();
  assert.equal(commandCalls(h).filter((entry) => (entry.body as any).kind === "save_global_settings").length, 1);
  assert.equal(h.document.querySelector(".mcp-oauth-state")!.textContent, "Signed in");
  assert.deepEqual(h.errors, []);
});

for (const outcome of ["failed", "unknown"] as const) {
  test(`${outcome} connection save must not start OAuth`, async (t) => {
    const h = await createDialogHarness(pluginState());
    t.after(() => h.close());
    h.click(".plugin-add-connection");
    h.failNextCommand("Settings were not confirmed.", "integrationConnections", outcome === "unknown" ? { commandOutcome: outcome } : {});
    h.click(".plugin-connection-editor .editor-save");
    await h.settle();
    assert.equal(commandCalls(h).length, 1);
    assert.equal((commandCalls(h)[0]!.body as any).kind, "save_global_settings");
    assert.ok(h.document.querySelector('[name="connectionName"]'));
    assert.deepEqual(h.errors, []);
  });
}


test("the pending MCP sign-in can be cancelled in its own connection panel", async () => {
  const h = await createDialogHarness(state());
  let held = false;
  try {
    h.click('[data-connection-id="mcp-account"] .connection-choice');
    h.holdNextCommand(); held = true;
    h.click(".mcp-oauth-sign-in");
    await waitForCondition(() => commandCalls(h).length === 1, "Expected sign-in command");
    const cancel = () => [...h.document.querySelectorAll<HTMLButtonElement>(".plugin-connection-editor button")]
      .find((button) => button.textContent === "Cancel sign-in");
    assert.ok(cancel(), "The active login needs a local cancellation action");
    assert.equal(cancel()!.disabled, false);
    cancel()!.click(); await h.settle();
    assert.equal(h.commandStopIds.length, 1);
    assert.equal(commandCalls(h).length, 1, "Cancellation stops the active command instead of launching concurrent logout");
    assert.equal(cancel()!.disabled, true);
    h.releaseHeldCommand(); held = false; await h.settle();
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); h.close(); }
});


test("Chinese OAuth controls preserve account identity and refresh after sign-in", async () => {
  const value = pluginState(); value.settings.uiLanguage = 'zh-CN';
  const h = await createDialogHarness(value);
  try {
    h.click('.plugin-add-connection');
    h.input('[name="connectionName"]', 'Primary');
    assert.equal(h.document.querySelector('.plugin-connection-editor .editor-save')!.textContent, '连接并登录');
    assert.match(h.document.querySelector('.plugin-connection-editor')!.textContent!, /保存此账号/);
    h.click('.plugin-connection-editor .editor-save'); await h.settle();
    assert.equal(h.document.querySelector('.mcp-oauth-state')!.textContent, '已登录');
    assert.equal(h.document.querySelector<HTMLInputElement>('[name="connectionName"]')!.value, 'Primary');
    const save = (commandCalls(h)[0]!.body as any).integrationConnections.connection;
    assert.equal(save.name, 'Primary'); assert.equal(save.oauth.clientId, 'workspace-client');
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: 'start_mcp_oauth', connectionId: save.id });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
