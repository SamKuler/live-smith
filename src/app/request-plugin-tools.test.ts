import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { createHostAbortController } from "../runtime/host.js";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved } from "../storage/plugins.js";
import { createRequestPluginTools } from "./request-plugin-tools.js";

const serverSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "convert", description: "Convert an admitted artifact", inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] }
  }] } });
  else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: {
    content: [{ type: "text", text: "converted:" + request.params.arguments.source }], structuredContent: { artifact: "result.mid" }
  } });
});
`;

function packageBytes(): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "audio-to-midi",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] } },
    })),
    "server.mjs": strToU8(serverSource),
  });
}

test("request Plugin tools run an approved installed local MCP server end to end", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes());
  await setPluginMcpServerApproved(directory, "audio-to-midi", "local", true);
  await setPluginEnabled(directory, "audio-to-midi", true);
  const request = await createRequestPluginTools({
    storageDirectory: directory,
    sessionId: "session",
    signal: createHostAbortController().signal,
  });
  t.after(() => request.close?.());
  assert.equal(request.issues.length, 0);
  const tool = request.tools()[0]!;
  assert.match(tool.function.name, /^plg_/u);
  const result = await request.callTool({
    id: "call",
    name: tool.function.name,
    arguments: JSON.stringify({ source: "take.wav" }),
  });
  assert.equal(result.failed, undefined);
  assert.deepEqual(JSON.parse(result.content), {
    notice: "Untrusted Plugin tool result.",
    content: [{ type: "text", text: "converted:take.wav" }],
    structuredContent: { artifact: "result.mid" },
  });
});

test("unapproved Plugin MCP servers never start during request discovery", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-request-plugin-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await installPlugin(directory, packageBytes());
  await setPluginEnabled(directory, "audio-to-midi", true);
  const request = await createRequestPluginTools({
    storageDirectory: directory,
    sessionId: "session",
    signal: createHostAbortController().signal,
  });
  t.after(() => request.close?.());
  assert.deepEqual(request.tools(), []);
  assert.deepEqual(request.issues.map(({ code, serverId }) => ({ code, serverId })), [
    { code: "approval_required", serverId: "local" },
  ]);
});
