import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { integrationConnectionsView } from "../plugins/integration-connections.js";
import { bindMcpServerCredentials } from "../plugins/mcp/credentials.js";
import { installPlugin } from "./plugins.js";
import { loadAgentSettings, saveGlobalSettings } from "./settings.js";

function pluginBytes(header = "Bearer ${TOKEN}"): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "accounts-plugin",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { account: { type: "streamable-http", url: "https://example.test/mcp",
        headers: { Authorization: header } } },
    })),
  });
}

test("one MCP server saves two independent named credentials and redacts both from its view", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-settings-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, pluginBytes());
  const upsert = (id: string, name: string, revision: string, secrets?: Record<string, string>) =>
    saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: revision,
      connection: { id, name, pluginId: plugin.id, enabled: true,
        configuration: { serverId: "account", pluginDigest: plugin.sha256 },
        ...(secrets ? { secrets } : {}),
      } } });
  await assert.rejects(upsert("first", "First", "0"), /credentials/u);
  const first = await upsert("first", "First", "0", { TOKEN: "first-secret" });
  const second = await upsert("second", "Second", first.integrationConnections!.revision, { TOKEN: "second-secret" });
  assert.equal(second.integrationConnections?.lastChangeTouchesAudio, false);
  assert.deepEqual(second.integrationConnections?.connections.map(({ id, secrets }) => [id, secrets.TOKEN]), [
    ["first", "first-secret"], ["second", "second-secret"],
  ]);
  assert.doesNotMatch(JSON.stringify(integrationConnectionsView(second.integrationConnections)), /first-secret|second-secret/u);
  assert.deepEqual(integrationConnectionsView(second.integrationConnections).connections.map((entry) => entry.configuredSecrets),
    [["TOKEN"], ["TOKEN"]]);
  await assert.rejects(upsert("first", "Changed", first.integrationConnections!.revision), /changed in another window/u);
  const updated = await upsert("first", "Renamed", second.integrationConnections!.revision);
  assert.equal(updated.integrationConnections?.connections[0]?.secrets.TOKEN, "first-secret");
  assert.equal((await loadAgentSettings(directory)).integrationConnections?.connections[1]?.secrets.TOKEN, "second-secret");
});

test("replacing an MCP package does not transfer saved credentials to its new version", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-settings-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = await installPlugin(directory, pluginBytes());
  const initial = await saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: "0", connection: {
      id: "account-one", name: "Account", pluginId: old.id, enabled: true,
      configuration: { serverId: "account", pluginDigest: old.sha256 },
      secrets: { TOKEN: "old-secret" },
    },
  } });
  const replacement = await installPlugin(directory, pluginBytes("Token ${TOKEN}"), { replace: true });
  const revision = initial.integrationConnections!.revision;
  const candidate = { id: "account-one", name: "Account", pluginId: old.id, enabled: true,
    configuration: { serverId: "account", pluginDigest: replacement.sha256 } };
  await assert.rejects(saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: revision, connection: candidate,
  } }), /credentials/u);
  assert.equal((await loadAgentSettings(directory)).integrationConnections?.connections[0]?.secrets.TOKEN, "old-secret");
  const rebound = await saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: revision,
    connection: { ...candidate, secrets: { TOKEN: "new-secret" } },
  } });
  assert.equal(rebound.integrationConnections?.connections[0]?.secrets.TOKEN, "new-secret");
});

test("prototype-like placeholder names require own saved credentials", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-settings-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, pluginBytes("Bearer ${constructor}"));
  const connection = { id: "prototype-account", name: "Prototype account", pluginId: plugin.id,
    enabled: true, configuration: { serverId: "account", pluginDigest: plugin.sha256 } };
  await assert.rejects(saveGlobalSettings(directory, { integrationConnections: {
    action: "upsert", expectedRevision: "0", connection,
  } }), /credentials/u);
  const server = { id: "account", type: "streamable-http" as const, url: "https://example.test/mcp",
    headers: { Authorization: "Bearer ${__proto__}" } };
  assert.throws(() => bindMcpServerCredentials(server, {}), /not configured/u);
  const secrets = Object.fromEntries([["__proto__", "owned-secret"]]);
  const bound = bindMcpServerCredentials(server, secrets);
  assert.equal(bound.type, "streamable-http");
  if (bound.type !== "streamable-http") throw new Error("Expected remote MCP server.");
  assert.equal(bound.headers.Authorization, "Bearer owned-secret");
});
