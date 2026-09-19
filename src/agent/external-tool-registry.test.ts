import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolRegistry, type AgentToolset } from "./external-tool-registry.js";

function toolset(name: string, calls: string[]): AgentToolset {
  return {
    tools: () => [{ type: "function", function: { name, description: name } }],
    callTool: async (call) => { calls.push(call.name); return { content: call.arguments }; },
  };
}

test("external tool registry exposes generic tools and routes by registered identity", async () => {
  const calls: string[] = [];
  const registry = new AgentToolRegistry([toolset("first", calls), toolset("second", calls)]);
  assert.deepEqual(registry.tools().map((tool) => tool.function.name), ["first", "second"]);
  assert.deepEqual(await registry.callTool({ id: "call", name: "second", arguments: "{}" }), { content: "{}" });
  assert.deepEqual(calls, ["second"]);
});

test("external tool registry rejects ambiguous provider-facing names", () => {
  assert.throws(() => new AgentToolRegistry([toolset("same", []), toolset("same", [])]), /Duplicate external tool/u);
});
