import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import test from "node:test";

import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import type { TransportRequest } from "../provider.js";
import { createOpenAICodexProtocol } from "./openai-codex-protocol.js";

const credential: Extract<OAuthCredential, { provider: "openai" }> = {
  provider: "openai",
  accessToken: "openai-access",
  refreshToken: "openai-refresh",
  expiresAt: Date.now() + 3_600_000,
  accountId: "account-1",
};

function request(): TransportRequest {
  return {
    runtimeProfile: {
      profile: {
        id: "openai-oauth",
        name: "ChatGPT",
        connection: { kind: "oauth-subscription", provider: "openai" },
      },
      model: {
        model: "gpt-account-model",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 272_000,
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "medium", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: true, audio: false, pdf: false },
      },
      inputCapabilityEvidence: {
        image: "supported",
        audio: "unsupported",
        pdf: "unsupported",
      },
    },
    currentUserContent: [{ type: "text", text: "Inspect the track" }],
    systemInstructions: "Use Live Smith tools.",
    history: [],
    agentMessages: [],
    tools: [{
      type: "function",
      function: {
        name: "inspect_live_set",
        description: "Inspect Live",
        parameters: { type: "object", properties: {} },
      },
    }],
  };
}

function streamResponse(
  events: unknown[],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    },
  );
}

test("ChatGPT OAuth loads the signed-in Codex model catalog", async () => {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        models: [
          {
            slug: "gpt-account-model",
            display_name: "GPT Account Model",
            supported_in_api: true,
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
              { effort: "high", description: "Deep" },
            ],
            context_window: 272_000,
            input_modalities: ["text", "image", "audio", "pdf"],
          },
          {
            slug: "gpt-subscription-only",
            display_name: "GPT Subscription Only",
            supported_in_api: false,
            visibility: "list",
            max_context_window: 500_000,
          },
          {
            slug: "gpt-internal",
            display_name: "GPT Internal",
            supported_in_api: false,
            visibility: "none",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const models = await protocol.listModels({
    id: "openai-oauth",
    name: "ChatGPT",
    connection: { kind: "oauth-subscription", provider: "openai" },
    defaultModel: "",
    models: [],
  }, credential);

  assert.equal(
    capturedUrl,
    "https://chatgpt.com/backend-api/codex/models?client_version=0.149.0",
  );
  assert.equal(capturedHeaders?.get("authorization"), "Bearer openai-access");
  assert.equal(capturedHeaders?.get("chatgpt-account-id"), "account-1");
  assert.deepEqual(models, [
    {
      id: "gpt-account-model",
      displayName: "GPT Account Model",
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 272_000,
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "medium", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: true, audio: false, pdf: true },
      },
      providerReported: {
        inputs: { inputModalities: ["text", "image", "audio", "pdf"] },
      },
    },
    {
      id: "gpt-subscription-only",
      displayName: "GPT Subscription Only",
      capabilities: {
        tools: true,
        streaming: true,
        temperature: "unsupported",
        contextWindowTokens: 500_000,
      },
    },
  ]);
});

test("ChatGPT OAuth captures and replays Codex turn state within a tool loop", async () => {
  const requestHeaders: Headers[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestNumber += 1;
      if (requestNumber === 1) {
        return streamResponse([
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              status: "completed",
              call_id: "call-1",
              name: "inspect_live_set",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
            },
          },
        ], { "x-codex-turn-state": "turn-state-1" });
      }
      return streamResponse([
        {
          type: "response.metadata",
          headers: { "X-Codex-Turn-State": "turn-state-2" },
        },
        {
          type: "response.output_text.delta",
          delta: "Ready",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Ready" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "response-2",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      ]);
    },
  });

  const first = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(first.providerState, {
    kind: "openai-responses",
    output: [{
      type: "function_call",
      status: "completed",
      call_id: "call-1",
      name: "inspect_live_set",
      arguments: "{}",
    }],
    codexTurnState: "turn-state-1",
  });

  const next = request();
  next.agentMessages = [
    {
      role: "assistant",
      content: null,
      toolCalls: first.toolCalls,
      providerState: first.providerState,
    },
    { role: "tool", toolCallId: "call-1", content: "Track state" },
  ];
  const second = await protocol.createToolTurn(next, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(requestHeaders[0]?.get("content-type"), "application/json");
  assert.equal(requestHeaders[1]?.get("x-codex-turn-state"), "turn-state-1");
  assert.equal(requestBodies[0]?.store, false);
  assert.equal(requestBodies[0]?.stream, true);
  assert.equal(requestBodies[0]?.parallel_tool_calls, true);
  assert.equal("max_output_tokens" in requestBodies[0]!, false);
  assert.equal(second.content, "Ready");
  assert.deepEqual(second.contextUsage, {
    usedTokens: 12,
    contextWindowTokens: 272_000,
  });
  assert.deepEqual(second.providerState, {
    kind: "openai-responses",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Ready" }],
    }],
    codexTurnState: "turn-state-1",
  });
});

