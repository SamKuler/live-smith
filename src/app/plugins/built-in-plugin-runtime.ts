import type { BuiltInAudioHostRuntime, BuiltInAudioPluginDefinition } from "../../plugins/builtins/contracts.js";
import type { AudioJob } from "../../audio-services/contracts.js";
import type { SunoUploadAdapter } from "../../audio-services/suno/suno-upload.js";
import type { AudioProcessingContext } from "../audio/audio-processing.js";
import type { RuntimeIntegrationConnection } from "./integration-connections.js";
import type { AudioParameterGroup } from "../../plugins/builtins/parameter-panel.js";
import type { SessionEvent } from "../../storage/events.js";
import { builtInAudioPluginById } from "../../plugins/builtins/index.js";
import { createAppSunoGenerationAdapter } from "../audio/suno/suno-human-verification.js";
import { persistRotatedSunoSession } from "../audio/suno/suno-session-manager.js";
import { uploadSunoMusic, resumeSunoUpload } from "../audio/suno/suno-upload.js";
import { audioQueryProvenance, observedAudioQueryClipIds, applyAudioParameterSuggestions } from "../audio/suno/suno-parameter-suggestions.js";
import { providerFetchForStorage } from "../model/provider-fetch.js";
import { providerWebSocketForStorage } from "../model/provider-websocket.js";

export function builtInAudioHostRuntime(
  storageDirectory: string | undefined,
  overrides: Partial<BuiltInAudioHostRuntime> = {},
): BuiltInAudioHostRuntime {
  return {
    fetchImpl: providerFetchForStorage(storageDirectory),
    openWebSocket: providerWebSocketForStorage(storageDirectory),
    ...overrides,
  };
}

/** Private overrides exercise the same Plugin methods used by production. */
export interface AudioPluginOverrides {
  plugin?: Partial<Pick<BuiltInAudioPluginDefinition,
    "inspectMusicService" | "writeLyrics" | "inspectLyricModels" | "generateLyrics">>;
  uploadAdapter?: SunoUploadAdapter;
}

export function audioPluginDefinition(context: AudioProcessingContext, connection: RuntimeIntegrationConnection) {
  const plugin = builtInAudioPluginById(connection.pluginId);
  if (!plugin || plugin.provider !== connection.provider) throw new Error("The selected Integration Connection Plugin is unavailable.");
  return context.pluginOverrides?.plugin ? { ...plugin, ...context.pluginOverrides.plugin } : plugin;
}

/** Binds private account state and host facilities at the application composition boundary. */
export function audioPluginHostRuntime(context: AudioProcessingContext, connection: RuntimeIntegrationConnection): BuiltInAudioHostRuntime {
  return builtInAudioHostRuntime(context.storageDirectory, connection.sunoSession ? {
    onCredentialRefresh: (previous, next, signal) => persistRotatedSunoSession(
      context.storageDirectory, connection.id, connection.sunoSession!.accountId, previous, next, signal),
    createGenerationAdapter: (_connection, authorizeDownloads) =>
      createAppSunoGenerationAdapter(context, connection, authorizeDownloads),
  } : {});
}

export function pluginGenerationAdapter(
  context: AudioProcessingContext, connection: RuntimeIntegrationConnection, authorizeDownloads = false,
) {
  if (context.generationAdapter) {
    if (context.generationAdapter.provider !== connection.provider) throw new Error("Audio adapter does not match the selected connection.");
    return context.generationAdapter;
  }
  const plugin = audioPluginDefinition(context, connection);
  if (!plugin.createGenerationAdapter) throw new Error("This Plugin does not expose an audio-generation adapter.");
  return plugin.createGenerationAdapter(connection, audioPluginHostRuntime(context, connection), authorizeDownloads);
}

export function uploadPluginAudio(
  context: AudioProcessingContext, connectionId: string, rightsConfirmed: boolean,
  source: Parameters<typeof uploadSunoMusic>[3],
) {
  return uploadSunoMusic(context, connectionId, rightsConfirmed, source);
}

export function resumePluginAudioUpload(context: AudioProcessingContext, job: AudioJob) {
  return resumeSunoUpload(context, job);
}

export function audioPluginQueryProvenance(connection: RuntimeIntegrationConnection) {
  return connection.sunoSession ? audioQueryProvenance(connection) : { connectionId: connection.id };
}

export function observedAudioPluginClipIds(connection: RuntimeIntegrationConnection, events: readonly SessionEvent[]) {
  return observedAudioQueryClipIds(connection, events);
}

export function applyAudioPluginSuggestions(
  groups: AudioParameterGroup[], connections: readonly RuntimeIntegrationConnection[], jobs: readonly AudioJob[], events: readonly SessionEvent[],
) {
  applyAudioParameterSuggestions(groups, connections, jobs, events);
}
