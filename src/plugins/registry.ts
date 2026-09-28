import type { AgentExternalToolResult } from "../agent/loop.js";
import type { ModelToolCall } from "../model/contracts.js";
import type { ModelFunctionTool } from "../model/provider.js";

export interface Toolset {
  readonly id: string;
  tools(): readonly ModelFunctionTool[];
  callTool(call: ModelToolCall): Promise<AgentExternalToolResult>;
  close?(): Promise<void>;
}

export class ToolRegistry implements Toolset {
  readonly id = "live-smith.registry";
  private readonly definitions: ModelFunctionTool[] = [];
  private readonly owners = new Map<string, Toolset>();

  constructor(private readonly toolsets: readonly Toolset[]) {
    const ids = new Set<string>();
    for (const toolset of toolsets) {
      if (ids.has(toolset.id)) {
        throw new Error(`Duplicate toolset identity: ${toolset.id}.`);
      }
      ids.add(toolset.id);
      for (const tool of toolset.tools()) {
        const name = tool.function.name;
        if (this.owners.has(name)) throw new Error(`Duplicate tool name: ${name}.`);
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
    if (!owner) throw new Error("Tool is not registered.");
    return owner.callTool(call);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.toolsets.map((toolset) => toolset.close?.()));
  }
}
