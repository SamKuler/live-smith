import assert from "node:assert/strict";
import test from "node:test";

import { SessionMutationFence } from "./session-mutation-fence.js";

test("SessionMutationFence serializes one Session without blocking another", async () => {
  const fence = new SessionMutationFence();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstActive = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const order: string[] = [];

  const first = fence.run("session-a", async () => {
    order.push("a1-start");
    firstStarted();
    await firstGate;
    order.push("a1-end");
  });
  await firstActive;
  const second = fence.run("session-a", async () => {
    order.push("a2");
  });
  const other = fence.run("session-b", async () => {
    order.push("b");
  });

  await other;
  assert.deepEqual(order, ["a1-start", "b"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1-start", "b", "a1-end", "a2"]);
});

test("SessionMutationFence immediately removes an aborted queued operation", async () => {
  const fence = new SessionMutationFence();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstActive = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const order: string[] = [];
  const first = fence.run("session-a", async () => {
    order.push("first-start");
    firstStarted();
    await firstGate;
    order.push("first-end");
  });
  await firstActive;

  const controller = new AbortController();
  let cancelledOperationStarts = 0;
  const cancelled = fence.run("session-a", controller.signal, async () => {
    cancelledOperationStarts += 1;
  });
  const third = fence.run("session-a", async () => {
    order.push("third");
  });
  const cancellation = new Error("queued request closed");
  controller.abort(cancellation);

  await assert.rejects(cancelled, (error: unknown) => error === cancellation);
  assert.equal(cancelledOperationStarts, 0);
  assert.deepEqual(order, ["first-start"]);

  releaseFirst();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["first-start", "first-end", "third"]);
});

test("SessionMutationFence does not enqueue an already-aborted operation", async () => {
  const fence = new SessionMutationFence();
  const controller = new AbortController();
  const cancellation = new Error("already closed");
  controller.abort(cancellation);
  let starts = 0;

  await assert.rejects(
    fence.run("session-a", controller.signal, async () => {
      starts += 1;
    }),
    (error: unknown) => error === cancellation,
  );
  assert.equal(starts, 0);

  await fence.run("session-a", async () => {
    starts += 1;
  });
  assert.equal(starts, 1);
});

test("SessionMutationFence reports queued or active named operations", async () => {
  const fence = new SessionMutationFence();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstActive = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });

  const first = fence.runNamed("session-a", "send", undefined, async () => {
    firstStarted();
    await firstGate;
  });
  await firstActive;
  const queued = fence.runNamed("session-a", "skills", undefined, async () => undefined);

  assert.equal(fence.hasQueuedOrActive("session-a", "send"), true);
  assert.equal(fence.hasQueuedOrActive("session-a", "skills"), true);
  assert.equal(fence.hasQueuedOrActive("session-b", "send"), false);

  releaseFirst();
  await Promise.all([first, queued]);
  assert.equal(fence.hasQueuedOrActive("session-a", "send"), false);
});

test("SessionMutationFence exposes a send queued behind another Session mutation", async () => {
  const fence = new SessionMutationFence();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstActive = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });

  const first = fence.runNamed("session-a", "attachment", undefined, async () => {
    firstStarted();
    await firstGate;
  });
  await firstActive;
  const send = fence.runNamed("session-a", "send", undefined, async () => undefined);

  assert.equal(fence.hasQueuedOrActive("session-a", "send"), true);
  assert.equal(fence.queuedOrActiveCount("session-a"), 2);

  releaseFirst();
  await Promise.all([first, send]);
  assert.equal(fence.queuedOrActiveCount("session-a"), 0);
});

test("Session-first reuse probing does not hold intent changes behind a send", async () => {
  const mutationFence = new SessionMutationFence();
  const intentFence = new SessionMutationFence();
  const order: string[] = [];
  let releaseFirstIntent!: () => void;
  let firstIntentStarted!: () => void;
  let probeHasMutation!: () => void;
  const firstIntentGate = new Promise<void>((resolve) => {
    releaseFirstIntent = resolve;
  });
  const firstIntentActive = new Promise<void>((resolve) => {
    firstIntentStarted = resolve;
  });
  const probeMutationActive = new Promise<void>((resolve) => {
    probeHasMutation = resolve;
  });

  const firstIntent = intentFence.run("session-a", async () => {
    firstIntentStarted();
    await firstIntentGate;
  });
  await firstIntentActive;
  const probe = mutationFence.run("session-a", async () => {
    probeHasMutation();
    await intentFence.run("session-a", async () => {
      order.push("probe-intent");
    });
  });
  await probeMutationActive;
  const send = mutationFence.runNamed(
    "session-a",
    "send",
    undefined,
    async () => {
      order.push("send");
    },
  );
  const secondIntent = intentFence.run("session-a", async () => {
    order.push("second-intent");
  });

  releaseFirstIntent();
  await Promise.all([firstIntent, probe, send, secondIntent]);
  assert.deepEqual(order, ["probe-intent", "second-intent", "send"]);
});
