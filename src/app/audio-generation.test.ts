import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { AudioSubmissionNotStartedError, MAX_AUDIO_ASSET_BYTES, type AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { listAudioJobs, updateAudioJob } from "../storage/audio-jobs.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { generateAudio } from "./audio-generation.js";
import { audioJobViews, audioProcessingAvailable, resumeAudioJob } from "./audio-processing.js";

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-generation-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Generation", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  for (const [index, id] of ["music-a", "music-b"].entries()) {
    await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: String(index),
      connection: { id, name: id, provider: "elevenlabs", enabled: true, apiKey: `fixture-${id}` } } });
  }
  const controller = new AbortController();
  let submissions = 0;
  const adapter: AudioGenerationAdapter = {
    provider: "elevenlabs",
    submit: async (request) => {
      submissions++;
      return { kind: "audio", outputs: [{ role: request.operation === "generate_music" ? "music" : "sound_effect", bytes: waveBytes() }] };
    },
  };
  const context = { storageDirectory: directory, sessionId: session.id, signal: controller.signal, generationAdapter: adapter };
  return { directory, session, controller, adapter, context, submissions: () => submissions };
}

test("named music and sound-effect connections produce immutable usable results without credential leakage", async (t) => {
  const h = await harness(t);
  const music = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Sparse piano", durationSeconds: 12, instrumental: true });
  const effect = await generateAudio(h.context, "music-b", { operation: "generate_sound_effect", prompt: "Rain", durationSeconds: 3, loop: true });
  assert.equal(music.status, "completed"); assert.equal(effect.status, "completed");
  assert.equal(music.serviceId, "music-a"); assert.equal(effect.serviceId, "music-b");
  assert.notEqual(music.connectionFingerprint, effect.connectionFingerprint);
  assert.deepEqual(music.stems, []);
  assert.equal(music.outputAssets[0]?.origin.kind, "generated");
  assert.equal(effect.outputAssets[0]?.role, "sound_effect");
  assert.deepEqual((await readAudioAsset(h.directory, h.session.id, music.outputAssets[0]!.id)).bytes, waveBytes());
  const view = JSON.stringify(await audioJobViews(h.directory, h.session.id));
  assert.doesNotMatch(view, /fixture-music|connectionFingerprint|\/private\/tmp/);
  assert.equal(h.submissions(), 2);
  assert.equal(await audioProcessingAvailable(h.directory), false, "a generator alone cannot consume an audio attachment");
});

test("unknown inline generation is never repeated by Resume or moved to another account", async (t) => {
  const h = await harness(t);
  let calls = 0;
  h.adapter.submit = async () => { calls++; throw new Error("credential=fixture-music-a; response lost"); };
  const unknown = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  assert.equal(unknown.status, "unknown");
  assert.doesNotMatch(unknown.message ?? "", /fixture-music-a/);
  const resumed = await resumeAudioJob(h.context, unknown.id);
  assert.equal(resumed.status, "unknown");
  assert.equal(calls, 1);
  await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: "2",
    connection: { id: "music-a", name: "music-a", provider: "elevenlabs", enabled: true, apiKey: "replacement-key" } } });
  await assert.rejects(resumeAudioJob(h.context, unknown.id), /different service connection/);
  await saveGlobalSettings(h.directory, { audioServices: { action: "remove", expectedRevision: "3", serviceId: "music-a" } });
  await assert.rejects(resumeAudioJob(h.context, unknown.id), /unavailable/);
  assert.equal(calls, 1);
  assert.equal((await loadAgentSettings(h.directory)).audioServices?.connections[0]?.id, "music-b");
});

test("a known pre-dispatch rejection is failed rather than an unknown paid outcome", async (t) => {
  const h = await harness(t);
  h.adapter.submit = async () => { throw new AudioSubmissionNotStartedError("Verification expired before dispatch."); };
  const job = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  assert.equal(job.status, "failed");
  assert.equal(job.remoteTaskId, undefined);
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]?.resumable, false);
  assert.equal((await resumeAudioJob(h.context, job.id)).status, "failed");
  assert.equal(h.submissions(), 0);
});

