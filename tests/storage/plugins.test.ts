import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { platform } from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  deletePlugin,
  installPlugin,
  listInstalledPlugins,
  preparePluginRuntime,
  pluginRuntimePaths,
  readInstalledPluginArchive,
  readPluginConfig,
  readEnabledPluginPackagesInTransaction,
  setPluginEnabled,
  setPluginArtifactPermissionApproved,
  setPluginMcpServerApproved,
} from "../../src/storage/plugins.js";
import { STORAGE_DATABASE_NAME, readStoredBytes, readStoredText, removeStoredEntry, writeStoredBytes, writeStoredJson } from "../../src/storage/sqlite.js";
import { withStorageTransaction } from "../../src/storage/persistence.js";

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

async function installedArchivePath(directory: string): Promise<string> {
  const [plugin] = await listInstalledPlugins(directory);
  assert.ok(plugin);
  return path.join(directory, "live-smith-plugins", "packages", plugin.id, `${plugin.sha256}.zip`);
}

test("runtime and Plugin data directories tighten permissive modes before use", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  const runtime = await preparePluginRuntime(directory, "fixture-plugin");
  for (const target of [runtime.pluginRoot, runtime.pluginData]) await fs.chmod(target, 0o755);
  await preparePluginRuntime(directory, "fixture-plugin");
  for (const target of [runtime.pluginRoot, runtime.pluginData]) assert.equal((await fs.stat(target)).mode & 0o7777, 0o700);
});

test("private Plugin directories are reusable without resetting their permissions", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  const runtime = await preparePluginRuntime(directory, "fixture-plugin");
  const before = await fs.stat(runtime.pluginData);
  await preparePluginRuntime(directory, "fixture-plugin");
  assert.equal((await fs.stat(runtime.pluginData)).ctimeMs, before.ctimeMs);
});

test("Plugin archive reads validate the referenced digest and reject missing records", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const archive = await installedArchivePath(directory);
  const bytes = await readStoredBytes(directory, archive);
  bytes[0] = bytes[0]! ^ 1;
  await writeStoredBytes(directory, archive, bytes);
  await assert.rejects(readInstalledPluginArchive(directory, "fixture-plugin"), /storage is invalid/u);
  await removeStoredEntry(directory, archive);
  await assert.rejects(readInstalledPluginArchive(directory, "fixture-plugin"), { code: "ENOENT" });
});

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
  assert.match(first.pluginRoot, /live-smith-plugins\/runtime-cache\/fixture-plugin\/[a-f0-9]{64}$/u);
  assert.match(first.pluginData, /live-smith-plugins\/data\/fixture-plugin\/[a-f0-9-]{36}$/u);
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
  const catalog = JSON.parse(await readStoredText(directory, target));
  catalog.schemaVersion = 1;
  delete catalog.pendingCleanup;
  delete catalog.plugins[0].dataGeneration;
  delete catalog.plugins[0].approvedArtifactInputServerIds;
  delete catalog.plugins[0].approvedArtifactOutputServerIds;
  await writeStoredJson(directory, target, catalog);
  const before = await readStoredText(directory, target);
  const [loaded] = await listInstalledPlugins(directory);
  assert.deepEqual(loaded?.approvedArtifactInputServerIds, []);
  assert.deepEqual(loaded?.approvedArtifactOutputServerIds, []);
  assert.equal(await readStoredText(directory, target), before);
  await setPluginEnabled(directory, "fixture-plugin", true);
  const upgraded = JSON.parse(await readStoredText(directory, target));
  assert.equal(upgraded.schemaVersion, 3);
  assert.equal(upgraded.plugins[0].dataGeneration, null);
  assert.deepEqual(upgraded.pendingCleanup, []);
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

