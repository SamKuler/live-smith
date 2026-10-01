import type { ExtensionContext } from "@ableton-extensions/sdk";
import { Buffer } from "node:buffer";
import type { UiMessage } from "../../i18n/ui-message.js";
import {
  type AudioProcessingSource,
  type AudioToolRequest,
} from "../../agent/audio-tools.js";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import {
  audioJobRemoteSettled, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  type AudioAsset, type AudioOrigin, type AudioGenerationRequest,
} from "../../audio-services/contracts.js";
import { readArrangementAudio } from "../../live/observer.js";
import type { LiveTarget } from "../../live/target.js";
import type { ModelToolCall } from "../../model/contracts.js";
import { createBuiltInAudioToolsets } from "../../plugins/builtins/audio-toolsets.js";
import { builtInAudioPluginById } from "../../plugins/builtins/index.js";
import { ToolRegistry } from "../../plugins/registry.js";
import { readAudioAsset, readExpectedAudioAsset } from "../../storage/audio-assets.js";
import { loadSessionEvents } from "../../storage/events.js";
import { listAudioJobs } from "../../storage/audio-jobs.js";
import { readSessionAttachmentBytes, type AudioSessionAttachmentRef } from "../../storage/attachments.js";
import { throwIfAborted } from "../../runtime/host.js";
import {
  audioAssetsFromJobs, audioJobResultText, audioJobViews,
  resumeAudioJob, separateAudioStems,
  type AudioProcessingContext,
} from "./audio-processing.js";
import { integrationConnectionFingerprint, captureIntegrationConnections, resolveIntegrationConnection } from "../plugins/integration-connections.js";
import { generateAudio, retrieveMusic } from "./audio-generation.js";
import { uploadSunoMusic, SunoUploadOutcomeUnknownError } from "./suno-upload.js";
import { MurekaError } from "../../audio-services/mureka/mureka-http.js";
import { SunoHttpError } from "../../audio-services/suno/suno-http.js";
import { readSunoMusicService } from "../../audio-services/suno/suno.js";
import { SunoLyricsOutcomeUnknownError, type writeSunoLyrics, type readSunoLyricModels } from "../../audio-services/suno/suno-lyrics.js";
import { MurekaLyricsOutcomeUnknownError, type generateMurekaLyrics } from "../../audio-services/mureka/mureka.js";
import { providerFetchForStorage } from "../model/provider-fetch.js";
import { persistRotatedSunoSession } from "./suno-session-manager.js";
import { audioQueryProvenance, observedAudioQueryClipIds } from "./audio-parameter-suggestions.js";
import { builtInAudioHostRuntime } from "../plugins/built-in-plugin-runtime.js";

