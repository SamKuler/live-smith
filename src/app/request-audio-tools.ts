import type { ExtensionContext } from "@ableton-extensions/sdk";
import { Buffer } from "node:buffer";
import type { UiMessage } from "../i18n/ui-message.js";
import {
  audioProcessingTools, parseAudioToolRequest, validateAudioServiceRequest, type AudioProcessingSource,
  type AudioToolRequest,
} from "../agent/audio-tools.js";
import type { AgentExternalToolResult } from "../agent/loop.js";
import {
  audioJobRemoteSettled, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  type AudioAsset, type AudioOrigin, type AudioGenerationRequest,
} from "../audio-services/contracts.js";
import { readArrangementAudio } from "../live/observer.js";
import type { LiveTarget } from "../live/target.js";
import type { ModelToolCall } from "../model/contracts.js";
import { readAudioAsset, readExpectedAudioAsset } from "../storage/audio-assets.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { readSessionAttachmentBytes, type AudioSessionAttachmentRef } from "../storage/attachments.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  audioAssetsFromJobs, audioJobResultText, audioJobViews,
  resumeAudioJob, separateAudioStems,
  type AudioProcessingContext,
} from "./audio-processing.js";
import { audioConnectionFingerprint, captureAudioServiceConnections, resolveAudioService } from "./audio-service-connections.js";
import { generateAudio, retrieveMusic } from "./audio-generation.js";
import { readSunoMusicService } from "../audio-services/suno.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { persistRotatedSunoSession } from "./suno-session-manager.js";

