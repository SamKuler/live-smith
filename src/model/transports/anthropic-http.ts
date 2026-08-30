import { URL } from "node:url";
import { validateHeaderValue } from "node:http";

import {
  assertApiKeyCanBeUsedInHttpHeader,
  requireDirectApiConnection,
  type DirectApiConnection,
  type DraftProfile,
} from "../profile.js";
import type { RuntimeProfileIdentity } from "../provider.js";
import { throwIfAborted } from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import {
  assertServerSentEventResponse,
  parseServerSentEventData,
} from "./server-sent-events.js";
import { readBoundedJsonResponse } from "./response-body.js";
import { providerRetryAfterMs } from "./retry-after.js";
import { cancelStreamBestEffort } from "./stream-cancel.js";

const anthropicApiVersion = "2023-06-01";

interface AnthropicRequestOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export async function requestAnthropicJson(
  profile: RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  resource: "/messages",
  options: AnthropicRequestOptions,
): Promise<unknown> {
  return requestAnthropicResource(profile, fetchImpl, resource, options);
}

export async function requestAnthropicModelPage(
  profile: DraftProfile,
  fetchImpl: typeof fetch,
  query: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestAnthropicResource(profile, fetchImpl, "/models", {
    method: "GET",
    query,
    ...(signal ? { signal } : {}),
  });
}

async function requestAnthropicResource(
  profile: DraftProfile | RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  resource: "/messages" | "/models",
  options: AnthropicRequestOptions,
): Promise<unknown> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchAnthropicResponse(
    fetchImpl,
    anthropicEndpoint(connection.baseUrl, resource, options.query),
    anthropicRequestInit(connection, options, requestHeadersFor(profile)),
    options.signal,
    resource !== "/models",
  );
  await assertAnthropicResponse(response, options.signal);
  return readBoundedJsonResponse(response, {
    label: "Anthropic",
    ...(options.signal ? { signal: options.signal } : {}),
    connectionFailureOnRead: resource !== "/models",
  });
}

export async function* streamAnthropicEvents(
  profile: RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchAnthropicResponse(
    fetchImpl,
    anthropicEndpoint(connection.baseUrl, "/messages"),
    anthropicRequestInit(connection, {
      method: "POST",
      body: { ...body, stream: true },
      ...(signal ? { signal } : {}),
    }, requestHeadersFor(profile)),
    signal,
    true,
  );
  await assertAnthropicResponse(response, signal);
  if (!response.body) {
    throwIfAborted(signal);
    throw new Error("Anthropic returned a streaming response without a body.");
  }
  assertServerSentEventResponse(response, "Anthropic", signal);

  for await (const data of parseServerSentEventData(response.body, signal)) {
    throwIfAborted(signal);
    if (data === "[DONE]") {
      throw new Error(
        "Anthropic stream sent [DONE] before its protocol terminal event.",
      );
    }
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("Anthropic returned invalid JSON in its event stream.");
    }
    if (!isRecord(event)) {
      throw new Error("Anthropic returned a non-object event in its event stream.");
    }
    yield event;
  }
}

async function fetchAnthropicResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  connectionFailure = false,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    throwIfAborted(signal);
    if (cause instanceof NetworkProxyError) throw cause;
    if (connectionFailure) throw new ModelConnectionError();
    throw cause;
  }
}

function anthropicEndpoint(
  baseUrl: string,
  resource: "/messages" | "/models",
  query: Readonly<Record<string, string>> = {},
): string {
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const versionedPath = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
  endpoint.pathname = `${versionedPath}${resource}`;
  endpoint.hash = "";
  for (const [key, value] of Object.entries(query)) {
    endpoint.searchParams.set(key, value);
  }
  return endpoint.toString();
}

function anthropicRequestInit(
  connection: DirectApiConnection,
  options: AnthropicRequestOptions,
  requestHeaders: Readonly<Record<string, string>> | undefined,
): RequestInit {
  assertApiKeyCanBeUsedInHttpHeader(connection.apiKey);
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": anthropicApiVersion,
    "content-type": "application/json",
  };
  if (connection.apiKey && requestHeaders?.authorization === undefined) {
    headers["x-api-key"] = connection.apiKey;
  }
  mergeRequestHeaders(headers, requestHeaders);
  const init: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  return init;
}

function mergeRequestHeaders(
  target: Record<string, string>,
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    try {
      validateHeaderValue(name, value);
    } catch {
      throw new Error("OAuth request headers contain an invalid value.");
    }
    target[name] = value;
  }
}

function requestHeadersFor(
  profile: DraftProfile | RuntimeProfileIdentity,
): Readonly<Record<string, string>> | undefined {
  return "requestHeaders" in profile ? profile.requestHeaders : undefined;
}

async function assertAnthropicResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (response.ok) return;
  cancelStreamBestEffort(response.body, signal?.reason);
  throwIfAborted(signal);
  if (response.status === 401) {
    throw new ModelAuthenticationError("Anthropic HTTP 401: request failed");
  }
  const message = `Anthropic HTTP ${response.status}: request failed`;
  const retryAfterMs = providerRetryAfterMs(response.headers);
  const shouldRetry = response.headers.get("x-should-retry");
  if (shouldRetry === "false") throw new Error(message);
  if (
    shouldRetry === "true" ||
    response.status === 408 ||
    response.status === 409 ||
    (response.status === 429 && retryAfterMs !== undefined) ||
    response.status >= 500
  ) {
    throw new ModelRetryableError(message, retryAfterMs);
  }
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
