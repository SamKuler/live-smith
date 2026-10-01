import assert from "node:assert/strict";
import test from "node:test";

import { actionSystemPrompt } from "../../src/agent/actions.js";
import {
  agentSystemInstructions,
  agentSystemInstructionsForSkills,
} from "../../src/agent/system-instructions.js";

const skillPriorityBoundary = "The following selected Skills";

test("empty Skill context uses the base instruction contract", () => {
  assert.equal(
    agentSystemInstructionsForSkills({
      activeSkillIds: [],
      instructionBlock: "",
    }),
    agentSystemInstructions,
  );
});

test("Custom Instructions are standing user choices below immutable boundaries and above workflow defaults", () => {
  const custom = "Prefer Suno sketches first, then turn the chosen idea into MIDI.";
  const instructions = agentSystemInstructionsForSkills(
    { activeSkillIds: [], instructionBlock: "" },
    ["midi"],
    custom,
  );
  const scopeIndex = instructions.indexOf("saved Session Edit Scope");
  const customBoundaryIndex = instructions.indexOf("The following Custom Instructions");
  const customIndex = instructions.indexOf(JSON.stringify(custom));
  const actionIndex = instructions.indexOf(actionSystemPrompt());
  assert.ok(scopeIndex >= 0);
  assert.ok(customBoundaryIndex > scopeIndex);
  assert.ok(customIndex > customBoundaryIndex);
  assert.ok(actionIndex > customIndex);
  assert.match(instructions, /current request takes precedence/i);
  assert.match(instructions, /cannot expand.*Edit Scope|Edit Scope.*cannot expand/is);
  assert.equal(instructions.split(JSON.stringify(custom)).length - 1, 1);
});

test("active Skill guidance stays below built-in safety and above the action contract", () => {
  const instructionBlock = [
    '<skill id="arrangement-review">',
    "Review the arrangement in sections.",
    "</skill>",
    "",
    '<skill id="mixing-review">',
    "Review routing before changing levels.",
    "</skill>",
  ].join("\n");
  const instructions = agentSystemInstructionsForSkills({
    activeSkillIds: ["arrangement-review", "mixing-review"],
    instructionBlock,
  });

  const base = agentSystemInstructions.slice(0, -actionSystemPrompt().length);
  const boundaryIndex = instructions.indexOf(skillPriorityBoundary);
  const skillIndex = instructions.indexOf(instructionBlock);
  const actionContractIndex = instructions.indexOf(actionSystemPrompt());

  assert.ok(instructions.startsWith(base));
  assert.ok(boundaryIndex >= base.length);
  assert.ok(skillIndex > boundaryIndex);
  assert.ok(actionContractIndex > skillIndex);
  assert.equal(
    instructions.slice(skillIndex, actionContractIndex).trimEnd(),
    instructionBlock,
  );
  assert.equal(instructions.split(skillPriorityBoundary).length - 1, 1);
});

test("saved edit scope instructions precede Skills and explicitly distinguish read-only", () => {
  const skills = { activeSkillIds: ["scope-test"], instructionBlock: "Selected workflow" };
  const scoped = agentSystemInstructionsForSkills(skills, ["midi", "devices"]);
  const allowed = "Allowed write scopes for this model turn: MIDI content, Devices.";
  assert.ok(scoped.includes(allowed));
  assert.ok(scoped.indexOf(allowed) < scoped.indexOf(skills.instructionBlock));
  assert.ok(scoped.endsWith(actionSystemPrompt()));
  const readOnly = agentSystemInstructionsForSkills({ activeSkillIds: [], instructionBlock: "" }, []);
  assert.ok(readOnly.includes("This Session is read-only: no Live writes are allowed."));
  assert.ok(!readOnly.includes("Allowed write scopes"));
  assert.ok(readOnly.endsWith(actionSystemPrompt()));
});
