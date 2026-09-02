import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemProxyReader,
  parseMacSystemProxyConfiguration,
  parseWindowsSystemProxyConfiguration,
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

test("Windows system proxy parsing preserves static routes and bypasses", () => {
  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxy:
      "HTTP=192.0.2.10:3128;https=http://[2001:db8::2]:8443;ftp=ignored.example:21",
    proxyBypass: "localhost; *.internal.example\t<local>;ms*;*int*",
  })), {
    httpProxy: "http://192.0.2.10:3128",
    httpsProxy: "http://[2001:db8::2]:8443",
    noProxy: ["localhost", "*.internal.example", "<local>", "ms*", "*int*"],
    bypassSyntax: "wininet",
  });

  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxy: "proxy.example:8080",
    proxyBypass: "stale.example",
  })), {
    httpProxy: "http://proxy.example:8080",
    httpsProxy: "http://proxy.example:8080",
    noProxy: ["stale.example"],
    bypassSyntax: "wininet",
  });

  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxyEnable: "0x0",
    proxy: "stale.example:8080",
    proxyBypass: "stale.example",
  })), { noProxy: [] });

  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxy: "2001:db8::2",
  })), {
    httpProxy: "http://[2001:db8::2]",
    httpsProxy: "http://[2001:db8::2]",
    noProxy: [],
    bypassSyntax: "wininet",
  });

  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxy:
      "http=plain.example:8080;https=secure-target.example:8080;socks=unused.example:1080",
  })), {
    httpProxy: "http://plain.example:8080",
    httpsProxy: "http://secure-target.example:8080",
    noProxy: [],
    bypassSyntax: "wininet",
  });

  assert.deepEqual(parseWindowsSystemProxyConfiguration(windowsProxyOutput({
    proxy: null,
    proxyEnable: null,
  })), { noProxy: [] });
});