test("ChatGPT OAuth restores streamed output order before replay", async () => {
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call-2",
          name: "second_call",
          arguments: "{}",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "first_call",
          arguments: "{}",
        },
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]),
  });

  const turn = await protocol.createToolTurn(request(), credential);

  assert.deepEqual(turn.toolCalls.map((call) => call.name), [
    "first_call",
    "second_call",
  ]);
  assert.deepEqual(
    (turn.providerState as { output: Array<{ call_id?: unknown }> }).output.map(
      (item) => item.call_id,
    ),
    ["call-1", "call-2"],
  );
});

test("ChatGPT OAuth rejects duplicate and incomplete streamed output indices", async () => {
  const cases = [
    {
      name: "duplicate",
      events: [
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "First" }],
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Duplicate" }],
          },
        },
      ],
      error: /duplicate completed output index/u,
    },
    {
      name: "incomplete",
      events: [{
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Missing index zero" }],
        },
      }],
      error: /incomplete completed output indices/u,
    },
  ];

  for (const candidate of cases) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([
        ...candidate.events,
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      candidate.error,
      candidate.name,
    );
  }
});

test("ChatGPT OAuth preserves incomplete and contradictory terminal semantics", async () => {
  const partial = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Partial" }],
        },
      },
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
    ]),
  });
  const turn = await partial.createToolTurn(request(), credential);
  assert.equal(turn.content, "Partial");
  assert.deepEqual(turn.continuation, { reason: "output_limit" });

  const contradictory = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.completed",
      response: { status: "incomplete", output: [] },
    }]),
  });
  await assert.rejects(
    contradictory.createToolTurn(request(), credential),
    /terminal event.*contradicted/u,
  );

  const malformed = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Must not mask malformed output" }],
        },
      },
      {
        type: "response.completed",
        response: { status: "completed", output: null },
      },
    ]),
  });
  await assert.rejects(
    malformed.createToolTurn(request(), credential),
    /returned no output items/u,
  );
});

test("ChatGPT OAuth answers a truncated function call before continuing", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const partialCall = {
    id: "fc-codex-incomplete",
    type: "function_call",
    call_id: "call-codex-incomplete",
    name: "inspect_live_set",
    arguments: "{",
    status: "incomplete",
  };
  const secondPartialCall = {
    id: "fc-codex-incomplete-2",
    type: "function_call",
    call_id: "call-codex-incomplete-2",
    name: "inspect_live_set",
    arguments: "{\"track",
    status: "incomplete",
  };
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestNumber += 1;
      return requestNumber === 1
        ? streamResponse([{
          type: "response.output_item.done",
          output_index: 0,
          item: partialCall,
        }, {
          type: "response.output_item.done",
          output_index: 1,
          item: secondPartialCall,
        }, {
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          }])
        : streamResponse([{
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "message-codex-completed",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
            },
          }, {
            type: "response.completed",
            response: { status: "completed", output: [] },
          }]);
    },
  });
  const first = await protocol.createToolTurn(request(), credential);
  assert.deepEqual(first.toolCalls, []);
  assert.equal(
    (first.providerState as { outputLimited?: unknown }).outputLimited,
    true,
  );
  const next = request();
  next.agentMessages = [{
    role: "assistant",
    content: first.content,
    toolCalls: first.toolCalls,
    providerState: first.providerState,
  }];

  await protocol.createToolTurn(next, credential);

  const secondInput = requestBodies[1]?.input as Array<Record<string, unknown>>;
  assert.deepEqual(secondInput.slice(-4), [
    partialCall,
    secondPartialCall,
    {
      type: "function_call_output",
      call_id: "call-codex-incomplete",
      output:
        "Function call was not executed because the model response reached its output-token limit.",
    },
    {
      type: "function_call_output",
      call_id: "call-codex-incomplete-2",
      output:
        "Function call was not executed because the model response reached its output-token limit.",
    },
  ]);
});

