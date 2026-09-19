import { Buffer, isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  LEGACY_AUDIO_SERVICE_ID, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  MAX_AUDIO_JOB_OUTPUTS, MAX_AUDIO_SESSION_JOBS, SEPARATION_STEMS,
  MAX_AUDIO_JOB_TITLE_CHARACTERS,
  type AudioAsset, type AudioJob, type AudioOrigin, type SeparationStem,
} from "../audio-services/contracts.js";
import { isAudioServiceModelId } from "../audio-services/model-id.js";
import { isUiMessage } from "../i18n/ui-message.js";
import { isAudioAttachmentInspection } from "../attachments/audio.js";
import { copyAudioFileSafely } from "../live/audio-attachment-source.js";
import { safeRegularFileOpenFlags } from "../live/safe-file-read.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { builtInAudioToolIdentity } from "../plugins/builtins/index.js";
import { createHostAbortController, throwIfAborted, waitForPromiseWithSignal } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  ensurePrivateDirectoryDurably, withStorageTransaction,
  writeJsonAtomically, writeJsonAtomicallyCreateOnly,
  type StorageTransactionContext,
} from "./persistence.js";
import { listSessions, persistTransientSessionInTransaction } from "./sessions.js";

export const MAX_AUDIO_JOB_METADATA_BYTES = 32 * 1024;
export const MAX_AUDIO_ASSET_METADATA_BYTES = 4 * 1024;
export const audioAssetInspectionLimits = {
  maxBytes: MAX_AUDIO_ASSET_BYTES,
  maxDurationSeconds: MAX_AUDIO_ASSET_DURATION_SECONDS,
};
const jobStatuses: readonly AudioJob["status"][] = [
  "preparing", "submitting", "running", "collecting", "ready", "completed",
  "partial", "failed", "interrupted", "unknown", "cancelled",
];
const jobConfigurationFields = [
  "provider", "serviceId", "operation", "modelId", "title", "connectionFingerprint", "stems",
];
type JobConfiguration = Pick<AudioJob,
  "provider" | "serviceId" | "operation" | "modelId" | "title" | "connectionFingerprint" | "stems"
>;
const jobFields = [
  "id", "sessionId", "pluginId", "toolId", "toolVersion", ...jobConfigurationFields,
  "status", "createdAt", "updatedAt", "sourceAssetId", "remoteSourceId",
  "remoteTaskId", "expectedOutputRoles", "expectedOutputs", "remoteOutputs", "remoteTaskTerminal", "failedOutputKeys",
  "outputAssets", "message",
];
const updateFields = [
  "status", "sourceAssetId", "remoteSourceId", "remoteTaskId", "expectedOutputRoles", "expectedOutputs", "remoteOutputs",
  "remoteTaskTerminal", "failedOutputKeys", "outputAssets", "message",
];
type JobUpdate = Partial<Pick<AudioJob,
  "status" | "sourceAssetId" | "remoteSourceId" | "remoteTaskId" | "expectedOutputRoles" | "expectedOutputs" | "remoteOutputs" |
  "remoteTaskTerminal" | "failedOutputKeys" | "outputAssets" | "message"
>>;
type InitialRetrievalReceipt = {
  remoteTaskId: string;
  expectedOutputs: NonNullable<AudioJob["expectedOutputs"]>;
};

export class AudioStorageError extends Error {
  constructor(message = "Saved audio data is invalid, unavailable, or changed.") {
    super(message);
    this.name = "AudioStorageError";
  }
}

