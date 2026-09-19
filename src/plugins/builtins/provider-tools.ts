import {
  parseAudioToolRequest,
  type AudioToolRequest,
} from "../../agent/audio-tool-parser.js";
import {
  musicOptionsSchema,
  musicServiceTools,
} from "../../agent/music-tools.js";
import {
  SEPARATION_STEMS,
  type AudioOperation,
} from "../../audio-services/contracts.js";
import { exceedsAudioPromptLimit } from "../../audio-services/prompt.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import type {
  BuiltInAudioToolContract,
  BuiltInAudioToolExtension,
  BuiltInIntegrationConnectionChoice,
} from "./contracts.js";

const stringField = { type: "string", minLength: 1, maxLength: 128 };
const sourceSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "request_audio_attachment" },
        requestId: stringField,
        audioIndex: { type: "integer", minimum: 0, maximum: 1 },
      },
      required: ["kind", "requestId", "audioIndex"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "audio_asset" }, assetRef: stringField },
      required: ["kind", "assetRef"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "arrangement_audio" },
        trackName: stringField,
        clipName: stringField,
        clipStartBeat: { type: "number" },
        startBeat: { type: "number" },
        endBeat: { type: "number" },
      },
      required: ["kind", "startBeat", "endBeat"],
    },
  ],
};
const soundEffectDurationSchema = { type: "number", minimum: 0.5, maximum: 30 };

export function createBuiltInAudioTools(
  audio: BuiltInAudioToolContract,
  extension?: BuiltInAudioToolExtension,
): BuiltInAudioToolExtension {
  const standardNames = standardToolNames(audio);
  const extensionNames = new Set(extension?.localToolNames ?? []);
  if (standardNames.some((name) => extensionNames.has(name))) {
    throw new Error("Built-in Plugin declares a duplicate tool name.");
  }
  const localToolNames = Object.freeze([
    ...(extension?.localToolNames ?? []),
    ...standardNames,
  ]);
  const tools: BuiltInAudioToolExtension = {
    localToolNames,
    tools(services) {
      return [
        ...(extension?.tools(services) ?? []),
        ...standardTools(audio, services),
      ];
    },
    parse(name, argumentsJson, services) {
      if (!localToolNames.includes(name)) throw new Error("Unknown Plugin tool.");
      const request = extensionNames.has(name)
        ? extension!.parse(name, argumentsJson, services)
        : parseAudioToolRequest(name, argumentsJson);
      validateBuiltInAudioToolRequest(
        request,
        audio,
        services,
        localToolNames,
      );
      return request;
    },
  };
  return Object.freeze(tools);
}

export function validateBuiltInAudioToolRequest(
  request: AudioToolRequest,
  audio: BuiltInAudioToolContract,
  services: readonly BuiltInIntegrationConnectionChoice[],
  localToolNames: readonly string[],
): void {
  if (
    request.kind === "list_audio_jobs" ||
    request.kind === "resume_audio_job" ||
    request.kind === "listen_to_audio_asset"
  ) return;
  const service = services.find((entry) => entry.id === request.connectionId);
  if (!service || !localToolNames.includes(request.kind)) {
    throw new Error("Unavailable Integration Connection or tool.");
  }
  if (request.kind === "inspect_music_service") {
    if (!audio.musicLibrary) throw new Error("Music library unavailable.");
    return;
  }
  if (request.kind === "generate_lyrics") return;
  if (!audio.operations.includes(request.kind as AudioOperation)) {
    throw new Error("Unavailable Integration Connection or tool.");
  }
  if (request.kind !== "generate_music") return;
  if (request.options && !audio.customMusic) {
    throw new Error("Custom music parameters are unavailable.");
  }
  if (
    request.options &&
    Object.keys(request.options).some((field) =>
      field !== "mode" &&
      !audio.customMusicOptions?.includes(
        field as Exclude<keyof typeof request.options, "mode">,
      ))
  ) {
    throw new Error("This connection does not support one or more custom music parameters.");
  }
  if (
    request.options &&
    audio.requiredCustomMusicOptions?.some((field) =>
      request.options?.[field] === undefined)
  ) {
    throw new Error("This connection requires another custom music parameter.");
  }
  if (
    audio.customMusic &&
    !request.options &&
    exceedsAudioPromptLimit(request.prompt, 3000)
  ) {
    throw new Error("Description exceeds 3000 characters.");
  }
  if (
    exceedsAudioPromptLimit(request.prompt, audio.musicPromptCharacters) ||
    (!audio.musicDuration && request.durationSeconds !== undefined)
  ) {
    throw new Error("This connection does not support those music generation parameters.");
  }
  if (
    request.durationSeconds !== undefined &&
    audio.musicDuration &&
    (request.durationSeconds < audio.musicDuration.minimumSeconds ||
      request.durationSeconds > audio.musicDuration.maximumSeconds)
  ) {
    throw new Error("Music generation duration is outside this connection's supported range.");
  }
  if (request.durationSeconds !== undefined && service.modelId) {
    const fixed = audio.fixedMusicDurationSecondsByModel?.[service.modelId];
    if (fixed !== undefined && request.durationSeconds !== fixed) {
      throw new Error(`The selected music model always generates ${fixed} seconds.`);
    }
  }
  if (
    !request.instrumental &&
    service.modelId &&
    audio.instrumentalOnlyModelIds?.includes(service.modelId)
  ) {
    throw new Error("The selected music model supports instrumental generation only.");
  }
}

