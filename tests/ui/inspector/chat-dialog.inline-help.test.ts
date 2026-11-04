import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("keyboard collapse dismisses pinned help inside a disclosure and retains summary focus", async () => {
  const h = await createDialogHarness(stateFixture());
  try {
    const disclosure = h.document.querySelector<HTMLDetailsElement>("#manualModelEntry")!;
    const summary = disclosure.querySelector("summary")!;
    summary.click();
    const button = h.document.querySelector<HTMLButtonElement>("#manualModelHelp")!;
    button.focus(); button.click(); await h.settle();
    const tip = h.document.querySelector<HTMLElement>('[role="tooltip"]')!;
    assert.equal(tip.hidden, false);
    summary.focus(); summary.click(); await h.settle();
    assert.equal(disclosure.open, false);
    assert.equal(tip.hidden, true);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(h.document.activeElement, summary);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("field help opens by click, stays readable under the pointer, and closes with Escape or an outside click", async () => {
  const h = await createDialogHarness(stateFixture());
  try {
    const button = h.document.querySelector<HTMLButtonElement>("#baseUrlHelp")!;
    button.focus(); button.click(); await h.settle();
    const tip = h.document.querySelector<HTMLElement>('[role="tooltip"]')!;
    assert.ok(tip && !tip.hidden);
    assert.equal(tip.parentElement, h.document.body);
    assert.equal(tip.textContent, button.dataset.tooltip);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    button.dispatchEvent(new h.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: tip }));
    tip.dispatchEvent(new h.window.MouseEvent("pointerover", { bubbles: true, relatedTarget: button }));
    await h.settle(); assert.equal(tip.hidden, false);
    button.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(tip.hidden, true); assert.equal(h.document.activeElement, button);
    button.click(); await h.settle(); assert.equal(tip.hidden, false);
    h.document.body.dispatchEvent(new h.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(tip.hidden, true); assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("open help follows a peer language change without replacing the focused control or draft", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.input("#baseUrl", "https://example.test/my-api");
    const button = h.document.querySelector<HTMLButtonElement>("#baseUrlHelp")!;
    button.focus(); button.click(); await h.settle();
    const tip = h.document.querySelector<HTMLElement>('[role="tooltip"]')!;
    assert.ok(tip && !tip.hidden); const english = tip.textContent;
    h.emitServerEvent({ type: "global_settings_changed", commandId: "peer-language", defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision, showContextUsage: state.settings.showContextUsage, contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.settle();
    assert.notEqual(tip.textContent, english);
    assert.equal(tip.textContent, button.dataset.tooltip);
    assert.equal(tip.hidden, false); assert.equal(h.document.activeElement, button);
    assert.equal(h.document.querySelector<HTMLInputElement>("#baseUrl")!.value, "https://example.test/my-api");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
