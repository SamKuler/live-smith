import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { NetworkProxyError } from "./network-proxy-error.js";
import {
  fetchWithNetworkRoute,
} from "./undici-network-fetch.js";

test("the bundled fetch keeps direct and proxy routes isolated", async (t) => {
  let redirectUrl = "";
  const origin = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: redirectUrl });
      response.end();
      return;
    }
    if (request.url === "/truncated") {
      response.writeHead(200, { "content-length": "8" });
      response.flushHeaders();
      response.write("x");
      setTimeout(() => response.destroy(), 5);
      return;
    }
    response.end(`${request.method}:${request.headers["x-probe"] ?? ""}`);
  });
  const redirectTarget = createServer((_request, response) => {
    response.end("redirected");
  });
  const proxy = createServer();
  const proxyTargets: string[] = [];
  const proxySockets = new Set<ReturnType<typeof connect>>();
  proxy.on("connect", (request, clientSocket, head) => {
    const target = new URL(`http://${request.url}`);
    proxyTargets.push(target.host);
    const targetSocket = connect(Number(target.port), target.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
    proxySockets.add(targetSocket);
    targetSocket.once("close", () => proxySockets.delete(targetSocket));
  });
  await Promise.all([
    new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) =>
      redirectTarget.listen(0, "127.0.0.1", resolve)
    ),
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(() => {
    origin.closeAllConnections();
    redirectTarget.closeAllConnections();
    proxy.closeAllConnections();
    for (const socket of proxySockets) socket.destroy();
    origin.close();
    redirectTarget.close();
    proxy.close();
  });
  const originAddress = origin.address();
  const proxyAddress = proxy.address();
  const redirectAddress = redirectTarget.address();
  assert.ok(originAddress && typeof originAddress === "object");
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  assert.ok(redirectAddress && typeof redirectAddress === "object");
  const originUrl = `http://127.0.0.1:${originAddress.port}/probe`;
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  redirectUrl = `http://127.0.0.1:${redirectAddress.port}/final`;

  const request = new Request(originUrl, {
    method: "POST",
    headers: { "x-probe": "request" },
    body: "payload",
  });
  assert.equal(
    await (await fetchWithNetworkRoute(request, undefined, "direct", () => null))
      .text(),
    "POST:request",
  );
  const inheritedMethod = new Request(originUrl, {
    method: "POST",
    headers: { "x-probe": "undefined-init" },
    body: "payload",
  });
  // JavaScript callers can provide explicit undefined dictionary members even
  // though exactOptionalPropertyTypes excludes that shape at compile time.
  const undefinedMethodInit = { method: undefined } as unknown as RequestInit;
  assert.equal(
    await (await fetchWithNetworkRoute(
      inheritedMethod,
      undefinedMethodInit,
      "direct",
      () => null,
    )).text(),
    "POST:undefined-init",
  );

  const omittedController = new AbortController();
  const omittedSignal = new Request(originUrl, {
    signal: omittedController.signal,
  });
  omittedController.abort(new Error("cancel omitted signal"));
  await assert.rejects(
    fetchWithNetworkRoute(omittedSignal, undefined, "direct", () => null),
  );

  const undefinedController = new AbortController();
  const undefinedSignal = new Request(originUrl, {
    signal: undefinedController.signal,
  });
  undefinedController.abort(new Error("cancel undefined signal"));
  const undefinedSignalInit = { signal: undefined } as unknown as RequestInit;
  await assert.rejects(
    fetchWithNetworkRoute(
      undefinedSignal,
      undefinedSignalInit,
      "direct",
      () => null,
    ),
  );

  const nullController = new AbortController();
  const nullSignal = new Request(originUrl, {
    signal: nullController.signal,
  });
  nullController.abort(new Error("detached signal"));
  assert.equal(
    await (await fetchWithNetworkRoute(
      nullSignal,
      { signal: null },
      "direct",
      () => null,
    )).text(),
    "GET:",
  );
  assert.equal(
    await (await fetchWithNetworkRoute(
      originUrl,
      undefined,
      `proxy:${proxyUrl}`,
      () => proxyUrl,
    )).text(),
    "GET:",
  );
  assert.deepEqual(proxyTargets, [`127.0.0.1:${originAddress.port}`]);
  const truncated = await fetchWithNetworkRoute(
    `http://127.0.0.1:${originAddress.port}/truncated`,
    undefined,
    `proxy:${proxyUrl}:truncated`,
    () => proxyUrl,
    "The Manual proxy could not be reached.",
  );
  await assert.rejects(
    truncated.text(),
    (error: unknown) => {
      assert.equal(error instanceof NetworkProxyError, false);
      return true;
    },
  );
  const selectedOrigins: string[] = [];
  assert.equal(
    await (await fetchWithNetworkRoute(
      `http://127.0.0.1:${originAddress.port}/redirect`,
      undefined,
      "redirect-routing",
      (target) => {
        selectedOrigins.push(target.host);
        return null;
      },
    )).text(),
    "redirected",
  );
  assert.deepEqual(selectedOrigins, [
    `127.0.0.1:${originAddress.port}`,
    `127.0.0.1:${redirectAddress.port}`,
  ]);
});

test("only pre-response ProxyAgent failures become safe proxy errors", async (t) => {
  let resolveConnect!: () => void;
  const connected = new Promise<void>((resolve) => {
    resolveConnect = resolve;
  });
  const sockets = new Set<import("node:stream").Duplex>();
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    resolveConnect();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const unavailableProxy = createServer();
  await new Promise<void>((resolve) =>
    unavailableProxy.listen(0, "127.0.0.1", resolve)
  );
  const unavailableAddress = unavailableProxy.address();
  assert.ok(unavailableAddress && typeof unavailableAddress === "object");
  await new Promise<void>((resolve, reject) =>
    unavailableProxy.close((error) => error ? reject(error) : resolve())
  );
  const unavailableProxyUrl =
    `http://127.0.0.1:${unavailableAddress.port}`;
  const messages = [
    "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
    "The system proxy could not reach the provider. Check operating system proxy settings or choose another proxy mode.",
  ];

  for (const [index, message] of messages.entries()) {
    await assert.rejects(
      fetchWithNetworkRoute(
        "https://provider.example/request",
        undefined,
        `failed-proxy-${index}`,
        () => unavailableProxyUrl,
        message,
      ),
      (error: unknown) => {
        assert.ok(error instanceof NetworkProxyError);
        assert.equal(error.message, message);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /127\.0\.0\.1|provider\.example/u);
        return true;
      },
    );
  }

  await assert.rejects(
    fetchWithNetworkRoute(
      `http://127.0.0.1:${unavailableAddress.port}/direct`,
      undefined,
      "direct-bypass-failure",
      () => null,
      messages[0],
    ),
    (error: unknown) => {
      assert.equal(error instanceof NetworkProxyError, false);
      return true;
    },
  );

  const controller = new AbortController();
  const reason = new Error("stop proxied request");
  const pending = fetchWithNetworkRoute(
    "https://provider.example/pending",
    { signal: controller.signal },
    "aborted-proxy-request",
    () => proxyUrl,
    messages[0],
  );
  await connected;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});
