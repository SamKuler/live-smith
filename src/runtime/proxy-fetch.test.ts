import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkProxySettings } from "../model/profile.js";
import { createProxyAwareFetch } from "./proxy-fetch.js";

test("proxy-aware fetch gives none, manual, and system modes distinct routes", async () => {
  let selection: NetworkProxySettings = { mode: "none", url: "" };
  const calls: Array<{
    kind: "direct" | "proxy";
    proxyFailureMessage: string | undefined;
    url: string;
  }> = [];
  const proxyFetch = createProxyAwareFetch(
    async () => selection,
    {
      fetchWithNetworkRoute: async (
        input,
        _init,
        _key,
        selectProxy,
        proxyFailureMessage,
      ) => {
        const proxyUrl = selectProxy(new URL(requestUrl(input)));
        calls.push(proxyUrl === null
          ? { kind: "direct", url: requestUrl(input), proxyFailureMessage }
          : { kind: "proxy", url: proxyUrl, proxyFailureMessage });
        return new Response(requestUrl(input));
      },
      readSystemProxy: async () => ({
        httpProxy: "http://system-http.example:8080",
        httpsProxy: "http://system-https.example:8443",
        socksProxy: "socks5://system-socks.example:1080",
        noProxy: ["localhost", "*.internal.example"],
      }),
    },
  );

  await proxyFetch("https://api.example/v1", { method: "POST" });
  selection = { mode: "manual", url: "http://manual.example:7890" };
  await proxyFetch("https://api.example/v1");
  selection = { mode: "system", url: "" };
  await proxyFetch("http://plain.example/v1");
  await proxyFetch("https://secure.example/v1");
  await proxyFetch("https://service.internal.example/v1");

  assert.deepEqual(calls, [
    {
      kind: "direct",
      url: "https://api.example/v1",
      proxyFailureMessage: undefined,
    },
    {
      kind: "proxy",
      url: "http://manual.example:7890",
      proxyFailureMessage:
        "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
    },
    {
      kind: "proxy",
      url: "http://system-http.example:8080",
      proxyFailureMessage:
        "The system proxy could not reach the provider. Check operating system proxy settings or choose another proxy mode.",
    },
    {
      kind: "proxy",
      url: "http://system-https.example:8443",
      proxyFailureMessage:
        "The system proxy could not reach the provider. Check operating system proxy settings or choose another proxy mode.",
    },
    {
      kind: "direct",
      url: "https://service.internal.example/v1",
      proxyFailureMessage:
        "The system proxy could not reach the provider. Check operating system proxy settings or choose another proxy mode.",
    },
  ]);
});

test("system mode falls back to SOCKS only when the target protocol has no route", async () => {
  const routes: string[] = [];
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "system", url: "" }),
    {
      fetchWithNetworkRoute: async (input, _init, _key, selectProxy) => {
        const proxyUrl = selectProxy(new URL(requestUrl(input)));
        assert.ok(proxyUrl);
        routes.push(proxyUrl);
        return new Response("ok");
      },
      readSystemProxy: async () => ({
        socksProxy: "socks5://127.0.0.1:1080",
        noProxy: [],
      }),
    },
  );

  await proxyFetch("https://api.example/v1");
  assert.deepEqual(routes, ["socks5://127.0.0.1:1080"]);
});

test("system mode preserves macOS loopback, CIDR, and suffix bypasses", async () => {
  const routes: string[] = [];
  let systemReads = 0;
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "system", url: "" }),
    {
      fetchWithNetworkRoute: async (input, _init, _key, selectProxy) => {
        const proxyUrl = selectProxy(new URL(requestUrl(input)));
        routes.push(proxyUrl === null
          ? `direct:${requestUrl(input)}`
          : `${proxyUrl}:${requestUrl(input)}`);
        return new Response("ok");
      },
      readSystemProxy: async () => {
        systemReads += 1;
        return {
          httpsProxy: "http://proxy.example:8080",
          noProxy: [
            "[not-ipv6]",
            "169.254/16",
            "<local>",
            "secure.example:443",
            "*.corp.example:443",
            "[2001:db8::2]:443",
            "2001:db8::3",
            "2001:0db8:0:0:0:0:0:4",
          ],
        };
      },
    },
  );

  await proxyFetch("https://localhost:8443/v1");
  await proxyFetch("https://service.localhost:8443/v1");
  await proxyFetch("https://127.0.0.1:8443/v1");
  await proxyFetch("https://[::1]:8443/v1");
  await proxyFetch("https://[::ffff:7f00:1]:8443/v1");
  await proxyFetch("https://169.254.2.3/v1");
  await proxyFetch("https://printer/v1");
  await proxyFetch("https://secure.example/v1");
  await proxyFetch("https://api.corp.example/v1");
  await proxyFetch("https://corp.example/v1");
  await proxyFetch("https://[2001:db8::2]/v1");
  await proxyFetch("https://[2001:db8::3]/v1");
  await proxyFetch("https://[2001:db8::4]/v1");
  await proxyFetch("https://[2001:db8::1]/v1");
  assert.equal(
    routes.slice(0, -1).every((route) => route.startsWith("direct:")),
    true,
  );
  assert.equal(routes.at(-1)?.startsWith("http://proxy.example:8080:"), true);
  assert.equal(systemReads, 14);
});

