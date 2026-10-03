import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
import test from "node:test";

import { inspectAudioAttachment, isAudioAttachmentInspection } from "../../src/attachments/audio.js";
import {
  MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_SESSION_BYTES, SEPARATION_STEMS, type AudioAsset,
} from "../../src/audio-services/contracts.js";
import { copyAudioFileSafely } from "../../src/live/audio-attachment-source.js";
import { createHostAbortController } from "../../src/runtime/host.js";
import {
  deleteSessionAudio, listAudioAssets, listSessionAudioDirectoryIds,
  readAudioAsset, readExpectedAudioAsset, saveAudioAsset,
} from "../../src/storage/audio-assets.js";
import {
  AudioStorageError, MAX_AUDIO_ASSET_METADATA_BYTES, audioAssetId, audioAssetInspectionLimits,
  createAudioJob, loadAudioJob, updateAudioJob,
} from "../../src/storage/audio-jobs.js";
import {
  audioStorageHarness, generationJobCases, mp3Bytes, overwriteJson, separationJobInput, sessionInput, waveBytes,
} from "./support/audio-storage-test-helpers.js";
import { isStorageCommitOutcomeUnknownError, withStorageTransaction } from "../../src/storage/persistence.js";
import { createStorageId } from "../../src/storage/id.js";
import { createSession, deleteSession } from "../../src/storage/sessions.js";

test("WAV and MP3 assets persist verified inspection, hashes and private permissions", async (t) => {
  const h = await audioStorageHarness(t);
  for (const [role, bytes, mediaType] of [
    ["source", waveBytes(), "audio/wav"], ["vocals", mp3Bytes(), "audio/mpeg"],
  ] as const) {
    const asset = await h.save(role, bytes);
    assert.equal(asset.mediaType, mediaType);
    assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(await readAudioAsset(h.storage, h.session.id, asset.id), { asset, bytes });
    assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset), bytes);
    if (platform !== "win32") {
      for (const suffix of [".audio", ".asset.json"]) assert.equal((await fs.stat(path.join(h.directory, asset.id + suffix))).mode & 0o777, 0o600);
    }
  }
  assert.equal((await listAudioAssets(h.storage, h.session.id, h.job.id)).length, 2);
  if (platform !== "win32") {
    assert.equal((await fs.stat(h.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.dirname(h.directory))).mode & 0o777, 0o700);
  }
});

test("concurrent exact retries reuse the same immutable role asset even before job output metadata commits", async (t) => {
  const h = await audioStorageHarness(t);
  const assets = await Promise.all([h.save("vocals"), h.save("vocals"), h.save("vocals")]);
  assert.deepEqual(assets[1], assets[0]);
  assert.deepEqual(assets[2], assets[0]);
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets, []);
  assert.deepEqual(await listAudioAssets(h.storage, h.session.id, h.job.id), [assets[0]]);
  const asset = assets[0]!;
  const initialStat = await fs.stat(path.join(h.directory, `${asset.id}.audio`));
  await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [asset] });
  await h.save("vocals");
  assert.equal((await fs.stat(path.join(h.directory, `${asset.id}.audio`))).ino, initialStat.ino);
  assert.equal((await fs.readdir(h.directory)).filter((name) => name.endsWith(".audio")).length, 1);
  const changed = waveBytes(); changed[changed.length - 1] = 9;
  await assert.rejects(h.save("vocals", changed), /differs/);
  await assert.rejects(saveAudioAsset(h.storage, h.session.id, {
    jobId: h.job.id, role: "vocals", label: "changed label", bytes: waveBytes(), origin: { kind: "attachment" }, signal: h.signal,
  }), /differs/);
  assert.deepEqual((await readAudioAsset(h.storage, h.session.id, asset.id)).bytes, waveBytes());
});

test("a committed blob without metadata can recover only exact bytes without creating another file", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save("vocals");
  await fs.unlink(path.join(h.directory, `${asset.id}.asset.json`));
  const original = await fs.stat(path.join(h.directory, `${asset.id}.audio`));
  const changed = waveBytes(); changed[changed.length - 1] = 1;
  await assert.rejects(h.save("vocals", changed), AudioStorageError);
  assert.deepEqual(await h.save("vocals"), asset);
  assert.equal((await fs.stat(path.join(h.directory, `${asset.id}.audio`))).ino, original.ino);
  assert.equal((await fs.readdir(h.directory)).length, 3);
});

