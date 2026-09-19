import assert from "node:assert/strict";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { openPluginArchive, PluginArchiveError } from "./archive.js";

const manifest = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "audio-to-midi",
  version: "1.0.0",
  description: "Convert audio into MIDI.",
});

test("Plugin archive opens a portable package and retains exact immutable files", async () => {
  const archive = await openPluginArchive(zipSync({
    "plugin.json": strToU8(manifest),
    "mcp.json": strToU8('{"mcpServers":{}}'),
    "skills/convert/SKILL.md": strToU8("---\nname: convert\ndescription: Convert audio\n---\nUse the tool.\n"),
  }));
  assert.equal(archive.manifest.id, "audio-to-midi");
  assert.deepEqual([...archive.files.keys()], ["mcp.json", "plugin.json", "skills/convert/SKILL.md"]);
  assert.equal(new TextDecoder().decode(archive.files.get("plugin.json")), manifest);
});

test("Plugin archive accepts one enclosing distribution directory", async () => {
  const archive = await openPluginArchive(zipSync({
    "audio-to-midi/plugin.json": strToU8(manifest),
    "audio-to-midi/mcp.json": strToU8('{"mcpServers":{}}'),
  }));
  assert.deepEqual([...archive.files.keys()], ["mcp.json", "plugin.json"]);
});

test("Plugin archive rejects unsafe paths and ambiguous package roots", async () => {
  await assert.rejects(
    openPluginArchive(zipSync({ "../plugin.json": strToU8(manifest) })),
    (error: unknown) => error instanceof PluginArchiveError && error.code === "archive_limit",
  );
  await assert.rejects(openPluginArchive(zipSync({
    "one/plugin.json": strToU8(manifest),
    "two/plugin.json": strToU8(manifest),
  })), /single package root/u);
});

test("Plugin archive rejects non-ZIP and packages without a supported manifest", async () => {
  await assert.rejects(openPluginArchive(strToU8("not a zip")), PluginArchiveError);
  await assert.rejects(openPluginArchive(zipSync({ "README.md": strToU8("No manifest") })), /manifest/u);
});

test("Plugin archive returns defensive copies", async () => {
  const source = zipSync({ "plugin.json": strToU8(manifest) });
  const archive = await openPluginArchive(source);
  const first = archive.files.get("plugin.json")!;
  first[0] = 0;
  const reopened = await openPluginArchive(source);
  assert.equal(new TextDecoder().decode(reopened.files.get("plugin.json")), manifest);
});
