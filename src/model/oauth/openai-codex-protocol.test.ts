import assert from "node:assert/strict";
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
            input_modalities: ["text", "image"],
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
        inputs: { image: true, audio: false, pdf: false },
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
        assert.doesNotMatch(failure.message, /sensitive/u);
        return true;
      },
      code,
    );
  }
});

test("ChatGPT OAuth retries an unterminated error envelope", async () => {
  const protocol = createOpenAICodexProtocol({
    fetchImpl: async () => streamResponse([{
      type: "error",
      error: { code: "provider_failure", message: "sensitive upstream detail" },
    }]),
  });

  await assert.rejects(
    protocol.createToolTurn(request(), credential),
    (failure: unknown) => {
      assert.ok(failure instanceof ModelConnectionError);
      assert.match(failure.message, /without a terminal response/u);
      assert.doesNotMatch(failure.message, /sensitive/u);
      return true;
    },
  );
});
