import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual, types } from "node:util";

import { inspectAudioAttachment } from "../attachments/audio.js";
import {
  MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_SESSION_BYTES, SEPARATION_STEMS, type AudioAsset, type AudioJob, type AudioOrigin,
} from "../audio-services/contracts.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  removeDirectoryDurably, withStorageTransaction,
  writeBytesAtomicallyCreateOnly, writeJsonAtomicallyCreateOnly,
} from "./persistence.js";
import {
  AudioStorageError, MAX_AUDIO_ASSET_METADATA_BYTES, assertAudioDirectory,
  assertAudioJsonSize, audioAssetId, audioAssetInspectionLimits,
  audioDirectoryEntries, audioJobOwnsAssetRole, audioRecordHasOnly, bindAudioDirectory, isAudioAsset,
  listAudioJobs, loadAudioJob, readAudioAssetRecord, readBoundedAudioFile,
  requireAudioSession, requireAudioStorage, type AudioDirectoryBinding,
} from "./audio-jobs.js";

export async function saveAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  input: { jobId: string; label: string; role: AudioAsset["role"]; bytes: Uint8Array; origin: AudioOrigin; signal: AbortSignal },
): Promise<AudioAsset> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(input.jobId, "Audio job ID");
  throwIfAborted(input.signal);
  if (!audioRecordHasOnly(input, ["jobId", "label", "role", "bytes", "origin", "signal"]) ||
    !types.isUint8Array(input.bytes) || input.bytes.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new AudioStorageError("Audio assets must be valid audio of at most 128 MiB.");
  }
  const bytes = new Uint8Array(input.bytes);
  const origin = cloneJsonValue(input.origin);
  const { jobId, role, label, signal } = input;
  const inspection = await inspectAudioAttachment({ bytes, signal, limits: audioAssetInspectionLimits });
  const asset: AudioAsset = {
    id: audioAssetId(jobId, role), sessionId, jobId, role, label, origin,
    byteLength: bytes.byteLength, sha256: hashBytes(bytes), ...inspection,
  };
  if (!isAudioAsset(asset)) throw new AudioStorageError("Audio asset metadata is invalid.");
  assertAudioJsonSize(asset, MAX_AUDIO_ASSET_METADATA_BYTES);
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(signal);
    await requireAudioSession(storageDirectory, sessionId, transaction);
    const job = await loadAudioJob(storageDirectory, sessionId, jobId);
    if (!audioJobOwnsAssetRole(job, role)) throw new AudioStorageError("The audio output is not part of this job.");
    const directory = (await bindAudioDirectory(storageDirectory, sessionId))!;
    if (origin.sourceAssetId !== undefined &&
      !(await readAudioAssetRecord(directory, sessionId, origin.sourceAssetId))) throw new AudioStorageError();
    const existing = await readAudioAssetRecord(directory, sessionId, asset.id);
    if (existing && !isDeepStrictEqual(existing, asset)) throw new AudioStorageError("The saved audio asset differs from this retry.");
    const blobExists = await hasAudioBlob(directory, asset);
    if (blobExists) await readVerifiedBytes(directory, asset, signal);
    if (existing && blobExists) return existing;
    const usedBytes = await storedAudioBytes(directory);
    if (usedBytes + (blobExists ? 0 : asset.byteLength) > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("This Session has reached its 1 GiB audio storage limit.");
    }
    throwIfAborted(signal);
    await assertAudioDirectory(directory);
    // Commit the immutable recovery receipt first. A crash after the blob commit
    // can then recover without a provider response or another paid request.
    // A receipt without its complete blob is never listed as an available asset.
    if (!existing) await writeJsonAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.asset.json`), asset);
    await assertAudioDirectory(directory);
    if (!blobExists) await writeBytesAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.audio`), bytes);
    await assertAudioDirectory(directory);
    return asset;
  });
}

/**
 * Called while the app owns the complete same-Session send/command fence. The
 * checked budget therefore cannot be consumed by another supported Session
 * operation before this request saves its results. File writes recheck quota.
 */
export async function assertAudioOutputCapacity(
  storageDirectory: string | undefined, sessionId: string, outputCount: number,
): Promise<void> {
  requireAudioStorage(storageDirectory, sessionId);
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 7) throw new AudioStorageError("Invalid audio output capacity request.");
  await withStorageTransaction(storageDirectory, async () => {
    await requireAudioSession(storageDirectory, sessionId);
    const directory = await bindAudioDirectory(storageDirectory, sessionId);
    const used = directory ? await storedAudioBytes(directory) : 0;
    if (used + outputCount * MAX_AUDIO_ASSET_BYTES > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("Insufficient audio output capacity within this Session's 1 GiB storage limit. No paid request was submitted.");
    }
  });
}

export async function readAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<{ asset: AudioAsset; bytes: Uint8Array }> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(assetId, "Audio asset ID");
  throwIfAborted(signal);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  const asset = directory && await readAudioAssetRecord(directory, sessionId, assetId);
  if (!asset || !directory) throw new AudioStorageError("The audio asset does not exist in this Session.");
  const job = await loadAudioJob(storageDirectory, sessionId, asset.jobId);
  if (!audioJobOwnsAssetRole(job, asset.role)) throw new AudioStorageError();
  const bytes = await readVerifiedBytes(directory, asset, signal);
  const afterRead = await readAudioAssetRecord(directory, sessionId, assetId);
  if (!isDeepStrictEqual(afterRead, asset)) throw new AudioStorageError();
  return { asset, bytes };
}

