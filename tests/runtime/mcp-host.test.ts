import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { URL } from "node:url";

for (const nativeEvent of [false, true]) test(`MCP server bundle loads in the Extension VM with ${nativeEvent ? "native" : "missing"} Event`, async (t) => {
  const result = await build({ entryPoints: [resolve("src/app/mcp/server.ts")], bundle: true,
    platform: "node", format: "cjs", write: false, inject: [resolve("src/runtime/network-node-globals.ts")] });
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox = vm.createContext({ module, exports: module.exports, require: createRequire(import.meta.url) });
  vm.runInContext(result.outputFiles[0]!.text, sandbox, { timeout: 5000 });
  assert.equal(typeof module.exports.createMcpHttpServer, "function");
  Object.assign(sandbox, { AbortController, AbortSignal, ...(nativeEvent ? { Event } : {}) });
  const start = module.exports.createMcpHttpServer as (options: unknown) => Promise<{ url: string; close(): Promise<void> }>;
  const server = await start({ port: 0, onError: (error: Error) => t.diagnostic(error.stack ?? error.message), authenticate: async (token: string) => token === "fixture" ? { id: "client", sessionId: "session" } : undefined,
    tools: async () => [{ type: "function", function: { name: "inspect", description: "Read the fixture", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    callTool: async () => ({ content: [{ type: "text", text: "observed" }] }) });
  if (nativeEvent) assert.equal(sandbox.Event, Event);
  const client = new Client({ name: "vm-fixture", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    assert.equal((await fetch(server.url)).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: "Bearer fixture" } } }));
    assert.equal((await client.listTools()).tools[0]?.name, "inspect");
    assert.deepEqual((await client.callTool({ name: "inspect", arguments: {} })).content, [{ type: "text", text: "observed" }]);
  } finally { await client.close(); await server.close(); }
});