test("unknown blob or asset commit outcomes retain durable data for exact retry", async (t) => {
  for (const failureAtDirectorySync of [1, 2]) {
    const h = await audioStorageHarness(t);
    const probe = await fs.open(path.join(h.directory, `${h.job.id}.job.json`));
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    const originalSync = prototype.sync;
    await probe.close();
    let directorySyncs = 0;
    const mocked = t.mock.method(prototype, "sync", async function (this: fs.FileHandle) {
      if ((await this.stat()).isDirectory() && ++directorySyncs === failureAtDirectorySync) {
        throw new Error("simulated directory sync failure");
      }
      return originalSync.call(this);
    });
    try { await assert.rejects(h.save("vocals"), isStorageCommitOutcomeUnknownError); }
    finally { mocked.mock.restore(); }
    const names = await fs.readdir(h.directory);
    assert.equal(names.filter((name) => name.endsWith(".asset.json")).length, 1);
    assert.equal(names.filter((name) => name.endsWith(".audio")).length, failureAtDirectorySync === 1 ? 0 : 1);
    const asset = await h.save("vocals");
    assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset), waveBytes());
    assert.equal((await fs.readdir(h.directory)).length, 3);
    assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets, []);
  }
});

test("audio metadata requires valid UTF-8 and reads restore private file permissions", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  const target = path.join(h.directory, `${asset.id}.asset.json`);
  const raw = Buffer.from(JSON.stringify(asset));
  raw[raw.indexOf('"label":"') + 9] = 0xff;
  await fs.writeFile(target, raw);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
  await overwriteJson(target, asset);
  if (platform !== "win32") {
    await fs.chmod(target, 0o644);
    await fs.chmod(path.join(h.directory, `${asset.id}.audio`), 0o644);
    await readAudioAsset(h.storage, h.session.id, asset.id);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(h.directory, `${asset.id}.audio`))).mode & 0o777, 0o600);
  }
});

test("asset operations reject missing storage, foreign IDs, foreign origin references, and deleted owners", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  const other = await createSession(h.storage, sessionInput);
  await assert.rejects(readAudioAsset(h.storage, other.id, asset.id), AudioStorageError);
  await assert.rejects(readExpectedAudioAsset(h.storage, other.id, asset), AudioStorageError);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, "../outside"), /invalid/);
  await assert.rejects(readAudioAsset(undefined, h.session.id, asset.id), /persistent storage/);
  await assert.rejects(listAudioAssets(undefined, h.session.id), /persistent storage/);
  await deleteSessionAudio(undefined, h.session.id);
  assert.deepEqual(await listSessionAudioDirectoryIds(undefined), []);
  await assert.rejects(deleteSessionAudio(undefined, "../outside"), /invalid/);
  await assert.rejects(saveAudioAsset(undefined, h.session.id, {
    jobId: h.job.id, role: "source", label: "source", bytes: waveBytes(), origin: { kind: "attachment" }, signal: h.signal,
  }), /persistent storage/);
  await assert.rejects(saveAudioAsset(h.storage, h.session.id, {
    jobId: h.job.id, role: "vocals", label: "vocals", bytes: waveBytes(), origin: { kind: "asset", sourceAssetId: "missing" }, signal: h.signal,
  }), AudioStorageError);
  await deleteSession(h.storage, h.session.id);
  await assert.rejects(h.save("vocals"), /owning Session/);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), /owning Session/);
});

