import assert from "node:assert/strict";
import test from "node:test";

import { freshEmptyAgentSettings } from "../../../../src/model/profile.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";

test("Custom Instructions reconcile independently from other global settings", async (t) => {
  let source = {
    sessions: [],
    settings: freshEmptyAgentSettings(),
  } as unknown as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => source,
    renderHtml: () => "",
    handleCommand: async () => source,
    handleSend: async () => {},
  });
  t.after(() => bridge.close());
  const url = new URL(bridge.url);
  const stateUrl = `${url.origin}/state?token=${url.searchParams.get("token")}`;
  await (await fetch(stateUrl)).json();

  bridge.publishGlobalSettings({
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
    showContextUsage: true,
    contextUsageVisibilityRevision: "0",
    customInstructions: "Prefer editable MIDI.",
    customInstructionsRevision: "1",
    networkProxy: { mode: "none", url: "" },
    networkProxyRevision: "0",
    uiLanguage: "system",
    uiLanguageRevision: "0",
    sessionTabs: ["context", "brief", "artifacts"],
    sessionTabsRevision: "0",
    commandId: "custom-1",
  });
  let projected = await (await fetch(stateUrl)).json() as ChatDialogState;
  assert.equal(projected.settings.customInstructions, "Prefer editable MIDI.");
  assert.equal(projected.settings.customInstructionsRevision, "1");

  source = {
    ...source,
    settings: {
      ...source.settings,
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      customInstructions: "stale",
      customInstructionsRevision: "0",
    },
  };
  projected = await (await fetch(stateUrl)).json() as ChatDialogState;
  assert.equal(projected.settings.defaultFollowUpBehavior, "steer");
  assert.equal(projected.settings.customInstructions, "Prefer editable MIDI.");
  assert.equal(projected.settings.customInstructionsRevision, "1");
});
