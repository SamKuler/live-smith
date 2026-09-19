import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { LEGACY_AUDIO_SERVICE_ID, MAX_AUDIO_SESSION_JOBS, type AudioJob } from "../audio-services/contracts.js";
import { saveAudioAsset } from "./audio-assets.js";
import {
  AudioStorageError, MAX_AUDIO_JOB_METADATA_BYTES,
  createAudioJob, listAudioJobs, loadAudioJob, updateAudioJob,
} from "./audio-jobs.js";
import {
  audioStorageHarness, generationJobCases, overwriteJson, separationJobInput, sessionInput, waveBytes,
} from "./audio-storage-test-helpers.js";
import { createSession, deleteSession } from "./sessions.js";

test("jobs persist complete host metadata with independent returned snapshots and merged concurrent updates", async (t) => {
  const h = await audioStorageHarness(t);
  await Promise.all([
    updateAudioJob(h.storage, h.session.id, h.job.id, { remoteSourceId: "source_1" }),
    updateAudioJob(h.storage, h.session.id, h.job.id, { remoteTaskId: "task_1", status: "running" }),
  ]);
  const loaded = await loadAudioJob(h.storage, h.session.id, h.job.id);
  assert.equal(loaded.remoteSourceId, "source_1");
  assert.equal(loaded.remoteTaskId, "task_1");
  assert.equal(loaded.status, "running");
  assert.deepEqual(
    { pluginId: loaded.pluginId, toolId: loaded.toolId, toolVersion: loaded.toolVersion },
    { pluginId: "live-smith.lalal", toolId: "separate_stems", toolVersion: "1" },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.directory, `${h.job.id}.job.json`), "utf8")), loaded);
  loaded.stems.length = 0;
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).stems, ["vocals", "drums"]);
  assert.equal((await listAudioJobs(h.storage, h.session.id)).length, 1);
});

test("jobs require persistent storage and a real owning Session, including queued writes after deletion", async (t) => {
  const h = await audioStorageHarness(t);
  const input = separationJobInput;
  await assert.rejects(createAudioJob(undefined, h.session.id, { ...input, stems: [...input.stems] }), /persistent storage/);
  await assert.rejects(listAudioJobs(undefined, h.session.id), /persistent storage/);
  await assert.rejects(loadAudioJob(undefined, h.session.id, h.job.id), /persistent storage/);
  await assert.rejects(updateAudioJob(undefined, h.session.id, h.job.id, {}), /persistent storage/);
  await assert.rejects(createAudioJob(h.storage, "missing", { ...input, stems: [...input.stems] }), /owning Session/);
  const deletion = deleteSession(h.storage, h.session.id);
  const lateUpdate = updateAudioJob(h.storage, h.session.id, h.job.id, { status: "failed" });
  await deletion;
  await assert.rejects(lateUpdate, /owning Session/);
});

test("writing a job promotes only its existing transient Session", async (t) => {
  const h = await audioStorageHarness(t);
  const selected = await createSession(h.storage, sessionInput, { transient: true });
  const unrelated = await createSession(h.storage, sessionInput, { transient: true });
  await createAudioJob(h.storage, selected.id, { ...separationJobInput, stems: ["bass"] });
  const saved = JSON.parse(await fs.readFile(path.join(h.storage, "live-smith-sessions.json"), "utf8")) as { id: string }[];
  assert.ok(saved.some((session) => session.id === selected.id));
  assert.ok(!saved.some((session) => session.id === unrelated.id));
});

test("40-job cap is serialized across providers and simultaneous creates and counts every durable status", async (t) => {
  const h = await audioStorageHarness(t);
  const inputs = [separationJobInput, ...generationJobCases.map(({ input }) => input)];
  const results = await Promise.allSettled(Array.from({ length: MAX_AUDIO_SESSION_JOBS + 2 }, (_, index) =>
    createAudioJob(h.storage, h.session.id, inputs[index % inputs.length]!)
  ));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, MAX_AUDIO_SESSION_JOBS - 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 3);
  await updateAudioJob(h.storage, h.session.id, h.job.id, { status: "cancelled" });
  await assert.rejects(createAudioJob(h.storage, h.session.id, separationJobInput), /40 audio job/);
  assert.equal((await listAudioJobs(h.storage, h.session.id)).length, MAX_AUDIO_SESSION_JOBS);
});