test("asset reads reject bytes, inspection, metadata and hash tampering; immutable expected metadata detects coherent rewrites", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  const blobPath = path.join(h.directory, `${asset.id}.audio`);
  const metadataPath = path.join(h.directory, `${asset.id}.asset.json`);
  const changed = waveBytes(); changed[changed.length - 1] = 1;
  await fs.writeFile(blobPath, changed);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
  await overwriteJson(metadataPath, { ...asset, sha256: createHash("sha256").update(changed).digest("hex") });
  await assert.rejects(readExpectedAudioAsset(h.storage, h.session.id, asset), /changed since/);
  await fs.writeFile(blobPath, waveBytes());
  for (const patch of [
    { durationSeconds: 2 }, { sampleRate: 16000 }, { channels: 2 }, { byteLength: asset.byteLength - 1 },
    { mediaType: "audio/mpeg" }, { sessionId: "other" }, { id: "other" }, { apiKey: "not-a-real-key" },
    { origin: { kind: "arrangement", startBeat: 10, endBeat: 2 } },
  ]) {
    await overwriteJson(metadataPath, { ...asset, ...patch });
    await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id));
  }
  await fs.writeFile(metadataPath, " ".repeat(MAX_AUDIO_ASSET_METADATA_BYTES + 1));
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
  await overwriteJson(metadataPath, asset);
  await fs.truncate(blobPath, MAX_AUDIO_ASSET_BYTES + 1);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
});

test("symlinked blobs, metadata, and Session directories never resolve outside audio storage", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  for (const suffix of [".audio", ".asset.json"]) {
    const target = path.join(h.directory, asset.id + suffix);
    await fs.rename(target, target + ".original");
    await fs.symlink(target + ".original", target);
    await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
    await fs.unlink(target);
    await fs.rename(target + ".original", target);
  }
  const displaced = path.join(h.storage, "displaced-audio");
  await fs.rename(h.directory, displaced);
  await fs.symlink(displaced, h.directory);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
  await assert.rejects(h.save("vocals"), AudioStorageError);
  await assert.rejects(deleteSessionAudio(h.storage, h.session.id), AudioStorageError);
  await assert.rejects(listSessionAudioDirectoryIds(h.storage), AudioStorageError);
  assert.deepEqual(await fs.readFile(path.join(displaced, `${asset.id}.audio`)), Buffer.from(waveBytes()));
});

test("directory replacement during byte reads is rejected even when the replacement contains identical bytes", async (t) => {
  const h = await audioStorageHarness(t);
  const asset = await h.save();
  const displaced = path.join(h.storage, "displaced");
  let checks = 0;
  const signal = { get aborted() {
    checks += 1;
    if (checks === 3) {
      fsSync.renameSync(h.directory, displaced);
      fsSync.cpSync(displaced, h.directory, { recursive: true });
    }
    return false;
  } } as AbortSignal;
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id, signal), AudioStorageError);
});

test("1 GiB quota includes atomic remnants, orphan blobs, inputs, and outputs and admits exactly one concurrent final asset", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  const remainingForOrphans = MAX_AUDIO_SESSION_BYTES - source.byteLength * 2;
  let remaining = remainingForOrphans;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(MAX_AUDIO_ASSET_BYTES, remaining);
    const name = index === 0 ? `.${source.id}.audio.${createStorageId("tmp")}` : `orphan_${index}.audio`;
    index += 1;
    const handle = await fs.open(path.join(h.directory, name), "wx");
    await handle.truncate(size); await handle.close();
    remaining -= size;
  }
  const results = await Promise.allSettled([h.save("vocals"), h.save("drums")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason), /1 GiB/);
  assert.deepEqual(await h.save(), source);
  await assert.rejects(h.save("residual"), /1 GiB/);
});

test("a zero-byte recognized atomic audio remnant permits a new asset save", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  const remnant = path.join(h.directory, `.${source.id}.audio.${createStorageId("tmp")}`);
  await fs.writeFile(remnant, new Uint8Array(), { flag: "wx", mode: 0o600 });

  const output = await h.save("vocals");
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, output), waveBytes());
  assert.equal((await fs.stat(remnant)).size, 0);
});

test("a zero-byte committed audio blob still rejects reads and new asset saves", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  await fs.truncate(path.join(h.directory, `${source.id}.audio`), 0);

  await assert.rejects(h.save("vocals"), AudioStorageError);
  await assert.rejects(readAudioAsset(h.storage, h.session.id, source.id), AudioStorageError);
  await assert.rejects(listAudioAssets(h.storage, h.session.id), AudioStorageError);
});

