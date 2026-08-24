import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { resolveSkillContext } from "./skill-context.js";

const skillIds = [
  "arranging-section-energy",
  "developing-musical-variation",
  "organizing-instrument-roles",
] as const;

test("built-in arrangement Skills enter requests only while explicitly active", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-skill-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

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
  await assert.rejects(
    fs.stat(path.join(directory, "live-smith-skills")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
