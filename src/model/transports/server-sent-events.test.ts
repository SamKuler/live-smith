import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import test from "node:test";

import { createHostAbortController } from "../../runtime/host.js";
import {
  MAX_DIRECT_SSE_EVENT_BYTES,
  parseServerSentEventData,
} from "./server-sent-events.js";

test("SSE parsing cancels a blocked reader when its request is aborted", async () => {
  const reason = new Error("steering interrupted the stream");
  let cancelledWith: unknown;
  const body = new ReadableStream<Uint8Array>({
    cancel(cancelReason) {
      cancelledWith = cancelReason;
    },
  });
  const controller = createHostAbortController();
  const iterator = parseServerSentEventData(
    body as unknown as Parameters<typeof parseServerSentEventData>[0],
    controller.signal,
  );
  const pending = iterator.next();

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(cancelledWith, reason);
});

test("SSE parsing rejects an event that never reaches a bounded delimiter", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array(MAX_DIRECT_SSE_EVENT_BYTES + 1).fill(97),
      );
    },
  });
  const iterator = parseServerSentEventData(
    body as unknown as Parameters<typeof parseServerSentEventData>[0],
  );

  await assert.rejects(iterator.next(), /oversized event/);
});