test("atomic audio remnant names and symlinks retain the storage safety checks", async (t) => {
  const h = await audioStorageHarness(t);
  const source = await h.save();
  for (const name of [`.${source.id}.audio.tmp_`, `.${source.id}.audio.tmp_invalid.name`, "unsafe name.audio"]) {
    const target = path.join(h.directory, name);
    await fs.writeFile(target, new Uint8Array());
    await assert.rejects(h.save("vocals"), AudioStorageError);
    await fs.unlink(target);
  }
  const target = path.join(h.directory, `.${source.id}.audio.${createStorageId("tmp")}`);
  await fs.symlink(path.join(h.directory, `${source.id}.audio`), target);
  await assert.rejects(h.save("vocals"), AudioStorageError);
});

test("audio assets and attachments preserve 15-minute originals while explicit read budgets still apply", async (t) => {
  const h = await audioStorageHarness(t);
  const long = waveBytes(900);
  const asset = await h.save("source", long);
  assert.equal(asset.durationSeconds, 900);
  assert.equal(isAudioAttachmentInspection(asset), true);
  assert.equal(isAudioAttachmentInspection(asset, audioAssetInspectionLimits), true);
  assert.equal((await inspectAudioAttachment({ bytes: long })).durationSeconds, 900);
  await assert.rejects(h.save("vocals", waveBytes(901)), /900 seconds/);
  await assert.rejects(h.save("vocals", new Uint8Array([1, 2, 3])), /valid supported audio/);
  const renderPath = path.join(h.storage, "render.wav");
  await fs.writeFile(renderPath, new Uint8Array(24 * 1024 * 1024));
  assert.equal((await copyAudioFileSafely(renderPath, h.signal)).length, 24 * 1024 * 1024);
  assert.equal((await copyAudioFileSafely(renderPath, h.signal, MAX_AUDIO_ASSET_BYTES)).length, 24 * 1024 * 1024);
  await assert.rejects(copyAudioFileSafely(renderPath, h.signal, 20 * 1024 * 1024), /20 MiB/);
  await assert.rejects(inspectAudioAttachment({ bytes: waveBytes(), limits: { maxBytes: 10, maxDurationSeconds: 900 } }), /may not exceed/);
  await assert.rejects(inspectAudioAttachment({ bytes: waveBytes(), limits: { maxBytes: Infinity, maxDurationSeconds: 900 } }), /limits are invalid/);
});

test("asset saves admit exactly 128 MiB of verified WAV and reject one extra byte", async (t) => {
  const h = await audioStorageHarness(t);
  const bytes = Buffer.from(waveBytes(1, MAX_AUDIO_ASSET_BYTES - 44));
  bytes.writeUInt32LE(192000, 24);
  bytes.writeUInt32LE(192000, 28);
  const asset = await h.save("source", bytes);
  assert.equal(asset.byteLength, MAX_AUDIO_ASSET_BYTES);
  assert.equal((await fs.stat(path.join(h.directory, `${asset.id}.audio`))).size, MAX_AUDIO_ASSET_BYTES);
  await assert.rejects(h.save("vocals", new Uint8Array(MAX_AUDIO_ASSET_BYTES + 1)), /128 MiB/);
});

test("cancellation before persistence cannot create an asset; pre-aborted reads cannot return bytes", async (t) => {
  const h = await audioStorageHarness(t);
  let release!: () => void;
  const blocking = withStorageTransaction(h.storage, () => new Promise<void>((resolve) => { release = resolve; }));
  const controller = createHostAbortController();
  const saving = saveAudioAsset(h.storage, h.session.id, {
    jobId: h.job.id, role: "source", label: "source", bytes: waveBytes(), origin: { kind: "attachment" }, signal: controller.signal,
  });
  controller.abort(new Error("cancel audio storage"));
  await assert.rejects(saving, /cancel audio storage/);
  release(); await blocking;
  assert.deepEqual(await listAudioAssets(h.storage, h.session.id), []);
  const asset = await h.save();
  await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id, controller.signal), /cancel audio storage/);
});

