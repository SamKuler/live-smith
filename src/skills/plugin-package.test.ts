import assert from "node:assert/strict";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { pluginSkillsFromArchive } from "./plugin-package.js";

const manifest = (name: string): Uint8Array => strToU8(JSON.stringify({
  name, version: "1.0.0", description: "Fixture Plugin",
}));

test("portable Plugin Skills are namespaced and retain their instructions", async () => {
  const skills = await pluginSkillsFromArchive("music-tools", zipSync({
    "plugin.json": manifest("music-tools"),
    "skills/transcribe/SKILL.md": strToU8([
      "---", "name: transcribe", "description: Transcribe an audio artifact", "---", "Use the transcription tool.", "",
    ].join("\n")),
  }));
  assert.deepEqual(skills, [{
    id: "music-tools:transcribe",
    description: "Transcribe an audio artifact",
    body: "Use the transcription tool.\n",
    pluginId: "music-tools",
    localId: "transcribe",
  }]);
});

test("Claude-compatible Skills may derive the local name from their directory", async () => {
  const skills = await pluginSkillsFromArchive("claude-tools", zipSync({
    ".claude-plugin/plugin.json": manifest("claude-tools"),
    "skills/audio-to-midi/SKILL.md": strToU8([
      "---", "description: Convert selected audio to MIDI", "disable-model-invocation: true", "---",
      "Call the conversion tool only when requested.", "",
    ].join("\n")),
  }));
  assert.equal(skills[0]!.id, "claude-tools:audio-to-midi");
  assert.equal(skills[0]!.description, "Convert selected audio to MIDI");
});

test("Plugin Skill identity cannot disagree with its directory", async () => {
  await assert.rejects(pluginSkillsFromArchive("music-tools", zipSync({
    "plugin.json": manifest("music-tools"),
    "skills/transcribe/SKILL.md": strToU8([
      "---", "name: another-name", "description: Mismatch", "---", "Body", "",
    ].join("\n")),
  })), /directory/u);
});

test("only direct Skill package entries are discovered", async () => {
  const skills = await pluginSkillsFromArchive("music-tools", zipSync({
    "plugin.json": manifest("music-tools"),
    "skills/transcribe/SKILL.md": strToU8("---\ndescription: Transcribe\n---\nInstructions\n"),
    "skills/transcribe/references/example.md": strToU8("Reference"),
    "skills/nested/child/SKILL.md": strToU8("---\ndescription: Hidden\n---\nInstructions\n"),
  }));
  assert.deepEqual(skills.map((skill) => skill.id), ["music-tools:transcribe"]);
});