test("a committed Plugin deletion retains and retries private-data cleanup", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  let data = path.join(directory, "live-smith-plugins", "data", "fixture-plugin");
  t.after(async () => {
    await fs.chmod(data, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  data = (await preparePluginRuntime(directory, "fixture-plugin")).pluginData;
  await setPluginEnabled(directory, "fixture-plugin", false);
  await fs.writeFile(path.join(data, "state.json"), "private", { mode: 0o600 });
  await fs.chmod(data, 0o500);

  assert.equal(await deletePlugin(directory, "fixture-plugin"), false);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  assert.deepEqual(JSON.parse(await readStoredText(directory, path.join(directory, "live-smith-plugins", "catalog.json")))
    .pendingCleanup, [{ kind: "delete", pluginId: "fixture-plugin", dataGeneration: path.basename(data) }]);
  await assert.rejects(installPlugin(directory, packageBytes("2.0.0")), /awaiting cleanup/u);
  await fs.chmod(data, 0o700);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  await assert.rejects(fs.lstat(data), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readStoredText(directory, path.join(directory, "live-smith-plugins", "catalog.json")))
    .pendingCleanup, []);
});

test("pending Plugin cleanup never follows a replaced private-data ancestor", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  const dataRoot = path.join(directory, "live-smith-plugins", "data");
  let data = path.join(dataRoot, "fixture-plugin");
  const held = `${dataRoot}.held`;
  const outside = path.join(directory, "outside");
  t.after(async () => {
    await fs.chmod(data, 0o700).catch(() => undefined);
    await fs.chmod(path.join(held, path.relative(dataRoot, data)), 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  data = (await preparePluginRuntime(directory, "fixture-plugin")).pluginData;
  await setPluginEnabled(directory, "fixture-plugin", false);
  await fs.writeFile(path.join(data, "state.json"), "private");
  await fs.chmod(data, 0o500);
  assert.equal(await deletePlugin(directory, "fixture-plugin"), false);
  await fs.chmod(data, 0o700);
  await fs.rename(dataRoot, held);
  await fs.mkdir(path.join(outside, "fixture-plugin"), { recursive: true });
  const marker = path.join(outside, "fixture-plugin", "keep.txt");
  await fs.writeFile(marker, "untouched");
  await fs.symlink(outside, dataRoot);

  assert.deepEqual(await listInstalledPlugins(directory), []);
  assert.equal(await fs.readFile(marker, "utf8"), "untouched");
  assert.equal(JSON.parse(await readStoredText(directory, path.join(directory, "live-smith-plugins", "catalog.json")))
    .pendingCleanup.length, 1);
  await fs.unlink(dataRoot);
  await fs.rename(held, dataRoot);
  await listInstalledPlugins(directory);
  await assert.rejects(fs.lstat(data), { code: "ENOENT" });
});

test("a committed Plugin replacement succeeds while old runtime cleanup is pending", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  let oldRuntime: string | undefined;
  t.after(async () => {
    if (oldRuntime) await fs.chmod(oldRuntime, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const old = await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  oldRuntime = (await preparePluginRuntime(directory, "fixture-plugin")).pluginRoot;
  await setPluginEnabled(directory, "fixture-plugin", false);
  await fs.chmod(oldRuntime, 0o500);

  const replacement = await installPlugin(directory, packageBytes("2.0.0"), { replace: true });
  assert.equal(replacement.version, "2.0.0");
  assert.equal((await listInstalledPlugins(directory))[0]?.sha256, replacement.sha256);
  assert.deepEqual(JSON.parse(await readStoredText(directory, path.join(directory, "live-smith-plugins", "catalog.json")))
    .pendingCleanup, [{ kind: "replace", pluginId: "fixture-plugin", sha256: old.sha256 }]);
  await setPluginEnabled(directory, "fixture-plugin", true);
  assert.equal(JSON.parse(await readStoredText(directory, path.join(directory, "live-smith-plugins", "catalog.json")))
    .pendingCleanup.length, 1);
  await fs.chmod(oldRuntime, 0o700);
  await listInstalledPlugins(directory);
  await assert.rejects(fs.lstat(oldRuntime), { code: "ENOENT" });
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
  await writeStoredBytes(directory, target, strToU8("{broken"));
  const before = await readStoredBytes(directory, target);
  await assert.rejects(listInstalledPlugins(directory), /storage is invalid/u);
  assert.deepEqual(await readStoredBytes(directory, target), before);
});

test("Plugin cleanup intent rejects paths outside its owned Plugin ID", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const target = path.join(directory, "live-smith-plugins", "catalog.json");
  const catalog = JSON.parse(await readStoredText(directory, target));
  catalog.pendingCleanup = [{ kind: "delete", pluginId: "../outside" }];
  await writeStoredJson(directory, target, catalog);
  const before = await readStoredBytes(directory, target);
  await assert.rejects(listInstalledPlugins(directory), /storage is invalid/u);
  assert.deepEqual(await readStoredBytes(directory, target), before);
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


test("legacy Plugin replacement and deletion preserve original package bytes and catalog", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const bytes = packageBytes("1.0.0");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const plugin = {id: "fixture-plugin", version: "1.0.0", description: "Fixture plugin",
    sourceFormat: "agent-plugins-1.0", components: {mcpConfigPath: "mcp.json"}, sha256,
    byteLength: bytes.byteLength, enabled: false, approvedMcpServerIds: [],
    approvedArtifactInputServerIds: [], approvedArtifactOutputServerIds: [],
    installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"};
  const archive = path.join(directory, "live-smith-plugins", "packages", plugin.id, `${sha256}.zip`);
  const catalog = path.join(directory, "live-smith-plugins", "catalog.json");
  const original = JSON.stringify({schemaVersion: 2, revision: "1", plugins: [plugin], pendingCleanup: []});
  const configPath = path.join(path.dirname(archive), "user-config.json");
  const config = { revision: "1", values: { fixture: "legacy value" }, secrets: {} };
  const legacyRuntime = path.join(directory, "live-smith-plugins", "runtime", plugin.id, sha256, "legacy.txt");
  const legacyData = path.join(directory, "live-smith-plugins", "data", plugin.id);
  await fs.mkdir(path.dirname(archive), {recursive: true, mode: 0o700});
  await fs.writeFile(archive, bytes, {mode: 0o600});
  await fs.writeFile(catalog, original, {mode: 0o600});
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await fs.mkdir(path.dirname(legacyRuntime), { recursive: true, mode: 0o700 });
  await fs.writeFile(legacyRuntime, "legacy runtime");
  await fs.mkdir(legacyData, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(legacyData, "state.json"), "legacy private data");
  assert.deepEqual(await readPluginConfig(directory, plugin.id), config);
  assert.equal((await listInstalledPlugins(directory))[0]?.version, "1.0.0");
  await setPluginEnabled(directory, plugin.id, true);
  const migratedRuntime = await preparePluginRuntime(directory, plugin.id);
  assert.equal(migratedRuntime.pluginData, legacyData);
  assert.equal(await fs.readFile(path.join(migratedRuntime.pluginData, "state.json"), "utf8"), "legacy private data");
  await installPlugin(directory, packageBytes("2.0.0"), {replace: true});
  await setPluginEnabled(directory, plugin.id, true);
  assert.equal((await preparePluginRuntime(directory, plugin.id)).pluginData, legacyData);
  assert.equal(await deletePlugin(directory, plugin.id), true);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  assert.equal(await fs.readFile(catalog, "utf8"), original);
  assert.deepEqual(new Uint8Array(await fs.readFile(archive)), bytes);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), config);
  assert.equal(await fs.readFile(legacyRuntime, "utf8"), "legacy runtime");
  await fs.mkdir(legacyData, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(legacyData, "state.json"), "legacy data after cleanup");
  const reinstalled = await installPlugin(directory, bytes);
  await setPluginEnabled(directory, reinstalled.id, true);
  const freshRuntime = await preparePluginRuntime(directory, reinstalled.id);
  assert.notEqual(freshRuntime.pluginData, legacyData);
  await assert.rejects(fs.readFile(path.join(freshRuntime.pluginData, "state.json")), { code: "ENOENT" });
  const database = new DatabaseSync(path.join(directory, STORAGE_DATABASE_NAME), { readOnly: true });
  try {
    const snapshot = database.prepare("SELECT preserved, sha256 FROM entries WHERE path=?")
      .get("live-smith-plugins/data/fixture-plugin/state.json");
    assert.equal(snapshot?.preserved, 1);
    assert.equal(snapshot?.sha256, createHash("sha256").update("legacy private data").digest("hex"));
  } finally { database.close(); }
});


test("relative Plugin storage roots share catalog and packages with their absolute path", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-relative-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const relative = path.relative(process.cwd(), directory);
  const plugin = await installPlugin(relative, packageBytes("1.0.0"));
  assert.deepEqual(await listInstalledPlugins(directory), [plugin]);
  assert.deepEqual(await readInstalledPluginArchive(relative, plugin.id), await readInstalledPluginArchive(directory, plugin.id));
  await setPluginEnabled(relative, plugin.id, true);
  const runtime = await preparePluginRuntime(relative, plugin.id);
  assert.equal(await fs.readFile(path.join(runtime.pluginRoot, "mcp.json"), "utf8"), '{"mcpServers":{}}');
  assert.equal(await deletePlugin(relative, plugin.id), true);
  assert.deepEqual(await listInstalledPlugins(directory), []);
});

test("same-ID reinstall isolates private data that reappears after completed deletion", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugin-generations-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = packageBytes("1.0.0");
  const first = await installPlugin(directory, bytes);
  await setPluginEnabled(directory, first.id, true);
  const oldRuntime = await preparePluginRuntime(directory, first.id);
  await fs.writeFile(path.join(oldRuntime.pluginData, "state.json"), "old private data");
  assert.equal(await deletePlugin(directory, first.id), true);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  await fs.mkdir(oldRuntime.pluginData, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(oldRuntime.pluginData, "state.json"), "old private data");

  const reinstalled = await installPlugin(directory, bytes);
  await setPluginEnabled(directory, first.id, true);
  const currentRuntime = await preparePluginRuntime(directory, first.id);
  assert.notEqual(currentRuntime.pluginData, oldRuntime.pluginData);
  await assert.rejects(fs.readFile(path.join(currentRuntime.pluginData, "state.json")), { code: "ENOENT" });
  await fs.writeFile(path.join(currentRuntime.pluginData, "state.json"), "current private data");
  const replaced = await installPlugin(directory, packageBytes("2.0.0"), { replace: true });
  await setPluginEnabled(directory, first.id, true);
  const replacementRuntime = await preparePluginRuntime(directory, first.id);
  assert.equal(replacementRuntime.pluginData, currentRuntime.pluginData);
  assert.equal(await fs.readFile(path.join(replacementRuntime.pluginData, "state.json"), "utf8"), "current private data");
  for (const plugin of [first, reinstalled, replaced, ...(await listInstalledPlugins(directory))]) {
    assert.equal(Object.hasOwn(plugin, "dataGeneration"), false);
  }
  assert.equal(await deletePlugin(directory, first.id), true);
  await assert.rejects(fs.lstat(replacementRuntime.pluginData), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(oldRuntime.pluginData, "state.json"), "utf8"), "old private data");
});


test("Plugin runtime path lookup rejects a replaced package and keeps materialization lazy", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugin-paths-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await installPlugin(directory, packageBytes("1.0.0"));
  const paths = await pluginRuntimePaths(directory, first);
  await assert.rejects(fs.lstat(paths.pluginData), { code: "ENOENT" });
  const replaced = await installPlugin(directory, packageBytes("2.0.0"), { replace: true });
  await assert.rejects(pluginRuntimePaths(directory, first), /package has changed/);
  const currentPaths = await pluginRuntimePaths(directory, replaced);
  assert.equal(currentPaths.pluginData, paths.pluginData);
});

for (const invalidGeneration of [undefined, "../outside", "", "not-a-generation"]) {
  test(`Plugin generation metadata rejects ${String(invalidGeneration)} without falling back to legacy data`, async (t) => {
    const directory = await fs.mkdtemp("/private/tmp/live-smith-plugin-generation-invalid-");
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await installPlugin(directory, packageBytes("1.0.0"));
    const target = path.join(directory, "live-smith-plugins", "catalog.json");
    const catalog = JSON.parse(await readStoredText(directory, target));
    catalog.plugins[0].dataGeneration = invalidGeneration;
    await writeStoredJson(directory, target, catalog);
    const before = await readStoredText(directory, target);
    await assert.rejects(listInstalledPlugins(directory), /storage is invalid/);
    assert.equal(await readStoredText(directory, target), before);
  });
}
