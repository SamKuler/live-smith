import assert from "node:assert/strict";
import test from "node:test";
import { generateAudio, downloadAudioOutput } from "../../../src/app/audio/audio-generation.js";
import { resumeAudioJob } from "../../../src/app/audio/audio-processing.js";
import { createAudioJob, loadAudioJob, listAudioJobs } from "../../../src/storage/audio-jobs.js";
import { saveAudioAsset } from "../../../src/storage/audio-assets.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { retrievalHarness, connection, manifest } from "./support/audio-retrieval-test-helpers.js";
import { fingerprint, waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import type { AudioGenerationAdapter } from "../../../src/audio-services/contracts.js";

test("generation persists the admitted source before remote dispatch and uses it after resume and later downloads", async (t) => {
  const h = await retrievalHarness(t);
  const sourceJob = await createAudioJob(h.directory, h.session.id, { provider: "sunoapi", serviceId: "source",
    operation: "generate_music", connectionFingerprint: fingerprint, stems: [] });
  const source = await saveAudioAsset(h.directory, h.session.id, { jobId: sourceJob.id, role: "music", label: "Music",
    bytes: waveBytes(), origin: { kind: "generated" }, signal: h.controller.signal });
  let dispatched = 0;
  const adapter: AudioGenerationAdapter = {
    ...h.adapter,
    prepare: async () => {},
    async submit(_request, _signal, dispatch) {
      await dispatch?.(); dispatched++;
      const created = (await listAudioJobs(h.directory, h.session.id)).find((job) => job.id !== sourceJob.id)!;
      assert.deepEqual(created.artifactSource, { kind: "audio", id: source.id });
      h.controller.abort();
      return { kind: "task", taskId: manifest[0]!.key, expectedOutputs: manifest };
    },
  };
  const admitted = { ...h.context, generationAdapter: adapter, artifactSource: { kind: "audio" as const, id: source.id },
    withGenerationAuthorization: async <T>(_signal: AbortSignal, run: () => Promise<T>) => run() };
  await assert.rejects(generateAudio(admitted, connection.id, { operation: "generate_music", prompt: "variation", instrumental: true }), /abort/i);
  const created = (await listAudioJobs(h.directory, h.session.id)).find((job) => job.id !== sourceJob.id)!;
  const later = { ...h.context, generationAdapter: adapter, signal: createHostAbortController().signal,
    artifactSource: { kind: "audio" as const, id: "another-current-selection" } };
  const ready = await resumeAudioJob(later, created.id);
  assert.equal(ready.status, "ready");
  const first = await downloadAudioOutput(later, ready.id, manifest[0]!.key);
  const complete = await downloadAudioOutput(later, ready.id, manifest[1]!.key);
  assert.equal(dispatched, 1);
  assert.deepEqual(first.outputAssets[0]!.version, { groupId: source.id, number: 2, derivedFromId: source.id });
  assert.deepEqual(complete.outputAssets[1]!.version, { groupId: source.id, number: 3, derivedFromId: source.id });
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, ready.id)).artifactSource, { kind: "audio", id: source.id });
  for (const asset of complete.outputAssets) assert.equal(asset.origin.sourceAssetId, source.id);
});