export async function readExpectedAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  expectedAsset: AudioAsset,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!isAudioAsset(expectedAsset) || expectedAsset.sessionId !== sessionId) throw new AudioStorageError();
  const expected = cloneJsonValue(expectedAsset);
  const result = await readAudioAsset(storageDirectory, sessionId, expected.id, signal);
  if (!isDeepStrictEqual(result.asset, expected)) throw new AudioStorageError("The audio source changed since it was selected.");
  return result.bytes;
}

export async function listAudioAssets(
  storageDirectory: string | undefined,
  sessionId: string,
  jobId?: string,
): Promise<AudioAsset[]> {
  requireAudioStorage(storageDirectory, sessionId);
  if (jobId !== undefined) requireSafeStorageId(jobId, "Audio job ID");
  const jobs = jobId === undefined ? await listAudioJobs(storageDirectory, sessionId)
    : [await loadAudioJob(storageDirectory, sessionId, jobId)];
  return listAssetsForJobs(storageDirectory, sessionId, jobs, jobId !== undefined);
}

/** One verified snapshot for callers that need both jobs and recoverable assets. */
export async function readAudioSessionState(
  storageDirectory: string, sessionId: string,
): Promise<{ jobs: AudioJob[]; assets: AudioAsset[] }> {
  const jobs = await listAudioJobs(storageDirectory, sessionId);
  return { jobs, assets: await listAssetsForJobs(storageDirectory, sessionId, jobs) };
}

async function listAssetsForJobs(
  storageDirectory: string, sessionId: string, jobs: readonly AudioJob[], oneJob = false,
): Promise<AudioAsset[]> {
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const byJobId = new Map(jobs.map((job) => [job.id, job]));
  const committed = new Map(jobs.flatMap((job) => job.outputAssets).map((asset) => [asset.id, asset]));
  const target = oneJob ? jobs[0]! : undefined;
  const wanted = target ? new Set(["source", "residual", ...SEPARATION_STEMS, "music", "music_alternative", "sound_effect"]
    .map((role) => audioAssetId(target.id, role as AudioAsset["role"]))) : undefined;
  const assets: AudioAsset[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".asset.json")) continue;
    const id = name.slice(0, -11);
    if (wanted && !wanted.has(id)) continue;
    // Job loading already verified committed metadata against the job snapshot.
    const asset = committed.get(id) ?? await readAudioAssetRecord(directory, sessionId, id);
    const job = asset && byJobId.get(asset.jobId);
    if (!asset || !job || !audioJobOwnsAssetRole(job, asset.role)) throw new AudioStorageError();
    if (await hasAudioBlob(directory, asset)) assets.push(asset);
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id));
}

async function hasAudioBlob(directory: AudioDirectoryBinding, asset: AudioAsset): Promise<boolean> {
  let info;
  try { info = await fs.lstat(path.join(directory.directory, `${asset.id}.audio`)); }
  catch (error) { if (isMissingFileError(error)) return false; throw new AudioStorageError(); }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byteLength) throw new AudioStorageError();
  await assertAudioDirectory(directory);
  return true;
}

export async function deleteSessionAudio(storageDirectory: string | undefined, sessionId: string): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (storageDirectory === undefined) return;
  requireAudioStorage(storageDirectory, sessionId);
  await withStorageTransaction(storageDirectory, async () => {
    const directory = await bindAudioDirectory(storageDirectory, sessionId);
    if (!directory) return;
    await assertAudioDirectory(directory);
    await removeDirectoryDurably(directory.directory);
  });
}

export async function listSessionAudioDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (storageDirectory === undefined) return [];
  requireAudioStorage(storageDirectory, "startup");
  const root = path.join(storageDirectory, "live-smith-audio");
  let before;
  try { before = await fs.lstat(root); } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new AudioStorageError();
  }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new AudioStorageError();
  const ids: string[] = [];
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeStorageId(entry.name)) throw new AudioStorageError();
    ids.push(entry.name);
  }
  const after = await fs.lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new AudioStorageError();
  return ids.sort();
}

async function readVerifiedBytes(directory: AudioDirectoryBinding, asset: AudioAsset, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await readBoundedAudioFile(directory, `${asset.id}.audio`, asset.byteLength, signal);
  if (bytes.byteLength !== asset.byteLength || hashBytes(bytes) !== asset.sha256) throw new AudioStorageError();
  const inspection = await inspectAudioAttachment({ bytes, limits: audioAssetInspectionLimits, ...(signal ? { signal } : {}) });
  if (inspection.mediaType !== asset.mediaType || inspection.durationSeconds !== asset.durationSeconds ||
    inspection.sampleRate !== asset.sampleRate || inspection.channels !== asset.channels) throw new AudioStorageError();
  return bytes;
}

async function storedAudioBytes(directory: AudioDirectoryBinding): Promise<number> {
  let bytes = 0;
  for (const name of await audioDirectoryEntries(directory)) {
    // Include interrupted atomic blob writes, as well as metadata-less blobs.
    const temporaryId = /^\.asset_[a-f0-9]{64}\.audio\.(tmp_.*)$/s.exec(name)?.[1];
    const isTemporary = temporaryId !== undefined;
    if (!name.endsWith(".audio") && !isTemporary) continue;
    if (isTemporary
      ? !isSafeStorageId(temporaryId) || temporaryId.length <= 4
      : !isSafeStorageId(name.slice(0, -6))) throw new AudioStorageError();
    const info = await fs.lstat(path.join(directory.directory, name));
    // A crash after opening the atomic temporary file can leave it empty.
    // Committed blobs must still contain audio, including metadata-less blobs.
    if (!info.isFile() || info.isSymbolicLink() ||
      info.size < (isTemporary ? 0 : 1) || info.size > MAX_AUDIO_ASSET_BYTES) throw new AudioStorageError();
    bytes += info.size;
  }
  await assertAudioDirectory(directory);
  return bytes;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
