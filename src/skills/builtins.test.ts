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
  const definitions = builtInIds.map((id) => builtInSkillDefinition(id)!);
  assert.deepEqual(availableSkillSummaries([]).map((skill) => skill.id), builtInIds);
  for (const definition of definitions) {
    assert.match(definition.description, /^Use when\b/u);
    assert.ok(definition.body.trim().split(/\s+/u).length < 500);
    assert.equal(isBuiltInSkillId(definition.id), true);
  }
  assert.equal(isBuiltInSkillId("mix-review"), false);
});

test("built-in Skill readers return isolated definitions and source-labelled summaries", () => {
  const first = builtInSkillDefinition("arranging-section-energy")!;
  first.body = "mutated";
  assert.notEqual(
    builtInSkillDefinition("arranging-section-energy")?.body,
    "mutated",
  );
  assert.deepEqual(
    availableSkillSummaries([]).map(({ id, source }) => ({ id, source })),
    builtInIds.map((id) => ({ id, source: "built-in" })),
  );
  assert.equal(builtInSkillDefinition("mix-review"), undefined);
});

test("the complete built-in registry is a sorted snapshot of canonical definitions", () => {
  const snapshot = builtInSkillDefinitions();
  assert.deepEqual(snapshot, builtInIds.map((id) => builtInSkillDefinition(id)));
  snapshot[0]!.body = "Changed reader body";
  snapshot[0]!.description = "Changed reader description";
  snapshot.pop();
  assert.deepEqual(
    builtInSkillDefinitions(),
    builtInIds.map((id) => builtInSkillDefinition(id)),
  );
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