function standardToolNames(audio: BuiltInAudioToolContract): string[] {
  return [
    ...audio.operations.filter((operation) =>
      [
        "separate_stems",
        "generate_music",
        "generate_sound_effect",
        "extend_music",
        "get_whole_song",
        "retrieve_music",
      ].includes(operation)),
    ...(audio.musicLibrary ? ["inspect_music_service"] : []),
  ];
}

function standardTools(
  audio: BuiltInAudioToolContract,
  services: readonly BuiltInIntegrationConnectionChoice[],
): ModelFunctionTool[] {
  const tools: ModelFunctionTool[] = [];
  if (audio.operations.includes("separate_stems")) tools.push(separationTool(services));
  if (audio.operations.includes("generate_music")) {
    tools.push(generationTool(audio, services, "generate_music"));
  }
  if (audio.operations.includes("generate_sound_effect")) {
    tools.push(generationTool(audio, services, "generate_sound_effect"));
  }
  tools.push(...musicServiceTools(audio, services));
  return tools;
}

function separationTool(
  services: readonly BuiltInIntegrationConnectionChoice[],
): ModelFunctionTool {
  return {
    type: "function",
    function: {
      name: "separate_stems",
      description: "Separate an exact audio source into selected instrument stems plus the residual mix when separation is part of the user's requested workflow. This uploads chosen audio and consumes processing minutes for each requested stem. It saves local results without changing Live. Inspect Arrangement Clip state first; range must lie within one isolated Clip. Current attachment and saved asset locators come from host context. Long processing waits inside the tool; do not submit duplicates. " + describeConnections(services),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: connectionSchema(services),
          source: sourceSchema,
          stems: {
            type: "array",
            minItems: 1,
            maxItems: SEPARATION_STEMS.length,
            uniqueItems: true,
            items: { type: "string", enum: [...SEPARATION_STEMS] },
          },
        },
        required: ["connectionId", "source", "stems"],
      },
    },
  };
}

