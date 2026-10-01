import { AudioToolOutcomeUnknownError } from "../../../audio-services/contracts.js";
import { setTimeout as delay } from "node:timers/promises";
import type { AudioAsset, AudioJob, AudioOrigin, SunoUploadMutationStage, SunoUploadReceipt } from "../../../audio-services/contracts.js";
import { AudioSubmissionNotStartedError, MAX_AUDIO_ASSET_DURATION_SECONDS, SUNO_UPLOAD_MUTATIONS } from "../../../audio-services/contracts.js";
import { createSunoUploadAdapter, type SunoUploadAdapter, type SunoUploadSpec } from "../../../audio-services/suno/suno-upload.js";
import { readAudioAsset, saveAudioAsset } from "../../../storage/audio-assets.js";
import { createAudioJob, loadAudioJob, updateAudioJob } from "../../../storage/audio-jobs.js";
import { throwIfAborted } from "../../../runtime/host.js";
import type { AudioProcessingContext } from "../audio-processing.js";
import { acquireAudioJob } from "../audio-job-runtime.js";
import { integrationConnectionFingerprint, resolveIntegrationConnection, type RuntimeIntegrationConnection } from "../../plugins/integration-connections.js";
import { persistRotatedSunoSession } from "./suno-session-manager.js";
import { providerFetchForStorage } from "../../network.js";
import { audioMessage as m } from "../audio-messages.js";

export interface SunoUploadOptions { adapter?: SunoUploadAdapter }
export class SunoUploadOutcomeUnknownError extends AudioToolOutcomeUnknownError {
  constructor() { super("The upload outcome could not be recorded. Check Suno and the saved upload receipt before continuing; do not submit it again automatically."); }
}
const legacyPendingMutation = (stage: SunoUploadReceipt["stage"]) => Object.hasOwn(SUNO_UPLOAD_MUTATIONS, stage);

export async function uploadSunoMusic(
  context: AudioProcessingContext, connectionId: string, rightsConfirmed: boolean,
  source: () => Promise<{ bytes: Uint8Array; label: string; origin: AudioOrigin }>,
  options: SunoUploadOptions = {},
): Promise<AudioJob> {
  if (rightsConfirmed !== true) throw new Error("Confirm that you have the rights to upload this audio before continuing.");
  if (!context.withGenerationAuthorization) throw new Error("Audio upload authorization is unavailable.");
  throwIfAborted(context.signal);
  const settings = await connection(context, connectionId);
  const adapter = options.adapter ?? context.pluginOverrides?.uploadAdapter ?? uploadAdapter(context, settings);
  const limits = await adapter.limits(context.signal);
  const job = await createAudioJob(context.storageDirectory, context.sessionId, {
    provider: "suno", serviceId: connectionId, connectionFingerprint: integrationConnectionFingerprint(settings), operation: "upload_music", stems: [],
  });
  const release = acquireAudioJob(context.storageDirectory, job.id);
  try {
    await context.onProgress?.(m("Preparing audio for upload"));
    const snapshot = await source();
    if (snapshot.origin.kind !== "asset" && snapshot.origin.kind !== "arrangement" && snapshot.origin.kind !== "attachment") throw new Error("Upload requires a validated request attachment, saved Session audio, or an observed Arrangement source.");
    const asset = await saveAudioAsset(context.storageDirectory, context.sessionId, { jobId: job.id, role: "source", ...snapshot, signal: context.signal });
    if (asset.durationSeconds < limits.minimumSeconds || asset.durationSeconds > Math.min(limits.maximumSeconds, MAX_AUDIO_ASSET_DURATION_SECONDS)) {
      throw new Error("Audio duration is outside this Suno account's upload limits.");
    }
    const prepared = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, {
      sourceAssetId: asset.id, upload: { sourceSha256: asset.sha256, rightsConfirmed: true, stage: "prepared" },
    });
    return await ownUpload(context, prepared, settings, adapter, asset, snapshot.bytes);
  } catch (error) {
    if (error instanceof SunoUploadOutcomeUnknownError) throw error;
    // The workflow owner records every remote-stage failure itself.
    const saved = await loadAudioJob(context.storageDirectory, context.sessionId, job.id);
    if (saved.upload) throw error;
    return updateAudioJob(context.storageDirectory, context.sessionId, job.id, {
      status: context.signal.aborted ? "interrupted" : "failed",
      message: m("Audio upload preparation failed. No audio was sent to Suno."),
    });
  } finally { release(); }
}

