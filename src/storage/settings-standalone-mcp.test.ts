import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test, { type TestContext } from "node:test";

import { cloneAgentSettings, freshEmptyAgentSettings, ProfileValidationError } from "../model/profile.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import {
  integrationConnectionsView,
  isPluginIntegrationConnection,
  isStandaloneMcpConnection,
  normalizeIntegrationConnection,
  type IntegrationConnectionInput,
  type StandaloneMcpConnection,
} from "../plugins/integration-connections.js";
import type { StandaloneMcpConfig } from "../plugins/mcp/config.js";
import { decodeAgentSettings } from "./settings-migrations.js";
import {
  loadAgentSettings,
  normalizeIntegrationConnectionsSettingsPatch,
  saveGlobalSettings,
} from "./settings.js";

function localConnection(overrides: Partial<StandaloneMcpConnection> = {}): StandaloneMcpConnection {
  return {
    id: "local-mcp", name: "Local tools", enabled: true,
    mcp: { type: "stdio", command: "node", args: ["/opt/mcp/server.js"], cwd: "/opt/mcp" },
    secrets: { TOKEN: "fixture local token", WORKSPACE: "one\ntwo" },
    artifactInputApproved: false, artifactOutputApproved: false,
    ...overrides,
  };
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), "live-smith-standalone-settings-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    file: join(directory, "live-smith-settings.json"),
    save: (connection: IntegrationConnectionInput, expectedRevision: string) =>
      saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision, connection } }),
  };
}

test("standalone MCP persists named stdio and HTTP connections without an installed Plugin", async (t) => {
  const h = await fixture(t);
  const first = await h.save(localConnection(), "0");
  const remote = localConnection({
    id: "remote-mcp", name: "Remote tools",
    mcp: { type: "streamable-http", url: "https://mcp.example.test/api" },
    secrets: { Authorization: "Bearer fixture remote token", "X-Account": "fixture account" },
  });
  const saved = await h.save(remote, first.integrationConnections!.revision);
  assert.equal(saved.schemaVersion, 10);
  assert.equal(saved.integrationConnections!.revision, "2");
  assert.equal(saved.integrationConnections!.lastChangeTouchesAudio, false);
  assert.deepEqual(saved.integrationConnections!.connections, [localConnection(), remote]);
  assert.deepEqual((await loadAgentSettings(h.directory)).integrationConnections, saved.integrationConnections);
  assert.equal((await fs.readdir(h.directory)).includes("plugins"), false);
  if (platform !== "win32") assert.equal((await fs.stat(h.file)).mode & 0o777, 0o600);

  const view = integrationConnectionsView(saved.integrationConnections);
  assert.deepEqual(view.connections.map((entry) => entry.configuredSecrets), [["TOKEN", "WORKSPACE"], ["Authorization", "X-Account"]]);
  assert.doesNotMatch(JSON.stringify(view), /fixture local|fixture remote|fixture account|one\\ntwo|"secrets"|"env"|"headers"|"pluginId"/u);
  const publicLocal = view.connections[0]!;
  assert.ok(isStandaloneMcpConnection(publicLocal));
  assert.equal(isPluginIntegrationConnection(publicLocal), false);
  assert.equal(publicLocal.artifactInputApproved, false);
  publicLocal.mcp = { type: "stdio", command: "other", args: [] };
  assert.deepEqual(saved.integrationConnections!.connections[0]!.mcp, localConnection().mcp);
  const cloned = cloneAgentSettings(saved);
  assert.notStrictEqual(cloned.integrationConnections!.connections[0]!.mcp, saved.integrationConnections!.connections[0]!.mcp);
});