export async function createAudioJob(
  storageDirectory: string | undefined,
  sessionId: string,
  input: JobConfiguration,
  initialReceipt?: InitialRetrievalReceipt,
): Promise<AudioJob> {
  requireAudioStorage(storageDirectory, sessionId);
  if (!audioRecordHasOnly(input, jobConfigurationFields) || !isJobConfiguration(input)) {
    throw new AudioStorageError("Audio job configuration is invalid.");
  }
  // Only explicit retrieval can start with existing remote identities. Paid
  // generation must still create its job before obtaining a submission receipt.
  if (input.operation === "retrieve_music"
    ? !audioRecordHasOnly(initialReceipt, ["remoteTaskId", "expectedOutputs"]) || !validExpectedOutputs({ ...input, ...initialReceipt })
    : initialReceipt !== undefined) throw new AudioStorageError("Audio job initial retrieval receipt is invalid.");
  const config = cloneJsonValue({ ...input, ...initialReceipt });
  return withStorageTransaction(storageDirectory, async (transaction) => {
    await requireAudioSession(storageDirectory, sessionId, transaction);
    if ((await listAudioJobs(storageDirectory, sessionId)).length >= MAX_AUDIO_SESSION_JOBS) {
      throw new AudioStorageError("This Session has reached its 40 audio job limit.");
    }
    const directory = await bindAudioDirectory(storageDirectory, sessionId, true);
    const now = new Date().toISOString();
    const job: AudioJob = {
      ...config,
      ...builtInAudioToolIdentity(config.provider, config.operation),
      id: createStorageId("audiojob"), sessionId,
      status: config.operation === "retrieve_music" ? "running" : "preparing", createdAt: now, updatedAt: now,
      outputAssets: [],
    };
    assertAudioJsonSize(job, MAX_AUDIO_JOB_METADATA_BYTES);
    await assertAudioDirectory(directory!);
    await writeJsonAtomicallyCreateOnly(path.join(directory!.directory, `${job.id}.job.json`), job);
    await assertAudioDirectory(directory!);
    return job;
  });
}

export async function loadAudioJob(
  storageDirectory: string | undefined,
  sessionId: string,
  jobId: string,
): Promise<AudioJob> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(jobId, "Audio job ID");
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) throw new AudioStorageError("The audio job does not exist in this Session.");
  return readJob(directory, sessionId, jobId);
}

