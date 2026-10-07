import assert from "node:assert/strict";
import test from "node:test";
import { freshEmptyAgentSettings } from "../../../../src/model/profile.js";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import { parseCommandInput } from "../../../../src/app/chat/chat-bridge-http.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

test("window host command accepts exactly one supported preference", () => {
  assert.deepEqual(parseCommandInput({ kind: 'save_global_settings', interfaceMode: 'browser' }), { kind: 'save_global_settings', interfaceMode: 'browser' });
  for (const patch of [{ interfaceMode: 'popup' }, { interfaceMode: 'browser', uiLanguage: 'en' }, { interfaceMode: 'modal', interfaceModeRevision: '2' }]) {
    assert.throws(() => parseCommandInput({ kind: 'save_global_settings', ...patch }));
  }
});

test("window host peer publications dominate stale snapshots without replacing newer independent preferences", async () => {
  const { integrationConnections, ...settings } = freshEmptyAgentSettings();
  const bridge = await createChatBridge({
    buildState: async () => ({ settings } as ChatDialogState), renderHtml: () => '<html></html>',
    handleCommand: async () => ({ settings } as ChatDialogState), handleSend: async () => {},
  });
  const url = new URL(bridge.url);
  const read = async () => (await (await fetch(`${url.origin}/state?token=${url.searchParams.get('token')}`)).json()).settings;
  try {
    await read();
    bridge.publishGlobalSettings({ ...settings, interfaceMode: 'browser', interfaceModeRevision: '2', commandId: 'mode-newer' });
    assert.equal((await read()).interfaceMode, 'browser');
    bridge.publishGlobalSettings({ ...settings, interfaceMode: 'modal', interfaceModeRevision: '1', uiLanguage: 'zh-CN', uiLanguageRevision: '3', commandId: 'language-newer' });
    const projected = await read();
    assert.equal(projected.interfaceMode, 'browser');
    assert.equal(projected.interfaceModeRevision, '2');
    assert.equal(projected.uiLanguage, 'zh-CN');
    settings.interfaceMode = 'modal'; settings.interfaceModeRevision = '4';
    const refreshed = await read();
    assert.equal(refreshed.interfaceMode, 'modal');
    assert.equal(refreshed.uiLanguage, 'zh-CN');
  } finally { await bridge.close(); }
});
