import { URL } from "node:url";

import { throwIfAborted } from "../../runtime/host.js";
import type { DraftProfile, SavedProfile } from "../profile.js";
import { parseServerSentEventData } from "./server-sent-events.js";

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
  const response = await fetchImpl(
    openAIEndpoint(profile.baseUrl, resource),
    openAIRequestInit(profile, options),
  );
  await assertOpenAIResponse(response, options.signal);
  try {
    return await response.json() as unknown;
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof SyntaxError) {
      throw new Error(`OpenAI-compatible endpoint returned invalid JSON (HTTP ${response.status}).`);
    }
    throw cause;
  }
}

export async function* streamOpenAIEvents(
  profile: SavedProfile,
  fetchImpl: typeof fetch,
  resource: "/chat/completions" | "/responses",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const response = await fetchImpl(
    openAIEndpoint(profile.baseUrl, resource),
    openAIRequestInit(profile, {
      method: "POST",
      body: { ...body, stream: true },
      ...(signal ? { signal } : {}),
    }),
  );
  await assertOpenAIResponse(response, signal);
  if (!response.body) {
    throw new Error("OpenAI-compatible endpoint returned a streaming response without a body.");
  }

  for await (const data of parseServerSentEventData(response.body)) {
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
  profile: DraftProfile | SavedProfile,
  options: OpenAIRequestOptions,
): RequestInit {
  const init: RequestInit = {
    method: options.method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${profile.apiKey}`,
      "content-type": "application/json",
    },
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
  throwIfAborted(signal);
  const detail = response.statusText || "request failed";
  await response.body?.cancel().catch(() => undefined);
  throwIfAborted(signal);
  throw new Error(`OpenAI-compatible HTTP ${response.status}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
