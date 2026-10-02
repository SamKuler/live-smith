import type { ModelFunctionTool } from "../model/provider.js";
import type { PluginConfigField } from "./user-config.js";
import type { PluginAppMetadata } from "./mcp/apps.js";

export type PluginId = string;
export type PluginSourceFormat = "agent-plugins-1.0" | "codex" | "claude";
export const MAX_PLUGIN_ID_LENGTH = 64;
export const MAX_PLUGIN_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
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
  userConfig?: PluginConfigField[];
}

export interface PluginToolDefinition {
  pluginId?: PluginId;
  serverId: string;
  connectionId?: string;
  name: string;
  description: string;
  tool: ModelFunctionTool;
  artifactContract?: PluginArtifactToolContract;
  app?: PluginAppMetadata;
}

export interface PluginArtifactToolContract {
  inputs: readonly { argument: string; kind: "audio" | "midi" }[];
  /** Explicit MIDI conditioning with a host-bound duration argument. */
  continuation?: { lengthArgument: string };
  outputs: readonly { argument: string; kind: "midi"; label: string }[];
}

export interface PluginToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface PluginToolIssue {
  pluginId?: PluginId;
  connectionId?: string;
  serverId?: string;
  code: "invalid_configuration" | "unsupported_transport" | "approval_required" |
    "artifact_permission_required" | "authorization_required" | "connection_failed" | "invalid_tool";
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

export interface McpToolSource {
  tools(context: PluginToolContext): Promise<PluginToolsResult>;
  callTool(serverId: string, name: string, argumentsValue: unknown, context: PluginToolContext): Promise<PluginToolResult>;
  readResource?(serverId: string, uri: string, context: PluginToolContext): Promise<unknown>;
  listResources?(serverId: string, templates: boolean, cursor: string | undefined, context: PluginToolContext): Promise<unknown>;
  close(): Promise<void>;
}

export interface PluginPackage extends McpToolSource {
  readonly manifest: PluginManifest;
}
