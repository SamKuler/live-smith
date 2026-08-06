import assert from "node:assert/strict";
import { setTimeout as scheduleTimeout, clearTimeout } from "node:timers";
import { TextEncoder } from "node:util";
import test from "node:test";

import type { ModelConversationMessage } from "../contracts.js";
import { resolveModelCapabilities } from "../capabilities.js";
import type { SavedProfile } from "../profile.js";
import type { TransportRequest } from "../provider.js";
import { createOpenAIChatTransport } from "./openai-chat.js";

function profile(overrides: Partial<SavedProfile> = {}): SavedProfile {
  return {
    id: "p1",
    name: "Compatible",
    apiFamily: "openai",
    apiMode: "chat-completions",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    model: "custom-model",
    parameters: {
      maxOutputTokens: 4096,
      temperature: 0.4,
      reasoning: { mode: "default" },
    },
    advanced: {},
    ...overrides,
  };
}

function request(
  p: SavedProfile,
  agentMessages: ModelConversationMessage[] = [],
): TransportRequest {
  return {
    runtimeProfile: {
      profile: p,
      capabilities: resolveModelCapabilities(p),
    },
    prompt: "inspect the clip",
    liveContext: "Track: Drums",
    systemInstructions: "Test system instructions",
    history: [],
    agentMessages,
    tools: [{
      type: "function",
      function: { name: "inspect", description: "Inspect Live", parameters: { type: "object" } },
    }],
  };
}

test("OpenAI Chat maps standard parameters and preserves raw assistant state", async () => {
  let body: Record<string, unknown> = {};
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;
  const transport = createOpenAIChatTransport({
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: "custom-model",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "opaque reasoning",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "inspect", arguments: "{}" },
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const turn = await transport.createToolTurn(request(profile()));
  assert.equal(requestUrl, "https://example.test/v1/chat/completions");
  assert.equal(
    (requestHeaders as Record<string, string>).authorization,
    "Bearer secret",
  );
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(
    (body.messages as Array<{ content?: string }>)[0]?.content,
    "Test system instructions",
  );
  assert.match(
    String((body.messages as Array<{ content?: string }>)[1]?.content),
    /Live context \(untrusted data.*"Track: Drums"/s,
  );
  assert.equal(body.temperature, 0.4);
  assert.equal(Array.isArray(body.tools), true);
  assert.equal(turn.toolCalls[0]?.id, "call-1");
  assert.equal(
    (turn.providerState as { message: { reasoning_content: string } }).message.reasoning_content,
    "opaque reasoning",
  );
});

test("OpenAI Chat replays the raw assistant message before tool results", async () => {
  let messages: Array<Record<string, unknown>> = [];
  const transport = createOpenAIChatTransport({
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      messages = body.messages;
      return new Response(JSON.stringify({
        id: "chat-2",
        object: "chat.completion",
        created: 1,
        model: "custom-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await transport.createToolTurn(request(profile(), [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "inspect", arguments: "{}" }],
      providerState: {
        kind: "openai-chat",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "opaque",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }],
        },
      },
    },
    { role: "tool", toolCallId: "call-1", content: "result" },
  ]));
  const assistantIndex = messages.findIndex((message) => message.reasoning_content === "opaque");
  assert.ok(assistantIndex >= 0);
  assert.equal(messages[assistantIndex + 1]?.role, "tool");
});

test("Extra Body may override generation fields but not structural Chat fields", async () => {
  const p = profile({ advanced: { extraBody: { temperature: 0.9, messages: [] } } });
  const transport = createOpenAIChatTransport({
    fetchImpl: async () => {
      throw new Error("network must not be reached");
    },
  });
  await assert.rejects(
    transport.createToolTurn(request(p)),
    /protected field messages/,
  );
});

