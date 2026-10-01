import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import { URL } from "node:url";

import { createHostAbortController, resolveFetchImplementation } from "../../../../src/runtime/host.js";

/** Forwards a real App open, then holds its HTTP body incomplete until the client disconnects. */
export async function createOpenResponseRelay(t: TestContext, target: URL) {
  const held = deferred<{ body: Record<string, unknown>; sentBytes: number; totalBytes: number }>();
  const clientClosed = deferred<void>();
  const fetchImpl = resolveFetchImplementation();
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const forwarding = new Set<Promise<void>>();
  let heldResponse: ServerResponse | undefined;
  let closing: Promise<void> | undefined;

  const forward = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = createHostAbortController();
    controllers.add(controller);
    response.once("close", () => { controller.abort(); clientClosed.resolve(); });
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetchImpl(target, {
        method: request.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      assert.ok(bytes.byteLength > 1, "The real open must return a JSON response body.");
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Content-Length": String(bytes.byteLength),
        Connection: "close",
      });
      // One byte permits fetch to resolve headers while JSON parsing still requires the withheld tail.
      response.write(bytes.subarray(0, 1));
      heldResponse = response;
      held.resolve({ body, sentBytes: 1, totalBytes: bytes.byteLength });
    } catch (error) {
      held.reject(error);
      response.destroy();
    } finally {
      controllers.delete(controller);
    }
  };
  const server = createServer((request, response) => {
    const running = forward(request, response);
    forwarding.add(running);
    void running.then(() => forwarding.delete(running), () => forwarding.delete(running));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      held.reject(new Error("The response relay closed before forwarding its body."));
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        ...forwarding,
        new Promise<void>((resolve, reject) => {
          if (!server.listening) { resolve(); return; }
          server.close((error) => error ? reject(error) : resolve());
        }),
      ]);
      clientClosed.resolve();
    })();
    return closing;
  };
  t.after(close);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url,
    held: held.promise,
    clientClosed: clientClosed.promise,
    isBodyHeld: () => !!heldResponse && !heldResponse.destroyed && !heldResponse.writableFinished,
    close,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // Cleanup can reject readiness before the caller reaches its await.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
