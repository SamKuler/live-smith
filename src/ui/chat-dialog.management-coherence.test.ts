import assert from "node:assert/strict";
import test from "node:test";

import { commandCalls, createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";

test("MCP uses one named editor and one empty state before a Plugin source exists", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#mcpExtensionTab");
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginMcpSection")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#connectionsEmpty")?.hidden, false);
    harness.click("#addConnectionButton");
    const editor = harness.document.querySelector(".plugin-connection-editor");
    assert.equal(editor?.getAttribute("aria-label"), "Connection settings");
    assert.equal(editor?.querySelector(":scope > h4"), null);
    assert.equal(harness.document.querySelector<HTMLElement>("#connectionsEmpty")?.hidden, true);
    assert.equal((harness.document.activeElement as HTMLInputElement).name, "connectionName");
    harness.click(".plugin-connection-editor .editor-discard");
    assert.equal(harness.document.querySelector(".plugin-connection-editor"), null);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("each Plugin server account opens its own saved connection in the shared MCP editor", async () => {
  const state = stateFixture();
  state.plugins = [{ id: "accounts", sha256: "a".repeat(64), sourceFormat: "agent-plugins-1.0",
    enabled: true, skillCount: 0, unsupportedComponents: [], issues: [], mcpServers: [
      { id: "remote", type: "streamable-http", target: "https://example.test", approved: true,
        artifactInputApproved: false, artifactOutputApproved: false,
        credentialFields: [{ name: "TOKEN", required: true }] },
    ] }];
  state.integrationConnections = { revision: "1", connections: ["First", "Second"].map((name) => ({
    id: name.toLowerCase(), name, pluginId: "accounts", enabled: true,
    configuration: { serverId: "remote", pluginDigest: "a".repeat(64) }, configuredSecrets: ["TOKEN"],
  })) };
  const harness = await createDialogHarness(state);
  try {
    harness.click("#pluginsExtensionTab");
    harness.click(".plugin-open-mcp");
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginMcpSection")?.hidden, false);
    const selector = "#pluginMcpServers .plugin-manage-connections";
    assert.deepEqual([...harness.document.querySelectorAll(selector)].map((link) => link.textContent), ["First", "Second"]);
    harness.click(`${selector}[data-connection-id="second"]`);
    assert.equal(harness.document.querySelector<HTMLInputElement>('.plugin-connection-editor [name="connectionName"]')?.value, "Second");
    assert.match(harness.document.querySelector(".connection-editor-source")?.textContent ?? "", /accounts.*remote/u);
    assert.equal(harness.document.querySelectorAll(".plugin-connection-editor").length, 1);
    assert.equal(harness.document.querySelector("#pluginManager .plugin-connection-editor"), null);
    harness.input('.plugin-connection-editor [name="TOKEN"]', "transient-secret");
    harness.click(`${selector}[data-connection-id="first"]`);
    assert.equal(harness.document.querySelector<HTMLInputElement>('.plugin-connection-editor [name="connectionName"]')?.value, "First");
    assert.equal(harness.document.querySelector<HTMLInputElement>('.plugin-connection-editor [name="TOKEN"]')?.value, "");
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