export async function listAudioJobs(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<AudioJob[]> {
  requireAudioStorage(storageDirectory, sessionId);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const names = (await audioDirectoryEntries(directory)).filter((name) => name.endsWith(".job.json"));
  if (names.length > MAX_AUDIO_SESSION_JOBS) throw new AudioStorageError();
  const jobs: AudioJob[] = [];
  for (const name of names) jobs.push(await readJob(directory, sessionId, name.slice(0, -9)));
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function updateAudioJob(
  storageDirectory: string | undefined,
  sessionId: string,
  jobId: string,
  update: JobUpdate,
): Promise<AudioJob> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(jobId, "Audio job ID");
  if (!audioRecordHasOnly(update, updateFields)) throw new AudioStorageError("Audio job update is invalid.");
  const patch = cloneJsonValue(update);
  return withStorageTransaction(storageDirectory, async (transaction) => {
    await requireAudioSession(storageDirectory, sessionId, transaction);
    const current = await loadAudioJob(storageDirectory, sessionId, jobId);
    const job = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // A first identity mapping replaces, rather than duplicates, the historical shape.
    if (patch.expectedOutputs && !Object.hasOwn(patch, "expectedOutputRoles")) delete job.expectedOutputRoles;
    if (!isAudioJob(job)) throw new AudioStorageError("Audio job update is invalid.");
    if (current.expectedOutputs && (current.remoteTaskId !== job.remoteTaskId ||
      !isDeepStrictEqual(current.expectedOutputs, job.expectedOutputs))) {
      throw new AudioStorageError("The confirmed audio output identities changed.");
    }
    if (current.expectedOutputRoles && !isDeepStrictEqual(current.expectedOutputRoles,
      job.expectedOutputs?.map((output) => output.role) ?? job.expectedOutputRoles)) {
      throw new AudioStorageError("The confirmed audio result shape changed.");
    }
    if (current.remoteTaskTerminal && job.remoteTaskTerminal !== current.remoteTaskTerminal ||
      current.failedOutputKeys && !isDeepStrictEqual(current.failedOutputKeys, job.failedOutputKeys)) {
      throw new AudioStorageError("The confirmed remote audio failure changed.");
    }
    assertAudioJsonSize(job, MAX_AUDIO_JOB_METADATA_BYTES);
    const directory = (await bindAudioDirectory(storageDirectory, sessionId))!;
    await verifyJobAssets(directory, job);
    await assertAudioDirectory(directory);
    await writeJsonAtomically(path.join(directory.directory, `${jobId}.job.json`), job);
    await assertAudioDirectory(directory);
    return job;
  });
}

async function readJob(directory: AudioDirectoryBinding, sessionId: string, jobId: string): Promise<AudioJob> {
  requireSafeStorageId(jobId, "Audio job ID");
  const saved = await readAudioJson(directory, `${jobId}.job.json`, MAX_AUDIO_JOB_METADATA_BYTES);
  // Only historical LALAL separation records predate service identity. Reading
  // projects their legacy owner without changing the persisted record.
  const serviceNormalized = audioRecordHasOnly(saved, jobFields) && saved.provider === "lalal" &&
    saved.operation === "separate_stems" && !Object.hasOwn(saved, "serviceId")
    ? { ...saved, serviceId: LEGACY_AUDIO_SERVICE_ID } : saved;
  const job = audioRecordHasOnly(serviceNormalized, jobFields) &&
      !Object.hasOwn(serviceNormalized, "pluginId") &&
      !Object.hasOwn(serviceNormalized, "toolId") &&
      !Object.hasOwn(serviceNormalized, "toolVersion") &&
      typeof serviceNormalized.provider === "string" &&
      typeof serviceNormalized.operation === "string"
    ? addLegacyPluginToolIdentity(serviceNormalized)
    : serviceNormalized;
  if (!isAudioJob(job) || job.id !== jobId || job.sessionId !== sessionId) throw new AudioStorageError();
  await verifyJobAssets(directory, job);
  return job;
}

function addLegacyPluginToolIdentity(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return {
      ...value,
      ...builtInAudioToolIdentity(
        value.provider as AudioJob["provider"],
        value.operation as AudioJob["operation"],
      ),
    };
  } catch {
    return value;
  }
}

async function verifyJobAssets(directory: AudioDirectoryBinding, job: AudioJob): Promise<void> {
  if (job.sourceAssetId !== undefined) {
    const source = await readAudioAssetRecord(directory, job.sessionId, job.sourceAssetId);
    if (!source || source.jobId !== job.id || source.role !== "source") throw new AudioStorageError();
  }
  for (const expected of job.outputAssets) {
    const actual = await readAudioAssetRecord(directory, job.sessionId, expected.id);
    if (!actual || actual.jobId !== job.id || !isDeepStrictEqual(actual, expected)) throw new AudioStorageError();
  }
}

