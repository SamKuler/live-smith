import { Buffer } from "node:buffer";
import { AUDIO_SERVICE_CAPABILITIES } from "../audio-services/capabilities.js";
import type { AudioJob } from "../audio-services/contracts.js";
import { listAudioAssets, readExpectedAudioAsset } from "../storage/audio-assets.js";
import { updateAudioJob } from "../storage/audio-jobs.js";
import { storageScopeKey } from "../storage/scope.js";
import { sessionErrorMessage } from "./error-routing.js";
import { audioMessage as m } from "./audio-messages.js";

const activeJobs = new Map<string | symbol, Set<string>>();

export function audioJobIsActive(storageDirectory: string | undefined, jobId: string): boolean {
  return activeJobs.get(storageScopeKey(storageDirectory))?.has(jobId) ?? false;
}

export function acquireAudioJob(storageDirectory: string | undefined, jobId: string): () => void {
  const key = storageScopeKey(storageDirectory);
  const owned = activeJobs.get(key) ?? new Set<string>();
  if (owned.has(jobId)) throw new Error("This audio job is already running.");
  owned.add(jobId);
  activeJobs.set(key, owned);
  return () => {
    owned.delete(jobId);
    if (!owned.size) activeJobs.delete(key);
  };
}

/** The caller owns the job for the complete local-recovery/remote-resume attempt. */
export async function reconcileLocalAudioJob(
  storageDirectory: string | undefined, sessionId: string, job: AudioJob, signal: AbortSignal,
): Promise<AudioJob> {
  const assets = (await listAudioAssets(storageDirectory, sessionId, job.id)).filter((asset) => asset.role !== "source");
  // Verify against committed expectations as well as newly recovered receipts.
  // Do not silently drop an output whose file has disappeared or changed.
  const expected = new Map(assets.map((asset) => [asset.id, asset]));
  for (const asset of job.outputAssets) expected.set(asset.id, asset);
  for (const asset of expected.values()) await readExpectedAudioAsset(storageDirectory, sessionId, asset, signal);
  const roles = job.operation === "separate_stems" ? [...job.stems, "residual"]
    : job.expectedOutputs?.map((output) => output.role) ?? job.expectedOutputRoles ??
      (AUDIO_SERVICE_CAPABILITIES[job.provider].inlineGeneration
        ? [job.operation === "generate_sound_effect" ? "sound_effect" : "music"]
        : undefined);
  const complete = roles?.every((role) => assets.some((asset) => asset.role === role));
  const remoteStatus = job.remoteOutputs?.length && job.status !== "cancelled" ? expected.size ? "partial" : "ready" : undefined;
  if (!complete && (!remoteStatus || remoteStatus === job.status) &&
    assets.every((asset) => job.outputAssets.some((existing) => existing.id === asset.id))) return job;
  return updateAudioJob(storageDirectory, sessionId, job.id, {
    outputAssets: [...expected.values()],
    ...(complete ? { status: "completed", message: m("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.") }
      : remoteStatus ? { status: remoteStatus, message: m("Audio is ready online. Preview a version or download it to Live Smith before a separate scoped Live import.") } : {}),
  });
}

export function safeAudioFailure(error: unknown, key: string): string {
  return boundedAudioMessage(sessionErrorMessage(error, [key]));
}

export function boundedAudioMessage(message: string): string {
  let value = "";
  let bytes = 0;
  for (const character of message.replace(/[\u0000-\u001f\u007f]/g, " ")) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 900) break;
    value += character;
  }
  return value;
}
