import assert from "node:assert/strict";
import test from "node:test";
import { generateAudio, retrieveMusic } from "../../src/app/audio-generation.js";
import { audioJobViews, resumeAudioJob } from "../../src/app/audio-processing.js";
import { listAudioAssets } from "../../src/storage/audio-assets.js";
import { updateAudioJob } from "../../src/storage/audio-jobs.js";
import { clipIds, connection, manifest, retrievalHarness } from "./support/audio-retrieval-test-helpers.js";

test("Suno generation finishes ready without any download or local asset", async (t) => {
  const h = await retrievalHarness(t);
  h.adapter.prepare = async () => { h.calls.prepare++; };
  h.adapter.submit = async () => { h.calls.submit++; return { kind: "task", taskId: clipIds[0]!, expectedOutputs: manifest }; };
  const result = await generateAudio(h.context, connection.id, {
    operation: "generate_music", prompt: "Original piano", instrumental: true,
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.remoteOutputs, manifest);
  assert.deepEqual(result.outputAssets, []);
  assert.deepEqual(await listAudioAssets(h.directory, h.session.id), []);
  assert.deepEqual(h.calls, { prepare: 1, submit: 1, inspect: 1, downloads: [] });
});

test("ready survives reopening, retrieval reuse and Resume with no implicit download", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(job.status, "ready");
  const view = (await audioJobViews(h.directory, h.session.id))[0]!;
  assert.equal(view.status, "ready");
  assert.equal(view.resumable, false);
  assert.deepEqual(view.remoteOutputs, manifest);
  assert.doesNotMatch(JSON.stringify(view), /https?:|download\/clip|fixture-signature|user_fixture/);
  assert.equal((await retrieveMusic(h.context, connection.id, [...clipIds].reverse())).id, job.id);
  await h.sessions.clear(connection.id);
  assert.equal((await resumeAudioJob(h.context, job.id)).status, "ready");
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 1, downloads: [] });
});

test("mixed remote success and a confirmed failed sibling are terminal without another poll", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.failed.add(clipIds[0]!);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(job.status, "ready");
  assert.deepEqual(job.remoteOutputs, [manifest[1]]);
  assert.deepEqual(job.outputAssets, []);
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.resumable, false);
  const inspections = h.calls.inspect;
  h.adapter.inspect = async () => ({ status: "failed", message: "Remote unavailable." });
  const retried = await resumeAudioJob(h.context, job.id);
  assert.equal(retried.status, "ready");
  assert.deepEqual(retried.remoteOutputs, job.remoteOutputs);
  assert.equal(h.calls.inspect, inspections);
  assert.deepEqual(h.calls.downloads, []);
});

test("a stopped download's remote receipt recovers ready locally instead of remaining collecting", async (t) => {
  const h = await retrievalHarness(t);
  const job = await retrieveMusic(h.context, connection.id, clipIds);
  await updateAudioJob(h.directory, h.session.id, job.id, { status: "collecting", message: "Downloading the selected Suno song." });
  await h.sessions.clear(connection.id);
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]!.status, "ready");
  const recovered = await resumeAudioJob(h.context, job.id);
  assert.equal(recovered.status, "ready");
  assert.deepEqual(recovered.outputAssets, []);
  assert.deepEqual(recovered.remoteOutputs, manifest);
  assert.deepEqual(h.calls, { prepare: 0, submit: 0, inspect: 1, downloads: [] });
});

test("no successful remote outputs cannot create ready or download files", async (t) => {
  const h = await retrievalHarness(t);
  h.mode.failed = new Set(clipIds);
  const result = await retrieveMusic(h.context, connection.id, clipIds);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.remoteOutputs, []);
  assert.deepEqual(result.outputAssets, []);
  assert.deepEqual(h.calls.downloads, []);
});