function isAudioJob(value: unknown): value is AudioJob {
  if (!audioRecordHasOnly(value, jobFields) || !isJobConfiguration(value)) return false;
  return isSafeStorageId(value.id) && isSafeStorageId(value.sessionId) &&
    validPluginToolIdentity(value) &&
    jobStatuses.includes(value.status as AudioJob["status"]) &&
    validDate(value.createdAt) && validDate(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    (!Object.hasOwn(value, "sourceAssetId") ||
      (value.operation === "separate_stems" && isSafeStorageId(value.sourceAssetId))) &&
    (!Object.hasOwn(value, "remoteSourceId") ||
      (value.operation === "separate_stems" && validProviderIdentifier(value.remoteSourceId))) &&
    (!Object.hasOwn(value, "remoteTaskId") || validProviderIdentifier(value.remoteTaskId)) &&
    (!Object.hasOwn(value, "expectedOutputRoles") ||
      (!Object.hasOwn(value, "expectedOutputs") && validExpectedOutputRoles(value, value.expectedOutputRoles))) &&
    (!Object.hasOwn(value, "expectedOutputs") || validExpectedOutputs(value)) &&
    (!Object.hasOwn(value, "remoteOutputs") || validRemoteOutputs(value)) &&
    (!Object.hasOwn(value, "remoteTaskTerminal") || ["failed", "cancelled"].includes(value.remoteTaskTerminal as string) &&
      validProviderIdentifier(value.remoteTaskId)) &&
    (!Object.hasOwn(value, "failedOutputKeys") || validFailedOutputKeys(value)) &&
    (value.status !== "ready" || Array.isArray(value.remoteOutputs) && value.remoteOutputs.length > 0) &&
    (value.operation !== "retrieve_music" || Object.hasOwn(value, "expectedOutputs")) &&
    (!Object.hasOwn(value, "message") || (typeof value.message === "string"
      ? boundedAudioText(value.message, 1024, true)
      : isUiMessage(value.message) && Buffer.byteLength(JSON.stringify(value.message), "utf8") <= 4096)) &&
    Array.isArray(value.outputAssets) && value.outputAssets.length <= MAX_AUDIO_JOB_OUTPUTS &&
    value.outputAssets.every((asset: unknown) => isAudioAsset(asset) &&
      asset.sessionId === value.sessionId && asset.jobId === value.id &&
      asset.role !== "source" && audioJobOwnsAssetRole(value, asset.role)) &&
    new Set(value.outputAssets.map((asset: AudioAsset) => asset.role)).size === value.outputAssets.length;
}

function validPluginToolIdentity(value: Record<string, unknown> & JobConfiguration): boolean {
  if (typeof value.pluginId !== "string" || typeof value.toolId !== "string" ||
      typeof value.toolVersion !== "string") return false;
  try {
    const expected = builtInAudioToolIdentity(value.provider, value.operation);
    return value.pluginId === expected.pluginId && value.toolId === expected.toolId &&
      value.toolVersion === expected.toolVersion;
  } catch {
    return false;
  }
}

function isJobConfiguration(value: Record<string, unknown>): value is Record<string, unknown> & JobConfiguration {
  // Persisted protocol semantics must outlive changes to advertised service
  // availability; a disabled provider's historical jobs remain readable.
  const validOperation = value.provider === "lalal" ? value.operation === "separate_stems"
    : value.provider === "elevenlabs" ? ["generate_music", "generate_sound_effect"].includes(value.operation as string)
    : value.provider === "google-lyria" ? value.operation === "generate_music"
    : value.provider === "mureka" ? value.operation === "generate_music"
    : value.provider === "suno-platform" ? value.operation === "generate_music"
    : value.provider === "suno" ? ["generate_music", "extend_music", "get_whole_song", "retrieve_music"].includes(value.operation as string)
    : value.provider === "sunoapi" && value.operation === "generate_music";
  return validOperation && isSafeStorageId(value.serviceId) && isAudioHash(value.connectionFingerprint) &&
    (!Object.hasOwn(value, "title") || typeof value.title === "string" && Boolean(value.title.trim()) &&
      Array.from(value.title).length <= MAX_AUDIO_JOB_TITLE_CHARACTERS &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value.title)) &&
    (!Object.hasOwn(value, "modelId") || isAudioServiceModelId(value.modelId)) &&
    (value.operation === "separate_stems" ? validStems(value.stems) : Array.isArray(value.stems) && value.stems.length === 0);
}

function validExpectedOutputRoles(job: JobConfiguration, roles: unknown): boolean {
  if (!Array.isArray(roles)) return false;
  if (job.operation === "generate_sound_effect") return roles.length === 1 && roles[0] === "sound_effect";
  return ["generate_music", "extend_music", "get_whole_song", "retrieve_music"].includes(job.operation) && roles[0] === "music" &&
    (roles.length === 1 || job.operation !== "get_whole_song" && ["sunoapi", "suno"].includes(job.provider) &&
      roles.length === 2 && roles[1] === "music_alternative");
}