test("ChatGPT OAuth rejects duplicate call IDs in incomplete output", async () => {
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc-duplicate-1",
        type: "function_call",
        call_id: "duplicate-call",
        name: "inspect_live_set",
        arguments: "{",
        status: "incomplete",
      },
    }, {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "fc-duplicate-2",
        type: "function_call",
        call_id: "duplicate-call",
        name: "inspect_live_set",
        arguments: "{",
        status: "incomplete",
      },
    }, {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    /duplicate tool call ID/u,
  );
});

test("ChatGPT OAuth rejects success terminals after an error event", async () => {
  const sentinel = "codex-private-contradictory-error";
  for (const eventType of ["response.completed", "response.incomplete"] as const) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "error",
        code: "provider_failure",
        message: sentinel,
      }, {
        type: eventType,
        response: {
          ...(eventType === "response.incomplete"
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
          output: [{
            id: "message-after-error",
            type: "message",
            role: "assistant",
            status: eventType === "response.completed" ? "completed" : "incomplete",
            content: [{ type: "output_text", text: "must not survive", annotations: [] }],
          }],
        },
      }]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (error: unknown) => {
        assert.match(String(error), /terminal response after an error event/u);
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
    );
  }
});

test("ChatGPT OAuth shares strict terminal Web Search and citation decoding", async () => {
  const malformedItems = [{
    id: "search-invalid-status",
    type: "web_search_call",
    status: "in_progress",
    action: { type: "search", query: "Ableton" },
  }, {
    id: "message-invalid-citation",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{
      type: "output_text",
      text: "Done",
      annotations: [{ type: "url_citation", url: 42 }],
    }],
  }];
  for (const item of malformedItems) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.output_item.done",
        output_index: 0,
        item,
      }, {
        type: "response.completed",
        response: { status: "completed", output: [] },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      /invalid (?:web_search_call|url_citation)/u,
    );
  }
});

test("ChatGPT OAuth shares incomplete message-role and Web Search replay validation", async () => {
  const validSearch = {
    id: "search-codex-in-progress",
    type: "web_search_call",
    status: "in_progress",
    action: { type: "search", query: "Ableton", sources: [] },
  };
  const validProtocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.output_item.done",
      output_index: 0,
      item: validSearch,
    }, {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    }]),
  });

  const turn = await validProtocol.createToolTurn(request(), credential);

  assert.deepEqual(turn.continuation, { reason: "output_limit" });
  assert.equal(turn.hostedWebSearches, undefined);
  assert.deepEqual(
    (turn.providerState as { output: unknown[] }).output,
    [validSearch],
  );

  for (const item of [{
    id: "message-codex-invalid-role",
    type: "message",
    role: "user",
    status: "incomplete",
    content: [{ type: "output_text", text: "must not survive", annotations: [] }],
  }, {
    ...validSearch,
    action: { type: "search", query: 42 },
  }]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.output_item.done",
        output_index: 0,
        item,
      }, {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      /invalid (?:message role|web_search_call)/u,
    );
  }
});

test("ChatGPT OAuth preserves refusal events and unknown object output for replay", async () => {
  const sentinel = "codex-private-refusal-metadata";
  const deltas: string[] = [];
  const refusalItem = {
    type: "message",
    role: "assistant",
    content: [
      { type: "refusal", refusal: "I cannot help with that request." },
      { type: "future_private_part", private_metadata: sentinel },
    ],
  };
  const unknownOutputItem = {
    type: "future_output_item",
    opaque_state: sentinel,
  };
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([
      {
        type: "response.refusal.delta",
        delta: "I cannot ",
        private_metadata: sentinel,
      },
      {
        type: "response.refusal.delta",
        delta: "help with that request.",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: refusalItem,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: unknownOutputItem,
      },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]),
  });
  const req = request();
  req.onDelta = (delta) => { deltas.push(delta); };

  const turn = await protocol.createToolTurn(req, credential);

  assert.equal(turn.content, "I cannot help with that request.");
  assert.deepEqual(deltas, ["I cannot ", "help with that request."]);
  assert.deepEqual(
    (turn.providerState as { output: unknown[] }).output,
    [refusalItem, unknownOutputItem],
  );
  assert.doesNotMatch(turn.content ?? "", new RegExp(sentinel));
});