test("Windows system proxy parsing rejects PAC, malformed output, and unsafe routes", () => {
  for (const fixture of [
    windowsProxyOutput({
      autoConfigUrl: "https://secret.example/proxy.pac?token=secret",
    }),
    windowsProxyOutput({ autoDetect: "0x1" }),
  ]) {
    assert.throws(
      () => parseWindowsSystemProxyConfiguration(fixture),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(
          message,
          "Windows automatic proxy configuration is not supported; choose Manual proxy instead.",
        );
        assert.doesNotMatch(message, /secret|proxy\.pac|token/i);
        return true;
      },
    );
  }

  assert.throws(
    () => parseWindowsSystemProxyConfiguration(windowsProxyOutput({
      proxy: "socks=secret-socks.example:1080",
    })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(
        message,
        "Windows SOCKS system proxies are not supported; choose Manual SOCKS5 proxy instead.",
      );
      assert.doesNotMatch(message, /secret-socks/i);
      return true;
    },
  );

  for (const fixture of [
    "",
    "unrecognized command output",
    windowsProxyOutput({ proxyEnable: "not-a-dword" }),
    windowsProxyOutput({ proxy: null }),
    windowsProxyOutput({ proxy: "https=https://proxy.example:443" }),
    windowsProxyOutput({ proxy: "http=user:secret@proxy.example:8080" }),
    windowsProxyOutput({ proxy: "http=@proxy.example:8080" }),
    windowsProxyOutput({ proxy: "http=proxy.example:0" }),
    windowsProxyOutput({ proxy: "http=proxy.example:" }),
    windowsProxyOutput({ proxy: "http=http://proxy.example:/" }),
    windowsProxyOutput({ proxy: "http=http://proxy.example:/./" }),
    windowsProxyOutput({ proxy: "https=[2001:db8::2]:" }),
    windowsProxyOutput({ proxy: "https=http://[2001:db8::2]:/" }),
    windowsProxyOutput({ proxy: "https=http://[2001:db8::2]:/./" }),
    windowsProxyOutput({ proxy: "https=proxy.example:65536" }),
    windowsProxyOutput({ proxy: "http=proxy.example:8080/path" }),
    windowsProxyOutput({ proxy: "http=http://proxy.example:8080/./" }),
    windowsProxyOutput({ proxy: "http=one.example:80;HTTP=two.example:80" }),
    windowsProxyOutput({ proxy: "one.example:80 two.example:80" }),
    windowsProxyOutput({ proxy: "unknown=proxy.example:80" }),
    windowsProxyOutput({
      extraLines: ["    ProxyServer    REG_SZ    duplicate.example:8080"],
    }),
  ]) {
    assert.throws(
      () => parseWindowsSystemProxyConfiguration(fixture),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(
          message,
          /Windows returned an invalid system proxy configuration/,
        );
        assert.doesNotMatch(
          message,
          /secret|proxy\.example|one\.example|two\.example|65536|duplicate/i,
        );
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

test("the Windows system proxy reader uses one fixed bounded System32 query", async () => {
  const calls: Array<{
    args: readonly string[];
    executable: string;
    options: Readonly<{
      cwd: string;
      encoding: "utf8";
      maxBuffer: number;
      timeout: number;
      windowsHide: true;
    }>;
  }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = createSystemProxyReader({
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    runWindowsProxyCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      await gate;
      return windowsProxyOutput({ proxy: "proxy.example:8080" });
    },
  });

  const first = reader();
  const second = reader();
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.executable,
    "C:\\Windows\\System32\\reg.exe",
  );
  assert.deepEqual(calls[0]?.args, [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ]);
  assert.deepEqual(calls[0]?.options, {
    cwd: "C:\\Windows\\System32",
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 2_000,
    windowsHide: true,
  });

  await reader();
  assert.equal(calls.length, 2);
});

test("Windows system proxy discovery rejects unsafe roots and redacts command failures", async () => {
  let calls = 0;
  for (const windowsSystemRoot of [
    "",
    "Windows",
    "\\Windows",
    "\\\\server\\share\\Windows",
    "\\\\?\\C:\\Windows",
    "C:\\Temp\\..\\Windows",
    "C:\\Windows:alternate",
    "C:\\Win<dows",
    "C:\\Win|dows",
  ]) {
    const reader = createSystemProxyReader({
      platform: "win32",
      windowsSystemRoot,
      runWindowsProxyCommand: async () => {
        calls += 1;
        return windowsProxyOutput();
      },
    });
    await assert.rejects(reader(), /Windows system proxy command is unavailable/i);
  }
  assert.equal(calls, 0);

  const reader = createSystemProxyReader({
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    runWindowsProxyCommand: async () => {
      throw new Error("secret proxy process output");
    },
  });
  await assert.rejects(
    reader(),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(
        message,
        "The Windows system proxy configuration could not be read.",
      );
      assert.doesNotMatch(message, /secret|process output/i);
      return true;
    },
  );
});

test("system proxy discovery fails explicitly outside desktop Live platforms", async () => {
  const reader = createSystemProxyReader({
    platform: "linux",
    queryMacProxy: async () => activeProxy,
  });
  await assert.rejects(
    reader(),
    /System proxy discovery is available only on macOS and Windows/,
  );
});

function windowsProxyOutput(
  overrides: {
    autoConfigUrl?: string;
    autoDetect?: string;
    extraLines?: string[];
    proxy?: string | null;
    proxyBypass?: string;
    proxyEnable?: string | null;
  } = {},
): string {
  const lines = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ];
  if (overrides.proxyEnable !== null) {
    lines.push(
      `    ProxyEnable    REG_DWORD    ${overrides.proxyEnable ?? "0x1"}`,
    );
  }
  const proxy = overrides.proxy === undefined
    ? "proxy.example:8080"
    : overrides.proxy;
  if (proxy !== null) lines.push(`    ProxyServer    REG_SZ    ${proxy}`);
  if (overrides.proxyBypass !== undefined) {
    lines.push(`    ProxyOverride    REG_SZ    ${overrides.proxyBypass}`);
  }
  if (overrides.autoConfigUrl !== undefined) {
    lines.push(`    AutoConfigURL    REG_SZ    ${overrides.autoConfigUrl}`);
  }
  if (overrides.autoDetect !== undefined) {
    lines.push(`    AutoDetect    REG_DWORD    ${overrides.autoDetect}`);
  }
  lines.push(...(overrides.extraLines ?? []));
  return lines.join("\r\n");
}
