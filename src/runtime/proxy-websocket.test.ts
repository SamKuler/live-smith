import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import test from "node:test";
import { URL } from "node:url";

import { WebSocketServer } from "ws";

import { createHostAbortController } from "./host.js";
import { resolveNetworkRoute } from "./proxy-fetch.js";
import { createProxyAwareWebSocket } from "./proxy-websocket.js";

test("proxy-aware WebSocket exchanges bounded text over a loopback-bypassed route", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const received = Promise.withResolvers<string>();
  server.once("connection", (socket, request) => {
    assert.equal(request.headers["x-test-auth"], "fixture-header-only");
    socket.once("message", (data, binary) => {
      assert.equal(binary, false);
      received.resolve(data.toString());
      socket.send(JSON.stringify({ setupComplete: {} }));
    });
  });

  const open = createProxyAwareWebSocket(async () => ({ mode: "manual", url: "http://127.0.0.1:1" }));
  const controller = createHostAbortController();
  const connection = await open(`ws://127.0.0.1:${address.port}/music`, {
    headers: { "x-test-auth": "fixture-header-only" },
    signal: controller.signal,
    handshakeTimeoutMs: 2_000,
    maximumMessageBytes: 1024,
  });
  await connection.sendText(JSON.stringify({ setup: { model: "models/test" } }));
  assert.equal(await received.promise, JSON.stringify({ setup: { model: "models/test" } }));
  assert.equal(await connection.receiveText(controller.signal), JSON.stringify({ setupComplete: {} }));
  await connection.close();
});

test("the shared route resolver applies HTTPS proxy and bypass rules to WSS targets", async () => {
  const manual = await resolveNetworkRoute(async () => ({ mode: "manual", url: "http://proxy.example:8080" }));
  assert.equal(manual.selectProxy(new URL("wss://generativelanguage.googleapis.com/ws")), "http://proxy.example:8080");
  assert.equal(manual.selectProxy(new URL("ws://127.0.0.1:3000/ws")), null);

  const system = await resolveNetworkRoute(async () => ({ mode: "system", url: "" }), undefined, {
    readSystemProxy: async () => ({
      httpsProxy: "http://secure-proxy.example:8443",
      socksProxy: "socks5://fallback.example:1080",
      noProxy: ["bypass.example"],
    }),
  });
  assert.equal(system.selectProxy(new URL("wss://provider.example/ws")), "http://secure-proxy.example:8443");
  assert.equal(system.selectProxy(new URL("wss://bypass.example/ws")), null);
});

test("WebSocket cancellation and invalid frames close the owned socket without exposing payloads", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.on("connection", (socket, request) => {
    if (request.url === "/binary") socket.send(Buffer.from("raw-secret-binary"), { binary: true });
  });
  const controller = createHostAbortController();
  const connection = await createProxyAwareWebSocket(async () => ({ mode: "none", url: "" }))(
    `ws://127.0.0.1:${address.port}/binary`,
    { headers: {}, signal: controller.signal, handshakeTimeoutMs: 2_000, maximumMessageBytes: 1024 },
  );
  await assert.rejects(connection.receiveText(controller.signal), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid message|closed/);
    assert.doesNotMatch(error.message, /raw-secret/);
    return true;
  });
  connection.terminate();

  const waitingController = createHostAbortController();
  const waiting = await createProxyAwareWebSocket(async () => ({ mode: "none", url: "" }))(
    `ws://127.0.0.1:${address.port}/idle`,
    { headers: {}, signal: waitingController.signal, handshakeTimeoutMs: 2_000, maximumMessageBytes: 1024 },
  );
  const receive = waiting.receiveText(waitingController.signal);
  waitingController.abort(new Error("cancelled while waiting"));
  await assert.rejects(receive, /cancelled while waiting|connection closed/);

  const aborted = createHostAbortController();
  aborted.abort(new Error("cancelled by caller"));
  await assert.rejects(createProxyAwareWebSocket(async () => ({ mode: "none", url: "" }))(
    `ws://127.0.0.1:${address.port}`,
    { headers: {}, signal: aborted.signal, handshakeTimeoutMs: 2_000, maximumMessageBytes: 1024 },
  ), /cancelled by caller/);
});