test("job IDs and asset references cannot cross Session or job ownership", async (t) => {
  const h = await audioStorageHarness(t);
  const second = await createSession(h.storage, sessionInput);
  await assert.rejects(loadAudioJob(h.storage, second.id, h.job.id), AudioStorageError);
  await assert.rejects(loadAudioJob(h.storage, h.session.id, "../outside"), /invalid/);
  const sibling = await createAudioJob(h.storage, h.session.id, separationJobInput);
  const foreign = await saveAudioAsset(h.storage, h.session.id, {
    jobId: sibling.id, role: "vocals", label: "vocals", bytes: waveBytes(), origin: { kind: "attachment" }, signal: h.signal,
  });
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [foreign] }), AudioStorageError);
  const output = await h.save("vocals");
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { sourceAssetId: output.id }), AudioStorageError);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [{ ...output, sha256: "b".repeat(64) }] }), AudioStorageError);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [output, output] }), AudioStorageError);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [{ ...output, id: "missing" }] }), AudioStorageError);
  const source = await h.save();
  await updateAudioJob(h.storage, h.session.id, h.job.id, { sourceAssetId: source.id, outputAssets: [output], status: "partial" });
  assert.equal((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets[0]?.id, output.id);
  await overwriteJson(path.join(h.directory, `${h.job.id}.job.json`), { ...h.job, outputAssets: [foreign] });
  await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
});

test("strict bounded job metadata rejects corrupt reads and invalid writes without replacing saved state", async (t) => {
  const h = await audioStorageHarness(t);
  const target = path.join(h.directory, `${h.job.id}.job.json`);
  const initial = await fs.readFile(target, "utf8");
  for (const update of [
    { status: "invented" }, { message: "x".repeat(MAX_AUDIO_JOB_METADATA_BYTES) },
    { apiKey: "not-a-real-key" }, { remoteTaskId: "https://example.test/task?token=private" },
    { remoteSourceId: "bad\nvalue" }, { outputAssets: {} }, { sourceAssetId: undefined },
    { provider: "elevenlabs" }, { serviceId: "other-service" }, { operation: "generate_music" },
    { modelId: "music_v2" }, { connectionFingerprint: "b".repeat(64) }, { stems: ["bass"] },
    { id: "other-job" }, { sessionId: "other-session" },
  ]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, update as never));
    assert.equal(await fs.readFile(target, "utf8"), initial);
  }
  for (const mutated of [
    { ...h.job, provider: "other" }, { ...h.job, stems: ["vocals", "vocals"] },
    { ...h.job, sessionId: "other" }, { ...h.job, createdAt: "yesterday" },
    { ...h.job, connectionFingerprint: "not-a-hash" }, { ...h.job, apiKey: "not-a-real-key" },
  ]) {
    await overwriteJson(target, mutated);
    await assert.rejects(listAudioJobs(h.storage, h.session.id), AudioStorageError);
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { status: "failed" }), AudioStorageError);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), mutated);
  }
  await fs.writeFile(target, " ".repeat(MAX_AUDIO_JOB_METADATA_BYTES + 1));
  await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
  await fs.writeFile(target, "{incomplete");
  await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
  await overwriteJson(target, h.job);
  await fs.rename(target, `${target}.original`);
  await fs.symlink(`${target}.original`, target);
  await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
});

test("storage persists caller-selected durable states without implementing a job state machine", async (t) => {
  const h = await audioStorageHarness(t);
  for (const status of ["submitting", "unknown", "running", "collecting", "partial", "interrupted", "cancelled", "failed", "completed"] satisfies AudioJob["status"][]) {
    await updateAudioJob(h.storage, h.session.id, h.job.id, { status });
    assert.equal((await loadAudioJob(h.storage, h.session.id, h.job.id)).status, status);
  }
});

