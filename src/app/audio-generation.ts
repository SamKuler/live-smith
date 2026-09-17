import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { isDeepStrictEqual } from "node:util";
import { parseRetrievalClipIds } from "../agent/music-tools.js";
import {
  audioJobRemoteSettled,
  AudioSubmissionNotStartedError,
  type AudioGenerationAdapter, type AudioGenerationRequest, type AudioJob,
  type GeneratedAudioOutput, type RemoteAudioStatus,
} from "../audio-services/contracts.js";
import { AUDIO_SERVICE_CAPABILITIES } from "../audio-services/capabilities.js";
import { exceedsAudioPromptLimit } from "../audio-services/prompt.js";
import { AttachmentProcessingError } from "../attachments/contracts.js";
import { createElevenLabsAudioAdapter } from "../audio-services/elevenlabs.js";
import { createMurekaAudioAdapter } from "../audio-services/mureka.js";
import { createSunoPlatformAudioAdapter } from "../audio-services/suno-platform.js";
import { createSunoApiAudioAdapter } from "../audio-services/sunoapi.js";
import { createHostAbortController, throwIfAborted, waitForPromiseWithSignal } from "../runtime/host.js";
import { createAudioJob, listAudioJobs, loadAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { assertAudioOutputCapacity, saveAudioAsset } from "../storage/audio-assets.js";
import { acquireAudioJob, boundedAudioMessage, reconcileLocalAudioJob, safeAudioFailure } from "./audio-job-runtime.js";
import { audioConnectionFingerprint, resolveAudioService, type RuntimeAudioServiceConnection } from "./audio-service-connections.js";
import type { AudioProcessingContext } from "./audio-processing.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { createAppSunoGenerationAdapter } from "./suno-human-verification.js";
import { audioMessage as m } from "./audio-messages.js";

function generationAdapter(
  context: AudioProcessingContext, settings: RuntimeAudioServiceConnection, authorizeDownloads = false,
): AudioGenerationAdapter {
  if (context.generationAdapter) {
    if (context.generationAdapter.provider !== settings.provider) throw new Error("Audio adapter does not match the selected connection.");
    return context.generationAdapter;
  }
  if (settings.provider === "elevenlabs") {
    return createElevenLabsAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  if (settings.provider === "mureka") {
    return createMurekaAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  if (settings.provider === "suno-platform") {
    return createSunoPlatformAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
    });
  }
  if (settings.provider === "sunoapi" && settings.callbackUrl) {
    return createSunoApiAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory), callbackUrl: settings.callbackUrl,
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  if (settings.provider === "suno" && settings.sunoSession) {
    return createAppSunoGenerationAdapter(context, settings, authorizeDownloads);
  }
  throw new Error("This service's generation protocol is not available.");
}

export async function generateAudio(
  context: AudioProcessingContext, serviceId: string, request: AudioGenerationRequest,
): Promise<AudioJob> {
  throwIfAborted(context.signal);
  const settings = await resolveAudioService(context.storageDirectory, serviceId, request.operation, context.admittedConnections);
  if ((request.operation === "generate_music" || request.operation === "extend_music") && request.options &&
    !AUDIO_SERVICE_CAPABILITIES[settings.provider].customMusic) throw new Error("This service does not support custom music parameters.");
  if ((request.operation === "generate_music" || request.operation === "extend_music") && request.options &&
    Object.keys(request.options).some((field) => field !== "mode" &&
      !AUDIO_SERVICE_CAPABILITIES[settings.provider].customMusicOptions?.includes(field as never))) {
    throw new Error("This service does not support one or more custom music parameters.");
  }
  if ((request.operation === "generate_music" || request.operation === "extend_music") && request.options &&
    AUDIO_SERVICE_CAPABILITIES[settings.provider].requiredCustomMusicOptions?.some((field) => request.options?.[field] === undefined)) {
    throw new Error("This service requires another custom music parameter.");
  }
  if (request.operation === "generate_music" && exceedsAudioPromptLimit(request.prompt, AUDIO_SERVICE_CAPABILITIES[settings.provider].musicPromptCharacters)) {
    throw new Error("The music prompt exceeds this service's supported limit.");
  }
  if (request.operation === "generate_music" && request.instrumental && settings.modelId &&
    AUDIO_SERVICE_CAPABILITIES[settings.provider].instrumentalUnsupportedModelIds?.includes(settings.modelId)) {
    throw new Error("The selected model does not support instrumental generation.");
  }
  if (request.operation === "generate_music" && request.durationSeconds !== undefined) {
    const range = AUDIO_SERVICE_CAPABILITIES[settings.provider].musicDuration;
    if (!range) throw new Error("This service does not support an explicit music duration.");
    if (request.durationSeconds < range.minimumSeconds ||
      request.durationSeconds > range.maximumSeconds) {
      throw new Error("The music duration is outside this service's supported range.");
    }
  }
  const adapter = generationAdapter(context, settings);
  if (settings.provider !== "suno") await assertAudioOutputCapacity(context.storageDirectory, context.sessionId,
    request.operation === "get_whole_song" ? 1 : AUDIO_SERVICE_CAPABILITIES[settings.provider].generationOutputCount);
  const job = await createAudioJob(context.storageDirectory, context.sessionId, {
    provider: settings.provider, serviceId: settings.id, operation: request.operation,
    ...(request.operation !== "generate_sound_effect" && settings.modelId ? { modelId: settings.modelId } : {}),
    ...((request.operation === "generate_music" || request.operation === "extend_music") && request.options?.title?.trim()
      ? { title: request.options.title } : {}),
    connectionFingerprint: audioConnectionFingerprint(settings), stems: [],
  });
  const release = acquireAudioJob(context.storageDirectory, job.id);
  try { return await runGeneration(context, job, settings, adapter, request); }
  finally { release(); }
}

export async function retrieveMusic(
  context: AudioProcessingContext, serviceId: string, clipIds: readonly string[],
): Promise<AudioJob> {
  const ids = parseRetrievalClipIds(clipIds).sort();
  throwIfAborted(context.signal);
  const settings = await resolveAudioService(context.storageDirectory, serviceId, "retrieve_music", context.admittedConnections);
  const fingerprint = audioConnectionFingerprint(settings);
  const expectedOutputs: NonNullable<AudioJob["expectedOutputs"]> = ids.map((key, index) =>
    Object.freeze({ key, role: index === 0 ? "music" : "music_alternative" }));
  Object.freeze(expectedOutputs);
  // Exclude duplicate selections before a job ID exists, using the same owner
  // mechanism as Resume. The real job lock also excludes concurrent recovery.
  const releaseSelection = acquireAudioJob(context.storageDirectory, `retrieve:${context.sessionId}:${serviceId}:${ids.join(",")}`);
  try {
    const matching = (await listAudioJobs(context.storageDirectory, context.sessionId)).filter((job) =>
      job.provider === settings.provider && job.serviceId === serviceId && job.remoteTaskId === ids[0] &&
      isDeepStrictEqual(job.expectedOutputs, expectedOutputs));
    let job = matching.find((entry) => entry.connectionFingerprint === fingerprint);
    if (!job && matching.length) throw new Error("This audio job belongs to a different service connection. Restore that connection to retrieve it.");
    if (!job) {
      throwIfAborted(context.signal);
      job = await createAudioJob(context.storageDirectory, context.sessionId, {
        provider: settings.provider, serviceId, operation: "retrieve_music", connectionFingerprint: fingerprint, stems: [],
      }, { remoteTaskId: ids[0]!, expectedOutputs });
    }
    const release = acquireAudioJob(context.storageDirectory, job.id);
    try {
      job = await loadAudioJob(context.storageDirectory, context.sessionId, job.id);
      if (job.status === "completed" || job.status === "cancelled") return job;
      job = await reconcileLocalAudioJob(context.storageDirectory, context.sessionId, job, context.signal);
      if (job.status === "completed" || audioJobRemoteSettled(job)) return job;
      await resolveAudioService(context.storageDirectory, serviceId, "retrieve_music", [settings]);
      return await runGeneration(context, job, settings, generationAdapter(context, settings));
    } finally { release(); }
  } finally { releaseSelection(); }
}

export async function resumeAudioGeneration(context: AudioProcessingContext, job: AudioJob): Promise<AudioJob> {
  if (audioJobRemoteSettled(job)) return job;
  const settings = await resolveAudioService(context.storageDirectory, job.serviceId, job.operation);
  if (settings.provider !== job.provider || audioConnectionFingerprint(settings) !== job.connectionFingerprint) {
    throw new Error("This audio job belongs to a different service connection. Restore that connection to retrieve it.");
  }
  const { modelId: _currentModel, ...connection } = settings;
  const adapter = generationAdapter(context, { ...connection, ...(job.modelId ? { modelId: job.modelId } : {}) });
  return runGeneration(context, job, settings, adapter);
}

/** An explicit confirmation authorizes collection of exactly one observed output. */
export async function downloadAudioOutput(
  context: AudioProcessingContext, jobId: string, outputKey: string,
): Promise<AudioJob> {
  throwIfAborted(context.signal);
  const release = acquireAudioJob(context.storageDirectory, jobId);
  try {
    let job = await loadAudioJob(context.storageDirectory, context.sessionId, jobId);
    const selected = job.expectedOutputs?.find((output) => output.key === outputKey);
    if (job.provider !== "suno" || !selected) throw new Error("This output is not part of the original Suno job.");
    job = await reconcileLocalAudioJob(context.storageDirectory, context.sessionId, job, context.signal);
    if (job.outputAssets.some((asset) => asset.role === selected.role)) return job;
    if (job.status === "cancelled" || !job.remoteOutputs?.some((output) => output.key === selected.key && output.role === selected.role)) {
      throw new Error("This Suno output has not been observed complete. Resume its existing job before downloading.");
    }
    const settings = await resolveAudioService(context.storageDirectory, job.serviceId, job.operation, context.admittedConnections);
    if (settings.provider !== job.provider || audioConnectionFingerprint(settings) !== job.connectionFingerprint) {
      throw new Error("This audio job belongs to a different service connection. Restore that connection to retrieve it.");
    }
    const update = async (patch: Parameters<typeof updateAudioJob>[3]) => {
      job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, patch);
    };
    try {
      await assertAudioOutputCapacity(context.storageDirectory, context.sessionId, 1);
      await context.onProgress?.(m("Downloading the selected Suno song"));
      const currentSettings = await resolveAudioService(context.storageDirectory, settings.id, job.operation, [settings]);
      throwIfAborted(context.signal);
      const adapter = generationAdapter(context, currentSettings, true);
      if (!adapter.downloadSelected) throw new Error("This service cannot download the selected output.");
      await update({ status: "collecting", message: m("Downloading the selected Suno song") });
      throwIfAborted(context.signal);
      const bytes = await adapter.downloadSelected(selected, context.signal, (signal, authorize) => {
        if (!context.withDownloadAuthorization) throw new Error("Download authorization requires the connection lifecycle fence.");
        return context.withDownloadAuthorization(signal, async () => {
          await resolveAudioService(context.storageDirectory, currentSettings.id, job.operation, [currentSettings]);
          throwIfAborted(signal);
          // The provider calls this only at the actual allowance boundary. Keep
          // token minting and the complete POST inside the same settings lease.
          return authorize();
        });
      });
      throwIfAborted(context.signal);
      const asset = await saveAudioAsset(context.storageDirectory, context.sessionId, {
        jobId: job.id, role: selected.role, label: selected.role === "music_alternative" ? "Music alternative" : "Music",
        bytes, origin: { kind: "generated" }, signal: context.signal,
      });
      const outputAssets = [...job.outputAssets, asset];
      const complete = job.expectedOutputs!.every((entry) => outputAssets.some((saved) => saved.role === entry.role));
      await retryLocalCommit(() => update({ outputAssets, status: complete ? "completed" : "partial",
        message: m(job.failedOutputKeys?.length
          ? "Audio is downloaded to Live Smith. Some confirmed outputs failed to generate. Importing into Live is a separate scoped operation."
          : "Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.") }));
    } catch (error) {
      await update({ status: job.outputAssets.length ? "partial" : "ready",
        message: context.signal.aborted
          ? m("Local download stopped. Download authorization may have consumed an allowance. No automatic retry will occur.")
          : safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey) });
      throwIfAborted(context.signal);
    }
    return job;
  } finally { release(); }
}

