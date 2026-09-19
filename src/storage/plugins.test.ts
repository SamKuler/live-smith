import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  deletePlugin,
  installPlugin,
  listInstalledPlugins,
  preparePluginRuntime,
  readInstalledPluginArchive,
  readEnabledPluginPackagesInTransaction,
  setPluginEnabled,
  setPluginArtifactPermissionApproved,
  setPluginMcpServerApproved,
} from "./plugins.js";
import { withStorageTransaction } from "./persistence.js";

function packageBytes(version: string, description = "Fixture plugin"): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-plugin",
      version,
      description,
    })),
    "mcp.json": strToU8('{"mcpServers":{}}'),
  });
}

test("Plugin catalog installs immutable bytes disabled and returns defensive copies", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = packageBytes("1.0.0");
  const installed = await installPlugin(directory, source);
  assert.equal(installed.id, "fixture-plugin");
  assert.equal(installed.enabled, false);
  assert.equal(installed.version, "1.0.0");
  assert.deepEqual(installed.approvedMcpServerIds, []);
  assert.deepEqual(installed.approvedArtifactInputServerIds, []);
  assert.deepEqual(installed.approvedArtifactOutputServerIds, []);
  source.fill(0);
  const stored = await readInstalledPluginArchive(directory, installed.id);
  assert.notEqual(stored[0], 0);
  stored.fill(0);
  assert.notEqual((await readInstalledPluginArchive(directory, installed.id))[0], 0);
  assert.deepEqual((await listInstalledPlugins(directory)).map(({ id, enabled }) => ({ id, enabled })), [
    { id: "fixture-plugin", enabled: false },
  ]);
});

test("runtime files materialize from the verified archive and keep Plugin data separate", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  const first = await preparePluginRuntime(directory, "fixture-plugin");
  assert.match(first.pluginRoot, /live-smith-plugins\/runtime\/fixture-plugin\/[a-f0-9]{64}$/u);
  assert.match(first.pluginData, /live-smith-plugins\/data\/fixture-plugin$/u);
  assert.equal(JSON.parse(await fs.readFile(`${first.pluginRoot}/plugin.json`, "utf8")).name, "fixture-plugin");
  await fs.chmod(`${first.pluginRoot}/plugin.json`, 0o600);
  await fs.writeFile(`${first.pluginRoot}/plugin.json`, "tampered", "utf8");
  const repaired = await preparePluginRuntime(directory, "fixture-plugin");
  assert.equal(JSON.parse(await fs.readFile(`${repaired.pluginRoot}/plugin.json`, "utf8")).name, "fixture-plugin");
  await fs.writeFile(`${first.pluginData}/state.json`, "persistent", "utf8");
  await installPlugin(directory, packageBytes("2.0.0"), { replace: true });
  assert.equal(await fs.readFile(`${first.pluginData}/state.json`, "utf8"), "persistent");
});

test("MCP server execution requires an approval bound to the installed package", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-plugin",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node" } },
    })),
  });
  await installPlugin(directory, archive);
  assert.deepEqual((await setPluginMcpServerApproved(directory, "fixture-plugin", "local", true)).approvedMcpServerIds, ["local"]);
  await setPluginArtifactPermissionApproved(directory, "fixture-plugin", "local", "input", true);
  const granted = await setPluginArtifactPermissionApproved(directory, "fixture-plugin", "local", "output", true);
  assert.deepEqual(granted.approvedArtifactInputServerIds, ["local"]);
  assert.deepEqual(granted.approvedArtifactOutputServerIds, ["local"]);
  const revoked = await setPluginMcpServerApproved(directory, "fixture-plugin", "local", false);
  assert.deepEqual(revoked.approvedMcpServerIds, []);
  assert.deepEqual(revoked.approvedArtifactInputServerIds, []);
  assert.deepEqual(revoked.approvedArtifactOutputServerIds, []);
  await assert.rejects(setPluginArtifactPermissionApproved(
    directory, "fixture-plugin", "local", "input", true,
  ), /Approve this MCP server/u);
  await assert.rejects(setPluginMcpServerApproved(directory, "fixture-plugin", "missing", true), /does not expose/u);
});

