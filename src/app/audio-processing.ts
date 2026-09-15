import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";

import {
  audioJobRemoteSettled, audioJobView, type AudioAsset, type AudioJob, type AudioJobView,
  type AudioOrigin, type AudioServiceAdapter, type AudioServiceConnection, type AudioGenerationAdapter,
  type SeparationStem, type AudioDownloadAuthorization, type AudioServiceAuthorization,
} from "../audio-services/contracts.js";
import { createLalalAudioAdapter } from "../audio-services/lalal.js";
import { AttachmentProcessingError } from "../attachments/contracts.js";
import {
  createHostAbortController, throwIfAborted, waitForPromiseWithSignal,
} from "../runtime/host.js";
import { assertAudioOutputCapacity, saveAudioAsset, readAudioAsset, readAudioSessionState } from "../storage/audio-assets.js";
import {
  createAudioJob, loadAudioJob, updateAudioJob,
} from "../storage/audio-jobs.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { audioServiceSupports } from "../audio-services/capabilities.js";
import { audioConnectionFingerprint, availableAudioServices, resolveAudioService, type RuntimeAudioServiceConnection } from "./audio-service-connections.js";
import { acquireAudioJob, audioJobIsActive, boundedAudioMessage, reconcileLocalAudioJob, safeAudioFailure } from "./audio-job-runtime.js";
import { resumeAudioGeneration } from "./audio-generation.js";
import { audioPollScheduler } from "./audio-polling.js";
export { audioConnectionFingerprint } from "./audio-service-connections.js";
export { downloadAudioOutput } from "./audio-generation.js";

export interface AudioProcessingContext {
  storageDirectory: string | undefined;
  sessionId: string;
  signal: AbortSignal;
  /** Saved connections captured before this request advertises audio tools. */
  admittedConnections?: readonly RuntimeAudioServiceConnection[];
  onProgress?(message: string): Promise<void> | void;
  /** The explicit download command supplies the shared global-settings fence. */
  withDownloadAuthorization?: AudioDownloadAuthorization;
  /** Paid generation uses the same settings lifecycle owner, after preparation. */
  withGenerationAuthorization?: AudioServiceAuthorization;
  /** Injected service and wait are used by protocol-independent lifecycle tests. */
  adapter?: AudioServiceAdapter;
  generationAdapter?: AudioGenerationAdapter;
  wait?: (signal: AbortSignal) => Promise<void>;
}

export async function audioProcessingAvailable(storageDirectory: string | undefined): Promise<boolean> {
  return (await availableAudioServices(storageDirectory)).some((service) => audioServiceSupports(service.provider, "separate_stems"));
}

export async function audioJobViews(
  storageDirectory: string | undefined, sessionId: string,
): Promise<AudioJobView[]> {
  if (!storageDirectory) return [];
  const { jobs, assets: localAssets } = await readAudioSessionState(storageDirectory, sessionId);
  return jobs.map((job) => {
    const view = audioJobView(job);
    const active = audioJobIsActive(storageDirectory, job.id);
    if (!active && ["preparing", "submitting", "running", "collecting"].includes(job.status)) {
      view.status = job.remoteOutputs?.length ? job.outputAssets.length ? "partial" : "ready"
        : job.status === "submitting" && !job.remoteTaskId ? "unknown" : "interrupted";
    }
    if (active) view.resumable = false;
    else if (!job.remoteTaskId && job.operation !== "separate_stems" &&
      job.status !== "completed" && job.status !== "cancelled") {
      view.resumable = localAssets.some((asset) => asset.jobId === job.id && asset.role !== "source");
    }
    return view;
  });
}

async function service(context: AudioProcessingContext, serviceId: string): Promise<{
  settings: AudioServiceConnection; adapter: AudioServiceAdapter;
}> {
  const settings = await resolveAudioService(context.storageDirectory, serviceId, "separate_stems", context.admittedConnections);
  return {
    settings,
    adapter: context.adapter ?? createLalalAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
    }),
  };
}

export async function separateAudioStems(
  context: AudioProcessingContext,
  serviceId: string,
  stems: SeparationStem[],
  source: () => Promise<{ bytes: Uint8Array; label: string; origin: AudioOrigin }>,
): Promise<AudioJob> {
  throwIfAborted(context.signal);
  const { settings, adapter } = await service(context, serviceId);
  if (!stems.length || new Set(stems).size !== stems.length || stems.some((stem) => !adapter.stems.includes(stem))) {
    throw new Error("The audio service does not support the requested stem combination.");
  }
  const job = await createAudioJob(context.storageDirectory, context.sessionId, {
    provider: settings.provider, serviceId: settings.id, operation: "separate_stems",
    connectionFingerprint: audioConnectionFingerprint(settings), stems,
  });
  const release = acquireAudioJob(context.storageDirectory, job.id);
  try { return await ownJob(context, job, settings, adapter, source); }
  finally { release(); }
}

