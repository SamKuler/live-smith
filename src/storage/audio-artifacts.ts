import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual, types } from "node:util";

import { allocateArtifactVersion, isArtifactLabel, isArtifactRef, isArtifactVersion, type ArtifactPluginSource, type ArtifactRef, type ArtifactVersion } from "../agent/artifact-contracts.js";
import { inspectAudioAttachment, isAudioAttachmentInspection, type AudioAttachmentInspection } from "../attachments/audio.js";
import { MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_SESSION_BYTES, type AudioAsset } from "../audio-services/contracts.js";
import { audioArtifactOutputDescriptor, audioOutputsCanShareWork } from "../audio-services/audio-output.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { isSafePluginId } from "../plugins/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { listAudioAssetRecords, readAudioAsset, audioAssetExport, audioAssetWaveform } from "./audio-assets.js";
import { audioArtifactFileName, readStoredWaveform, openVerifiedStoredStream, type SessionFileExport } from "./file-export.js";
import {
  AudioStorageError, assertAudioJsonSize, audioAssetInspectionLimits, audioDirectoryEntries,
  audioRecordHasOnly, boundedAudioText, isAudioHash, listAudioJobs, readAudioJson,
  readBoundedAudioFile, requireAudioSession, requireAudioStorage, type AudioDirectoryBinding,
} from "./audio-jobs.js";
import { storedSessionAudioBytes } from "./audio-storage-budget.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import { readMidiArtifact } from "./midi-artifacts.js";
import { readDeviceParameterArtifact } from "./device-parameter-artifacts.js";
import { withStorageTransaction } from "./persistence.js";
import { listStoredChildren, storedEntry, storedTreeExists, removeStoredEntry, removeStoredTree, writeStoredBytes, writeStoredJson } from "./sqlite.js";

const ROOT = "live-smith-audio-artifacts";
const MAX_METADATA_BYTES = 4096;
export const MAX_PLUGIN_AUDIO_ARTIFACTS_PER_SESSION = 64;

export type PluginAudioArtifact = ArtifactPluginSource & AudioAttachmentInspection & {
  id: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  label: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  version: ArtifactVersion;
  sourceArtifact?: ArtifactRef;
};
export class AudioArtifactNotFoundError extends AudioStorageError {
  constructor() { super("Audio result is unavailable in this Session."); this.name = "AudioArtifactNotFoundError"; }
}
export type SessionAudioArtifact = AudioAsset | PluginAudioArtifact;

export async function savePluginAudioArtifact(
  storageDirectory: string | undefined, sessionId: string,
  input: ArtifactPluginSource & {
    serverId: string; toolName: string; label: string; bytes: Uint8Array;
    format: "wav" | "mp3"; revisionOf?: ArtifactRef; signal: AbortSignal;
  },
): Promise<PluginAudioArtifact> {
  requireAudioStorage(storageDirectory, sessionId);
  if (!validOwner(input) || !boundedAudioText(input.serverId, 128) || !boundedAudioText(input.toolName, 128) ||
      !isArtifactLabel(input.label) || !types.isUint8Array(input.bytes) || input.bytes.byteLength > MAX_AUDIO_ASSET_BYTES ||
      !["wav", "mp3"].includes(input.format) || input.revisionOf !== undefined && !isArtifactRef(input.revisionOf)) throw new AudioStorageError();
  const bytes = new Uint8Array(input.bytes);
  const sourceArtifact = input.revisionOf && { ...input.revisionOf };
  const inspection = await inspectAudioAttachment({ bytes, signal: input.signal, limits: audioAssetInspectionLimits });
  if (inspection.mediaType !== (input.format === "mp3" ? "audio/mpeg" : "audio/wav")) {
    throw new AudioStorageError("Plugin audio output does not match its declared format.");
  }
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(input.signal);
    await requireAudioSession(storageDirectory, sessionId, transaction);
    if (sourceArtifact?.kind === "midi") await readMidiArtifact(storageDirectory, sessionId, sourceArtifact.id, input.signal);
    if (sourceArtifact?.kind === "device-parameters") await readDeviceParameterArtifact(storageDirectory, sessionId, sourceArtifact.id);
    const audioParent = sourceArtifact?.kind === "audio"
      ? (await readSessionAudioArtifact(storageDirectory, sessionId, sourceArtifact.id, input.signal)).asset : undefined;
    const directory = (await bindDirectory(storageDirectory, sessionId, true))!;
    const records = await listPluginAudioArtifactRecords(storageDirectory, sessionId);
    if (records.length >= MAX_PLUGIN_AUDIO_ARTIFACTS_PER_SESSION ||
        await storedSessionAudioBytes(storageDirectory, sessionId) + bytes.byteLength > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("This Session has reached its audio artifact storage limit.");
    }
    const id = createStorageId("audio_artifact");
    const version = allocateArtifactVersion(id, [...await listAudioAssetRecords(storageDirectory, sessionId), ...records],
      audioParent && audioOutputsCanShareWork({ kind: "audio", label: input.label }, audioArtifactOutputDescriptor(audioParent))
        ? { revisionOf: audioParent.id } : {});
    const artifact: PluginAudioArtifact = {
      ...(input.pluginId === undefined ? { connectionId: input.connectionId } : { pluginId: input.pluginId }),
      id, sessionId, serverId: input.serverId, toolName: input.toolName, label: input.label,
      createdAt: new Date().toISOString(), byteLength: bytes.byteLength, sha256: hashBytes(bytes), ...inspection, version,
      ...(sourceArtifact ? { sourceArtifact } : {}),
    };
    assertAudioJsonSize(artifact, MAX_METADATA_BYTES);
    throwIfAborted(input.signal);
    await writeStoredBytes(storageDirectory, path.join(directory.directory, `${id}.audio`), bytes, { createOnly: true, storage: "file" });
    try { throwIfAborted(input.signal); }
    catch (error) {
      await removeStoredEntry(storageDirectory, path.join(directory.directory, `${id}.audio`)).catch(() => undefined);
      throw error;
    }
    await writeStoredJson(storageDirectory, path.join(directory.directory, `${id}.artifact.json`), artifact, { createOnly: true });
    return cloneJsonValue(artifact);
  });
}

