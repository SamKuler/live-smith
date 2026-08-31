import assert from "node:assert/strict";
import test from "node:test";

import { ModelRetryableError } from "../connection-error.js";
import type { TransportRequest } from "../provider.js";
import {
  createAnthropicOAuthProtocol,
} from "./anthropic-protocol.js";

function request(provider: "openai" | "anthropic"): TransportRequest {
  return {
    runtimeProfile: {
      profile: {
        id: `${provider}-oauth`,
        name: provider,
        connection: { kind: "oauth-subscription", provider },
      },
      model: {
        model: provider === "openai" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      capabilities: {
        tools: true,
        streaming: false,
        temperature: "unsupported",
        maxOutputTokens: 64_000,
        reasoning: {
          supported: true,
          canDisable: true,
          efforts: ["low", "medium", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
        inputs: { image: false, audio: false, pdf: false },
      },
      inputCapabilityEvidence: {
        image: "unsupported",
        audio: "unsupported",
        pdf: "unsupported",
      },
    },
    currentUserContent: [{ type: "text", text: "Hello" }],
    systemInstructions: "Live Smith instructions",
    history: [],
    agentMessages: [],
    tools: [],
  };
}

test("Anthropic subscription protocol uses OAuth bearer identity, not x-api-key", async () => {
  let headers: Headers | undefined;
  let body: Record<string, unknown> | undefined;
  const protocol = createAnthropicOAuthProtocol({
    fetchImpl: async (_input, init) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Ready" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const turn = await protocol.createToolTurn(request("anthropic"), {
    provider: "anthropic",
    accessToken: "sk-ant-oat-access",
    refreshToken: "anthropic-refresh",
    expiresAt: Date.now() + 3_600_000,
  });

  assert.equal(headers?.get("authorization"), "Bearer sk-ant-oat-access");
  assert.equal(headers?.has("x-api-key"), false);
  assert.match(headers?.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
  assert.match(String(body?.system), /Claude Code/u);
  assert.equal(turn.content, "Ready");
});

test("Anthropic OAuth model discovery also uses bearer identity", async () => {
  let headers: Headers | undefined;
  const protocol = createAnthropicOAuthProtocol({
    fetchImpl: async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const models = await protocol.listModels({
    id: "anthropic-oauth",
    name: "Claude",
    connection: { kind: "oauth-subscription", provider: "anthropic" },
    defaultModel: "",
    models: [],
  }, {
    provider: "anthropic",
    accessToken: "sk-ant-oat-access",
    refreshToken: "anthropic-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(headers?.get("authorization"), "Bearer sk-ant-oat-access");
  assert.equal(headers?.has("x-api-key"), false);
  assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-4-6"]);
});

test("Anthropic OAuth preserves replay-only output-limit responses", async () => {
  const content = [{ type: "text", text: "Partial" }, {
    type: "tool_use",
    id: "partial-tool",
    name: "inspect",
    input: { trackName: "Lead" },
  }];
  const protocol = createAnthropicOAuthProtocol({
    fetchImpl: async () => new Response(JSON.stringify({
      type: "message",
      role: "assistant",
      stop_reason: "max_tokens",
      content,
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const turn = await protocol.createToolTurn(request("anthropic"), {
    provider: "anthropic",
    accessToken: "sk-ant-oat-access",
    refreshToken: "anthropic-refresh",
    expiresAt: Date.now() + 3_600_000,
  });

  assert.equal(turn.content, "Partial");
  assert.deepEqual(turn.toolCalls, []);
  assert.deepEqual(turn.continuation, { reason: "output_limit" });
  assert.deepEqual(turn.providerState, {
    kind: "anthropic-messages",
    content,
    outputLimited: true,
  });
});

test("Anthropic OAuth shares safe 200 error-envelope classification", async () => {
  const sentinel = "anthropic-oauth-private-error";
  const protocol = createAnthropicOAuthProtocol({
    fetchImpl: async () => new Response(JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        message: sentinel,
        details: { error_code: "future_safe_code" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    protocol.createToolTurn(request("anthropic"), {
      provider: "anthropic",
      accessToken: "sk-ant-oat-access",
      refreshToken: "anthropic-refresh",
      expiresAt: Date.now() + 3_600_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelRetryableError);
      assert.match(error.message, /type=overloaded_error/u);
      assert.match(error.message, /error_code=future_safe_code/u);
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    },
  );
});