export async function resumeAudioJob(context: AudioProcessingContext, jobId: string): Promise<AudioJob> {
  throwIfAborted(context.signal);
  const release = acquireAudioJob(context.storageDirectory, jobId);
  try {
    let job = await loadAudioJob(context.storageDirectory, context.sessionId, jobId);
    if (job.status === "completed" || job.status === "cancelled") return job;
    job = await reconcileLocalAudioJob(context.storageDirectory, context.sessionId, job, context.signal);
    if (job.status === "completed" || audioJobRemoteSettled(job)) return job;
    if (job.operation !== "separate_stems") return await resumeAudioGeneration(context, job);
    const { settings, adapter } = await service(context, job.serviceId);
    if (job.connectionFingerprint !== audioConnectionFingerprint(settings)) {
      throw new Error("This audio job belongs to a different service connection. Restore that connection to retrieve it.");
    }
    if (!job.remoteTaskId) {
      throw new Error("This audio job has no confirmed remote task ID and cannot be resumed. It will not be submitted again automatically.");
    }
    return await ownJob(context, job, settings, adapter);
  } finally { release(); }
}

async function ownJob(
  context: AudioProcessingContext, initial: AudioJob, settings: AudioServiceConnection,
  adapter: AudioServiceAdapter,
  source?: () => Promise<{ bytes: Uint8Array; label: string; origin: AudioOrigin }>,
): Promise<AudioJob> {
  let job = initial;
  // Receipt ownership must not depend on the subsequent filesystem commit.
  let acceptedTaskId = initial.remoteTaskId;
  let submissionStarted = false;
  let recordingFailure: unknown;
  const update = async (patch: Parameters<typeof updateAudioJob>[3]): Promise<void> => {
    job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, patch);
    // The owning send publishes progress and its final state. Invalidating the
    // same Session here would wait on that send's fence and lock its composer.
  };
  try {
    if (source) {
      await context.onProgress?.("Preparing audio for stem separation");
      const snapshot = await source();
      throwIfAborted(context.signal);
      const asset = await saveAudioAsset(context.storageDirectory, context.sessionId, {
        jobId: job.id, role: "source", ...snapshot, signal: context.signal,
      });
      await update({ sourceAssetId: asset.id });
      await assertAudioOutputCapacity(context.storageDirectory, context.sessionId, job.stems.length + 1);
      await context.onProgress?.("Uploading audio for stem separation");
      await resolveAudioService(context.storageDirectory, settings.id, job.operation, [settings]);
      throwIfAborted(context.signal);
      const remoteSourceId = await adapter.upload(snapshot.bytes, asset.mediaType, context.signal);
      await update({ remoteSourceId });
      throwIfAborted(context.signal);
      // A lost reply from this point has an unknown paid submission outcome.
      await update({ status: "submitting" });
      await resolveAudioService(context.storageDirectory, settings.id, job.operation, [settings]);
      throwIfAborted(context.signal);
      submissionStarted = true;
      const remoteTaskId = await adapter.submit(remoteSourceId, job.stems, randomUUID(), context.signal, asset.mediaType);
      acceptedTaskId = remoteTaskId;
      // Persist the accepted ticket even when cancellation raced the reply.
      await update({ remoteTaskId, status: "running", message: "Stem separation is processing." });
    }
    throwIfAborted(context.signal);
    const taskId = job.remoteTaskId;
    if (!taskId) throw new Error("Audio processing has no confirmed remote task.");
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      throwIfAborted(context.signal);
      if (!context.wait) await audioPollScheduler.wait(settings.provider,
        JSON.stringify([context.storageDirectory, job.connectionFingerprint]), context.signal);
      const remote = await adapter.inspect(taskId, job.stems, context.signal);
      if (remote.status === "cancelled") {
        await update({ remoteTaskTerminal: "cancelled", status: "cancelled", message: "The audio service confirmed cancellation." });
        return job;
      }
      if (remote.status === "failed") {
        await update({ remoteTaskTerminal: "failed", status: job.outputAssets.length ? "partial" : "failed", message: remote.message });
        return job;
      }
      if (remote.status === "completed") {
        await update({ status: "collecting", message: "Downloading separated audio." });
        if (!job.sourceAssetId) throw new Error("Audio job source is unavailable.");
        const sourceAsset = (await readAudioAsset(context.storageDirectory, context.sessionId, job.sourceAssetId, context.signal)).asset;
        const unavailable: string[] = [];
        for (const output of remote.outputs) {
          if (job.outputAssets.some((asset) => asset.role === output.role)) continue;
          throwIfAborted(context.signal);
          await context.onProgress?.(`Downloading stem: ${output.role}`);
          let bytes: Uint8Array;
          try {
            bytes = await adapter.download(output, context.signal);
          } catch (error) {
            throwIfAborted(context.signal);
            unavailable.push(`${output.role}: ${safeAudioFailure(error, settings.apiKey)}`);
            continue;
          }
          try {
            const asset = await saveAudioAsset(context.storageDirectory, context.sessionId, {
              jobId: job.id, role: output.role, label: output.role,
              bytes, origin: { ...sourceAsset.origin, sourceAssetId: sourceAsset.id }, signal: context.signal,
            });
            await update({ outputAssets: [...job.outputAssets, asset] });
          } catch (error) {
            throwIfAborted(context.signal);
            if (!(error instanceof AttachmentProcessingError)) throw error;
            unavailable.push(`${output.role}: ${safeAudioFailure(error, settings.apiKey)}`);
          }
        }
        const missing = [...job.stems, "residual"].filter((role) => !job.outputAssets.some((asset) => asset.role === role));
        await update({
          status: missing.length ? job.outputAssets.length ? "partial" : "interrupted" : "completed",
          message: missing.length
            ? boundedAudioMessage(`Audio outputs unavailable: ${missing.join(", ")}. Resume to retrieve missing files without another separation. ${unavailable.join("; ")}`)
            : "Separated audio is saved. Importing it into Live is a separate scoped Apply operation.",
        });
        return job;
      }
      await context.onProgress?.(remote.progress === undefined ? "Separating stems" : `Separating stems (${remote.progress}%)`);
      if (Date.now() >= deadline) {
        await update({ status: "interrupted", message: "Stopped waiting for audio processing. Resume this job to check the existing remote task." });
        return job;
      }
      if (context.wait) await context.wait(context.signal);
      else await delay(3_000, undefined, { signal: context.signal });
    }
  } catch (error) {
    const aborted = context.signal.aborted;
    const taskId = acceptedTaskId ?? job.remoteTaskId;
    const message = aborted
      ? taskId
        ? "Local audio processing stopped. The remote task may still exist; resume to check its state."
        : submissionStarted
          ? "Stopped while submitting audio processing. The remote submission outcome is unknown; no automatic resubmission will occur."
          : "Audio processing stopped before a confirmed remote task was created."
      : safeAudioFailure(error, settings.apiKey);
    try {
      await update({
        ...(taskId ? { remoteTaskId: taskId } : {}),
        status: taskId ? job.outputAssets.length ? "partial" : "interrupted"
          : submissionStarted ? "unknown" : aborted ? "interrupted" : "failed",
        message,
      });
    } catch (failure) {
      recordingFailure = failure;
    }
    if (recordingFailure) throw recordingFailure;
    return job;
  } finally {
    // Stop may arrive during an awaited progress update or terminal bookkeeping.
    // Every exit owns cancellation, including an ordinary wait-deadline return.
    const taskId = acceptedTaskId ?? job.remoteTaskId;
    if ((context.signal.aborted || recordingFailure) && taskId && adapter.cancel) {
      await cancelRemoteBestEffort(adapter, taskId);
    }
    if (!recordingFailure) throwIfAborted(context.signal);
  }
}

async function cancelRemoteBestEffort(adapter: AudioServiceAdapter, taskId: string): Promise<void> {
  const controller = createHostAbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Audio cancellation wait expired.")), 3_000);
  try {
    await waitForPromiseWithSignal(adapter.cancel!(taskId, controller.signal), controller.signal);
  } catch {
    // Only a later status read can confirm remote cancellation; the job is retained.
  } finally {
    clearTimeout(timeout);
  }
}

export function audioJobResultText(job: AudioJob): string {
  return JSON.stringify({ ...audioJobView(job), ...(job.provider === "suno" && job.remoteOutputs
    ? { musicClips: job.remoteOutputs.map(({ key, role }) => ({ clipId: key, role })) } : {}) });
}

export function audioAssetsFromJobs(jobs: readonly AudioJob[]): AudioAsset[] {
  return jobs.flatMap((job) => job.outputAssets);
}
