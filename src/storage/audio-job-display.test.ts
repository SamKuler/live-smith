import assert from "node:assert/strict";
import test from "node:test";
import { audioJobView } from "../audio-services/contracts.js";
import { uiMessage } from "../ui/i18n/ui-message.js";
import { AudioStorageError, createAudioJob, loadAudioJob, updateAudioJob } from "./audio-jobs.js";
import { audioStorageHarness, fingerprint, generationJobCases } from "./audio-storage-test-helpers.js";

test("job display titles roundtrip without persisting prompt or changing historical jobs", async (t) => {
  const h = await audioStorageHarness(t);
  const title = "Afterlight · 中文 <img src=x>";
  const input = { ...generationJobCases[0]!.input, title };
  const saved = await createAudioJob(h.storage, h.session.id, input);
  assert.equal((await loadAudioJob(h.storage, h.session.id, saved.id)).title, title);
  assert.equal(audioJobView(saved).title, title);
  assert.equal(Object.hasOwn(await loadAudioJob(h.storage, h.session.id, h.job.id), "title"), false);
});

test("job titles reject empty, oversized and control-bearing input before creating records", async (t) => {
  const h = await audioStorageHarness(t);
  for (const title of ["", " ", "a".repeat(201), "bad\nname", "bad\u0000name"]) {
    await assert.rejects(createAudioJob(h.storage, h.session.id, { ...generationJobCases[0]!.input, title }), AudioStorageError);
  }
});

test("authored audio notices retain message identity while raw diagnostics stay raw", async (t) => {
  const h = await audioStorageHarness(t);
  const notice = uiMessage("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.");
  await updateAudioJob(h.storage, h.session.id, h.job.id, { message: notice });
  const saved = await loadAudioJob(h.storage, h.session.id, h.job.id);
  assert.deepEqual(saved.message, notice);
  assert.deepEqual(audioJobView(saved).message, notice);
  await updateAudioJob(h.storage, h.session.id, h.job.id, { message: "provider diagnostic <b>Music</b>" });
  assert.equal(audioJobView(await loadAudioJob(h.storage, h.session.id, h.job.id)).message, "provider diagnostic <b>Music</b>");
});

test("malformed or oversized audio descriptors are rejected before metadata updates", async (t) => {
  const h = await audioStorageHarness(t);
  for (const message of [{ source: "Preparing music generation" }, { source: "", values: {} },
    { source: "Preparing music generation", values: {}, token: "not-allowed" },
    { source: "Preparing music generation", values: { invalid: { url: "not-allowed" } } },
    { source: "Preparing music generation", values: { details: "a".repeat(4096) } }]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { message: message as never }), AudioStorageError);
  }
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, {
    message: uiMessage("Preparing music generation", { count: Infinity }),
  }), TypeError);
});

test("public remote outcome distinguishes completed generation from selected local collection", async (t) => {
  const h = await audioStorageHarness(t, { provider: "suno", serviceId: "suno-personal", operation: "generate_music", connectionFingerprint: fingerprint, stems: [] });
  const expectedOutputs = [{ key: "11111111-1111-4111-8111-111111111111", role: "music" as const },
    { key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "music_alternative" as const }];
  const asset = await h.save("music");
  const saved = await updateAudioJob(h.storage, h.session.id, h.job.id, { status: "partial", remoteTaskId: expectedOutputs[0]!.key,
    expectedOutputs, remoteOutputs: expectedOutputs, outputAssets: [asset] });
  assert.equal(audioJobView(saved).remoteOutcome, "completed");
  const failed = await updateAudioJob(h.storage, h.session.id, h.job.id, { remoteOutputs: [expectedOutputs[0]!], failedOutputKeys: [expectedOutputs[1]!.key] });
  assert.equal(audioJobView(failed).remoteOutcome, "partial");
  assert.equal(Object.hasOwn(audioJobView(saved), "connectionFingerprint"), false);
});
