import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process, { execPath } from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import test from "node:test";

import { createHostAbortController, resolveFetchImplementation } from "../../../src/runtime/host.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { createChatBridge } from "../../../src/app/chat/chat-bridge.js";
import { createPluginAppSessions } from "../../../src/app/plugins/plugin-apps.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { SessionMutationFence, sessionMutationFenceKey } from "../../../src/app/session/session-mutation-fence.js";

const resourceUri = "ui://cancel-fixture/app";
const serverSource = String.raw`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const uri = "ui://cancel-fixture/app";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (existsSync(process.env.GATE_PATH) && readFileSync(process.env.GATE_PATH, "utf8") === request.method) {
    writeFileSync(path.join(process.env.PENDING_DIRECTORY, String(process.pid)), request.method);
    return;
  }
  if (request.method === "server/discover") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Legacy server." } }) + "\n");
  } else if (request.method === "initialize") {
    send(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "cancel-fixture", version: "1" } });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{ name: "entry", description: "Local cancellation fixture",
      inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: uri } } }] });
  } else if (request.method === "resources/read") {
    send(request.id, { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<p>Local App</p>" }] });
  }
});
`;

async function waitFor(condition: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await setTimeout(10);
  }
}

for (const stage of ["server/discover", "tools/list", "resources/read"] as const) for (const cancellation of ["disconnect", "close"] as const) {
  test(`HTTP App opening ${cancellation} releases a pending ${stage} process and its capacity`, { timeout: 15_000 }, async (t) => {
    const directory = await fs.mkdtemp("/private/tmp/live-smith-app-cancellation-");
    const pendingDirectory = path.join(directory, "pending");
    const gatePath = path.join(directory, "gate");
    const serverPath = path.join(directory, "server.mjs");
    await fs.mkdir(pendingDirectory);
    await fs.writeFile(serverPath, serverSource);
    const fetchImpl = resolveFetchImplementation();
    const controllers: ReturnType<typeof createHostAbortController>[] = [];
    const fence = new SessionMutationFence();
    const withAuthorization = <T>(signal: AbortSignal, operation: () => Promise<T>) =>
      fence.run(sessionMutationFenceKey(directory, "request-configuration"), signal, operation);
    const session = await createSession(directory, { title: "App cancellation", projectKey: "fixture", scope: {
      kind: "selection", identity: "fixture", label: "Fixture",
    } });
    await saveGlobalSettings(directory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
      id: "cancel-fixture", name: "Local fixture", enabled: true,
      mcp: { type: "stdio", command: execPath, args: [serverPath] },
      secrets: { GATE_PATH: gatePath, PENDING_DIRECTORY: pendingDirectory },
      artifactInputApproved: false, artifactOutputApproved: false,
    } } });
    const discovery = await createRequestPluginTools({ storageDirectory: directory, sessionId: session.id,
      signal: createHostAbortController().signal, withAuthorization });
    const descriptor = discovery.catalogTools()[0]!.app!;
    await discovery.close();
    const apps = createPluginAppSessions({ storageDirectory: directory, fetchImpl, withAuthorization,
      async validateSession(sessionId) { assert.equal(sessionId, session.id); },
      async mutateSession(_sessionId, _signal, operation) { return operation(); },
      sessionChanged() {},
    });
    const state = { status: "Ready" } as ChatDialogState;
    let settledOpens = 0;
    const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "<html></html>",
      handleCommand: async () => state, handleSend: async () => {}, closePluginApps: () => apps.close(),
      async handlePluginAppRequest(request, signal) {
        try { return await apps.request(request, signal); }
        finally { if (request.operation === "open") settledOpens += 1; }
      },
    });
    t.after(async () => {
      for (const controller of controllers) controller.abort();
      await bridge.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const post = (operation: string, body: unknown, signal?: AbortSignal) => {
      const url = new URL(bridge.url);
      url.pathname = `/plugin-apps/${operation}`;
      return fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    };
    const input = { sessionId: session.id, toolName: descriptor.toolName, signature: descriptor.signature };
    await fs.writeFile(gatePath, stage);
    const seenProcesses = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = createHostAbortController();
      const id = randomUUID();
      controllers.push(controller);
      const pending = post("open", { id, ...input }, controller.signal).then((response) => ({ response }), (error: unknown) => ({ error }));
      await waitFor(async () => {
        const names = await fs.readdir(pendingDirectory);
        const next = names.find((entry) => !seenProcesses.has(entry));
        return names.length === attempt + 1 && next !== undefined &&
          await fs.readFile(path.join(pendingDirectory, next), "utf8") === stage;
      }, "The App did not publish its complete pending MCP request marker.");
      const processId = (await fs.readdir(pendingDirectory)).find((entry) => !seenProcesses.has(entry))!;
      seenProcesses.add(processId);
      assert.equal(await fs.readFile(path.join(pendingDirectory, processId), "utf8"), stage);
      const reason = new Error("App opening cancelled.");
      if (cancellation === "disconnect") controller.abort(reason);
      else {
        const response = await post("close", { id });
        assert.equal(response.status, 200);
        await response.json();
      }
      const outcome = await pending;
      if (cancellation === "disconnect") {
        assert.ok("error" in outcome);
        assert.equal(outcome.error, reason);
      } else {
        assert.ok("response" in outcome);
        assert.notEqual(outcome.response.status, 200);
        await outcome.response.json();
      }
      await waitFor(async () => {
        try { process.kill(Number(processId), 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
      }, "The cancelled App retained its MCP process.");
      await waitFor(async () => settledOpens === attempt + 1, "The cancelled App retained its opening handler.");
    }
    await fs.rm(gatePath);
    const reopened = await post("open", { id: randomUUID(), ...input });
    assert.equal(reopened.status, 200, "Four cancelled opens must not consume the App capacity.");
    const body = await reopened.json() as { id: string; html: string };
    assert.equal(body.html, "<p>Local App</p>");
    const resource = await post("resource", { id: body.id, uri: resourceUri });
    assert.equal(resource.status, 200, "A completed open must retain its connection after its HTTP response closes.");
    await resource.json();
    const closed = await post("close", { id: body.id });
    assert.equal(closed.status, 200);
    await closed.json();
    assert.deepEqual(await loadSessionEvents(directory, session.id), []);
  });
}
