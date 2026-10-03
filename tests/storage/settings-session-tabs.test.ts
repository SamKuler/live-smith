import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandInput } from "../../src/app/chat/chat-bridge-http.js";
import {
  compareSessionTabsRevisions,
  freshEmptyAgentSettings,
  incrementSessionTabsRevision,
  isSessionTabsRevision,
} from "../../src/model/profile.js";
import { defaultSessionTabs, isSessionTabs, sessionShortcutIds } from "../../src/model/session-tabs.js";
import { decodeAgentSettings } from "../../src/storage/settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";

const invalidSelections = [null, false, 1, "context", [""], ["Context"], ["unknown"], ["context", "context"], [null], Array(1)];

test("Session tabs default historical fields independently and preserve empty selections", () => {
  const { sessionTabs, sessionTabsRevision, ...historical } = freshEmptyAgentSettings();
  assert.deepEqual(decodeAgentSettings(historical).sessionTabs, defaultSessionTabs);
  assert.equal(decodeAgentSettings(historical).sessionTabsRevision, "0");
  assert.deepEqual(decodeAgentSettings({ ...historical, sessionTabs: [] }).sessionTabs, []);
  assert.equal(decodeAgentSettings({ ...historical, sessionTabs: [] }).sessionTabsRevision, "0");
  assert.deepEqual(decodeAgentSettings({ ...historical, sessionTabsRevision: "7" }).sessionTabs, defaultSessionTabs);
  assert.deepEqual(decodeAgentSettings({ ...historical, sessionTabs: ["tools", "context", "skills"] }).sessionTabs,
    ["context", "skills", "tools"]);
  assert.equal(isSessionTabs([...sessionShortcutIds]), true);
  assert.equal(isSessionTabs([]), true);
  for (const value of invalidSelections) {
    assert.equal(isSessionTabs(value), false);
    assert.throws(() => decodeAgentSettings({ ...historical, sessionTabs: value }));
  }
  for (const value of [null, 0, "01", "-1", "1.0", "1e2", ""]) {
    assert.equal(isSessionTabsRevision(value), false);
    assert.throws(() => decodeAgentSettings({ ...historical, sessionTabsRevision: value }));
  }
  assert.equal(incrementSessionTabsRevision("99999999999999999999"), "100000000000000000000");
  assert.equal(compareSessionTabsRevisions("99999999999999999999", "100000000000000000000"), -1);
});

test("Session tabs commands accept a single validated visibility selection", () => {
  for (const sessionTabs of [[], [...sessionShortcutIds], ["tools", "context"]]) {
    assert.deepEqual(parseCommandInput({ kind: "save_global_settings", sessionTabs }),
      { kind: "save_global_settings", sessionTabs });
  }
  for (const input of [
    ...invalidSelections.map((sessionTabs) => ({ kind: "save_global_settings", sessionTabs })),
    { kind: "save_global_settings", sessionTabs: [], showContextUsage: false },
    { kind: "save_global_settings", sessionTabs: [], sessionTabsRevision: "5" },
  ]) assert.throws(() => parseCommandInput(input));
});

test("Session tab saves migrate without read writes and advance only their independent revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-session-tabs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { sessionTabs, sessionTabsRevision, ...historical } = freshEmptyAgentSettings();
  const file = join(directory, "live-smith-settings.json");
  const bytes = JSON.stringify(historical);
  await writeFile(file, bytes);
  await loadAgentSettings(directory);
  assert.equal(await readFile(file, "utf8"), bytes);
  for (const input of [
    {}, ...invalidSelections.map((sessionTabs) => ({ sessionTabs })),
    { sessionTabs: [], showContextUsage: false },
    { sessionTabs: [], sessionTabsRevision: "5" },
  ]) await assert.rejects(saveGlobalSettings(directory, input as never));
  assert.equal(await readFile(file, "utf8"), bytes);
  const writes = await Promise.all([
    saveGlobalSettings(directory, { sessionTabs: ["tools", "context"] }),
    saveGlobalSettings(directory, { showContextUsage: false }),
    saveGlobalSettings(directory, { sessionTabs: [] }),
    saveGlobalSettings(directory, { uiLanguage: "zh-CN" }),
  ]);
  assert.deepEqual(writes[0]!.sessionTabs, ["context", "tools"]);
  assert.equal(writes[0]!.sessionTabsRevision, "1");
  assert.equal(writes[1]!.sessionTabsRevision, "1");
  const saved = await loadAgentSettings(directory);
  assert.deepEqual(saved.sessionTabs, []);
  assert.equal(saved.sessionTabsRevision, "2");
  assert.equal(saved.contextUsageVisibilityRevision, "1");
  assert.equal(saved.uiLanguageRevision, "1");
  assert.equal(saved.defaultFollowUpBehaviorRevision, "0");
  assert.equal(saved.networkProxyRevision, "0");
  assert.equal(saved.customInstructionsRevision, "0");
  assert.equal(saved.approvalMode, "manual");
  assert.deepEqual(saved.profiles, []);
  await writeFile(file, JSON.stringify({ ...saved, sessionTabsRevision: "99999999999999999999" }));
  assert.equal((await saveGlobalSettings(directory, { sessionTabs: ["skills"] })).sessionTabsRevision,
    "100000000000000000000");
});
