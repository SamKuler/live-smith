import {
  parseAudioToolRequest,
  validateAudioServiceRequest,
  type AudioToolRequest,
} from "../../agent/audio-tools.js";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import {
  musicOptionsSchema,
  musicServiceTools,
} from "../../agent/music-tools.js";
import type { AudioServiceChoice } from "../../audio-services/capabilities.js";
import { SEPARATION_STEMS } from "../../audio-services/contracts.js";
import type { ModelToolCall } from "../../model/contracts.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import type { PluginToolset } from "../registry.js";
import { BUILT_IN_AUDIO_PLUGINS } from "./index.js";
import type { BuiltInAudioPluginDefinition } from "./contracts.js";

const stringField = { type: "string", minLength: 1, maxLength: 128 };
const sourceSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: {
        kind: { const: "request_audio_attachment" },
        requestId: stringField,
        audioIndex: { type: "integer", minimum: 0, maximum: 1 },
      },
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
const providerLocalToolNames = [
  "separate_stems",
  "generate_music",
  "generate_sound_effect",
  "inspect_music_service",
  "extend_music",
  "get_whole_song",
  "retrieve_music",
] as const;

export type BuiltInAudioExecutor = (
  request: AudioToolRequest,
) => Promise<AgentExternalToolResult>;

export function builtInAudioToolName(
  plugin: BuiltInAudioPluginDefinition,
  localName: string,
): string {
  const provider = plugin.provider.replaceAll(/[^A-Za-z0-9_]/gu, "_");
  return `builtin_${provider}_${localName}`;
}

export function builtInAudioLocalToolName(name: string): string | undefined {
  if (["listen_to_audio_asset", "resume_audio_job", "list_audio_jobs"].includes(name)) {
    return name;
  }
  for (const plugin of BUILT_IN_AUDIO_PLUGINS) {
    for (const localName of providerLocalToolNames) {
      if (name === builtInAudioToolName(plugin, localName)) return localName;
    }
  }
  return undefined;
}

export function builtInAudioToolNames(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([
    ...["listen_to_audio_asset", "resume_audio_job", "list_audio_jobs"]
      .map((name) => [name, name] as const),
    ...BUILT_IN_AUDIO_PLUGINS.flatMap((plugin) =>
      providerLocalToolNames.map((localName) => [
        builtInAudioToolName(plugin, localName),
        localName,
      ] as const)),
  ]));
}

export function createBuiltInAudioToolsets(input: {
  services: readonly AudioServiceChoice[];
  includeModelAudioInput: boolean;
  execute: BuiltInAudioExecutor;
}): PluginToolset[] {
  const result: PluginToolset[] = [coreAudioToolset(
    input.includeModelAudioInput,
    input.execute,
  )];
  for (const plugin of BUILT_IN_AUDIO_PLUGINS) {
    const services = input.services.filter((service) => service.provider === plugin.provider);
    if (!services.length) continue;
    const localTools = providerTools(plugin, services);
    if (!localTools.length) continue;
    result.push(providerAudioToolset(plugin, services, localTools, input.execute));
  }
  return result;
}

function coreAudioToolset(
  includeModelAudioInput: boolean,
  execute: BuiltInAudioExecutor,
): PluginToolset {
  const tools = sessionMediaTools(includeModelAudioInput);
  const names = new Set(tools.map((tool) => tool.function.name));
  return {
    pluginId: "live-smith.media",
    tools: () => tools,
    callTool: (call) => parseAndExecute(call, names, [], execute),
  };
}

