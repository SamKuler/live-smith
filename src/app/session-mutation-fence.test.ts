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
