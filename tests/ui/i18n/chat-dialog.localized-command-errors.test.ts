import assert from "node:assert/strict";
import test from "node:test";
import { formatUiMessage, uiMessage } from "../../../src/i18n/ui-message.js";
import { createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

for (const transport of ["http", "sse"] as const) test(`${transport} command errors localize and preserve literal parameter names`, async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  const name = 'applied <Gain> {name}';
  const displayMessage = uiMessage('Parameter "{name}" changed before its write.', { name });
  try {
    h.failNextCommand(formatUiMessage(displayMessage), undefined, { displayMessage });
    if (transport === "sse") h.holdNextCommand();
    h.click("#newSessionButton");
    await waitForCondition(() => h.commandIds.length > 0, "Expected a command admission");
    if (transport === "sse") {
      h.emitServerEvent({ type: "error", commandId: h.commandIds[0], message: formatUiMessage(displayMessage), displayMessage: { source: "Delete", values: [] } });
      await h.settle(); assert.doesNotMatch(h.document.querySelector("#status")!.textContent!, /删除/);
      h.emitServerEvent({ type: "error", commandId: h.commandIds[0], message: formatUiMessage(displayMessage), displayMessage });
    }
    await h.settle();
    const status = h.document.querySelector("#status")!;
    assert.equal(status.textContent, `参数“${name}”在写入前发生了变化。`); assert.equal(status.querySelector("gain"), null);
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision, showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision, uiLanguage: "en", uiLanguageRevision: "1", commandId: "external-language" });
    await h.settle(); assert.equal(status.textContent, formatUiMessage(displayMessage)); assert.deepEqual(h.errors, []);
  } finally { if (transport === "sse") { h.releaseHeldCommand(); await h.settle(); } h.close(); }
});
