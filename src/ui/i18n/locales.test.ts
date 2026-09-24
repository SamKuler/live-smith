import assert from "node:assert/strict";
import test from "node:test";
import { UI_LANGUAGES, isUiLanguage } from "../../i18n/languages.js";
import { parseCommandInput } from "../../app/chat-bridge-http.js";
import { freshEmptyAgentSettings } from "../../model/profile.js";
import { decodeAgentSettings } from "../../storage/settings-migrations.js";
import { createDialogHarness, stateFixture } from "../chat-dialog.test-harness.js";

test("every registered language is accepted by settings, commands, and the composed picker", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const options = [...harness.document.querySelectorAll<HTMLOptionElement>("#uiLanguage option")];
    assert.deepEqual(options.map(option => option.value), ["system", ...UI_LANGUAGES.map(language => language.id)]);
    for (const language of UI_LANGUAGES) {
      assert.equal(isUiLanguage(language.id), true);
      assert.equal(decodeAgentSettings({ ...freshEmptyAgentSettings(), uiLanguage: language.id }).uiLanguage, language.id);
      assert.deepEqual(parseCommandInput({ kind: "save_global_settings", uiLanguage: language.id }),
        { kind: "save_global_settings", uiLanguage: language.id });
      assert.equal(options.find(option => option.value === language.id)?.textContent, language.nativeName);
    }
    assert.equal(isUiLanguage("unregistered"), false);
    assert.throws(() => parseCommandInput({ kind: "save_global_settings", uiLanguage: "unregistered" }));
  } finally { harness.close(); }
});
