import { PluginRegistry, type PluginToolset } from "../plugins/registry.js";
import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { PluginPackage, PluginToolDefinition, PluginToolIssue } from "../plugins/contracts.js";
import { createMcpPluginPackage } from "../plugins/mcp/package.js";
import { throwIfAborted } from "../runtime/host.js";
import { listInstalledPlugins, preparePluginRuntime } from "../storage/plugins.js";

export interface RequestPluginTools extends PluginToolset {
  toolsets: readonly PluginToolset[];
  issues: readonly PluginToolIssue[];
  close(): Promise<void>;
}

export async function createRequestPluginTools(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RequestPluginTools> {
  const packages: PluginPackage[] = [];
  const toolsets: PluginToolset[] = [];
  const issues: PluginToolIssue[] = [];
  if (input.storageDirectory) {
    const installed = await listInstalledPlugins(input.storageDirectory);
    for (const metadata of installed.filter((plugin) => plugin.enabled &&
      (plugin.components.mcpConfigPath !== undefined || plugin.components.mcpManifestPath !== undefined))) {
      throwIfAborted(input.signal);
      try {
        const plugin = createMcpPluginPackage(await preparePluginRuntime(input.storageDirectory, metadata.id), {
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        });
        const packageIndex = packages.push(plugin) - 1;
        const discovery = await plugin.tools({ sessionId: input.sessionId, signal: input.signal });
        issues.push(...discovery.issues);
        const routes = new Map<string, PluginToolDefinition>();
        for (const definition of discovery.tools) {
          const callName = definition.tool.function.name;
          if (routes.has(callName)) {
            issues.push({
              pluginId: definition.pluginId,
              serverId: definition.serverId,
              code: "invalid_tool",
              message: "Plugin tool identity conflicts with another installed tool.",
            });
            continue;
          }
          routes.set(callName, definition);
        }
        toolsets.push({
          pluginId: metadata.id,
          tools: () => [...routes.values()].map((definition) => definition.tool),
          callTool: (call) => callInstalledPluginTool(
            packages[packageIndex]!,
            routes,
            call,
            input,
          ),
          close: () => packages[packageIndex]!.close(),
        });
      } catch {
        issues.push({
          pluginId: metadata.id,
          code: "invalid_configuration",
          message: "Plugin tools could not be loaded.",
        });
      }
    }
  }
  const registry = new PluginRegistry(toolsets);
  return {
    pluginId: "installed.mcp",
    toolsets,
    issues,
    tools: () => registry.tools(),
    callTool: (call) => registry.callTool(call),
    async close() {
      await Promise.allSettled(packages.map((plugin) => plugin.close()));
    },
  };
}

async function callInstalledPluginTool(
  plugin: PluginPackage,
  routes: ReadonlyMap<string, PluginToolDefinition>,
  call: ModelToolCall,
  input: { sessionId: string; signal: AbortSignal },
): Promise<AgentExternalToolResult> {
  const route = routes.get(call.name);
  if (!route) return { content: "Plugin tool is unavailable.", failed: true, invalidArguments: true };
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments || "{}");
  } catch {
    return { content: "Plugin tool arguments are not valid JSON.", failed: true, invalidArguments: true };
  }
  try {
    const result = await plugin.callTool(
      route.serverId,
      route.name,
      argumentsValue,
      { sessionId: input.sessionId, signal: input.signal },
    );
    return {
      content: JSON.stringify({
        notice: "Untrusted Plugin tool result.",
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }),
      ...(result.isError ? { failed: true } : {}),
    };
  } catch {
    throwIfAborted(input.signal);
    return {
      content: "Plugin tool could not complete. Check the Plugin and MCP server status before retrying.",
      failed: true,
      stop: true,
    };
  }
}
