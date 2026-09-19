import assert from "node:assert/strict";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { openPluginArchive } from "../archive.js";
import {
  parsePluginMcpConfig,
  pluginMcpConfigFromArchive,
  PluginMcpConfigError,
  PORTABLE_MCP_SCHEMA,
} from "./config.js";

const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");

test("portable MCP configuration parses stdio and Streamable HTTP independently", () => {
  const parsed = parsePluginMcpConfig(bytes({
    $schema: PORTABLE_MCP_SCHEMA,
    mcpServers: {
      local: {
        type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"],
        env: { CACHE: "${PLUGIN_DATA}/cache" }, cwd: "${PLUGIN_ROOT}",
      },
      remote: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "public" } },
    },
  }), { sourceFormat: "agent-plugins-1.0" });
  assert.deepEqual(parsed, {
    servers: [
      { id: "local", type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"], env: { CACHE: "${PLUGIN_DATA}/cache" }, cwd: "${PLUGIN_ROOT}" },
      { id: "remote", type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "public" } },
    ],
    issues: [],
  });
});

test("invalid and unsupported server entries do not disable independent servers", () => {
  const parsed = parsePluginMcpConfig(bytes({
    $schema: PORTABLE_MCP_SCHEMA,
    mcpServers: {
      valid: { type: "stdio", command: "node" },
      escaping: { type: "stdio", command: "./../outside" },
      legacy: { type: "sse", url: "https://example.com/sse" },
    },
  }), { sourceFormat: "agent-plugins-1.0" });
  assert.deepEqual(parsed.servers.map(({ id }) => id), ["valid"]);
  assert.deepEqual(parsed.issues.map(({ serverId, code }) => ({ serverId, code })), [
    { serverId: "escaping", code: "invalid_server" },
    { serverId: "legacy", code: "unsupported_transport" },
  ]);
});

test("portable MCP top-level schema is closed and fatal only to the MCP component", () => {
  for (const value of [
    { mcpServers: {} },
    { $schema: PORTABLE_MCP_SCHEMA, mcpServers: {}, extra: true },
    { $schema: PORTABLE_MCP_SCHEMA, mcpServers: [] },
  ]) {
    assert.throws(() => parsePluginMcpConfig(bytes(value), { sourceFormat: "agent-plugins-1.0" }), PluginMcpConfigError);
  }
});

test("remote MCP URLs and literal headers enforce portable transport safety", () => {
  const parsed = parsePluginMcpConfig(bytes({
    $schema: PORTABLE_MCP_SCHEMA,
    mcpServers: {
      cleartext: { type: "streamable-http", url: "http://example.com/mcp" },
      credentials: { type: "streamable-http", url: "https://user:pass@example.com/mcp" },
      duplicateHeaders: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "one", authorization: "two" } },
      loopback: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
    },
  }), { sourceFormat: "agent-plugins-1.0" });
  assert.deepEqual(parsed.servers.map(({ id }) => id), ["loopback"]);
  assert.equal(parsed.issues.length, 3);
});

test("Claude-compatible MCP accepts inline stdio and http aliases without weakening portable parsing", () => {
  const parsed = parsePluginMcpConfig(bytes({
    name: "fixture",
    mcpServers: {
      local: { command: "${CLAUDE_PLUGIN_ROOT}/server", args: ["${CLAUDE_PLUGIN_DATA}/state"] },
      remote: { type: "http", url: "https://example.com/mcp" },
    },
  }), { sourceFormat: "claude", inline: true });
  assert.deepEqual(parsed.servers.map(({ id, type }) => ({ id, type })), [
    { id: "local", type: "stdio" },
    { id: "remote", type: "streamable-http" },
  ]);
});

test("archive MCP discovery reads the exact declared component without affecting Skills", async () => {
  const archive = await openPluginArchive(zipSync({
    ".claude-plugin/plugin.json": strToU8(JSON.stringify({
      name: "fixture", mcpServers: { local: { command: "node", args: ["server.js"] } },
    })),
    "skills/example/SKILL.md": strToU8("---\ndescription: Example\n---\nInstructions\n"),
  }));
  assert.deepEqual(pluginMcpConfigFromArchive(archive)?.servers.map(({ id }) => id), ["local"]);
});
