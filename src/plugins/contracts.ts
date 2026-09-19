import type { ModelFunctionTool } from "../model/provider.js";

export type PluginId = string;
export type PluginSourceFormat = "agent-plugins-1.0" | "codex" | "claude";

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
}

export interface PluginToolDefinition {
  pluginId: PluginId;
  serverId: string;
  name: string;
  tool: ModelFunctionTool;
}

export interface PluginToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PluginToolIssue {
  pluginId: PluginId;
  serverId?: string;
  code: "invalid_configuration" | "unsupported_transport" | "approval_required" | "connection_failed" | "invalid_tool";
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
