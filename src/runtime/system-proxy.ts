import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { win32 as windowsPath } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";

import { NetworkProxyError } from "./network-proxy-error.js";

export interface SystemProxyConfiguration {
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  noProxy: string[];
  bypassSyntax?: "wininet";
}

interface SystemProxyReaderOptions {
  platform?: NodeJS.Platform;
  queryMacProxy?: () => Promise<string>;
  runWindowsProxyCommand?: WindowsProxyCommandRunner;
  windowsSystemRoot?: string;
}

interface WindowsProxyCommandOptions {
  cwd: string;
  encoding: "utf8";
  maxBuffer: number;
  timeout: number;
  windowsHide: true;
}

type WindowsProxyCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<WindowsProxyCommandOptions>,
) => Promise<string>;

interface WindowsRegistryValue {
  data: string;
  type: string;
}

const execFileAsync = promisify(execFile);
const windowsInternetSettingsKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const windowsInternetSettingsOutputKey =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export function createSystemProxyReader(
  options: SystemProxyReaderOptions = {},
): () => Promise<SystemProxyConfiguration> {
  const platform = options.platform ?? process.platform;
  const queryMacProxy = options.queryMacProxy ?? queryMacSystemProxy;
  const windowsSystemRoot = normalizeWindowsSystemRoot(
    options.windowsSystemRoot ?? process.env.SystemRoot,
  );
  const runWindowsProxyCommand = options.runWindowsProxyCommand ??
    runWindowsSystemProxyCommand;
  let pending: Promise<SystemProxyConfiguration> | undefined;

  return () => {
    if (platform !== "darwin" && platform !== "win32") {
      return Promise.reject(new NetworkProxyError(
        "System proxy discovery is available only on macOS and Windows.",
      ));
    }
    const query = platform === "darwin"
      ? queryMacProxy
      : () => queryWindowsSystemProxy(
          windowsSystemRoot,
          runWindowsProxyCommand,
        );
    pending ??= query()
      .then(platform === "darwin"
        ? parseMacSystemProxyConfiguration
        : parseWindowsSystemProxyConfiguration)
      .catch((error: unknown) => {
        if (error instanceof NetworkProxyError) throw error;
        throw new NetworkProxyError(
          platform === "darwin"
            ? "The macOS system proxy configuration could not be read."
            : "The Windows system proxy configuration could not be read.",
        );
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

export function parseWindowsSystemProxyConfiguration(
  output: string,
): SystemProxyConfiguration {
  const values = parseWindowsRegistryValues(output);
  const autoDetect = values.get("autodetect");
  if (autoDetect !== undefined) {
    if (
      autoDetect.type !== "REG_DWORD" ||
      !/^0x[0-9a-f]{1,8}$/iu.test(autoDetect.data)
    ) {
      throw invalidWindowsSystemProxy();
    }
    if (Number.parseInt(autoDetect.data.slice(2), 16) !== 0) {
      throw unsupportedWindowsAutomaticProxy();
    }
  }
  const autoConfigUrl = values.get("autoconfigurl");
  if (autoConfigUrl !== undefined) {
    if (autoConfigUrl.type !== "REG_SZ") throw invalidWindowsSystemProxy();
    if (autoConfigUrl.data.trim()) {
      throw unsupportedWindowsAutomaticProxy();
    }
  }
  const proxyEnable = values.get("proxyenable");
  if (proxyEnable === undefined) return { noProxy: [] };
  if (
    proxyEnable.type !== "REG_DWORD" ||
    !/^0x[0-9a-f]{1,8}$/iu.test(proxyEnable.data)
  ) {
    throw invalidWindowsSystemProxy();
  }
  if (Number.parseInt(proxyEnable.data.slice(2), 16) === 0) {
    return { noProxy: [] };
  }
  const proxyServer = values.get("proxyserver");
  if (
    proxyServer === undefined ||
    proxyServer.type !== "REG_SZ" ||
    !proxyServer.data.trim()
  ) {
    throw invalidWindowsSystemProxy();
  }
  const proxyOverride = values.get("proxyoverride");
  if (proxyOverride !== undefined && proxyOverride.type !== "REG_SZ") {
    throw invalidWindowsSystemProxy();
  }
  const routes = parseWindowsProxyMap(proxyServer.data.trim());
  return {
    ...routes,
    noProxy: splitWindowsProxyList(proxyOverride?.data ?? ""),
    bypassSyntax: "wininet",
  };
}

function parseWindowsRegistryValues(
  output: string,
): Map<string, WindowsRegistryValue> {
  const values = new Map<string, WindowsRegistryValue>();
  let foundInternetSettingsKey = false;
  for (const line of output.split(/\r?\n/u)) {
    if (
      line.trim().toLowerCase() ===
        windowsInternetSettingsOutputKey.toLowerCase()
    ) {
      foundInternetSettingsKey = true;
      continue;
    }
    const knownValue = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\b/iu
      .test(line);
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\s+(REG_[A-Z0-9_]+)(?:\s+(.*))?$/iu
      .exec(line);
    if (!match) {
      if (knownValue) throw invalidWindowsSystemProxy();
      continue;
    }
    const name = match[1]!.toLowerCase();
    if (values.has(name)) throw invalidWindowsSystemProxy();
    values.set(name, {
      type: match[2]!.toUpperCase(),
      data: match[3]?.trim() ?? "",
    });
  }
  if (!foundInternetSettingsKey) throw invalidWindowsSystemProxy();
  return values;
}

function parseWindowsProxyMap(
  rawProxy: string,
): Omit<SystemProxyConfiguration, "noProxy"> {
  const routes = new Map<string, string>();
  let defaultRoute: string | undefined;
  for (const entry of splitWindowsProxyList(rawProxy)) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      if (defaultRoute !== undefined) throw invalidWindowsSystemProxy();
      defaultRoute = entry;
      continue;
    }
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if (!key || !value || routes.has(key)) {
      throw invalidWindowsSystemProxy();
    }
    if (!["ftp", "http", "https", "socks"].includes(key)) {
      throw invalidWindowsSystemProxy();
    }
    routes.set(key, value);
  }
  const http = routes.get("http") ?? defaultRoute;
  const https = routes.get("https") ?? defaultRoute;
  if (routes.has("socks") && (http === undefined || https === undefined)) {
    throw new NetworkProxyError(
      "Windows SOCKS system proxies are not supported; choose Manual SOCKS5 proxy instead.",
    );
  }
  return {
    ...(http === undefined
      ? {}
      : { httpProxy: normalizeWindowsProxyEndpoint(http) }),
    ...(https === undefined
      ? {}
      : { httpsProxy: normalizeWindowsProxyEndpoint(https) }),
  };
}

function normalizeWindowsProxyEndpoint(rawValue: string): string {
  const value = rawValue.trim();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(value)?.[0] ?? "";
  const bareIpv6 = !scheme && isIP(value) === 6;
  const remainder = value.slice(scheme.length);
  const authorityEnd = remainder.search(/[/?#]/u);
  const authority = authorityEnd < 0
    ? remainder
    : remainder.slice(0, authorityEnd);
  const suffix = authorityEnd < 0 ? "" : remainder.slice(authorityEnd);
  if (
    !value ||
    !authority ||
    (!bareIpv6 && authority.endsWith(":")) ||
    (suffix !== "" && suffix !== "/") ||
    /[\u0000-\u0020\u007f\\,@]/u.test(value)
  ) {
    throw invalidWindowsSystemProxy();
  }
  const candidate = bareIpv6
    ? `http://[${value}]`
    : scheme
      ? value
      : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "http:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash ||
      (url.port !== "" && (
        !/^[0-9]+$/u.test(url.port) ||
        Number(url.port) < 1 ||
        Number(url.port) > 65_535
      ))
    ) {
      throw invalidWindowsSystemProxy();
    }
    return url.origin;
  } catch (error) {
    if (error instanceof NetworkProxyError) throw error;
    throw invalidWindowsSystemProxy();
  }
}

function splitWindowsProxyList(value: string): string[] {
  return value
    .split(/[;\t\n\f\r ]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function invalidWindowsSystemProxy(): NetworkProxyError {
  return new NetworkProxyError(
    "Windows returned an invalid system proxy configuration.",
  );
}

function unsupportedWindowsAutomaticProxy(): NetworkProxyError {
  return new NetworkProxyError(
    "Windows automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
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

async function queryWindowsSystemProxy(
  windowsSystemRoot: string | undefined,
  runCommand: WindowsProxyCommandRunner,
): Promise<string> {
  if (!windowsSystemRoot) {
    throw new NetworkProxyError(
      "The Windows system proxy command is unavailable.",
    );
  }
  const system32 = windowsPath.join(windowsSystemRoot, "System32");
  const executable = windowsPath.join(
    system32,
    "reg.exe",
  );
  // This is one fixed, read-only registry query. It never invokes a shell,
  // script host, or registry mutation command.
  return runCommand(
    executable,
    [
      "query",
      windowsInternetSettingsKey,
    ],
    {
      cwd: system32,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      windowsHide: true,
    },
  );
}

async function runWindowsSystemProxyCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<WindowsProxyCommandOptions>,
): Promise<string> {
  const result = await execFileAsync(executable, [...args], options);
  return result.stdout;
}

function normalizeWindowsSystemRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.replaceAll("/", "\\").replace(/\\+$/u, "");
  if (!/^[A-Za-z]:\\[^\\]+(?:\\[^\\]+)*$/u.test(candidate)) {
    return undefined;
  }
  const segments = candidate.slice(3).split("\\");
  if (segments.some((segment) =>
    segment === "." ||
    segment === ".." ||
    /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
    /[. ]$/u.test(segment)
  )) {
    return undefined;
  }
  const normalized = windowsPath.normalize(candidate);
  return normalized === candidate ? normalized : undefined;
}
