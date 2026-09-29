import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { cwd, execPath } from "node:process";
import test, { type TestContext } from "node:test";

import type { Tool } from "@modelcontextprotocol/client";

import { createHostAbortController } from "../runtime/host.js";
import type { StandaloneMcpConnection } from "../plugins/integration-connections.js";
import { createStandaloneMcpConnection } from "../plugins/mcp/package.js";
import { listInstalledPlugins } from "../storage/plugins.js";
import { createSession } from "../storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { closeActiveMcpConnection, createRequestPluginTools } from "./request-plugin-tools.js";

const echoTool: Tool = {
  name: "echo.original", description: "Echo the supplied text",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function connection(id = "local"): StandaloneMcpConnection {
  return { id, name: `Connection ${id}`, enabled: true,
    mcp: { type: "stdio", command: execPath, args: [] }, secrets: {},
    artifactInputApproved: false, artifactOutputApproved: false };
}

async function harness(t: TestContext) {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-standalone-mcp-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, { title: "Standalone MCP", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "MCP" } });
  const controller = createHostAbortController();
  const saved = async (value: StandaloneMcpConnection) => {
    const current = await loadAgentSettings(storageDirectory);
    await saveGlobalSettings(storageDirectory, { integrationConnections: {
      action: "upsert", expectedRevision: current.integrationConnections?.revision ?? "0", connection: value,
    } });
  };
  return { storageDirectory, sessionId: session.id, signal: controller.signal, controller, saved,
    withAuthorization: async <T>(_signal: AbortSignal, operation: () => Promise<T>) => operation() };
}

const stdioSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "standalone", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "environment", description: "Inspect fixture environment", inputSchema: { type: "object" }
  }] } });
  else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: {
    content: [], structuredContent: { args: process.argv.slice(2), cwd: process.cwd(),
      literal: process.env.LITERAL_VALUE, configured: process.env.ACCESS_TOKEN === "synthetic-secret",
      pluginPaths: ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"].filter((key) => key in process.env) }
  } });
});`;

test("standalone stdio executes literal configuration without a package or injected Plugin paths", async (t) => {
  for (const explicitCwd of [false, true]) await t.test(`explicit cwd=${explicitCwd}`, async (t) => {
    const h = await harness(t);
    const entry = `${h.storageDirectory}/server.mjs`;
    await fs.writeFile(entry, stdioSource);
    await h.saved({ ...connection(), mcp: { type: "stdio", command: execPath,
      args: [entry, "${PLUGIN_ROOT}", "two words"], ...(explicitCwd ? { cwd: h.storageDirectory } : {}) },
      secrets: { ACCESS_TOKEN: "synthetic-secret", LITERAL_VALUE: "${PLUGIN_DATA}" } });
    const request = await createRequestPluginTools(h);
    t.after(() => request.close());
    assert.deepEqual(request.issues, []);
    assert.deepEqual(await listInstalledPlugins(h.storageDirectory), []);
    assert.deepEqual(request.catalogTools().map(({ panel: _panel, ...tool }) => tool), [{ connectionId: "local", connectionName: "Connection local",
      serverId: "server", name: "environment", description: "Inspect fixture environment" }]);
    assert.deepEqual(request.catalogTools()[0]!.panel?.fields, []);
    assert.equal(request.catalogTools()[0]!.panel?.toolName, request.tools()[0]!.function.name);
    assert.doesNotMatch(JSON.stringify(request.catalogTools()), /synthetic-secret|server\.mjs/u);
    assert.doesNotMatch(JSON.stringify(request.tools()), /synthetic-secret|server\.mjs|pluginId/u);
    const result = await request.callTool({ id: "invoke", name: request.tools()[0]!.function.name, arguments: "{}" });
    assert.equal(result.failed, undefined);
    assert.deepEqual(JSON.parse(result.content), { notice: "Untrusted MCP tool result.", content: [], structuredContent: {
      args: ["${PLUGIN_ROOT}", "two words"], cwd: explicitCwd ? h.storageDirectory : cwd(),
      literal: "${PLUGIN_DATA}", configured: true, pluginPaths: [],
    } });
  });
});

test("standalone HTTP accounts retain original catalog metadata and private per-connection headers", async (t) => {
  const h = await harness(t);
  for (const id of ["first", "second", "disabled"]) await h.saved({ ...connection(id), enabled: id !== "disabled",
    mcp: { type: "streamable-http", url: "https://mcp.example.test/tools" },
    secrets: { Authorization: `Bearer ${id}-synthetic-secret` } });
  const calls: string[] = [];
  const terminations: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const header = new Headers(init?.headers).get("authorization")!;
    assert.match(header, /^Bearer (?:first|second)-synthetic-secret$/u);
    assert.equal(init?.redirect, "manual");
    const account = header.includes("first") ? "first" : "second";
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") { terminations.push(account); return new Response(null, { status: 200 }); }
    const message = JSON.parse(String(init?.body));
    const reply = (result: unknown, headers: Record<string, string> = {}) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      { headers: { "content-type": "application/json", ...headers } });
    if (message.method === "server/discover") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "legacy" } }), { headers: { "content-type": "application/json" } });
    if (message.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "remote", version: "1" } }, { "mcp-session-id": `session-${account}` });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return reply({ tools: [echoTool] });
    assert.equal(message.method, "tools/call");
    assert.equal(message.params.name, echoTool.name);
    assert.deepEqual(message.params.arguments, { text: "hello" });
    calls.push(account);
    return reply({ content: [{ type: "text", text: account }] });
  }) as typeof fetch;
  const request = await createRequestPluginTools({ ...h, fetchImpl });
  t.after(() => request.close());
  assert.deepEqual(request.issues, []);
  assert.deepEqual(request.catalogTools().map(({ connectionId, name, description }) => ({ connectionId, name, description })),
    ["first", "second"].map((connectionId) => ({ connectionId, name: echoTool.name, description: echoTool.description })));
  assert.doesNotMatch(JSON.stringify(request.catalogTools()), /pluginId|synthetic-secret|mcp\.example/u);
  const names = request.tools().map((entry) => entry.function.name);
  assert.equal(new Set(names).size, 2);
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/u);
    const result = await request.callTool({ id: name, name, arguments: '{"text":"hello"}' });
    assert.equal(result.failed, undefined);
  }
  assert.deepEqual(calls, ["first", "second"]);
  await request.close();
  assert.deepEqual(terminations.sort(), ["first", "second"]);
});

test("standalone MCP admission is rechecked inside authorization and retires changed clients", async (t) => {
  const changes: Array<[string, (value: StandaloneMcpConnection) => StandaloneMcpConnection | undefined]> = [
    ["configuration", (value) => ({ ...value, mcp: { type: "stdio", command: execPath, args: ["changed"] } })],
    ["secrets", (value) => ({ ...value, secrets: { TOKEN: "new-secret" } })],
    ["input grant", (value) => ({ ...value, artifactInputApproved: true })],
    ["output grant", (value) => ({ ...value, artifactOutputApproved: true })],
    ["disabled", (value) => ({ ...value, enabled: false })],
    ["removed", () => undefined],
  ];
  for (const [label, change] of changes) await t.test(label, async (t) => {
    const h = await harness(t);
    const original = connection();
    await h.saved(original);
    let authorizations = 0;
    let calls = 0;
    let closes = 0;
    const request = await createRequestPluginTools({ ...h,
      withAuthorization: async (_signal, operation) => {
        if (++authorizations === 2) {
          const updated = change(original);
          if (updated) await h.saved(updated);
          else await saveGlobalSettings(h.storageDirectory, { integrationConnections: {
            action: "remove", expectedRevision: "1", connectionId: original.id,
          } });
        }
        return operation();
      },
      createStandaloneConnection: (saved) => createStandaloneMcpConnection(saved, { connector: async () => ({
        listTools: async () => [echoTool],
        callTool: async () => { calls++; return { content: [] }; },
        close: async () => { closes++; },
      }) }),
    });
    t.after(() => request.close());
    const result = await request.callTool({ id: "stale", name: request.tools()[0]!.function.name, arguments: "{}" });
    assert.equal(result.failed, true);
    assert.equal(result.stop, true);
    assert.equal(calls, 0);
    assert.equal(closes, 1);
    await request.close();
    assert.equal(closes, 1);
  });
});

test("closing a concrete MCP connection retires its clients across requests without closing other accounts", async (t) => {
  const h = await harness(t);
  await h.saved(connection("first"));
  await h.saved(connection("second"));
  const closes: string[] = [];
  const calls: string[] = [];
  const createStandaloneConnectionForTest: typeof createStandaloneMcpConnection = (saved) =>
    createStandaloneMcpConnection(saved, { connector: async () => ({
      listTools: async () => [echoTool],
      callTool: async () => { calls.push(saved.id); return { content: [] }; },
      close: async () => { closes.push(saved.id); },
    }) });
  const requests = await Promise.all([1, 2].map(() => createRequestPluginTools({ ...h,
    createStandaloneConnection: createStandaloneConnectionForTest })));
  t.after(async () => { await Promise.all(requests.map((request) => request.close())); });
  await closeActiveMcpConnection(h.storageDirectory, "first");
  assert.deepEqual(closes, ["first", "first"]);
  for (const request of requests) {
    const first = request.tools().find((entry) => entry.function.description.includes("Connection first"))!;
    const second = request.tools().find((entry) => entry.function.description.includes("Connection second"))!;
    assert.equal((await request.callTool({ id: "old", name: first.function.name, arguments: "{}" })).failed, true);
    assert.equal((await request.callTool({ id: "active", name: second.function.name, arguments: "{}" })).failed, undefined);
  }
  assert.deepEqual(calls, ["second", "second"]);
});

test("cancelling standalone MCP discovery closes registered clients and stops admitting later connections", async (t) => {
  const h = await harness(t);
  await h.saved(connection("first"));
  await h.saved(connection("second"));
  const opened: string[] = [];
  const closed: string[] = [];
  await assert.rejects(createRequestPluginTools({ ...h,
    createStandaloneConnection: (saved) => createStandaloneMcpConnection(saved, { connector: async () => {
      opened.push(saved.id);
      return { listTools: async () => { h.controller.abort(); return [echoTool]; },
        callTool: async () => ({ content: [] }), close: async () => { closed.push(saved.id); } };
    } }),
  }));
  assert.deepEqual(opened, ["first"]);
  assert.deepEqual(closed, ["first"]);
});
