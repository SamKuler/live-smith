import assert from "node:assert/strict";
import test from "node:test";
import { audioJobView } from "../../src/audio-services/contracts.js";
import { AudioStorageError, loadAudioJob, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { audioStorageHarness, fingerprint, overwriteJson } from "./support/audio-storage-test-helpers.js";

const first = "aaaaaaaa-1111-4111-8111-111111111111";
const second = "bbbbbbbb-2222-4222-8222-222222222222";
const expectedOutputs = [{ key: first, role: "music" as const }, { key: second, role: "music_alternative" as const }];
const input = { provider: "suno" as const, serviceId: "website", operation: "generate_music" as const,
  connectionFingerprint: fingerprint, stems: [] };

test("remote success subset survives storage and projects only independent key/role copies", async (t) => {
  const h = await audioStorageHarness(t, input);
  const job = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: first, expectedOutputs, remoteOutputs: [expectedOutputs[1]!],
    failedOutputKeys: [first], status: "ready",
  });
  const saved = await loadAudioJob(h.storage, h.session.id, job.id);
  assert.equal(saved.status, "ready");
  assert.deepEqual(saved.outputAssets, []);
  assert.deepEqual(saved.remoteOutputs, [expectedOutputs[1]]);
  assert.deepEqual(saved.failedOutputKeys, [first]);
  const view = audioJobView(saved);
  assert.deepEqual(view.remoteOutputs, saved.remoteOutputs);
  assert.deepEqual(Object.keys(view.remoteOutputs![0]!).sort(), ["key", "role"]);
  view.remoteOutputs![0]!.key = first;
  assert.equal(saved.remoteOutputs![0]!.key, second);
  assert.equal(Object.hasOwn(view, "expectedOutputs"), false);
  assert.equal(Object.hasOwn(view, "failedOutputKeys"), false);
  assert.equal(view.resumable, false);
  assert.equal(Object.hasOwn(view, "connectionFingerprint"), false);
});

test("task-level cancellation is immutable terminal state even when a successful preview remains", async (t) => {
  const h = await audioStorageHarness(t, input);
  const job = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: first, expectedOutputs, remoteOutputs: [expectedOutputs[0]!],
    remoteTaskTerminal: "cancelled", status: "ready",
  });
  assert.equal(audioJobView(job).resumable, false);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, job.id, { remoteTaskTerminal: "failed" }), AudioStorageError);
});

test("remote readiness rejects orphan, duplicate, noncanonical, wrong-role and URL identities on write and read", async (t) => {
  const h = await audioStorageHarness(t, input);
  const valid = { ...h.job, remoteTaskId: first, expectedOutputs, status: "running" };
  const target = `${h.directory}/${h.job.id}.job.json`;
  for (const remoteOutputs of [null, {}, [null], ["music"], [{ key: first }], [{ role: "music" }],
    [expectedOutputs[0], expectedOutputs[0]], [{ key: first, role: "music_alternative" }],
    [{ ...expectedOutputs[0], url: "https://example.com/private" }],
    ...["cccccccc-3333-4333-8333-333333333333", first.toUpperCase(), first + "\n", "opaque", "../clip"]
      .map((key) => [{ key, role: "music" }])]) {
    await overwriteJson(target, valid);
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { remoteOutputs } as never), AudioStorageError);
    await overwriteJson(target, { ...valid, remoteOutputs });
    await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
  }
  for (const invalid of [
    { ...valid, status: "ready" }, { ...valid, status: "ready", remoteOutputs: [] },
    { ...valid, expectedOutputs: undefined, remoteOutputs: [expectedOutputs[0]] },
    { ...valid, remoteTaskId: undefined, remoteOutputs: [expectedOutputs[0]] },
    { ...valid, remoteTaskId: second, remoteOutputs: [expectedOutputs[0]] },
    { ...valid, provider: "sunoapi", remoteOutputs: [expectedOutputs[0]] },
    { ...valid, expectedOutputs: [{ key: "opaque", role: "music" }], remoteOutputs: [{ key: "opaque", role: "music" }] },
    { ...valid, failedOutputKeys: [first, first] },
    { ...valid, remoteOutputs: [expectedOutputs[0]], failedOutputKeys: [first] },
    { ...valid, failedOutputKeys: ["cccccccc-3333-4333-8333-333333333333"] },
    { ...valid, remoteTaskTerminal: "done" },
    { ...valid, remoteTaskId: undefined, remoteTaskTerminal: "failed" },
  ]) {
    await overwriteJson(target, invalid);
    await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
  }
});

test("historical Suno records remain readable without remote success evidence", async (t) => {
  const h = await audioStorageHarness(t, input);
  const legacy = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: "old-task", expectedOutputRoles: ["music"], status: "interrupted",
  });
  assert.deepEqual(await loadAudioJob(h.storage, h.session.id, h.job.id), legacy);
  assert.equal(Object.hasOwn(audioJobView(legacy), "remoteOutputs"), false);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { status: "ready" }), AudioStorageError);
});