test("ChatGPT OAuth rejects malformed known visible delta events", async () => {
  for (const type of ["response.output_text.delta", "response.refusal.delta"]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type,
        delta: { private_value: "do-not-expose" },
      }]),
    });
    const req = request();
    req.onDelta = () => {};

    await assert.rejects(
      protocol.createToolTurn(req, credential),
      (error: unknown) => {
        assert.match(String(error), /invalid visible text delta/i);
        assert.doesNotMatch(String(error), /do-not-expose/u);
        return true;
      },
      type,
    );
  }
});

test("ChatGPT OAuth rejects non-object terminal output items", async () => {
  const sentinel = "codex-private-primitive-output";
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.completed",
      response: {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Safe text" }],
        }, sentinel],
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (error: unknown) => {
      assert.match(String(error), /non-object output item/i);
      assert.doesNotMatch(String(error), new RegExp(sentinel));
      return true;
    },
  );
});

test("ChatGPT OAuth preserves the first Codex turn state across reconnect", async () => {
  const requestHeaders: Headers[] = [];
  let requestNumber = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      requestNumber += 1;
      if (requestNumber === 1) {
        return streamResponse([], { "x-codex-turn-state": "turn-state-1" });
      }
      return streamResponse([
        {
          type: "response.metadata",
          headers: { "X-Codex-Turn-State": "turn-state-2" },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Recovered" }],
            }],
          },
        },
      ]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;

  await assert.rejects(
    protocol.createToolTurn(first, credential),
    ModelConnectionError,
  );

  const second = request();
  second.reconnectState = reconnectState;
  const recovered = await protocol.createToolTurn(second, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(
    requestHeaders[1]?.get("x-codex-turn-state"),
    "turn-state-1",
  );
  assert.equal(recovered.content, "Recovered");
  assert.equal(
    (recovered.providerState as { codexTurnState?: unknown }).codexTurnState,
    "turn-state-1",
  );
});

test("ChatGPT OAuth preserves an explicitly safe network proxy diagnosis", async () => {
  const error = new NetworkProxyError(
    "macOS automatic proxy configuration is not supported; choose Manual proxy instead.",
  );
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => {
      throw error;
    },
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.equal(failure instanceof ModelConnectionError, false);
      assert.match(failure.message, /choose Manual proxy instead/u);
      return true;
    },
  );
});

test("ChatGPT OAuth classifies transient HTTP generation failures", async () => {
  for (const status of [408, 409, 429, 500, 503]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => new Response("sensitive upstream detail", {
        status,
        headers: { "retry-after-ms": "2250" },
      }),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.equal(failure.retryAfterMs, 2_250);
        assert.match(failure.message, new RegExp(`HTTP ${status}.*retryable`, "u"));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      String(status),
    );
  }
});

test("ChatGPT OAuth decodes bounded headerless HTTP errors", async () => {
  const sentinel = "codex-private-headerless-error";
  const bytes = new TextEncoder().encode(JSON.stringify({
    error: {
      code: "invalid_prompt",
      type: "invalid_request_error",
      message: sentinel,
    },
  }));
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }) as never, { status: 400 }),
  });

  await assert.rejects(protocol.createToolTurn(request(), credential), (failure: unknown) => {
    assert.ok(failure instanceof Error);
    assert.equal(failure instanceof ModelRetryableError, false);
    assert.match(
      failure.message,
      /HTTP 400.*rejected.*code=invalid_prompt; type=invalid_request_error/u,
    );
    assert.doesNotMatch(failure.message, new RegExp(sentinel));
    return true;
  });
});

test("ChatGPT OAuth cancels a hanging headerless HTTP error body", {
  timeout: 2_000,
}, async () => {
  let cancelled = false;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }) as never, { status: 503 }),
  });

  await assert.rejects(protocol.createToolTurn(request(), credential), (failure: unknown) => {
    assert.ok(failure instanceof ModelRetryableError);
    assert.match(failure.message, /HTTP 503/u);
    return true;
  });
  assert.equal(cancelled, true);
});

test("ChatGPT OAuth replays turn state captured from a retryable HTTP response", async () => {
  const requestHeaders: Headers[] = [];
  let calls = 0;
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      calls += 1;
      if (calls === 1) {
        return new Response("temporary failure", {
          status: 503,
          headers: { "x-codex-turn-state": "retry-turn-state" },
        });
      }
      return streamResponse([{
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered" }],
          }],
        },
      }]);
    },
  });
  const reconnectState = {};
  const first = request();
  first.reconnectState = reconnectState;
  await assert.rejects(protocol.createToolTurn(first, credential), ModelRetryableError);

  const second = request();
  second.reconnectState = reconnectState;
  const turn = await protocol.createToolTurn(second, credential);

  assert.equal(requestHeaders[0]?.has("x-codex-turn-state"), false);
  assert.equal(requestHeaders[1]?.get("x-codex-turn-state"), "retry-turn-state");
  assert.equal(turn.content, "Recovered");
});

