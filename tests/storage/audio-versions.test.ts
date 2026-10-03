import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { AudioAsset, AudioJob } from "../../src/audio-services/contracts.js";
import { audioOutputDescriptor } from "../../src/audio-services/audio-output.js";
import { savePluginAudioArtifact } from "../../src/storage/audio-artifacts.js";
import { saveAudioAsset, readAudioAsset } from "../../src/storage/audio-assets.js";
import { audioAssetId, createAudioJob, loadAudioJob, updateAudioJob } from "../../src/storage/audio-jobs.js";
import { audioStorageHarness, fingerprint, generationJobCases, overwriteJson, waveBytes } from "./support/audio-storage-test-helpers.js";

const music = generationJobCases.find((entry) => entry.input.provider === "sunoapi")!.input;

test("music siblings share a work without a derived chain; selected revisions and exact retries retain immutable versions", async (t) => {
  const h = await audioStorageHarness(t, music);
  const first = await h.save("music");
  const alternative = await h.save("music_alternative");
  assert.deepEqual(first.version, { groupId: first.id, number: 1 });
  assert.deepEqual(alternative.version, { groupId: first.id, number: 2 });
  const next = await createAudioJob(h.storage, h.session.id, { ...music, artifactSource: { kind: "audio", id: alternative.id } });
  const save = (role: AudioAsset["role"]) => saveAudioAsset(h.storage, h.session.id, {
    jobId: next.id, role, label: role, bytes: waveBytes(), origin: { kind: "generated" }, signal: h.signal,
  });
  const revised = await save("music");
  const revisedAlternative = await save("music_alternative");
  assert.deepEqual(revised.version, { groupId: first.id, number: 3, derivedFromId: alternative.id });
  assert.deepEqual(revisedAlternative.version, { groupId: first.id, number: 4, derivedFromId: alternative.id });
  assert.deepEqual(revised.origin, { kind: "generated", sourceAssetId: alternative.id });
  assert.deepEqual(await h.save("music"), first);
  assert.deepEqual(await h.save("music_alternative"), alternative);
  assert.deepEqual(await save("music"), revised);
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, next.id)).artifactSource, { kind: "audio", id: alternative.id });
  await assert.rejects(updateAudioJob(h.storage, h.session.id, next.id, { artifactSource: { kind: "audio", id: first.id } } as never));
});

test("metadata receipts reserve version numbers before a missing blob is recovered", async (t) => {
  const h = await audioStorageHarness(t, music);
  const first = await h.save("music");
  await fs.unlink(path.join(h.directory, `${first.id}.audio`));
  const second = await h.save("music_alternative");
  assert.deepEqual(second.version, { groupId: first.id, number: 2 });
  assert.deepEqual(await h.save("music"), first);
  assert.deepEqual((await readAudioAsset(h.storage, h.session.id, first.id)).bytes, waveBytes());
});

test("component outputs and effects retain source provenance without becoming full-song versions", async (t) => {
  const h = await audioStorageHarness(t, music);
  const source = await h.save("music");
  const sourceRef = { kind: "audio" as const, id: source.id };
  const make = async (operation: "extract_music_stems" | "generate_sound_sample", roles: AudioAsset["role"][]) => {
    const job = await createAudioJob(h.storage, h.session.id, { provider: "suno", serviceId: "stems", operation,
      connectionFingerprint: fingerprint, stems: [], artifactSource: sourceRef });
    const assets: AudioAsset[] = [];
    for (const role of roles) assets.push(await saveAudioAsset(h.storage, h.session.id, {
      jobId: job.id, role, label: role, origin: { kind: "generated" }, bytes: waveBytes(), signal: h.signal,
    }));
    return assets;
  };
  const stems = await make("extract_music_stems", ["stem_vocals", "stem_drums", "stem_vocals_alternative"]);
  for (const asset of stems) {
    assert.deepEqual(asset.version, { groupId: asset.id, number: 1 });
    assert.deepEqual(asset.origin, { kind: "generated", sourceAssetId: source.id });
    assert.equal(audioOutputDescriptor(asset.role)?.kind, "stem");
  }
  const effects = await make("generate_sound_sample", ["sound_effect", "sound_effect_alternative"]);
  assert.deepEqual(effects[0]!.version, { groupId: effects[0]!.id, number: 1 });
  assert.deepEqual(effects[1]!.version, { groupId: effects[0]!.id, number: 2 });
  assert.notEqual(effects[0]!.version!.groupId, source.version!.groupId);
});