function sessionMediaTools(includeModelAudioInput: boolean): ModelFunctionTool[] {
  return [
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
        parameters: {
          type: "object", additionalProperties: false,
          properties: { jobId: stringField }, required: ["jobId"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "list_audio_jobs",
        description: "List this Session's saved audio processing jobs and verified result asset references, including previous requests. Results include snapshot origins, not permission to change Live. Use an output's id as assetRef in an audio_asset SampleSource, a subsequent audio processing call, or listen_to_audio_asset when that tool is available. This only reads local state.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
}

function providerTools(
  plugin: BuiltInAudioPluginDefinition,
  services: readonly AudioServiceChoice[],
): ModelFunctionTool[] {
  const tools: ModelFunctionTool[] = [];
  if (plugin.capabilities.operations.includes("separate_stems")) {
    tools.push(separationTool(services));
  }
  if (plugin.capabilities.operations.includes("generate_music")) {
    tools.push(generationTool(plugin, services, "generate_music"));
  }
  if (plugin.capabilities.operations.includes("generate_sound_effect")) {
    tools.push(generationTool(plugin, services, "generate_sound_effect"));
  }
  tools.push(...musicServiceTools(services));
  return tools;
}

function separationTool(services: readonly AudioServiceChoice[]): ModelFunctionTool {
  return {
    type: "function",
    function: {
      name: "separate_stems",
      description: "Separate an exact audio source into selected instrument stems plus the residual mix when separation is part of the user's requested workflow. This uploads chosen audio and consumes processing minutes for each requested stem. It saves local results without changing Live. Inspect Arrangement Clip state first; range must lie within one isolated Clip. Current attachment and saved asset locators come from host context. Long processing waits inside the tool; do not submit duplicates. " + describeConnections(services),
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          serviceId: connectionSchema(services),
          source: sourceSchema,
          stems: {
            type: "array",
            minItems: 1,
            maxItems: SEPARATION_STEMS.length,
            uniqueItems: true,
            items: { type: "string", enum: [...SEPARATION_STEMS] },
          },
        },
        required: ["serviceId", "source", "stems"],
      },
    },
  };
}

function generationTool(
  plugin: BuiltInAudioPluginDefinition,
  services: readonly AudioServiceChoice[],
  operation: "generate_music" | "generate_sound_effect",
): ModelFunctionTool {
  const capability = plugin.capabilities;
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
          serviceId: connectionSchema(services),
          prompt: {
            type: "string",
            minLength: music && capability.customMusic ? 0 : 1,
            maxLength: music ? 5000 : 4100,
          },
          ...(music && capability.customMusic
            ? { options: musicOptionsSchemaFor(plugin) }
            : {}),
          ...(!music || capability.musicDuration
            ? {
                durationSeconds: music
                  ? combinedMusicDurationSchema(plugin, services)
                  : soundEffectDurationSchema,
              }
            : {}),
          ...(music
            ? { instrumental: { type: "boolean" } }
            : { loop: { type: "boolean" } }),
        },
        required: music
          ? ["serviceId", "prompt", "instrumental"]
          : ["serviceId", "prompt", "durationSeconds", "loop"],
        oneOf: services.flatMap((service) =>
          (music && capability.customMusic ? [false, true] : [false]).map((custom) => ({
            type: "object",
            additionalProperties: false,
            properties: {
              serviceId: { const: service.id },
              prompt: {
                type: "string",
                minLength: custom ? 0 : 1,
                maxLength: music
                  ? capability.customMusic && !custom
                    ? 3000
                    : capability.musicPromptCharacters
                  : 4100,
              },
              ...(custom ? { options: musicOptionsSchemaFor(plugin) } : {}),
              ...(!music || capability.musicDuration
                ? {
                    durationSeconds: music
                      ? musicDurationSchema(plugin, service)
                      : soundEffectDurationSchema,
                  }
                : {}),
              ...(music
                ? { instrumental: musicInstrumentalSchema(plugin, service) }
                : { loop: { type: "boolean" } }),
            },
            required: music
              ? ["serviceId", "prompt", "instrumental", ...(custom ? ["options"] : [])]
              : ["serviceId", "prompt", "durationSeconds", "loop"],
          })),
        ),
      },
    },
  };
}