test("Plugin replacement is explicit and enablement remains an independent user decision", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  await assert.rejects(installPlugin(directory, packageBytes("2.0.0")), /already installed/u);
  await setPluginEnabled(directory, "fixture-plugin", true);
  const replaced = await installPlugin(directory, packageBytes("2.0.0"), { replace: true });
  assert.equal(replaced.version, "2.0.0");
  assert.equal(replaced.enabled, false);
  assert.deepEqual(replaced.approvedMcpServerIds, []);
  assert.deepEqual(replaced.approvedArtifactInputServerIds, []);
  assert.deepEqual(replaced.approvedArtifactOutputServerIds, []);
  assert.equal((await listInstalledPlugins(directory))[0]!.version, "2.0.0");
});

test("historical Plugin catalogs default missing artifact grants without rewriting", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const target = `${directory}/live-smith-plugins/catalog.json`;
  const catalog = JSON.parse(await fs.readFile(target, "utf8"));
  delete catalog.plugins[0].approvedArtifactInputServerIds;
  delete catalog.plugins[0].approvedArtifactOutputServerIds;
  await fs.writeFile(target, JSON.stringify(catalog, null, 2));
  const before = await fs.readFile(target, "utf8");
  const [loaded] = await listInstalledPlugins(directory);
  assert.deepEqual(loaded?.approvedArtifactInputServerIds, []);
  assert.deepEqual(loaded?.approvedArtifactOutputServerIds, []);
  assert.equal(await fs.readFile(target, "utf8"), before);
});

test("Plugin catalog serializes concurrent installs and deletes only the selected package", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const second = zipSync({ "plugin.json": strToU8(JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "second-plugin", version: "1.0.0", description: "Second",
  })) });
  await Promise.all([installPlugin(directory, packageBytes("1.0.0")), installPlugin(directory, second)]);
  assert.deepEqual((await listInstalledPlugins(directory)).map((entry) => entry.id), ["fixture-plugin", "second-plugin"]);
  await deletePlugin(directory, "fixture-plugin");
  assert.deepEqual((await listInstalledPlugins(directory)).map((entry) => entry.id), ["second-plugin"]);
  await assert.rejects(readInstalledPluginArchive(directory, "fixture-plugin"), /not installed/u);
});

test("invalid packages never create a Plugin catalog", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(installPlugin(directory, strToU8("not zip")));
  await assert.rejects(fs.lstat(`${directory}/live-smith-plugins`), { code: "ENOENT" });
});

test("corrupt catalog fails closed without rewriting its bytes", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const target = `${directory}/live-smith-plugins/catalog.json`;
  await fs.writeFile(target, "{broken", "utf8");
  const before = await fs.readFile(target);
  await assert.rejects(listInstalledPlugins(directory), /storage is invalid/u);
  assert.deepEqual(await fs.readFile(target), before);
});

test("Plugin installation never follows a catalog or package-directory symlink", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  const outside = await fs.mkdtemp("/private/tmp/live-smith-plugin-outside-");
  t.after(() => Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.symlink(outside, `${directory}/live-smith-plugins`);
  await assert.rejects(installPlugin(directory, packageBytes("1.0.0")), /storage is invalid/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("enabled Plugin packages are read under the caller's storage transaction", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  const packages = await withStorageTransaction(directory, (transaction) =>
    readEnabledPluginPackagesInTransaction(transaction, directory));
  assert.equal(packages.length, 1);
  assert.equal(packages[0]!.plugin.id, "fixture-plugin");
  assert.deepEqual(packages[0]!.bytes, await readInstalledPluginArchive(directory, "fixture-plugin"));
});