test("startup directory listing finds orphan Sessions; durable Session cleanup preserves peers and Live-owned files", async (t) => {
  const h = await audioStorageHarness(t);
  await h.save();
  const other = await createSession(h.storage, sessionInput);
  const peer = path.join(h.storage, "live-smith-audio", other.id);
  await fs.mkdir(peer);
  const liveCopy = path.join(h.storage, "live-owned.wav");
  await fs.writeFile(liveCopy, waveBytes());
  await deleteSession(h.storage, h.session.id);
  assert.deepEqual(await listSessionAudioDirectoryIds(h.storage), [h.session.id, other.id].sort());
  await deleteSessionAudio(h.storage, h.session.id);
  await deleteSessionAudio(h.storage, h.session.id);
  assert.deepEqual(await listSessionAudioDirectoryIds(h.storage), [other.id]);
  assert.deepEqual(await fs.readFile(liveCopy), Buffer.from(waveBytes()));
  await assert.rejects(deleteSessionAudio(h.storage, "../outside"), /invalid/);
});

test("generated WAV and MP3 assets retain deterministic IDs, hashes and immutable recovery before job metadata commits", async (t) => {
  for (const { input, roles } of generationJobCases) {
    const h = await audioStorageHarness(t, input);
    for (const role of roles) {
      const bytes = role === "sound_effect" ? waveBytes() : mp3Bytes();
      const [asset, retry] = await Promise.all([h.save(role, bytes), h.save(role, bytes)]);
      const expectedId = `asset_${createHash("sha256").update(`${h.job.id}\0${role}`).digest("hex")}`;
      assert.equal(asset!.id, expectedId);
      assert.equal(asset!.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(asset!.origin, { kind: "generated" });
      assert.deepEqual(retry, asset);
      assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets, []);
      const metadata = path.join(h.directory, `${asset!.id}.asset.json`);
      const blob = path.join(h.directory, `${asset!.id}.audio`);
      const before = await fs.stat(blob);
      await fs.unlink(metadata);
      await assert.rejects(h.save(role, role === "sound_effect" ? mp3Bytes() : waveBytes()), AudioStorageError);
      assert.deepEqual(await h.save(role, bytes), asset);
      assert.equal((await fs.stat(blob)).ino, before.ino);
      assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, asset!), bytes);
      const peer = await createSession(h.storage, sessionInput);
      await assert.rejects(readAudioAsset(h.storage, peer.id, asset!.id), AudioStorageError);
      await assert.rejects(readExpectedAudioAsset(h.storage, peer.id, asset!), AudioStorageError);
      await fs.writeFile(blob, new Uint8Array(bytes.length));
      await assert.rejects(readAudioAsset(h.storage, h.session.id, asset!.id), AudioStorageError);
      await fs.writeFile(blob, bytes);
    }
    const assets = await listAudioAssets(h.storage, h.session.id, h.job.id);
    assert.deepEqual(assets.map((asset) => asset.role).sort(), [...roles].sort());
    await updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: assets });
    assert.deepEqual((await loadAudioJob(h.storage, h.session.id, h.job.id)).outputAssets, assets);
  }
});

test("every asset boundary rejects roles owned by another operation or provider, including unpublished output records", async (t) => {
  const allRoles: AudioAsset["role"][] = [...SEPARATION_STEMS, "source", "residual", "music", "music_alternative", "sound_effect"];
  for (const { input, roles } of [
    { input: separationJobInput, roles: ["source", "vocals", "drums", "residual"] as AudioAsset["role"][] },
    ...generationJobCases,
  ]) {
    const h = await audioStorageHarness(t, input);
    const original = await h.save(roles[0]!);
    const jobPath = path.join(h.directory, `${h.job.id}.job.json`);
    for (const role of allRoles.filter((role) => !roles.includes(role))) {
      const origin = { kind: ["music", "music_alternative", "sound_effect"].includes(role) ? "generated" : "attachment" } as const;
      const asset: AudioAsset = { ...original, role, origin, id: audioAssetId(h.job.id, role) };
      const existingNames = await fs.readdir(h.directory);
      await assert.rejects(saveAudioAsset(h.storage, h.session.id, {
        jobId: h.job.id, role, label: role, bytes: waveBytes(), origin, signal: h.signal,
      }), AudioStorageError);
      assert.deepEqual(await fs.readdir(h.directory), existingNames);
      const metadata = path.join(h.directory, `${asset.id}.asset.json`);
      const blob = path.join(h.directory, `${asset.id}.audio`);
      await overwriteJson(metadata, asset);
      await fs.writeFile(blob, waveBytes());
      await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
      await assert.rejects(readExpectedAudioAsset(h.storage, h.session.id, asset), AudioStorageError);
      await assert.rejects(listAudioAssets(h.storage, h.session.id, h.job.id), AudioStorageError);
      await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [asset] }), AudioStorageError);
      await overwriteJson(jobPath, { ...h.job, outputAssets: [asset] });
      await assert.rejects(loadAudioJob(h.storage, h.session.id, h.job.id), AudioStorageError);
      await overwriteJson(jobPath, h.job);
      await fs.unlink(metadata);
      await fs.unlink(blob);
    }
    assert.deepEqual(await listAudioAssets(h.storage, h.session.id), [original]);
  }
});

