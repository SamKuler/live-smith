import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { listAudioJobs, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { readExpectedAudioAsset } from "../../src/storage/audio-assets.js";
import { waveBytes } from "../storage/support/audio-storage-test-helpers.js";
import { generateAudio } from "../../src/app/audio-generation.js";
import { audioJobViews, resumeAudioJob } from "../../src/app/audio-processing.js";
import { audioRecoveryHarness } from "./support/audio-recovery-test-helpers.js";

for (const provider of ["lalal", "elevenlabs", "sunoapi"] as const) {
  for (const connectionChange of ["disabled", "removed", "replaced"] as const) {
    test(`${provider} finishes verified local recovery with its connection ${connectionChange}`, async (t) => {
      const h = await audioRecoveryHarness(t, provider);
      const first = await h.run();
      assert.equal(first.status, "completed");
      await updateAudioJob(h.storage, h.session.id, first.id, { status: "collecting", outputAssets: [] });
      await h.change(connectionChange === "removed" ? "remove" : connectionChange === "disabled" ? { enabled: false } : { apiKey: "synthetic-replacement" });
      const before = h.calls.length;
      const recovered = await resumeAudioJob(h.context, first.id);
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.outputAssets.length, first.outputAssets.length);
      for (const asset of recovered.outputAssets) assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset), waveBytes());
      assert.equal(h.calls.length, before, "entirely local recovery must not request any provider");
    });
  }
}

for (const provider of ["lalal", "sunoapi"] as const) {
  test(`${provider} collects a later valid output after invalid audio and resumes only the missing output`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    h.mode.invalidFirst = true;
    const first = await h.run();
    const later = provider === "lalal" ? "residual" : "music_alternative";
    assert.equal(first.status, "partial");
    assert.deepEqual(first.outputAssets.map((asset) => asset.role), [later]);
    assert.equal((await audioJobViews(h.storage, h.session.id))[0]!.resumable, true);
    h.mode.invalidFirst = false;
    const completed = await resumeAudioJob(h.context, first.id);
    assert.equal(completed.status, "completed");
    assert.equal(h.calls.filter((call) => call === `download:${later}`).length, 1);
    assert.equal(h.calls.filter((call) => call === "submit").length, 1);
  });
}

test("sound-effect jobs do not inherit the unrelated saved music model override", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  await h.change({ modelId: "music/v2" });
  const job = await generateAudio(h.context, h.connection.id, {
    operation: "generate_sound_effect", prompt: "Rain", durationSeconds: 1, loop: false,
  });
  assert.equal(job.status, "completed");
  assert.equal(Object.hasOwn(job, "modelId"), false);
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
});

test("a directly returned blob survives persistent bookkeeping failure and resumes locally after connection removal", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const probe = await fs.open(h.storage);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const sync = prototype.sync;
  await probe.close();
  const submit = h.generationAdapter.submit;
  let restore = () => {};
  h.generationAdapter.submit = async (...args) => {
    const result = await submit(...args);
    const fault = t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
      if ((await this.stat()).isDirectory() && (await fs.readdir(`${h.storage}/live-smith-audio/${h.session.id}`))
        .some((name) => name.endsWith(".audio"))) throw new Error("bookkeeping unavailable after blob commit");
      return sync.call(this);
    });
    restore = () => fault.mock.restore();
    return result;
  };
  try { await assert.rejects(h.run()); } finally { restore(); }
  const job = (await listAudioJobs(h.storage, h.session.id))[0]!;
  assert.notEqual(job.status, "completed");
  await h.change("remove");
  assert.equal((await audioJobViews(h.storage, h.session.id))[0]!.resumable, true);
  const recovered = await resumeAudioJob(h.context, job.id);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, recovered.outputAssets[0]!), waveBytes());
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
});
