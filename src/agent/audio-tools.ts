import { SEPARATION_STEMS, type SeparationStem, type MusicGenerationOptions } from "../audio-services/contracts.js";
import { musicOptionsSchema, musicServiceTools, parseMusicOptions, parseMusicServiceRequest, type MusicServiceRequest } from "./music-tools.js";
import { AUDIO_SERVICE_CAPABILITIES, audioServiceSupports, type AudioServiceChoice } from "../audio-services/capabilities.js";
import { exceedsAudioPromptLimit } from "../audio-services/prompt.js";
import type { ModelFunctionTool } from "../model/provider.js";
import { isSafeStorageId } from "../storage/id.js";

export type AudioProcessingSource =
  | { kind: "request_audio_attachment"; requestId: string; audioIndex: number }
  | { kind: "audio_asset"; assetRef: string }
  | {
      kind: "arrangement_audio"; trackName?: string; clipName?: string;
      clipStartBeat?: number; startBeat: number; endBeat: number;
    };

export type AudioToolRequest =
  | MusicServiceRequest
  | { kind: "separate_stems"; serviceId: string; source: AudioProcessingSource; stems: SeparationStem[] }
  | { kind: "generate_music"; serviceId: string; prompt: string; durationSeconds?: number; instrumental: boolean; options?: MusicGenerationOptions }
  | { kind: "generate_sound_effect"; serviceId: string; prompt: string; durationSeconds: number; loop: boolean }
  | { kind: "listen_to_audio_asset"; assetRef: string }
  | { kind: "list_audio_jobs" }
  | { kind: "resume_audio_job"; jobId: string };

const stringField = { type: "string", minLength: 1, maxLength: 128 };
const sourceSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: { kind: { const: "request_audio_attachment" }, requestId: stringField, audioIndex: { type: "integer", minimum: 0, maximum: 1 } },
      required: ["kind", "requestId", "audioIndex"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { kind: { const: "audio_asset" }, assetRef: stringField },
      required: ["kind", "assetRef"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        kind: { const: "arrangement_audio" }, trackName: stringField, clipName: stringField,
        clipStartBeat: { type: "number" }, startBeat: { type: "number" }, endBeat: { type: "number" },
      },
      required: ["kind", "startBeat", "endBeat"],
    },
  ],
};