/** The caller owns the ordinary audio-job lock for this complete recovery attempt. */
export async function resumeSunoUpload(context: AudioProcessingContext, job: AudioJob, options: SunoUploadOptions = {}): Promise<AudioJob> {
  if (job.status === "failed") throw new Error("Suno rejected this upload; it cannot be resumed.");
  if (job.operation !== "upload_music" || job.provider !== "suno" || !job.upload || !job.sourceAssetId) throw new Error("This upload has no recoverable source receipt.");
  if (job.upload.stage === "complete") return job;
  if (job.upload.pendingStage || legacyPendingMutation(job.upload.stage)) {
    throw new Error("This upload has an unconfirmed remote stage and cannot be sent again. Check Suno before starting a new upload.");
  }
  if (job.upload.stage === "created") throw new Error("This upload has no saved storage authorization and cannot resume its transfer. Start a new upload.");
  if (!context.withGenerationAuthorization) throw new Error("Audio upload authorization is unavailable.");
  const settings = await connection(context, job.serviceId);
  if (integrationConnectionFingerprint(settings) !== job.connectionFingerprint) throw new Error("This upload belongs to another Suno account.");
  const { asset, bytes } = await readAudioAsset(context.storageDirectory, context.sessionId, job.sourceAssetId, context.signal);
  if (asset.sha256 !== job.upload.sourceSha256) throw new Error("The saved upload source changed.");
  const adapter = options.adapter ?? context.pluginOverrides?.uploadAdapter ?? uploadAdapter(context, settings);
  const limits = await adapter.limits(context.signal);
  if (asset.durationSeconds < limits.minimumSeconds || asset.durationSeconds > limits.maximumSeconds) throw new Error("Audio duration is outside this Suno account's upload limits.");
  return ownUpload(context, job, settings, adapter, asset, bytes);
}

