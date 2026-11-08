import assert from "node:assert/strict";
import test from "node:test";

import { liveSmithTools } from "../../../src/agent/tool-definitions.js";
import { audioParameterGroups } from "../../../src/plugins/builtins/parameter-panel.js";
import { MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH } from "../../../src/ui/chat-state.js";
import { liveToolHelp } from "../../../src/ui/i18n/tool-messages.js";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("built-in tools use user-facing help independently of model instructions and preserve external descriptions", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  const { name } = liveSmithTools().find(tool => tool.function.name === "inspect_current_object")!.function;
  const description = "Model-only pagination instructions changed independently of the UI.";
  const [english, chinese] = liveToolHelp[name]!;
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
      assert.equal(h.document.querySelector(`${group} .tool-description`)!.textContent, source === "live" ? english : description);
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
    assert.equal(live.querySelector(".tool-description")!.textContent, chinese);
    const external = h.document.querySelector('[data-tool-source="mcp"]')!;
    assert.equal(external.querySelector(".tool-description")!.textContent, description);
    assert.equal(external.querySelector(".tool-entry > summary")!.textContent, name);
    for (const group of [live, external]) {
      assert.equal(group.hasAttribute("open"), true);
      assert.equal(group.querySelector(".tool-entry")!.hasAttribute("open"), true);
    }
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the built-in audio tool and its parameter panel use the same short, localized explanation", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "zh-CN";
  const groups = audioParameterGroups({
    services: [{ id: "suno-studio", name: "Suno Studio", provider: "suno", pluginId: "live-smith.suno-website" }],
    hasJobs: false,
    identity: () => "fixture",
  });
  for (const group of groups) for (const tool of group.tools) {
    if (tool.description.length > MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH) {
      tool.description = tool.description.slice(0, MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH - 1) + "…";
    }
  }
  state.sessionToolCatalog = {
    sessionId: state.activeSessionId, loadedAt: "2026-11-08T00:00:00.000Z",
    modelToolsSupported: true, truncated: false, issues: [], groups,
  };
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const tool = '[data-tool-key$=":builtin_suno_generate_music"]';
    h.click(tool + " > summary");
    const help = h.document.querySelector(tool + " .tool-description");
    assert.match(help?.textContent ?? "", /生成音乐.*付费额度/);
    h.click(tool + " .audio-open-panel");
    assert.equal(h.document.querySelector(".audio-parameter-dialog .audio-parameter-description p")?.textContent,
      help?.textContent);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
