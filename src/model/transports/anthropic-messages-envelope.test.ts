import assert from "node:assert/strict";
import test from "node:test";

import { ModelRetryableError } from "../connection-error.js";
import { createAnthropicMessagesTransport } from "./anthropic-messages.js";
import {
  anthropicStreamResponse,
  profile,
  request,
} from "./anthropic-messages.test-harness.js";

test("Anthropic Messages validates canonical success and 200 error envelopes", async (t) => {
  const canonical = {
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Done" }],
  };
  for (const [name, response] of [
    ["missing type", { ...canonical, type: undefined }],
    ["wrong type", { ...canonical, type: "future_message" }],
    ["missing role", { ...canonical, role: undefined }],
    ["wrong role", { ...canonical, role: "user" }],
  ] as const) {
    await t.test(name, async () => {
      const transport = createAnthropicMessagesTransport({
        fetchImpl: async () => new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      });
      await assert.rejects(
        transport.createToolTurn(request(profile())),
        /invalid message envelope/u,
      );
    });
  }

  const sentinel = "anthropic-private-200-error";
  const retryable = createAnthropicMessagesTransport({
    fetchImpl: async () => new Response(JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: sentinel,
        details: { error_code: "future_safe_code" },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    retryable.createToolTurn(request(profile())),
    (error: unknown) => {
      assert.ok(error instanceof ModelRetryableError);
      assert.match(error.message, /type=rate_limit_error/u);
      assert.match(error.message, /error_code=future_safe_code/u);
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    },
  );
});

test("Anthropic stream requires a canonical message_start envelope", async () => {
  const canonical = {
    type: "message",
    role: "assistant",
    content: [],
  };
  for (const message of [
    { ...canonical, type: undefined },
    { ...canonical, type: "future_message" },
    { ...canonical, role: undefined },
    { ...canonical, role: "user" },
  ]) {
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => anthropicStreamResponse([{
        type: "message_start",
        message,
      }]),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      /invalid message_start event/u,
    );
  }
});

test("Anthropic stream rejects every started block left open at message_stop", async () => {
  const sentinel = "anthropic-private-open-block";
  const cases = [{
    block: { type: "text", text: "" },
    delta: { type: "text_delta", text: "partial" },
    stopReason: "end_turn",
  }, {
    block: { type: "thinking", thinking: "", signature: "" },
    delta: { type: "thinking_delta", thinking: "hidden" },
    stopReason: "end_turn",
  }, {
    block: {
      type: "tool_use",
      id: "tool-open",
      name: "inspect",
      input: {},
    },
    delta: { type: "input_json_delta", partial_json: "{}" },
    stopReason: "tool_use",
  }, {
    block: {
      type: "server_tool_use",
      id: "server-open",
      name: "web_search",
      input: {},
      private: sentinel,
    },
    delta: { type: "input_json_delta", partial_json: "{}" },
    stopReason: "max_tokens",
  }];

  for (const item of cases) {
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => anthropicStreamResponse([{
        type: "message_start",
        message: { type: "message", role: "assistant", content: [] },
      }, {
        type: "content_block_start",
        index: 0,
        content_block: item.block,
      }, {
        type: "content_block_delta",
        index: 0,
        delta: item.delta,
      }, {
        type: "message_delta",
        delta: { stop_reason: item.stopReason },
      }, {
        type: "message_stop",
      }]),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      (error: unknown) => {
        assert.match(String(error), /message_stop before content_block_stop/u);
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
      String(item.block.type),
    );
  }
});

test("Anthropic stream requires empty message_start content", async () => {
  for (const initial of [
    [{ type: "text", text: "Initial" }],
    [{ type: "tool_use", id: "tool-unclosed", name: "inspect", input: {} }],
  ]) {
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => anthropicStreamResponse([{
        type: "message_start",
        message: {
          type: "message",
          role: "assistant",
          content: initial,
        },
      }, {
        type: "message_delta",
        delta: {
          stop_reason: initial[0]?.type === "tool_use" ? "tool_use" : "end_turn",
        },
      }, {
        type: "message_stop",
      }]),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      /non-empty message_start content/u,
    );
  }
});

test("Anthropic stream requires one message_start before lifecycle events", async () => {
  for (const block of [
    { type: "text", text: "" },
    { type: "tool_use", id: "tool-unclosed", name: "inspect", input: {} },
  ]) {
    const transport = createAnthropicMessagesTransport({
      fetchImpl: async () => anthropicStreamResponse([{
        type: "content_block_start",
        index: 0,
        content_block: block,
      }, {
        type: "content_block_stop",
        index: 0,
      }, {
        type: "message_delta",
        delta: {
          stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
        },
      }, {
        type: "message_stop",
      }]),
    });
    const req = request(profile());
    req.onDelta = () => {};
    await assert.rejects(
      transport.createToolTurn(req),
      /event before message_start/u,
    );
  }

  const duplicate = createAnthropicMessagesTransport({
    fetchImpl: async () => anthropicStreamResponse([{
      type: "message_start",
      message: { type: "message", role: "assistant", content: [] },
    }, {
      type: "message_start",
      message: { type: "message", role: "assistant", content: [] },
    }]),
  });
  const req = request(profile());
  req.onDelta = () => {};
  await assert.rejects(
    duplicate.createToolTurn(req),
    /duplicate message_start/u,
  );
});
