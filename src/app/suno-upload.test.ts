import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { retrievalHarness, connection } from "./audio-retrieval-test-helpers.js";
import { uploadSunoMusic, resumeSunoUpload } from "./suno-upload.js";
import type { SunoUploadAdapter } from "../audio-services/suno-upload.js";
import { AudioSubmissionNotStartedError, SUNO_UPLOAD_MUTATIONS, type SunoUploadMutationStage, type SunoUploadReceipt } from "../audio-services/contracts.js";
import { listAudioAssets } from "../storage/audio-assets.js";
import { bindAudioDirectory, listAudioJobs, loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";
import { createHostAbortController } from "../runtime/host.js";

const uploadId = "aaaaaaaa-1111-4111-8111-111111111111";
const clipId = "bbbbbbbb-2222-4222-8222-222222222222";
const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
const source = () => Promise.resolve({ bytes: waveBytes(6), label: "Arrangement source", origin: { kind: "arrangement" as const, startBeat: 0, endBeat: 16 } });
const mutationStages: Record<string, SunoUploadMutationStage> = { create: "creating", upload: "uploading", finish: "finishing", initialize: "initializing" };

async function fixture(t: Parameters<typeof retrievalHarness>[0]) {
  const h = await retrievalHarness(t);
  const calls: string[] = [];
  const mode: { lose?: string; abort?: string; notStarted?: string; pollOffline?: boolean; pollFailed?: boolean } = {};
  const entered = async (name: string) => {
    const jobs = await listAudioJobs(h.directory, h.session.id);
    if (mutationStages[name]) {
      assert.equal(jobs[0]!.upload?.pendingStage, mutationStages[name], `${name} must commit its dispatch intent first`);
      assert.equal(jobs[0]!.upload?.stage, SUNO_UPLOAD_MUTATIONS[mutationStages[name]!].from);
    }
    if (mode.notStarted === name) throw new AudioSubmissionNotStartedError("Synthetic pre-dispatch authentication failure");
    calls.push(name);
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
    { ...unknown.upload!, pendingStage: "creating" },
    { ...unknown.upload!, pendingStage: undefined },
    { ...unknown.upload!, url: "https://suno-data-uploads.s3.amazonaws.com/" },
  ]) await assert.rejects(updateAudioJob(h.directory, h.session.id, unknown.id, { upload: upload as SunoUploadReceipt }));
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, unknown.id)).upload, unknown.upload);
});

async function interruptCommit(
  t: Parameters<typeof fixture>[0], h: Awaited<ReturnType<typeof fixture>>, stage: SunoUploadMutationStage,
  mode: "stop" | "sync" | "sync-stop", boundary: "marker" | "receipt" = "marker",
) {
  const probe = await fs.open(path.join(h.directory, "commit-probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const originalWrite = prototype.writeFile, originalSync = prototype.sync;
  await probe.close();
  let armed = false, interrupted = false;
  t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
    const result = await originalWrite.apply(this, args);
    if (typeof args[0] === "string" && !interrupted) {
      const value = JSON.parse(args[0]) as { operation?: string; upload?: SunoUploadReceipt };
      if (value.operation === "upload_music" && (boundary === "marker" ? value.upload?.pendingStage === stage
        : value.upload?.stage === SUNO_UPLOAD_MUTATIONS[stage].to && value.upload.pendingStage === undefined)) {
        if (mode === "stop") { interrupted = true; h.controller.abort(); }
        else armed = true;
      }
    }
    return result;
  });
  t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
    if (armed && !interrupted && (await this.stat()).isDirectory()) {
      interrupted = true;
      if (mode === "sync-stop") h.controller.abort();
      throw new Error("Synthetic directory sync failure after replacement");
    }
    return originalSync.call(this);
  });
  return () => interrupted;
}

function assertOneMutationEach(calls: readonly string[]) {
  for (const name of Object.keys(mutationStages)) assert.equal(calls.filter((call) => call === name).length, 1, name);
}

for (const [step, stage] of Object.entries(mutationStages)) {
  for (const mode of ["stop", "sync-stop"] as const) test(`${mode} during ${step} intent commit keeps the prior confirmed stage`, async (t) => {
    const h = await fixture(t);
    const interrupted = await interruptCommit(t, h, stage, mode);
    const job = await h.run();
    t.mock.restoreAll();
    assert.equal(interrupted(), true);
    assert.equal(job.status, "interrupted");
    assert.ok(job.upload);
    assert.equal(job.upload?.stage, SUNO_UPLOAD_MUTATIONS[stage].from);
    assert.equal(job.upload.pendingStage, undefined);
    assert.equal(h.calls.includes(step), false);
    const resumable = job.upload.stage !== "created";
    assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, resumable);
    const before = h.calls.slice();
    if (!resumable) {
      await assert.rejects(resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, job.id), /cannot resume its transfer/);
      assert.deepEqual(h.calls, before);
    } else {
      const finished = await resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, job.id);
      assert.equal(finished.status, "ready");
      assertOneMutationEach(h.calls);
      assert.equal(finished.upload?.uploadId, uploadId);
      assert.equal(finished.upload?.clipId, clipId);
    }
  });
  for (const boundary of ["marker", "receipt"] as const) test(`one uncertain ${step} ${boundary} commit retries only local persistence`, async (t) => {
    const h = await fixture(t);
    const interrupted = await interruptCommit(t, h, stage, "sync", boundary);
    const job = await h.run();
    assert.equal(interrupted(), true);
    assert.equal(job.status, "ready");
    assert.equal(job.upload?.pendingStage, undefined);
    assert.deepEqual((await loadAudioJob(h.directory, h.session.id, job.id)).upload, job.upload);
    assertOneMutationEach(h.calls);
  });
  test(`known pre-dispatch ${step} rejection preserves its confirmed receipt`, async (t) => {
    const h = await fixture(t);
    h.mode.notStarted = step;
    const job = await h.run();
    assert.equal(job.status, "interrupted");
    assert.ok(job.upload);
    assert.equal(job.upload.stage, SUNO_UPLOAD_MUTATIONS[stage].from);
    assert.equal(job.upload.pendingStage, undefined);
    assert.equal(h.calls.includes(step), false);
    delete h.mode.notStarted;
    if (job.upload.stage === "created") {
      await assert.rejects(resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, job.id), /cannot resume its transfer/);
    } else {
      assert.equal((await resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, job.id)).status, "ready");
      assertOneMutationEach(h.calls);
    }
  });
}

test("an unresolved legacy upload marker remains readable and cannot be resumed", async (t) => {
  const h = await fixture(t);
  h.mode.lose = "initialize";
  const unknown = await h.run();
  const { pendingStage: _pending, ...receipt } = unknown.upload!;
  const bound = await bindAudioDirectory(h.directory, h.session.id);
  await fs.writeFile(path.join(bound!.directory, `${unknown.id}.job.json`), JSON.stringify({
    ...unknown, upload: { ...receipt, stage: "initializing" },
  }));
  const saved = await loadAudioJob(h.directory, h.session.id, unknown.id);
  assert.equal(saved.upload?.stage, "initializing");
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, false);
  const calls = h.calls.slice();
  await assert.rejects(resumeAudioJob({ ...h.freshContext(), sunoUploadAdapter: h.adapter }, saved.id), /cannot be sent again/);
  assert.deepEqual(h.calls, calls);
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
