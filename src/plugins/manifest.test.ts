import assert from "node:assert/strict";
import test from "node:test";

import { parsePluginPackageManifest, type PluginPackageFile } from "./manifest.js";

const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");
const file = (path: string, value: unknown): PluginPackageFile => ({ path, bytes: bytes(value) });

test("portable Agent Plugins manifest is canonical and discovers fixed components", () => {
  const plugin = parsePluginPackageManifest([
    file("plugin.json", {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "audio-to-midi",
      version: "1.2.3",
      description: "Convert an admitted audio artifact into MIDI.",
    }),
    file("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} }),
    { path: "skills/transcribe/SKILL.md", bytes: Buffer.from("---\nname: transcribe\ndescription: Convert audio\n---\nUse the tool.\n") },
  ]);
  assert.deepEqual(plugin, {
    id: "audio-to-midi",
    version: "1.2.3",
    description: "Convert an admitted audio artifact into MIDI.",
    sourceFormat: "agent-plugins-1.0",
    components: { skillsDirectory: "skills", mcpConfigPath: "mcp.json" },
  });
});

test("Codex and Claude compatibility manifests use one bounded identity contract", () => {
  for (const [path, sourceFormat] of [
    [".codex-plugin/plugin.json", "codex"],
    [".claude-plugin/plugin.json", "claude"],
  ] as const) {
    assert.deepEqual(parsePluginPackageManifest([file(path, {
      name: "fixture-plugin", version: "0.4.0", description: "Fixture tools",
      skills: "./skills/", mcpServers: "./.mcp.json",
    })]), {
      id: "fixture-plugin", version: "0.4.0", description: "Fixture tools", sourceFormat,
      components: { skillsDirectory: "skills", mcpConfigPath: ".mcp.json" },
    });
  }
});

test("portable identity wins only when compatibility overlays agree", () => {
  const portable = file("plugin.json", { name: "fixture-plugin", version: "1.0.0", description: "Portable" });
  assert.throws(() => parsePluginPackageManifest([
    portable,
    file(".claude-plugin/plugin.json", { name: "another-plugin", version: "1.0.0", description: "Claude" }),
  ]), /identity/u);
});

test("manifest paths and identities cannot escape their package", () => {
  for (const value of ["../skills", "/skills", "./skills/../../outside", "skills\\outside"]) {
    assert.throws(() => parsePluginPackageManifest([file(".codex-plugin/plugin.json", {
      name: "fixture-plugin", version: "1.0.0", description: "Fixture", skills: value,
    })]), /path/u);
  }
  for (const name of ["Fixture Plugin", "../fixture", "fixture:plugin", "a".repeat(65)]) {
    assert.throws(() => parsePluginPackageManifest([file("plugin.json", {
      name, version: "1.0.0", description: "Fixture",
    })]), /name/u);
  }
});

test("manifest discovery rejects duplicate normalized paths and ambiguous compatibility roots", () => {
  assert.throws(() => parsePluginPackageManifest([
    file("plugin.json", { name: "fixture", version: "1.0.0", description: "Fixture" }),
    file("./plugin.json", { name: "fixture", version: "1.0.0", description: "Fixture" }),
  ]), /duplicate/u);
  assert.throws(() => parsePluginPackageManifest([
    file(".codex-plugin/plugin.json", { name: "fixture", version: "1.0.0", description: "Fixture" }),
    file(".claude-plugin/plugin.json", { name: "fixture", version: "1.0.0", description: "Fixture" }),
  ]), /ambiguous/u);
});
