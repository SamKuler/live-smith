import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { AudioStorageError, loadAudioJob, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { audioStorageHarness, generationJobCases, overwriteJson } from "./support/audio-storage-test-helpers.js";

const identities = [{ key: "track-a", role: "music" as const }, { key: "track-b", role: "music_alternative" as const }];
const music = generationJobCases.find((entry) => entry.input.provider === "sunoapi")!.input;

test("remote output identities round-trip privately and cannot be replaced, swapped or cleared", async (t) => {
  const h = await audioStorageHarness(t, music);
  const patch = { remoteTaskId: "task-one", expectedOutputs: identities };
  const saved = await updateAudioJob(h.storage, h.session.id, h.job.id, patch);
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).expectedOutputs, identities);
  assert.equal(Object.hasOwn(saved, "expectedOutputRoles"), false);
  const target = path.join(h.directory, `${h.job.id}.job.json`);
  const original = await fs.readFile(target, "utf8");
  for (const update of [
    { expectedOutputs: [{ ...identities[0], key: "replacement" }, identities[1]] },
    { expectedOutputs: [{ ...identities[0], key: "track-b" }, { ...identities[1], key: "track-a" }] },
    { expectedOutputs: identities.slice(0, 1) },
    { expectedOutputs: undefined }, { expectedOutputs: null },
    { expectedOutputs: identities, expectedOutputRoles: ["music", "music_alternative"] },
    { remoteTaskId: "different-task" },
  ]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, update as never), AudioStorageError);
    assert.equal(await fs.readFile(target, "utf8"), original);
  }
  assert.deepEqual((await updateAudioJob(h.storage, h.session.id, h.job.id, patch)).expectedOutputs, identities);
});

test("output identity validation rejects corrupt metadata and locators without saving URLs", async (t) => {
  const h = await audioStorageHarness(t, music);
  const target = path.join(h.directory, `${h.job.id}.job.json`);
  for (const outputs of [
    [], null, {}, [null], ["music"], [{ key: "a" }], [{ role: "music" }],
    [{ key: "a", role: "music", url: "https://example.com/audio" }],
    [{ key: "a", role: "source" }], [{ key: "a", role: "music_alternative" }],
    [{ key: "a", role: "music" }, { key: "a", role: "music_alternative" }],
    ...["", "../a", "https://example.com/a", "a\n", "a".repeat(257), null]
      .map((key) => [{ key, role: "music" }]),
  ]) {
    await overwriteJson(target, h.job);
    const patch = { remoteTaskId: "task-one", expectedOutputs: outputs };
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, patch as never), AudioStorageError);
    await overwriteJson(target, { ...h.job, ...patch });
    await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
  }
  await overwriteJson(target, h.job);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { expectedOutputs: identities }), AudioStorageError);
  const allowed = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: "task-one", expectedOutputs: [{ key: "_opaque-track", role: "music" }],
  });
  assert.equal(allowed.expectedOutputs?.[0]?.key, "_opaque-track");
  await assert.rejects(h.save("music_alternative"), AudioStorageError);
  const asset = await h.save("music");
  assert.equal((await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [asset] })).outputAssets.length, 1);
});

test("historical role-only shapes upgrade without changing expected roles or maintaining duplicate state", async (t) => {
  const h = await audioStorageHarness(t, music);
  await updateAudioJob(h.storage, h.session.id, h.job.id, { expectedOutputRoles: ["music"] });
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: "task-one", expectedOutputs: identities,
  }), AudioStorageError);
  const upgraded = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    remoteTaskId: "task-one", expectedOutputs: identities.slice(0, 1),
  });
  assert.deepEqual(upgraded.expectedOutputs, identities.slice(0, 1));
  assert.equal(Object.hasOwn(upgraded, "expectedOutputRoles"), false);
  const separation = await audioStorageHarness(t);
  await assert.rejects(updateAudioJob(separation.storage, separation.session.id, separation.job.id, {
    remoteTaskId: "task-one", expectedOutputs: identities,
  }), AudioStorageError);
});
