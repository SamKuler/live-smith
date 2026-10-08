import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { argv, stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { createHostAbortController } from "../../../src/runtime/host.js";
import { createProxyAwareWebSocket } from "../../../src/runtime/proxy-websocket.js";

const scenario = argv[2];
assert.ok(["abort", "http-rejection", "timeout"].includes(scenario ?? ""));
const controller = createHostAbortController();
const connections = new Set<Socket>();
const server = createServer((_request, response) => {
  response.writeHead(403);
  response.end("fixture-private-response");
});
server.on("connection", (socket) => {
  connections.add(socket);
  socket.once("close", () => connections.delete(socket));
});
if (scenario !== "http-rejection") {
  server.once("upgrade", (_request, socket) => {
    socket.resume();
    if (scenario === "abort") controller.abort(new Error("fixture stop"));
  });
}
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  await assert.rejects(createProxyAwareWebSocket(async () => ({ mode: "none", url: "" }))(
    `ws://127.0.0.1:${address.port}/opening`,
    { headers: {}, signal: controller.signal,
      handshakeTimeoutMs: scenario === "timeout" ? 100 : 2_000, maximumMessageBytes: 1024 },
  ), scenario === "abort" ? /fixture stop/ : /^Error: WebSocket connection failed\.$/);
  // CONNECTING termination reports its socket error on a later event-loop turn.
  await delay(25);
} finally {
  for (const socket of connections) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
stdout.write("opening rejected and transport closed\n");
