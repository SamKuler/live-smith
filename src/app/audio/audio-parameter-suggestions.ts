import type { AudioJob } from "../../audio-services/contracts.js";
import type { SessionEvent } from "../../storage/events.js";
import { builtInAudioToolName } from "../../plugins/builtins/audio-toolsets.js";
import { sunoWebsitePlugin } from "../../plugins/builtins/suno-website.js";
import { MAX_AUDIO_PARAMETER_SUGGESTIONS, type AudioParameterGroup, type AudioParameterSuggestion } from "../../plugins/builtins/parameter-panel.js";
import { integrationConnectionFingerprint, type RuntimeIntegrationConnection } from "../plugins/integration-connections.js";

type SuggestionMap = Map<string, AudioParameterSuggestion>;
const clipIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Public query provenance is supplied by the host after checking the saved connection. */
export function audioQueryProvenance(connection: RuntimeIntegrationConnection) {
  return { connectionId: connection.id, accountId: connection.sunoSession!.accountId,
    ...(connection.modelId === undefined ? {} : { modelId: connection.modelId }) };
}

export function* currentAudioQueryResults(connection: RuntimeIntegrationConnection, events: readonly SessionEvent[]) {
  if (connection.provider !== "suno" || !connection.sunoSession) return;
  const musicQuery = builtInAudioToolName(sunoWebsitePlugin, "inspect_music_service");
  const lyricQuery = builtInAudioToolName(sunoWebsitePlugin, "inspect_lyric_models");
  for (const event of events) {
    if (event.kind !== "tool_result" || event.name !== musicQuery && event.name !== lyricQuery) continue;
    let value: unknown;
    try { value = JSON.parse(event.content); } catch { continue; }
    if (!record(value) || !record(value.provenance) || value.provenance.connectionId !== connection.id ||
        value.provenance.accountId !== connection.sunoSession.accountId || value.provenance.modelId !== connection.modelId) continue;
    if (event.name === musicQuery ? !["catalog", "library", "persona"].includes(String(value.query)) : value.query !== "lyric_models") continue;
    yield value;
  }
}

export function observedAudioQueryClipIds(connection: RuntimeIntegrationConnection, events: readonly SessionEvent[]): string[] {
  const ids = new Set<string>();
  for (const value of currentAudioQueryResults(connection, events)) {
    if (value.query === "library" && Array.isArray(value.clips)) {
      for (const clip of value.clips) if (record(clip) && typeof clip.id === "string" && clipIdPattern.test(clip.id)) ids.add(clip.id);
    }
  }
  return [...ids];
}

/** Historical text without a matching, host-authored owner is never a parameter suggestion. */
export function applyAudioParameterSuggestions(
  groups: AudioParameterGroup[], connections: readonly RuntimeIntegrationConnection[], jobs: readonly AudioJob[], events: readonly SessionEvent[],
): void {
  for (const connection of connections) {
    if (connection.provider !== "suno" || !connection.sunoSession) continue;
    const clips: SuggestionMap = new Map(), models: SuggestionMap = new Map(), remasters: SuggestionMap = new Map();
    const lyrics: SuggestionMap = new Map(), personas: SuggestionMap = new Map();
    const add = (target: SuggestionMap, id: unknown, label: unknown, uuid = false) => {
      if (typeof id !== "string" || !(uuid ? clipIdPattern : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).test(id)) return;
      target.delete(id);
      target.set(id, { id, label: typeof label === "string" ? Array.from(label.replace(/[\u0000-\u001f\u007f]/gu, " ")).slice(0, 160).join("") : id });
      if (target.size > MAX_AUDIO_PARAMETER_SUGGESTIONS) target.delete(target.keys().next().value!);
    };
    const fingerprint = integrationConnectionFingerprint(connection);
    for (const job of [...jobs].reverse()) {
      if (job.serviceId === connection.id && job.connectionFingerprint === fingerprint) {
        for (const output of job.remoteOutputs ?? []) add(clips, output.key, job.title, true);
      }
    }
    for (const value of currentAudioQueryResults(connection, events)) {
      if (value.query === "library" && Array.isArray(value.clips)) {
        for (const clip of value.clips) if (record(clip)) add(clips, clip.id, clip.title, true);
      }
      if (value.query === "persona" && record(value.persona)) add(personas, value.persona.id, value.persona.name, true);
      if (value.query === "catalog") {
        models.clear(); remasters.clear();
        for (const [source, target] of [[value.models, models], [value.remasterModels, remasters]] as const) {
          if (Array.isArray(source)) for (const model of source) if (record(model) && model.canUse === true) add(target, model.id, model.name);
        }
      }
      if (value.query === "lyric_models" && Array.isArray(value.models)) {
        lyrics.clear();
        for (const model of value.models) if (record(model)) add(lyrics, model.id, model.name);
      }
    }
    for (const group of groups) {
      if (group.connectionId !== connection.id) continue;
      for (const tool of group.tools) {
        const panel = tool.audioPanel;
        if (!panel) continue;
        const fields = new Set<string>();
        const visit = (schema: unknown) => {
          if (!record(schema)) return;
          if (record(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) { fields.add(name); visit(child); }
          if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(visit);
          if (schema.items) visit(schema.items);
        };
        visit(panel.schema);
        const selectedModels = panel.toolName.endsWith("write_lyrics") ? lyrics : panel.toolName.endsWith("remaster_music") ? remasters : models;
        const suggestions = {
          ...(fields.has("clipId") || fields.has("clipIds") ? { clips: [...clips.values()] } : {}),
          ...(fields.has("modelId") ? { models: [...selectedModels.values()] } : {}),
          ...(fields.has("personaId") ? { personas: [...personas.values()] } : {}),
        };
        if (Object.keys(suggestions).length) panel.suggestions = suggestions;
      }
    }
  }
}
