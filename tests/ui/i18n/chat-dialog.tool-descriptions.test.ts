import assert from "node:assert/strict";
import test from "node:test";

import { liveSmithTools } from "../../../src/agent/tool-definitions.js";
import { uiCatalogs } from "../../../src/ui/i18n/messages.js";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("the open tool details translate built-in help and keep external descriptions verbatim", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  const { name, description } = liveSmithTools().find(tool => tool.function.name === "inspect_current_object")!.function;
  state.sessionToolCatalog = {
    sessionId: state.activeSessionId, loadedAt: "2026-11-08T00:00:00.000Z",
    modelToolsSupported: true, truncated: false, issues: [],
    groups: [
      { kind: "live", tools: [{ name, description }] },
      { kind: "mcp", pluginId: "external-tools", serverId: "fixture", tools: [{ name, description }] },
    ],
  };
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    for (const source of ["live", "mcp"]) {
      const group = `[data-tool-source="${source}"]`;
      h.click(`${group} > summary`);
      h.click(`${group} .tool-entry > summary`);
      h.click(`${group} .tool-information > summary`);
      assert.equal(h.document.querySelector(`${group} .tool-description`)!.textContent, description);
    }

    h.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
      uiLanguage: "zh-CN",
      uiLanguageRevision: "1",
      commandId: "peer-language",
    });
    await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");

    const live = h.document.querySelector('[data-tool-source="live"]')!;
    assert.notEqual(live.querySelector(".tool-description")!.textContent, description);
    assert.equal(live.querySelector(".tool-description")!.textContent, uiCatalogs["zh-CN"][description]);
    assert.equal(live.querySelector(".tool-name")!.textContent, name);
    const external = h.document.querySelector('[data-tool-source="mcp"]')!;
    assert.equal(external.querySelector(".tool-description")!.textContent, description);
    assert.equal(external.querySelector(".tool-entry > summary")!.textContent, name);
    for (const group of [live, external]) {
      assert.equal(group.hasAttribute("open"), true);
      assert.equal(group.querySelector(".tool-entry")!.hasAttribute("open"), true);
      assert.equal(group.querySelector(".tool-information")!.hasAttribute("open"), true);
    }
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
