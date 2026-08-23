import { URL } from "node:url";

import { throwIfAborted } from "../../runtime/host.js";
import {
  requireDirectApiConnection,
  type DirectApiConnection,
  type DraftProfile,
  type SavedProfile,
} from "../profile.js";
import { parseServerSentEventData } from "./server-sent-events.js";
import { readBoundedJsonResponse } from "./response-body.js";
import { cancelStreamBestEffort } from "./stream-cancel.js";

type OpenAIResource = "/models" | "/chat/completions" | "/responses";

interface OpenAIRequestOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function requestOpenAIJson(
  profile: SavedProfile,
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
  profile: DraftProfile | SavedProfile,
  fetchImpl: typeof fetch,
  resource: OpenAIResource,
  options: OpenAIRequestOptions,
): Promise<unknown> {
  const connection = requireDirectApiConnection(profile);
  const response = await fetchOpenAIResponse(
    fetchImpl,
    openAIEndpoint(connection.baseUrl, resource),
    openAIRequestInit(connection, options),
    options.signal,
  );
  await assertOpenAIResponse(response, options.signal);
  return readBoundedJsonResponse(response, {
    label: "OpenAI-compatible endpoint",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function* streamOpenAIEvents(
  profile: SavedProfile,
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
    }),
    signal,
  );
  await assertOpenAIResponse(response, signal);
  if (!response.body) {
    throwIfAborted(signal);
    throw new Error("OpenAI-compatible endpoint returned a streaming response without a body.");
  }

  for await (const data of parseServerSentEventData(response.body, signal)) {
    throwIfAborted(signal);
    if (data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("OpenAI-compatible endpoint returned invalid JSON in its event stream.");
    }
    if (!isRecord(event)) {
      throw new Error("OpenAI-compatible endpoint returned a non-object event in its event stream.");
    }
    if (isOpenAIStreamError(event)) {
      throw new Error("OpenAI-compatible stream error.");
    }
    yield event;
  }
}

async function fetchOpenAIResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    throwIfAborted(signal);
    throw cause;
  }
}

function isOpenAIStreamError(event: Record<string, unknown>): boolean {
  return "error" in event || event.type === "error";
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
): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  const init: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  return init;
}

async function assertOpenAIResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (response.ok) return;
  cancelStreamBestEffort(response.body, signal?.reason);
  throwIfAborted(signal);
  throw new Error(`OpenAI-compatible HTTP ${response.status}: request failed`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
