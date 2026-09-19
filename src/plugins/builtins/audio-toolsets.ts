import {
  parseAudioToolRequest,
  type AudioToolRequest,
} from "../../agent/audio-tool-parser.js";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import type { ModelToolCall } from "../../model/contracts.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import type { PluginToolset } from "../registry.js";
import type {
  BuiltInAudioPluginDefinition,
  BuiltInIntegrationConnectionChoice,
} from "./contracts.js";
import { BUILT_IN_AUDIO_PLUGINS } from "./index.js";

const stringField = { type: "string", minLength: 1, maxLength: 128 };

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
    for (const localName of plugin.tools.localToolNames) {
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
      plugin.tools.localToolNames.map((localName) => [
        builtInAudioToolName(plugin, localName),
        localName,
      ] as const)),
  ]));
}

export function createBuiltInAudioToolsets(input: {
  services: readonly BuiltInIntegrationConnectionChoice[];
  includeModelAudioInput: boolean;
  execute: BuiltInAudioExecutor;
}): PluginToolset[] {
  const result: PluginToolset[] = [coreAudioToolset(
    input.includeModelAudioInput,
    input.execute,
  )];
  for (const plugin of BUILT_IN_AUDIO_PLUGINS) {
    const services = input.services.filter((service) =>
      service.pluginId === plugin.id && service.provider === plugin.provider);
    if (!services.length) continue;
    const localTools = plugin.tools.tools(services);
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
          type: "object",
          additionalProperties: false,
          properties: { assetRef: stringField },
          required: ["assetRef"],
        },
      },
    }] : []),
    {
      type: "function" as const,
      function: {
        name: "resume_audio_job",
        description: "Recover an existing audio job using a jobId from list_audio_jobs. Fully saved audio can finish local recovery without an enabled connection or remote ticket. Retrieving missing outputs requires the original saved connection and a confirmed remote task ID. Never resubmits processing or changes Live; a lost provider response cannot be regenerated through this tool.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { jobId: stringField },
          required: ["jobId"],
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

function providerAudioToolset(
  plugin: BuiltInAudioPluginDefinition,
  services: readonly BuiltInIntegrationConnectionChoice[],
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
      return parseAndExecute(
        { ...call, name: localName },
        new Set([localName]),
        services,
        execute,
        plugin.tools.parse,
      );
    },
  };
}

async function parseAndExecute(
  call: ModelToolCall,
  admittedNames: ReadonlySet<string>,
  services: readonly BuiltInIntegrationConnectionChoice[],
  execute: BuiltInAudioExecutor,
  parse: (
    name: string,
    argumentsJson: string,
    services: readonly BuiltInIntegrationConnectionChoice[],
  ) => AudioToolRequest = (name, argumentsJson) =>
    parseAudioToolRequest(name, argumentsJson),
): Promise<AgentExternalToolResult> {
  if (!admittedNames.has(call.name)) return invalidArguments();
  let request: AudioToolRequest;
  try {
    request = parse(call.name, call.arguments, services);
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