export async function createRequestAudioTools(input: {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  sessionId: string;
  requestId: string;
  /** Host-owned observations shared only by manual calls in the same Session. */
  observedMusicClips?: Map<string, Set<string>>;
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
  processing?: Pick<AudioProcessingContext, "adapter" | "generationAdapter" | "sunoUploadAdapter" | "wait"> & {
    musicServiceReader?: typeof readSunoMusicService;
    murekaLyricsGenerator?: typeof generateMurekaLyrics;
    sunoLyricsWriter?: typeof writeSunoLyrics;
    sunoLyricModelsReader?: typeof readSunoLyricModels;
  };
}) {
  const admittedConnections = await captureIntegrationConnections(input.storageDirectory);
  const services = admittedConnections.map(({ id, name, pluginId, provider, modelId }) => ({
    id,
    name,
    pluginId,
    provider,
    ...(modelId === undefined ? {} : { modelId }),
  }));
  const jobs = input.storageDirectory ? await listAudioJobs(input.storageDirectory, input.sessionId) : [];
  const observedClips = input.observedMusicClips ?? new Map<string, Set<string>>();
  const observationKeys = new Map(admittedConnections.map((connection) => [connection.id,
    JSON.stringify([connection.id, connection.pluginId, connection.configuration, integrationConnectionFingerprint(connection)]),
  ]));
  const rememberClips = (connectionId: string, clips: readonly { id: string }[]) => {
    const key = observationKeys.get(connectionId)!;
    const observed = observedClips.get(key) ?? new Set<string>();
    for (const clip of clips) observed.add(clip.id);
    observedClips.set(key, observed);
  };
  const rememberJobs = (current: typeof jobs) => {
    for (const job of current) {
      const connection = admittedConnections.find((entry) => entry.id === job.serviceId && entry.provider === "suno");
      if (connection && integrationConnectionFingerprint(connection) === job.connectionFingerprint) {
        rememberClips(connection.id, job.remoteOutputs?.map((output) => ({ id: output.key })) ?? []);
      }
    }
  };
  rememberJobs(jobs);
  if (admittedConnections.some((connection) => connection.provider === "suno")) {
    const events = await loadSessionEvents(input.storageDirectory, input.sessionId);
    for (const connection of admittedConnections) {
      rememberClips(connection.id, observedAudioQueryClipIds(connection, events).map((id) => ({ id })));
    }
  }
  const assets = new Map<string, AudioAsset>();
  const registerAssets = async (values: readonly AudioAsset[]): Promise<void> => {
    for (const asset of values) assets.set(asset.id, asset);
    await input.onAssets(values);
  };
  await registerAssets(audioAssetsFromJobs(jobs));
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

  const executeRequest = async (request: AudioToolRequest): Promise<AgentExternalToolResult> => {
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
          const connection = await resolveIntegrationConnection(input.storageDirectory, request.connectionId, "generate_music", admittedConnections);
          if (connection.provider !== "suno" || !connection.sunoSession) throw new Error("Music account unavailable.");
          const { kind: _kind, connectionId: _id, ...query } = request;
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
          await resolveIntegrationConnection(input.storageDirectory, request.connectionId, "generate_music", [connection]);
          if (request.query === "library" && "clips" in result) rememberClips(connection.id, result.clips);
          return { content: JSON.stringify({ ...result, provenance: audioQueryProvenance(connection) }) };
        }
        if (request.kind === "write_lyrics" || request.kind === "inspect_lyric_models") {
          const connection = await resolveIntegrationConnection(input.storageDirectory, request.connectionId, "generate_music", admittedConnections);
          const plugin = builtInAudioPluginById(connection.pluginId);
          if (!plugin || !connection.sunoSession) throw new Error("Lyric-writing account unavailable.");
          const runtime = builtInAudioHostRuntime(input.storageDirectory, {
            onSunoSessionRefresh: (previous, next, signal) => persistRotatedSunoSession(
              input.storageDirectory, connection.id, connection.sunoSession!.accountId, previous, next, signal),
          });
          if (request.kind === "inspect_lyric_models") {
            if (!plugin.inspectLyricModels) throw new Error("Lyric model catalog unavailable.");
            const result = input.processing?.sunoLyricModelsReader
              ? await input.processing.sunoLyricModelsReader(connection.sunoSession, input.signal)
              : await plugin.inspectLyricModels(connection, input.signal, runtime);
            await resolveIntegrationConnection(input.storageDirectory, connection.id, "generate_music", [connection]);
            return { content: JSON.stringify({ ...result, provenance: audioQueryProvenance(connection) }) };
          }
          if (!plugin.writeLyrics || !input.withGenerationAuthorization) throw new Error("Lyric-writing authorization unavailable.");
          const { kind: _kind, connectionId: _id, ...fields } = request;
          const result = await input.withGenerationAuthorization(input.signal, async () => {
            const current = await resolveIntegrationConnection(input.storageDirectory, connection.id, "generate_music", [connection]);
            throwIfAborted(input.signal);
            return input.processing?.sunoLyricsWriter
              ? input.processing.sunoLyricsWriter(current.sunoSession!, fields, input.signal)
              : plugin.writeLyrics!(current, fields, input.signal, runtime);
          });
          // Preserve a confirmed paid text receipt even when Stop raced its response.
          return { content: JSON.stringify(result) };
        }
        if (request.kind === "generate_lyrics") {
          const connection = await resolveIntegrationConnection(
            input.storageDirectory,
            request.connectionId,
            "generate_music",
            admittedConnections,
          );
          const plugin = builtInAudioPluginById(connection.pluginId);
          if (!plugin || plugin.provider !== connection.provider || !plugin.generateLyrics) {
            throw new Error("This Plugin does not expose lyrics generation.");
          }
          if (!input.withGenerationAuthorization) throw new Error("Generation authorization unavailable.");
          const result = await input.withGenerationAuthorization(input.signal, async () => {
            const current = await resolveIntegrationConnection(
              input.storageDirectory,
              request.connectionId,
              "generate_music",
              [connection],
            );
            if (current.pluginId !== plugin.id) throw new Error("The Integration Connection Plugin changed.");
            throwIfAborted(input.signal);
            return input.processing?.murekaLyricsGenerator
              ? input.processing.murekaLyricsGenerator(
                  current.apiKey,
                  request.prompt,
                  input.signal,
                  { fetchImpl: providerFetchForStorage(input.storageDirectory) },
                )
              : plugin.generateLyrics!(
                  current,
                  request.prompt,
                  input.signal,
                  builtInAudioHostRuntime(input.storageDirectory),
                );
          });
          // Retain the confirmed paid text result if Stop arrived with its receipt.
          return { content: JSON.stringify(result) };
        }
        const clipIds = request.kind === "retrieve_music" ? request.clipIds
          : request.kind === "extend_music" || request.kind === "get_whole_song" || request.kind === "cover_music" || request.kind === "remaster_music" || request.kind === "add_vocals" || request.kind === "add_instrumental" || request.kind === "replace_music_section" || request.kind === "finish_music_replacement" || request.kind === "extract_music_stems" ? [request.clipId] : [];
        if (clipIds.length && "connectionId" in request && clipIds.some((id) => !observedClips.get(observationKeys.get(request.connectionId)!)?.has(id))) {
          return { content: "Read this connection's library or saved audio jobs first, then use an observed clip ID.", failed: true, invalidArguments: true };
        }
        const job = request.kind === "resume_audio_job"
          ? await resumeAudioJob(processing, request.jobId)
          : request.kind === "upload_music"
          ? await uploadSunoMusic(processing, request.connectionId, request.rightsConfirmed, () => snapshot(request.source))
          : request.kind === "separate_stems"
          ? await separateAudioStems(processing, request.connectionId, request.stems, () => snapshot(request.source))
          : request.kind === "retrieve_music"
          ? await retrieveMusic(processing, request.connectionId, request.clipIds)
          : await generateAudio(processing, request.connectionId, generationRequest(request));
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
      if (error instanceof SunoLyricsOutcomeUnknownError || error instanceof MurekaLyricsOutcomeUnknownError || error instanceof SunoUploadOutcomeUnknownError) return {
        content: JSON.stringify({ status: "unknown", message: error.message }), failed: true, stop: true,
      };
      if ((error instanceof MurekaError || error instanceof SunoHttpError) && error.status !== undefined &&
          error.status >= 400 && error.status < 500 && error.status !== 408) return {
        content: JSON.stringify({ status: "failed", message: error.message }), failed: true, stop: true,
      };
      throwIfAborted(input.signal);
      // Never feed a possibly credential-bearing raw cause back to the model.
      return { content: "Audio processing could not complete. Check Connections settings and this Session's saved audio jobs before retrying. No Live changes were performed by this tool.", failed: true, stop: true };
    }
  };
  const toolsets = services.length || jobs.length
    ? createBuiltInAudioToolsets({
        services,
        includeModelAudioInput: Boolean(input.modelAudioInput),
        execute: executeRequest,
      })
    : [];
  const registry = new ToolRegistry(toolsets);
  return {
    toolsets,
    tools: registry.tools(),
    execute(call: ModelToolCall) {
      return registry.callTool(call);
    },
  };
}

function musicClipReferences(job: import("../../audio-services/contracts.js").AudioJob) {
  return job.provider === "suno" && job.remoteOutputs ? {
    musicClips: job.remoteOutputs.map(({ key, role }) => ({ clipId: key, role })),
  } : {};
}

function generationRequest(request: Extract<AudioToolRequest, { kind: AudioGenerationRequest["operation"] }>): AudioGenerationRequest {
  switch (request.kind) {
    case "generate_music": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "generate_sound_effect": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "generate_song_from_lyrics": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "generate_sound_sample": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "cover_music": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "remaster_music": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "add_vocals": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "add_instrumental": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "replace_music_section": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "finish_music_replacement": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "extend_music": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "extract_music_stems": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
    case "get_whole_song": { const { kind, connectionId: _id, ...fields } = request; return { operation: kind, ...fields }; }
  }
}
