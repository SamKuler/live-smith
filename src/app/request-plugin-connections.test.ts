import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { createHostAbortController } from "../runtime/host.js";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved } from "../storage/plugins.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { closeActivePluginConnections, createRequestPluginTools } from "./request-plugin-tools.js";

const serverSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "account", description: "Read account identity", inputSchema: { type: "object", properties: {} }
  }] } });
  else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: {
    content: [{ type: "text", text: process.env.ACCOUNT_TOKEN === "first-secret" ? "first" : "second" }]
  } });
});`;

function pluginBytes(version = "1.0.0"): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "named-accounts", version,
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs"], env: { ACCOUNT_TOKEN: "${ACCOUNT_TOKEN}" } } },
    })),
    "server.mjs": strToU8(serverSource),
  });
}

test("one MCP server routes two named accounts privately and rejects a changed connection", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-accounts-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, pluginBytes());
  await setPluginMcpServerApproved(directory, plugin.id, "local", true);
  await setPluginEnabled(directory, plugin.id, true);
  let revision = "0";
  for (const [id, name, secret] of [["first", "First account", "first-secret"],
    ["second", "Second account", "second-secret"]]) {
    const settings = await saveGlobalSettings(directory, { integrationConnections: {
      action: "upsert", expectedRevision: revision,
      connection: { id: id!, name: name!, pluginId: plugin.id, enabled: true,
        configuration: { serverId: "local", pluginDigest: plugin.sha256 },
        secrets: { ACCOUNT_TOKEN: secret! } },
    } });
    revision = settings.integrationConnections!.revision;
  }
  const session = await createSession(directory, { title: "Accounts", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Accounts" } });
  const request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id,
    signal: createHostAbortController().signal,
    withAuthorization: async (_signal, operation) => operation() });
  t.after(() => request.close());
  const tools = request.tools();
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0]!.function.name, tools[1]!.function.name);
  assert.doesNotMatch(JSON.stringify(tools), /first-secret|second-secret/u);
  const invoke = (name: string) => request.callTool({ id: "call", name, arguments: "{}" });
  const first = await invoke(tools.find((tool) => tool.function.description.includes("First account"))!.function.name);
  const second = await invoke(tools.find((tool) => tool.function.description.includes("Second account"))!.function.name);
  assert.deepEqual(JSON.parse(first.content).content, [{ type: "text", text: "first" }]);
  assert.deepEqual(JSON.parse(second.content).content, [{ type: "text", text: "second" }]);
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: revision,
    connection: { id: "first", name: "First account", pluginId: plugin.id, enabled: true,
      configuration: { serverId: "local", pluginDigest: plugin.sha256 },
      secrets: { ACCOUNT_TOKEN: "rotated-secret" } },
  } });
  const changed = await invoke(tools.find((tool) => tool.function.description.includes("First account"))!.function.name);
  assert.equal(changed.failed, true);
  assert.equal(changed.stop, true);
  await closeActivePluginConnections(directory, plugin.id, "first");
  const unchanged = await invoke(tools.find((tool) => tool.function.description.includes("Second account"))!.function.name);
  assert.equal(unchanged.failed, undefined);
});

test("replacement between metadata listing and admission cannot send old secrets to the new package", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-accounts-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = await installPlugin(directory, pluginBytes());
  await setPluginMcpServerApproved(directory, original.id, "local", true);
  await setPluginEnabled(directory, original.id, true);
  await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0",
    connection: { id: "old-account", name: "Old account", pluginId: original.id, enabled: true,
      configuration: { serverId: "local", pluginDigest: original.sha256 },
      secrets: { ACCOUNT_TOKEN: "old-secret" } },
  } });
  const session = await createSession(directory, { title: "Replacement", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Replacement" } });
  const boundSecrets: string[] = [];
  let replaced = false;
  const request = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id,
    signal: createHostAbortController().signal,
    withAuthorization: async (_signal, operation) => {
      if (!replaced) {
        replaced = true;
        await setPluginEnabled(directory, original.id, false);
        await installPlugin(directory, pluginBytes("2.0.0"), { replace: true });
        await setPluginMcpServerApproved(directory, original.id, "local", true);
        await setPluginEnabled(directory, original.id, true);
      }
      return operation();
    },
    createPackage: (runtime, options) => {
      if (options?.connection) boundSecrets.push(...Object.values(options.connection.secrets));
      return { manifest: runtime.archive.manifest, async tools() { return { tools: [], issues: [] }; },
        async callTool() { return { content: [] }; }, async close() {} };
    },
  });
  t.after(() => request.close());
  assert.deepEqual(boundSecrets, []);
  assert.deepEqual(request.tools(), []);
});
