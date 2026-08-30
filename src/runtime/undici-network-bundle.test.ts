import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import * as vm from "node:vm";

import * as esbuild from "esbuild";

import { resolveFetchImplementation } from "./host.js";

test("the bundled network route works in Ableton's restricted VM", async (t) => {
  const requests: string[] = [];
  const origin = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(`${request.method}:${Buffer.concat(chunks).toString("utf8")}`);
      response.setHeader("connection", "close");
      response.end("ok");
    });
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
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(() => {
    origin.closeAllConnections();
    proxy.closeAllConnections();
    for (const socket of proxySockets) socket.destroy();
    origin.close();
    proxy.close();
  });

  const originAddress = origin.address();
  const proxyAddress = proxy.address();
  assert.ok(originAddress && typeof originAddress === "object");
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const originUrl = `http://127.0.0.1:${originAddress.port}/probe`;
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  const unavailableProxy = createServer();
  await new Promise<void>((resolve) =>
    unavailableProxy.listen(0, "127.0.0.1", resolve)
  );
  const unavailableAddress = unavailableProxy.address();
  assert.ok(unavailableAddress && typeof unavailableAddress === "object");
  await new Promise<void>((resolve, reject) =>
    unavailableProxy.close((error) => error ? reject(error) : resolve())
  );
  const unavailableProxyUrl = `http://127.0.0.1:${unavailableAddress.port}`;
  const build = await esbuild.build({
    entryPoints: ["src/runtime/undici-network-fetch.ts"],
    bundle: true,
    format: "cjs",
    inject: ["src/runtime/undici-node-globals.ts"],
    logLevel: "silent",
    platform: "node",
    write: false,
  });
  const source = build.outputFiles[0]?.text;
  assert.ok(source);
  const bundledModule: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(source, {
    AbortController,
    Buffer,
    clearInterval,
    clearTimeout,
    console,
    exports: bundledModule.exports,
    fetch: resolveFetchImplementation(),
    module: bundledModule,
    process,
    require: createRequire(import.meta.url),
    setInterval,
    setTimeout,
  });
  const fetchWithNetworkRoute = bundledModule.exports.fetchWithNetworkRoute as (
    input: string,
    init: RequestInit | undefined,
    routeKey: string,
    selectProxy: (target: URL) => string | null,
    proxyFailureMessage?: string,
  ) => Promise<Response>;
  assert.equal(typeof fetchWithNetworkRoute, "function");

  const direct = await fetchWithNetworkRoute(
    originUrl,
    { method: "POST", body: "direct" },
    "direct",
    () => null,
  );
  assert.equal(await direct.text(), "ok");
  const proxied = await fetchWithNetworkRoute(
    originUrl,
    { method: "POST", body: "proxy" },
    "proxy",
    () => proxyUrl,
  );
  assert.equal(await proxied.text(), "ok");
  assert.deepEqual(requests, ["POST:direct", "POST:proxy"]);
  assert.deepEqual(proxyTargets, [`127.0.0.1:${originAddress.port}`]);

  const proxyFailureMessage = "The selected proxy could not be reached.";
  await assert.rejects(
    fetchWithNetworkRoute(
      "https://provider.example/request",
      undefined,
      "failed-proxy",
      () => unavailableProxyUrl,
      proxyFailureMessage,
    ),
    (error: unknown) => {
      assert.equal((error as Error).name, "NetworkProxyError");
      assert.equal((error as Error).message, proxyFailureMessage);
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});
