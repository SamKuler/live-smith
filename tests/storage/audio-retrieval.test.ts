import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { AudioStorageError, createAudioJob, loadAudioJob, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { audioStorageHarness, fingerprint } from "./support/audio-storage-test-helpers.js";

const first = "aaaaaaaa-1111-4111-8111-111111111111";
const second = "bbbbbbbb-2222-4222-8222-222222222222";
const configuration = { provider: "suno" as const, serviceId: "website", operation: "retrieve_music" as const,
  connectionFingerprint: fingerprint, stems: [] };
const receipt = { remoteTaskId: first, expectedOutputs: [
  { key: first, role: "music" as const }, { key: second, role: "music_alternative" as const },
] };

test("first durable retrieval record contains its immutable ID and role receipt", async (t) => {
  const h = await audioStorageHarness(t);
  const initial = { remoteTaskId: receipt.remoteTaskId, expectedOutputs: receipt.expectedOutputs.map((entry) => ({ ...entry })) };
  const job = await createAudioJob(h.storage, h.session.id, configuration, initial);
  initial.expectedOutputs[0]!.key = second;
  const saved = JSON.parse(await fs.readFile(`${h.directory}/${job.id}.job.json`, "utf8"));
  assert.deepEqual(saved.expectedOutputs, receipt.expectedOutputs);
  assert.equal(saved.remoteTaskId, first);
  assert.equal(saved.operation, "retrieve_music");
  assert.equal(saved.status, "running");
  assert.equal(saved.expectedOutputRoles, undefined);
  for (const patch of [{ remoteTaskId: second }, { expectedOutputs: receipt.expectedOutputs.slice(0, 1) },
    { expectedOutputs: [...receipt.expectedOutputs].reverse() }, { expectedOutputs: undefined },
    { expectedOutputRoles: ["music", "music_alternative"] }]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, job.id, patch as never), AudioStorageError);
  }
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, job.id)).expectedOutputs, receipt.expectedOutputs);
});

test("initial receipts are required for retrieval and cannot spoof generation submission", async (t) => {
  const h = await audioStorageHarness(t);
  const before = await fs.readdir(h.directory);
  await assert.rejects(createAudioJob(h.storage, h.session.id, configuration), AudioStorageError);
  for (const input of [undefined, {}, { ...receipt, remoteTaskId: second },
    { ...receipt, expectedOutputs: [] }, { ...receipt, expectedOutputs: [...receipt.expectedOutputs].reverse() },
    { ...receipt, expectedOutputs: [{ key: first, role: "sound_effect" }] },
    { ...receipt, expectedOutputs: [{ key: "opaque-id", role: "music" }] },
    { ...receipt, expectedOutputs: [{ key: first, role: "music" }, { key: first, role: "music_alternative" }] },
    { ...receipt, status: "completed" }, { ...receipt, expectedOutputRoles: ["music"] }]) {
    await assert.rejects(createAudioJob(h.storage, h.session.id, configuration, input as never), AudioStorageError);
  }
  await assert.rejects(createAudioJob(h.storage, h.session.id, { ...configuration, operation: "generate_music" }, receipt), AudioStorageError);
  assert.deepEqual(await fs.readdir(h.directory), before);
});
