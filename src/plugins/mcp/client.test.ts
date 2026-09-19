import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execPath } from "node:process";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import { connectPluginMcpServer, PluginMcpConnectionError } from "./client.js";
import type { PluginMcpStdioServer } from "./config.js";

const serverSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  } else if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" }
    } });
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
      name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } }
    }] } });
  } else if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }],
      structuredContent: { echoed: request.params.arguments?.text ?? "" }
    } });
  }
});
`;

test("official MCP client connects to stdio, lists tools, calls them, and closes", async (t) => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-mcp-client-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = `${root}/data`;
  await fs.mkdir(data);
  const entry = `${root}/server.mjs`;
  await fs.writeFile(entry, serverSource, "utf8");
  const server: PluginMcpStdioServer = { id: "fixture", type: "stdio", command: execPath, args: [entry], env: {} };
  const connection = await connectPluginMcpServer(server, { pluginRoot: root, pluginData: data }, createHostAbortController().signal);
  t.after(() => connection.close());
  const tools = await connection.listTools(createHostAbortController().signal);
  assert.deepEqual(tools.map(({ name, description }) => ({ name, description })), [
    { name: "echo", description: "Echo text" },
  ]);
  const result = await connection.callTool("echo", { text: "hello" }, createHostAbortController().signal);
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result.structuredContent, { echoed: "hello" });
});

test("MCP client rejects non-object arguments before sending a tool call", async (t) => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-mcp-client-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = `${root}/server.mjs`;
  await fs.writeFile(entry, serverSource, "utf8");
  const server: PluginMcpStdioServer = { id: "fixture", type: "stdio", command: execPath, args: [entry], env: {} };
  const connection = await connectPluginMcpServer(server, { pluginRoot: root, pluginData: root }, createHostAbortController().signal);
  t.after(() => connection.close());
  await assert.rejects(
    connection.callTool("echo", ["not", "an", "object"], createHostAbortController().signal),
    PluginMcpConnectionError,
  );
});
