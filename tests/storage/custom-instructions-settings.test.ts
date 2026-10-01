import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCommandInput } from "../../src/app/chat-bridge-http.js";
import {
  MAX_CUSTOM_INSTRUCTIONS_CODE_POINTS,
  compareCustomInstructionsRevisions,
  freshEmptyAgentSettings,
  incrementCustomInstructionsRevision,
  isCustomInstructionsRevision,
} from "../../src/model/profile.js";
import { decodeAgentSettings } from "../../src/storage/settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";

test("Custom Instructions adjacent settings default independently and validate bounded user text", () => {
  const { customInstructions, customInstructionsRevision, ...historical } = freshEmptyAgentSettings();
  assert.equal(decodeAgentSettings(historical).customInstructions, "");
  assert.equal(decodeAgentSettings(historical).customInstructionsRevision, "0");
  assert.equal(decodeAgentSettings({ ...historical, customInstructions: "  Use MIDI.  " }).customInstructions, "Use MIDI.");
  assert.equal(decodeAgentSettings({ ...historical, customInstructionsRevision: "7" }).customInstructions, "");
  for (const value of [null, false, 1, "x\0y", "🎵".repeat(MAX_CUSTOM_INSTRUCTIONS_CODE_POINTS + 1)]) {
    assert.throws(() => decodeAgentSettings({ ...historical, customInstructions: value }));
  }
  for (const value of [null, 0, "01", "-1", "1.0", ""]) {
    assert.equal(isCustomInstructionsRevision(value), false);
    assert.throws(() => decodeAgentSettings({ ...historical, customInstructionsRevision: value }));
  }
  assert.equal(incrementCustomInstructionsRevision("99999999999999999999"), "100000000000000000000");
  assert.equal(compareCustomInstructionsRevisions("9", "10"), -1);
});

test("Custom Instructions command accepts only one normalized bounded setting", () => {
  assert.deepEqual(parseCommandInput({
    kind: "save_global_settings",
    customInstructions: "  Prefer hybrid workflows.  ",
  }), {
    kind: "save_global_settings",
    customInstructions: "Prefer hybrid workflows.",
  });
  for (const input of [
    { kind: "save_global_settings", customInstructions: 1 },
    { kind: "save_global_settings", customInstructions: "x\0y" },
    { kind: "save_global_settings", customInstructions: "x", showContextUsage: false },
    { kind: "save_global_settings", customInstructions: "🎵".repeat(MAX_CUSTOM_INSTRUCTIONS_CODE_POINTS + 1) },
  ]) assert.throws(() => parseCommandInput(input));
});

test("Custom Instructions save as one global setting and preserve unrelated settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-custom-instructions-"));
  try {
    const { customInstructions, customInstructionsRevision, ...historical } = freshEmptyAgentSettings();
    const file = join(directory, "live-smith-settings.json");
    const bytes = JSON.stringify(historical);
    await writeFile(file, bytes);
    await loadAgentSettings(directory);
    assert.equal(await readFile(file, "utf8"), bytes);

    const saved = await saveGlobalSettings(directory, {
      customInstructions: "  Write complete arrangements.  ",
    });
    assert.equal(saved.customInstructions, "Write complete arrangements.");
    assert.equal(saved.customInstructionsRevision, "1");
    assert.equal(saved.defaultFollowUpBehaviorRevision, "0");
    assert.equal(saved.networkProxyRevision, "0");
    assert.equal((await loadAgentSettings(directory)).customInstructions, "Write complete arrangements.");

    const cleared = await saveGlobalSettings(directory, { customInstructions: "  " });
    assert.equal(cleared.customInstructions, "");
    assert.equal(cleared.customInstructionsRevision, "2");
    for (const invalid of [
      {},
      { customInstructions: "MIDI", showContextUsage: false },
      { customInstructions: "x", customInstructionsRevision: "5" },
    ]) await assert.rejects(saveGlobalSettings(directory, invalid as never));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
