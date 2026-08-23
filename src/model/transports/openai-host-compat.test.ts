import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import test from "node:test";

import { resolveModelCapabilities } from "../capabilities.js";
import type { SavedProfile } from "../profile.js";
import type { TransportRequest } from "../provider.js";
import { createOpenAIChatTransport } from "./openai-chat.js";
import { createOpenAIResponsesTransport } from "./openai-responses.js";

const ambientWebNames = [
  "AbortController",
  "Blob",
  "fetch",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "URL",
] as const;

test("OpenAI discovery and both streaming modes avoid ambient Web APIs", async () => {
  const descriptors = new Map(
    ambientWebNames.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of ambientWebNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: undefined,
      writable: true,
    });
  }

  try {
    const chat = createOpenAIChatTransport({ fetchImpl: hostSafeFetch });
    const responses = createOpenAIResponsesTransport({ fetchImpl: hostSafeFetch });

    const models = await chat.listModels(profile("chat-completions"));
    assert.equal(models[0]?.id, "host-safe-model");

    const chatTurn = await chat.createToolTurn(
      request(profile("chat-completions")),
    );
    assert.equal(chatTurn.content, "chat safe");

    const responsesTurn = await responses.createToolTurn(
      request(profile("responses")),
    );
    assert.equal(responsesTurn.content, "responses safe");
  } finally {
    for (const name of ambientWebNames) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

function profile(apiMode: "chat-completions" | "responses"): SavedProfile {
  return {
    id: apiMode,
    name: apiMode,
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode,
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
    },
    model: "host-safe-model",
    parameters: {
      maxOutputTokens: 1024,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

function request(profileValue: SavedProfile): TransportRequest {
  return {
    runtimeProfile: {
      profile: profileValue,
      capabilities: resolveModelCapabilities(profileValue),
      inputCapabilityEvidence: {
        image: "unverified",
        audio: "unverified",
        pdf: "unverified",
      },
    },
    currentUserContent: [{ type: "text", text: "test" }],
    systemInstructions: "test instructions",
    history: [],
    agentMessages: [],
    tools: [],
    onDelta: () => {},
  };
}

const hostSafeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/models")) {
    return jsonResponse({ data: [{ id: "host-safe-model" }] });
  }
  if (url.endsWith("/chat/completions")) {
    return eventStreamResponse([
      { choices: [{ finish_reason: "stop", delta: { content: "chat safe" } }] },
    ]);
  }
  if (url.endsWith("/responses")) {
    return eventStreamResponse([
      { type: "response.output_text.delta", delta: "responses safe" },
      {
        type: "response.completed",
        response: { output_text: "responses safe", output: [] },
      },
    ]);
  }
  throw new Error(`Unexpected URL ${url}`);
}) as typeof fetch;

function jsonResponse(value: unknown): Response {
  const bytes = NodeBuffer.from(JSON.stringify(value), "utf8");
  let sent = false;
  return {
    body: {
      getReader: () => ({
        cancel: async () => {},
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
      }),
    },
    ok: true,
    status: 200,
    statusText: "OK",
  } as unknown as Response;
}

function eventStreamResponse(events: Record<string, unknown>[]): Response {
  const bytes = NodeBuffer.from(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    "utf8",
  );
  let sent = false;
  return {
    body: {
      getReader: () => ({
        cancel: async () => {},
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
      }),
    },
    ok: true,
    status: 200,
    statusText: "OK",
  } as unknown as Response;
}
