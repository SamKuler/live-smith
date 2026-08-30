import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemProxyReader,
  parseMacSystemProxyConfiguration,
} from "./system-proxy.js";

const activeProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
    2 : *.local
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 10808
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 10809
  HTTPSProxy : secure-proxy.example
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 10810
  SOCKSProxy : socks-proxy.example
}`;

test("macOS system proxy parsing preserves protocol routes and bypasses", () => {
  assert.deepEqual(parseMacSystemProxyConfiguration(activeProxy), {
    httpProxy: "http://127.0.0.1:10808",
    httpsProxy: "http://secure-proxy.example:10809",
    socksProxy: "socks5://socks-proxy.example:10810",
    noProxy: ["localhost", "127.0.0.0/8", "*.local", "<local>"],
  });

  assert.deepEqual(parseMacSystemProxyConfiguration(`<dictionary> {
    HTTPEnable : 0
    HTTPPort : 10808
    HTTPProxy : secret-proxy.example
    HTTPSEnable : 0
    SOCKSEnable : 0
    ProxyAutoConfigEnable : 0
  }`), { noProxy: [] });
});

test("macOS system proxy parsing rejects unsupported automatic-only routes safely", () => {
  for (const fixture of [
    `<dictionary> {
      ProxyAutoConfigEnable : 1
      ProxyAutoConfigURLString : https://secret.example/proxy.pac?token=secret
    }`,
    `<dictionary> {
      ProxyAutoDiscoveryEnable : 1
    }`,
  ]) {
    assert.throws(
      () => parseMacSystemProxyConfiguration(fixture),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /automatic proxy configuration is not supported/i);
        assert.doesNotMatch(message, /secret|proxy\.pac|token/i);
        return true;
      },
    );
  }
});

test("macOS system proxy parsing rejects malformed routes without echoing them", () => {
  for (const fixture of [
    `<dictionary> {
      HTTPSEnable : 1
      HTTPSProxy : user:secret@proxy.example
      HTTPSPort : 443
    }`,
    `<dictionary> {
      HTTPSEnable : 1
      HTTPSProxy : proxy.example
      HTTPSPort : 70000
    }`,
    `<dictionary> {
      HTTPSEnable : 1
      HTTPSProxy : proxy\\evil
      HTTPSPort : 8080
    }`,
  ]) {
    assert.throws(
      () => parseMacSystemProxyConfiguration(fixture),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message, "macOS returned an invalid system proxy configuration.");
        assert.doesNotMatch(message, /secret|proxy\.example|70000/i);
        return true;
      },
    );
  }
});

test("the system proxy reader coalesces only concurrent OS queries", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = createSystemProxyReader({
    platform: "darwin",
    queryMacProxy: async () => {
      calls += 1;
      await gate;
      return activeProxy;
    },
  });

  const first = reader();
  const second = reader();
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);

  await reader();
  assert.equal(calls, 2);
});

test("system proxy discovery fails explicitly on unsupported hosts", async () => {
  const reader = createSystemProxyReader({
    platform: "win32",
    queryMacProxy: async () => activeProxy,
  });
  await assert.rejects(
    reader(),
    /System proxy discovery is currently available only on macOS/,
  );
});
