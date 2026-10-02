import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { AttachmentProcessingError } from "../../src/attachments/contracts.js";
import { runDocumentParserWorker } from "../../src/runtime/document-parser.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const success = 'require("node:worker_threads").parentPort.postMessage({ok:true,text:"ready",truncated:false});';
const busy = 'const {workerData}=require("node:worker_threads");Atomics.store(new Int32Array(workerData),0,1);for(;;){}';

async function started(marker: SharedArrayBuffer): Promise<void> {
  const state = new Int32Array(marker);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (Atomics.load(state, 0) === 1) return;
    await delay(5);
  }
  throw new Error("Worker did not begin execution.");
}

test("cancellation ends synchronous parser execution and releases the worker slot", async () => {
  const marker = new SharedArrayBuffer(4);
  const controller = createHostAbortController();
  const pending = runDocumentParserWorker({ source: busy, job: marker, signal: controller.signal });
  const cancelled = assert.rejects(pending, /cancel running parser/);
  try {
    await started(marker);
    controller.abort(new Error("cancel running parser"));
    await cancelled;
    assert.deepEqual(await runDocumentParserWorker({ source: success, job: null }), { text: "ready", truncated: false });
  } finally { controller.abort(new Error("cancel running parser")); }
});

test("deadline ends a busy parser while the parent remains responsive", async () => {
  const marker = new SharedArrayBuffer(4);
  const pending = runDocumentParserWorker({ source: busy, job: marker, timeoutMs: 1_000 });
  const timedOut = assert.rejects(pending, (error: unknown) => error instanceof AttachmentProcessingError && error.code === "archive_limit");
  await started(marker);
  assert.equal(Atomics.load(new Int32Array(marker), 0), 1);
  await timedOut;
  assert.equal((await runDocumentParserWorker({ source: success, job: null })).text, "ready");
});

test("two active parsers bound concurrency and a cancelled waiter never consumes a slot", async () => {
  const controllers = [createHostAbortController(), createHostAbortController()];
  const markers = [new SharedArrayBuffer(4), new SharedArrayBuffer(4)];
  const active = controllers.map((controller, index) => runDocumentParserWorker({
    source: busy, job: markers[index], signal: controller.signal,
  }));
  const cancelled = active.map((promise) => assert.rejects(promise, /release active parser/));
  try {
    await Promise.all(markers.map(started));
    const waitingMarker = new SharedArrayBuffer(4);
    const waiter = createHostAbortController();
    const queued = runDocumentParserWorker({ source: busy, job: waitingMarker, signal: waiter.signal });
    const queuedCancelled = assert.rejects(queued, /cancel queued parser/);
    await delay(20);
    assert.equal(Atomics.load(new Int32Array(waitingMarker), 0), 0);
    waiter.abort(new Error("cancel queued parser"));
    await queuedCancelled;
    for (const controller of controllers) controller.abort(new Error("release active parser"));
    await Promise.all(cancelled);
    assert.equal((await runDocumentParserWorker({ source: success, job: null })).text, "ready");
  } finally { for (const controller of controllers) controller.abort(new Error("release active parser")); }
});

test("cancelling notified parser waiters passes the available slots to the remaining queue", async () => {
  const activeControllers = [createHostAbortController(), createHostAbortController()];
  const activeMarkers = [new SharedArrayBuffer(4), new SharedArrayBuffer(4)];
  const active = activeControllers.map((controller, index) => runDocumentParserWorker({
    source: busy, job: activeMarkers[index], signal: controller.signal,
  }));
  const activeCancelled = active.map((operation) => assert.rejects(operation, /release active parser/));
  const queuedControllers = [createHostAbortController(), createHostAbortController()];
  const survivorController = createHostAbortController();
  const originalEmit = Worker.prototype.emit;
  const originalEmitDescriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "emit");
  const queued: Promise<unknown>[] = [];
  let exits = 0;
  try {
    await Promise.all(activeMarkers.map(started));
    queued.push(...queuedControllers.map((controller) => assert.rejects(runDocumentParserWorker({
      source: busy, job: new SharedArrayBuffer(4), signal: controller.signal,
    }), /cancel notified parser/)));
    const survivorMarker = new SharedArrayBuffer(4);
    const survivor = runDocumentParserWorker({
      source: 'const {workerData}=require("node:worker_threads");Atomics.store(new Int32Array(workerData),0,1);' + success,
      job: survivorMarker, signal: survivorController.signal,
    });
    queued.push(survivor.catch(() => undefined));
    // Native exit handlers resolve termination before the independent Stop
    // microtask runs, placing cancellation at the slot-notification boundary.
    Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      const result = Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      if (event === "exit" && exits < queuedControllers.length) {
        const controller = queuedControllers[exits++]!;
        queueMicrotask(() => controller.abort(new Error("cancel notified parser")));
      }
      return result;
    };
    for (let index = 0; index < activeControllers.length; index += 1) {
      activeControllers[index]!.abort(new Error("release active parser"));
      await activeCancelled[index];
      await queued[index];
    }
    await started(survivorMarker);
    assert.deepEqual(await survivor, { text: "ready", truncated: false });
    assert.equal(exits, 2);
  } finally {
    if (originalEmitDescriptor) Object.defineProperty(Worker.prototype, "emit", originalEmitDescriptor);
    else Reflect.deleteProperty(Worker.prototype, "emit");
    for (const controller of activeControllers) controller.abort(new Error("release active parser"));
    for (const controller of queuedControllers) controller.abort(new Error("cancel notified parser"));
    survivorController.abort(new Error("cancel survivor parser"));
    await Promise.allSettled([...activeCancelled, ...queued]);
  }
});

test("parser failures expose safe errors and subsequent jobs still run", async () => {
  for (const source of [
    'throw new Error("private parser diagnostic");',
    'require("node:process").exit(0);',
    'require("node:worker_threads").parentPort.postMessage({ok:false,limit:true});',
  ]) {
    await assert.rejects(runDocumentParserWorker({ source, job: null }), (error: unknown) => {
      assert.ok(error instanceof AttachmentProcessingError);
      assert.doesNotMatch(error.message, /private parser diagnostic/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal((await runDocumentParserWorker({ source: success, job: null })).text, "ready");
});