function describeConnections(services: readonly AudioServiceChoice[]): string {
  return "Available connections (IDs, user-defined labels, and configured model IDs): " +
    JSON.stringify(services);
}

function connectionSchema(services: readonly AudioServiceChoice[]) {
  return { type: "string", enum: services.map((service) => service.id) };
}

function musicDurationSchema(
  plugin: BuiltInAudioPluginDefinition,
  service: AudioServiceChoice,
) {
  const fixed = service.modelId === undefined
    ? undefined
    : plugin.capabilities.fixedMusicDurationSecondsByModel?.[service.modelId];
  if (fixed !== undefined) return { type: "number", const: fixed };
  const range = plugin.capabilities.musicDuration!;
  return {
    type: "number",
    minimum: range.minimumSeconds,
    maximum: range.maximumSeconds,
  };
}

function musicInstrumentalSchema(
  plugin: BuiltInAudioPluginDefinition,
  service: AudioServiceChoice,
) {
  return service.modelId &&
      plugin.capabilities.instrumentalOnlyModelIds?.includes(service.modelId)
    ? { type: "boolean", const: true }
    : { type: "boolean" };
}

function combinedMusicDurationSchema(
  plugin: BuiltInAudioPluginDefinition,
  services: readonly AudioServiceChoice[],
) {
  const range = plugin.capabilities.musicDuration!;
  const fixedOr = (
    service: AudioServiceChoice,
    fallback: number,
  ) => service.modelId === undefined
    ? fallback
    : plugin.capabilities.fixedMusicDurationSecondsByModel?.[service.modelId] ?? fallback;
  return {
    type: "number",
    minimum: Math.min(...services.map((service) =>
      fixedOr(service, range.minimumSeconds))),
    maximum: Math.max(...services.map((service) =>
      fixedOr(service, range.maximumSeconds))),
  };
}

function musicOptionsSchemaFor(plugin: BuiltInAudioPluginDefinition) {
  const allowed = new Set(plugin.capabilities.customMusicOptions ?? []);
  return {
    ...musicOptionsSchema,
    required: ["mode", ...(plugin.capabilities.requiredCustomMusicOptions ?? [])],
    properties: Object.fromEntries(
      Object.entries(musicOptionsSchema.properties)
        .filter(([field]) => field === "mode" || allowed.has(field as never)),
    ),
  };
}

function providerAudioToolset(
  plugin: BuiltInAudioPluginDefinition,
  services: readonly AudioServiceChoice[],
  localTools: readonly ModelFunctionTool[],
  execute: BuiltInAudioExecutor,
): PluginToolset {
  const routes = new Map(localTools.map((tool) => {
    const localName = tool.function.name;
    return [builtInAudioToolName(plugin, localName), localName] as const;
  }));
  const tools = localTools.map((tool): ModelFunctionTool => ({
    ...tool,
    function: {
      ...tool.function,
      name: builtInAudioToolName(plugin, tool.function.name),
    },
  }));
  return {
    pluginId: plugin.id,
    tools: () => tools,
    async callTool(call) {
      const localName = routes.get(call.name);
      if (!localName) return invalidArguments();
      return parseAndExecute({ ...call, name: localName }, new Set([localName]), services, execute);
    },
  };
}

async function parseAndExecute(
  call: ModelToolCall,
  admittedNames: ReadonlySet<string>,
  services: readonly AudioServiceChoice[],
  execute: BuiltInAudioExecutor,
): Promise<AgentExternalToolResult> {
  if (!admittedNames.has(call.name)) return invalidArguments();
  let request: AudioToolRequest;
  try {
    request = parseAudioToolRequest(call.name, call.arguments);
    validateAudioServiceRequest(request, services);
  } catch {
    return invalidArguments();
  }
  return execute(request);
}

function invalidArguments(): AgentExternalToolResult {
  return {
    content: "Invalid Plugin tool arguments. Use only the declared connection IDs, source references, and operation fields.",
    failed: true,
    invalidArguments: true,
  };
}
