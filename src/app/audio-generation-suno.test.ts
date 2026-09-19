import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { audioJobView, type AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { loadAgentSettings, saveGlobalSettings } from "../storage/settings.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { listAudioJobs, loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { audioConnectionFingerprint, captureAudioServiceConnections, resolveAudioService } from "./audio-service-connections.js";
import { generateAudio } from "./audio-generation.js";
import { downloadAudioOutput, resumeAudioJob } from "./audio-processing.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { elevenLabsPlugin } from "../plugins/builtins/elevenlabs.js";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const manifest = [{ key: ids[0]!, role: "music" as const }, { key: ids[1]!, role: "music_alternative" as const }];
const token = (value: string) => ["{}", JSON.stringify({ value }), "signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");
const connection = { id: "website", name: "Suno personal", provider: "suno" as const, enabled: true, apiKey: "" };
const request = { operation: "generate_music" as const, prompt: "Original piano phrase", instrumental: true };

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-native-suno-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Native Suno", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: "0", connection } });
  const sessions = new SunoSessions(directory);
  await sessions.save(connection.id, { accountId: "user_personal", clientToken: token("first") });
  const controller = new AbortController();
  const mode = { stopAfterReceipt: false, failPrepare: false, failSecond: false, failedSibling: false,
    failedTask: false, changeId: false };
  const calls = { submit: 0, inspect: 0, downloads: [] as string[] };
  const adapter: AudioGenerationAdapter = {
    provider: "suno",
    prepare: async () => { if (mode.failPrepare) throw new Error("Suno requires manual verification."); },
    submit: async () => {
      calls.submit++;
      if (mode.stopAfterReceipt) controller.abort();
      return { kind: "task", taskId: ids[0]!, expectedOutputs: manifest };
    },
    inspect: async (taskId, _signal, expectedOutputs) => {
      calls.inspect++;
      assert.equal(taskId, ids[0]);
      assert.deepEqual(expectedOutputs, manifest);
      const saved = (await listAudioJobs(directory, session.id))[0]!;
      assert.deepEqual(saved.expectedOutputs, manifest, "receipt is durable before polling");
      if (mode.failedTask) return { status: "failed", message: "The remote task failed." };
      return { status: "completed", outputs: manifest.filter((_, index) => !mode.failedSibling || index === 0).map((entry, index) => ({
        ...entry, key: mode.changeId && index === 1 ? "33333333-3333-4333-8333-333333333333" : entry.key,
        url: `https://cdn1.suno.ai/${entry.key}.mp3`,
      })), ...(mode.failedSibling ? { failedOutputKeys: [ids[1]!] } : {}) };
    },
    download: async (output) => {
      calls.downloads.push(output.key);
      if (mode.failSecond && output.role === "music_alternative") throw new Error("Download unavailable.");
      return waveBytes();
    },
    downloadSelected: async (output, signal) => adapter.download!({ ...output, url: `fixture:${output.key}` }, signal),
  };
  const context = { storageDirectory: directory, sessionId: session.id, signal: controller.signal, generationAdapter: adapter, wait: async () => {} };
  return { directory, session, sessions, controller, mode, calls, context };
}

test("Cookie-based service admission follows verified same-account rotation and rejects missing credentials", async (t) => {
  const h = await harness(t);
  const admitted = await captureAudioServiceConnections(h.directory);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.apiKey, "");
  assert.equal(admitted[0]!.sunoSession?.accountId, "user_personal");
  assert.ok(Object.isFrozen(admitted[0]!.sunoSession));
  const fingerprint = audioConnectionFingerprint(admitted[0]!);
  const renewed = token("renewed");
  await h.sessions.save(connection.id, { accountId: "user_personal", clientToken: renewed });
  const resolved = await resolveAudioService(h.directory, connection.id, "generate_music", admitted);
  assert.equal(resolved.sunoSession?.clientToken, `__client=${renewed}`);
  assert.equal(audioConnectionFingerprint((await captureAudioServiceConnections(h.directory))[0]!), fingerprint);
  await h.sessions.clear(connection.id);
  assert.deepEqual(await captureAudioServiceConnections(h.directory), []);
  await assert.rejects(resolveAudioService(h.directory, connection.id, "generate_music"), /unavailable/);
});

test("provider-confirmed task failure is terminal and does not offer a pointless Resume", async (t) => {
  const h = await harness(t);
  h.mode.failedTask = true;
  const job = await generateAudio(h.context, connection.id, request);
  assert.equal(job.status, "failed");
  assert.equal(job.remoteTaskTerminal, "failed");
  assert.equal(audioJobView(job).resumable, false);
  const inspections = h.calls.inspect;
  const unchanged = await resumeAudioJob(h.context, job.id);
  assert.equal(unchanged.remoteTaskTerminal, "failed");
  assert.equal(h.calls.inspect, inspections);
});

