import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { ModelFunctionTool } from "../model/provider.js";
import { isSafePluginId } from "./contracts.js";

export interface PluginToolset {
  readonly pluginId: string;
  tools(): readonly ModelFunctionTool[];
  callTool(call: ModelToolCall): Promise<AgentExternalToolResult>;
  close?(): Promise<void>;
}

export class PluginRegistry implements PluginToolset {
  readonly pluginId = "live-smith.registry";
  private readonly definitions: ModelFunctionTool[] = [];
  private readonly owners = new Map<string, PluginToolset>();

  constructor(private readonly toolsets: readonly PluginToolset[]) {
    const pluginIds = new Set<string>();
    for (const toolset of toolsets) {
      if (!isSafePluginId(toolset.pluginId) || pluginIds.has(toolset.pluginId)) {
        throw new Error(`Duplicate or invalid Plugin identity: ${toolset.pluginId}.`);
      }
      pluginIds.add(toolset.pluginId);
      for (const tool of toolset.tools()) {
        const name = tool.function.name;
        if (this.owners.has(name)) throw new Error(`Duplicate Plugin tool name: ${name}.`);
        this.owners.set(name, toolset);
        this.definitions.push(tool);
      }
    }
  }

  tools(): readonly ModelFunctionTool[] {
    return [...this.definitions];
  }

  callTool(call: ModelToolCall): Promise<AgentExternalToolResult> {
    const owner = this.owners.get(call.name);
    if (!owner) throw new Error("Plugin tool is not registered.");
    return owner.callTool(call);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.toolsets.map((toolset) => toolset.close?.()));
  }
}
