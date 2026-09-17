import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { createHostAbortController } from "../runtime/host.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";
import { audioRecoveryHarness } from "./audio-recovery-test-helpers.js";

for (const elapsed of [1, 30 * 60_000]) {
  test(`Stop during separation progress cancels the accepted task at ${elapsed}ms`, async (t) => {
    const h = await audioRecoveryHarness(t, "lalal");
    const controller = createHostAbortController();
    const stopped = new Error("synthetic Stop");
    h.context.signal = controller.signal;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    h.adapter.inspect = async () => {
      h.calls.push("inspect");
      now += elapsed;
      return { status: "running", progress: 50 };
    };
    h.context.onProgress = async (message) => {
      if (formatUiMessage(message) === "Separating stems (50%)") {
        await Promise.resolve();
        controller.abort(stopped);
      }
    };
    h.adapter.cancel = async (taskId, signal) => {
      assert.equal(taskId, "fixture-task");
      assert.notEqual(signal, controller.signal);
      assert.equal(signal.aborted, false);
      h.calls.push("cancel");
    };
    const outcome = await h.run().then(() => undefined, (error: unknown) => error);
    assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
    assert.equal(outcome, stopped);
    const [saved] = await listAudioJobs(h.storage, h.session.id);
    assert.equal(saved!.status, "interrupted");
    assert.equal(saved!.remoteTaskId, "fixture-task");
    assert.equal((await audioJobViews(h.storage, h.session.id))[0]!.resumable, true);
    assert.doesNotMatch(formatUiMessage(saved!.message!), /confirmed cancellation/i);

    h.context.signal = createHostAbortController().signal;
    delete h.context.onProgress;
    h.adapter.inspect = async () => ({ status: "cancelled" });
    assert.equal((await resumeAudioJob(h.context, saved!.id)).status, "cancelled");
    assert.equal(h.calls.filter((call) => call === "submit").length, 1);
  });
}

test("separation wait expiry without Stop retains its task without cancelling it", async (t) => {
  const h = await audioRecoveryHarness(t, "lalal");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  h.adapter.inspect = async () => {
    now += 30 * 60_000;
    return { status: "running", progress: 50 };
  };
  h.adapter.cancel = async () => { h.calls.push("cancel"); };
  const job = await h.run();
  assert.equal(job.status, "interrupted");
  assert.equal(job.remoteTaskId, "fixture-task");
  assert.equal(h.calls.filter((call) => call === "cancel").length, 0);
  assert.equal((await audioJobViews(h.storage, h.session.id))[0]!.resumable, true);
});

test("Stop during separation timeout bookkeeping still cancels even when the provider rejects cancellation", async (t) => {
  const h = await audioRecoveryHarness(t, "lalal");
  const controller = createHostAbortController();
  const stopped = new Error("Stop during timeout bookkeeping");
  h.context.signal = controller.signal;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const probe = await fs.open(h.storage);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const writeFile = prototype.writeFile;
  await probe.close();
  h.adapter.inspect = async () => {
    now += 30 * 60_000;
    t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
      controller.abort(stopped);
      return writeFile.apply(this, args);
    });
    return { status: "running", progress: 50 };
  };
  h.adapter.cancel = async (taskId, signal) => {
    assert.equal(taskId, "fixture-task");
    assert.equal(signal.aborted, false);
    h.calls.push("cancel");
    throw new Error("synthetic cancellation unavailable");
  };
  const outcome = await h.run().then(() => undefined, (error: unknown) => error);
  assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
  assert.equal(outcome, stopped);
  const [job] = await listAudioJobs(h.storage, h.session.id);
  assert.equal(job!.status, "interrupted");
  assert.equal(job!.remoteTaskId, "fixture-task");
  assert.doesNotMatch(formatUiMessage(job!.message!), /confirmed cancellation|synthetic cancellation/i);
});

test("Stop at separation wait expiry bounds a stalled cancellation to three seconds", { timeout: 5_000 }, async (t) => {
  const h = await audioRecoveryHarness(t, "lalal");
  const controller = createHostAbortController();
  const stopped = new Error("Stop at wait expiry");
  h.context.signal = controller.signal;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  h.adapter.inspect = async () => {
    now += 30 * 60_000;
    return { status: "running", progress: 50 };
  };
  h.context.onProgress = (message) => {
    if (formatUiMessage(message) === "Separating stems (50%)") controller.abort(stopped);
  };
  const cancelling = Promise.withResolvers<AbortSignal>();
  h.adapter.cancel = async (taskId, signal) => {
    assert.equal(taskId, "fixture-task");
    h.calls.push("cancel");
    cancelling.resolve(signal);
    return new Promise(() => undefined);
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    let settled = false;
    const outcome = h.run().then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
    const signal = await Promise.race([cancelling.promise, outcome.then(() => undefined)]);
    assert.ok(signal, "Accepted task did not receive a cancellation attempt");
    assert.notEqual(signal, controller.signal);
    t.mock.timers.tick(2_999);
    await Promise.resolve();
    assert.equal(signal.aborted, false);
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(await outcome, stopped);
    assert.equal(signal.aborted, true);
    assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
    const [job] = await listAudioJobs(h.storage, h.session.id);
    assert.equal(job!.status, "interrupted");
    assert.equal(job!.remoteTaskId, "fixture-task");
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});
