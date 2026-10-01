import assert from "node:assert/strict";
import test from "node:test";

import { AudioPollScheduler } from "../../../src/app/audio/audio-polling.js";

test("LALAL polls sharing one credential stay below the published account limit", async () => {
  let now = 0;
  const waits: number[] = [];
  const scheduler = new AudioPollScheduler({
    now: () => now,
    wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  });
  const signal = new AbortController().signal;
  const started: number[] = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    await scheduler.wait("lalal", "storage-and-credential", signal);
    started.push(now);
  }));
  assert.deepEqual(started, [0, 2_100, 4_200]);
  assert.deepEqual(waits, [2_100, 2_100]);
});

test("poll scheduling does not delay unrelated credentials or providers", async () => {
  let waits = 0;
  const scheduler = new AudioPollScheduler({ now: () => 0, wait: async () => { waits++; } });
  const signal = new AbortController().signal;
  await Promise.all([
    scheduler.wait("lalal", "first", signal),
    scheduler.wait("lalal", "second", signal),
    scheduler.wait("sunoapi", "first", signal),
    scheduler.wait("suno", "first", signal),
  ]);
  assert.equal(waits, 0);
});
