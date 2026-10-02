import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { ReadableStream } from "node:stream/web";
import test from "node:test";

import { createHostAbortController } from "../../../src/runtime/host.js";
import {
  MAX_DIRECT_SSE_EVENT_BYTES,
  parseServerSentEventData,
} from "../../../src/model/transports/server-sent-events.js";

function eventStream(chunks: readonly Uint8Array[]): Parameters<typeof parseServerSentEventData>[0] {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }) as Parameters<typeof parseServerSentEventData>[0];
}

function framedEvents(lineEnding: string): Uint8Array {
  return Buffer.from([
    ": keepalive",
    "event: message",
    "id: 7",
    "data: {",
    'data: "text":"雪",',
    'data: "ok":true}',
    "",
    "data:",
    "",
    "data: final",
    "",
    "",
  ].join(lineEnding));
}

test("SSE parsing preserves multiline data with LF, CRLF, and CR line endings", async (t) => {
  for (const [name, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
    await t.test(name, async () => {
      const data = await Array.fromAsync(parseServerSentEventData(eventStream([framedEvents(lineEnding)])));
      assert.deepEqual(data, ['{\n"text":"雪",\n"ok":true}', "", "final"]);
      assert.deepEqual(JSON.parse(data[0]!), { text: "雪", ok: true });
    });
  }
});

test("SSE event framing is independent of chunk boundaries", async (t) => {
  for (const [name, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
    await t.test(name, async () => {
      const bytes = framedEvents(lineEnding);
      for (let split = 1; split < bytes.byteLength; split += 1) {
        const data = await Array.fromAsync(parseServerSentEventData(eventStream([
          bytes.subarray(0, split), bytes.subarray(split),
        ])));
        assert.deepEqual(data, ['{\n"text":"雪",\n"ok":true}', "", "final"], `split at byte ${split}`);
      }
      const data = await Array.fromAsync(parseServerSentEventData(eventStream(
        Array.from(bytes, (byte) => Uint8Array.of(byte)),
      )));
      assert.deepEqual(data, ['{\n"text":"雪",\n"ok":true}', "", "final"]);
    });
  }
});

test("SSE parsing dispatches a CR-terminated event before the next chunk", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { producer = controller; },
  });
  const iterator = parseServerSentEventData(body as Parameters<typeof parseServerSentEventData>[0]);
  producer.enqueue(Buffer.from("data: first\r\n\r"));
  assert.deepEqual(await iterator.next(), { done: false, value: "first" });
  // The LF completes the preceding CRLF instead of starting another event.
  producer.enqueue(Buffer.from('\ndata: {\r\ndata: "ok":true}\r\n\r\n'));
  assert.deepEqual(await iterator.next(), { done: false, value: '{\n"ok":true}' });
  producer.close();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("SSE parsing applies its byte bound to the complete multiline event", async () => {
  const line = "data: " + "x".repeat(1024) + "\r\n";
  const bytes = Buffer.from(line.repeat(Math.ceil((MAX_DIRECT_SSE_EVENT_BYTES + 1) / line.length)));
  const iterator = parseServerSentEventData(eventStream([bytes]));
  await assert.rejects(iterator.next(), /oversized event/);
});

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