test("write-only standalone values merge, clear, and stay inside their named connection", async (t) => {
  const h = await fixture(t);
  await h.save(localConnection(), "0");
  const { secrets: _private, ...unchanged } = localConnection();
  const second = await h.save({ ...unchanged, id: "second", name: "Second account" }, "1");
  assert.deepEqual(second.integrationConnections!.connections[1]!.secrets, {});
  const edited = await h.save({
    ...unchanged, name: "Renamed", enabled: false, artifactOutputApproved: true,
    secrets: { TOKEN: "replacement token" },
  }, "2");
  assert.deepEqual(edited.integrationConnections!.connections[0]!.secrets,
    { TOKEN: "replacement token", WORKSPACE: "one\ntwo" });
  const cleared = await h.save({ ...unchanged, secrets: { TOKEN: "" } }, "3");
  assert.deepEqual(cleared.integrationConnections!.connections[0]!.secrets, { WORKSPACE: "one\ntwo" });
  assert.deepEqual(integrationConnectionsView(cleared.integrationConnections).connections[0]!.configuredSecrets, ["WORKSPACE"]);
  const retained = await h.save({ ...unchanged, artifactInputApproved: true }, "4");
  assert.deepEqual(retained.integrationConnections!.connections[0]!.secrets, { WORKSPACE: "one\ntwo" });
  assert.equal(retained.integrationConnections!.connections[0]!.enabled, true);
  assert.equal(retained.integrationConnections!.connections[0]!.artifactInputApproved, true);
  assert.equal(retained.integrationConnections!.connections[0]!.artifactOutputApproved, false);
  await assert.rejects(h.save(unchanged, "4"), /changed in another window/u);
  const removed = await saveGlobalSettings(h.directory, { integrationConnections: {
    action: "remove", expectedRevision: "5", connectionId: unchanged.id,
  } });
  assert.deepEqual(removed.integrationConnections!.connections.map(({ id }) => id), ["second"]);
  assert.equal(removed.integrationConnections!.revision, "6");
});

test("changing any standalone MCP target drops credentials that were not re-entered", async (t) => {
  const h = await fixture(t);
  const baseline = localConnection();
  const { secrets: _private, ...fields } = baseline;
  const targets: StandaloneMcpConfig[] = [
    { type: "stdio", command: "other-node", args: ["/opt/mcp/server.js"], cwd: "/opt/mcp" },
    { type: "stdio", command: "node", args: ["/opt/mcp/other.js"], cwd: "/opt/mcp" },
    { type: "stdio", command: "node", args: ["/opt/mcp/server.js"], cwd: "/opt/other" },
    { type: "streamable-http", url: "https://other.example.test/mcp" },
  ];
  let revision = "0";
  for (const mcp of targets) {
    const initial = await h.save(baseline, revision);
    const changed = await h.save({ ...fields, mcp }, initial.integrationConnections!.revision);
    assert.deepEqual(changed.integrationConnections!.connections[0]!.secrets, {});
    revision = changed.integrationConnections!.revision;
  }
  const remote = { ...fields, mcp: { type: "streamable-http" as const, url: "https://one.example.test/mcp" } };
  const one = await h.save({ ...remote, secrets: { Authorization: "Bearer first account" } }, revision);
  const two = await h.save({
    ...remote, mcp: { type: "streamable-http", url: "https://two.example.test/mcp" },
    secrets: { "X-Account": "second account" },
  }, one.integrationConnections!.revision);
  assert.deepEqual(two.integrationConnections!.connections[0]!.secrets, { "X-Account": "second account" });
});

test("Plugin and standalone MCP source changes never transfer their credential owner", async (t) => {
  const h = await fixture(t);
  const plugin = { id: "shared", name: "Tools", pluginId: builtInAudioPluginId("lalal"),
    enabled: true, configuration: {}, secrets: { apiKey: "fixture-plugin-key" } };
  await h.save(plugin, "0");
  const { secrets: _private, ...standalone } = localConnection({ id: plugin.id, name: plugin.name });
  const converted = await h.save(standalone, "1");
  assert.deepEqual(converted.integrationConnections!.connections[0]!.secrets, {});
  assert.equal(converted.integrationConnections!.lastChangeTouchesAudio, true);
  await h.save({ ...standalone, secrets: { apiKey: "fixture env key" } }, "2");
  const { secrets: _pluginSecret, ...pluginFields } = plugin;
  await assert.rejects(h.save(pluginFields, "3"), /API key/u);
  const restored = await h.save({ ...pluginFields, enabled: false }, "3");
  assert.deepEqual(restored.integrationConnections!.connections[0]!.secrets, {});
});