export function audioProcessingTools(
  services: readonly AudioServiceChoice[],
  includeModelAudioInput = false,
): ModelFunctionTool[] {
  const separation = services.filter((entry) => audioServiceSupports(entry.provider, "separate_stems"));
  return [
    ...(separation.length ? [{
      type: "function" as const,
      function: {
        name: "separate_stems",
        description: "Separate an exact audio source into selected instrument stems plus the residual mix when separation is part of the user's requested workflow. This uploads chosen audio and consumes processing minutes for each requested stem. It saves local results without changing Live. Inspect Arrangement Clip state first; range must lie within one isolated Clip. Current attachment and saved asset locators come from host context. Long processing waits inside the tool; do not submit duplicates. " + describeServices(separation),
        parameters: {
          type: "object", additionalProperties: false,
          properties: { serviceId: serviceSchema(separation), source: sourceSchema, stems: { type: "array", minItems: 1, maxItems: SEPARATION_STEMS.length, uniqueItems: true, items: { type: "string", enum: [...SEPARATION_STEMS] } } },
          required: ["serviceId", "source", "stems"],
        },
      },
    }] : []),
    ...generationTools(services),
    ...musicServiceTools(services),
    ...(includeModelAudioInput ? [{
      type: "function" as const,
      function: {
        name: "listen_to_audio_asset",
        description: "Listen to one locally saved audio result from this Session using the active model's verified audio-input capability. Use only when the user asks to hear, analyze, compare, transcribe, or reason about that audio. First use list_audio_jobs and copy an exact output asset id as assetRef. This reads local audio only; it does not download remote audio, spend provider allowance, or change Live.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { assetRef: stringField }, required: ["assetRef"],
        },
      },
    }] : []),
    {
      type: "function" as const,
      function: {
        name: "resume_audio_job",
        description: "Recover an existing audio job using a jobId from list_audio_jobs. Fully saved audio can finish local recovery without an enabled connection or remote ticket. Retrieving missing outputs requires the original saved connection and a confirmed remote task ID. Never resubmits processing or changes Live; a lost provider response cannot be regenerated through this tool.",
        parameters: { type: "object", properties: { jobId: stringField }, required: ["jobId"], additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "list_audio_jobs",
        description: "List this Session's saved audio processing jobs and verified result asset references, including previous requests. Results include snapshot origins, not permission to change Live. Use an output's id as assetRef in an audio_asset SampleSource, a subsequent audio processing call, or listen_to_audio_asset when that tool is available. This only reads local state.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
}

function describeServices(services: readonly AudioServiceChoice[]): string {
  return "Available connections (IDs, user-defined labels, and configured model IDs): " + JSON.stringify(services);
}

function serviceSchema(services: readonly AudioServiceChoice[]) {
  return { type: "string", enum: services.map((entry) => entry.id) };
}

function generationTools(services: readonly AudioServiceChoice[]): ModelFunctionTool[] {
  return (["generate_music", "generate_sound_effect"] as const).flatMap((operation) => {
    const eligible = services.filter((entry) => audioServiceSupports(entry.provider, operation));
    if (!eligible.length) return [];
    const music = operation === "generate_music";
    return [{ type: "function" as const, function: {
      name: operation,
      description: (music
        ? "Create rendered audio through an external music service when rendered audio is part of the user's requested deliverable. This does not create or edit Live tracks, MIDI, devices, Scenes, or the Arrangement."
        : "Generate a sound effect from a description.") +
        (music ? " On connections whose schema offers options, options.mode=custom makes prompt literal lyrics (empty for instrumentals); use only the option fields advertised for the selected connection. Without options, prompt is a description, at most 3000 characters on Suno. Do not claim unsupported Sounds, Cover, Mashup or voice enrollment." : "") +
        " Uses the selected service's paid generation allowance. Generate the result or variants the user requested; do not add unrequested paid calls. Saves audio results without changing Live. Do not repeat a call after an unknown outcome or retry on another account. " + describeServices(eligible),
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          serviceId: serviceSchema(eligible), prompt: { type: "string", minLength: music && eligible.some((service) => AUDIO_SERVICE_CAPABILITIES[service.provider].customMusic) ? 0 : 1, maxLength: music ? 5000 : 4100 },
          ...(music && eligible.some((service) => AUDIO_SERVICE_CAPABILITIES[service.provider].customMusic)
            ? { options: musicOptionsSchemaForServices(eligible) } : {}),
          ...(!music || eligible.some((service) => AUDIO_SERVICE_CAPABILITIES[service.provider].musicDuration)
            ? { durationSeconds: music ? combinedMusicDurationSchema(eligible) : soundEffectDurationSchema } : {}),
          ...(music ? { instrumental: { type: "boolean" } } : { loop: { type: "boolean" } }),
        },
        required: music ? ["serviceId", "prompt", "instrumental"] : ["serviceId", "prompt", "durationSeconds", "loop"],
        oneOf: eligible.flatMap((service) => (music && AUDIO_SERVICE_CAPABILITIES[service.provider].customMusic ? [false, true] : [false]).map((custom) => ({
          type: "object", additionalProperties: false,
          properties: {
            serviceId: { const: service.id }, prompt: { type: "string", minLength: custom ? 0 : 1,
              maxLength: music ? AUDIO_SERVICE_CAPABILITIES[service.provider].customMusic && !custom ? 3000 : AUDIO_SERVICE_CAPABILITIES[service.provider].musicPromptCharacters : 4100 },
            ...(custom ? { options: musicOptionsSchemaFor(service.provider) } : {}),
            ...(!music || AUDIO_SERVICE_CAPABILITIES[service.provider].musicDuration
              ? { durationSeconds: music ? musicDurationSchema(service) : soundEffectDurationSchema } : {}),
            ...(music ? { instrumental: musicInstrumentalSchema(service) } : { loop: { type: "boolean" } }),
          },
          required: music ? ["serviceId", "prompt", "instrumental", ...(custom ? ["options"] : [])] : ["serviceId", "prompt", "durationSeconds", "loop"],
        }))),
      },
    } }];
  });
}

export function validateAudioServiceRequest(request: AudioToolRequest, services: readonly AudioServiceChoice[]): void {
  if (request.kind === "list_audio_jobs" || request.kind === "resume_audio_job" ||
    request.kind === "listen_to_audio_asset") return;
  const service = services.find((entry) => entry.id === request.serviceId);
  if (request.kind === "inspect_music_service") {
    if (!service || !AUDIO_SERVICE_CAPABILITIES[service.provider].musicLibrary) throw new Error("Music library unavailable.");
    return;
  }
  if (!service || !audioServiceSupports(service.provider, request.kind)) throw new Error("Unavailable audio connection or operation.");
  const capability = AUDIO_SERVICE_CAPABILITIES[service.provider];
  if (request.kind === "generate_music" && request.options && !capability.customMusic) throw new Error("Custom music parameters are unavailable.");
  if (request.kind === "generate_music" && request.options && Object.keys(request.options).some((field) =>
    field !== "mode" && !capability.customMusicOptions?.includes(field as Exclude<keyof typeof request.options, "mode">))) {
    throw new Error("This connection does not support one or more custom music parameters.");
  }
  if (request.kind === "generate_music" && request.options && capability.requiredCustomMusicOptions?.some((field) =>
    request.options?.[field] === undefined)) throw new Error("This connection requires another custom music parameter.");
  if (request.kind === "generate_music" && capability.customMusic && !request.options && exceedsAudioPromptLimit(request.prompt, 3000)) throw new Error("Description exceeds 3000 characters.");
  if (request.kind === "generate_music" && (exceedsAudioPromptLimit(request.prompt, capability.musicPromptCharacters) ||
    (!capability.musicDuration && request.durationSeconds !== undefined))) {
    throw new Error("This connection does not support those music generation parameters.");
  }
  if (request.kind === "generate_music" && request.durationSeconds !== undefined && capability.musicDuration &&
    (request.durationSeconds < capability.musicDuration.minimumSeconds ||
      request.durationSeconds > capability.musicDuration.maximumSeconds)) {
    throw new Error("Music generation duration is outside this connection's supported range.");
  }
  if (request.kind === "generate_music" && request.durationSeconds !== undefined && service.modelId) {
    const fixed = capability.fixedMusicDurationSecondsByModel?.[service.modelId];
    if (fixed !== undefined && request.durationSeconds !== fixed) {
      throw new Error(`The selected music model always generates ${fixed} seconds.`);
    }
  }
  if (request.kind === "generate_music" && !request.instrumental && service.modelId &&
    capability.instrumentalOnlyModelIds?.includes(service.modelId)) {
    throw new Error("The selected music model supports instrumental generation only.");
  }
}

const soundEffectDurationSchema = { type: "number", minimum: 0.5, maximum: 30 };

function musicDurationSchema(service: AudioServiceChoice) {
  const capability = AUDIO_SERVICE_CAPABILITIES[service.provider];
  const fixed = service.modelId && capability.fixedMusicDurationSecondsByModel?.[service.modelId];
  if (fixed !== undefined) return { type: "number", const: fixed };
  const range = capability.musicDuration!;
  return { type: "number", minimum: range.minimumSeconds, maximum: range.maximumSeconds };
}

function musicInstrumentalSchema(service: AudioServiceChoice) {
  return service.modelId && AUDIO_SERVICE_CAPABILITIES[service.provider].instrumentalOnlyModelIds?.includes(service.modelId)
    ? { type: "boolean", const: true }
    : { type: "boolean" };
}

function combinedMusicDurationSchema(services: readonly AudioServiceChoice[]) {
  const ranges = services.flatMap((service) => {
    const range = AUDIO_SERVICE_CAPABILITIES[service.provider].musicDuration;
    return range ? [range] : [];
  });
  return {
    type: "number",
    minimum: Math.min(...ranges.map((range) => range.minimumSeconds)),
    maximum: Math.max(...ranges.map((range) => range.maximumSeconds)),
  };
}

function musicOptionsSchemaFor(provider: AudioServiceChoice["provider"]) {
  const capability = AUDIO_SERVICE_CAPABILITIES[provider];
  return filteredMusicOptionsSchema(capability.customMusicOptions ?? [], capability.requiredCustomMusicOptions);
}

function musicOptionsSchemaForServices(services: readonly AudioServiceChoice[]) {
  return filteredMusicOptionsSchema(services.flatMap((service) =>
    [...AUDIO_SERVICE_CAPABILITIES[service.provider].customMusicOptions ?? []]));
}

function filteredMusicOptionsSchema(fields: readonly string[], required: readonly string[] = []) {
  const allowed = new Set(fields);
  return {
    ...musicOptionsSchema,
    required: ["mode", ...required],
    properties: Object.fromEntries(Object.entries(musicOptionsSchema.properties)
      .filter(([field]) => field === "mode" || allowed.has(field))),
  };
}

export function parseAudioToolRequest(name: string, argumentsJson: string): AudioToolRequest {
  const args: unknown = JSON.parse(argumentsJson || "{}");
  if (["inspect_music_service", "extend_music", "get_whole_song", "retrieve_music"].includes(name)) return parseMusicServiceRequest(name, args);
  if (name === "listen_to_audio_asset") {
    const value = record(args); only(value, ["assetRef"]);
    return { kind: name, assetRef: id(value.assetRef) };
  }
  if (name === "list_audio_jobs") {
    const value = record(args); only(value, []);
    return { kind: name };
  }
  if (name === "resume_audio_job") {
    const value = record(args); only(value, ["jobId"]);
    return { kind: name, jobId: id(value.jobId) };
  }
  if (name === "generate_music" || name === "generate_sound_effect") {
    const value = record(args);
    const music = name === "generate_music";
    only(value, ["serviceId", "prompt", "durationSeconds", music ? "instrumental" : "loop", ...(music ? ["options"] : [])]);
    const options = music && value.options !== undefined ? parseMusicOptions(value.options) : undefined;
    if (typeof value.prompt !== "string" || (!value.prompt.trim() && !(options && value.instrumental === true)) || exceedsAudioPromptLimit(value.prompt, options ? 5000 : 4100) || value.prompt.includes("\0")) {
      throw new Error("Invalid audio generation prompt.");
    }
    const option = music ? value.instrumental : value.loop;
    if (typeof option !== "boolean") throw new Error("Invalid audio generation option.");
    const duration = value.durationSeconds === undefined && music ? undefined : number(value.durationSeconds);
    if (duration !== undefined && (duration < (music ? 3 : 0.5) || duration > (music ? 600 : 30))) {
      throw new Error("Audio generation duration is outside the supported range.");
    }
    return music
      ? { kind: name, serviceId: id(value.serviceId), prompt: value.prompt,
        ...(duration === undefined ? {} : { durationSeconds: duration }), instrumental: option, ...(options ? { options } : {}) }
      : { kind: name, serviceId: id(value.serviceId), prompt: value.prompt, durationSeconds: duration!, loop: option };
  }
  if (name !== "separate_stems") throw new Error("Unknown audio tool.");
  const value = record(args); only(value, ["serviceId", "source", "stems"]);
  if (!Array.isArray(value.stems) || value.stems.length < 1 || value.stems.length > SEPARATION_STEMS.length ||
    new Set(value.stems).size !== value.stems.length || value.stems.some((stem) => !SEPARATION_STEMS.includes(stem))) {
    throw new Error("stems must be a non-empty unique selection of the available stems.");
  }
  return { kind: name, serviceId: id(value.serviceId), stems: value.stems as SeparationStem[], source: parseSource(value.source) };
}

function parseSource(input: unknown): AudioProcessingSource {
  const source = record(input);
  if (source.kind === "audio_asset") {
    only(source, ["kind", "assetRef"]);
    return { kind: source.kind, assetRef: id(source.assetRef) };
  }
  if (source.kind === "request_audio_attachment") {
    only(source, ["kind", "requestId", "audioIndex"]);
    if (!Number.isInteger(source.audioIndex) || (source.audioIndex as number) < 0 || (source.audioIndex as number) > 1) throw new Error("Invalid audio attachment index.");
    return { kind: source.kind, requestId: id(source.requestId), audioIndex: source.audioIndex as number };
  }
  if (source.kind !== "arrangement_audio") throw new Error("Invalid audio source kind.");
  only(source, ["kind", "trackName", "clipName", "clipStartBeat", "startBeat", "endBeat"]);
  const startBeat = number(source.startBeat);
  const endBeat = number(source.endBeat);
  if (endBeat <= startBeat) throw new Error("Audio endBeat must be greater than startBeat.");
  return {
    kind: source.kind, startBeat, endBeat,
    ...(source.trackName === undefined ? {} : { trackName: text(source.trackName) }),
    ...(source.clipName === undefined ? {} : { clipName: text(source.clipName) }),
    ...(source.clipStartBeat === undefined ? {} : { clipStartBeat: number(source.clipStartBeat) }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audio tool arguments must be an object.");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Audio tool arguments contain unsupported fields.");
}
function id(value: unknown): string {
  if (!isSafeStorageId(value)) throw new Error("Invalid audio reference.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("Invalid audio target name.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Audio beat positions must be finite numbers.");
  return value;
}
