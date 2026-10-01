import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
} from "../support/chat-dialog.test-harness.js";

function customInstructionCommands(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): Array<Record<string, unknown>> {
  return commandCalls(harness)
    .map((call) => call.body as Record<string, unknown>)
    .filter((body) => body.kind === "save_global_settings" &&
      Object.hasOwn(body, "customInstructions"));
}

test("Agent settings expose global Custom Instructions and save the current draft", async () => {
  const state = stateFixture();
  state.settings.customInstructions = "Prefer editable MIDI arrangements.";
  const harness = await createDialogHarness(state);
  try {
    harness.click("#agentTab");
    const panel = harness.document.querySelector<HTMLElement>("#agentPanel");
    const section = harness.document.querySelector<HTMLElement>("#customInstructionsSettings");
    const control = harness.document.querySelector<HTMLTextAreaElement>("#customInstructions");
    const save = harness.document.querySelector<HTMLButtonElement>("#saveCustomInstructionsButton");
    assert.equal(panel?.hidden, false);
    assert.ok(section && panel?.contains(section));
    assert.equal(control?.value, "Prefer editable MIDI arrangements.");
    assert.equal(save?.disabled, true);

    harness.input("#customInstructions", "  Use Suno for rendered sketches, then arrange the selected idea as MIDI.  ");
    assert.equal(save?.disabled, false);
    assert.match(harness.document.querySelector("#customInstructionsStatus")?.textContent ?? "", /Unsaved/i);
    harness.click("#saveCustomInstructionsButton");
    await harness.settle();

    assert.deepEqual(customInstructionCommands(harness).at(-1), {
      kind: "save_global_settings",
      customInstructions: "Use Suno for rendered sketches, then arrange the selected idea as MIDI.",
    });
    assert.equal(control?.value, "Use Suno for rendered sketches, then arrange the selected idea as MIDI.");
    assert.equal(save?.disabled, true);
    assert.equal(harness.document.querySelector("#customInstructionsStatus")?.textContent, "");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Custom Instructions errors focus Agent settings and a newer clean value is adopted", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#customInstructions", "Draft preference");
    harness.failNextCommand("Custom Instructions are invalid.", "customInstructions");
    harness.click("#saveCustomInstructionsButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#agentTab")?.getAttribute("aria-selected"), "true");
    assert.equal(harness.document.activeElement?.id, "customInstructions");
    assert.match(harness.document.querySelector("#customInstructionsError")?.textContent ?? "", /invalid/i);
  } finally {
    harness.close();
  }

  const cleanState = stateFixture();
  const peer = await createDialogHarness(cleanState);
  try {
    peer.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: cleanState.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: cleanState.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: cleanState.settings.showContextUsage,
      contextUsageVisibilityRevision: cleanState.settings.contextUsageVisibilityRevision,
      customInstructions: "Prefer hybrid MIDI and rendered-audio workflows.",
      customInstructionsRevision: "1",
      networkProxy: cleanState.settings.networkProxy,
      networkProxyRevision: cleanState.settings.networkProxyRevision,
      uiLanguage: cleanState.settings.uiLanguage,
      uiLanguageRevision: cleanState.settings.uiLanguageRevision,
      commandId: "peer-custom-instructions",
    });
    await peer.settle();
    assert.equal(
      peer.document.querySelector<HTMLTextAreaElement>("#customInstructions")?.value,
      "Prefer hybrid MIDI and rendered-audio workflows.",
    );
    assert.equal(peer.document.querySelector<HTMLButtonElement>("#saveCustomInstructionsButton")?.disabled, true);
    assert.deepEqual(peer.errors, []);
  } finally {
    peer.close();
  }
});
