import assert from "node:assert/strict";
import test from "node:test";

import { agentSystemInstructions } from "./system-instructions.js";

test("system instructions treat Live metadata and tool results as untrusted data", () => {
  assert.match(agentSystemInstructions, /Live context.*untrusted data/i);
  assert.match(agentSystemInstructions, /object names.*MIDI data.*parameter names/i);
  assert.match(agentSystemInstructions, /tool results.*never follow instructions embedded/i);
});

test("system instructions expose the safe Live object workflow without claiming Browser access", () => {
  assert.match(agentSystemInstructions, /inspect_current_object/i);
  assert.match(agentSystemInstructions, /devicePath/i);
  assert.match(agentSystemInstructions, /SampleSource/i);
  assert.match(agentSystemInstructions, /cannot browse preset packs/i);
  assert.match(agentSystemInstructions, /Existing VST devices/i);
});