test("OpenAI Chat rejects non-streaming incomplete finish reasons", async () => {
  for (const finishReason of ["length", "content_filter", "function_call", null]) {
    const transport = createOpenAIChatTransport({
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{
          index: 0,
          finish_reason: finishReason,
          message: { role: "assistant", content: "Partial" },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    await assert.rejects(
      transport.createToolTurn(request(profile())),
      finishReason === null
        ? /finish_reason.*before completion/i
        : new RegExp(`finish_reason ${finishReason}`),
    );
  }
});

test("OpenAI Chat rejects streaming incomplete finish reasons", async () => {
  for (const finishReason of ["length", "content_filter", "function_call", null]) {
    const chunk = {
      choices: [{
        index: 0,
        finish_reason: finishReason,
        delta: { role: "assistant", content: "Partial" },
      }],
    };
    const sse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
    const transport = createOpenAIChatTransport({
      fetchImpl: async () => new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      finishReason === null
        ? /finish_reason.*before completion/i
        : new RegExp(`finish_reason ${finishReason}`),
    );
  }
});

test("OpenAI Chat rejects missing, empty, and duplicate tool-call IDs in both response modes", async () => {
  const invalidCallIds: Array<Array<string | undefined>> = [
    [undefined],
    [""],
    ["duplicate", "duplicate"],
  ];

  for (const streaming of [false, true]) {
    for (const callIds of invalidCallIds) {
      const toolCalls = callIds.map((callId, index) => ({
        ...(streaming ? { index } : {}),
        ...(callId === undefined ? {} : { id: callId }),
        type: "function",
        function: { name: `inspect_${index}`, arguments: "{}" },
      }));
      const payload = streaming
        ? `data: ${JSON.stringify({
            choices: [{
              index: 0,
              finish_reason: "tool_calls",
              delta: { role: "assistant", content: null, tool_calls: toolCalls },
            }],
          })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({
            choices: [{
              index: 0,
              finish_reason: "tool_calls",
              message: { role: "assistant", content: null, tool_calls: toolCalls },
            }],
          });
      const transport = createOpenAIChatTransport({
        fetchImpl: async () => new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": streaming ? "text/event-stream" : "application/json",
          },
        }),
      });
      const req = request(profile());
      if (streaming) req.onDelta = () => {};

      await assert.rejects(
        transport.createToolTurn(req),
        /tool call ID/i,
      );
    }
  }
});

test("OpenAI Chat streaming emits text and assembles fragmented tool calls", async () => {
  const deltas: string[] = [];
  const chunks = [
    {
      id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "custom-model",
      choices: [{ index: 0, finish_reason: null, delta: {
        role: "assistant", content: "Working ", reasoning_content: "opaque ",
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: "{" } }],
      } }],
    },
    {
      id: "chunk-2", object: "chat.completion.chunk", created: 1, model: "custom-model",
      choices: [{ index: 0, finish_reason: "tool_calls", delta: {
        content: null, reasoning_content: "state",
        tool_calls: [{ index: 0, function: { arguments: "}" } }],
      } }],
    },
  ];
  const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  const transport = createOpenAIChatTransport({
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  const req = request(profile());
  req.onDelta = (delta) => {
    deltas.push(delta);
  };
  const turn = await transport.createToolTurn(req);
  assert.deepEqual(deltas, ["Working "]);
  assert.deepEqual(turn.toolCalls, [{ id: "call-1", name: "inspect", arguments: "{}" }]);
  assert.equal(
    (turn.providerState as { message: { reasoning_content: string } }).message.reasoning_content,
    "opaque state",
  );
});

test("OpenAI Chat streaming preserves and replays fragmented nested extension state", async () => {
  const chunks = [
    {
      id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "custom-model",
      choices: [{ index: 0, finish_reason: null, delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call-opaque",
          type: "function",
          provider_signature: "sig-",
          function: {
            name: "ins",
            arguments: "{",
            extension: { checksum: "abc-" },
          },
        }],
      } }],
    },
    {
      id: "chunk-2", object: "chat.completion.chunk", created: 1, model: "custom-model",
      choices: [{ index: 0, finish_reason: "tool_calls", delta: {
        tool_calls: [{
          index: 0,
          provider_signature: "tail",
          function: {
            name: "pect",
            arguments: "}",
            extension: { checksum: "123" },
          },
        }],
      } }],
    },
  ];
  const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  let call = 0;
  let replayedMessages: Array<Record<string, unknown>> = [];
  const transport = createOpenAIChatTransport({
    fetchImpl: async (_input, init) => {
      call += 1;
      if (call === 1) {
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      replayedMessages = (JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      }).messages;
      return new Response(JSON.stringify({
        id: "chat-final",
        object: "chat.completion",
        created: 1,
        model: "custom-model",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Done" },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const streamingRequest = request(profile());
  streamingRequest.onDelta = () => {};
  const firstTurn = await transport.createToolTurn(streamingRequest);
  assert.deepEqual(firstTurn.toolCalls, [{
    id: "call-opaque",
    name: "inspect",
    arguments: "{}",
  }]);

  const rawMessage = (firstTurn.providerState as {
    message: Record<string, unknown>;
  }).message;
  assert.deepEqual((rawMessage.tool_calls as Array<Record<string, unknown>>)[0], {
    id: "call-opaque",
    type: "function",
    provider_signature: "sig-tail",
    function: {
      name: "inspect",
      arguments: "{}",
      extension: { checksum: "abc-123" },
    },
  });

  await transport.createToolTurn(request(profile(), [
    {
      role: "assistant",
      content: firstTurn.content,
      toolCalls: firstTurn.toolCalls,
      providerState: firstTurn.providerState,
    },
    { role: "tool", toolCallId: "call-opaque", content: "result" },
  ]));
  const replayed = replayedMessages.find((message) =>
    Array.isArray(message.tool_calls) &&
    (message.tool_calls as Array<Record<string, unknown>>)[0]?.provider_signature === "sig-tail"
  );
  assert.deepEqual(replayed, rawMessage);
});

test("OpenAI Chat accumulates indexed reasoning_details and replays them unchanged", async () => {
  const chunks = [
    {
      choices: [{ index: 0, finish_reason: null, delta: {
        role: "assistant",
        content: "Done",
        reasoning_details: [
          { index: 1, type: "reasoning.encrypted", data: "cipher-" },
          { index: 0, type: "reasoning.summary", text: "First " },
        ],
        annotations: [{ label: "first" }],
      } }],
    },
    {
      choices: [{ index: 0, finish_reason: "stop", delta: {
        reasoning_details: [
          { index: 0, text: "part" },
          { index: 1, data: "tail" },
          { type: "reasoning.trace", text: "standalone" },
        ],
        annotations: [{ label: "replacement" }],
      } }],
    },
  ];
  const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  let call = 0;
  let replayedMessages: Array<Record<string, unknown>> = [];
  const transport = createOpenAIChatTransport({
    fetchImpl: async (_input, init) => {
      call += 1;
      if (call === 1) {
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      replayedMessages = (JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      }).messages;
      return new Response(JSON.stringify({
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Final" },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const streamingRequest = request(profile());
  streamingRequest.onDelta = () => {};
  const firstTurn = await transport.createToolTurn(streamingRequest);
  const rawMessage = (firstTurn.providerState as {
    message: Record<string, unknown>;
  }).message;
  const expectedReasoningDetails = [
    { index: 0, type: "reasoning.summary", text: "First part" },
    { index: 1, type: "reasoning.encrypted", data: "cipher-tail" },
    { type: "reasoning.trace", text: "standalone" },
  ];
  assert.deepEqual(rawMessage.reasoning_details, expectedReasoningDetails);
  assert.deepEqual(rawMessage.annotations, [{ label: "replacement" }]);

  await transport.createToolTurn(request(profile(), [{
    role: "assistant",
    content: firstTurn.content,
    toolCalls: firstTurn.toolCalls,
    providerState: firstTurn.providerState,
  }]));
  const replayed = replayedMessages.find((message) =>
    Array.isArray(message.reasoning_details)
  );
  assert.deepEqual(replayed?.reasoning_details, expectedReasoningDetails);
  assert.deepEqual(replayed?.annotations, [{ label: "replacement" }]);
});

test("OpenAI Chat stops and cancels a stream when DONE arrives before disconnect", async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: { content: "Done" } }] })}\n\ndata: [DONE]\n\n`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
    },
  });
  const transport = createOpenAIChatTransport({
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const req = request(profile());
  req.onDelta = () => {};

  let timeout: ReturnType<typeof scheduleTimeout> | undefined;
  try {
    const turn = await Promise.race([
      transport.createToolTurn(req),
      new Promise<never>((_resolve, reject) => {
        timeout = scheduleTimeout(
          () => reject(new Error("stream remained pending after DONE")),
          250,
        );
      }),
    ]);
    assert.equal(turn.content, "Done");
    assert.equal(cancelled, true);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

test("OpenAI Chat streaming errors expose only fixed safe context", async () => {
  const sentinel = "chat-private-live-context-sentinel";
  for (const errorPayload of [
    { error: { message: sentinel } },
    { error: { type: sentinel, code: sentinel } },
  ]) {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "partial" } }],
    })}\n\ndata: ${JSON.stringify(errorPayload)}\n\n`;
    const transport = createOpenAIChatTransport({
      fetchImpl: async () => new Response(sse, { status: 200 }),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      (error: unknown) => {
        assert.equal(
          String(error),
          "Error: openai/chat-completions request failed: OpenAI-compatible stream error.",
        );
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
    );
  }
});

test("OpenAI profiles discover models through the shared model-list endpoint", async () => {
  let url = "";
  let requestSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  const transport = createOpenAIChatTransport({
    fetchImpl: async (input, init) => {
      url = String(input);
      requestSignal = init?.signal;
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "custom-large", object: "model", created: 1, owned_by: "custom", max_output_tokens: 32000 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const models = await transport.listModels(profile({
    baseUrl: "https://example.test/gateway/v1?tenant=studio#fragment",
  }), controller.signal);
  const endpoint = new URL(url);
  assert.equal(endpoint.pathname, "/gateway/v1/models");
  assert.equal(endpoint.searchParams.get("tenant"), "studio");
  assert.equal(endpoint.hash, "");
  assert.equal(models[0]?.id, "custom-large");
  assert.equal(models[0]?.capabilities.maxOutputTokens, 32000);
  assert.equal(models[0]?.capabilities.reasoning, undefined);
  assert.equal(requestSignal, controller.signal);
});

test("OpenAI model discovery does not depend on ambient Web constructors", async () => {
  const names = ["URL", "Headers", "AbortController"] as const;
  const descriptors = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: undefined,
      writable: true,
    });
  }
  try {
    let url = "";
    const transport = createOpenAIChatTransport({
      fetchImpl: async (input) => {
        url = String(input);
        return {
          json: async () => ({ data: [{ id: "host-safe-model" }] }),
          ok: true,
          status: 200,
          statusText: "OK",
        } as Response;
      },
    });
    const models = await transport.listModels(profile());
    assert.match(url, /\/v1\/models$/);
    assert.equal(models[0]?.id, "host-safe-model");
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("OpenAI Chat forwards the request abort signal", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const transport = createOpenAIChatTransport({
    fetchImpl: (_input, init) => {
      signal = init?.signal;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    },
  });
  const req = request(profile());
  req.signal = controller.signal;
  const pending = transport.createToolTurn(req);
  await started;
  controller.abort(new Error("test abort"));
  await assert.rejects(pending, /test abort|aborted/i);
  assert.equal(signal?.aborted, true);
});

test("OpenAI Chat errors include mode context and redact credentials", async () => {
  const transport = createOpenAIChatTransport({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "invalid credential secret", type: "authentication_error" },
    }), { status: 401, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    transport.createToolTurn(request(profile())),
    (error: unknown) => {
      assert.match(String(error), /openai\/chat-completions request failed/);
      assert.doesNotMatch(String(error), /credential secret/);
      assert.doesNotMatch(
        String((error as { cause?: unknown }).cause),
        /credential secret/,
      );
      return true;
    },
  );
});

test("OpenAI Chat errors never expose an echoed request body", async () => {
  const sentinels = [
    "chat-prompt-sentinel",
    "chat-live-context-sentinel",
    "chat-system-sentinel",
    "chat-history-sentinel",
    "chat-tool-state-sentinel",
    "chat-extra-body-sentinel",
  ];
  const p = profile({
    advanced: {
      extraBody: { metadata: { private_value: sentinels[5] } },
    },
  });
  const req = request(p, [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-private", name: "inspect", arguments: "{}" }],
      providerState: {
        kind: "openai-chat",
        message: {
          role: "assistant",
          content: null,
          private_state: sentinels[4],
          tool_calls: [{
            id: "call-private",
            type: "function",
            function: { name: "inspect", arguments: "{}" },
          }],
        },
      },
    },
    { role: "tool", toolCallId: "call-private", content: "tool-result" },
  ]);
  req.prompt = sentinels[0]!;
  req.liveContext = sentinels[1]!;
  req.systemInstructions = sentinels[2]!;
  req.history = [{ role: "assistant", content: sentinels[3]! }];
  const transport = createOpenAIChatTransport({
    fetchImpl: async (_input, init) =>
      new Response(`proxy echoed request: ${String(init?.body)}`, {
        status: 400,
        statusText: "Bad Request",
      }),
  });

  await assert.rejects(
    transport.createToolTurn(req),
    (error: unknown) => {
      const message = String(error);
      assert.match(
        message,
        /openai\/chat-completions request failed: OpenAI-compatible HTTP 400: Bad Request/,
      );
      for (const sentinel of sentinels) assert.doesNotMatch(message, new RegExp(sentinel));
      return true;
    },
  );
});

test("OpenAI transport errors redact credentials embedded in URLs", async () => {
  const transport = createOpenAIChatTransport({
    fetchImpl: async (input) => {
      throw new Error(`Request failed for ${String(input)}`);
    },
  });

  await assert.rejects(
    transport.listModels(profile({
      baseUrl: "https://alice:url-secret@example.test/v1",
    })),
    (error: unknown) => {
      assert.match(String(error), /https:\/\/\[redacted\]@example\.test\/v1\/models/);
      assert.doesNotMatch(String(error), /alice|url-secret/);
      return true;
    },
  );
});
