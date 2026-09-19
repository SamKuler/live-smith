import type { ModelToolCall } from "../model/contracts.js";
import type { ModelFunctionTool } from "../model/provider.js";
import type { AgentExternalToolResult } from "./loop.js";

export interface AgentToolset {
  tools(): readonly ModelFunctionTool[];
  callTool(call: ModelToolCall): Promise<AgentExternalToolResult>;
  close?(): Promise<void>;
}

export class AgentToolRegistry implements AgentToolset {
  private readonly definitions: ModelFunctionTool[];
  private readonly owners = new Map<string, AgentToolset>();

  constructor(private readonly toolsets: readonly AgentToolset[]) {
    this.definitions = [];
    for (const toolset of toolsets) {
      for (const tool of toolset.tools()) {
        const name = tool.function.name;
        if (this.owners.has(name)) throw new Error(`Duplicate external tool name: ${name}.`);
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
    if (!owner) throw new Error("External tool is not registered.");
    return owner.callTool(call);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.toolsets.map((toolset) => toolset.close?.()));
  }
}