test("standalone configuration rejects public credentials, unsafe targets, and invalid private fields", () => {
  const remote = localConnection({ mcp: { type: "streamable-http", url: "https://example.test/mcp" }, secrets: {} });
  for (const value of [
    { ...localConnection(), pluginId: "invented-plugin" },
    { ...localConnection(), mcp: { type: "stdio", command: "node", args: [], shell: true } },
    { ...localConnection(), mcp: { type: "stdio", command: "node", args: [], env: { TOKEN: "private" } } },
    { ...localConnection(), mcp: { type: "stdio", command: "node", args: Array.from({ length: 129 }, () => "arg") } },
    { ...localConnection(), mcp: { type: "stdio", command: "node", args: ["a".repeat(8193)] } },
    { ...localConnection(), secrets: { "INVALID-NAME": "private" } },
    { ...localConnection(), secrets: { TOKEN: "private\0value" } },
    { ...localConnection(), secrets: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`VAR_${index}`, "value"])) },
    { ...remote, mcp: { ...remote.mcp, headers: { Authorization: "private" } } },
    { ...remote, artifactInputApproved: true },
    { ...remote, artifactOutputApproved: true },
    { ...remote, secrets: { Authorization: "one", authorization: "two" } },
    { ...remote, secrets: { Authorization: "one\r\nX-Other: two" } },
    { ...remote, secrets: { "Bad Header": "private" } },
    { ...remote, secrets: { Authorization: "non-header-\u0100" } },
  ]) assert.throws(() => normalizeIntegrationConnection(value), ProfileValidationError);

  for (const url of ["http://example.test/mcp", "https://user:pass@example.test/mcp", "https://@example.test/mcp",
    "https://example.test/mcp#", "https://example.test/mcp#fragment", "https://example.test/\nmcp"])
    assert.throws(() => normalizeIntegrationConnection({ ...remote, mcp: { type: "streamable-http", url } }), ProfileValidationError);
  for (const url of ["https://example.test/mcp", "http://localhost:3000/mcp", "http://127.3.2.1:3000/mcp", "http://[::1]:3000/mcp"])
    assert.deepEqual(normalizeIntegrationConnection({ ...remote, mcp: { type: "streamable-http", url } }).mcp,
      { type: "streamable-http", url });
  const { secrets: _private, ...input } = localConnection();
  const patch = normalizeIntegrationConnectionsSettingsPatch({ action: "upsert", expectedRevision: "0", connection: input });
  assert.equal(patch.action, "upsert");
  if (patch.action !== "upsert") throw new Error("Expected upsert.");
  assert.equal(Object.hasOwn(patch.connection, "secrets"), false);
  assert.deepEqual(patch.connection, input);
});

test("schema v9 Plugin records migrate on read without rewriting or widening their shape", async (t) => {
  const h = await fixture(t);
  const connections = [
    { id: "audio", name: "Audio", pluginId: builtInAudioPluginId("lalal"), enabled: true,
      configuration: {}, secrets: { apiKey: "fixture-old-audio" } },
    { id: "package", name: "Package", pluginId: "existing-plugin", enabled: false,
      configuration: { serverId: "account", pluginDigest: "a".repeat(64) }, secrets: { TOKEN: "fixture-old-mcp" } },
  ];
  const source = { ...freshEmptyAgentSettings(), schemaVersion: 9,
    integrationConnections: { connections, revision: "9007199254740999", lastChangeTouchesAudio: true } };
  const original = JSON.stringify(source, null, 2);
  await fs.writeFile(h.file, original, { mode: 0o600 });
  const loaded = await loadAgentSettings(h.directory);
  assert.equal(loaded.schemaVersion, 10);
  assert.deepEqual(loaded.integrationConnections, source.integrationConnections);
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  await saveGlobalSettings(h.directory, { showContextUsage: false });
  const persisted = JSON.parse(await fs.readFile(h.file, "utf8"));
  assert.equal(persisted.schemaVersion, 10);
  assert.deepEqual(persisted.integrationConnections, source.integrationConnections);
  assert.throws(() => decodeAgentSettings({ ...source,
    integrationConnections: { connections: [localConnection()], revision: "0" } }), /Schema version 9/u);
});
