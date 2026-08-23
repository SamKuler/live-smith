import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import { resolveModelCapabilities } from "../capabilities.js";
import { ModelConnectionError } from "../connection-error.js";
import type { SavedProfile } from "../profile.js";
import type { ModelTransport, TransportRequest } from "../provider.js";
import { createAnthropicMessagesTransport } from "./anthropic-messages.js";
import { withTransportContext } from "./errors.js";
import { createOpenAIChatTransport } from "./openai-chat.js";
import { createOpenAIResponsesTransport } from "./openai-responses.js";
import { MAX_DIRECT_JSON_RESPONSE_BYTES } from "./response-body.js";
import { MAX_DIRECT_SSE_EVENT_BYTES } from "./server-sent-events.js";

function openAIProfile(
  apiMode: "responses" | "chat-completions" = "responses",
): SavedProfile {
  return {
    id: `openai-${apiMode}-connection-test`,
    name: `OpenAI ${apiMode} connection test`,
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode,
      baseUrl: "https://example.test/v1?token=private-query-token",
      apiKey: "private-api-key",
    },
    model: "test-model",
    parameters: {
      maxOutputTokens: 1024,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

function anthropicProfile(): SavedProfile {
  return {
    id: "anthropic-connection-test",
    name: "Anthropic connection test",
    connection: {
      kind: "direct-api",
      apiFamily: "anthropic",
      apiMode: "messages",
      baseUrl: "https://example.test?token=private-query-token",
      apiKey: "private-api-key",
    },
    model: "claude-test",
    parameters: {
      maxOutputTokens: 1024,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

function request(
  profile: SavedProfile,
  options: {
    signal?: AbortSignal;
    streaming?: boolean;
    onDelta?: (delta: string) => Promise<void> | void;
  } = {},
): TransportRequest {
  return {
    runtimeProfile: {
      profile,
      capabilities: resolveModelCapabilities(profile),
      inputCapabilityEvidence: {
        image: "unverified",
        audio: "unverified",
        pdf: "unverified",
      },
    },
    currentUserContent: [{ type: "text", text: "Inspect the selected clip." }],
    systemInstructions: "Test system instructions",
    history: [],
    agentMessages: [],
    tools: [],
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.streaming
      ? { onDelta: options.onDelta ?? (() => undefined) }
      : {}),
  };
}

function directCases(
  fetchImpl: typeof fetch,
): Array<{ name: string; profile: SavedProfile; transport: ModelTransport }> {
  return [
    {
      name: "OpenAI Responses",
      profile: openAIProfile(),
      transport: createOpenAIResponsesTransport({ fetchImpl }),
    },
    {
      name: "OpenAI Chat Completions",
      profile: openAIProfile("chat-completions"),
      transport: createOpenAIChatTransport({ fetchImpl }),
    },
    {
      name: "Anthropic Messages",
      profile: anthropicProfile(),
      transport: createAnthropicMessagesTransport({ fetchImpl }),
    },
  ];
}

function assertConnectionError(
  error: unknown,
  context: RegExp,
  forbidden?: string,
): boolean {
  assert.ok(error instanceof ModelConnectionError);
  assert.match(error.message, context);
  if (forbidden) assert.equal(error.message.includes(forbidden), false);
  assert.equal((error as { cause?: unknown }).cause, undefined);
  return true;
}

function assertOrdinaryError(
  error: unknown,
  expected?: RegExp,
  forbidden?: string,
): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error instanceof ModelConnectionError, false);
  if (expected) assert.match(error.message, expected);
  if (forbidden) assert.equal(error.message.includes(forbidden), false);
  return true;
}

function sseResponse(payload: string | ReadableStream<Uint8Array>): Response {
  return new Response(payload as never, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function erroredBody(secret: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(secret));
    },
  });
}

test("transport context preserves safe connection-error identity", async () => {
  const profile = openAIProfile();

  await assert.rejects(
    withTransportContext(profile, "request", async () => {
      throw new ModelConnectionError(
        "connection interrupted private-api-key private-query-token",
      );
    }),
    (error: unknown) => assertConnectionError(
      error,
      /^openai\/responses request failed: connection interrupted \[redacted\] \[redacted\]$/,
      "private-api-key",
    ),
  );
});

test("generation fetch rejection is typed in every Direct mode", async () => {
  const secret = "private-fetch-failure";
  const fetchImpl = (async () => {
    throw new Error(secret);
  }) as typeof fetch;

  for (const item of directCases(fetchImpl)) {
    await assert.rejects(
      item.transport.createToolTurn(request(item.profile, { streaming: true })),
      (error: unknown) => assertConnectionError(
        error,
        /request failed/i,
        secret,
      ),
      item.name,
    );
  }
});

test("model-discovery fetch rejection remains ordinary", async () => {
  const fetchImpl = (async () => {
    throw new Error("discovery failed");
  }) as typeof fetch;

  for (const item of directCases(fetchImpl)) {
    await assert.rejects(
      item.transport.listModels(item.profile),
      (error: unknown) => assertOrdinaryError(
        error,
        /model discovery failed: discovery failed/,
      ),
      item.name,
    );
  }
});

