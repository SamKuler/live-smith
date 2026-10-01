import assert from "node:assert/strict";
import test from "node:test";

import {
  availableSkillSummaries,
  builtInSkillDefinitions,
} from "../../src/skills/builtins.js";
import { uiCatalogs } from "../../src/ui/i18n/messages.js";
import {
  commandCalls,
  createDialogHarness,
  stateFixture,
  type DialogHarness,
} from "./support/chat-dialog.test-harness.js";

function completionElements(harness: DialogHarness) {
  const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  const listbox = harness.document.querySelector<HTMLElement>("#composerAutocomplete");
  assert.ok(prompt && listbox);
  return { prompt, listbox };
}

function pressKey(harness: DialogHarness, prompt: HTMLTextAreaElement, key: string) {
  const event = new harness.window.KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true,
  });
  prompt.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

async function changeLanguage(harness: DialogHarness, language: "en" | "zh-CN", revision: string) {
  const { settings } = stateFixture();
  harness.emitServerEvent({
    type: "global_settings_changed",
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
    showContextUsage: settings.showContextUsage,
    contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
    uiLanguage: language,
    uiLanguageRevision: revision,
    commandId: `external-language-${revision}`,
  });
  await harness.settle();
  assert.equal(harness.document.documentElement.lang, language);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language} Skill autocomplete and sidebar share localized built-in summaries and original IDs`, async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.settings.uiLanguage = language;
    const originalSkills = JSON.stringify(state.availableSkills);
    const harness = await createDialogHarness(state);
    try {
      const { prompt, listbox } = completionElements(harness);
      prompt.focus();
      harness.input("#prompt", "Use $");
      assert.equal(listbox.hidden, false);
      const options = [...listbox.querySelectorAll("[role='option']")];
      assert.equal(options.length, state.availableSkills.length);
      for (const [index, skill] of state.availableSkills.entries()) {
        const translated = uiCatalogs["zh-CN"][skill.description];
        assert.ok(translated && translated !== skill.description);
        const expected = language === "zh-CN" ? translated : skill.description;
        const row = harness.document.querySelector(
          `#builtInSkillList [data-skill-id="${skill.id}"]`,
        );
        assert.equal(row?.querySelector(".skill-copy strong")?.textContent, skill.id);
        assert.equal(row?.querySelector(".skill-copy span")?.textContent, expected);
        assert.equal(options[index]?.querySelector("strong")?.textContent, `$${skill.id}`);
        assert.equal(options[index]?.querySelector("span")?.textContent, expected);
      }
      assert.equal(
        JSON.stringify(harness.readBootstrappedClientStateReference().availableSkills),
        originalSkills,
      );
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });

  test(`${language} autocomplete preserves authored descriptions including built-in text and ID overrides`, async () => {
    const builtIn = builtInSkillDefinitions()[0]!;
    const authored = [
      { id: builtIn.id, description: builtIn.description },
      { id: "authored-copy", description: builtIn.description },
      { id: "authored-notes", description: 'Agent <span data-i18n="Agent">Delete</span> / 自写描述 {id}' },
    ];
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.settings.uiLanguage = language;
    state.availableSkills = availableSkillSummaries(authored);
    const harness = await createDialogHarness(state);
    try {
      const { prompt, listbox } = completionElements(harness);
      for (const skill of authored) {
        const row = harness.document.querySelector(
          `#userSkillList [data-skill-id="${skill.id}"]`,
        );
        assert.ok(row);
        assert.equal(row.querySelector(".skill-copy strong")?.textContent, skill.id);
        assert.equal(row.querySelector(".skill-copy span")?.textContent, skill.description);
        assert.equal(row.querySelector(".skill-view"), null);
        const libraryRow = harness.document.querySelector(
          `#userSkillLibraryList [data-skill-id="${skill.id}"]`,
        );
        assert.equal(libraryRow?.querySelector(".skill-copy strong")?.textContent, skill.id);
        assert.equal(libraryRow?.querySelector(".skill-copy span")?.textContent, skill.description);
        assert.equal(libraryRow?.querySelector(".skill-copy span")?.children.length, 0);
        prompt.focus();
        harness.input("#prompt", `Use $${skill.id}`);
        assert.equal(listbox.hidden, false);
        assert.equal(listbox.querySelectorAll("[role='option']").length, 1);
        const option = listbox.querySelector("[role='option']")!;
        assert.equal(option.querySelector("strong")?.textContent, `$${skill.id}`);
        assert.equal(option.querySelector("span")?.textContent, skill.description);
        assert.equal(option.querySelector("span")?.children.length, 0);
        pressKey(harness, prompt, "Enter");
        assert.equal(prompt.value, `Use $${skill.id} `);
      }
      assert.equal(
        harness.document.querySelector(`#builtInSkillList [data-skill-id="${builtIn.id}"]`),
        null,
      );
      assert.equal(harness.sendIds.length, 0);
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("locale changes refresh an active Skill prefix without changing its draft, caret, or selected suggestion", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  const harness = await createDialogHarness(state);
  try {
    const { prompt, listbox } = completionElements(harness);
    const draft = "Keep Agent / 删除: $ then keep this suffix.";
    const caret = draft.indexOf("$") + 1;
    prompt.focus();
    harness.input("#prompt", draft);
    prompt.setSelectionRange(caret, caret);
    harness.click("#prompt");
    pressKey(harness, prompt, "ArrowDown");
    const selectedId = prompt.getAttribute("aria-activedescendant");
    const selected = listbox.querySelector("[aria-selected='true'] strong")?.textContent;
    const skill = state.availableSkills[1]!;
    assert.equal(selected, `$${skill.id}`);
    for (const [language, revision] of [["zh-CN", "1"], ["en", "2"]] as const) {
      await changeLanguage(harness, language, revision);
      assert.equal(prompt.value, draft);
      assert.equal(prompt.selectionStart, caret);
      assert.equal(prompt.selectionEnd, caret);
      assert.equal(harness.document.activeElement, prompt);
      assert.equal(listbox.hidden, false);
      assert.equal(prompt.getAttribute("aria-expanded"), "true");
      assert.equal(prompt.getAttribute("aria-activedescendant"), selectedId);
      assert.equal(listbox.querySelectorAll("[aria-selected='true']").length, 1);
      assert.equal(listbox.querySelector("[aria-selected='true'] strong")?.textContent, selected);
      const expected = language === "zh-CN" ? uiCatalogs["zh-CN"][skill.description] : skill.description;
      assert.equal(listbox.querySelector("[aria-selected='true'] span")?.textContent, expected);
      assert.equal(
        harness.document.querySelector(`[data-skill-id="${skill.id}"] .skill-copy span`)?.textContent,
        expected,
      );
    }
    pressKey(harness, prompt, "Tab");
    assert.equal(prompt.value, draft.slice(0, caret - 1) + `$${skill.id} ` + draft.slice(caret));
    assert.equal(listbox.hidden, true);
    assert.equal(harness.sendIds.length, 0);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("localized built-in details pass original bodies to Markdown and keep identifiers unchanged", async () => {
  for (const language of ["en", "zh-CN"] as const) {
    const state = stateFixture();
    state.settings.uiLanguage = language;
    const harness = await createDialogHarness(state);
    try {
      harness.click("#skillsTab");
      const body = harness.document.getElementById("skillViewerBody");
      assert.ok(body);
      const renderer = harness.window.LiveSmithMarkdown;
      assert.ok(renderer);
      const renderInto = renderer.renderInto;
      const rendered: string[] = [];
      renderer.renderInto = (target: HTMLElement, source: string) => {
        if (target === body) rendered.push(source);
        renderInto(target, source);
      };
      for (const skill of builtInSkillDefinitions()) {
        harness.click(`#skillManager [data-skill-id="${skill.id}"] .skill-view`);
        assert.equal(harness.document.getElementById("skillViewerId")?.textContent, skill.id);
        assert.equal(
          harness.document.getElementById("skillViewerDescription")?.textContent,
          language === "zh-CN" ? uiCatalogs["zh-CN"][skill.description] : skill.description,
        );
        assert.equal(rendered.at(-1), skill.body);
        assert.ok(body.querySelector("h1"));
        harness.click("#closeSkillViewer");
      }
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});
