import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { execPath } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import test from "node:test";

import { createHostAbortController } from "../../../src/runtime/host.js";
import { connectPluginMcpServer, PluginMcpConnectionError } from "../../../src/plugins/mcp/client.js";
import type { PluginMcpRemoteServer, PluginMcpStdioServer } from "../../../src/plugins/mcp/config.js";

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

test("installed stdio inline scripts keep JavaScript templates literal", async (t) => {
  const root = await fs.mkdtemp("/private/tmp/live-smith-mcp-inline-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = 'const name = "template result"; const message = `${name}`;\n' +
    serverSource.replace('String(request.params.arguments?.text ?? "")', 'message');
  const connection = await connectPluginMcpServer({ id: "inline", type: "stdio", command: execPath,
    args: ["--input-type=module", "-e", script], env: {},
  }, { pluginRoot: root, pluginData: root }, createHostAbortController().signal);
  t.after(() => connection.close());
  const result = await connection.callTool("echo", {}, createHostAbortController().signal);
  assert.deepEqual(result.content, [{ type: "text", text: "template result" }]);
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

const remoteServer: PluginMcpRemoteServer = {
  id: "remote", type: "streamable-http", url: "https://mcp.example.test/mcp", headers: {},
};

function remoteFetch(options: {
  listResponse?: (id: unknown) => Response;
  resourcesResponse?: (request: { id?: unknown; method: string; params?: { cursor?: string } }) => Response | Promise<Response>;
  getResponse?: () => Response;
  terminate?: (signal: AbortSignal | null | undefined) => Promise<Response>;
} = {}): typeof fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (init?.method === "GET") return options.getResponse?.() ?? new Response(null, { status: 405 });
    if (init?.method === "DELETE") return options.terminate?.(init.signal) ?? new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body)) as { id?: unknown; method: string; params?: { cursor?: string } };
    const reply = (result: unknown, headers: Record<string, string> = {}) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      { headers: { "content-type": "application/json", ...headers } },
    );
    if (message.method === "server/discover") return new Response(JSON.stringify({
      jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" },
    }), { headers: { "content-type": "application/json" } });
    if (message.method === "initialize") return reply({
      protocolVersion: "2025-03-26", capabilities: { tools: {}, ...(options.resourcesResponse ? { resources: {} } : {}) },
      serverInfo: { name: "fixture", version: "1" },
    }, { "mcp-session-id": "session-fixture" });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "notifications/cancelled") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return options.listResponse?.(message.id) ?? reply({ tools: [] });
    if (message.method === "resources/list" || message.method === "resources/templates/list") {
      return options.resourcesResponse?.(message) ?? reply({ resources: [] });
    }
    throw new Error("Unexpected MCP request.");
  }) as typeof fetch;
}

test("MCP resource lists preserve each page and opaque cursor beyond sixteen pages", async (t) => {
  for (const templates of [false, true]) {
    await t.test(templates ? "templates" : "resources", async (t) => {
      const cursors = Array.from({ length: 16 }, (_unused, index) => `opaque page/${index + 1} +?&=`);
      const requests: Array<{ cursor?: string }> = [];
      const fetchImpl = remoteFetch({ resourcesResponse(request) {
        assert.equal(request.method, templates ? "resources/templates/list" : "resources/list");
        requests.push(request.params ?? {});
        const page = request.params?.cursor === undefined ? 0 : cursors.indexOf(request.params.cursor) + 1;
        assert.ok(page === 0 ? request.params?.cursor === undefined : page > 0);
        const item = templates
          ? { name: `Page ${page}`, uriTemplate: `resource://page/${page}/{id}` }
          : { name: `Page ${page}`, uri: `resource://page/${page}` };
        const result = { [templates ? "resourceTemplates" : "resources"]: [item],
          ...(page < 16 ? { nextCursor: cursors[page] } : {}), _meta: { page } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
          headers: { "content-type": "application/json" },
        });
      } });
      const signal = createHostAbortController().signal;
      const connection = await connectPluginMcpServer(remoteServer, undefined, signal, { fetchImpl });
      t.after(() => connection.close());
      let cursor: string | undefined;
      for (let page = 0; page < 17; page++) {
        const result = await connection.listResources!(templates, cursor, signal) as {
          resources?: unknown[]; resourceTemplates?: unknown[]; nextCursor?: string; _meta: { page: number };
        };
        assert.equal((templates ? result.resourceTemplates : result.resources)?.length, 1);
        assert.deepEqual(result._meta, { page });
        assert.equal(result.nextCursor, page < 16 ? cursors[page] : undefined);
        assert.equal(requests.length, page + 1, "one server page per caller request");
        assert.deepEqual(requests.at(-1), cursor === undefined ? {} : { cursor });
        cursor = result.nextCursor;
      }
      assert.equal(cursor, undefined);
    });
  }
});

