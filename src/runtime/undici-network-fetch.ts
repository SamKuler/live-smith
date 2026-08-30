import { URL } from "node:url";

import Agent from "undici/lib/dispatcher/agent.js";
import DispatcherBase from "undici/lib/dispatcher/dispatcher.js";
import ProxyAgent from "undici/lib/dispatcher/proxy-agent.js";
import WrapHandler from "undici/lib/handler/wrap-handler.js";
import connectDispatcher from "undici/lib/api/api-connect.js";
import type { Dispatcher } from "undici";

import { resolveFetchImplementation, throwIfAborted } from "./host.js";
import { NetworkProxyError } from "./network-proxy-error.js";

// ProxyAgent expects the public entrypoint's connect mixin on its private Pool.
Object.assign(DispatcherBase.prototype, { connect: connectDispatcher });

const hostFetch = resolveFetchImplementation();

let activeDispatcher:
  | RoutingDispatcherEntry
  | undefined;

interface RoutingDispatcherEntry {
  refs: number;
  retired: boolean;
  routeKey: string;
  value: NetworkRoutingDispatcher;
}

type DispatchHandler = Parameters<Dispatcher["dispatch"]>[1];

export function fetchWithNetworkRoute(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  routeKey: string,
  selectProxy: (target: URL) => string | null,
  proxyFailureMessage?: string,
): Promise<Response> {
  const request = proxyRequest(input, init);
  const lease = acquireDispatcher(
    routeKey,
    selectProxy,
    proxyFailureMessage,
  );
  let proxyFailureDetected = false;
  const requestDispatcher = {
    dispatch(
      options: Parameters<Dispatcher["dispatch"]>[0],
      handler: Parameters<Dispatcher["dispatch"]>[1],
    ): boolean {
      return lease.dispatcher.dispatch(options, handler, () => {
        proxyFailureDetected = true;
      });
    },
  };
  const throwNetworkError = (error: unknown): never => {
    throwIfAborted(request.init.signal ?? undefined);
    if (proxyFailureDetected && proxyFailureMessage !== undefined) {
      throw new NetworkProxyError(proxyFailureMessage);
    }
    throw error;
  };
  try {
    const response = hostFetch(request.url, {
      ...request.init,
      dispatcher: requestDispatcher,
    } as unknown as RequestInit & { dispatcher: Dispatcher })
      .catch(throwNetworkError);
    return response.finally(lease.release);
  } catch (error) {
    lease.release();
    return throwNetworkError(error);
  }
}

function acquireDispatcher(
  routeKey: string,
  selectProxy: (target: URL) => string | null,
  proxyFailureMessage?: string,
): { dispatcher: NetworkRoutingDispatcher; release: () => void } {
  let entry = activeDispatcher;
  const routingKey = JSON.stringify([routeKey, proxyFailureMessage ?? null]);
  if (entry?.routeKey !== routingKey) {
    if (entry) {
      entry.retired = true;
      closeRetiredDispatcher(entry);
    }
    entry = {
      refs: 0,
      retired: false,
      routeKey: routingKey,
      value: new NetworkRoutingDispatcher(selectProxy, proxyFailureMessage),
    };
    activeDispatcher = entry;
  }
  entry.refs += 1;
  let released = false;
  return {
    dispatcher: entry.value,
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      closeRetiredDispatcher(entry);
    },
  };
}

function closeRetiredDispatcher(entry: RoutingDispatcherEntry): void {
  if (!entry.retired || entry.refs !== 0) return;
  void entry.value.close().catch(() => undefined);
}

class NetworkRoutingDispatcher {
  private readonly direct = new Agent();
  private readonly proxies = new Map<string, Dispatcher>();

  constructor(
    private readonly selectProxy: (target: URL) => string | null,
    private readonly proxyFailureMessage: string | undefined,
  ) {}

