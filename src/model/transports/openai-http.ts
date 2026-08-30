import { URL } from "node:url";
import { validateHeaderValue } from "node:http";

import { throwIfAborted } from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import {
  assertApiKeyCanBeUsedInHttpHeader,
  requireDirectApiConnection,
  type DirectApiConnection,
  type DraftProfile,
} from "../profile.js";
import type { RuntimeProfileIdentity } from "../provider.js";
import {
  assertServerSentEventResponse,
  parseServerSentEventData,
} from "./server-sent-events.js";
import { readBoundedJsonResponse } from "./response-body.js";
import {
  openAIErrorCode,
  openAIProviderFailure,
} from "./openai-errors.js";
import { providerRetryAfterMs } from "./retry-after.js";
import { cancelStreamBestEffort } from "./stream-cancel.js";

type OpenAIResource = "/models" | "/chat/completions" | "/responses";

interface OpenAIRequestOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function requestOpenAIJson(
  profile: RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  resource: Exclude<OpenAIResource, "/models">,
  options: OpenAIRequestOptions,
): Promise<unknown> {
  return requestOpenAIResource(profile, fetchImpl, resource, options);
}

export async function discoverOpenAIModels(
  profile: DraftProfile,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestOpenAIResource(profile, fetchImpl, "/models", {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
}

async function requestOpenAIResource(
  profile: DraftProfile | RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  resource: OpenAIResource,
  options: OpenAIRequestOptions,
): Promise<unknown> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchOpenAIResponse(
    fetchImpl,
    openAIEndpoint(connection.baseUrl, resource),
    openAIRequestInit(connection, options, requestHeadersFor(profile)),
    options.signal,
    resource !== "/models",
  );
  await assertOpenAIResponse(response, options.signal, resource !== "/models");
  return readBoundedJsonResponse(response, {
    label: "OpenAI-compatible endpoint",
    ...(options.signal ? { signal: options.signal } : {}),
    connectionFailureOnRead: resource !== "/models",
  });
}

export async function* streamOpenAIEvents(
  profile: RuntimeProfileIdentity,
  fetchImpl: typeof fetch,
  resource: "/chat/completions" | "/responses",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchOpenAIResponse(
    fetchImpl,
    openAIEndpoint(connection.baseUrl, resource),
    openAIRequestInit(connection, {
      method: "POST",
      body: { ...body, stream: true },
      ...(signal ? { signal } : {}),
    }, requestHeadersFor(profile)),
    signal,
    true,
  );
  await assertOpenAIResponse(response, signal, true);
  if (!response.body) {
    throwIfAborted(signal);
    throw new Error("OpenAI-compatible endpoint returned a streaming response without a body.");
  }
  assertServerSentEventResponse(response, "OpenAI-compatible endpoint", signal);

  for await (const data of parseServerSentEventData(response.body, signal)) {
    throwIfAborted(signal);
    if (data === "[DONE]") {
      throw new Error(
        "OpenAI-compatible stream sent [DONE] before its protocol terminal event.",
      );
    }
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("OpenAI-compatible endpoint returned invalid JSON in its event stream.");
    }
    if (!isRecord(event)) {
      throw new Error("OpenAI-compatible endpoint returned a non-object event in its event stream.");
    }
    yield event;
  }
}

async function fetchOpenAIResponse(
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

function openAIEndpoint(baseUrl: string, resource: OpenAIResource): string {
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${basePath}${resource}`;
  endpoint.hash = "";
  return endpoint.toString();
}

function openAIRequestInit(
  connection: DirectApiConnection,
  options: OpenAIRequestOptions,
  requestHeaders: Readonly<Record<string, string>> | undefined,
): RequestInit {
  assertApiKeyCanBeUsedInHttpHeader(connection.apiKey);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
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

async function assertOpenAIResponse(
  response: Response,
  signal?: AbortSignal,
  generationRequest = false,
): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    cancelStreamBestEffort(response.body, signal?.reason);
    throwIfAborted(signal);
    throw new ModelAuthenticationError("OpenAI-compatible HTTP 401: request failed");
  }
  if (!generationRequest) {
    cancelStreamBestEffort(response.body, signal?.reason);
    throwIfAborted(signal);
    throw new Error(`OpenAI-compatible HTTP ${response.status}: request failed`);
  }
  const retryAfterMs = providerRetryAfterMs(response.headers);
  if (
    response.status === 408 ||
    response.status === 409 ||
    response.status >= 500
  ) {
    cancelStreamBestEffort(response.body, signal?.reason);
    throwIfAborted(signal);
    throw new ModelRetryableError(
      `OpenAI-compatible HTTP ${response.status}: retryable failure`,
      retryAfterMs,
    );
  }
  const payload = await readOpenAIErrorPayload(response, signal);
  if (response.status === 429) {
    throw openAIProviderFailure(payload, "OpenAI-compatible endpoint", {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      unknownIsRetryable: true,
    });
  }
  if (openAIErrorCode(payload) !== undefined) {
    throw openAIProviderFailure(payload, "OpenAI-compatible endpoint");
  }
  throwIfAborted(signal);
  throw new Error(`OpenAI-compatible HTTP ${response.status}: request failed`);
}

async function readOpenAIErrorPayload(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await readBoundedJsonResponse(response, {
      label: "OpenAI-compatible error response",
      maximumBytes: 64 * 1024,
      ...(signal ? { signal } : {}),
    });
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