async function ownUpload(context: AudioProcessingContext, initial: AudioJob, settings: RuntimeIntegrationConnection,
  adapter: SunoUploadAdapter, asset: AudioAsset, bytes: Uint8Array): Promise<AudioJob> {
  let job = initial;
  let receipt = initial.upload!;
  let spec: SunoUploadSpec | undefined;
  let recordingFailure: unknown;
  let unrecordedMutation = false;
  const record = async (next: SunoUploadReceipt, patch: Parameters<typeof updateAudioJob>[3] = {}) => {
    const update = { upload: next, ...patch };
    try {
      // Retry only this immutable local receipt, including an uncertain fsync.
      // A provider operation is never part of either commit attempt.
      try { job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, update); }
      catch { job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, update); }
      receipt = next;
      recordingFailure = undefined;
      if (!next.pendingStage && !legacyPendingMutation(next.stage)) unrecordedMutation = false;
    }
    catch (error) { recordingFailure = error; throw error; }
  };
  const mutate = <T>(stage: SunoUploadMutationStage, operation: () => Promise<T>) => context.withGenerationAuthorization!(context.signal, async () => {
    await resolveIntegrationConnection(context.storageDirectory, settings.id, "upload_music", [settings]);
    throwIfAborted(context.signal);
    const confirmed = receipt;
    try {
      await record({ ...confirmed, pendingStage: stage }, { status: "submitting" });
      throwIfAborted(context.signal);
    } catch (error) {
      // This owner has not entered the remote call, so clearing its intent does
      // not replay an uncertain mutation or move the confirmed stage backward.
      await record(confirmed, { status: "interrupted" });
      throw error;
    }
    unrecordedMutation = true;
    try { return await operation(); }
    catch (error) {
      if (error instanceof AudioSubmissionNotStartedError) {
        unrecordedMutation = false;
        await record(confirmed, { status: "interrupted" });
      }
      throw error;
    }
  });
  const completedReceipt = (stage: SunoUploadMutationStage): SunoUploadReceipt => {
    const { pendingStage: _pending, ...confirmed } = receipt;
    return { ...confirmed, stage: SUNO_UPLOAD_MUTATIONS[stage].to };
  };
  try {
    throwIfAborted(context.signal);
    if (receipt.stage === "prepared") {
      spec = await mutate("creating", () => adapter.create(asset.mediaType, context.signal));
      await record({ ...completedReceipt("creating"), uploadId: spec.uploadId }, { status: "running" });
    }
    throwIfAborted(context.signal);
    if (receipt.stage === "created" && spec) {
      await context.onProgress?.(m("Uploading audio to Suno"));
      await mutate("uploading", () => adapter.upload(spec!, bytes, asset.mediaType, context.signal));
      await record(completedReceipt("uploading"), { status: "running" });
    }
    throwIfAborted(context.signal);
    if (receipt.stage === "uploaded") {
      await mutate("finishing", () => adapter.finish(receipt.uploadId!, asset.mediaType, context.signal));
      await record(completedReceipt("finishing"), { status: "running" });
    }
    if (receipt.stage === "processing") {
      await context.onProgress?.(m("Processing uploaded audio"));
      for (let attempt = 0; attempt < 75; attempt++) {
        throwIfAborted(context.signal);
        await resolveIntegrationConnection(context.storageDirectory, settings.id, "upload_music", [settings]);
        const status = await adapter.inspect(receipt.uploadId!, context.signal);
        if (status.status === "failed") return await updateAudioJob(context.storageDirectory, context.sessionId, job.id, {
          status: "failed", message: m("Suno could not process this uploaded audio."),
        });
        if (status.status === "complete") { await record({ ...receipt, stage: "processed" }, { status: "running" }); break; }
        if (context.wait) await context.wait(context.signal); else await delay(4_000, undefined, { signal: context.signal });
      }
      if (receipt.stage === "processing") throw new Error("Upload processing timed out.");
    }
    throwIfAborted(context.signal);
    if (receipt.stage === "processed") {
      const clipId = await mutate("initializing", () => adapter.initialize(receipt.uploadId!, context.signal));
      const outputs = [{ key: clipId, role: "uploaded_audio" as const }];
      await record({ ...completedReceipt("initializing"), clipId }, {
        status: "ready", remoteTaskId: clipId, expectedOutputs: outputs, remoteOutputs: outputs,
        message: m("Audio uploaded to Suno. Its Clip can be used by this connection's music tools."),
      });
    }
    return job;
  } catch (error) {
    if (recordingFailure) throw unrecordedMutation ? new SunoUploadOutcomeUnknownError() : recordingFailure;
    try {
      return await updateAudioJob(context.storageDirectory, context.sessionId, job.id, {
        status: receipt.pendingStage || legacyPendingMutation(receipt.stage) ? "unknown" : "interrupted",
        message: receipt.pendingStage || legacyPendingMutation(receipt.stage)
          ? m("The upload stage is unconfirmed. Check Suno before starting a new upload; this stage will not be sent again.")
          : m("Audio upload was interrupted. Its saved receipt was preserved."),
      });
    } catch (failure) {
      throw unrecordedMutation ? new SunoUploadOutcomeUnknownError() : failure;
    }
  }
}

async function connection(context: AudioProcessingContext, id: string): Promise<RuntimeIntegrationConnection> {
  const settings = await resolveIntegrationConnection(context.storageDirectory, id, "upload_music", context.admittedConnections);
  if (settings.provider !== "suno" || !settings.sunoSession) throw new Error("A signed-in Suno connection is required to upload audio.");
  return settings;
}

function uploadAdapter(context: AudioProcessingContext, settings: RuntimeIntegrationConnection): SunoUploadAdapter {
  return createSunoUploadAdapter(settings.sunoSession!, {
    fetchImpl: providerFetchForStorage(context.storageDirectory),
    onSessionRefresh: (previous, next, signal) => persistRotatedSunoSession(context.storageDirectory,
      settings.id, settings.sunoSession!.accountId, previous, next, signal),
  });
}