/** Includes metadata with missing bytes so revision numbers cannot be reused. */
export async function listPluginAudioArtifactRecords(storageDirectory: string | undefined, sessionId: string): Promise<PluginAudioArtifact[]> {
  if (storageDirectory === undefined) return [];
  requireAudioStorage(storageDirectory, sessionId);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const artifacts: PluginAudioArtifact[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".artifact.json")) continue;
    const artifact = await readRecord(directory, sessionId, name.slice(0, -14));
    if (!artifact) throw new AudioStorageError();
    artifacts.push(artifact);
  }
  return artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function listPluginAudioArtifacts(storageDirectory: string | undefined, sessionId: string): Promise<PluginAudioArtifact[]> {
  const records = await listPluginAudioArtifactRecords(storageDirectory, sessionId);
  if (!storageDirectory || !records.length) return [];
  const directory = (await bindDirectory(storageDirectory, sessionId))!;
  const artifacts: PluginAudioArtifact[] = [];
  for (const record of records) {
    const info = await storedEntry(storageDirectory, path.join(directory.directory, `${record.id}.audio`));
    if (!info) continue;
    if (info.byteLength !== record.byteLength) throw new AudioStorageError();
    artifacts.push(record);
  }
  return artifacts;
}

export async function readPluginAudioArtifact(
  storageDirectory: string | undefined, sessionId: string, id: string, signal?: AbortSignal,
): Promise<{ artifact: PluginAudioArtifact; bytes: Uint8Array }> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(id, "Audio artifact ID");
  throwIfAborted(signal);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindDirectory(storageDirectory, sessionId);
  const artifact = directory && await readRecord(directory, sessionId, id);
  if (!directory || !artifact) throw new AudioArtifactNotFoundError();
  const bytes = await readBoundedAudioFile(directory, `${id}.audio`, artifact.byteLength, signal);
  if (bytes.byteLength !== artifact.byteLength || hashBytes(bytes) !== artifact.sha256) throw new AudioStorageError();
  const inspection = await inspectAudioAttachment({ bytes, limits: audioAssetInspectionLimits, ...(signal ? { signal } : {}) });
  if (inspection.mediaType !== artifact.mediaType || inspection.durationSeconds !== artifact.durationSeconds ||
      inspection.sampleRate !== artifact.sampleRate || inspection.channels !== artifact.channels ||
      !isDeepStrictEqual(await readRecord(directory, sessionId, id), artifact)) throw new AudioStorageError();
  return { artifact, bytes };
}

