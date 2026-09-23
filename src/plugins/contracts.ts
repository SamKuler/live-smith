import type { ModelFunctionTool } from "../model/provider.js";

export type PluginId = string;
export type PluginSourceFormat = "agent-plugins-1.0" | "codex" | "claude";
export const MAX_PLUGIN_ID_LENGTH = 64;
const pluginIdPattern = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;

export function isSafePluginId(value: unknown): value is PluginId {
  return typeof value === "string" && value.length <= MAX_PLUGIN_ID_LENGTH && pluginIdPattern.test(value);
}

export interface PluginComponents {
  skillsDirectory?: string;
  mcpConfigPath?: string;
  mcpManifestPath?: string;
}

export interface PluginManifest {
  id: PluginId;
  version?: string;
  description?: string;
  sourceFormat: PluginSourceFormat;
  components: PluginComponents;
  unsupportedComponents?: string[];
}

export interface PluginToolDefinition {
  pluginId: PluginId;
  serverId: string;
  connectionId?: string;
  name: string;
  tool: ModelFunctionTool;
  artifactContract?: PluginArtifactToolContract;
}

export interface PluginArtifactToolContract {
  inputs: readonly { argument: string; kind: "audio" }[];
  outputs: readonly { argument: string; kind: "midi"; label: string }[];
}

export interface PluginToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PluginToolIssue {
  pluginId: PluginId;
  serverId?: string;
  code: "invalid_configuration" | "unsupported_transport" | "approval_required" |
    "artifact_permission_required" | "connection_failed" | "invalid_tool";
  message: string;
}

export interface PluginToolsResult {
  tools: readonly PluginToolDefinition[];
  issues: readonly PluginToolIssue[];
}

export interface PluginToolContext {
  signal: AbortSignal;
  sessionId: string;
}

export interface PluginPackage {
  readonly manifest: PluginManifest;
  tools(context: PluginToolContext): Promise<PluginToolsResult>;
  callTool(serverId: string, name: string, argumentsValue: unknown, context: PluginToolContext): Promise<PluginToolResult>;
  close(): Promise<void>;
}
