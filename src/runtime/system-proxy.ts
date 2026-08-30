import { execFile } from "node:child_process";
import { isIP } from "node:net";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";

import { NetworkProxyError } from "./network-proxy-error.js";

export interface SystemProxyConfiguration {
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  noProxy: string[];
}

interface SystemProxyReaderOptions {
  platform?: NodeJS.Platform;
  queryMacProxy?: () => Promise<string>;
}

const execFileAsync = promisify(execFile);

export function createSystemProxyReader(
  options: SystemProxyReaderOptions = {},
): () => Promise<SystemProxyConfiguration> {
  const platform = options.platform ?? process.platform;
  const queryMacProxy = options.queryMacProxy ?? queryMacSystemProxy;
  let pending: Promise<SystemProxyConfiguration> | undefined;

  return () => {
    if (platform !== "darwin") {
      return Promise.reject(new NetworkProxyError(
        "System proxy discovery is currently available only on macOS.",
      ));
    }
    pending ??= queryMacProxy()
      .then(parseMacSystemProxyConfiguration)
      .catch((error: unknown) => {
        if (error instanceof NetworkProxyError) throw error;
        throw new NetworkProxyError("The macOS system proxy configuration could not be read.");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

export const readSystemProxyConfiguration = createSystemProxyReader();

export function parseMacSystemProxyConfiguration(
  output: string,
): SystemProxyConfiguration {
  const values = new Map<string, string>();
  const noProxy: string[] = [];
  let readingExceptions = false;

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "ExceptionsList : <array> {") {
      readingExceptions = true;
      continue;
    }
    if (readingExceptions) {
      if (trimmed === "}") {
        readingExceptions = false;
        continue;
      }
      const entry = /^\d+\s*:\s*(.+)$/u.exec(trimmed)?.[1]?.trim();
      if (entry) noProxy.push(entry);
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/u.exec(trimmed);
    if (field) values.set(field[1]!, field[2]!.trim());
  }

  if (
    values.get("ProxyAutoConfigEnable") === "1" ||
    values.get("ProxyAutoDiscoveryEnable") === "1"
  ) {
    throw new NetworkProxyError(
      "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
    );
  }
  if (
    values.get("ExcludeSimpleHostnames") === "1" &&
    !noProxy.includes("<local>")
  ) {
    noProxy.push("<local>");
  }

  const httpProxy = proxyRoute(values, "HTTP", "http");
  const httpsProxy = proxyRoute(values, "HTTPS", "http");
  const socksProxy = proxyRoute(values, "SOCKS", "socks5");
  return {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(socksProxy === undefined ? {} : { socksProxy }),
    noProxy,
  };
}

function proxyRoute(
  values: Map<string, string>,
  prefix: "HTTP" | "HTTPS" | "SOCKS",
  protocol: "http" | "socks5",
): string | undefined {
  if (values.get(`${prefix}Enable`) !== "1") return undefined;
  const host = values.get(`${prefix}Proxy`)?.trim();
  const rawPort = values.get(`${prefix}Port`)?.trim();
  if (!host || !rawPort || !/^[0-9]+$/u.test(rawPort)) {
    throw invalidSystemProxy();
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalidSystemProxy();
  }
  if (
    /[\u0000-\u0020\u007f/\\@?#]/u.test(host) ||
    (host.includes(":") && isIP(host) !== 6)
  ) {
    throw invalidSystemProxy();
  }
  try {
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    const url = new URL(`${protocol}://${authority}:${port}`);
    if (!url.hostname || url.username || url.password) throw invalidSystemProxy();
    return protocol === "socks5"
      ? url.href.replace(/\/$/u, "")
      : url.origin;
  } catch (error) {
    if (error instanceof NetworkProxyError) throw error;
    throw invalidSystemProxy();
  }
}

function invalidSystemProxy(): NetworkProxyError {
  return new NetworkProxyError("macOS returned an invalid system proxy configuration.");
}

async function queryMacSystemProxy(): Promise<string> {
  const result = await execFileAsync(
    "/usr/sbin/scutil",
    ["--proxy"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      windowsHide: true,
    },
  );
  return result.stdout;
}
