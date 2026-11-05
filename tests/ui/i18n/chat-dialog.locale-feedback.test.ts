import assert from "node:assert/strict";
import test from "node:test";

import { uiMessage } from "../../../src/i18n/ui-message.js";
import { SkillFormatError, parseSkillMarkdown } from "../../../src/skills/format.js";
import { audioState, service } from "../support/chat-dialog.audio-test-helpers.js";
import { createDialogHarness, stateFixture, type DialogHarness } from "../support/chat-dialog.test-harness.js";

async function switchToChinese(h: DialogHarness, state: ReturnType<typeof stateFixture>) {
  h.emitServerEvent({
    type: "global_settings_changed",
    defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
    showContextUsage: state.settings.showContextUsage,
    contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
    uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "peer-language",
  });
  await h.settle();
  assert.equal(h.document.documentElement.lang, "zh-CN");
}

test("a connection validation message follows the language while retaining its draft", async () => {
  const state = audioState();
  state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.click("#extensionsTab");
    h.click("#mcpExtensionTab");
    h.click("#addConnectionButton");
    const editor = ".plugin-connection-editor";
    const name = editor + ' [name="connectionName"]';
    h.input(name, service.name);
    h.input(editor + ' [name="mcpUrl"]', "https://mcp.example.test");
    h.click(editor + " .editor-save");
    await h.settle();
    const feedback = () => h.document.querySelector(".plugin-connection-feedback")?.textContent;
    assert.equal(feedback(), "Enter a unique connection name.");
    await switchToChinese(h, state);
    assert.equal(feedback(), "请输入唯一的连接名称。");
    assert.equal(h.document.querySelector<HTMLInputElement>(name)?.value, service.name);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a rejected Plugin save retains its localized feedback and draft through language changes", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  state.plugins = [{
    id: "studio-tools", sha256: "a".repeat(64), version: "1.0.0", sourceFormat: "claude", enabled: false,
    skillCount: 0, skills: [], mcpServers: [], unsupportedComponents: [], issues: [],
    userConfig: {
      revision: "1", fields: [{ name: "amount", title: "Amount", description: "Fractional amount", type: "number", min: 0, max: 1, required: true }],
      values: { amount: 0.5 }, configuredSecrets: [], invalidFields: [],
    },
  }];
  const h = await createDialogHarness(state);
  try {
    h.click("#extensionsTab");
    h.click("#pluginsExtensionTab");
    const panel = "#pluginUserConfig-studio-tools";
    h.click(panel + " > summary");
    const field = panel + ' [name="amount"]';
    h.input(field, "0.75");
    const source = "Plugin parameters changed. Review the current values before saving.";
    h.failNextCommand(source, undefined, { status: 409, displayMessage: uiMessage(source) });
    h.click(panel + ' [data-config-action="save"]');
    await h.settle();
    const feedback = () => h.document.querySelector(".plugin-user-config-status")?.textContent;
    assert.equal(feedback(), source);
    await switchToChinese(h, state);
    assert.equal(feedback(), "插件参数已更改，请检查当前值后再保存。");
    assert.equal(h.document.querySelector<HTMLInputElement>(field)?.value, "0.75");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the pasted Skill example and parser feedback localize while its input remains intact", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  try {
    h.click("#extensionsTab");
    h.click("#skillsExtensionTab");
    h.click(".skill-paste > summary");
    const input = h.document.querySelector<HTMLTextAreaElement>("#skillPasteText")!;
    assert.match(input.placeholder, /name: my-skill\ndescription: 此技能的用途/);
    const text = "This is not a Skill.";
    const original = h.window.fetch;
    Object.defineProperty(h.window, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/skills" && init?.method === "POST") {
        try { parseSkillMarkdown(new TextEncoder().encode(text)); }
        catch (error) {
          assert.ok(error instanceof SkillFormatError);
          return Response.json({ error: error.message, displayMessage: error.displayMessage }, { status: 400 });
        }
      }
      return original(url, init);
    } });
    h.input("#skillPasteText", text);
    h.click("#installPastedSkillButton");
    await h.settleAttachmentOperation();
    assert.equal(h.document.querySelector("#status")?.textContent, "SKILL.md 第 1 行格式有误：缺少开头的分隔符。");
    assert.equal(input.value, text);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
