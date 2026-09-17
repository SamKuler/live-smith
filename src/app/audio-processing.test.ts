import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";

import { SEPARATION_STEMS, type AudioServiceAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { listAudioJobs, updateAudioJob } from "../storage/audio-jobs.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { mp3Bytes } from "../storage/audio-storage-test-helpers.js";
import { resumeAudioJob, separateAudioStems, audioJobViews } from "./audio-processing.js";
import { subscribeSessionStateInvalidations } from "./session-state-events.js";

const key = "fixture-audio-service-key";
function wave(): Uint8Array {
  const data = Buffer.alloc(44 + 16_000);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8_000, 24); data.writeUInt32LE(16_000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(16_000, 40);
  return data;
}

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-audio-run-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Audio", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: "0",
    connection: { id: "splitter", name: "Stem account", provider: "lalal", enabled: true, apiKey: key } } });
  const calls: string[] = [];
  const submittedMediaTypes: string[] = [];
  const adapter: AudioServiceAdapter = {
    provider: "lalal", stems: SEPARATION_STEMS,
    upload: async () => { calls.push("upload"); return "remote-source"; },
    submit: async (_source, stems, idempotencyKey, _signal, sourceMediaType) => {
      assert.deepEqual(stems, ["vocals"]); assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
      submittedMediaTypes.push(sourceMediaType ?? "");
      calls.push("submit"); return "remote-task";
    },
    inspect: async () => {
      calls.push("inspect");
      return { status: "completed", outputs: [
        { key: "vocals", role: "vocals", url: "https://d.lalal.ai/vocals" },
        { key: "residual", role: "residual", url: "https://d.lalal.ai/residual" },
      ] };
    },
    download: async (output) => { calls.push(`download:${output.role}`); return wave(); },
    cancel: async () => { calls.push("cancel"); },
  };
  const controller = new AbortController();
  const context = { storageDirectory: directory, sessionId: session.id, signal: controller.signal, adapter, wait: async () => {} };
  const source = async () => ({ bytes: wave(), label: "Input", origin: { kind: "arrangement" as const, startBeat: 16, endBeat: 18, tempo: 120 } });
  return { directory, session, adapter, calls, submittedMediaTypes, controller, context, source };
}

test("separation persists the source, outputs and origin without credentials or remote URLs in view", async (t) => {
  const h = await harness(t);
  const job = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  assert.equal(job.status, "completed");
  assert.deepEqual(job.outputAssets.map((asset) => asset.role), ["vocals", "residual"]);
  for (const asset of job.outputAssets) {
    assert.equal(asset.origin.startBeat, 16);
    assert.deepEqual((await readAudioAsset(h.directory, h.session.id, asset.id)).bytes, new Uint8Array(wave()));
  }
  const view = JSON.stringify(await audioJobViews(h.directory, h.session.id));
  assert.doesNotMatch(view, /fixture-audio-service-key|d\.lalal\.ai|remote-task|connectionFingerprint/);
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
  assert.deepEqual(h.submittedMediaTypes, ["audio/wav"]);
});

test("MP3 separation keeps a compressed output request instead of expanding long sources to WAV", async (t) => {
  const h = await harness(t);
  h.adapter.download = async () => mp3Bytes();
  const result = await separateAudioStems(h.context, "splitter", ["vocals"], async () => ({
    bytes: mp3Bytes(), label: "Compressed input", origin: { kind: "attachment" as const },
  }));
  assert.equal(result.status, "completed");
  assert.deepEqual(h.submittedMediaTypes, ["audio/mpeg"]);
  assert.ok(result.outputAssets.every((asset) => asset.mediaType === "audio/mpeg"));
});

test("partial download preserves successful stems; resume retrieves only missing files without resubmission", async (t) => {
  const h = await harness(t);
  const download = h.adapter.download;
  h.adapter.download = async (output, signal) => {
    if (output.role === "residual") throw new Error("download interrupted");
    return download(output, signal);
  };
  const partial = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  assert.equal(partial.status, "partial");
  assert.equal(partial.outputAssets.length, 1);
  h.adapter.download = download;
  const completed = await resumeAudioJob(h.context, partial.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.outputAssets[0]?.id, partial.outputAssets[0]?.id);
  assert.equal(h.calls.filter((call) => call === "upload").length, 1);
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
  assert.equal(h.calls.filter((call) => call === "download:vocals").length, 1);
});

test("lost submission reply stays unknown and never replays the paid request", async (t) => {
  const h = await harness(t);
  h.adapter.submit = async () => { h.calls.push("submit"); throw new Error(`failure apiKey=${key}`); };
  const job = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  assert.equal(job.status, "unknown");
  assert.equal(job.remoteTaskId, undefined);
  assert.doesNotMatch(formatUiMessage(job.message ?? ""), new RegExp(key));
  await assert.rejects(resumeAudioJob(h.context, job.id), /no confirmed remote task ID/);
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
});

