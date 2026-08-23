import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import type { SavedProfile } from "../profile.js";
import { requestAnthropicJson } from "./anthropic-http.js";
import { requestOpenAIJson } from "./openai-http.js";
import { readBoundedJsonResponse } from "./response-body.js";
import {
  MAX_DIRECT_SSE_EVENT_BYTES,
  parseServerSentEventData,
} from "./server-sent-events.js";

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

test("non-2xx provider responses do not wait for body cancellation", async (t) => {
  await t.test("OpenAI", async () => {
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, { status: 503 });

    await assert.rejects(
      settleBeforeDeadline(requestOpenAIJson(
        openAIProfile,
        (async () => response) as typeof fetch,
        "/responses",
        { method: "POST" },
      )),
      /OpenAI-compatible HTTP 503: request failed/,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("Anthropic", async () => {
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, { status: 503 });

    await assert.rejects(
      settleBeforeDeadline(requestAnthropicJson(
        anthropicProfile,
        (async () => response) as typeof fetch,
        "/messages",
        { method: "POST" },
      )),
      /Anthropic HTTP 503: request failed/,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("pre-aborted OpenAI", async () => {
    const reason = new Error("OpenAI request stopped");
    const controller = createHostAbortController();
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, { status: 503 });
    controller.abort(reason);

    await assert.rejects(
      settleBeforeDeadline(requestOpenAIJson(
        openAIProfile,
        (async () => response) as typeof fetch,
        "/responses",
        { method: "POST", signal: controller.signal },
      )),
      (error: unknown) => error === reason,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("pre-aborted Anthropic", async () => {
    const reason = new Error("Anthropic request stopped");
    const controller = createHostAbortController();
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, { status: 503 });
    controller.abort(reason);

    await assert.rejects(
      settleBeforeDeadline(requestAnthropicJson(
        anthropicProfile,
        (async () => response) as typeof fetch,
        "/messages",
        { method: "POST", signal: controller.signal },
      )),
      (error: unknown) => error === reason,
    );
    assert.equal(stream.cancelCalls(), 1);
  });
});

test("bounded JSON failures do not wait for stream cancellation", async (t) => {
  await t.test("declared excess", async () => {
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, {
      status: 200,
      headers: { "Content-Length": "9" },
    });

    await assert.rejects(
      settleBeforeDeadline(readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
      })),
      /larger than 8 bytes/,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("pre-aborted declared excess", async () => {
    const reason = new Error("JSON request stopped");
    const controller = createHostAbortController();
    const stream = neverSettlingCancelStream();
    const response = new Response(stream.body as never, {
      status: 200,
      headers: { "Content-Length": "9" },
    });
    controller.abort(reason);

    await assert.rejects(
      settleBeforeDeadline(readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
        signal: controller.signal,
      })),
      (error: unknown) => error === reason,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("streamed excess", async () => {
    const stream = neverSettlingCancelStream(
      new Uint8Array(9).fill(97),
    );
    const response = new Response(stream.body as never, { status: 200 });

    await assert.rejects(
      settleBeforeDeadline(readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
      })),
      /larger than 8 bytes/,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("reader error", async () => {
    const readError = new Error("reader failed");
    let cancelCalls = 0;
    const response = {
      body: {
        getReader: () => ({
          read: async () => Promise.reject(readError),
          cancel: () => {
            cancelCalls += 1;
            return new Promise<void>(() => {});
          },
          releaseLock: () => {},
        }),
      },
      headers: { get: () => null },
      status: 200,
    } as unknown as Response;

    await assert.rejects(
      settleBeforeDeadline(readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
      })),
      (error: unknown) => error === readError,
    );
    assert.equal(cancelCalls, 1);
  });
});

test("SSE termination does not wait for stream cancellation", async (t) => {
  await t.test("oversized event", async () => {
    const stream = neverSettlingCancelStream(
      new Uint8Array(MAX_DIRECT_SSE_EVENT_BYTES + 1).fill(97),
    );
    const iterator = parseServerSentEventData(stream.body as never);

    await assert.rejects(
      settleBeforeDeadline(iterator.next()),
      /oversized event/,
    );
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("consumer early return", async () => {
    const stream = neverSettlingCancelStream(
      new TextEncoder().encode("data: first\n\n"),
    );
    const iterator = parseServerSentEventData(stream.body as never);

    assert.deepEqual(await settleBeforeDeadline(iterator.next()), {
      value: "first",
      done: false,
    });
    assert.deepEqual(await settleBeforeDeadline(iterator.return(undefined)), {
      value: undefined,
      done: true,
    });
    assert.equal(stream.cancelCalls(), 1);
  });

  await t.test("request abort", async () => {
    const reason = new Error("request stopped");
    const stream = neverSettlingCancelStream();
    const controller = createHostAbortController();
    const iterator = parseServerSentEventData(
      stream.body as never,
      controller.signal,
    );
    const pending = iterator.next();

    controller.abort(reason);

    await assert.rejects(
      settleBeforeDeadline(pending),
      (error: unknown) => error === reason,
    );
    assert.equal(stream.cancelCalls(), 1);
  });
});

function neverSettlingCancelStream(initialChunk?: Uint8Array): {
  body: ReadableStream<Uint8Array>;
  cancelCalls: () => number;
} {
  let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initialChunk) controller.enqueue(initialChunk);
    },
    cancel() {
      cancelCalls += 1;
      return new Promise<void>(() => {});
    },
  });
  return { body, cancelCalls: () => cancelCalls };
}

async function settleBeforeDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Operation did not settle before the deadline.")),
          100,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
