import assert from "node:assert/strict";
import test from "node:test";

import { ProfileValidationError } from "../model/profile.js";
import {
  migrateAudioServiceConnection,
  normalizeIntegrationConnection,
} from "../plugins/integration-connections.js";
import { AudioStorageError, createAudioJob, loadAudioJob, updateAudioJob } from "./audio-jobs.js";
import { audioStorageHarness, fingerprint } from "./audio-storage-test-helpers.js";

const music = {
  provider: "elevenlabs" as const, serviceId: "music-fixture", operation: "generate_music" as const,
  connectionFingerprint: fingerprint, stems: [],
};
const connection = {
  id: music.serviceId, name: "Music fixture", provider: music.provider, enabled: true, apiKey: "fixture-key-only",
};

test("settings model IDs round-trip through jobs without task-ID restrictions or normalization", async (t) => {
  const h = await audioStorageHarness(t);
  const printable = Array.from({ length: 94 }, (_, index) => String.fromCharCode(0x21 + index)).join("");
  for (const modelId of ["!", "vendor/music-v2", "music.v2:beta", printable, "m".repeat(128)]) {
    const saved = normalizeIntegrationConnection({
      ...migrateAudioServiceConnection(connection),
      configuration: { modelId },
    });
    const job = await createAudioJob(h.storage, h.session.id, {
      ...music,
      modelId: saved.configuration.modelId!,
    });
    assert.equal((await loadAudioJob(h.storage, h.session.id, job.id)).modelId, modelId);
    await updateAudioJob(h.storage, h.session.id, job.id, { status: "running", remoteTaskId: "task_1" });
    assert.equal((await loadAudioJob(h.storage, h.session.id, job.id)).modelId, modelId);
    await assert.rejects(updateAudioJob(h.storage, h.session.id, job.id, { remoteTaskId: "vendor/task" }), AudioStorageError);
  }
});

test("settings and job model IDs reject the same empty, oversized, whitespace, control and non-ASCII values", async (t) => {
  const h = await audioStorageHarness(t);
  for (const modelId of [undefined, null, 42, {}, "", "m".repeat(129), "m".repeat(256),
    " model", "model ", "two words", "model\n", "model\r", "model\t", "model\0", "model\x1f", "model\x7f", "模型", "m\u0080"]) {
    assert.throws(() => normalizeIntegrationConnection({
      ...migrateAudioServiceConnection(connection),
      configuration: { modelId },
    }), ProfileValidationError);
    await assert.rejects(createAudioJob(h.storage, h.session.id, { ...music, modelId } as never), AudioStorageError);
  }
  const saved = normalizeIntegrationConnection(migrateAudioServiceConnection(connection));
  assert.equal(Object.hasOwn(saved.configuration, "modelId"), false);
  const job = await createAudioJob(h.storage, h.session.id, music);
  assert.equal(Object.hasOwn(await loadAudioJob(h.storage, h.session.id, job.id), "modelId"), false);
});

test("Mureka, native Suno and SunoAPI keep their provider-specific output contracts", async (t) => {
  const h = await audioStorageHarness(t);
  const native = await createAudioJob(h.storage, h.session.id, { ...music, provider: "suno" });
  assert.equal((await loadAudioJob(h.storage, h.session.id, native.id)).provider, "suno");
  await assert.rejects(createAudioJob(h.storage, h.session.id, { ...music, provider: "suno", operation: "generate_sound_effect" }), AudioStorageError);
  const job = await createAudioJob(h.storage, h.session.id, { ...music, provider: "sunoapi", modelId: "V4_5ALL" });
  const updated = await updateAudioJob(h.storage, h.session.id, job.id, { expectedOutputRoles: ["music", "music_alternative"] });
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, job.id)).expectedOutputRoles, updated.expectedOutputRoles);
  const official = await createAudioJob(h.storage, h.session.id, { ...music, provider: "suno-platform" });
  await updateAudioJob(h.storage, h.session.id, official.id, { expectedOutputRoles: ["music"] });
  await assert.rejects(updateAudioJob(h.storage, h.session.id, official.id,
    { expectedOutputRoles: ["music", "music_alternative"] }), AudioStorageError);
  const mureka = await createAudioJob(h.storage, h.session.id, { ...music, provider: "mureka", modelId: "mureka-9.5" });
  await updateAudioJob(h.storage, h.session.id, mureka.id, {
    remoteTaskId: "song:task-1", expectedOutputs: [{ key: "song-a", role: "music" }],
  });
  assert.equal((await loadAudioJob(h.storage, h.session.id, mureka.id)).provider, "mureka");
  await assert.rejects(updateAudioJob(h.storage, h.session.id, mureka.id, { expectedOutputs: [
    { key: "song-a", role: "music" }, { key: "song-b", role: "music_alternative" },
  ] }), AudioStorageError);
});
