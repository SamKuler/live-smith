import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installSkill } from "../storage/skills.js";
import { resolveSkillContext } from "./skill-context.js";

const examplesDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/skills",
);

const skillIds = [
  "arranging-section-energy",
  "developing-musical-variation",
  "organizing-instrument-roles",
] as const;

test("arrangement examples enter requests only while explicitly active", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-skill-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const skillId of skillIds) {
    await installSkill(
      directory,
      await fs.readFile(path.join(examplesDirectory, skillId, "SKILL.md")),
    );
  }

  assert.deepEqual(
    await resolveSkillContext({
      storageDirectory: directory,
      sessionSkillIds: [],
      prompt: "Arrange the middle section.",
    }),
    { activeSkillIds: [], instructionBlock: "" },
  );

  for (const skillId of skillIds) {
    const active = await resolveSkillContext({
      storageDirectory: directory,
      sessionSkillIds: [skillId],
      prompt: "Arrange the middle section.",
    });
    assert.deepEqual(active.activeSkillIds, [skillId]);
    assert.match(active.instructionBlock, new RegExp(`<skill id="${skillId}">`));
    for (const otherSkillId of skillIds) {
      if (otherSkillId === skillId) continue;
      assert.doesNotMatch(
        active.instructionBlock,
        new RegExp(`<skill id="${otherSkillId}">`),
      );
    }

    const mentionedAndActive = await resolveSkillContext({
      storageDirectory: directory,
      sessionSkillIds: [skillId],
      prompt: `$${skillId} Arrange the middle section.`,
    });
    assert.deepEqual(mentionedAndActive.activeSkillIds, [skillId]);
    assert.equal(
      mentionedAndActive.instructionBlock.split(`<skill id="${skillId}">`).length - 1,
      1,
    );
  }
});
