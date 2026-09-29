import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { retrievalHarness, connection } from "./audio-retrieval-test-helpers.js";
import { uploadSunoMusic, resumeSunoUpload } from "./suno-upload.js";
import type { SunoUploadAdapter } from "../audio-services/suno-upload.js";
import type { SunoUploadReceipt } from "../audio-services/contracts.js";
import { listAudioAssets } from "../storage/audio-assets.js";
import { listAudioJobs, loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";
import { createHostAbortController } from "../runtime/host.js";

const uploadId = "aaaaaaaa-1111-4111-8111-111111111111";
const clipId = "bbbbbbbb-2222-4222-8222-222222222222";
const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
const source = () => Promise.resolve({ bytes: waveBytes(6), label: "Arrangement source", origin: { kind: "arrangement" as const, startBeat: 0, endBeat: 16 } });

async function fixture(t: Parameters<typeof retrievalHarness>[0]) {
  const h = await retrievalHarness(t);
  const calls: string[] = [];
  const mode: { lose?: string; abort?: string; pollOffline?: boolean; pollFailed?: boolean } = {};
  const stages: Record<string, SunoUploadReceipt["stage"]> = { create: "creating", upload: "uploading", finish: "finishing", initialize: "initializing" };
  const entered = async (name: string) => {
    calls.push(name);
    const jobs = await listAudioJobs(h.directory, h.session.id);
    if (stages[name]) assert.equal(jobs[0]!.upload?.stage, stages[name], `${name} must commit its start marker first`);
    if (mode.lose === name) throw new Error("Synthetic lost reply with private signed storage information");
    if (mode.abort === name) h.controller.abort();
  };
  const adapter: SunoUploadAdapter = {
    limits: async () => { calls.push("limits"); return { minimumSeconds: 6, maximumSeconds: 60 }; },
    create: async () => { await entered("create"); return { uploadId, url: "https://suno-data-uploads.s3.amazonaws.com/", fields: { policy: "synthetic-secret-policy" } }; },
    upload: async (_spec, bytes) => { assert.deepEqual(bytes, waveBytes(6)); await entered("upload"); },
    finish: async (id) => { assert.equal(id, uploadId); await entered("finish"); },
    inspect: async (id) => { assert.equal(id, uploadId); calls.push("inspect"); if (mode.pollOffline) throw new Error("Offline"); return { status: mode.pollFailed ? "failed" : "complete" }; },
    initialize: async (id) => { assert.equal(id, uploadId); await entered("initialize"); return clipId; },
  };
  const context = { ...h.context, withGenerationAuthorization: authorize, wait: async () => undefined };
  const freshContext = () => ({ ...context, signal: createHostAbortController().signal });
  const run = () => uploadSunoMusic(context, connection.id, true, source, { adapter });
  return { ...h, context, freshContext, run, adapter, calls, mode };
}

test("Suno upload preserves one source and the two distinct remote IDs in the ordinary job", async (t) => {
  const h = await fixture(t);
  const job = await h.run();
  assert.equal(job.status, "ready");
  assert.deepEqual(job.upload, { stage: "complete", rightsConfirmed: true,
    sourceSha256: createHash("sha256").update(waveBytes(6)).digest("hex"), uploadId, clipId });
  assert.equal(job.remoteTaskId, clipId);
  assert.deepEqual(job.remoteOutputs, [{ key: clipId, role: "uploaded_audio" }]);
  assert.equal(job.outputAssets.length, 0);
  assert.deepEqual(h.calls, ["limits", "create", "upload", "finish", "inspect", "initialize"]);
  assert.doesNotMatch(JSON.stringify(job), /synthetic-secret-policy|s3\.amazonaws|private signed/);
  assert.equal((await listAudioAssets(h.directory, h.session.id, job.id))[0]!.role, "source");
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 1);
});

for (const step of ["create", "upload", "finish", "initialize"]) test(`lost ${step} reply stays unknown and Resume never repeats that mutation`, async (t) => {
  const h = await fixture(t);
  h.mode.lose = step;
  const job = await h.run();
  assert.equal(job.status, "unknown");
  const before = h.calls.slice();
  await assert.rejects(resumeSunoUpload(h.freshContext(), job, { adapter: h.adapter }), /cannot be sent again/);
  assert.deepEqual(h.calls, before);
  assert.doesNotMatch(JSON.stringify(job), /private signed/);
});

