import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshEmptyAgentSettings,
  compareUiLanguageRevisions,
  incrementUiLanguageRevision,
  isUiLanguageRevision,
} from "../../src/model/profile.js";
import { decodeAgentSettings } from "../../src/storage/settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";

test("language migration defaults missing fields independently and rejects invalid present values", () => {
  const { uiLanguage, uiLanguageRevision, ...historical } = freshEmptyAgentSettings();
  assert.equal(decodeAgentSettings(historical).uiLanguage, "system");
  assert.equal(decodeAgentSettings(historical).uiLanguageRevision, "0");
  assert.equal(decodeAgentSettings({ ...historical, uiLanguage: "zh-CN" }).uiLanguageRevision, "0");
  assert.equal(decodeAgentSettings({ ...historical, uiLanguageRevision: "7" }).uiLanguage, "system");
  for (const value of [null, false, "", "zh", "EN", 1]) {
    assert.throws(() => decodeAgentSettings({ ...historical, uiLanguage: value }));
  }
  for (const value of [null, 0, "01", "-1", "1.0", "1e2", ""]) {
    assert.equal(isUiLanguageRevision(value), false);
    assert.throws(() => decodeAgentSettings({ ...historical, uiLanguageRevision: value }));
  }
  assert.equal(incrementUiLanguageRevision("99999999999999999999"), "100000000000000000000");
  assert.equal(compareUiLanguageRevisions("99999999999999999999", "100000000000000000000"), -1);
});

test("language saves migrate without read writes, serialize independently, and accept one setting only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-language-"));
  try {
    const { uiLanguage, uiLanguageRevision, ...historical } = freshEmptyAgentSettings();
    const file = join(directory, "live-smith-settings.json");
    const bytes = JSON.stringify(historical);
    await writeFile(file, bytes);
    await loadAgentSettings(directory);
    assert.equal(await readFile(file, "utf8"), bytes);
    for (const input of [{}, { uiLanguage: "zh" }, { uiLanguage: "en", showContextUsage: false }, { uiLanguage: "en", uiLanguageRevision: "5" }]) {
      await assert.rejects(saveGlobalSettings(directory, input as never));
    }
    const writes = await Promise.all([
      saveGlobalSettings(directory, { uiLanguage: "en" }),
      saveGlobalSettings(directory, { showContextUsage: false }),
      saveGlobalSettings(directory, { uiLanguage: "zh-CN" }),
      saveGlobalSettings(directory, { defaultFollowUpBehavior: "steer" }),
    ]);
    assert.equal(writes[0]!.uiLanguageRevision, "1");
    assert.equal(writes[1]!.uiLanguageRevision, "1");
    const saved = await loadAgentSettings(directory);
    assert.equal(saved.uiLanguage, "zh-CN");
    assert.equal(saved.uiLanguageRevision, "2");
    assert.equal(saved.contextUsageVisibilityRevision, "1");
    assert.equal(saved.defaultFollowUpBehaviorRevision, "1");
    assert.equal(saved.networkProxyRevision, "0");
    assert.equal(saved.approvalMode, "manual");
    assert.deepEqual(saved.profiles, []);
    assert.equal((await saveGlobalSettings(directory, { uiLanguage: "system" })).uiLanguageRevision, "3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