/** Public Session audio reads admit Plugin artifacts and committed job outputs. */
export async function readSessionAudioArtifact(
  storageDirectory: string | undefined, sessionId: string, id: string, signal?: AbortSignal,
): Promise<{ asset: SessionAudioArtifact; bytes: Uint8Array }> {
  if (id.startsWith("audio_artifact_")) {
    const { artifact, bytes } = await readPluginAudioArtifact(storageDirectory, sessionId, id, signal);
    return { asset: artifact, bytes };
  }
  const jobs = await listAudioJobs(storageDirectory, sessionId);
  const expected = jobs.flatMap((job) => job.outputAssets).find((asset) => asset.id === id);
  if (!expected) throw new AudioArtifactNotFoundError();
  const result = await readAudioAsset(storageDirectory, sessionId, id, signal);
  if (!isDeepStrictEqual(expected, result.asset)) throw new AudioStorageError("The audio source changed since it was selected.");
  throwIfAborted(signal);
  return result;
}

export async function sessionAudioArtifactExport(storageDirectory: string, sessionId: string, id: string, expectedArtifact?: SessionAudioArtifact): Promise<SessionFileExport> {
  requireAudioStorage(storageDirectory, sessionId); requireSafeStorageId(id, "Audio artifact ID");
  await requireAudioSession(storageDirectory, sessionId);
  if (!id.startsWith("audio_artifact_")) {
    const expected = (await listAudioJobs(storageDirectory, sessionId)).flatMap(job => job.outputAssets).find(asset => asset.id === id);
    if (!expected) throw new AudioArtifactNotFoundError();
    if (expectedArtifact && !isDeepStrictEqual(expected,expectedArtifact)) throw new AudioStorageError("The audio source changed since it was selected.");
    return audioAssetExport(storageDirectory, sessionId, expected);
  }
  const directory = await bindDirectory(storageDirectory, sessionId);
  const artifact = directory && await readRecord(directory, sessionId, id);
  if (!directory || !artifact) throw new AudioArtifactNotFoundError();
  if (expectedArtifact && !isDeepStrictEqual(artifact,expectedArtifact)) throw new AudioStorageError("The audio source changed since it was selected.");
  return { fileName: audioArtifactFileName(artifact), mediaType: artifact.mediaType, byteLength: artifact.byteLength,
    open: (signal, range) => openVerifiedStoredStream({ storageDirectory, ...(range ? { range } : {}), key: path.join(directory.directory, `${id}.audio`), byteLength: artifact.byteLength, sha256: artifact.sha256, signal,
      assertCurrent: async () => { if (!isDeepStrictEqual(await readRecord(directory, sessionId, id), artifact)) throw new AudioStorageError(); } }),
  };
}

export async function readSessionAudioArtifactWaveform(storageDirectory: string, sessionId: string, id: string, options: { signal?: AbortSignal } = {}) {
  requireAudioStorage(storageDirectory, sessionId); requireSafeStorageId(id, "Audio artifact ID");
  await requireAudioSession(storageDirectory, sessionId);
  if (!id.startsWith("audio_artifact_")) {
    const expected = (await listAudioJobs(storageDirectory, sessionId)).flatMap(job => job.outputAssets).find(asset => asset.id === id);
    if (!expected) throw new AudioArtifactNotFoundError();
    return audioAssetWaveform(storageDirectory, sessionId, expected, options.signal);
  }
  const directory = await bindDirectory(storageDirectory, sessionId);
  const artifact = directory && await readRecord(directory, sessionId, id);
  if (!directory || !artifact) throw new AudioArtifactNotFoundError();
  if (artifact.mediaType !== "audio/wav") return undefined;
  return readStoredWaveform({ storageDirectory, key: path.join(directory.directory, `${id}.audio`),
    byteLength: artifact.byteLength, sha256: artifact.sha256, ...(options.signal ? { signal: options.signal } : {}),
    assertCurrent: async () => { if (!isDeepStrictEqual(await readRecord(directory, sessionId, id), artifact)) throw new AudioStorageError(); },
  });
}

export async function openExpectedSessionAudioArtifact(
  storageDirectory: string | undefined, sessionId: string, expected: SessionAudioArtifact, signal: AbortSignal,
) {
  throwIfAborted(signal);
  requireAudioStorage(storageDirectory,sessionId);
  const snapshot = cloneJsonValue(expected);
  if (snapshot.sessionId !== sessionId) throw new AudioStorageError();
  const file = await sessionAudioArtifactExport(storageDirectory,sessionId,snapshot.id,snapshot);
  return file.open(signal);
}