test("MCP resource lists preserve cancellation and reject invalid or oversized pages", async (t) => {
  for (const templates of [false, true]) {
    await t.test(templates ? "templates" : "resources", async (t) => {
      const key = templates ? "resourceTemplates" : "resources";
      const uriKey = templates ? "uriTemplate" : "uri";
      for (const failure of ["schema", "size", "abort"] as const) {
        await t.test(failure, async (t) => {
          let started!: () => void;
          const dispatched = new Promise<void>((resolve) => { started = resolve; });
          let release!: () => void;
          const blocked = new Promise<void>((resolve) => { release = resolve; });
          const controller = createHostAbortController();
          const reason = new Error("Resource listing stopped.");
          const fetchImpl = remoteFetch({ async resourcesResponse(request) {
            started();
            if (failure === "abort") await blocked;
            const result = { [key]: [{ name: "Resource", [uriKey]: failure === "schema" ? 42 : "resource://fixture/{id}",
              ...(failure === "size" ? { description: "x".repeat(4 * 1024 * 1024 + 1024) } : {}) }] };
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
              headers: { "content-type": "application/json" },
            });
          } });
          const connection = await connectPluginMcpServer(remoteServer, undefined, createHostAbortController().signal, { fetchImpl });
          t.after(() => connection.close());
          const pending = connection.listResources!(templates, undefined, controller.signal);
          const rejected = assert.rejects(pending, failure === "abort"
            ? (error: unknown) => error === reason : PluginMcpConnectionError);
          try {
            await dispatched;
            if (failure === "abort") controller.abort(reason);
            await rejected;
          } finally { release(); }
        });
      }
    });
  }
});

test("remote MCP rejects oversized JSON and SSE before accepting tool definitions", async (t) => {
  const largeDescription = "x".repeat(4 * 1024 * 1024 + 1024);
  for (const format of ["json", "sse"] as const) {
    await t.test(format, async (t) => {
      let streamCancelled = false;
      const fetchImpl = remoteFetch({ listResponse(id) {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{
          name: "large", description: largeDescription, inputSchema: { type: "object" },
        }] } });
        return format === "json"
          ? new Response(payload, { headers: { "content-type": "application/json" } })
          : new Response(new ReadableStream<Uint8Array>({
              start(controller) { controller.enqueue(Buffer.from(`data: ${payload}\n\n`)); },
              cancel() { streamCancelled = true; },
            }), { headers: { "content-type": "text/event-stream" } });
      } });
      const connection = await connectPluginMcpServer(remoteServer, { pluginRoot: "/tmp", pluginData: "/tmp" },
        createHostAbortController().signal, { fetchImpl });
      t.after(() => connection.close());
      const controller = createHostAbortController();
      const timer = format === "sse" ? setTimeout(() => controller.abort(), 500) : undefined;
      try {
        await assert.rejects(connection.listTools(controller.signal), PluginMcpConnectionError);
        if (format === "sse") assert.equal(streamCancelled, true);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }
});

test("persistent remote MCP GET accepts many bounded SSE events beyond 4 MiB total", async () => {
  const event = Buffer.from(`data: ${JSON.stringify({
    jsonrpc: "2.0", method: "notifications/message",
    params: { level: "info", data: "x".repeat(256 * 1024) },
  })}\r\n\r\n`);
  const pieces = [event.subarray(0, -2), event.subarray(-2, -1), event.subarray(-1)];
  let getCalls = 0;
  let firstStreamSent = 0;
  let cancelled = false;
  const fetchImpl = remoteFetch({ getResponse() {
    getCalls += 1;
    let streamSent = 0;
    let pieceIndex = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (streamSent < 20) {
          controller.enqueue(pieces[pieceIndex % pieces.length]!);
          pieceIndex += 1;
          if (pieceIndex % pieces.length === 0) {
            streamSent += 1;
            if (getCalls === 1) firstStreamSent = streamSent;
          }
        }
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  } });
  const connection = await connectPluginMcpServer(remoteServer, { pluginRoot: "/tmp", pluginData: "/tmp" },
    createHostAbortController().signal, { fetchImpl });
  try {
    const deadline = Date.now() + 2_000;
    while (firstStreamSent < 20 && getCalls === 1 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(firstStreamSent, 20);
    assert.equal(getCalls, 1);
    assert.equal(cancelled, false);
  } finally {
    await connection.close();
  }
});

test("remote MCP DELETE text remains whole-response bounded even with an SSE content type", async () => {
  let cancelledBeforeAbort = false;
  const frame = Buffer.from(`: ${"x".repeat(64 * 1024)}\n\n`);
  const fetchImpl = remoteFetch({ terminate(signal) {
    let sent = 0;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    signal?.addEventListener("abort", () => streamController?.error(new Error("closed")), { once: true });
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull(controller) {
        if (sent < 80) {
          sent += 1;
          controller.enqueue(frame);
        }
      },
      cancel() { cancelledBeforeAbort = signal?.aborted === false; },
    }), { headers: { "content-type": "text/event-stream" } }));
  } });
  const connection = await connectPluginMcpServer(remoteServer, { pluginRoot: "/tmp", pluginData: "/tmp" },
    createHostAbortController().signal, { fetchImpl });
  await connection.close();
  assert.equal(cancelledBeforeAbort, true);
});

test("remote MCP close is bounded when session termination stalls and still closes the client", async () => {
  let deleteSignal: AbortSignal | null | undefined;
  const fetchImpl = remoteFetch({ terminate(signal) {
    deleteSignal = signal;
    return new Promise<Response>(() => undefined);
  } });
  const connection = await connectPluginMcpServer(remoteServer, { pluginRoot: "/tmp", pluginData: "/tmp" },
    createHostAbortController().signal, { fetchImpl });
  assert.deepEqual(await connection.listTools(createHostAbortController().signal), []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      connection.close().then(() => "closed"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("stalled"), 1_800); }),
    ]);
    assert.equal(outcome, "closed");
    assert.equal(deleteSignal?.aborted, true);
  } finally {
    if (timer) clearTimeout(timer);
  }
});