function validExpectedOutputs(job: Record<string, unknown> & JobConfiguration): boolean {
  const outputs = job.expectedOutputs;
  return validProviderIdentifier(job.remoteTaskId) && Array.isArray(outputs) &&
    outputs.every((output: unknown) => audioRecordHasOnly(output, ["key", "role"]) &&
      typeof output.key === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(output.key)) &&
    new Set(outputs.map((output) => output.key)).size === outputs.length &&
    validExpectedOutputRoles(job, outputs.map((output) => output.role)) &&
    (job.operation !== "retrieve_music" || outputs[0]!.key === job.remoteTaskId &&
      outputs.every((output, index) => output.key.length === 36 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(output.key) &&
        (index === 0 || output.key > outputs[index - 1]!.key)));
}

function validRemoteOutputs(job: Record<string, unknown> & JobConfiguration): boolean {
  const outputs = job.remoteOutputs;
  const expected = job.expectedOutputs;
  return job.provider === "suno" && validExpectedOutputs(job) && Array.isArray(expected) &&
    expected[0]?.key === job.remoteTaskId && expected.every((output, index) =>
      output.key.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(output.key) &&
      (index === 0 || output.key > expected[index - 1]!.key)) &&
    Array.isArray(outputs) && outputs.length <= expected.length &&
    outputs.every((output: unknown) => audioRecordHasOnly(output, ["key", "role"]) &&
      expected.some((entry) => entry.key === output.key && entry.role === output.role)) &&
    new Set(outputs.map((output) => output.key)).size === outputs.length;
}

function validFailedOutputKeys(job: Record<string, unknown> & JobConfiguration): boolean {
  const failed = job.failedOutputKeys;
  const expected = job.expectedOutputs;
  const successful = job.remoteOutputs;
  return Array.isArray(failed) && failed.length > 0 && Array.isArray(expected) &&
    failed.every((key: unknown) => typeof key === "string" && expected.some((output) => output.key === key)) &&
    new Set(failed).size === failed.length &&
    (!Array.isArray(successful) || failed.every((key) => !successful.some((output) => output.key === key)));
}

export function audioJobOwnsAssetRole(
  job: Pick<AudioJob, "provider" | "operation" | "stems"> & { expectedOutputRoles?: unknown; expectedOutputs?: unknown }, role: AudioAsset["role"],
): boolean {
  if (job.expectedOutputs !== undefined &&
    (!Array.isArray(job.expectedOutputs) || !job.expectedOutputs.some((output) => output.role === role))) return false;
  if (job.expectedOutputRoles !== undefined &&
    (!Array.isArray(job.expectedOutputRoles) || !job.expectedOutputRoles.includes(role))) return false;
  switch (job.operation) {
    case "separate_stems": return job.provider === "lalal" &&
      (role === "source" || role === "residual" || job.stems.some((stem) => stem === role));
    case "generate_music": return (["elevenlabs", "google-lyria", "mureka", "suno-platform"].includes(job.provider) && role === "music") ||
      (["sunoapi", "suno"].includes(job.provider) && (role === "music" || role === "music_alternative"));
    case "extend_music":
    case "retrieve_music": return job.provider === "suno" && (role === "music" || role === "music_alternative");
    case "get_whole_song": return job.provider === "suno" && role === "music";
    case "generate_sound_effect": return job.provider === "elevenlabs" && role === "sound_effect";
  }
}

function validStems(value: unknown): value is SeparationStem[] {
  return Array.isArray(value) && value.length > 0 && value.length <= SEPARATION_STEMS.length &&
    [...value].every((stem: unknown) => SEPARATION_STEMS.includes(stem as SeparationStem)) &&
    new Set(value).size === value.length;
}

function validProviderIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Shared private-file and metadata boundary consumed by audio-assets.ts.
export function requireAudioStorage(storageDirectory: string | undefined, sessionId: string): asserts storageDirectory is string {
  if (typeof storageDirectory !== "string" || !storageDirectory.trim()) {
    throw new AudioStorageError("Audio tools require persistent storage, which is unavailable.");
  }
  requireSafeStorageId(sessionId, "Session ID");
}

export async function requireAudioSession(
  storageDirectory: string, sessionId: string, transaction?: StorageTransactionContext,
): Promise<void> {
  if (!(await listSessions(storageDirectory)).some((session) => session.id === sessionId)) {
    throw new AudioStorageError("The owning Session does not exist.");
  }
  if (transaction) await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
}

export function audioRecordHasOnly(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key));
}

export function isAudioHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function boundedAudioText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function audioAssetId(jobId: string, role: AudioAsset["role"]): string {
  return `asset_${createHash("sha256").update(`${jobId}\0${role}`).digest("hex")}`;
}

export function isAudioOrigin(value: unknown): value is AudioOrigin {
  if (!audioRecordHasOnly(value, ["kind", "startBeat", "endBeat", "tempo", "sourceAssetId"]) ||
    !["attachment", "arrangement", "asset", "generated"].includes(value.kind as string)) return false;
  if (value.kind === "generated") return audioRecordHasOnly(value, ["kind"]);
  for (const field of ["startBeat", "endBeat", "tempo"] as const) {
    if (Object.hasOwn(value, field) &&
      (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0)) return false;
  }
  return (!Object.hasOwn(value, "tempo") || (value.tempo as number) > 0) &&
    (!(typeof value.startBeat === "number" && typeof value.endBeat === "number") || value.endBeat > value.startBeat) &&
    (!Object.hasOwn(value, "sourceAssetId") || isSafeStorageId(value.sourceAssetId));
}

export function isAudioAsset(value: unknown): value is AudioAsset {
  return audioRecordHasOnly(value, [
    "id", "sessionId", "jobId", "label", "role", "mediaType", "byteLength", "sha256",
    "durationSeconds", "sampleRate", "channels", "origin",
  ]) && isSafeStorageId(value.sessionId) && isSafeStorageId(value.jobId) &&
    [...SEPARATION_STEMS, "residual", "source", "music", "music_alternative", "sound_effect"].includes(value.role as string) &&
    value.id === audioAssetId(value.jobId, value.role as AudioAsset["role"]) &&
    boundedAudioText(value.label, 256) && isAudioHash(value.sha256) &&
    Number.isSafeInteger(value.byteLength) && (value.byteLength as number) > 0 &&
    (value.byteLength as number) <= MAX_AUDIO_ASSET_BYTES &&
    isAudioAttachmentInspection(value, audioAssetInspectionLimits) && isAudioOrigin(value.origin) &&
    (["music", "music_alternative", "sound_effect"].includes(value.role as string) === (value.origin.kind === "generated"));
}

export async function readAudioAssetRecord(
  directory: AudioDirectoryBinding, sessionId: string, assetId: string,
): Promise<AudioAsset | undefined> {
  requireSafeStorageId(assetId, "Audio asset ID");
  const asset = await readAudioJson(directory, `${assetId}.asset.json`, MAX_AUDIO_ASSET_METADATA_BYTES);
  if (asset === undefined) return undefined;
  if (!isAudioAsset(asset) || asset.id !== assetId || asset.sessionId !== sessionId) throw new AudioStorageError();
  return asset;
}

export interface AudioDirectoryBinding {
  directory: string;
  identities: { path: string; dev: number; ino: number }[];
}

