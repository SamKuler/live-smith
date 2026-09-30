import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";
import process, { execPath } from "node:process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createHostAbortController, resolveFetchImplementation } from "../../runtime/host.js";
import { connectPluginMcpServer, type ConnectedPluginMcpServer } from "./client.js";
import type { PluginMcpRemoteServer, PluginMcpStdioServer } from "./config.js";

type Era = "legacy" | "modern" | "exit-on-probe";
type ConnectMethod = "server/discover" | "initialize";
type RequestRecord = { pid: number; method: string };

const stdioSource = String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id,
  result: { ...(process.env.ERA === "modern" ? { resultType: "complete" } : {}), ...result } }) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ pid: process.pid, method: request.method }) + "\n");
  if (request.method === process.env.BLOCK_METHOD) return;
  if (request.method === "server/discover") {
    if (process.env.ERA === "exit-on-probe") process.exit(0);
    if (process.env.ERA === "modern") send(request.id, {
      supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private",
    });
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Legacy server." } }) + "\n");
  } else if (request.method === "initialize") {
    send(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "lifecycle-fixture", version: "1" } });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{ name: "echo", inputSchema: { type: "object" } }], ttlMs: 0, cacheScope: "private" });
  } else if (request.method === "tools/call") {
    send(request.id, { content: [{ type: "text", text: "retained connection" }] });
  }
});
`;

async function waitFor(condition: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await setTimeout(10);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stdioFixture(era: Era, blockMethod?: ConnectMethod) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mcp-lifecycle-");
  const entry = path.join(directory, "server.mjs");
  const log = path.join(directory, "requests.jsonl");
  await fs.writeFile(entry, stdioSource);
  await fs.writeFile(log, "");
  const records = async (): Promise<RequestRecord[]> => (await fs.readFile(log, "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as RequestRecord);
  const server: PluginMcpStdioServer = { id: "lifecycle-fixture", type: "stdio", command: execPath, args: [entry],
    env: { REQUEST_LOG: log, ERA: era, ...(blockMethod ? { BLOCK_METHOD: blockMethod } : {}) } };
  return {
    server, records,
    async stopProcesses() {
      for (const pid of new Set((await records()).map((record) => record.pid))) {
        if (isAlive(pid)) process.kill(pid, "SIGTERM");
      }
    },
    remove: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

for (const stage of ["server/discover", "initialize"] as const) {
  test(`stdio cancellation during ${stage} settles after reaping every connection process`, async (t) => {
    const fixture = await stdioFixture("legacy", stage);
    const controller = createHostAbortController();
    const reason = new Error("Connection cancelled.");
    let settled = false;
    const pending = connectPluginMcpServer(fixture.server, undefined, controller.signal)
      .then((connection) => ({ connection }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    t.after(async () => {
      controller.abort(reason);
      await fixture.stopProcesses();
      const outcome = await pending;
      if ("connection" in outcome) await outcome.connection.close();
      await fixture.remove();
    });
    await waitFor(async () => (await fixture.records()).some((record) => record.method === stage), "Connection did not dispatch its handshake.");
    const blocked = (await fixture.records()).find((record) => record.method === stage)!;
    assert.equal(isAlive(blocked.pid), true);
    controller.abort(reason);
    await waitFor(() => settled, "Cancelled connection kept waiting for the probe timeout.");
    const outcome = await pending;
    assert.ok("error" in outcome);
    assert.equal(outcome.error, reason);
    for (const pid of new Set((await fixture.records()).map((record) => record.pid))) {
      assert.equal(isAlive(pid), false, "Connection cannot settle while a cancelled child remains alive.");
    }
    if (stage === "server/discover") {
      assert.deepEqual((await fixture.records()).map((record) => record.method), [stage], "Cancellation cannot start the retained session process.");
    }
  });
}

test("stdio automatic negotiation preserves disposable probes and retained connection ownership", async (t) => {
  for (const era of ["modern", "legacy", "exit-on-probe"] as const) {
    await t.test(era, async (t) => {
      const fixture = await stdioFixture(era);
      const controller = createHostAbortController();
      let connection: ConnectedPluginMcpServer | undefined;
      t.after(async () => { await connection?.close(); await fixture.stopProcesses(); await fixture.remove(); });
      connection = await connectPluginMcpServer(fixture.server, undefined, controller.signal);
      controller.abort(new Error("Opening request finished."));
      const signal = createHostAbortController().signal;
      assert.deepEqual((await connection.listTools(signal)).map((tool) => tool.name), ["echo"]);
      assert.deepEqual((await connection.callTool("echo", {}, signal)).content, [{ type: "text", text: "retained connection" }]);
      const records = await fixture.records();
      const probePid = records.find((record) => record.method === "server/discover")!.pid;
      const sessionPid = records.find((record) => record.method === "tools/list")!.pid;
      assert.notEqual(probePid, sessionPid);
      assert.equal(isAlive(probePid), false);
      assert.equal(isAlive(sessionPid), true);
      assert.equal(records.some((record) => record.method === "initialize"), era !== "modern");
      await connection.close();
      await waitFor(() => !isAlive(sessionPid), "Closing the owner did not release its session process.");
    });
  }
});

async function remoteFixture(era: Exclude<Era, "exit-on-probe">, blockMethod?: ConnectMethod) {
  const methods: string[] = [];
  let blocked = false;
  let blockedClosed = false;
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "GET" ? 405 : 200).end();
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method: string };
    methods.push(message.method);
    if (message.method === blockMethod) {
      blocked = true;
      response.on("close", () => { blockedClosed = true; });
      return;
    }
    const reply = (result: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(200, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { ...(era === "modern" ? { resultType: "complete" } : {}), ...result as object } }));
    };
    if (message.method === "server/discover") {
      if (era === "modern") reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private" });
      else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy server." } }));
      }
    } else if (message.method === "initialize") reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "lifecycle-fixture", version: "1" } }, { "mcp-session-id": "lifecycle-fixture" });
    else if (message.method === "tools/list") reply({ tools: [], ttlMs: 0, cacheScope: "private" });
    else response.writeHead(202).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const server: PluginMcpRemoteServer = { id: "remote-fixture", type: "streamable-http",
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {} };
  return {
    server, methods, isBlocked: () => blocked, isBlockedClosed: () => blockedClosed,
    close: () => new Promise<void>((resolve, reject) => {
      http.closeAllConnections();
      http.close((error) => error ? reject(error) : resolve());
    }),
  };
}

for (const stage of ["server/discover", "initialize"] as const) {
  test(`remote cancellation during ${stage} settles promptly and closes its actual HTTP request`, async (t) => {
    const fixture = await remoteFixture("legacy", stage);
    const controller = createHostAbortController();
    const reason = new Error("Remote connection cancelled.");
    let settled = false;
    const pending = connectPluginMcpServer(fixture.server, undefined, controller.signal, { fetchImpl: resolveFetchImplementation() })
      .then((connection) => ({ connection }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    t.after(async () => {
      controller.abort(reason);
      await fixture.close();
      const outcome = await pending;
      if ("connection" in outcome) await outcome.connection.close();
    });
    await waitFor(fixture.isBlocked, "Connection did not dispatch its handshake.");
    controller.abort(reason);
    await waitFor(() => settled, "Cancelled connection kept waiting for the probe timeout.");
    const outcome = await pending;
    assert.ok("error" in outcome);
    assert.equal(outcome.error, reason);
    await waitFor(fixture.isBlockedClosed, "Cancellation left its HTTP request open.");
    if (stage === "server/discover") assert.deepEqual(fixture.methods, [stage]);
  });
}

test("remote automatic negotiation keeps successful connections independent of the opening signal", async (t) => {
  for (const era of ["modern", "legacy"] as const) {
    await t.test(era, async (t) => {
      const fixture = await remoteFixture(era);
      let connection: ConnectedPluginMcpServer | undefined;
      t.after(async () => { await connection?.close(); await fixture.close(); });
      const controller = createHostAbortController();
      connection = await connectPluginMcpServer(fixture.server, undefined, controller.signal, { fetchImpl: resolveFetchImplementation() });
      controller.abort(new Error("Opening request finished."));
      assert.deepEqual(await connection.listTools(createHostAbortController().signal), []);
      assert.equal(fixture.methods.includes("initialize"), era === "legacy");
      assert.equal(fixture.methods[0], "server/discover");
    });
  }
});