test("generation response reader rejection is typed for JSON and SSE", async (t) => {
  const secret = "private-reader-failure";

  await t.test("bounded JSON", async () => {
    const fetchImpl = (async () => new Response(erroredBody(secret) as never, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    for (const item of directCases(fetchImpl)) {
      await assert.rejects(
        item.transport.createToolTurn(request(item.profile)),
        (error: unknown) => assertConnectionError(error, /request failed/i, secret),
        item.name,
      );
    }
  });

  await t.test("event stream", async () => {
    const fetchImpl = (async () => sseResponse(erroredBody(secret))) as typeof fetch;
    for (const item of directCases(fetchImpl)) {
      await assert.rejects(
        item.transport.createToolTurn(request(item.profile, { streaming: true })),
        (error: unknown) => assertConnectionError(error, /request failed/i, secret),
        item.name,
      );
    }
  });
});

test("clean EOF before the required terminal is typed in every streaming mode", async () => {
  const fixtures: Array<{
    name: string;
    profile: SavedProfile;
    transport: ModelTransport;
  }> = [
    {
      name: "OpenAI Responses",
      profile: openAIProfile(),
      transport: createOpenAIResponsesTransport({
        fetchImpl: async () => sseResponse(
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "partial",
          })}\n\n`,
        ),
      }),
    },
    {
      name: "OpenAI Chat Completions",
      profile: openAIProfile("chat-completions"),
      transport: createOpenAIChatTransport({
        fetchImpl: async () => sseResponse(
          `data: ${JSON.stringify({
            choices: [{
              index: 0,
              finish_reason: null,
              delta: { content: "partial" },
            }],
          })}\n\n`,
        ),
      }),
    },
    {
      name: "Anthropic Messages",
      profile: anthropicProfile(),
      transport: createAnthropicMessagesTransport({
        fetchImpl: async () => sseResponse([
          { type: "message_start", message: { content: [] } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
      }),
    },
  ];

  for (const item of fixtures) {
    await assert.rejects(
      item.transport.createToolTurn(request(item.profile, { streaming: true })),
      (error: unknown) => assertConnectionError(error, /request failed/i),
      item.name,
    );
  }
});

test("Abort retains exact identity instead of becoming a connection error", async (t) => {
  await t.test("fetch", async () => {
    const controller = createHostAbortController();
    const reason = new Error("steering interrupted fetch");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const transport = createOpenAIResponsesTransport({
      fetchImpl: async (_input, init) => {
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(
            new Error("private fetch rejection after Abort"),
          ), { once: true });
        });
      },
    });
    const pending = transport.createToolTurn(request(openAIProfile(), {
      signal: controller.signal,
      streaming: true,
    }));

    await started;
    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
  });

  await t.test("reader", async () => {
    const controller = createHostAbortController();
    const reason = new Error("Stop interrupted reader");
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markReading();
        return new Promise<void>(() => undefined);
      },
    });
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => sseResponse(body),
    });
    const pending = transport.createToolTurn(request(anthropicProfile(), {
      signal: controller.signal,
      streaming: true,
    }));

    await reading;
    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});

test("HTTP, provider, and early DONE failures remain ordinary", async (t) => {
  await t.test("HTTP status", async () => {
    const fetchImpl = (async () => new Response("untrusted private body", {
      status: 503,
      statusText: "private remote reason",
    })) as typeof fetch;
    for (const item of directCases(fetchImpl)) {
      await assert.rejects(
        item.transport.createToolTurn(request(item.profile)),
        (error: unknown) => assertOrdinaryError(
          error,
          /HTTP 503: request failed/,
          "private remote reason",
        ),
        item.name,
      );
    }
  });

  await t.test("explicit provider stream error", async () => {
    const fixtures = [
      {
        name: "OpenAI Responses",
        profile: openAIProfile(),
        transport: createOpenAIResponsesTransport({
          fetchImpl: async () => sseResponse(
            `data: ${JSON.stringify({ type: "error", error: { message: "private" } })}\n\n`,
          ),
        }),
      },
      {
        name: "OpenAI Chat Completions",
        profile: openAIProfile("chat-completions"),
        transport: createOpenAIChatTransport({
          fetchImpl: async () => sseResponse(
            `data: ${JSON.stringify({ error: { message: "private" } })}\n\n`,
          ),
        }),
      },
      {
        name: "Anthropic Messages",
        profile: anthropicProfile(),
        transport: createAnthropicMessagesTransport({
          fetchImpl: async () => sseResponse(
            `data: ${JSON.stringify({ type: "error", error: { message: "private" } })}\n\n`,
          ),
        }),
      },
    ];
    for (const item of fixtures) {
      await assert.rejects(
        item.transport.createToolTurn(request(item.profile, { streaming: true })),
        (error: unknown) => assertOrdinaryError(error, /stream|Anthropic request failed/i),
        item.name,
      );
    }
  });

  await t.test("DONE before protocol terminal", async () => {
    const fixtures = [
      {
        name: "OpenAI Responses",
        profile: openAIProfile(),
        transport: createOpenAIResponsesTransport({
          fetchImpl: async () => sseResponse("data: [DONE]\n\n"),
        }),
      },
      {
        name: "Anthropic Messages",
        profile: anthropicProfile(),
        transport: createAnthropicMessagesTransport({
          fetchImpl: async () => sseResponse("data: [DONE]\n\n"),
        }),
      },
    ];
    for (const item of fixtures) {
      await assert.rejects(
        item.transport.createToolTurn(request(item.profile, { streaming: true })),
        (error: unknown) => assertOrdinaryError(error, /protocol terminal|invalid JSON/i),
        item.name,
      );
    }
  });
});

test("an explicit incompatible streaming Content-Type is ordinary in every Direct mode", async () => {
  const fetchImpl = (async () => new Response("<html>gateway</html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })) as typeof fetch;

  for (const item of directCases(fetchImpl)) {
    await assert.rejects(
      item.transport.createToolTurn(request(item.profile, { streaming: true })),
      (error: unknown) => assertOrdinaryError(error, /event-stream/i),
      item.name,
    );
  }
});

test("a missing streaming Content-Type remains compatible with valid SSE", async () => {
  const fixtures: Array<{
    name: string;
    profile: SavedProfile;
    payload: string;
    transport(fetchImpl: typeof fetch): ModelTransport;
  }> = [
    {
      name: "OpenAI Responses",
      profile: openAIProfile(),
      payload: `data: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output_text: "Done", output: [] },
      })}\n\n`,
      transport: (fetchImpl) => createOpenAIResponsesTransport({ fetchImpl }),
    },
    {
      name: "OpenAI Chat Completions",
      profile: openAIProfile("chat-completions"),
      payload: `data: ${JSON.stringify({
        choices: [{ finish_reason: "stop", delta: { content: "Done" } }],
      })}\n\n`,
      transport: (fetchImpl) => createOpenAIChatTransport({ fetchImpl }),
    },
    {
      name: "Anthropic Messages",
      profile: anthropicProfile(),
      payload: [
        { type: "message_start", message: { content: [] } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Done" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      transport: (fetchImpl) => createAnthropicMessagesTransport({ fetchImpl }),
    },
  ];

  for (const fixture of fixtures) {
    const fetchImpl = (async () => new Response(
      new TextEncoder().encode(fixture.payload),
      { status: 200 },
    )) as typeof fetch;
    const turn = await fixture.transport(fetchImpl).createToolTurn(
      request(fixture.profile, { streaming: true }),
    );
    assert.equal(turn.content, "Done", fixture.name);
  }
});

test("JSON, protocol, oversize, and callback failures remain ordinary", async (t) => {
  await t.test("malformed JSON response", async () => {
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    await assert.rejects(
      transport.createToolTurn(request(anthropicProfile())),
      (error: unknown) => assertOrdinaryError(error, /invalid JSON/),
    );
  });

  await t.test("malformed SSE JSON", async () => {
    const transport = createOpenAIResponsesTransport({
      fetchImpl: async () => sseResponse("data: {not-json}\n\n"),
    });
    await assert.rejects(
      transport.createToolTurn(request(openAIProfile(), { streaming: true })),
      (error: unknown) => assertOrdinaryError(error, /invalid JSON/),
    );
  });

  await t.test("explicit incomplete protocol terminal", async () => {
    const transport = createOpenAIChatTransport({
      fetchImpl: async () => sseResponse(
        `data: ${JSON.stringify({
          choices: [{ finish_reason: "length", delta: { content: "partial" } }],
        })}\n\n`,
      ),
    });
    await assert.rejects(
      transport.createToolTurn(request(openAIProfile("chat-completions"), {
        streaming: true,
      })),
      (error: unknown) => assertOrdinaryError(error, /finish_reason length/),
    );
  });

  await t.test("declared oversized JSON", async () => {
    const transport = createOpenAIResponsesTransport({
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "Content-Length": String(MAX_DIRECT_JSON_RESPONSE_BYTES + 1),
        },
      }),
    });
    await assert.rejects(
      transport.createToolTurn(request(openAIProfile())),
      (error: unknown) => assertOrdinaryError(error, /larger than/),
    );
  });

  await t.test("oversized SSE event", async () => {
    const oversized = new TextEncoder().encode(
      `data: ${"a".repeat(MAX_DIRECT_SSE_EVENT_BYTES + 1)}`,
    );
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => sseResponse(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      })),
    });
    await assert.rejects(
      transport.createToolTurn(request(anthropicProfile(), { streaming: true })),
      (error: unknown) => assertOrdinaryError(error, /oversized event/),
    );
  });

  await t.test("consumer callback", async () => {
    const callbackFailure = new Error("delta callback failed");
    const transport = createOpenAIResponsesTransport({
      fetchImpl: async () => sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.completed",
          response: { status: "completed", output_text: "partial", output: [] },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
    });
    await assert.rejects(
      transport.createToolTurn(request(openAIProfile(), {
        streaming: true,
        onDelta: () => {
          throw callbackFailure;
        },
      })),
      (error: unknown) => assertOrdinaryError(error, /delta callback failed/),
    );
  });
});
