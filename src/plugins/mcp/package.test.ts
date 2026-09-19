import assert from "node:assert/strict";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { createHostAbortController } from "../../runtime/host.js";
import type { PreparedPluginRuntime } from "../../storage/plugins.js";
import { openPluginArchive } from "../archive.js";
import type { ConnectedPluginMcpServer } from "./client.js";
import { PORTABLE_MCP_SCHEMA, type PluginMcpServer } from "./config.js";
import { createMcpPluginPackage, pluginToolCallName, type PluginMcpConnector } from "./package.js";
import { LIVE_SMITH_ARTIFACT_META_KEY } from "../artifacts.js";

async function prepared(approvedMcpServerIds: string[]): Promise<PreparedPluginRuntime> {
  const archive = await openPluginArchive(zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "acme.audio-tools",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: PORTABLE_MCP_SCHEMA,
      mcpServers: {
        primary: { type: "stdio", command: "node" },
        secondary: { type: "streamable-http", url: "https://example.com/mcp" },
      },
    })),
  }));
  return {
    archive,
    pluginRoot: "/plugin/root",
    pluginData: "/plugin/data",
    plugin: {
      id: "acme.audio-tools",
      sourceFormat: "agent-plugins-1.0",
      components: { mcpConfigPath: "mcp.json" },
      sha256: "a".repeat(64),
      byteLength: 1,
      enabled: true,
      approvedMcpServerIds,
      approvedArtifactInputServerIds: [],
      approvedArtifactOutputServerIds: [],
      installedAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    },
  };
}

function connection(server: PluginMcpServer, calls: string[]): ConnectedPluginMcpServer {
  return {
    listTools: async () => [{
      name: `${server.id}.echo`,
      description: `Echo through ${server.id}`,
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    callTool: async (name, argumentsValue) => {
      calls.push(`${server.id}:${name}`);
      return { content: [{ type: "text", text: String((argumentsValue as { text?: unknown }).text ?? "") }] };
    },
    close: async () => undefined,
  };
}

test("PluginPackage exposes only approved MCP servers and keeps generic tool routing", async () => {
  const calls: string[] = [];
  const connector: PluginMcpConnector = async (server) => connection(server, calls);
  const plugin = createMcpPluginPackage(await prepared(["primary"]), { connector });
  const context = { sessionId: "session", signal: createHostAbortController().signal };
  const discovered = await plugin.tools(context);
  assert.equal(discovered.tools.length, 1);
  assert.deepEqual(discovered.tools[0], {
    pluginId: "acme.audio-tools",
    serverId: "primary",
    name: "primary.echo",
    tool: {
      type: "function",
      function: {
        name: pluginToolCallName("acme.audio-tools", "primary", "primary.echo"),
        description: "Echo through primary",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    },
  });
  assert.deepEqual(discovered.issues.map(({ serverId, code }) => ({ serverId, code })), [
    { serverId: "secondary", code: "approval_required" },
  ]);
  assert.deepEqual(await plugin.callTool("primary", "primary.echo", { text: "hello" }, context), {
    content: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(calls, ["primary:primary.echo"]);
  await assert.rejects(plugin.callTool("secondary", "secondary.echo", {}, context), /not approved/u);
  await plugin.close();
});

test("one failed MCP server does not hide independent Plugin tools", async () => {
  const connector: PluginMcpConnector = async (server) => {
    if (server.id === "primary") throw new Error("secret endpoint failure");
    return connection(server, []);
  };
  const plugin = createMcpPluginPackage(await prepared(["primary", "secondary"]), { connector });
  const discovered = await plugin.tools({ sessionId: "session", signal: createHostAbortController().signal });
  assert.deepEqual(discovered.tools.map(({ serverId }) => serverId), ["secondary"]);
  assert.deepEqual(discovered.issues.map(({ serverId, code, message }) => ({ serverId, code, message })), [{
    serverId: "primary",
    code: "connection_failed",
    message: "MCP server could not be reached.",
  }]);
  await plugin.close();
});

test("Plugin MCP results cannot expose materialized package or private data paths", async () => {
  const connector: PluginMcpConnector = async (server) => ({
    ...connection(server, []),
    callTool: async () => ({ content: [{ type: "text", text: "/plugin/root/private-file" }] }),
  });
  const plugin = createMcpPluginPackage(await prepared(["primary"]), { connector });
  await plugin.tools({ sessionId: "session", signal: createHostAbortController().signal });
  await assert.rejects(plugin.callTool(
    "primary",
    "primary.echo",
    { text: "hello" },
    { sessionId: "session", signal: createHostAbortController().signal },
  ), /private filesystem path/u);
  await plugin.close();
});

test("provider-facing Plugin tool names are bounded, safe, and identity-stable", () => {
  const first = pluginToolCallName("plugin.with.dots", "server-name", "tool with spaces/and symbols");
  const second = pluginToolCallName("plugin.with.dots", "server-name", "tool with spaces/and symbols");
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{1,64}$/u);
  assert.notEqual(first, pluginToolCallName("plugin.with.dots", "another", "tool with spaces/and symbols"));
});

test("only local MCP tools may declare the Live Smith artifact bridge", async () => {
  const artifactTool = {
    name: "transcribe",
    description: "Transcribe audio",
    inputSchema: { type: "object" as const, properties: {
      source: { type: "string" }, destination: { type: "string" },
    }, required: ["source", "destination"] },
    _meta: { [LIVE_SMITH_ARTIFACT_META_KEY]: {
      version: 1,
      inputs: [{ argument: "source", kind: "audio" }],
      outputs: [{ argument: "destination", kind: "midi", label: "MIDI" }],
    } },
  };
  const connector: PluginMcpConnector = async () => ({
    listTools: async () => [artifactTool],
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  });
  const plugin = createMcpPluginPackage(await prepared(["primary", "secondary"]), { connector });
  const discovered = await plugin.tools({ sessionId: "session", signal: createHostAbortController().signal });
  assert.equal(discovered.tools.length, 1);
  assert.equal(discovered.tools[0]!.serverId, "primary");
  assert.deepEqual(discovered.tools[0]!.artifactContract, {
    inputs: [{ argument: "source", kind: "audio" }],
    outputs: [{ argument: "destination", kind: "midi", label: "MIDI" }],
  });
  assert.doesNotMatch(JSON.stringify(discovered.tools[0]!.tool.function.parameters), /destination/u);
  assert.ok(discovered.issues.some((issue) => issue.serverId === "secondary" && issue.code === "invalid_tool"));
  await plugin.close();
});
