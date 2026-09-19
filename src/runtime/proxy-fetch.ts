import { isIP } from "node:net";
import { URL } from "node:url";

import type { NetworkProxySettings } from "../model/profile.js";
import { throwIfAborted, waitForPromiseWithSignal } from "./host.js";
import { NetworkProxyError } from "./network-proxy-error.js";
import {
  readSystemProxyConfiguration,
  type SystemProxyConfiguration,
} from "./system-proxy.js";

const manualProxyFailureMessage =
  "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.";
const systemProxyFailureMessage =
  "The system proxy could not reach the provider. Check operating system proxy settings or choose another proxy mode.";

interface ProxyAwareFetchOptions {
  readSystemProxy?: () => Promise<SystemProxyConfiguration>;
  fetchWithNetworkRoute?: (
    input: URL | RequestInfo,
    init: RequestInit | undefined,
    routeKey: string,
    selectProxy: (target: URL) => string | null,
    proxyFailureMessage?: string,
  ) => Promise<Response>;
}

export interface ResolvedNetworkRoute {
  routeKey: string;
  selectProxy: (target: URL) => string | null;
  proxyFailureMessage?: string;
}

interface ResolveNetworkRouteOptions {
  readSystemProxy?: () => Promise<SystemProxyConfiguration>;
}

export function createProxyAwareFetch(
  loadSelection: () => Promise<NetworkProxySettings>,
  options: ProxyAwareFetchOptions = {},
): typeof fetch {
  const readSystemProxy = options.readSystemProxy ?? readSystemProxyConfiguration;
  const fetchWithNetworkRoute = options.fetchWithNetworkRoute ??
    bundledNetworkFetch;

  const proxyFetch: typeof fetch = async (input, init) => {
    const signal = init?.signal === null
      ? undefined
      : init?.signal ??
      (typeof input === "object" && !(input instanceof URL)
        ? input.signal
        : undefined);
    const route = await resolveNetworkRoute(loadSelection, signal, { readSystemProxy });
    return fetchWithNetworkRoute(
      input,
      init,
      route.routeKey,
      route.selectProxy,
      route.proxyFailureMessage,
    );
  };

  return proxyFetch;
}

export async function resolveNetworkRoute(
  loadSelection: () => Promise<NetworkProxySettings>,
  signal?: AbortSignal,
  options: ResolveNetworkRouteOptions = {},
): Promise<ResolvedNetworkRoute> {
  const selection = await waitForPromiseWithSignal(loadSelection(), signal);
  if (selection.mode === "none") {
    return { routeKey: "none", selectProxy: () => null };
  }
  if (selection.mode === "manual") {
    return {
      routeKey: JSON.stringify(selection),
      selectProxy: (target) => isLoopbackHost(target.hostname) ? null : selection.url,
      proxyFailureMessage: manualProxyFailureMessage,
    };
  }
  let system: SystemProxyConfiguration;
  try {
    system = await waitForPromiseWithSignal(
      (options.readSystemProxy ?? readSystemProxyConfiguration)(),
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof NetworkProxyError) throw error;
    throw new NetworkProxyError("The system proxy configuration could not be read.");
  }
  return {
    routeKey: JSON.stringify({ mode: "system", ...system }),
    selectProxy: (target) => proxyForTarget(system, target),
    proxyFailureMessage: systemProxyFailureMessage,
  };
}

function proxyForTarget(
  configuration: SystemProxyConfiguration,
  target: URL,
): string | null {
  const effectivePort = target.port ||
    (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : "");
  if (shouldBypassProxy(
    target.hostname,
    effectivePort,
    configuration.noProxy,
    configuration.bypassSyntax,
  )) {
    return null;
  }
  if (target.protocol === "https:" || target.protocol === "wss:") {
    return configuration.httpsProxy ?? configuration.socksProxy ?? null;
  }
  if (target.protocol === "http:" || target.protocol === "ws:") {
    return configuration.httpProxy ?? configuration.socksProxy ?? null;
  }
  return null;
}

function shouldBypassProxy(
  rawHostname: string,
  port: string,
  exceptions: string[],
  bypassSyntax: SystemProxyConfiguration["bypassSyntax"] = undefined,
): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isLoopbackHost(hostname)) return true;

  return exceptions.some((rawException) => {
    let exception = rawException.trim().toLowerCase();
    if (!exception) return false;
    if (exception === "*") return true;
    if (exception === "<local>") {
      return isIP(hostname) === 0 && !hostname.includes(".");
    }
    const bracketed = /^\[([^\]]+)\](?::([0-9]+))?$/u.exec(exception);
    if (bracketed && isIP(bracketed[1]!) === 6) {
      return hostname === normalizedIpv6Host(bracketed[1]!) &&
        (bracketed[2] === undefined || port === bracketed[2]);
    }
    if (bracketed) return false;
    if (isIP(exception) === 6) {
      return hostname === normalizedIpv6Host(exception);
    }
    const portSeparator = exception.lastIndexOf(":");
    if (
      portSeparator > 0 &&
      /^[0-9]+$/u.test(exception.slice(portSeparator + 1))
    ) {
      if (port !== exception.slice(portSeparator + 1)) return false;
      exception = exception.slice(0, portSeparator);
    }
    if (bypassSyntax === "wininet" && exception.includes("*")) {
      return matchesWildcard(hostname, exception);
    }
    if (exception.startsWith("*.")) exception = exception.slice(1);
    if (exception.startsWith(".")) {
      return hostname === exception.slice(1) || hostname.endsWith(exception);
    }
    if (matchesIpv4Cidr(hostname, exception)) return true;
    return hostname === exception;
  });
}

function matchesWildcard(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryValueIndex = 0;
  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length &&
      pattern[patternIndex] === value[valueIndex]
    ) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryValueIndex = valueIndex;
      continue;
    }
    if (starIndex < 0) return false;
    patternIndex = starIndex + 1;
    retryValueIndex += 1;
    valueIndex = retryValueIndex;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function isLoopbackHost(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127.")) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/iu.test(hostname);
}

function matchesIpv4Cidr(hostname: string, exception: string): boolean {
  const separator = exception.indexOf("/");
  if (separator < 0 || isIP(hostname) !== 4) return false;
  const network = normalizedIpv4Network(exception.slice(0, separator));
  const rawPrefix = exception.slice(separator + 1);
  if (!network || !/^(?:[0-9]|[12][0-9]|3[0-2])$/u.test(rawPrefix)) {
    return false;
  }
  const prefix = Number(rawPrefix);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (ipv4Number(hostname) & mask) === (ipv4Number(network) & mask);
}

function normalizedIpv4Network(value: string): string | undefined {
  const octets = value.split(".");
  if (octets.length < 1 || octets.length > 4) return undefined;
  if (octets.some((octet) =>
    !/^[0-9]{1,3}$/u.test(octet) || Number(octet) > 255
  )) return undefined;
  return [...octets, ...Array(4 - octets.length).fill("0")].join(".");
}

function normalizedIpv6Host(value: string): string {
  return new URL(`http://[${value}]`).hostname.replace(/^\[|\]$/gu, "");
}

function ipv4Number(address: string): number {
  return address.split(".").reduce(
    (value, octet) => ((value << 8) | Number(octet)) >>> 0,
    0,
  );
}

async function bundledNetworkFetch(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  routeKey: string,
  selectProxy: (target: URL) => string | null,
  proxyFailureMessage?: string,
): Promise<Response> {
  const { fetchWithNetworkRoute } = await import("./undici-network-fetch.js");
  return fetchWithNetworkRoute(
    input,
    init,
    routeKey,
    selectProxy,
    proxyFailureMessage,
  );
}
