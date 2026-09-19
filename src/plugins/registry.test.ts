import assert from "node:assert/strict";
import test from "node:test";

import { PluginRegistry, type PluginToolset } from "./registry.js";

function toolset(pluginId: string, name: string, calls: string[]): PluginToolset {
  return {
    pluginId,
    tools: () => [{ type: "function", function: { name, description: name } }],
    callTool: async (call) => {
      calls.push(`${pluginId}:${call.name}`);
      return { content: call.arguments };
    },
  };
}

test("Plugin registry exposes generic tools and routes by admitted Plugin identity", async () => {
  const calls: string[] = [];
  const registry = new PluginRegistry([
    toolset("first.plugin", "first_tool", calls),
    toolset("second.plugin", "second_tool", calls),
  ]);
  assert.deepEqual(registry.tools().map((tool) => tool.function.name), [
    "first_tool",
    "second_tool",
  ]);
  assert.deepEqual(await registry.callTool({
    id: "call",
    name: "second_tool",
    arguments: "{}",
  }), { content: "{}" });
  assert.deepEqual(calls, ["second.plugin:second_tool"]);
});

test("Plugin registry rejects duplicate package identities and tool names", () => {
  assert.throws(() => new PluginRegistry([
    toolset("same.plugin", "first", []),
    toolset("same.plugin", "second", []),
  ]), /Plugin identity/u);
  assert.throws(() => new PluginRegistry([
    toolset("first.plugin", "same_tool", []),
    toolset("second.plugin", "same_tool", []),
  ]), /Plugin tool/u);
});
