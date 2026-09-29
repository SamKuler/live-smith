import assert from "node:assert/strict";
import test from "node:test";
import { generateAudio, downloadAudioOutput } from "./audio-generation.js";
import { resumeAudioJob } from "./audio-processing.js";
import { retrievalHarness, connection } from "./audio-retrieval-test-helpers.js";
import { createHostAbortController } from "../runtime/host.js";
import type { AudioGenerationAdapter } from "../audio-services/contracts.js";
import { stemIds, stemManifest } from "../model/audio-service-suno-stems-harness.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { listAudioAssets } from "../storage/audio-assets.js";
import { listAudioJobs, loadAudioJob } from "../storage/audio-jobs.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

const authorize = async <T>(_signal: AbortSignal, operation: () => Promise<T>): Promise<T> => operation();
async function fixture(t: Parameters<typeof retrievalHarness>[0]) {
  const h = await retrievalHarness(t);
  await saveIntegrationConnection(h.directory, "1", { ...connection, modelId: "different-generation-model" });
  const mode = { lose: false, abort: false, failedLast: false };
  const calls = { submissions: 0, inspections: 0, downloads: [] as string[] };
  const expectedOutputs = stemManifest(24);
  const adapter: AudioGenerationAdapter = {
    provider: "suno",
    async submit(_request, _signal, dispatch) {
      await dispatch?.(); calls.submissions++;
      if (mode.lose) throw new Error("Lost response");
      if (mode.abort) h.controller.abort();
      return { kind: "task", taskId: stemIds[0]!, expectedOutputs };
    },
    async inspect(_taskId, _signal, expected) {
      calls.inspections++; assert.deepEqual(expected, expectedOutputs);
      return { status: "completed", outputs: expectedOutputs.filter((_, index) => !mode.failedLast || index < 23)
        .map((entry) => ({ ...entry, url: `/api/download/clip/${entry.key}?format=mp3` })),
        ...(mode.failedLast ? { failedOutputKeys: [stemIds[23]!] } : {}) };
    },
    async downloadSelected(output, signal, guard) {
      return guard(signal, async () => { calls.downloads.push(output.key); return waveBytes(); });
    },
  };
  const context = { ...h.context, generationAdapter: adapter, withGenerationAuthorization: authorize,
    withDownloadAuthorization: authorize, wait: async () => undefined };
  const run = () => generateAudio(context, connection.id, { operation: "extract_music_stems", clipId: stemIds[0]! });
  return { ...h, context, mode, calls, run };
}

test("24 stem outputs persist with their fixed model and distinct local identities across both banks", async (t) => {
  const h = await fixture(t);
  let job = await h.run();
  assert.equal(job.status, "ready");
  assert.equal(job.modelId, "chirp-v3-5-b");
  assert.equal(job.expectedOutputs?.length, 24);
  assert.equal(job.remoteOutputs?.length, 24);
  assert.equal(job.outputAssets.length, 0);
  for (const id of stemIds) job = await downloadAudioOutput(h.context, job.id, id);
  assert.equal(job.status, "completed");
  assert.equal(job.outputAssets.length, 24);
  assert.equal(new Set(job.outputAssets.map((asset) => asset.id)).size, 24);
  assert.equal(new Set(job.outputAssets.map((asset) => asset.role)).size, 24);
  assert.equal(job.outputAssets.find((asset) => asset.role === "suno_stem_guitar_alternative")?.origin.kind, "generated");
  assert.equal((await listAudioAssets(h.directory, h.session.id, job.id)).length, 24);
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, job.id)).expectedOutputs, stemManifest(24));
  assert.equal(h.calls.submissions, 1);
});

test("a failed stem sibling remains a terminal partial outcome with downloadable successful banks", async (t) => {
  const h = await fixture(t);
  h.mode.failedLast = true;
  const ready = await h.run();
  assert.equal(ready.remoteOutputs?.length, 23);
  assert.deepEqual(ready.failedOutputKeys, [stemIds[23]]);
  const selected = await downloadAudioOutput(h.context, ready.id, stemIds[12]!);
  assert.equal(selected.status, "partial");
  assert.equal(selected.outputAssets[0]!.role, "suno_stem_vocals_alternative");
  const inspections = h.calls.inspections;
  await resumeAudioJob(h.context, selected.id);
  assert.equal(h.calls.inspections, inspections);
  assert.equal(h.calls.submissions, 1);
});

test("stem Stop retains all acknowledged identities and Resume never pays again", async (t) => {
  const h = await fixture(t);
  h.mode.abort = true;
  await assert.rejects(h.run(), /abort/i);
  const stopped = (await listAudioJobs(h.directory, h.session.id))[0]!;
  assert.equal(stopped.status, "interrupted");
  assert.deepEqual(stopped.expectedOutputs, stemManifest(24));
  h.mode.abort = false;
  const ready = await resumeAudioJob({ ...h.context, signal: createHostAbortController().signal }, stopped.id);
  assert.equal(ready.remoteOutputs?.length, 24);
  assert.equal(h.calls.submissions, 1);
});

test("a lost paid stem receipt has no resumable ticket and no automatic retry", async (t) => {
  const h = await fixture(t);
  h.mode.lose = true;
  const unknown = await h.run();
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.remoteTaskId, undefined);
  assert.equal((await resumeAudioJob(h.context, unknown.id)).status, "unknown");
  assert.equal(h.calls.submissions, 1);
});