test("generated roles require a generated origin without self-reference, timing, or unknown metadata", async (t) => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const asset = await h.save("music");
  const target = path.join(h.directory, `${asset.id}.asset.json`);
  for (const origin of [
    { kind: "attachment" }, { kind: "arrangement" }, { kind: "asset", sourceAssetId: asset.id },
    { kind: "generated", startBeat: 0 }, { kind: "generated", endBeat: 4 },
    { kind: "generated", tempo: 120 }, { kind: "generated", sourceAssetId: asset.id },
    { kind: "generated", apiKey: "not-a-real-key" }, { kind: "other" }, null, [],
  ]) {
    await assert.rejects(saveAudioAsset(h.storage, h.session.id, {
      jobId: h.job.id, role: "music", label: "music", bytes: waveBytes(), origin, signal: h.signal,
    } as never), AudioStorageError);
    const invalid = { ...asset, origin };
    await overwriteJson(target, invalid);
    await assert.rejects(readAudioAsset(h.storage, h.session.id, asset.id), AudioStorageError);
    await assert.rejects(listAudioAssets(h.storage, h.session.id), AudioStorageError);
    await assert.rejects(updateAudioJob(h.storage, h.session.id, h.job.id, { outputAssets: [invalid] } as never), AudioStorageError);
    await overwriteJson(target, asset);
  }
  const separation = await audioStorageHarness(t);
  for (const role of ["source", "vocals", "residual"] as const) {
    await assert.rejects(saveAudioAsset(separation.storage, separation.session.id, {
      jobId: separation.job.id, role, label: role, bytes: waveBytes(), origin: { kind: "generated" }, signal: separation.signal,
    }), AudioStorageError);
  }
});

test("a generated same-Session asset can become a separation source through asset provenance", async (t) => {
  const h = await audioStorageHarness(t, generationJobCases[0]!.input);
  const generated = await h.save("music");
  const separation = await createAudioJob(h.storage, h.session.id, separationJobInput);
  const source = await saveAudioAsset(h.storage, h.session.id, {
    jobId: separation.id, role: "source", label: "Generated input", bytes: waveBytes(),
    origin: { kind: "asset", sourceAssetId: generated.id }, signal: h.signal,
  });
  const output = await saveAudioAsset(h.storage, h.session.id, {
    jobId: separation.id, role: "vocals", label: "vocals", bytes: waveBytes(),
    origin: { kind: "asset", sourceAssetId: source.id }, signal: h.signal,
  });
  await updateAudioJob(h.storage, h.session.id, separation.id, { sourceAssetId: source.id, outputAssets: [output] });
  assert.deepEqual(await readExpectedAudioAsset(h.storage, h.session.id, output), waveBytes());
  assert.deepEqual((await loadAudioJob(h.storage, h.session.id, separation.id)).outputAssets, [output]);
  const other = await createSession(h.storage, sessionInput);
  const foreign = await createAudioJob(h.storage, other.id, separationJobInput);
  await assert.rejects(saveAudioAsset(h.storage, other.id, {
    jobId: foreign.id, role: "source", label: "Foreign input", bytes: waveBytes(),
    origin: { kind: "asset", sourceAssetId: generated.id }, signal: h.signal,
  }), AudioStorageError);
});
