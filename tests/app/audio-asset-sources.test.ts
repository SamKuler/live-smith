import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import type { AudioAsset } from "../../src/audio-services/contracts.js";
import { resolveSampleSource } from "../../src/live/sample-source.js";
import { createSession } from "../../src/storage/sessions.js";
import { addAudioAssetSampleSources, audioAssetSampleSourceInstructions } from "../../src/app/audio-asset-sources.js";
import { assetHarness, mp3Bytes, sourceBindings, waveBytes } from "./support/audio-asset-sources-test-helpers.js";
import { createRequestAudioSampleSources, prepareRequestAudioSampleSources, requestAudioSampleSourceInstructions } from "../../src/app/request-audio-sources.js";

test("persisted assets register lazily in the shared send map without exposing labels or paths", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  const sources = createRequestAudioSampleSources({ ...h.input, requestId: "event", refs: [] });
  const filesBefore = await fs.readdir(h.directory);
  await addAudioAssetSampleSources(h.input, sources, [asset]);
  assert.deepEqual(await fs.readdir(h.directory), filesBefore);
  assert.equal(h.staged.length, 0);
  assert.equal(sources.size, 1);
  const source = resolveSampleSource(h.input.context, { kind: "audio_asset", assetRef: asset.id }, {}, sources);
  assert.equal(source, sources.get(asset.id));
  assert.throws(() => source.filePath, /not prepared/);
  const instructions = audioAssetSampleSourceInstructions(sources);
  assert.match(instructions, new RegExp(asset.id));
  assert.doesNotMatch(instructions, /untrusted|label.wav|live-smith-asset-import|request_audio_attachment/);
  assert.equal(requestAudioSampleSourceInstructions(sources), "");
  assert.equal(audioAssetSampleSourceInstructions(new Map()), "");
  // Input records can be reused by the job runner, but cannot change this snapshot.
  asset.sha256 = "b".repeat(64);
  asset.origin.startBeat = 100;
  await prepareRequestAudioSampleSources(sourceBindings(source), h.controller.signal);
  assert.equal(h.staged.length, 1);
});

test("asset imports verify WAV/MP3 bytes, share preparation, preserve cached imports, and clean private staging", async (t) => {
  const h = await assetHarness(t);
  const assets = [await h.save(), await h.save("drums", mp3Bytes())];
  await addAudioAssetSampleSources(h.input, h.sources, assets);
  const first = h.sources.get(assets[0]!.id)!;
  const second = h.sources.get(assets[1]!.id)!;
  const bindings = sourceBindings(first, first, second);
  const progress = await prepareRequestAudioSampleSources(bindings, h.controller.signal, () => h.operations.push("boundary"));
  assert.equal(progress.results.length, 2);
  assert.deepEqual(progress.keys, assets.map((asset) => `live-action-step:audio-asset-import:${asset.id}`));
  assert.doesNotMatch(progress.results.join(" "), /\/Live Project|untrusted|\.wav|\.mp3/);
  assert.deepEqual(h.operations, ["boundary", "import", "boundary", "boundary", "import", "boundary"]);
  assert.deepEqual(h.staged.map((item) => item.bytes), [new Uint8Array(waveBytes()), mp3Bytes()]);
  assert.deepEqual(h.staged.map((item) => path.extname(item.filePath)), [".wav", ".mp3"]);
  for (const stage of h.staged) {
    assert.equal(stage.fileMode, 0o600);
    assert.equal(stage.directoryMode, 0o700);
    await assert.rejects(fs.stat(path.dirname(stage.filePath)), { code: "ENOENT" });
  }
  await addAudioAssetSampleSources(h.input, h.sources, assets);
  assert.equal(h.sources.get(assets[0]!.id), first);
  assert.deepEqual(await prepareRequestAudioSampleSources(bindings, h.controller.signal), { results: [], keys: [] });
  assert.equal(h.staged.length, 2);
  assert.equal(first.filePath, "/Live Project/Samples/1.wav");
  await assert.rejects(addAudioAssetSampleSources(h.input, h.sources, [{ ...assets[0]!, sha256: "c".repeat(64) }]), /changed/);
  assert.equal(h.sources.get(assets[0]!.id), first);
});

test("asset registration and exact storage reads reject foreign Session ownership", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  const foreign = await createSession(h.directory, { title: "Other", projectKey: "project", scope: { kind: "object", identity: "song", label: "Song" } });
  await assert.rejects(addAudioAssetSampleSources({ ...h.input, sessionId: foreign.id }, h.sources, [asset]), /does not belong/);
  assert.equal(h.sources.size, 0);
  await addAudioAssetSampleSources({ ...h.input, sessionId: foreign.id }, h.sources, [{ ...asset, sessionId: foreign.id }]);
  await assert.rejects(prepareRequestAudioSampleSources(sourceBindings(...h.sources.values()), h.controller.signal));
  assert.equal(h.staged.length, 0);
  await assert.rejects(addAudioAssetSampleSources({ ...h.input, storageDirectory: undefined }, new Map(), [asset]), /Persistent storage/);
});

test("asset import revalidates the expected hash and complete metadata before staging", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  const changes: Partial<AudioAsset>[] = [
    { sha256: "d".repeat(64) }, { byteLength: asset.byteLength + 1 },
    { mediaType: "audio/mpeg" }, { durationSeconds: asset.durationSeconds + 1 },
    { channels: 2 }, { sampleRate: 44100 }, { jobId: "job-other" },
    { role: "drums" }, { label: "Other" }, { origin: { kind: "asset", sourceAssetId: "asset-other" } },
  ];
  const filesBefore = await fs.readdir(h.directory);
  for (const change of changes) {
    const sources = new Map();
    await addAudioAssetSampleSources(h.input, sources, [{ ...asset, ...change }]);
    await assert.rejects(prepareRequestAudioSampleSources(sourceBindings(...sources.values()), h.controller.signal), /changed/);
  }
  assert.equal(h.staged.length, 0);
  assert.deepEqual(await fs.readdir(h.directory), filesBefore);
});
