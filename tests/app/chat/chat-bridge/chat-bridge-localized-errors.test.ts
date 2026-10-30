import { openBridgeEvents, readEvent } from "../support/bridge-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { uiMessage, UiMessageError, formatUiMessage } from "../../../../src/i18n/ui-message.js";
import { ChatBridgeCommandOutcomeUnknownError, createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

for (const unknown of [false, true]) test(`command errors preserve localized data through HTTP and WebSocket; unknown=${unknown}`, { timeout: 5000 }, async () => {
  const displayMessage = uiMessage('Parameter "{name}" changed before its write.', { name: 'applied <Gain> {name}' });
  const error = unknown ? new ChatBridgeCommandOutcomeUnknownError(displayMessage, { cause: new Error("private diagnostic") }) : new UiMessageError(displayMessage);
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "", handleSend: async () => state,
    handleCommand: async () => { throw error; }, readDeviceParameters: async () => { throw error; } });
  const url = new URL(bridge.url);
  const endpoint = (path: string) => `${url.origin}${path}${url.search}`;
  const response = await openBridgeEvents(endpoint("/events"));
  const event = readEvent(response, "error");
  const received = event.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const command = await fetch(endpoint("/command"), { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "localized-command" }, body: JSON.stringify({ kind: "new_session" }) });
    assert.equal(command.status, 500); const body = await command.json() as Record<string, unknown>;
    assert.equal(body.error, formatUiMessage(displayMessage)); assert.deepEqual(body.displayMessage, displayMessage);
    assert.equal(body.commandOutcome, unknown ? "unknown" : undefined);
    const result = await received; assert.ok("value" in result); assert.deepEqual(result.value.displayMessage, displayMessage);
    assert.equal(result.value.commandId, "localized-command"); assert.equal(JSON.stringify(body).includes("private diagnostic"), false);
    const preview = await fetch(endpoint("/device-parameters"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "session-1" }) });
    assert.deepEqual((await preview.json() as { displayMessage: unknown }).displayMessage, displayMessage);
  } finally { await response.close(); await bridge.close(); }
});
