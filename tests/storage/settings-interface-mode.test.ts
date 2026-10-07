import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshEmptyAgentSettings, compareInterfaceModeRevisions, incrementInterfaceModeRevision,
} from "../../src/model/profile.js";
import { decodeAgentSettings } from "../../src/storage/settings-migrations.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";

test("interface mode migration defaults missing fields independently and rejects invalid present values", () => {
  const { interfaceMode, interfaceModeRevision, ...historical } = freshEmptyAgentSettings();
  assert.equal(decodeAgentSettings(historical).interfaceMode, "modal");
  assert.equal(decodeAgentSettings(historical).interfaceModeRevision, "0");
  assert.equal(decodeAgentSettings({ ...historical, interfaceMode: "browser" }).interfaceModeRevision, "0");
  assert.equal(decodeAgentSettings({ ...historical, interfaceModeRevision: "7" }).interfaceMode, "modal");
  assert.equal(incrementInterfaceModeRevision("99999999999999999999"), "100000000000000000000");
  assert.equal(compareInterfaceModeRevisions("99999999999999999999", "100000000000000000000"), -1);
  for (const value of [null, false, "", "popup", "BROWSER", 1]) {
    assert.throws(() => decodeAgentSettings({ ...historical, interfaceMode: value }));
  }
  for (const value of [null, 0, "01", "-1", "1.0", "1e2", ""]) {
    assert.throws(() => decodeAgentSettings({ ...historical, interfaceModeRevision: value }));
  }
});

test("interface mode saves migrate without read writes, serialize independently, and accept one setting only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-interface-mode-"));
  try {
    const { interfaceMode, interfaceModeRevision, ...historical } = freshEmptyAgentSettings();
    const file = join(directory, "live-smith-settings.json");
    const bytes = JSON.stringify(historical);
    await writeFile(file, bytes);
    await loadAgentSettings(directory);
    assert.equal(await readFile(file, "utf8"), bytes);
    for (const input of [{}, { interfaceMode: "popup" }, { interfaceMode: "modal", showContextUsage: false }, { interfaceMode: "modal", interfaceModeRevision: "5" }]) {
      await assert.rejects(saveGlobalSettings(directory, input as never));
    }
    const writes = await Promise.all([
      saveGlobalSettings(directory, { interfaceMode: "modal" }),
      saveGlobalSettings(directory, { showContextUsage: false }),
      saveGlobalSettings(directory, { interfaceMode: "browser" }),
      saveGlobalSettings(directory, { defaultFollowUpBehavior: "steer" }),
    ]);
    assert.equal(writes[0]!.interfaceModeRevision, "1");
    assert.equal(writes[1]!.interfaceModeRevision, "1");
    const saved = await loadAgentSettings(directory);
    assert.equal(saved.interfaceMode, "browser");
    assert.equal(saved.interfaceModeRevision, "2");
    assert.equal(saved.contextUsageVisibilityRevision, "1");
    assert.equal(saved.defaultFollowUpBehaviorRevision, "1");
    assert.equal(saved.networkProxyRevision, "0");
    assert.equal(saved.approvalMode, "manual");
    assert.deepEqual(saved.profiles, []);
    assert.equal((await saveGlobalSettings(directory, { interfaceMode: "modal" })).interfaceModeRevision, "3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
