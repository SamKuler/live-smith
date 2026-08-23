import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSkillMarkdown } from "./format.js";

const examplesDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/skills",
);

const arrangementSkillIds = [
  "arranging-section-energy",
  "developing-musical-variation",
  "organizing-instrument-roles",
] as const;

test("arrangement example Skills satisfy the real parser and stay concise", async () => {
  for (const skillId of arrangementSkillIds) {
    const bytes = await fs.readFile(
      path.join(examplesDirectory, skillId, "SKILL.md"),
    );
    const parsed = parseSkillMarkdown(bytes);
    assert.equal(parsed.id, skillId);
    assert.match(parsed.description, /^Use when\b/u);
    assert.ok(parsed.body.trim().split(/\s+/u).length < 500);
  }
});