test("ChatGPT OAuth classifies response failures after their error envelope", async () => {
  for (const code of [
    "rate_limit_exceeded",
    "provider_failure",
    "server_is_overloaded",
    "slow_down",
    "future_transient_failure",
  ]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([
        {
          type: "error",
          code,
          message: "sensitive envelope detail",
          param: null,
        },
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code, message: "sensitive terminal detail" },
          },
        },
      ], { "retry-after-ms": "1500" }),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.equal(failure instanceof ModelConnectionError, false);
        assert.equal(failure.retryAfterMs, 1_500);
        assert.match(failure.message, /ChatGPT Codex.*retryable/u);
        assert.match(failure.message, new RegExp(`code=${code}`));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      code,
    );
  }
});

test("ChatGPT OAuth keeps fatal response failure categories safe and actionable", async () => {
  const cases = [
    ["context_length_exceeded", /context window was exceeded/u],
    ["insufficient_quota", /account usage limit was reached/u],
    ["credit_balance_exhausted", /account usage limit was reached/u],
    ["organization_spend_limit_exceeded", /account usage limit was reached/u],
    ["project_spend_limit_exceeded", /account usage limit was reached/u],
    ["organization_usage_limit_exceeded", /account usage limit was reached/u],
    ["usage_not_included", /usage is not included/u],
    ["invalid_prompt", /rejected the request/u],
    ["bio_policy", /rejected the request/u],
    ["cyber_policy", /rejected the request/u],
    ["misalignment_policy_violation", /rejected the request/u],
  ] as const;

  for (const [code, expected] of cases) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.failed",
        response: {
          status: "failed",
          error: { code, message: "sensitive terminal detail" },
        },
      }]),
    });
    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof Error);
        assert.equal(failure instanceof ModelRetryableError, false);
        assert.match(failure.message, expected);
        assert.match(failure.message, new RegExp(`code=${code}`));
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      code,
    );
  }
});

test("ChatGPT OAuth treats failed envelopes without a safe code or type as malformed", async () => {
  const sentinel = "codex-private-malformed-failure";
  const malformedResponses: unknown[] = [
    undefined,
    null,
    {},
    { status: "failed" },
    { status: "failed", error: "provider_failure" },
    { status: "failed", error: {} },
    { status: "failed", error: { code: "BAD-CODE", message: sentinel } },
    { status: "completed", error: { code: "provider_failure" } },
    { status: "failed", code: "provider_failure", message: sentinel },
  ];
  for (const response of malformedResponses) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([{
        type: "response.failed",
        ...(response === undefined ? {} : { response }),
      }]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof Error);
        assert.equal(failure instanceof ModelRetryableError, false);
        assert.match(failure.message, /malformed failed response/u);
        assert.doesNotMatch(failure.message, /BAD-CODE|provider_failure|private/u);
        return true;
      },
    );
  }
});

test("ChatGPT OAuth accepts a canonical type-only failed envelope", async () => {
  const sentinel = "codex-private-type-only-failure";
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "response.failed",
      response: {
        status: "failed",
        error: { type: "server_error", message: sentinel },
      },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => {
      assert.ok(failure instanceof ModelRetryableError);
      assert.match(failure.message, /type=server_error/u);
      assert.doesNotMatch(failure.message, new RegExp(sentinel));
      return true;
    },
  );
});

test("ChatGPT OAuth preserves top-level and nested unterminated error envelopes", async () => {
  for (const event of [{
    type: "error",
    code: "provider_failure",
    message: "sensitive upstream detail",
  }, {
    type: "error",
    error: {
      code: "provider_failure",
      type: "server_error",
      message: "sensitive upstream detail",
    },
  }]) {
    const protocol = createOpenAICodexProtocol({
      fetchImpl: async () => streamResponse([event]),
    });

    await assert.rejects(
      protocol.createToolTurn(request(), credential),
      (failure: unknown) => {
        assert.ok(failure instanceof ModelRetryableError);
        assert.match(failure.message, /retryable failure.*code=provider_failure/u);
        if ("error" in event) assert.match(failure.message, /type=server_error/u);
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
    );
  }
});
