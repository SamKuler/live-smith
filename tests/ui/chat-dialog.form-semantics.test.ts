import assert from "node:assert/strict";
import test from "node:test";

import { createDialogHarness } from "./support/chat-dialog.test-harness.js";

test("rendered form controls have stable names", async () => {
  const harness = await createDialogHarness();
  try {
    const unnamed = [
      ...harness.document.querySelectorAll(
        "input:not([name]), select:not([name]), textarea:not([name])",
      ),
    ].map((control) => control.id || control.outerHTML);
    assert.deepEqual(unnamed, []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("settings help follows the heading or label it explains", async () => {
  const harness = await createDialogHarness();
  try {
    for (const [ownerSelector, helpSelector] of [
      ["#modelSettingsHeading", "#discoverModelsHelp"],
      ["#customInstructionsHeading", "#customInstructionsSettings > .inspector-scope-header > .inline-help"],
      ["#skillsHeading", "#skillManager > .inspector-scope-header > .inline-help"],
    ] as const) {
      const owner = harness.document.querySelector(ownerSelector);
      const help = harness.document.querySelector(helpSelector);
      assert.equal(owner?.nextElementSibling, help, ownerSelector);
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