function confirmedGenerationOutputs(
  job: AudioJob, remote: Extract<RemoteAudioStatus, { status: "completed" }>,
): NonNullable<AudioJob["expectedOutputs"]> {
  const roles = (job.expectedOutputs ?? remote.outputs).map((output) => output.role);
  if (roles.some((role) => !["music", "music_alternative", "sound_effect"].includes(role))) throw new Error("Unexpected generated audio role.");
  if (!job.expectedOutputs && job.outputAssets.length) {
    throw new Error("This historical partial result has no saved remote output identities. Existing audio is retained, but missing files cannot be safely matched.");
  }
  const expectedOutputs = job.expectedOutputs ?? remote.outputs.map(({ key, role }) => ({ key, role: role as GeneratedAudioOutput["role"] }));
  const returned = new Set(remote.outputs.map((output) => output.key));
  const failed = remote.failedOutputKeys ?? [];
  if (returned.size !== remote.outputs.length || new Set(failed).size !== failed.length ||
    failed.some((key) => returned.has(key) || !expectedOutputs.some((output) => output.key === key)) ||
    remote.outputs.some((output) => !expectedOutputs.some((expected) => expected.key === output.key && expected.role === output.role)) ||
    expectedOutputs.some((output) => !returned.has(output.key) && !failed.includes(output.key))) {
    throw new Error("The confirmed audio output identities changed.");
  }
  return expectedOutputs;
}

