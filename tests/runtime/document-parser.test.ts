import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

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
