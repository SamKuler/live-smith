import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { cloneJsonValue } from "../../model/json-clone.js";
import type { AudioToolRequest } from "../../agent/audio-tool-parser.js";
import type { BuiltInIntegrationConnectionChoice } from "./contracts.js";
import { createBuiltInAudioToolsets } from "./audio-toolsets.js";

export const MAX_AUDIO_PARAMETER_BYTES = 64 * 1024;
export const MAX_AUDIO_PARAMETER_SCHEMA_BYTES = 32 * 1024;
export const MAX_AUDIO_PARAMETER_SUGGESTIONS = 40;
export interface AudioParameterSuggestion { id: string; label: string }
export interface AudioParameterSuggestions {
  clips?: AudioParameterSuggestion[];
  models?: AudioParameterSuggestion[];
  personas?: AudioParameterSuggestion[];
}
export interface AudioParameterPanel {
  toolName: string;
  signature: string;
  connectionId?: string;
  schema: Record<string, unknown>;
  suggestions?: AudioParameterSuggestions;
}
export interface AudioParameterGroup {
  kind: "audio";
  pluginId: string;
  connectionId?: string;
  connectionName?: string;
  tools: Array<{ name: string; description: string; audioPanel?: AudioParameterPanel }>;
}

/** Derives manual forms from the same per-connection definitions consumed by the runtime parser. */
export function audioParameterGroups(input: {
  services: readonly BuiltInIntegrationConnectionChoice[];
  identity: (connectionId: string) => unknown;
  hasJobs: boolean;
}): AudioParameterGroup[] {
  const groups: AudioParameterGroup[] = [];
  for (const service of [undefined, ...input.services]) {
    if (!service && !input.services.length && !input.hasJobs) continue;
    const toolsets = createBuiltInAudioToolsets({ services: service ? [service] : [],
      includeModelAudioInput: false, execute: async () => { throw new Error("Catalog discovery cannot execute audio tools."); } });
    for (const toolset of toolsets) {
      if (service && toolset.id === "live-smith.media") continue;
      groups.push({ kind: "audio", pluginId: toolset.id,
        ...(service ? { connectionId: service.id, connectionName: service.name } : {}),
        tools: toolset.tools().map((tool) => {
          const schema = manualSchema(cloneJsonValue(tool.function.parameters ?? { type: "object", properties: {}, additionalProperties: false }), service?.id);
          const audioPanel = Buffer.byteLength(JSON.stringify(schema), "utf8") <= MAX_AUDIO_PARAMETER_SCHEMA_BYTES
            ? { toolName: tool.function.name, schema,
                ...(service ? { connectionId: service.id } : {}),
                signature: createHash("sha256").update(JSON.stringify([tool.function.name, schema,
                  service ? input.identity(service.id) : "session-media"])).digest("hex") }
            : undefined;
          return { name: tool.function.name, description: tool.function.description, ...(audioPanel ? { audioPanel } : {}) };
        }),
      });
    }
  }
  return groups;
}

export async function parseAudioParameters(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  services: readonly BuiltInIntegrationConnectionChoice[];
}): Promise<AudioToolRequest> {
  if (Buffer.byteLength(JSON.stringify(input.arguments), "utf8") > MAX_AUDIO_PARAMETER_BYTES) {
    throw new Error("Audio parameters exceed the byte limit.");
  }
  let request: AudioToolRequest | undefined;
  const toolsets = createBuiltInAudioToolsets({ services: input.services, includeModelAudioInput: false,
    execute: async (parsed) => { request = parsed; return { content: "" }; } });
  const owner = toolsets.find((toolset) => toolset.tools().some((tool) => tool.function.name === input.toolName));
  if (!owner) throw new Error("Audio tool is unavailable.");
  await owner.callTool({ id: "audio-parameters", name: input.toolName, arguments: JSON.stringify(input.arguments) });
  if (!request || "source" in request && request.source.kind === "request_audio_attachment") {
    throw new Error("Invalid audio parameters. Use this connection's declared fields and saved Session audio or Arrangement sources.");
  }
  return request;
}

function manualSchema(value: Record<string, unknown>, connectionId?: string): Record<string, unknown> {
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.filter((branch) => !isAttachmentBranch(branch)).map(visit);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key,
      key === "connectionId" && connectionId ? { type: "string", const: connectionId } : visit(child)]));
  };
  return visit(value) as Record<string, unknown>;
}

function isAttachmentBranch(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const properties = (value as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return false;
  const kind = (properties as Record<string, unknown>).kind;
  return Boolean(kind && typeof kind === "object" && (kind as Record<string, unknown>).const === "request_audio_attachment");
}