test("confirmed multipart receipt survives Stop and explicit Resume only finishes and initializes", async (t) => {
  const h = await fixture(t);
  h.mode.abort = "upload";
  const paused = await h.run();
  assert.equal(paused.status, "interrupted");
  assert.equal(paused.upload?.stage, "uploaded");
  delete h.mode.abort;
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, true);
  const finished = await resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, paused.id);
  assert.equal(finished.status, "ready");
  assert.equal(h.calls.filter((call) => call === "create").length, 1);
  assert.equal(h.calls.filter((call) => call === "upload").length, 1);
  assert.equal(h.calls.filter((call) => call === "finish").length, 1);
});

test("read-only processing failure resumes polling without repeating upload or finish", async (t) => {
  const h = await fixture(t);
  h.mode.pollOffline = true;
  const interrupted = await h.run();
  assert.equal(interrupted.upload?.stage, "processing");
  assert.equal(interrupted.status, "interrupted");
  h.mode.pollOffline = false;
  const job = await resumeSunoUpload(h.freshContext(), interrupted, { adapter: h.adapter });
  assert.equal(job.upload?.clipId, clipId);
  assert.equal(h.calls.filter((call) => call === "finish").length, 1);
  assert.equal(h.calls.filter((call) => call === "initialize").length, 1);
});

test("upload requires explicit rights and rejects unsupported source and account duration before mutations", async (t) => {
  const h = await fixture(t);
  await assert.rejects(uploadSunoMusic(h.context, connection.id, false, source, { adapter: h.adapter }), /rights/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await listAudioJobs(h.directory, h.session.id), []);
  const failed = await uploadSunoMusic(h.context, connection.id, true, async () => ({ ...await source(), bytes: waveBytes(1) }), { adapter: h.adapter });
  assert.equal(failed.status, "failed");
  assert.deepEqual(h.calls, ["limits"]);
  const invalid = await uploadSunoMusic(h.context, connection.id, true,
    async () => ({ ...await source(), origin: { kind: "generated" as const } }), { adapter: h.adapter });
  assert.equal(invalid.status, "failed");
  assert.equal(h.calls.filter((call) => call === "create").length, 0);
});

test("an accepted initialization ID is saved even if Stop arrives with its response", async (t) => {
  const h = await fixture(t);
  h.mode.abort = "initialize";
  const job = await h.run();
  assert.equal(job.status, "ready");
  assert.equal((await loadAudioJob(h.directory, h.session.id, job.id)).upload?.clipId, clipId);
  assert.equal((await resumeSunoUpload(h.freshContext(), job, { adapter: h.adapter })).id, job.id);
  assert.equal(h.calls.filter((call) => call === "initialize").length, 1);
});


test("upload storage rejects changed receipts and unknown stages never advertise Resume", async (t) => {
  const h = await fixture(t);
  h.mode.lose = "initialize";
  const unknown = await h.run();
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, false);
  for (const upload of [
    { ...unknown.upload!, stage: "prepared" as const, uploadId: undefined },
    { ...unknown.upload!, uploadId: clipId },
    { ...unknown.upload!, sourceSha256: "0".repeat(64) },
    { ...unknown.upload!, rightsConfirmed: false },
    { ...unknown.upload!, url: "https://suno-data-uploads.s3.amazonaws.com/" },
  ]) await assert.rejects(updateAudioJob(h.directory, h.session.id, unknown.id, { upload: upload as SunoUploadReceipt }));
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, unknown.id)).upload, unknown.upload);
});


test("terminal upload processing rejection cannot resume or initialize", async (t) => {
  const h = await fixture(t);
  h.mode.pollFailed = true;
  const rejected = await h.run();
  assert.equal(rejected.status, "failed");
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, false);
  const calls = h.calls.slice();
  await assert.rejects(resumeSunoUpload(h.freshContext(), rejected, { adapter: h.adapter }), /cannot be resumed/);
  assert.deepEqual(h.calls, calls);
  assert.equal(h.calls.includes("initialize"), false);
});
