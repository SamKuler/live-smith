import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
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

async function installedArchivePath(directory: string): Promise<string> {
  const [plugin] = await listInstalledPlugins(directory);
  assert.ok(plugin);
  return path.join(directory, "live-smith-plugins", "packages", plugin.id, `${plugin.sha256}.zip`);
}

async function fileHandlePrototype(target: string): Promise<{ chmod: (mode: number) => Promise<void> }> {
  const handle = await fs.open(target, "r");
  const prototype = Object.getPrototypeOf(handle) as { chmod: (mode: number) => Promise<void> };
  await handle.close();
  return prototype;
}

async function mockFileHandleChmod(
  t: test.TestContext,
  target: string,
  implementation: (mode: number) => Promise<void>,
): Promise<void> {
  t.mock.method(await fileHandlePrototype(target), "chmod", implementation);
}

test("installed Plugin root already at 0700 reads without path chmod", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const root = path.join(directory, "live-smith-plugins");
  await fs.chmod(root, 0o700);
  const before = await fs.stat(root);

  assert.equal((await listInstalledPlugins(directory)).length, 1);
  assert.equal((await fs.stat(root)).ctimeMs, before.ctimeMs);
});

test("installed Plugin archive already at 0600 reads without FileHandle chmod", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const archive = await installedArchivePath(directory);
  await fs.chmod(archive, 0o600);
  await mockFileHandleChmod(t, archive, async () => {
    throw new Error("chmod unavailable");
  });

  assert.ok((await readInstalledPluginArchive(directory, "fixture-plugin")).byteLength > 0);
});

test("permissive installed Plugin root tightens to exactly 0700", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const root = path.join(directory, "live-smith-plugins");
  await fs.chmod(root, 0o755);

  assert.equal((await listInstalledPlugins(directory)).length, 1);
  assert.equal((await fs.stat(root)).mode & 0o7777, 0o700);
});

test("permissive installed Plugin archive tightens to exactly 0600", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const archive = await installedArchivePath(directory);
  await fs.chmod(archive, 0o644);
  const prototype = await fileHandlePrototype(archive);
  const chmod = prototype.chmod;
  let calls = 0;
  t.mock.method(prototype, "chmod", async function (this: fs.FileHandle, mode: number) {
    calls += 1;
    return chmod.call(this, mode);
  });

  assert.ok((await readInstalledPluginArchive(directory, "fixture-plugin")).byteLength > 0);
  assert.equal(calls, 1);
  assert.equal((await fs.stat(archive)).mode & 0o7777, 0o600);
});

test("permissive installed Plugin archive fails closed when chmod fails", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const archive = await installedArchivePath(directory);
  await fs.chmod(archive, 0o644);
  await mockFileHandleChmod(t, archive, async () => {
    throw new Error("chmod unavailable");
  });

  await assert.rejects(readInstalledPluginArchive(directory, "fixture-plugin"));
});

test("permissive installed Plugin archive rejects ineffective chmod", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const archive = await installedArchivePath(directory);
  await fs.chmod(archive, 0o644);
  await mockFileHandleChmod(t, archive, async () => undefined);

  await assert.rejects(readInstalledPluginArchive(directory, "fixture-plugin"), /storage is invalid/u);
  assert.equal((await fs.stat(archive)).mode & 0o7777, 0o644);
});

test("installed Plugin storage clears special permission bits before reading", {
  skip: platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const root = path.join(directory, "live-smith-plugins");
  const archive = await installedArchivePath(directory);
  let tested = 0;
  for (const [target, expected] of [[root, 0o700], [archive, 0o600]] as const) {
    const mode = expected | 0o4000;
    await fs.chmod(target, mode);
    if (((await fs.stat(target)).mode & 0o7777) !== mode) continue;
    tested += 1;
    assert.ok((await readInstalledPluginArchive(directory, "fixture-plugin")).byteLength > 0);
    assert.equal((await fs.stat(target)).mode & 0o7777, expected);
  }
  if (tested === 0) t.skip("The filesystem does not preserve special permission bits.");
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
  catalog.schemaVersion = 1;
  delete catalog.pendingCleanup;
  delete catalog.plugins[0].approvedArtifactInputServerIds;
  delete catalog.plugins[0].approvedArtifactOutputServerIds;
  await fs.writeFile(target, JSON.stringify(catalog, null, 2));
  const before = await fs.readFile(target, "utf8");
  const [loaded] = await listInstalledPlugins(directory);
  assert.deepEqual(loaded?.approvedArtifactInputServerIds, []);
  assert.deepEqual(loaded?.approvedArtifactOutputServerIds, []);
  assert.equal(await fs.readFile(target, "utf8"), before);
  await setPluginEnabled(directory, "fixture-plugin", true);
  const upgraded = JSON.parse(await fs.readFile(target, "utf8"));
  assert.equal(upgraded.schemaVersion, 2);
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
  const data = path.join(directory, "live-smith-plugins", "data", "fixture-plugin");
  t.after(async () => {
    await fs.chmod(data, 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  await preparePluginRuntime(directory, "fixture-plugin");
  await setPluginEnabled(directory, "fixture-plugin", false);
  await fs.writeFile(path.join(data, "state.json"), "private", { mode: 0o600 });
  await fs.chmod(data, 0o500);

  assert.equal(await deletePlugin(directory, "fixture-plugin"), false);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "live-smith-plugins", "catalog.json"), "utf8"))
    .pendingCleanup, [{ kind: "delete", pluginId: "fixture-plugin" }]);
  await assert.rejects(installPlugin(directory, packageBytes("2.0.0")), /awaiting cleanup/u);
  await fs.chmod(data, 0o700);
  assert.deepEqual(await listInstalledPlugins(directory), []);
  await assert.rejects(fs.lstat(data), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "live-smith-plugins", "catalog.json"), "utf8"))
    .pendingCleanup, []);
});

test("pending Plugin cleanup never follows a replaced private-data ancestor", { skip: platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  const dataRoot = path.join(directory, "live-smith-plugins", "data");
  const data = path.join(dataRoot, "fixture-plugin");
  const held = `${dataRoot}.held`;
  const outside = path.join(directory, "outside");
  t.after(async () => {
    await fs.chmod(data, 0o700).catch(() => undefined);
    await fs.chmod(path.join(held, "fixture-plugin"), 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await installPlugin(directory, packageBytes("1.0.0"));
  await setPluginEnabled(directory, "fixture-plugin", true);
  await preparePluginRuntime(directory, "fixture-plugin");
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
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "live-smith-plugins", "catalog.json"), "utf8"))
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
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "live-smith-plugins", "catalog.json"), "utf8"))
    .pendingCleanup, [{ kind: "replace", pluginId: "fixture-plugin", sha256: old.sha256 }]);
  await setPluginEnabled(directory, "fixture-plugin", true);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "live-smith-plugins", "catalog.json"), "utf8"))
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
  await fs.writeFile(target, "{broken", "utf8");
  const before = await fs.readFile(target);
  await assert.rejects(listInstalledPlugins(directory), /storage is invalid/u);
  assert.deepEqual(await fs.readFile(target), before);
});

test("Plugin cleanup intent rejects paths outside its owned Plugin ID", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes("1.0.0"));
  const target = path.join(directory, "live-smith-plugins", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(target, "utf8"));
  catalog.pendingCleanup = [{ kind: "delete", pluginId: "../outside" }];
  await fs.writeFile(target, JSON.stringify(catalog));
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
