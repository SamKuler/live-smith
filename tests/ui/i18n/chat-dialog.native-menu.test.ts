import assert from "node:assert/strict";
import test from "node:test";

import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";
import { nativeBridge } from "../support/native-drag.test-harness.js";

const menuLabels = {
  quit: "Quit Live Smith",
  file: "File",
  closeWindow: "Close Window",
  edit: "Edit",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
};

test("the standalone host sends only translated menu labels through its Live WebKit handler", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state, nativeBridge);
  try {
    assert.deepEqual(h.errors, []);
    const messages = () => JSON.parse(JSON.stringify(h.hostMessages));
    assert.deepEqual(messages(), [{ method: "update_menu_labels", params: [menuLabels] }]);

    h.click("#appTab");
    h.select("#uiLanguage", "zh-CN");
    await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");
    const { LiveSmithI18n: i18n } = h.window as unknown as { LiveSmithI18n: { t(source: string): string } };
    const translated = Object.fromEntries(Object.entries(menuLabels).map(([field, source]) => [field, i18n.t(source)]));
    for (const title of Object.values(translated)) assert.match(title, /\p{Script=Han}/u);
    assert.deepEqual(messages(), [
      { method: "update_menu_labels", params: [menuLabels] },
      { method: "update_menu_labels", params: [translated] },
    ]);
    assert.equal(h.document.title, "Live Smith");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("native menu refresh leaves other host channels idle", async () => {
  for (const hostMode of ["modal", "browser"] as const) {
    const state = stateFixture();
    state.settings.uiLanguage = "en";
    const h = await createDialogHarness(state, { ...nativeBridge, hostMode, nativeArtifactDrag: false });
    try {
      assert.deepEqual(h.errors, []);
      h.click("#appTab");
      h.select("#uiLanguage", "zh-CN");
      await h.settle();
      assert.equal(h.document.documentElement.lang, "zh-CN");
      assert.deepEqual(h.hostMessages, []);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});