async function runGeneration(
  context: AudioProcessingContext, initial: AudioJob, settings: RuntimeAudioServiceConnection,
  adapter: AudioGenerationAdapter, request?: AudioGenerationRequest,
): Promise<AudioJob> {
  let job = initial;
  let acceptedTaskId = initial.remoteTaskId;
  let acceptedOutputs = initial.expectedOutputs;
  let hasCompleteAudio = false;
  let submissionStarted = false;
  const update = async (patch: Parameters<typeof updateAudioJob>[3]) => {
    job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, patch);
  };
  const save = async (output: GeneratedAudioOutput, preserveCompleted = false) => {
    if (job.outputAssets.some((asset) => asset.role === output.role)) return;
    const persist = () => saveAudioAsset(context.storageDirectory, context.sessionId, {
      jobId: job.id, role: output.role,
      label: output.role === "sound_effect" ? "Sound effect" : output.role === "music_alternative" ? "Music alternative" : "Music",
      bytes: output.bytes, origin: { kind: "generated" },
      // A complete paid result may race Stop. Persist that result, without
      // authorizing another remote request or a Live mutation.
      signal: preserveCompleted ? createHostAbortController().signal : context.signal,
    });
    const asset = preserveCompleted ? await retryLocalCommit(persist) : await persist();
    await retryLocalCommit(() => update({ outputAssets: [...job.outputAssets, asset] }));
  };
  try {
    if (request) {
      await context.onProgress?.(m(request.operation === "generate_sound_effect" ? "Generating a sound effect" : "Preparing music generation"));
      throwIfAborted(context.signal);
      await adapter.prepare?.(request, context.signal);
      await update({ status: "submitting", message: m("Waiting for the audio service. Do not submit duplicates.") });
      await resolveAudioService(context.storageDirectory, settings.id, request.operation, [settings]);
      throwIfAborted(context.signal);
      submissionStarted = true;
      const result = await adapter.submit(request, context.signal);
      if (result.kind === "audio") {
        hasCompleteAudio = true;
        for (const output of result.outputs) await save(output, true);
        if (!job.outputAssets.length) throw new Error("The audio service returned no usable output.");
        await retryLocalCommit(() => update({ status: "completed", message: m("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.") }));
        return job;
      }
      acceptedTaskId = result.taskId;
      acceptedOutputs = result.expectedOutputs;
      await retryLocalCommit(() => update({ remoteTaskId: result.taskId,
        ...(acceptedOutputs ? { expectedOutputs: acceptedOutputs } : {}), status: "running" }));
    }
    throwIfAborted(context.signal);
    if (!acceptedTaskId || !adapter.inspect || job.provider !== "suno" && !adapter.download) {
      throw new Error("This generation has no resumable remote task. It will not be submitted again automatically.");
    }
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      throwIfAborted(context.signal);
      const remote = await adapter.inspect(acceptedTaskId, context.signal, acceptedOutputs);
      if (remote.status === "failed" || remote.status === "cancelled") {
        await update({ remoteTaskTerminal: remote.status,
          status: job.remoteOutputs?.length ? job.outputAssets.length ? "partial" : "ready"
          : remote.status === "cancelled" ? "cancelled" : job.outputAssets.length ? "partial" : "failed",
          message: remote.status === "failed" ? remote.message : m("The audio service confirmed cancellation.") });
        return job;
      }
      if (remote.status === "completed") {
        const expectedOutputs = confirmedGenerationOutputs(job, remote);
        const roles = expectedOutputs.map((output) => output.role);
        const failed = remote.failedOutputKeys ?? [];
        acceptedOutputs = expectedOutputs;
        if (job.provider === "suno") {
          const successful = new Set([...job.remoteOutputs ?? [], ...remote.outputs].map((output) => output.key));
          const remoteOutputs = expectedOutputs.filter((output) => successful.has(output.key));
          await retryLocalCommit(() => update({ expectedOutputs, remoteOutputs,
            ...(failed.length ? { failedOutputKeys: failed } : {}),
            status: job.outputAssets.length ? "partial" : remoteOutputs.length ? "ready" : "failed",
            message: remoteOutputs.length
              ? m(failed.length
                ? "Audio is ready online, but some confirmed outputs failed to generate. Preview or download an available version."
                : "Audio is ready online. Preview a version or download it to Live Smith before a separate scoped Live import.")
              : m("The service failed to generate the confirmed outputs.") }));
          throwIfAborted(context.signal);
          return job;
        }
        await retryLocalCommit(() => update({ status: "collecting", expectedOutputs,
          ...(failed.length ? { failedOutputKeys: failed } : {}) }));
        const failures: string[] = failed.length ? ["The service failed to generate one or more confirmed outputs."] : [];
        for (const output of remote.outputs) {
          if (job.outputAssets.some((asset) => asset.role === output.role)) continue;
          throwIfAborted(context.signal);
          let bytes: Uint8Array;
          try { bytes = await adapter.download!(output, context.signal); }
          catch (error) {
            throwIfAborted(context.signal);
            failures.push(`${output.role}: ${safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey)}`);
            continue;
          }
          try { await save({ role: output.role as GeneratedAudioOutput["role"], bytes }); }
          catch (error) {
            throwIfAborted(context.signal);
            if (!(error instanceof AttachmentProcessingError)) throw error;
            failures.push(`${output.role}: ${safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey)}`);
          }
        }
        const missing = roles.filter((role) => !job.outputAssets.some((asset) => asset.role === role));
        await retryLocalCommit(() => update({ status: missing.length ? job.outputAssets.length ? "partial" : "interrupted" : "completed",
          message: missing.length
            ? m("Generated audio is not fully downloaded. Resume to retrieve missing files without another generation. {details}", { details: boundedAudioMessage(failures.join("; ")) })
            : m("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.") }));
        return job;
      }
      await context.onProgress?.(m("Waiting for generated audio"));
      if (Date.now() >= deadline) {
        await update({ status: "interrupted", message: m("Stopped waiting. Resume this job to check its existing remote task.") });
        return job;
      }
      if (context.wait) await context.wait(context.signal);
      else await delay(3_000, undefined, { signal: context.signal });
    }
  } catch (error) {
    let recordingFailure: unknown;
    try {
      await update({
        ...(acceptedTaskId ? { remoteTaskId: acceptedTaskId } : {}),
        ...(acceptedOutputs ? { expectedOutputs: acceptedOutputs } : {}),
        status: job.outputAssets.length ? "partial" : job.remoteOutputs?.length ? "ready" : acceptedTaskId || hasCompleteAudio ? "interrupted"
          : !(error instanceof AudioSubmissionNotStartedError) && (submissionStarted || initial.status === "submitting" || initial.status === "unknown") ? "unknown"
          : context.signal.aborted ? "interrupted" : "failed",
        message: context.signal.aborted
          ? m("Local audio generation stopped. This does not confirm service-side cancellation or a credit refund. No automatic resubmission will occur.")
          : safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey),
      });
    } catch (failure) { recordingFailure = failure; }
    finally {
      if ((context.signal.aborted || recordingFailure) && acceptedTaskId && adapter.cancel) {
        const controller = createHostAbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try { await waitForPromiseWithSignal(adapter.cancel(acceptedTaskId, controller.signal), controller.signal); }
        catch { /* A later status read is required to confirm remote cancellation. */ }
        finally { clearTimeout(timer); }
      }
    }
    if (recordingFailure) throw recordingFailure;
    throwIfAborted(context.signal);
    return job;
  }
}

async function retryLocalCommit<T>(commit: () => Promise<T>): Promise<T> {
  try { return await commit(); }
  catch {
    // Reconcile a one-time or unknown local commit using exactly the same
    // immutable receipt. This helper never wraps a provider request.
    return commit();
  }
}
