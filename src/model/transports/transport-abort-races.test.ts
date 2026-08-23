import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import type { SavedProfile } from "../profile.js";
import {
  requestAnthropicJson,
  streamAnthropicEvents,
} from "./anthropic-http.js";
import {
  requestOpenAIJson,
  streamOpenAIEvents,
} from "./openai-http.js";
import { readBoundedJsonResponse } from "./response-body.js";
import { parseServerSentEventData } from "./server-sent-events.js";

const openAIProfile: SavedProfile = {
  id: "openai-direct",
  name: "OpenAI Direct",
  connection: {
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
  },
  model: "model-a",
  parameters: {
    maxOutputTokens: 1024,
    reasoning: { mode: "default" },
  },
  advanced: {},
};

const anthropicProfile: SavedProfile = {
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

test("JSON EOF gives a queued abort precedence before parsing", async () => {
  const reason = new Error("JSON stopped at EOF");
  const controller = createHostAbortController();
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(streamController) {
      pullCount += 1;
      if (pullCount === 1) {
        streamController.enqueue(new TextEncoder().encode('{"ok":true}'));
      } else {
        streamController.close();
        queueMicrotask(() => controller.abort(reason));
      }
    },
  });

  await assert.rejects(
    readBoundedJsonResponse(new Response(body as never), {
      label: "Test provider",
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
});

test("SSE EOF and read errors give a queued abort precedence", async (t) => {
  await t.test("normal EOF", async () => {
    const reason = new Error("SSE stopped at EOF");
    const controller = createHostAbortController();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pullCount += 1;
        if (pullCount === 1) {
          streamController.enqueue(new TextEncoder().encode(": comment\n\n"));
        } else {
          streamController.close();
          queueMicrotask(() => controller.abort(reason));
        }
      },
    });

    await assert.rejects(
      parseServerSentEventData(body as never, controller.signal).next(),
      (error: unknown) => error === reason,
    );
  });

  await t.test("read error", async () => {
    const reason = new Error("SSE stopped with a read error");
    const readError = new Error("provider stream failed");
    const controller = createHostAbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.error(readError);
        queueMicrotask(() => controller.abort(reason));
      },
    });

    await assert.rejects(
      parseServerSentEventData(body as never, controller.signal).next(),
      (error: unknown) => error === reason,
    );
  });
});

test("fetch rejection gives the request abort reason precedence", async (t) => {
  await t.test("OpenAI JSON", async () => {
    const reason = new Error("OpenAI JSON stopped in fetch");
    const controller = createHostAbortController();
    const fetchError = new TypeError("OpenAI fetch failed");

    await assert.rejects(
      requestOpenAIJson(
        openAIProfile,
        rejectingFetch(controller, reason, fetchError),
        "/responses",
        { method: "POST", signal: controller.signal },
      ),
      (error: unknown) => error === reason,
    );
  });

  await t.test("OpenAI SSE", async () => {
    const reason = new Error("OpenAI SSE stopped in fetch");
    const controller = createHostAbortController();
    const fetchError = new TypeError("OpenAI stream fetch failed");
    const iterator = streamOpenAIEvents(
      openAIProfile,
      rejectingFetch(controller, reason, fetchError),
      "/responses",
      {},
      controller.signal,
    );

    await assert.rejects(
      iterator.next(),
      (error: unknown) => error === reason,
    );
  });

  await t.test("Anthropic JSON", async () => {
    const reason = new Error("Anthropic JSON stopped in fetch");
    const controller = createHostAbortController();
    const fetchError = new TypeError("Anthropic fetch failed");

    await assert.rejects(
      requestAnthropicJson(
        anthropicProfile,
        rejectingFetch(controller, reason, fetchError),
        "/messages",
        { method: "POST", signal: controller.signal },
      ),
      (error: unknown) => error === reason,
    );
  });

  await t.test("Anthropic SSE", async () => {
    const reason = new Error("Anthropic SSE stopped in fetch");
    const controller = createHostAbortController();
    const fetchError = new TypeError("Anthropic stream fetch failed");
    const iterator = streamAnthropicEvents(
      anthropicProfile,
      rejectingFetch(controller, reason, fetchError),
      {},
      controller.signal,
    );

    await assert.rejects(
      iterator.next(),
      (error: unknown) => error === reason,
    );
  });
});

test("reader release errors do not replace transport outcomes", async (t) => {
  await t.test("JSON read error", async () => {
    const readError = new Error("JSON reader failed");
    let cancelCalls = 0;
    let releaseCalls = 0;
    const response = {
      body: {
        getReader: () => ({
          read: async () => Promise.reject(readError),
          cancel: () => {
            cancelCalls += 1;
            return Promise.resolve();
          },
          releaseLock: () => {
            releaseCalls += 1;
            throw new Error("JSON release failed");
          },
        }),
      },
      headers: { get: () => null },
      status: 200,
    } as unknown as Response;

    await assert.rejects(
      readBoundedJsonResponse(response, { label: "Test provider" }),
      (error: unknown) => error === readError,
    );
    assert.equal(cancelCalls, 1);
    assert.equal(releaseCalls, 1);
  });

  await t.test("SSE consumer return", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const body = {
      getReader: () => ({
        read: async () => ({
          done: false,
          value: new TextEncoder().encode("data: first\n\n"),
        }),
        cancel: () => {
          cancelCalls += 1;
          return Promise.reject(new Error("SSE cancel failed"));
        },
        releaseLock: () => {
          releaseCalls += 1;
          throw new Error("SSE release failed");
        },
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const iterator = parseServerSentEventData(body as never);

    assert.deepEqual(await iterator.next(), { value: "first", done: false });
    assert.deepEqual(await iterator.return(undefined), {
      value: undefined,
      done: true,
    });
    assert.equal(cancelCalls, 1);
    assert.equal(releaseCalls, 1);
  });
});

function rejectingFetch(
  controller: AbortController,
  reason: Error,
  fetchError: Error,
): typeof fetch {
  return (async () => {
    controller.abort(reason);
    throw fetchError;
  }) as typeof fetch;
}