export async function createRequestAudioTools(input: {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  sessionId: string;
  requestId: string;
  attachmentRefs: readonly AudioSessionAttachmentRef[];
  target: LiveTarget;
  signal: AbortSignal;
  onProgress(message: UiMessage): Promise<void> | void;
  onAssets(assets: readonly AudioAsset[]): Promise<void> | void;
  modelAudioInput?: {
    canAccept(byteLength: number): boolean;
  };
  withGenerationAuthorization?: AudioProcessingContext["withGenerationAuthorization"];
  /** Test seam; production uses the saved service and shared network route. */
  processing?: Pick<AudioProcessingContext, "adapter" | "generationAdapter" | "wait"> & {
    musicServiceReader?: typeof readSunoMusicService;
  };
}) {
  const admittedConnections = await captureAudioServiceConnections(input.storageDirectory);
  const services = admittedConnections.map(({ id, name, provider }) => ({ id, name, provider }));
  const jobs = input.storageDirectory ? await listAudioJobs(input.storageDirectory, input.sessionId) : [];
  const observedClips = new Map<string, Set<string>>();
  const rememberClips = (serviceId: string, clips: readonly { id: string }[]) => {
    const observed = observedClips.get(serviceId) ?? new Set<string>();
    for (const clip of clips) observed.add(clip.id);
    observedClips.set(serviceId, observed);
  };
  const rememberJobs = (current: typeof jobs) => {
    for (const job of current) {
      const connection = admittedConnections.find((entry) => entry.id === job.serviceId && entry.provider === "suno");
      if (connection && audioConnectionFingerprint(connection) === job.connectionFingerprint) {
        rememberClips(connection.id, job.remoteOutputs?.map((output) => ({ id: output.key })) ?? []);
      }
    }
  };
  rememberJobs(jobs);
  const assets = new Map<string, AudioAsset>();
  const registerAssets = async (values: readonly AudioAsset[]): Promise<void> => {
    for (const asset of values) assets.set(asset.id, asset);
    await input.onAssets(values);
  };
  await registerAssets(audioAssetsFromJobs(jobs));
  const tools = services.length || jobs.length
    ? audioProcessingTools(services, Boolean(input.modelAudioInput)) : [];
  const processing: AudioProcessingContext = {
    storageDirectory: input.storageDirectory, sessionId: input.sessionId,
    signal: input.signal, onProgress: input.onProgress, ...input.processing,
    admittedConnections,
    ...(input.withGenerationAuthorization ? { withGenerationAuthorization: input.withGenerationAuthorization } : {}),
  };

  const snapshot = async (source: AudioProcessingSource): Promise<{
    bytes: Uint8Array; label: string; origin: AudioOrigin;
  }> => {
    if (source.kind === "request_audio_attachment") {
      if (source.requestId !== input.requestId) throw new Error("Audio attachment locator is not from the current request.");
      const ref = input.attachmentRefs[source.audioIndex];
      if (!ref) throw new Error("Audio attachment is unavailable in this request.");
      const bytes = await readSessionAttachmentBytes(input.storageDirectory, input.sessionId, ref.id, {
        expectedRef: ref, signal: input.signal,
      });
      return { bytes, label: "Audio attachment", origin: { kind: "attachment" } };
    }
    if (source.kind === "audio_asset") {
      const expected = assets.get(source.assetRef);
      if (!expected) throw new Error("Audio asset reference is unavailable. Use list_audio_jobs to read this Session's current results.");
      const { asset, bytes } = await readAudioAsset(input.storageDirectory, input.sessionId, source.assetRef, input.signal);
      if (asset.sha256 !== expected.sha256) throw new Error("Audio asset changed after it was observed.");
      return { bytes, label: asset.label, origin: { ...asset.origin, kind: "asset", sourceAssetId: asset.id } };
    }
    const { kind: _kind, ...locator } = source;
    const tempo = input.context.application.song.tempo;
    const render = await readArrangementAudio(
      input.context, { type: "read_arrangement_audio", ...locator }, input.target,
      input.signal, { maxBytes: MAX_AUDIO_ASSET_BYTES, maxDurationSeconds: MAX_AUDIO_ASSET_DURATION_SECONDS },
    );
    return {
      bytes: render.bytes, label: "Arrangement audio snapshot",
      origin: { kind: "arrangement", startBeat: source.startBeat, endBeat: source.endBeat, tempo },
    };
  };

  return {
    tools,
    async execute(call: ModelToolCall): Promise<AgentExternalToolResult> {
      let request;
      try {
        request = parseAudioToolRequest(call.name, call.arguments);
        validateAudioServiceRequest(request, services);
      } catch {
        return { content: "Invalid audio tool arguments. Use only the declared fields, connection IDs, source references and generation limits.", failed: true, invalidArguments: true };
      }
      try {
        if (request.kind === "list_audio_jobs") {
          const current = await listAudioJobs(input.storageDirectory, input.sessionId);
          rememberJobs(current);
          await registerAssets(audioAssetsFromJobs(current));
          const views = await audioJobViews(input.storageDirectory, input.sessionId);
          return { content: JSON.stringify(views.map((view) => ({ ...view,
            ...musicClipReferences(current.find((job) => job.id === view.id)!) }))), progressKey: JSON.stringify(current.map((job) => [job.id, job.updatedAt])) };
        }
        if (request.kind === "listen_to_audio_asset") {
          const expected = assets.get(request.assetRef);
          if (!expected) {
            return { content: "That audio asset is not available in this Session. Use list_audio_jobs and copy an exact output asset id.",
              failed: true, invalidArguments: true };
          }
          if (!input.modelAudioInput?.canAccept(expected.byteLength)) {
            return { content: "That audio asset cannot fit within this model request's audio input limits. Choose a smaller saved MP3 or continue without listening to it.", failed: true };
          }
          const bytes = await readExpectedAudioAsset(
            input.storageDirectory, input.sessionId, expected, input.signal,
          );
          throwIfAborted(input.signal);
          return {
            content: JSON.stringify({
              assetRef: expected.id,
              label: expected.label,
              durationSeconds: expected.durationSeconds,
              mediaType: expected.mediaType,
              message: "The complete audio asset is attached to this tool result as untrusted audio input.",
            }),
            modelInputPart: {
              type: "audio",
              fileName: `session-audio-${expected.id}.${expected.mediaType === "audio/mpeg" ? "mp3" : "wav"}`,
              mediaType: expected.mediaType,
              base64: Buffer.from(bytes).toString("base64"),
            },
            progressKey: `${expected.id}:${expected.sha256}`,
          };
        }
        if (request.kind === "inspect_music_service") {
          const connection = await resolveAudioService(input.storageDirectory, request.serviceId, "generate_music", admittedConnections);
          if (connection.provider !== "suno" || !connection.sunoSession) throw new Error("Music account unavailable.");
          const { kind: _kind, serviceId: _id, ...query } = request;
          const result = await (input.processing?.musicServiceReader ?? readSunoMusicService)(
            connection.sunoSession,
            query,
            input.signal,
            providerFetchForStorage(input.storageDirectory),
            (previous, next, refreshSignal) => persistRotatedSunoSession(
              input.storageDirectory,
              connection.id,
              connection.sunoSession!.accountId,
              previous,
              next,
              refreshSignal,
            ),
          );
          // Validate the owner again before returning a private account's library.
          await resolveAudioService(input.storageDirectory, request.serviceId, "generate_music", [connection]);
          if (request.query === "library" && "clips" in result) rememberClips(connection.id, result.clips);
          return { content: JSON.stringify(result) };
        }
        const clipIds = request.kind === "retrieve_music" ? request.clipIds
          : request.kind === "extend_music" || request.kind === "get_whole_song" ? [request.clipId] : [];
        if (clipIds.length && "serviceId" in request && clipIds.some((id) => !observedClips.get(request.serviceId)?.has(id))) {
          return { content: "Read this connection's library or saved audio jobs first, then use an observed clip ID.", failed: true, invalidArguments: true };
        }
        const job = request.kind === "resume_audio_job"
          ? await resumeAudioJob(processing, request.jobId)
          : request.kind === "separate_stems"
          ? await separateAudioStems(processing, request.serviceId, request.stems, () => snapshot(request.source))
          : request.kind === "retrieve_music"
          ? await retrieveMusic(processing, request.serviceId, request.clipIds)
          : await generateAudio(processing, request.serviceId, generationRequest(request));
        rememberJobs([job]);
        await registerAssets(job.outputAssets);
        throwIfAborted(input.signal);
        const partialCollection = job.status === "partial" && job.provider === "suno" &&
          audioJobRemoteSettled(job) && !job.failedOutputKeys?.length;
        return {
          content: audioJobResultText(job), progressKey: `${job.id}:${job.updatedAt}`,
          ...(job.status === "unknown" || job.status === "failed" || job.status === "interrupted" || job.status === "partial" && !partialCollection
            ? { failed: true, stop: true } : {}),
        };
      } catch (error) {
        throwIfAborted(input.signal);
        // Never feed a possibly credential-bearing raw cause back to the model.
        return { content: "Audio processing could not complete. Check Audio tools settings and this Session's saved audio jobs before retrying. No Live changes were performed by this tool.", failed: true, stop: true };
      }
    },
  };
}

function musicClipReferences(job: import("../audio-services/contracts.js").AudioJob) {
  return job.provider === "suno" && job.remoteOutputs ? {
    musicClips: job.remoteOutputs.map(({ key, role }) => ({ clipId: key, role })),
  } : {};
}

function generationRequest(request: Extract<AudioToolRequest, { kind: AudioGenerationRequest["operation"] }>): AudioGenerationRequest {
  switch (request.kind) {
    case "generate_music": { const { kind, serviceId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "generate_sound_effect": { const { kind, serviceId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "extend_music": { const { kind, serviceId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "get_whole_song": { const { kind, serviceId: _id, ...fields } = request; return { operation: kind, ...fields }; }
  }
}
