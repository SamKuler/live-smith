import assert from "node:assert/strict";
import { Blob, Buffer } from "node:buffer";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import * as vm from "node:vm";

import * as esbuild from "esbuild";

import { resolveFetchImplementation } from "../../src/runtime/host.js";

for (const webGlobals of [false, true]) {
  test(`the bundled network route works in ${webGlobals ? "Live 12.4.15b5's documented" : "the earlier restricted"} VM environment`, async (t) => {
    const requests: string[] = [];
    const requestKinds: (string | undefined)[] = [];
    const origin = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(`${request.method}:${Buffer.concat(chunks).toString("utf8")}`);
        requestKinds.push(request.headers["x-request-kind"] as string | undefined);
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
      inject: ["src/runtime/network-node-globals.ts"],
      logLevel: "silent",
      platform: "node",
      write: false,
    });
    const source = build.outputFiles[0]?.text;
    assert.ok(source);
    const bundledModule: { exports: Record<string, unknown> } = { exports: {} };
    const context = vm.createContext({
      ...(webGlobals ? { performance, AbortSignal, Headers, Request, Response, FormData } : {}),
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
    vm.runInContext(source, context);
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

    if (webGlobals) {
      // Construct native request objects inside the VM and send them through the
      // production proxy route, including multipart serialization and cancellation.
      const upload = vm.runInContext(`async (url, proxyUrl, file) => {
        const form = new FormData();
        form.append("prompt", "Generate a bass line");
        form.append("file", file, "reference.raw");
        const request = new Request(url, { method: "POST", headers: new Headers({ "x-request-kind": "upload" }), body: form });
        const response = await module.exports.fetchWithNetworkRoute(request, undefined, "native-upload", () => proxyUrl);
        return response.text();
      }`, context) as (url: string, proxyUrl: string, file: Blob) => Promise<string>;
      assert.equal(await upload(originUrl, proxyUrl, new Blob(["reference-audio"])), "ok");
      assert.equal(requests.length, 3);
      assert.match(requests[2]!, /name="prompt"\r\n\r\nGenerate a bass line/);
      assert.match(requests[2]!, /name="file"; filename="reference.raw"/);
      assert.match(requests[2]!, /\r\n\r\nreference-audio\r\n/);
      assert.equal(requestKinds[2], "upload");
      assert.equal(proxyTargets.length, 2);
      const cancelled = vm.runInContext(`(url) => module.exports.fetchWithNetworkRoute(
        new Request(url, { signal: AbortSignal.abort(new Error("upload cancelled")) }),
        undefined, "native-cancel", () => null
      )`, context) as (url: string) => Promise<Response>;
      await assert.rejects(cancelled(originUrl), /upload cancelled/);
      assert.equal(requests.length, 3);
    }

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
}
