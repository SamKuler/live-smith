import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

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

test("Plugin OAuth defaults need no server URL entry and saved authentication choices take precedence", async (t) => {
  const value = stateFixture();
  value.plugins = [{ id: "workspace", sha256: "a".repeat(64), sourceFormat: "claude", enabled: true,
    skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [{ id: "remote", type: "streamable-http",
      target: "https://example.test", approved: true, artifactInputApproved: false, artifactOutputApproved: false,
      credentialFields: [], oauth: { clientId: "workspace-client", callbackPort: 49321 } }] }];
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
  h.input('[name="connectionName"]', "My workspace");
  h.click(".plugin-connection-editor .editor-save");
  await h.settle();
  const saved = (commandCalls(h).at(-1)!.body as any).integrationConnections.connection;
  assert.deepEqual(saved.oauth, { clientId: "workspace-client", callbackPort: 49321 });
  assert.deepEqual(saved.configuration, { serverId: "remote", pluginDigest: "a".repeat(64) });
  h.click(".plugin-manage-connections");
  h.click(".mcp-oauth-sign-in");
  await h.settle();
  assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "start_mcp_oauth", connectionId: saved.id });
  assert.equal(h.document.querySelector(".mcp-oauth-state")!.textContent, "Signed in");
  h.select('[name="mcpAuthentication"]', "manual");
  h.click(".plugin-connection-editor .editor-save");
  await h.settle();
  h.click(".plugin-manage-connections");
  assert.equal(h.document.querySelector<HTMLSelectElement>('[name="mcpAuthentication"]')!.value, "manual");
  assert.deepEqual(h.errors, []);
});
