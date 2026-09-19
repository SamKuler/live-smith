import assert from "node:assert/strict";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import type { InstalledPluginPackage } from "../storage/plugins.js";
import { installedPluginViews, previewPluginArchive } from "./view.js";

function pluginPackage(): InstalledPluginPackage {
  const bytes = zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "audio-to-midi", version: "1.0.0", description: "Convert audio",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        local: { type: "stdio", command: "./bin/converter" },
        remote: { type: "streamable-http", url: "https://api.example.com/private/path?token=hidden" },
        legacy: { type: "sse", url: "https://legacy.example.com/sse" },
      },
    })),
    "skills/convert/SKILL.md": strToU8("---\ndescription: Convert audio\n---\nUse the tool.\n"),
    "skills/broken/SKILL.md": strToU8("not a Skill"),
    "bin/converter": strToU8("#!/bin/sh\n"),
  });
  return {
    bytes,
    plugin: {
      id: "audio-to-midi", version: "1.0.0", description: "Convert audio",
      sourceFormat: "agent-plugins-1.0",
      components: { skillsDirectory: "skills", mcpConfigPath: "mcp.json" },
      sha256: "a".repeat(64), byteLength: bytes.byteLength, enabled: true,
      approvedMcpServerIds: ["remote"],
      approvedArtifactInputServerIds: [], approvedArtifactOutputServerIds: [],
      installedAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
    },
  };
}

test("Plugin wire view exposes capabilities and approval without private runtime details", async () => {
  const [view] = await installedPluginViews([pluginPackage()]);
  assert.deepEqual(view, {
    id: "audio-to-midi", version: "1.0.0", description: "Convert audio",
    sourceFormat: "agent-plugins-1.0", enabled: true, skillCount: 1,
    mcpServers: [
      { id: "local", type: "stdio", approved: false, artifactInputApproved: false,
        artifactOutputApproved: false, target: "./bin/converter" },
      { id: "remote", type: "streamable-http", approved: true, artifactInputApproved: false,
        artifactOutputApproved: false, target: "https://api.example.com" },
    ],
    unsupportedComponents: [],
    issues: ["invalid_skill", "unsupported_mcp_transport"],
  });
  assert.doesNotMatch(JSON.stringify(view), /private\/path|token=hidden|sha256|PLUGIN_DATA/u);
});

test("Plugin install preview binds review metadata to the exact archive", async () => {
  const entry = pluginPackage();
  const preview = await previewPluginArchive(entry.bytes);
  assert.equal(preview.id, "audio-to-midi");
  assert.equal(preview.enabled, false);
  assert.equal(preview.byteLength, entry.bytes.byteLength);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(preview.mcpServers.map((server) => ({
    id: server.id,
    approved: server.approved,
    target: server.target,
  })), [
    { id: "local", approved: false, target: "./bin/converter" },
    { id: "remote", approved: false, target: "https://api.example.com" },
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /private\/path|token=hidden|PLUGIN_DATA/u);
});