test("generation jobs preserve connection identity and model without a source or advertised provider availability", async (t) => {
  for (const { input, roles } of generationJobCases) {
    const h = await audioStorageHarness(t, input);
    assert.equal(h.job.provider, input.provider);
    assert.equal(h.job.serviceId, input.serviceId);
    assert.equal(h.job.operation, input.operation);
    assert.equal(h.job.modelId, input.modelId);
    assert.deepEqual(h.job.stems, []);
    assert.equal(Object.hasOwn(h.job, "sourceAssetId"), false);
    assert.equal(Object.hasOwn(h.job, "remoteSourceId"), false);
    const outputs = await Promise.all(roles.map((role) => h.save(role)));
    const updated = await updateAudioJob(h.storage, h.session.id, h.job.id, {
      status: "completed", remoteTaskId: "task_1", outputAssets: outputs,
    });
    assert.deepEqual(await loadAudioJob(h.storage, h.session.id, h.job.id), updated);
    assert.deepEqual(await listAudioJobs(h.storage, h.session.id), [updated]);
  }
});

test("legacy LALAL jobs normalize the service ID without rewriting until an authorized update", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  const output = await h.save("vocals");
  const current = await updateAudioJob(h.storage, h.session.id, h.job.id, {
    sourceAssetId: source.id, outputAssets: [output], status: "partial",
  });
  const {
    serviceId: _,
    pluginId: _pluginId,
    toolId: _toolId,
    toolVersion: _toolVersion,
    ...legacy
  } = current;
  const target = path.join(h.directory, `${h.job.id}.job.json`);
  await overwriteJson(target, legacy);
  const raw = await fs.readFile(target, "utf8");
  const before = await fs.stat(target);
  const expected = {
    ...legacy,
    serviceId: LEGACY_AUDIO_SERVICE_ID,
    pluginId: "live-smith.lalal",
    toolId: "separate_stems",
    toolVersion: "1",
  };
  assert.deepEqual(await loadAudioJob(h.storage, h.session.id, h.job.id), expected);
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), [expected]);
  assert.equal(await fs.readFile(target, "utf8"), raw);
  assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs);
  assert.equal((await fs.stat(target)).ino, before.ino);
  const updated = await updateAudioJob(h.storage, h.session.id, h.job.id, { status: "completed" });
  assert.equal(updated.serviceId, LEGACY_AUDIO_SERVICE_ID);
  assert.deepEqual(updated.outputAssets, [output]);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), updated);
});

test("job creation and persisted reads reject incompatible providers, operations, stems and connection metadata", async (t) => {
  const h = await audioStorageHarness(t);
  const target = path.join(h.directory, `${h.job.id}.job.json`);
  for (const patch of [
    { provider: "other" }, { operation: "other" },
    { provider: "lalal", operation: "generate_music", stems: [] },
    { provider: "lalal", operation: "generate_sound_effect", stems: [] },
    { provider: "elevenlabs", operation: "separate_stems" },
    { provider: "suno", operation: "separate_stems" },
    { provider: "suno", operation: "generate_sound_effect", stems: [] },
    { stems: [] }, { stems: null }, { stems: ["music"] }, { stems: ["vocals", "vocals"] },
    ...generationJobCases.map(({ input }) => ({ ...input, stems: ["vocals"] })),
    { serviceId: "" }, { serviceId: null }, { serviceId: "../outside" },
    { serviceId: "service\n" }, { serviceId: "s".repeat(129) },
    { connectionFingerprint: "bad" }, { apiKey: "not-a-real-key" },
    { pluginId: "other.plugin" }, { toolId: "generate_music" }, { toolVersion: "2" },
    ...[null, "", " ", "music v2", " music_v2", "music_v2\n", "music\u202ev2",
      "m".repeat(129)].map((modelId) => ({ modelId })),
  ]) {
    await overwriteJson(target, h.job);
    await assert.rejects(createAudioJob(h.storage, h.session.id, { ...separationJobInput, ...patch } as never), AudioStorageError);
    assert.deepEqual(await listAudioJobs(h.storage, h.session.id), [h.job]);
    const invalid = { ...h.job, ...patch };
    await overwriteJson(target, invalid);
    await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
    await assert.rejects(listAudioJobs(h.storage, h.session.id), AudioStorageError);
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { status: "failed" }), AudioStorageError);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), invalid);
  }
});