test("one corrupt Suno credential cannot block healthy connections or ordinary chat admission", async (t) => {
  const h = await harness(t);
  await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: "1", connection: {
    id: "healthy", name: "Healthy music", provider: "elevenlabs", enabled: true, apiKey: "fixture-healthy-key",
  } } });
  await fs.writeFile(`${h.directory}/suno-session-${connection.id}.json`, "{}", { mode: 0o600 });
  const admitted = await captureAudioServiceConnections(h.directory);
  assert.deepEqual(admitted.map((entry) => entry.id), ["healthy"]);
  await assert.rejects(resolveAudioService(h.directory, connection.id, "generate_music"), /Private Suno session storage/);
  const tools = await createRequestAudioTools({ context: {} as never, storageDirectory: h.directory,
    sessionId: h.session.id, requestId: "request", attachmentRefs: [], target: {}, signal: h.controller.signal,
    onProgress() {}, onAssets() {} });
  const music = tools.tools.find((tool) => tool.function.name ===
    builtInAudioToolName(elevenLabsPlugin, "generate_music"))!;
  assert.match(JSON.stringify(music.function.parameters), /healthy/);
  assert.doesNotMatch(JSON.stringify(music.function.parameters), /website/);
});

test("preflight failure creates a known failed job and never enters paid submission", async (t) => {
  const h = await harness(t);
  h.mode.failPrepare = true;
  const job = await generateAudio(h.context, connection.id, request);
  assert.equal(job.status, "failed");
  assert.equal(job.remoteTaskId, undefined);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.calls.inspect, 0);
});

test("every confirmed Suno clip survives Stop and resumes without another submission", async (t) => {
  const h = await harness(t);
  h.mode.stopAfterReceipt = true;
  await assert.rejects(generateAudio(h.context, connection.id, request));
  const saved = (await listAudioJobs(h.directory, h.session.id))[0]!;
  assert.equal(saved.status, "interrupted");
  assert.deepEqual(saved.expectedOutputs, manifest);
  assert.equal(h.calls.inspect, 0);
  const result = await resumeAudioJob({ ...h.context, signal: new AbortController().signal }, saved.id);
  assert.equal(result.status, "ready");
  assert.equal(h.calls.submit, 1);
  assert.deepEqual(result.remoteOutputs, manifest);
  assert.deepEqual(result.outputAssets, []);
  assert.deepEqual(h.calls.downloads, []);
});

test("successful sibling is retained when another clip fails remotely", async (t) => {
  const h = await harness(t);
  h.mode.failedSibling = true;
  const job = await generateAudio(h.context, connection.id, request);
  assert.equal(job.status, "ready");
  assert.deepEqual(job.expectedOutputs, manifest);
  assert.deepEqual(job.remoteOutputs, [manifest[0]]);
  assert.deepEqual(job.failedOutputKeys, [ids[1]]);
  assert.deepEqual(job.outputAssets, []);
  assert.equal(audioJobView(job).resumable, false);
  const inspections = h.calls.inspect;
  h.mode.failedSibling = false;
  const result = await resumeAudioJob(h.context, job.id);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.remoteOutputs, [manifest[0]]);
  assert.deepEqual(result.failedOutputKeys, [ids[1]]);
  assert.equal(h.calls.inspect, inspections);
  assert.deepEqual(h.calls.downloads, []);
  assert.equal(h.calls.submit, 1);
});

test("a fresh Cookie for the same account can recover; another account cannot", async (t) => {
  const h = await harness(t);
  h.mode.failSecond = true;
  const job = await generateAudio(h.context, connection.id, request);
  assert.equal(job.status, "ready");
  const inspections = h.calls.inspect;
  await h.sessions.save(connection.id, { accountId: "user_other", clientToken: token("other") });
  await assert.rejects(downloadAudioOutput(h.context, job.id, ids[1]!), /different service connection/);
  assert.equal(h.calls.inspect, inspections);
  await h.sessions.save(connection.id, { accountId: "user_personal", clientToken: token("renewed") });
  h.mode.failSecond = false;
  assert.equal((await downloadAudioOutput(h.context, job.id, ids[1]!)).status, "partial");
  assert.deepEqual(h.calls.downloads, [ids[1]]);
  assert.equal(h.calls.submit, 1);
});

test("output manifests cannot change during collection or through storage updates", async (t) => {
  const h = await harness(t);
  h.mode.changeId = true;
  const job = await generateAudio(h.context, connection.id, request);
  assert.equal(job.status, "interrupted");
  assert.equal(h.calls.downloads.length, 0);
  assert.deepEqual(job.expectedOutputs, manifest);
  await assert.rejects(updateAudioJob(h.directory, h.session.id, job.id, { expectedOutputs: [manifest[0]!] }), /identities changed/);
  assert.deepEqual((await loadAudioJob(h.directory, h.session.id, job.id)).expectedOutputs, manifest);
});

test("reconfiguration during preflight prevents submission using a stale admission", async (t) => {
  const h = await harness(t);
  const admittedConnections = await captureAudioServiceConnections(h.directory);
  h.context.generationAdapter.prepare = async () => {
    const settings = await loadAgentSettings(h.directory);
    await saveGlobalSettings(h.directory, { audioServices: { action: "upsert", expectedRevision: settings.audioServices!.revision,
      connection: { ...connection, enabled: false } } });
  };
  const job = await generateAudio({ ...h.context, admittedConnections }, connection.id, request);
  assert.equal(job.status, "failed");
  assert.equal(h.calls.submit, 0);
});
