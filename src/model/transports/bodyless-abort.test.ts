import assert from "node:assert/strict";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import type { RuntimeProfileIdentity } from "../provider.js";
import {
  requestAnthropicJson,
  streamAnthropicEvents,
} from "./anthropic-http.js";
import {
  requestOpenAIJson,
  streamOpenAIEvents,
} from "./openai-http.js";

const openAIProfile: RuntimeProfileIdentity = {
  id: "openai-direct",
  name: "OpenAI Direct",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
};

const anthropicProfile: RuntimeProfileIdentity = {
  ...openAIProfile,
  id: "anthropic-direct",
  name: "Anthropic Direct",
  connection: {
    kind: "direct-api",
    apiFamily: "anthropic",
    apiMode: "messages",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
};

test("bodyless JSON responses preserve pre-existing abort reasons", async (t) => {
  await t.test("OpenAI", async () => {
    const reason = new Error("OpenAI JSON stopped");
    const controller = createHostAbortController();
    controller.abort(reason);

    await assert.rejects(
      requestOpenAIJson(
        openAIProfile,
        async () => new Response(null, { status: 200 }),
        "/responses",
        { method: "POST", signal: controller.signal },
      ),
      (error: unknown) => error === reason,
    );
  });

  await t.test("Anthropic", async () => {
    const reason = new Error("Anthropic JSON stopped");
    const controller = createHostAbortController();
    controller.abort(reason);

    await assert.rejects(
      requestAnthropicJson(
        anthropicProfile,
        async () => new Response(null, { status: 200 }),
        "/messages",
        { method: "POST", signal: controller.signal },
      ),
      (error: unknown) => error === reason,
    );
  });
});

test("bodyless OpenAI streams preserve a pre-existing abort reason", async () => {
  const reason = new Error("OpenAI stream stopped");
  const controller = createHostAbortController();
  controller.abort(reason);
  const iterator = streamOpenAIEvents(
    openAIProfile,
    async () => new Response(null, { status: 200 }),
    "/responses",
    {},
    controller.signal,
  );

  await assert.rejects(
    iterator.next(),
    (error: unknown) => error === reason,
  );
});

test("bodyless Anthropic streams preserve a pre-existing abort reason", async () => {
  const reason = new Error("Anthropic stream stopped");
  const controller = createHostAbortController();
  controller.abort(reason);
  const iterator = streamAnthropicEvents(
    anthropicProfile,
    async () => new Response(null, { status: 200 }),
    {},
    controller.signal,
  );

  await assert.rejects(
    iterator.next(),
    (error: unknown) => error === reason,
  );
});