export async function readExpectedSessionAudioArtifact(
  storageDirectory: string | undefined, sessionId: string, expected: SessionAudioArtifact, signal?: AbortSignal,
): Promise<Uint8Array> {
  const snapshot = cloneJsonValue(expected);
  if (snapshot.sessionId !== sessionId) throw new AudioStorageError();
  const result = await readSessionAudioArtifact(storageDirectory, sessionId, snapshot.id, signal);
  if (!isDeepStrictEqual(result.asset, snapshot)) throw new AudioStorageError("The audio source changed since it was selected.");
  return result.bytes;
}

/** Counts committed, orphaned and interrupted blobs inside the shared quota transaction. */
export async function storedAudioArtifactBytes(storageDirectory: string, sessionId: string): Promise<number> {
  const directory = await bindDirectory(storageDirectory, sessionId);
  if (!directory) return 0;
  let bytes = 0;
  for (const name of await audioDirectoryEntries(directory)) {
    const temporary = /^\.(audio_artifact_[A-Za-z0-9_-]+)\.audio\.(tmp_[A-Za-z0-9_-]+)$/u.test(name);
    if (!name.endsWith(".audio") && !temporary) continue;
    if (!temporary && !validId(name.slice(0, -6))) throw new AudioStorageError();
    const info = await storedEntry(directory.storageDirectory, path.join(directory.directory, name));
    if (!info || info.byteLength < (temporary ? 0 : 1) || info.byteLength > MAX_AUDIO_ASSET_BYTES) throw new AudioStorageError();
    bytes += info.byteLength;
  }
  return bytes;
}

export async function deleteSessionPluginAudioArtifacts(storageDirectory: string | undefined, sessionId: string): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (storageDirectory === undefined) return;
  await withStorageTransaction(storageDirectory, async () => {
    const directory = await bindDirectory(storageDirectory, sessionId);
    if (!directory) return;
    await removeStoredTree(storageDirectory, directory.directory);
  });
}

export async function listSessionPluginAudioDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (storageDirectory === undefined) return [];
  const ids = await listStoredChildren(storageDirectory, ROOT);
  if (ids.some(id => !isSafeStorageId(id))) throw new AudioStorageError();
  return ids;
}

async function bindDirectory(storageDirectory: string, sessionId: string, create = false): Promise<AudioDirectoryBinding | undefined> {
  requireAudioStorage(storageDirectory, sessionId);
  const directory = path.resolve(storageDirectory, ROOT, sessionId);
  if (!create && !await storedTreeExists(storageDirectory, directory)) return undefined;
  return { storageDirectory, directory };
}

async function readRecord(directory: AudioDirectoryBinding, sessionId: string, id: string): Promise<PluginAudioArtifact | undefined> {
  if (!validId(id)) throw new AudioStorageError();
  const value = await readAudioJson(directory, `${id}.artifact.json`, MAX_METADATA_BYTES);
  if (value === undefined) return undefined;
  if (!audioRecordHasOnly(value, ["id", "sessionId", "pluginId", "connectionId", "serverId", "toolName", "label", "createdAt",
    "byteLength", "sha256", "mediaType", "durationSeconds", "sampleRate", "channels", "version", "sourceArtifact"]) ||
      value.id !== id || value.sessionId !== sessionId || !validOwner(value) ||
      !boundedAudioText(value.serverId, 128) || !boundedAudioText(value.toolName, 128) || !isArtifactLabel(value.label) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > MAX_AUDIO_ASSET_BYTES ||
      !isAudioHash(value.sha256) || !isAudioAttachmentInspection(value, audioAssetInspectionLimits) || !isArtifactVersion(value.version, id) ||
      value.sourceArtifact !== undefined && !isArtifactRef(value.sourceArtifact)) throw new AudioStorageError();
  return value as unknown as PluginAudioArtifact;
}

function validId(id: string): boolean { return isSafeStorageId(id) && id.startsWith("audio_artifact_"); }
function validOwner(value: { pluginId?: unknown; connectionId?: unknown }): boolean {
  return value.pluginId === undefined ? isSafeStorageId(value.connectionId) : isSafePluginId(value.pluginId) && value.connectionId === undefined;
}
function hashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