test("a late accepted submit ticket survives Stop and cancellation uses an independent signal", async (t) => {
  const h = await harness(t);
  h.adapter.submit = async () => { h.controller.abort(new Error("stopped")); return "remote-ticket"; };
  h.adapter.cancel = async (taskId, signal) => { assert.equal(taskId, "remote-ticket"); assert.equal(signal.aborted, false); h.calls.push("cancel"); };
  await assert.rejects(separateAudioStems(h.context, "splitter", ["vocals"], h.source), /stopped/);
  const job = (await listAudioJobs(h.directory, h.session.id))[0]!;
  assert.equal(job.remoteTaskId, "remote-ticket");
  assert.equal(job.status, "interrupted");
  assert.deepEqual(h.calls, ["upload", "cancel"]);
});

test("resume is scoped to the exact credential owner", async (t) => {
  const h = await harness(t);
  h.adapter.download = async () => { throw new Error("offline"); };
  const job = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: "1",
    connection: { id: "splitter", name: "Stem account", provider: "lalal", enabled: true, apiKey: "other-account" } } });
  const before = h.calls.length;
  await assert.rejects(resumeAudioJob(h.context, job.id), /different service connection/);
  assert.equal(h.calls.length, before);
});

test("processing status is polled within one operation and a remote cancellation is preserved", async (t) => {
  const h = await harness(t);
  let polls = 0;
  let waits = 0;
  h.adapter.inspect = async () => ++polls === 1 ? { status: "running", progress: 30 } : { status: "cancelled" };
  const job = await separateAudioStems({ ...h.context, wait: async () => { waits++; } }, "splitter", ["vocals"], h.source);
  assert.equal(job.status, "cancelled"); assert.equal(polls, 2); assert.equal(waits, 1);
  assert.deepEqual(job.outputAssets, []);
});

test("provider-confirmed separation failure is terminal and Resume does not poll it again", async (t) => {
  const h = await harness(t);
  h.adapter.inspect = async () => { h.calls.push("inspect"); return { status: "failed", message: "Fixture terminal failure" }; };
  const job = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  assert.equal(job.status, "failed");
  assert.equal(job.remoteTaskTerminal, "failed");
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]?.resumable, false);
  const before = h.calls.filter((call) => call === "inspect").length;
  const unchanged = await resumeAudioJob(h.context, job.id);
  assert.equal(unchanged.remoteTaskTerminal, "failed");
  assert.equal(h.calls.filter((call) => call === "inspect").length, before);
});

test("Stop cancels an accepted in-memory ticket even when persisting the receipt and failure both fail", async (t) => {
  const h = await harness(t);
  h.adapter.submit = async () => {
    await fs.rename(`${h.directory}/live-smith-audio/${h.session.id}`, `${h.directory}/offline-audio`);
    h.controller.abort(new Error("stopped"));
    return "accepted-ticket";
  };
  h.adapter.cancel = async (taskId, signal) => {
    assert.equal(taskId, "accepted-ticket"); assert.equal(signal.aborted, false);
    h.calls.push("cancel");
  };
  await assert.rejects(separateAudioStems(h.context, "splitter", ["vocals"], h.source));
  assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
});

test("Stop still cancels a persisted remote ticket when interruption bookkeeping fails", async (t) => {
  const h = await harness(t);
  h.adapter.inspect = async () => {
    await fs.rename(`${h.directory}/live-smith-audio/${h.session.id}`, `${h.directory}/offline-audio`);
    h.controller.abort(new Error("stopped"));
    throw new Error("read interrupted");
  };
  h.adapter.cancel = async (taskId, signal) => {
    assert.equal(taskId, "remote-task"); assert.equal(signal.aborted, false);
    h.calls.push("cancel");
  };
  await assert.rejects(separateAudioStems(h.context, "splitter", ["vocals"], h.source));
  assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
});

test("audio progress uses the send channel without a same-Session blocking state refresh", async (t) => {
  const h = await harness(t);
  let invalidations = 0;
  const messages: string[] = [];
  const unsubscribe = subscribeSessionStateInvalidations(h.directory, () => { invalidations++; });
  try {
    const job = await separateAudioStems({ ...h.context, onProgress: (message) => { messages.push(formatUiMessage(message)); } }, "splitter", ["vocals"], h.source);
    assert.equal(job.status, "completed");
    assert.ok(messages.length >= 3);
    assert.equal(invalidations, 0);
  } finally { unsubscribe(); }
});

test("all locally committed outputs recover without requiring an unexpired remote task", async (t) => {
  const h = await harness(t);
  const first = await separateAudioStems(h.context, "splitter", ["vocals"], h.source);
  await updateAudioJob(h.directory, h.session.id, first.id, { status: "collecting", outputAssets: [] });
  h.adapter.inspect = async () => { throw new Error("remote result expired"); };
  const recovered = await resumeAudioJob(h.context, first.id);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.outputAssets.map((asset) => asset.id).sort(), first.outputAssets.map((asset) => asset.id).sort());
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
});

test("Stop arriving during failure bookkeeping still cancels the accepted remote task", async (t) => {
  const h = await harness(t);
  h.adapter.inspect = async () => {
    const error = new Error();
    Object.defineProperty(error, "message", { get() {
      queueMicrotask(() => h.controller.abort(new Error("stopped during bookkeeping")));
      return "temporary status failure";
    } });
    throw error;
  };
  await assert.rejects(separateAudioStems(h.context, "splitter", ["vocals"], h.source), /stopped during bookkeeping/);
  assert.equal(h.calls.filter((call) => call === "cancel").length, 1);
});
