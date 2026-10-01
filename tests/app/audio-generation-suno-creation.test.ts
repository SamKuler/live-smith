import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import test from "node:test";
import type { AudioGenerationAdapter } from "../../src/audio-services/contracts.js";
import { saveIntegrationConnection } from "./support/integration-connection-test-helpers.js";
import { createSession } from "../../src/storage/sessions.js";
import { SunoSessions } from "../../src/storage/suno-sessions.js";
import { loadAudioJob } from "../../src/storage/audio-jobs.js";
import { waveBytes } from "../storage/support/audio-storage-test-helpers.js";
import { generateAudio, downloadAudioOutput, resumeAudioGeneration } from "../../src/app/audio-generation.js";

test("Suno sound samples preserve both roles through explicit download, storage and local recovery", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-sound-samples-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Sounds", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveIntegrationConnection(directory, "0", { id: "website", name: "Suno", provider: "suno", enabled: true, apiKey: "" });
  const token = ["{}", JSON.stringify({ fixture: true }), "signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");
  await new SunoSessions(directory).save("website", { accountId: "user_fixture", clientToken: token });
  const outputs = [
    { key: "11111111-1111-4111-8111-111111111111", role: "sound_effect" as const },
    { key: "22222222-2222-4222-8222-222222222222", role: "sound_effect_alternative" as const },
  ];
  let submissions = 0;
  const downloaded: string[] = [];
  const adapter: AudioGenerationAdapter = {
    provider: "suno",
    submit: async (request) => {
      assert.equal(request.operation, "generate_sound_sample");
      submissions++;
      return { kind: "task", taskId: outputs[0]!.key, expectedOutputs: outputs };
    },
    inspect: async (_taskId, _signal, manifest) => {
      assert.deepEqual(manifest, outputs);
      return { status: "completed", outputs: outputs.map((output) => ({ ...output, url: `fixture:${output.key}` })) };
    },
    downloadSelected: async (output) => { downloaded.push(output.key); return waveBytes(); },
  };
  const context = { storageDirectory: directory, sessionId: session.id, signal: new AbortController().signal,
    generationAdapter: adapter, wait: async () => {} };
  const job = await generateAudio(context, "website", { operation: "generate_sound_sample", prompt: "A wooden click", loop: false });
  assert.equal(job.status, "ready");
  assert.deepEqual(job.remoteOutputs, outputs);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(job.outputAssets, []);
  const partial = await downloadAudioOutput(context, job.id, outputs[1]!.key);
  assert.equal(partial.status, "partial");
  assert.equal(partial.outputAssets[0]?.role, "sound_effect_alternative");
  assert.equal(partial.outputAssets[0]?.label, "Alternative sound effect");
  const complete = await downloadAudioOutput(context, job.id, outputs[0]!.key);
  assert.equal(complete.status, "completed");
  const saved = await loadAudioJob(directory, session.id, job.id);
  assert.deepEqual(saved.outputAssets.map((asset) => asset.role).sort(), outputs.map((output) => output.role).sort());
  assert.equal((await resumeAudioGeneration(context, saved)).status, "completed");
  assert.equal(submissions, 1);
  assert.deepEqual(downloaded, [outputs[1]!.key, outputs[0]!.key]);
});
