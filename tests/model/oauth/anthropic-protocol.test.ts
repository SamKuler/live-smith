import assert from "node:assert/strict";
import test from "node:test";

import { ModelRetryableError } from "../../../src/model/connection-error.js";
import type { TransportRequest } from "../../../src/model/provider.js";
import { modelToolsForProfile } from "../../../src/model/tools.js";
import {
  createAnthropicOAuthProtocol,
} from "../../../src/model/oauth/anthropic-protocol.js";

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

test("Anthropic subscription search preserves native results and citations on replay", async () => {
  const bodies: Record<string, any>[] = [];
  const content = [
    { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "Live manual" } },
    { type: "web_search_tool_result", tool_use_id: "search-1", content: [{
      type: "web_search_result", url: "https://www.ableton.com/en/manual/", title: "Live manual", encrypted_content: "opaque-search",
    }] },
    { type: "text", text: "The manual explains Warp.", citations: [{ type: "web_search_result_location", url: "https://www.ableton.com/en/manual/", title: "Live manual", cited_text: "Warp", encrypted_index: "opaque-index" }] },
    { type: "tool_use", id: "inspect-1", name: "inspect", input: {} },
  ];
  const protocol = createAnthropicOAuthProtocol({ fetchImpl: async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer search-access");
    return new Response(JSON.stringify({ type: "message", role: "assistant", stop_reason: "tool_use", content }), {
      headers: { "content-type": "application/json" },
    });
  } });
  const current = request("anthropic");
  current.runtimeProfile.model.advanced.hostedTools = { webSearch: true };
  current.tools = modelToolsForProfile(current.runtimeProfile, [{ type: "function", function: { name: "inspect", description: "Inspect", parameters: { type: "object", properties: {} } } }], 2);
  const credential = { provider: "anthropic" as const, accessToken: "search-access", refreshToken: "refresh", expiresAt: Date.now() + 60_000 };
  const turn = await protocol.createToolTurn(current, credential);
  assert.deepEqual(bodies[0]?.tools.at(-1), { type: "web_search_20250305", name: "web_search", max_uses: 2 });
  assert.equal(turn.hostedWebSearches?.[0]?.status, "completed");
  assert.deepEqual(turn.citations, [{ url: "https://www.ableton.com/en/manual/", title: "Live manual" }]);
  assert.deepEqual(turn.toolCalls, [{ id: "inspect-1", name: "inspect", arguments: "{}" }]);
  current.agentMessages = [
    { role: "assistant", content: turn.content, toolCalls: turn.toolCalls, providerState: turn.providerState },
    { role: "tool", toolCallId: "inspect-1", content: "Live state" },
  ];
  await protocol.createToolTurn(current, credential);
  assert.deepEqual(bodies[1]?.messages.find((message: any) => message.role === "assistant").content, content);
});

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
  assert.equal(headers?.get("user-agent"), "claude-cli/2.1.296");
  assert.equal(headers?.get("anthropic-version"), "2023-06-01");
  assert.match(headers?.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
  assert.match(String(body?.system), /Claude Code/u);
  assert.equal(turn.content, "Ready");
});

test("Anthropic OAuth requests visible thinking when enabled and preserves signed replay", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const protocol = createAnthropicOAuthProtocol({
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const events = [
        { type: "message_start", message: { type: "message", role: "assistant", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the clip." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "private-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "Ready" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      ).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const credential = {
    provider: "anthropic" as const,
    accessToken: "sk-ant-oat-access",
    refreshToken: "anthropic-refresh",
    expiresAt: Date.now() + 3_600_000,
  };
  const target = request("anthropic");
  target.runtimeProfile.capabilities.streaming = true;
  target.runtimeProfile.capabilities.reasoning.strategy = "adaptive-thinking";
  target.runtimeProfile.model.parameters.reasoning = { mode: "enabled", effort: "high" };
  target.onDelta = () => {};
  const updates: unknown[] = [];
  target.onReasoning = (update) => { updates.push(update); };
  const turn = await protocol.createToolTurn(target, credential);
  assert.deepEqual(bodies[0]?.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(bodies[0]?.output_config, { effort: "high" });
  assert.deepEqual(updates, [{ type: "start" }, { type: "delta", delta: "Checking the clip." }]);
  assert.deepEqual(turn.reasoning, { content: "Checking the clip." });
  assert.equal(turn.content, "Ready");
  target.agentMessages = [{
    role: "assistant",
    content: turn.content,
    toolCalls: turn.toolCalls,
    providerState: turn.providerState,
  }];
  await protocol.createToolTurn(target, credential);
  assert.ok(JSON.stringify(bodies[1]?.messages).includes("private-signature"));

  target.runtimeProfile.model.parameters.reasoning = { mode: "disabled" };
  await protocol.createToolTurn(target, credential);
  assert.deepEqual(bodies[2]?.thinking, { type: "disabled" });
  target.runtimeProfile.model.parameters.reasoning = { mode: "default" };
  await protocol.createToolTurn(target, credential);
  assert.equal(bodies[3]?.thinking, undefined);
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
  assert.equal(headers?.get("user-agent"), "claude-cli/2.1.296");
  assert.equal(headers?.get("anthropic-version"), "2023-06-01");
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
