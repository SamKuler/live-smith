import type { ModelFunctionTool } from "../model/provider.js";

export type PluginId = string;
export type PluginSourceFormat = "agent-plugins-1.0" | "codex" | "claude";

export interface PluginComponents {
  skillsDirectory?: string;
  mcpConfigPath?: string;
}

export interface PluginManifest {
  id: PluginId;
  version: string;
  description: string;
  sourceFormat: PluginSourceFormat;
  components: PluginComponents;
}

export interface PluginToolDefinition {
  pluginId: PluginId;
  serverId: string;
  tool: ModelFunctionTool;
}

export interface PluginToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PluginToolContext {
  signal: AbortSignal;
  sessionId: string;
}

export interface PluginPackage {
  readonly manifest: PluginManifest;
  tools(context: PluginToolContext): Promise<readonly PluginToolDefinition[]>;
  callTool(name: string, argumentsValue: unknown, context: PluginToolContext): Promise<PluginToolResult>;
}
