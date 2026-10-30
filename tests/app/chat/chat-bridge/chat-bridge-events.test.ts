import { openBridgeEvents, readEvent } from "../support/bridge-events.js";
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { type ClientOptions } from "ws";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

for (const scenario of ["command", "send"] as const) {
  test(`WebSocket delivers a large ${scenario} publication and subsequent frames over a real socket`, { timeout: 5000 }, async () => {
    const content = "x".repeat(128 * 1024);
    const state = { events: [{ id: "history", kind: "assistant", content, createdAt: "2026-10-07T00:00:00.000Z" }] } as ChatDialogState;
    const bridge = await createChatBridge({
      buildState: async () => state, renderHtml: () => "", handleCommand: async () => state,
      handleSend: async (_input, stream) => {
        await stream.assistantDelta(content);
        await stream.progress("After the large frame");
        return state;
      },
    });
    const url = new URL(bridge.url);
    const endpoint = (path: string) => `${url.origin}${path}${url.search}`;
    const response = await openBridgeEvents(endpoint("/events"));
    const events: Array<Record<string, any>> = [];
    const received = (async () => {
      while (!events.some(event => event.type === "session_state_invalidated")) {
        events.push(await response.next());
      }
    })();
    // Attach rejection handling before issuing the request that used to destroy the socket.
    const result = received.then(() => null, error => error);
    try {
      const http = await fetch(endpoint(`/${scenario}`), {
        method: "POST",
        headers: { "Content-Type": "application/json", [scenario === "send" ? "X-Live-Smith-Send-Id" : "X-Live-Smith-Command-Id"]: "large-publication" },
        body: JSON.stringify(scenario === "send" ? { prompt: "Test", sessionId: "session-1" } : { kind: "select_session", sessionId: "session-1" }),
      });
      assert.equal(http.status, 200); await http.json();
      bridge.publishSessionStateInvalidation("session-1");
      assert.equal(await result, null);
      if (scenario === "command") {
        assert.deepEqual(events.map(event => event.type), ["command_activity", "state", "command_activity", "session_state_invalidated"]);
        assert.equal(events[1]!.state.events[0].content, content);
        assert.equal(events[2]!.command, null);
      } else {
        assert.deepEqual(events[0], { type: "send_activity", sendId: "large-publication", sessionId: "session-1",
          activity: { status: "running", message: "Starting agent loop" }, bridgeStateRevision: "1" });
        assert.equal(events.find(event => event.type === "assistant_delta")?.delta, content);
        assert.ok(events.some(event => event.type === "progress"));
        assert.ok(events.some(event => event.type === "done"));
      }
    } finally { await response.close(); await bridge.close(); }
  });
}

test("ten event connections leave a six-socket HTTP pool available for discovery, Send and Stop", { timeout: 5000 }, async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 6 });
  const started = Promise.withResolvers<void>();
  let stopped = false;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state, renderHtml: () => "", handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        stopped = true;
        resolve();
      }, { once: true }));
      return state;
    },
  });
  const endpoint = (path: string) => { const url = new URL(bridge.url); url.pathname = path; return url; };
  const post = (path: string, body: unknown, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const http = request(endpoint(path), { agent, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode!));
    });
    http.once("error", reject);
    http.end(JSON.stringify(body));
  });
  const clients = [];
  try {
    clients.push(...await Promise.all(Array.from({ length: 10 }, () => openBridgeEvents(endpoint("/events"), { agent }))));
    assert.equal(await post("/session-tools", { kind: "load_session_tools", sessionId: "session-1" }, {
      "X-Live-Smith-Command-Id": "read-tools",
    }), 200);
    const send = post("/send", { prompt: "Continue", sessionId: "session-1" }, { "X-Live-Smith-Send-Id": "parallel-send" });
    await started.promise;
    assert.equal(await post("/stop", {}, { "X-Live-Smith-Send-Id": "parallel-send" }), 200);
    assert.equal(await send, 200);
    assert.equal(stopped, true);
    bridge.publishSessionStateInvalidation("session-1");
    const published = await Promise.all(clients.map(client => readEvent(client, "session_state_invalidated")));
    assert.equal(published.length, 10);
    assert.ok(published.every(event => event.sessionId === "session-1"));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await bridge.close();
    agent.destroy();
  }
});

test("event upgrades enforce the loopback Host, exact Origin, token and query contract", { timeout: 5000 }, async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "", handleCommand: async () => state, handleSend: async () => {} });
  const endpoint = new URL(bridge.url); endpoint.pathname = "/events";
  const rejected = (url: URL, options: ClientOptions = {}) => new Promise<number>((resolve, reject) => {
    const wsUrl = new URL(url); wsUrl.protocol = "ws:";
    const socket = new WebSocket(wsUrl, { origin: endpoint.origin, ...options });
    socket.on("error", () => {});
    socket.once("open", () => { socket.terminate(); reject(new Error("Unexpected accepted upgrade")); });
    socket.once("unexpected-response", (_request, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode!);
    });
  });
  try {
    assert.equal(await rejected(endpoint, { origin: "https://example.test" }), 403);
    assert.equal(await rejected(endpoint, { origin: undefined }), 403);
    assert.equal(await rejected(endpoint, { headers: { Host: "attacker.test" } }), 403);
    const missing = new URL(endpoint); missing.search = "";
    assert.equal(await rejected(missing), 403);
    const wrong = new URL(endpoint); wrong.searchParams.set("token", "wrong");
    assert.equal(await rejected(wrong), 403);
    for (const query of ["extra=1", "sessionId=session-1", "viewId=../escape", "viewId=first&viewId=second", `token=${endpoint.searchParams.get("token")}`]) {
      assert.equal(await rejected(new URL(`${endpoint}&${query}`)), 400);
    }
    assert.equal(await rejected(new URL(`${endpoint}&viewId=unregistered-view`)), 409);
    const plainHttp = await fetch(endpoint);
    assert.equal(plainHttp.status, 426);
    assert.equal(plainHttp.headers.get("upgrade"), "websocket");
  } finally { await bridge.close(); }
});

test("event channel rejects client messages and bridge shutdown closes upgraded sockets", { timeout: 5000 }, async () => {
  let commands = 0;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "", handleCommand: async () => { commands++; return state; }, handleSend: async () => {} });
  const endpoint = new URL(bridge.url); endpoint.pathname = "/events";
  const client = await openBridgeEvents(endpoint);
  try {
    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify({ kind: "new_session" }));
    assert.equal((await closed)[0], 1008);
    assert.equal(commands, 0);
    const next = await openBridgeEvents(endpoint);
    const ended = once(next.socket, "close");
    await bridge.close();
    await ended;
  } finally { await client.close(); await bridge.close(); }
});
