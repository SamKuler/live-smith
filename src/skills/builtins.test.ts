import assert from "node:assert/strict";
import test from "node:test";

import {
  availableSkillSummaries,
  builtInSkillDefinition,
  builtInSkillDefinitions,
  isBuiltInSkillId,
} from "./builtins.js";

const builtInIds = [
  "arranging-section-energy",
  "developing-musical-variation",
  "organizing-instrument-roles",
] as const;

test("built-in arrangement Skills are unique, sorted, and parsed by the real format", () => {
  const definitions = builtInSkillDefinitions();
  assert.deepEqual(definitions.map((skill) => skill.id), builtInIds);
  assert.equal(new Set(definitions.map((skill) => skill.id)).size, builtInIds.length);
  for (const definition of definitions) {
    assert.match(definition.description, /^Use when\b/u);
    assert.ok(definition.body.trim().split(/\s+/u).length < 500);
    assert.equal(isBuiltInSkillId(definition.id), true);
  }
  assert.equal(isBuiltInSkillId("mix-review"), false);
});

test("built-in Skill readers return isolated definitions and source-labelled summaries", () => {
  const first = builtInSkillDefinitions();
  first[0]!.body = "mutated";
  assert.notEqual(builtInSkillDefinitions()[0]?.body, "mutated");
  assert.deepEqual(
    availableSkillSummaries([]).map(({ id, source }) => ({ id, source })),
    builtInIds.map((id) => ({ id, source: "built-in" })),
  );
  assert.deepEqual(
    builtInSkillDefinition("arranging-section-energy"),
    builtInSkillDefinitions()[0],
  );
  assert.equal(builtInSkillDefinition("mix-review"), undefined);
});

test("installed summaries shadow same-ID built-ins without mutating either source", () => {
  const installed = [{
    id: "arranging-section-energy",
    description: "User override",
  }];
  const available = availableSkillSummaries(installed);
  assert.deepEqual(
    available.find((skill) => skill.id === "arranging-section-energy"),
    {
      id: "arranging-section-energy",
      description: "User override",
      source: "user",
    },
  );
  installed[0]!.description = "mutated after projection";
  assert.equal(
    available.find((skill) => skill.id === "arranging-section-energy")
      ?.description,
    "User override",
  );
});