test("complete inline audio received as Stop arrives is saved without continuing generation", async (t) => {
  const h = await harness(t);
  h.adapter.submit = async () => {
    h.controller.abort(new Error("stopped"));
    return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
  };
  const result = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  assert.equal(result.status, "completed");
  assert.equal(result.outputAssets.length, 1);
  assert.equal((await listAudioJobs(h.directory, h.session.id))[0]?.status, "completed");
});

test("a locally committed inline generation can be recovered without another paid request", async (t) => {
  const h = await harness(t);
  const first = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  await updateAudioJob(h.directory, h.session.id, first.id, { status: "collecting", outputAssets: [] });
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]?.resumable, true);
  const recovered = await resumeAudioJob(h.context, first.id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outputAssets[0]?.id, first.outputAssets[0]?.id);
  assert.equal(h.submissions(), 1);
});

test("audio services reject incompatible operations and disabled or unadvertised connections before submission", async (t) => {
  const h = await harness(t);
  await assert.rejects(generateAudio(h.context, "missing", { operation: "generate_music", prompt: "Piano", instrumental: true }), /unavailable/);
  await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: "2",
    connection: { id: "music-a", name: "music-a", provider: "elevenlabs", enabled: false } } });
  await assert.rejects(generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true }), /unavailable/);
  assert.equal(h.submissions(), 0);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 0);
});

test("music duration is rejected against the selected provider before creating a paid job", async (t) => {
  const h = await harness(t);
  for (const durationSeconds of [2.99, 600.01]) {
    await assert.rejects(generateAudio(h.context, "music-a", {
      operation: "generate_music", prompt: "Piano", durationSeconds, instrumental: true,
    }), /supported range/);
  }
  assert.equal(h.submissions(), 0);
  assert.equal((await listAudioJobs(h.directory, h.session.id)).length, 0);
});

test("complete paid audio survives one failed job-record commit without regenerating", async (t) => {
  const h = await harness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const original = prototype.writeFile;
  await probe.close();
  let failed = false;
  h.adapter.submit = async () => {
    t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle["writeFile"]>) {
      const [data] = args;
      if (!failed && typeof data === "string" && data.includes('"outputAssets"')) {
        failed = true;
        throw new Error("one-time job write failed");
      }
      return original.apply(this, args);
    });
    return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
  };
  const job = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  assert.equal(failed, true);
  assert.equal(job.status, "completed");
  assert.equal(job.outputAssets.length, 1);
});

test("complete paid audio reconciles its receipted blob after a one-time directory-sync failure", async (t) => {
  const h = await harness(t);
  const probe = await fs.open(h.directory);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const original = prototype.sync;
  await probe.close();
  let failed = false;
  h.adapter.submit = async () => {
    t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
      const directory = `${h.directory}/live-smith-audio/${h.session.id}`;
      const names = await fs.readdir(directory);
      if (!failed && (await this.stat()).isDirectory() && names.some((name) => name.endsWith(".audio"))) {
        assert.ok(names.some((name) => name.endsWith(".asset.json")), "the receipt must precede its committed blob");
        failed = true;
        throw new Error("one-time blob directory sync failed");
      }
      return original.call(this);
    });
    return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
  };
  const job = await generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true });
  assert.equal(failed, true);
  assert.equal(job.status, "completed");
  assert.equal(job.outputAssets.length, 1);
  assert.deepEqual((await readAudioAsset(h.directory, h.session.id, job.outputAssets[0]!.id)).bytes, waveBytes());
});

test("known exhausted local audio capacity blocks paid generation before submission", async (t) => {
  const h = await harness(t);
  const directory = `${h.directory}/live-smith-audio/${h.session.id}`;
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 8; index++) {
    const file = await fs.open(`${directory}/quota-${index}.audio`, "wx");
    try { await file.truncate(MAX_AUDIO_ASSET_BYTES); } finally { await file.close(); }
  }
  await assert.rejects(generateAudio(h.context, "music-a", { operation: "generate_music", prompt: "Piano", instrumental: true }), /capacity|storage limit/i);
  assert.equal(h.submissions(), 0);
});
