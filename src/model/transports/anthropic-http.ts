import { URL } from "node:url";

import {
  requireDirectApiConnection,
  type DirectApiConnection,
  type DraftProfile,
  type SavedProfile,
} from "../profile.js";
import { throwIfAborted } from "../../runtime/host.js";
import { ModelConnectionError } from "../connection-error.js";
import {
  assertServerSentEventResponse,
  parseServerSentEventData,
} from "./server-sent-events.js";
import { readBoundedJsonResponse } from "./response-body.js";
import { cancelStreamBestEffort } from "./stream-cancel.js";

const anthropicApiVersion = "2023-06-01";

interface AnthropicRequestOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export async function requestAnthropicJson(
  profile: SavedProfile,
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
  profile: DraftProfile | SavedProfile,
  fetchImpl: typeof fetch,
  resource: "/messages" | "/models",
  options: AnthropicRequestOptions,
): Promise<unknown> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchAnthropicResponse(
    fetchImpl,
    anthropicEndpoint(connection.baseUrl, resource, options.query),
    anthropicRequestInit(connection, options),
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
  profile: SavedProfile,
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
    }),
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
): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": anthropicApiVersion,
    "content-type": "application/json",
  };
  if (connection.apiKey) headers["x-api-key"] = connection.apiKey;
  const init: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  return init;
}

async function assertAnthropicResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (response.ok) return;
  cancelStreamBestEffort(response.body, signal?.reason);
  throwIfAborted(signal);
  throw new Error(`Anthropic HTTP ${response.status}: request failed`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