function generationTool(
  audio: BuiltInAudioToolContract,
  services: readonly BuiltInIntegrationConnectionChoice[],
  operation: "generate_music" | "generate_sound_effect",
): ModelFunctionTool {
  const music = operation === "generate_music";
  return {
    type: "function",
    function: {
      name: operation,
      description: (music
        ? "Create rendered audio through this Plugin when rendered audio is part of the user's requested deliverable. This does not create or edit Live tracks, MIDI, devices, Scenes, or the Arrangement."
        : "Generate a sound effect from a description.") +
        (music
          ? " When options are offered, options.mode=custom makes prompt literal lyrics (empty for instrumentals); use only the advertised option fields. Without options, prompt is a description."
          : "") +
        " This may use the selected connection's paid allowance. Generate only the requested result or variants; never retry an unknown outcome or switch accounts. Results are saved without changing Live. " +
        describeConnections(services),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: connectionSchema(services),
          prompt: {
            type: "string",
            minLength: music && audio.customMusic ? 0 : 1,
            maxLength: music ? 5000 : 4100,
          },
          ...(music && audio.customMusic
            ? { options: musicOptionsSchemaFor(audio) }
            : {}),
          ...(!music || audio.musicDuration
            ? {
                durationSeconds: music
                  ? combinedMusicDurationSchema(audio, services)
                  : soundEffectDurationSchema,
              }
            : {}),
          ...(music
            ? { instrumental: { type: "boolean" } }
            : { loop: { type: "boolean" } }),
        },
        required: music
          ? ["connectionId", "prompt", "instrumental"]
          : ["connectionId", "prompt", "durationSeconds", "loop"],
        oneOf: services.flatMap((service) =>
          (music && audio.customMusic ? [false, true] : [false]).map((custom) => ({
            type: "object",
            additionalProperties: false,
            properties: {
              connectionId: { const: service.id },
              prompt: {
                type: "string",
                minLength: custom ? 0 : 1,
                maxLength: music
                  ? audio.customMusic && !custom
                    ? 3000
                    : audio.musicPromptCharacters
                  : 4100,
              },
              ...(custom ? { options: musicOptionsSchemaFor(audio) } : {}),
              ...(!music || audio.musicDuration
                ? {
                    durationSeconds: music
                      ? musicDurationSchema(audio, service)
                      : soundEffectDurationSchema,
                  }
                : {}),
              ...(music
                ? { instrumental: musicInstrumentalSchema(audio, service) }
                : { loop: { type: "boolean" } }),
            },
            required: music
              ? ["connectionId", "prompt", "instrumental", ...(custom ? ["options"] : [])]
              : ["connectionId", "prompt", "durationSeconds", "loop"],
          }))),
      },
    },
  };
}

function describeConnections(
  services: readonly BuiltInIntegrationConnectionChoice[],
): string {
  return "Available connections (IDs, user-defined labels, and configured model IDs): " +
    JSON.stringify(services);
}

function connectionSchema(
  services: readonly BuiltInIntegrationConnectionChoice[],
) {
  return { type: "string", enum: services.map((service) => service.id) };
}

function musicDurationSchema(
  audio: BuiltInAudioToolContract,
  service: BuiltInIntegrationConnectionChoice,
) {
  const fixed = service.modelId === undefined
    ? undefined
    : audio.fixedMusicDurationSecondsByModel?.[service.modelId];
  if (fixed !== undefined) return { type: "number", const: fixed };
  const range = audio.musicDuration!;
  return {
    type: "number",
    minimum: range.minimumSeconds,
    maximum: range.maximumSeconds,
  };
}

function musicInstrumentalSchema(
  audio: BuiltInAudioToolContract,
  service: BuiltInIntegrationConnectionChoice,
) {
  return service.modelId &&
      audio.instrumentalOnlyModelIds?.includes(service.modelId)
    ? { type: "boolean", const: true }
    : { type: "boolean" };
}

function combinedMusicDurationSchema(
  audio: BuiltInAudioToolContract,
  services: readonly BuiltInIntegrationConnectionChoice[],
) {
  const range = audio.musicDuration!;
  const fixedOr = (
    service: BuiltInIntegrationConnectionChoice,
    fallback: number,
  ) => service.modelId === undefined
    ? fallback
    : audio.fixedMusicDurationSecondsByModel?.[service.modelId] ?? fallback;
  return {
    type: "number",
    minimum: Math.min(...services.map((service) =>
      fixedOr(service, range.minimumSeconds))),
    maximum: Math.max(...services.map((service) =>
      fixedOr(service, range.maximumSeconds))),
  };
}

function musicOptionsSchemaFor(audio: BuiltInAudioToolContract) {
  const allowed = new Set(audio.customMusicOptions ?? []);
  return {
    ...musicOptionsSchema,
    required: ["mode", ...(audio.requiredCustomMusicOptions ?? [])],
    properties: Object.fromEntries(
      Object.entries(musicOptionsSchema.properties)
        .filter(([field]) => field === "mode" || allowed.has(field as never)),
    ),
  };
}
