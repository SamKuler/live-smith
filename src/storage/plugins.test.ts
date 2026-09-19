import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  deletePlugin,
  installPlugin,
  listInstalledPlugins,
  readInstalledPluginArchive,
  setPluginEnabled,
} from "./plugins.js";

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
  source.fill(0);
  const stored = await readInstalledPluginArchive(directory, installed.id);
  assert.notEqual(stored[0], 0);
  stored.fill(0);
  assert.notEqual((await readInstalledPluginArchive(directory, installed.id))[0], 0);
  assert.deepEqual((await listInstalledPlugins(directory)).map(({ id, enabled }) => ({ id, enabled })), [
    { id: "fixture-plugin", enabled: false },
  ]);
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
  assert.equal((await listInstalledPlugins(directory))[0]!.version, "2.0.0");
});

test("Plugin catalog serializes concurrent installs and deletes only the selected package", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-plugins-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const second = zipSync({ "plugin.json": strToU8(JSON.stringify({
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