test("unversioned legacy stem receipts keep their role keys, asset hashes, manifests and bytes on read and retry", async (t) => {
  const h = await audioStorageHarness(t, { provider: "suno", serviceId: "stems", operation: "extract_music_stems",
    connectionFingerprint: fingerprint, stems: [] });
  const saved = await h.save("suno_stem_vocals");
  const { version: _version, ...historical } = saved;
  const outputs = [{ key: "11111111-1111-4111-8111-111111111111", role: historical.role }] as NonNullable<AudioJob["expectedOutputs"]>;
  await overwriteJson(path.join(h.directory, `${historical.id}.asset.json`), historical);
  await updateAudioJob(h.storage, h.session.id, h.job.id, { remoteTaskId: outputs[0]!.key, expectedOutputs: outputs,
    remoteOutputs: outputs, outputAssets: [historical], status: "completed" });
  assert.equal(historical.id, audioAssetId(h.job.id, "suno_stem_vocals"));
  assert.notEqual(historical.id, audioAssetId(h.job.id, "stem_vocals"));
  assert.deepEqual(await h.save("suno_stem_vocals"), historical);
  assert.deepEqual(await readAudioAsset(h.storage, h.session.id, historical.id), { asset: historical, bytes: waveBytes() });
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).expectedOutputs, outputs);
  assert.deepEqual(audioOutputDescriptor(historical.role), audioOutputDescriptor("stem_vocals"));
});


test("built-in music revises an explicitly selected generic Plugin audio artifact with shared numbering", async (t) => {
  const h = await audioStorageHarness(t, music);
  const original = await h.save("music");
  await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [original], status: "completed" });
  const plugin = await savePluginAudioArtifact(h.storage, h.session.id, {
    pluginId: "fixture.audio", serverId: "audio", toolName: "revise", label: "Plugin revision", format: "wav",
    bytes: waveBytes(), revisionOf: { kind: "audio", id: original.id }, signal: h.signal,
  });
  assert.deepEqual(plugin.version, { groupId: original.id, number: 2, derivedFromId: original.id });
  const revisedJob = await createAudioJob(h.storage, h.session.id, {
    ...music, artifactSource: { kind: "audio", id: plugin.id },
  });
  const revised = await saveAudioAsset(h.storage, h.session.id, {
    jobId: revisedJob.id, role: "music", label: "Built-in revision", bytes: waveBytes(), origin: { kind: "generated" }, signal: h.signal,
  });
  assert.deepEqual(revised.version, { groupId: original.id, number: 3, derivedFromId: plugin.id });
  assert.deepEqual(revised.origin, { kind: "generated", sourceAssetId: plugin.id });
  assert.deepEqual(await h.save("music"), original);
});


test("an intermediate generic Plugin revision cannot merge known sound effects into a music work", async (t) => {
  const effects = generationJobCases.find((entry) => entry.input.operation === "generate_sound_effect")!.input;
  const h = await audioStorageHarness(t, effects);
  const source = await h.save("sound_effect");
  await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [source], status: "completed" });
  const generic = await savePluginAudioArtifact(h.storage, h.session.id, {
    pluginId: "fixture.audio", serverId: "audio", toolName: "revise", label: "Edited audio", format: "wav",
    bytes: waveBytes(), revisionOf: { kind: "audio", id: source.id }, signal: h.signal,
  });
  assert.equal(generic.version.groupId, source.id);
  const job = await createAudioJob(h.storage, h.session.id, { ...music, artifactSource: { kind: "audio", id: generic.id } });
  const result = await saveAudioAsset(h.storage, h.session.id, { jobId: job.id, role: "music", label: "New song",
    origin: { kind: "generated" }, bytes: waveBytes(), signal: h.signal });
  assert.deepEqual(result.version, { groupId: result.id, number: 1 });
  assert.equal(result.origin.sourceAssetId, generic.id);
});
