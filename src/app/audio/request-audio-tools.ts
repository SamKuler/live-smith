import type { ExtensionContext } from "@ableton-extensions/sdk";
import { Buffer } from "node:buffer";
import type { UiMessage } from "../../i18n/ui-message.js";
import {
  isAudioTextToolRequest,
  type AudioProcessingSource,
  type AudioToolRequest,
} from "../../agent/audio-tool-parser.js";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import {
  audioJobRemoteSettled, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  AudioToolOutcomeUnknownError, AudioServiceHttpError,
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
import {
  audioPluginDefinition, audioPluginHostRuntime, uploadPluginAudio,
  audioPluginQueryProvenance, observedAudioPluginClipIds,
} from "../plugins/built-in-plugin-runtime.js";

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
  processing?: Pick<AudioProcessingContext, "adapter" | "generationAdapter" | "pluginOverrides" | "wait">;
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
      const connection = admittedConnections.find((entry) => entry.id === job.serviceId && builtInAudioPluginById(entry.pluginId)?.audio.musicLibrary);
      if (connection && integrationConnectionFingerprint(connection) === job.connectionFingerprint) {
        rememberClips(connection.id, job.remoteOutputs?.map((output) => ({ id: output.key })) ?? []);
      }
    }
  };
  rememberJobs(jobs);
  if (admittedConnections.some((connection) => builtInAudioPluginById(connection.pluginId)?.audio.musicLibrary)) {
    const events = await loadSessionEvents(input.storageDirectory, input.sessionId);
    for (const connection of admittedConnections) {
      rememberClips(connection.id, observedAudioPluginClipIds(connection, events).map((id) => ({ id })));
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
          const plugin = audioPluginDefinition(processing, connection);
          if (!plugin.inspectMusicService) throw new Error("Music account unavailable.");
          const { kind: _kind, connectionId: _id, ...query } = request;
          const result = await plugin.inspectMusicService(
            connection, query, input.signal, audioPluginHostRuntime(processing, connection),
          );
          // Validate the owner again before returning a private account's library.
          await resolveIntegrationConnection(input.storageDirectory, request.connectionId, "generate_music", [connection]);
          if (request.query === "library" && "clips" in result) rememberClips(connection.id, result.clips);
          return { content: JSON.stringify({ ...result, provenance: audioPluginQueryProvenance(connection) }) };
        }
        if (isAudioTextToolRequest(request)) {
          const connection = await resolveIntegrationConnection(input.storageDirectory, request.connectionId, "generate_music", admittedConnections);
          const plugin = audioPluginDefinition(processing, connection);
          const invocation = plugin.textTool?.(request);
          if (!invocation) throw new Error("This Plugin does not expose the requested text tool.");
          if (invocation.kind === "read") {
            const result = await invocation.run(connection, input.signal, audioPluginHostRuntime(processing, connection));
            await resolveIntegrationConnection(input.storageDirectory, connection.id, "generate_music", [connection]);
            return { content: JSON.stringify({ ...result, provenance: audioPluginQueryProvenance(connection) }) };
          }
          if (!input.withGenerationAuthorization) throw new Error("Generation authorization unavailable.");
          const result = await input.withGenerationAuthorization(input.signal, async () => {
            const current = await resolveIntegrationConnection(input.storageDirectory, connection.id, "generate_music", [connection]);
            throwIfAborted(input.signal);
            return invocation.run(current, input.signal, audioPluginHostRuntime(processing, current));
          });
          // Preserve a confirmed paid text receipt even when Stop raced its response.
          return { content: JSON.stringify(result) };
        }
        const clipIds = request.kind === "retrieve_music" ? request.clipIds
          : "clipId" in request ? [request.clipId] : [];
        if (clipIds.length && "connectionId" in request && clipIds.some((id) => !observedClips.get(observationKeys.get(request.connectionId)!)?.has(id))) {
          return { content: "Read this connection's library or saved audio jobs first, then use an observed clip ID.", failed: true, invalidArguments: true };
        }
        const job = request.kind === "resume_audio_job"
          ? await resumeAudioJob(processing, request.jobId)
          : request.kind === "upload_music"
          ? await uploadPluginAudio(processing, request.connectionId, request.rightsConfirmed, () => snapshot(request.source))
          : request.kind === "separate_stems"
          ? await separateAudioStems(processing, request.connectionId, request.stems, () => snapshot(request.source))
          : request.kind === "retrieve_music"
          ? await retrieveMusic(processing, request.connectionId, request.clipIds)
          : await generateAudio(processing, request.connectionId, generationRequest(request));
        rememberJobs([job]);
        await registerAssets(job.outputAssets);
        throwIfAborted(input.signal);
        const partialCollection = job.status === "partial" && job.remoteOutputs !== undefined &&
          audioJobRemoteSettled(job) && !job.failedOutputKeys?.length;
        return {
          content: audioJobResultText(job), progressKey: `${job.id}:${job.updatedAt}`,
          ...(job.status === "unknown" || job.status === "failed" || job.status === "interrupted" || job.status === "partial" && !partialCollection
            ? { failed: true, stop: true } : {}),
        };
    } catch (error) {
      if (error instanceof AudioToolOutcomeUnknownError) return {
        content: JSON.stringify({ status: "unknown", message: error.message }), failed: true, stop: true,
      };
      if (error instanceof AudioServiceHttpError && error.status !== undefined &&
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
  return job.remoteOutputs ? {
    musicClips: job.remoteOutputs.map(({ key, role }) => ({ clipId: key, role })),
  } : {};
}

function generationRequest(request: Extract<AudioToolRequest, { kind: AudioGenerationRequest["operation"] }>): AudioGenerationRequest {
  const { kind, connectionId: _id, ...fields } = request;
  // The request union and protocol union use the same fields with a renamed discriminator.
  return { operation: kind, ...fields } as AudioGenerationRequest;
}
