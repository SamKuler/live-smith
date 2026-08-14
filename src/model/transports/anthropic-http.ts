import { URL } from "node:url";

import type { DraftProfile, SavedProfile } from "../profile.js";
import { throwIfAborted } from "../../runtime/host.js";
import { parseServerSentEventData } from "./server-sent-events.js";

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
  const response = await fetchImpl(
    anthropicEndpoint(profile.baseUrl, resource, options.query),
    anthropicRequestInit(profile, options),
  );
  await assertAnthropicResponse(response, options.signal);
  try {
    return await response.json() as unknown;
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof SyntaxError) {
      throw new Error(`Anthropic returned invalid JSON (HTTP ${response.status}).`);
    }
    throw cause;
  }
}

export async function* streamAnthropicEvents(
  profile: SavedProfile,
  fetchImpl: typeof fetch,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const response = await fetchImpl(
    anthropicEndpoint(profile.baseUrl, "/messages"),
    anthropicRequestInit(profile, {
      method: "POST",
      body: { ...body, stream: true },
      ...(signal ? { signal } : {}),
    }),
  );
  await assertAnthropicResponse(response, signal);
  if (!response.body) {
    throw new Error("Anthropic returned a streaming response without a body.");
  }

  for await (const data of parseServerSentEventData(response.body, signal)) {
    throwIfAborted(signal);
    if (data === "[DONE]") return;
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
  profile: DraftProfile | SavedProfile,
  options: AnthropicRequestOptions,
): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": anthropicApiVersion,
    "content-type": "application/json",
  };
  if (profile.apiKey) headers["x-api-key"] = profile.apiKey;
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
  throwIfAborted(signal);
  const detail = response.statusText || "request failed";
  await response.body?.cancel().catch(() => undefined);
  throwIfAborted(signal);
  throw new Error(`Anthropic HTTP ${response.status}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