export async function bindAudioDirectory(
  storageDirectory: string, sessionId: string, create = false,
): Promise<AudioDirectoryBinding | undefined> {
  requireAudioStorage(storageDirectory, sessionId);
  const root = path.join(storageDirectory, "live-smith-audio");
  const directory = path.join(root, sessionId);
  const identities: AudioDirectoryBinding["identities"] = [];
  for (const target of [root, directory]) {
    let info;
    try { info = await fs.lstat(target); } catch (error) {
      if (!isMissingFileError(error)) throw new AudioStorageError();
      if (!create) return undefined;
      await ensurePrivateDirectoryDurably(target);
      info = await fs.lstat(target);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AudioStorageError();
    if (platform !== "win32") await fs.chmod(target, 0o700);
    identities.push({ path: target, dev: info.dev, ino: info.ino });
  }
  const binding = { directory, identities };
  await assertAudioDirectory(binding);
  return binding;
}

export async function assertAudioDirectory(binding: AudioDirectoryBinding): Promise<void> {
  for (const expected of binding.identities) {
    let actual;
    try { actual = await fs.lstat(expected.path); } catch { throw new AudioStorageError(); }
    if (!actual.isDirectory() || actual.isSymbolicLink() ||
      actual.dev !== expected.dev || actual.ino !== expected.ino) throw new AudioStorageError();
  }
}

export async function audioDirectoryEntries(binding: AudioDirectoryBinding): Promise<string[]> {
  await assertAudioDirectory(binding);
  const names: string[] = [];
  const directory = await fs.opendir(binding.directory);
  for await (const entry of directory) {
    // Forty jobs, each with one source and at most seven outputs, plus bounded
    // atomic-write remnants. Never allocate an unbounded directory listing.
    if (names.length >= 1024 || !entry.isFile() || entry.isSymbolicLink()) throw new AudioStorageError();
    names.push(entry.name);
  }
  await assertAudioDirectory(binding);
  return names;
}

export async function readAudioJson(binding: AudioDirectoryBinding, name: string, maxBytes: number): Promise<unknown> {
  await assertAudioDirectory(binding);
  const target = path.join(binding.directory, name);
  try { await fs.lstat(target); } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new AudioStorageError();
  }
  const bytes = await readBoundedAudioFile(binding, name, maxBytes);
  if (!isUtf8(bytes)) throw new AudioStorageError();
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { throw new AudioStorageError(); }
}

// File permission changes update ctime, even when the mode is unchanged. Keep
// normalization and the complete snapshot read in one turn per inode, including
// reads through path aliases. Only pending turns retain an entry, never bytes.
const pendingAudioReads = new Map<string, Promise<void>>();

export async function readBoundedAudioFile(
  binding: AudioDirectoryBinding, name: string, maxBytes: number, signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    throwIfAborted(signal);
    await assertAudioDirectory(binding);
    const target = path.join(binding.directory, name);
    const before = await fs.lstat(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new AudioStorageError();
    const identity = `${before.dev}:${before.ino}`;
    const previous = pendingAudioReads.get(identity) ?? Promise.resolve();
    const read = previous.then(async () => {
      throwIfAborted(signal);
      await assertAudioDirectory(binding);
      // Tighten the opened regular file, never a path that could now be a link.
      if (platform !== "win32") {
        const handle = await fs.open(target, safeRegularFileOpenFlags(constants));
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new AudioStorageError();
          if ((opened.mode & 0o7777n) !== 0o600n) await handle.chmod(0o600);
        } finally { await handle.close(); }
      }
      const bytes = await copyAudioFileSafely(
        target, signal ?? createHostAbortController().signal, maxBytes,
      );
      await assertAudioDirectory(binding);
      return bytes;
    });
    const complete = read.then(() => undefined, () => undefined);
    pendingAudioReads.set(identity, complete);
    void complete.then(() => {
      if (pendingAudioReads.get(identity) === complete) pendingAudioReads.delete(identity);
    });
    return await waitForPromiseWithSignal(read, signal);
  } catch {
    throwIfAborted(signal);
    throw new AudioStorageError();
  }
}

export function assertAudioJsonSize(value: unknown, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") > maxBytes) throw new AudioStorageError("Audio metadata exceeds its storage limit.");
}
