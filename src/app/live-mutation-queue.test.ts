import assert from "node:assert/strict";
import test from "node:test";

import { LiveMutationQueue } from "./live-mutation-queue.js";

test("one activation-scoped LiveMutationQueue serializes writes from independent flows", async () => {
  const queue = new LiveMutationQueue();
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  const order: string[] = [];

  const first = queue.run(new AbortController().signal, async () => {
    order.push("first-start");
    firstStarted.resolve();
    await firstGate.promise;
    order.push("first-end");
  });
  await firstStarted.promise;

  const second = queue.run(new AbortController().signal, async () => {
    order.push("second-start");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("aborting a queued write cannot let a later write bypass the active owner", async () => {
  const queue = new LiveMutationQueue();
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  const order: string[] = [];

  const first = queue.run(new AbortController().signal, async () => {
    order.push("first-start");
    firstStarted.resolve();
    await firstGate.promise;
    order.push("first-end");
  });
  await firstStarted.promise;

  const waitingController = new AbortController();
  const skipped = queue.run(waitingController.signal, async () => {
    order.push("aborted-operation-must-not-run");
  });
  const third = queue.run(new AbortController().signal, async () => {
    order.push("third-start");
  });
  waitingController.abort(new Error("Session stopped."));
  await assert.rejects(skipped, /Session stopped/);
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);

  firstGate.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["first-start", "first-end", "third-start"]);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((targetResolve) => {
    resolve = targetResolve;
  });
  return { promise, resolve };
}
