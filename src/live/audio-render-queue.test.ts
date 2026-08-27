import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import { consumePreFxAudioQueued } from "./audio-render-queue.js";

test("a cancelled render remains the queue owner until its SDK operation settles", async () => {
  const pending: Array<{
    resolve(value: string): void;
  }> = [];
  let renderCalls = 0;
  const context = {
    resources: {
      renderPreFxAudio: () => {
        renderCalls += 1;
        return new Promise<string>((resolve) => pending.push({ resolve }));
      },
    },
  } as never;
  const firstController = new AbortController();
  const firstCancellation = new Error("Stop first render");
  const first = consumePreFxAudioQueued(
    context,
    {} as never,
    0,
    8,
    firstController.signal,
    async (filePath) => filePath,
  );
  await yieldImmediate();
  assert.equal(renderCalls, 1);
  firstController.abort(firstCancellation);
  await assert.rejects(first, (error: unknown) => error === firstCancellation);

  const second = consumePreFxAudioQueued(
    context,
    {} as never,
    8,
    16,
    new AbortController().signal,
    async (filePath) => filePath,
  );
  await yieldImmediate();
  assert.equal(renderCalls, 1);

  pending[0]!.resolve("first.wav");
  await yieldImmediate();
  assert.equal(renderCalls, 2);
  pending[1]!.resolve("second.wav");
  assert.equal(await second, "second.wav");
});

test("the queue holds a rendered temp path until its consumer finishes", async () => {
  let renderCalls = 0;
  let finishFirstConsumer!: () => void;
  const firstConsumer = new Promise<void>((resolve) => {
    finishFirstConsumer = resolve;
  });
  const context = {
    resources: {
      renderPreFxAudio: async () => `render-${++renderCalls}.wav`,
    },
  } as never;
  const signal = new AbortController().signal;
  const first = consumePreFxAudioQueued(
    context,
    {} as never,
    0,
    8,
    signal,
    async (filePath) => {
      await firstConsumer;
      return filePath;
    },
  );
  const second = consumePreFxAudioQueued(
    context,
    {} as never,
    8,
    16,
    signal,
    async (filePath) => filePath,
  );

  await yieldImmediate();
  assert.equal(renderCalls, 1);
  finishFirstConsumer();
  assert.equal(await first, "render-1.wav");
  await yieldImmediate();
  assert.equal(renderCalls, 2);
  assert.equal(await second, "render-2.wav");
});