test("Windows system bypass uses anchored WinINet wildcard patterns", async () => {
  const routes: string[] = [];
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "system", url: "" }),
    {
      fetchWithNetworkRoute: async (input, _init, _key, selectProxy) => {
        routes.push(selectProxy(new URL(requestUrl(input))) ?? "direct");
        return new Response("ok");
      },
      readSystemProxy: async () => ({
        httpsProxy: "http://proxy.example:8080",
        noProxy: ["*.corp.example", "ms*", "*int*"],
        bypassSyntax: "wininet",
      }),
    },
  );

  for (const url of [
    "https://api.corp.example/v1",
    "https://corp.example/v1",
    "https://msedge.example/v1",
    "https://printserver.example/v1",
    "https://public.example/v1",
  ]) await proxyFetch(url);

  assert.deepEqual(routes, [
    "direct",
    "http://proxy.example:8080",
    "direct",
    "direct",
    "http://proxy.example:8080",
  ]);
});

test("manual mode leaves loopback Direct API endpoints local", async () => {
  const routes: string[] = [];
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "manual", url: "http://proxy.example:8080" }),
    {
      fetchWithNetworkRoute: async (input, _init, _key, selectProxy) => {
        routes.push(
          selectProxy(new URL(requestUrl(input))) ?? "direct",
        );
        return new Response("ok");
      },
    },
  );

  await proxyFetch("http://localhost:11434/v1/models");
  await proxyFetch("https://api.example/v1/models");
  assert.deepEqual(routes, ["direct", "http://proxy.example:8080"]);
});

test("proxy-aware fetch preserves request options and redacts discovery failures", async () => {
  const controller = new AbortController();
  const init = {
    method: "POST",
    headers: { authorization: "Bearer provider-secret" },
    body: "payload",
    signal: controller.signal,
  } satisfies RequestInit;
  let observed: RequestInit | undefined;
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "system", url: "" }),
    {
      fetchWithNetworkRoute: async () => new Response("unused"),
      readSystemProxy: async () => {
        throw new Error("system output contained secret-proxy-token");
      },
    },
  );
  await assert.rejects(
    proxyFetch("https://api.example/v1", init),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message, "The system proxy configuration could not be read.");
      assert.doesNotMatch(message, /secret-proxy-token/);
      return true;
    },
  );

  const manualFetch = createProxyAwareFetch(
    async () => ({ mode: "manual", url: "https://proxy.example" }),
    {
      fetchWithNetworkRoute: async (_input, next) => {
        observed = next;
        return new Response("ok");
      },
    },
  );
  await manualFetch("https://api.example/v1", init);
  assert.equal(observed, init);
});

test("cancellation stops waiting for a shared system proxy query", async () => {
  let finishQuery!: (configuration: {
    httpsProxy: string;
    noProxy: string[];
  }) => void;
  const query = new Promise<{
    httpsProxy: string;
    noProxy: string[];
  }>((resolve) => {
    finishQuery = resolve;
  });
  const controller = new AbortController();
  const reason = new Error("stop proxy admission");
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "system", url: "" }),
    {
      readSystemProxy: () => query,
      fetchWithNetworkRoute: async () => new Response("must not fetch"),
    },
  );

  const pending = proxyFetch("https://api.example/v1", {
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  finishQuery({ httpsProxy: "http://proxy.example:8080", noProxy: [] });
  await query;
});

test("an explicit null signal detaches an aborted Request during route selection", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stale request signal"));
  const request = new Request("https://api.example/v1", {
    signal: controller.signal,
  });
  let fetchCalls = 0;
  const proxyFetch = createProxyAwareFetch(
    async () => ({ mode: "none", url: "" }),
    {
      fetchWithNetworkRoute: async (_input, init) => {
        fetchCalls += 1;
        assert.equal(init?.signal, null);
        return new Response("ok");
      },
    },
  );

  assert.equal((await proxyFetch(request, { signal: null })).status, 200);
  assert.equal(fetchCalls, 1);
});

function requestUrl(input: URL | RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL
    ? input.href
    : input.url;
}
