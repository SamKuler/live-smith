import type { AudioJobView, AudioServiceConnectionView } from "../audio-services/contracts.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import type {
  IntegrationConnectionView,
  IntegrationConnectionsSettingsPatch,
} from "../plugins/integration-connections.js";
import { commandCalls, createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";

export const service: AudioServiceConnectionView = {
  id: "audio-work", name: "Work separation", provider: "lalal", enabled: true, apiKeyConfigured: true,
};
export const musicService: AudioServiceConnectionView = {
  id: "audio-music", name: "Music studio", provider: "elevenlabs", enabled: true, apiKeyConfigured: true, modelId: "music_v2",
};
export const sunoService: AudioServiceConnectionView = {
  id: "audio-sunoapi", name: "Third-party studio", provider: "sunoapi", enabled: true,
  apiKeyConfigured: true, callbackUrl: "https://hooks.example.com/music", modelId: "V4_5ALL",
};
export function integrationConnectionView(
  connection: AudioServiceConnectionView,
): IntegrationConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    pluginId: builtInAudioPluginId(connection.provider),
    enabled: connection.enabled,
    configuration: {
      ...(connection.modelId === undefined ? {} : { modelId: connection.modelId }),
      ...(connection.callbackUrl === undefined ? {} : { callbackUrl: connection.callbackUrl }),
    },
    configuredSecrets: connection.apiKeyConfigured ? ["apiKey"] : [],
  };
}
export function audioState(connections = [service]) {
  const state = stateFixture();
  state.integrationConnections = {
    connections: connections.map(integrationConnectionView),
    revision: "1",
  };
  return state;
}
export function job(sessionId: string, overrides: Partial<AudioJobView> = {}): AudioJobView {
  return { id: "job-one", serviceId: service.id, provider: service.provider, operation: "separate_stems",
    status: "partial", stems: ["vocals"], createdAt: "2026-09-07T00:00:00.000Z",
    resumable: true, outputs: [{ id: "asset-one", sessionId, jobId: "job-one", label: "Vocals <img src=x>",
      role: "vocals", mediaType: "audio/wav", byteLength: 64_000_000, durationSeconds: 899,
      sha256: "a".repeat(64), sampleRate: 44100, channels: 2, origin: { kind: "arrangement", startBeat: 0, endBeat: 64 } }],
    ...overrides };
}
export type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
export function selectAudioService(harness: Harness, id: string) {
  const button = [...harness.document.querySelectorAll<HTMLButtonElement>("[data-audio-service-id]")]
    .find((entry) => entry.dataset.audioServiceId === id);
  if (!button) throw new Error("Expected an audio connection row");
  button.click();
}
export function selectedAudioService(harness: Harness): string {
  return harness.document.querySelector<HTMLElement>('[data-audio-service-id][aria-pressed="true"]')?.dataset.audioServiceId ?? "";
}
export function toggle(harness: Harness, enabled: boolean) {
  const input = harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!;
  input.checked = enabled;
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
}
export function audioCommands(harness: Harness) {
  return commandCalls(harness).map((call) => call.body as { kind: string; integrationConnections?: IntegrationConnectionsSettingsPatch })
    .filter((body): body is { kind: string; integrationConnections: IntegrationConnectionsSettingsPatch } => Boolean(body.integrationConnections));
}
export function broadcast(state: ReturnType<typeof stateFixture>, integrationConnections: unknown) {
  return { type: "global_settings_changed", commandId: "peer-audio-save",
    defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
    showContextUsage: state.settings.showContextUsage,
    contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
    networkProxy: state.settings.networkProxy, networkProxyRevision: state.settings.networkProxyRevision,
    uiLanguage: state.settings.uiLanguage, uiLanguageRevision: state.settings.uiLanguageRevision, integrationConnections };
}