test("new jobs require explicit identity and optional models are bounded identifiers without normalization", async (t) => {
  const h = await audioStorageHarness(t);
  for (const field of ["provider", "serviceId", "operation", "connectionFingerprint", "stems"]) {
    const input: Record<string, unknown> = { ...separationJobInput };
    delete input[field];
    await assert.rejects(createAudioJob(h.storage, h.session.id, input as never), AudioStorageError);
  }
  await assert.rejects(createAudioJob(h.storage, h.session.id, { ...separationJobInput, modelId: undefined } as never), AudioStorageError);
  await assert.rejects(createAudioJob(h.storage, h.session.id, { ...separationJobInput, stems: new Array(1) }), AudioStorageError);
  for (const modelId of ["music_v2", "model.v2:beta-1", "model/path", "m".repeat(128)]) {
    const job = await createAudioJob(h.storage, h.session.id, { ...separationJobInput, modelId });
    assert.equal((await loadAudioJob(h.storage, h.session.id, job.id)).modelId, modelId);
  }
  const input = { ...separationJobInput, stems: ["vocals"] } as Parameters<typeof createAudioJob>[2];
  const pending = createAudioJob(h.storage, h.session.id, input);
  input.serviceId = "changed-owner";
  input.stems.push("drums");
  const created = await pending;
  assert.equal(created.serviceId, separationJobInput.serviceId);
  assert.deepEqual(created.stems, ["vocals"]);
});

test("generation jobs reject source fields and never inherit a missing legacy service ID", async (t) => {
  for (const { input } of generationJobCases) {
    const h = await audioStorageHarness(t, input);
    const target = path.join(h.directory, `${h.job.id}.job.json`);
    const original = await fs.readFile(target, "utf8");
    for (const patch of [{ sourceAssetId: "source_1" }, { remoteSourceId: "source_1" }]) {
      await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, patch), AudioStorageError);
      assert.equal(await fs.readFile(target, "utf8"), original);
      await overwriteJson(target, { ...h.job, ...patch });
      await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
      await fs.writeFile(target, original);
    }
    const { serviceId: _, ...missingService } = h.job;
    await overwriteJson(target, missingService);
    await assert.rejects(listAudioJobs(h.storage, h.session.id), AudioStorageError);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), missingService);
  }
});

test("generated outputs remain bound to their exact job and Session even with matching credentials", async (t) => {
  const input = generationJobCases[0]!.input;
  const h = await audioStorageHarness(t, input);
  const asset = await h.save("music");
  const peer = await createAudioJob(h.storage, h.session.id, { ...input, serviceId: "other-music-service" });
  await assert.rejects(updateAudioJob(h.storage, h.session.id, peer.id, { outputAssets: [asset] }), AudioStorageError);
  const other = await createSession(h.storage, sessionInput);
  const foreign = await createAudioJob(h.storage, other.id, input);
  await assert.rejects(updateAudioJob(h.storage, other.id, foreign.id, { outputAssets: [asset] }), AudioStorageError);
  for (const outputs of [[asset, asset], [{ ...asset, sha256: "b".repeat(64) }], [{ ...asset, origin: { kind: "attachment" } }]]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: outputs } as never), AudioStorageError);
  }
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets, []);
});

test("the acknowledged generation result shape is validated and cannot change during recovery", async (t) => {
  const h = await audioStorageHarness(t, { ...generationJobCases[0]!.input, provider: "sunoapi" });
  for (const roles of [[], ["source"], ["music_alternative"], ["music", "music"], ["music", "residual"], null]) {
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { expectedOutputRoles: roles } as never), AudioStorageError);
  }
  const acknowledged = await updateAudioJob(h.storage, h.session.id, h.job.id, { expectedOutputRoles: ["music"] });
  assert.deepEqual(acknowledged.expectedOutputRoles, ["music"]);
  await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { expectedOutputRoles: ["music", "music_alternative"] }), AudioStorageError);
  await assert.rejects(h.save("music_alternative"), AudioStorageError);
  const asset = await h.save("music");
  assert.equal((await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [asset], status: "completed" })).status, "completed");
  const separation = await audioStorageHarness(t);
  await assert.rejects(updateAudioJob(separation.storage, separation.session.id, separation.job.id, { expectedOutputRoles: ["music"] }), AudioStorageError);
});
