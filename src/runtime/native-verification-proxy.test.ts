import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { connect, createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createHostAbortController } from "./host.js";
import { createNativeVerificationDirectProxy } from "./native-verification-proxy.js";

test("direct verification routing requires its private credentials and only tunnels official HTTPS hosts", async (t) => {
  const upstream = createServer(socket => socket.pipe(socket));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const controller = createHostAbortController();
  const targets: unknown[] = [];
  const route = await createNativeVerificationDirectProxy(controller.signal, ((options: unknown) => {
    targets.push(options);
    return connect(address.port, "127.0.0.1");
  }) as typeof connect);
  t.after(() => route.close());
  const port = Number(new URL(route.url).port);
  const authorization = Buffer.from(`${route.username}:${route.password}`).toString("base64");
  async function request(target: string, credentials: string) {
    const socket = connect(port, "127.0.0.1");
    socket.write(`CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`);
    return socket;
  }
  const unauthenticated = await request("suno.com:443", "incorrect");
  const [denied] = await once(unauthenticated, "data");
  assert.match(String(denied), /^HTTP\/1.1 407/u);
  unauthenticated.destroy();
  assert.equal(targets.length, 0);
  for (const target of ["127.0.0.1:443", "suno.com.evil.test:443", "suno.com:80"]) {
    const socket = await request(target, authorization);
    await once(socket, "close");
  }
  assert.equal(targets.length, 0);
  const allowed = await request("suno.com:443", authorization);
  const [accepted] = await once(allowed, "data");
  assert.match(String(accepted), /^HTTP\/1.1 200/u);
  allowed.write("opaque-TLS-fixture");
  const [echo] = await once(allowed, "data");
  assert.equal(String(echo), "opaque-TLS-fixture");
  assert.deepEqual(targets, [{ host: "suno.com", port: 443 }]);
  const closed = once(allowed, "close");
  controller.abort();
  await closed;
  await route.close();
});