  dispatch(
    options: Parameters<Dispatcher["dispatch"]>[0],
    handler: Parameters<Dispatcher["dispatch"]>[1],
    onProxyFailure: () => void = () => undefined,
  ): boolean {
    if (options.origin === undefined) {
      throw new TypeError("Network dispatcher origin is required.");
    }
    const target = new URL(options.origin);
    const proxyUrl = this.selectProxy(target);
    let dispatcher = this.direct;
    if (proxyUrl !== null) {
      const existing = this.proxies.get(proxyUrl);
      if (existing) dispatcher = existing;
      else {
        dispatcher = new ProxyAgent(proxyUrl);
        this.proxies.set(proxyUrl, dispatcher);
      }
    }
    return dispatcher.dispatch(
      options,
      proxyUrl === null || this.proxyFailureMessage === undefined
        ? handler
        : new NetworkProxyFailureHandler(
            handler,
            this.proxyFailureMessage,
            onProxyFailure,
          ),
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.direct.close(),
      ...[...this.proxies.values()].map((dispatcher) => dispatcher.close()),
    ]);
  }
}

class NetworkProxyFailureHandler {
  private readonly handler: DispatchHandler;
  private responseHeadersReceived = false;

  constructor(
    handler: DispatchHandler,
    private readonly message: string,
    private readonly onProxyFailure: () => void,
  ) {
    this.handler = WrapHandler.wrap(handler);
  }

  onRequestStart(
    ...args: Parameters<NonNullable<DispatchHandler["onRequestStart"]>>
  ): void {
    this.handler.onRequestStart?.(...args);
  }

  onResponseStarted(
    ...args: Parameters<NonNullable<DispatchHandler["onResponseStarted"]>>
  ): void {
    this.handler.onResponseStarted?.(...args);
  }

  onRequestUpgrade(
    ...args: Parameters<NonNullable<DispatchHandler["onRequestUpgrade"]>>
  ): void {
    this.responseHeadersReceived = true;
    this.handler.onRequestUpgrade?.(...args);
  }

  onResponseStart(
    ...args: Parameters<NonNullable<DispatchHandler["onResponseStart"]>>
  ): void {
    this.responseHeadersReceived = true;
    this.handler.onResponseStart?.(...args);
  }

  onResponseData(
    ...args: Parameters<NonNullable<DispatchHandler["onResponseData"]>>
  ): void {
    this.handler.onResponseData?.(...args);
  }

  onResponseEnd(
    ...args: Parameters<NonNullable<DispatchHandler["onResponseEnd"]>>
  ): void {
    this.handler.onResponseEnd?.(...args);
  }

  onResponseError(
    ...args: Parameters<NonNullable<DispatchHandler["onResponseError"]>>
  ): void {
    const [controller, error] = args;
    this.handler.onResponseError?.(
      controller,
      this.proxyErrorBeforeResponse(error),
    );
  }

  private proxyErrorBeforeResponse(error: Error): Error {
    if (this.responseHeadersReceived) return error;
    this.onProxyFailure();
    return new NetworkProxyError(this.message);
  }
}

function proxyRequest(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
): { url: string | URL; init: RequestInit } {
  if (typeof input === "string" || input instanceof URL) {
    return { url: input, init: init ?? {} };
  }
  const inherited: RequestInit = {
    method: input.method,
    headers: input.headers,
    mode: input.mode,
    credentials: input.credentials,
    cache: input.cache,
    redirect: input.redirect,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    integrity: input.integrity,
    keepalive: input.keepalive,
    signal: input.signal,
    ...(input.body === null ? {} : { body: input.body }),
  };
  const definedInit = Object.fromEntries(
    Object.entries(init ?? {}).filter(([, value]) => value !== undefined),
  ) as RequestInit;
  const merged = {
    ...inherited,
    ...definedInit,
  } as RequestInit & { duplex?: "half" };
  if (merged.body !== undefined && merged.body !== null) {
    merged.duplex = "half";
  }
  return { url: input.url, init: merged };
}
