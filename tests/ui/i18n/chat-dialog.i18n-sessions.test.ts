import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

function sessionState() {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  state.openSettingsOnLoad = false;
  state.sessions[0]!.title = "Delete";
  state.sessions[0]!.scope.label = "Track";
  state.previousSessions = [{ ...state.sessions[1]!, id: "session-history" }];
  state.archivedSessions = [{
    ...state.sessions[1]!,
    id: "session-archived",
    archivedAt: "2026-09-01T00:00:00.000Z",
  }];
  state.events = [{
    id: "message-original",
    kind: "assistant",
    content: "Delete / Track / Continue / Agent",
    createdAt: "2026-09-06T00:00:00.000Z",
  }];
  return state;
}

async function changeLanguage(h: DialogHarness, uiLanguage: "en" | "zh-CN", revision: string) {
  const { settings } = sessionState();
  h.emitServerEvent({
    type: "global_settings_changed",
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
    showContextUsage: settings.showContextUsage,
    contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
    networkProxy: settings.networkProxy,
    networkProxyRevision: settings.networkProxyRevision,
    uiLanguage,
    uiLanguageRevision: revision,
    commandId: `external-language-${revision}`,
  });
  await h.settle();
  assert.equal(h.document.documentElement.lang, uiLanguage);
}

function required<T extends Element = HTMLElement>(h: DialogHarness, selector: string): T {
  const node = h.document.querySelector<T>(selector);
  assert.ok(node, `Expected ${selector}`);
  return node;
}

function selectSessions(h: DialogHarness, sessionIds: string[]) {
  for (const id of sessionIds) {
    required(h, `[data-session-id="${id}"] .session-row`).dispatchEvent(
      new h.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  }
}

function assertAuthoredContent(h: DialogHarness) {
  assert.equal(required(h, '[data-session-id="session-1"] .session-title').textContent, "Delete");
  assert.equal(required(h, '[data-event-id="message-original"] .timeline-content').textContent,
    "Delete / Track / Continue / Agent");
  assert.equal(required<HTMLSelectElement>(h, "#composerModel").value, "model-a");
}

for (const bulk of [false, true]) {
  for (const accept of [false, true]) {
    test(`language changes preserve ${bulk ? "bulk" : "single"} Session deletion until ${accept ? "accepted" : "cancelled"}`, async () => {
      const h = await createDialogHarness(sessionState());
      try {
        const ids = bulk ? ["session-1", "session-history", "session-archived"] : ["session-1"];
        if (bulk) selectSessions(h, ids);
        h.click('[data-session-menu-button="session-1"]');
        h.click('[data-session-id="session-1"] [data-session-action="delete"]');
        const entry = required(h, '[data-session-id="session-1"]');
        const menu = required(h, '[data-session-id="session-1"] .session-action-menu');
        const confirmation = required(h, ".session-delete-confirm");
        const cancel = required<HTMLButtonElement>(h, "[data-delete-cancel]");
        const remove = required<HTMLButtonElement>(h, "[data-delete-confirm]");
        const focused = accept ? remove : cancel;
        focused.focus();

        for (const [language, revision] of [["zh-CN", "1"], ["en", "2"], ["zh-CN", "3"]] as const) {
          await changeLanguage(h, language, revision);
          const chinese = language === "zh-CN";
          assert.equal(required(h, '[data-session-id="session-1"]'), entry);
          assert.equal(required(h, ".session-delete-confirm"), confirmation);
          assert.equal(h.document.activeElement, focused);
          assert.equal(menu.hidden, false);
          assert.equal(menu.getAttribute("role"), "presentation");
          assert.equal(required(h, '[data-session-menu-button="session-1"]').getAttribute("aria-expanded"), "true");
          assert.deepEqual(JSON.parse(confirmation.dataset.deleteSessionIds!), ids);
          assert.equal(confirmation.dataset.deleteSessionCount, String(ids.length));
          assert.equal(confirmation.getAttribute("aria-label"), bulk
            ? chinese ? "删除 3 个会话" : "Delete 3 sessions"
            : chinese ? "删除会话 Delete" : "Delete session Delete");
          assert.equal(required(h, ".session-delete-question").textContent, bulk
            ? chinese ? "删除 3 个会话？" : "Delete 3 sessions?"
            : chinese ? "删除此会话？" : "Delete this session?");
          assert.equal(cancel.textContent, chinese ? "取消" : "Cancel");
          assert.equal(remove.textContent, chinese ? "删除" : "Delete");
          assert.equal(cancel.disabled, false);
          assert.equal(remove.disabled, false);
          assert.deepEqual(commandCalls(h), []);
          assertAuthoredContent(h);
        }

        focused.click();
        await h.settle();
        assert.deepEqual(commandCalls(h).map(call => call.body), accept
          ? ids.map(sessionId => ({ kind: "delete_session", sessionId })) : []);
        if (!accept) {
          assert.equal(h.document.querySelector(".session-delete-confirm"), null);
          assert.equal(h.document.activeElement, required(h, '[data-session-menu-button="session-1"]'));
        }
        assert.deepEqual(h.errors, []);
      } finally { h.close(); }
    });
  }
}

for (const bulk of [false, true]) {
  test(`language changes refresh an open ${bulk ? "mixed bulk" : "single"} Session menu in place`, async () => {
    const h = await createDialogHarness(sessionState());
    try {
      if (bulk) selectSessions(h, ["session-1", "session-history", "session-archived"]);
      h.click('[data-session-menu-button="session-1"]');
      const menu = required(h, '[data-session-id="session-1"] .session-action-menu');
      const items = [...menu.querySelectorAll<HTMLButtonElement>("[data-session-action]")];
      const focused = items.find(item => item.dataset.sessionAction === "archive")!;
      focused.focus();
      for (const [language, revision] of [["zh-CN", "1"], ["en", "2"]] as const) {
        await changeLanguage(h, language, revision);
        assert.equal(required(h, '[data-session-id="session-1"] .session-action-menu'), menu);
        const currentItems = [...menu.querySelectorAll("[data-session-action]")];
        assert.equal(currentItems.length, items.length);
        currentItems.forEach((item, index) => assert.equal(item, items[index]));
        assert.equal(menu.hidden, false);
        assert.equal(h.document.activeElement, focused);
        assert.deepEqual(items.map(item => item.textContent), bulk
          ? language === "zh-CN" ? ["归档 2 个选中项", "取消归档 1 个选中项", "删除 3 个会话"]
            : ["Archive 2 Selected", "Unarchive 1 Selected", "Delete 3 Sessions"]
          : language === "zh-CN" ? ["重命名", "归档", "删除"] : ["Rename", "Archive", "Delete"]);
        assert.deepEqual(commandCalls(h), []);
        assertAuthoredContent(h);
      }
      focused.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(menu.hidden, true);
      assert.equal(h.document.activeElement, required(h, '[data-session-menu-button="session-1"]'));
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

for (const key of ["Enter", "Escape"]) {
  test(`language changes preserve the Session rename node, draft and selection before ${key}`, async () => {
    const h = await createDialogHarness(sessionState());
    try {
      const row = required(h, '[data-session-id="session-1"] .session-row');
      row.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      const input = required<HTMLInputElement>(h, ".session-rename-input");
      h.input(".session-rename-input", "Unsaved Delete / Track 🎵");
      input.setSelectionRange(8, 14, "backward");
      for (const [language, revision] of [["zh-CN", "1"], ["en", "2"]] as const) {
        await changeLanguage(h, language, revision);
        assert.equal(required(h, ".session-rename-input"), input);
        assert.equal(h.document.activeElement, input);
        assert.equal(input.value, "Unsaved Delete / Track 🎵");
        assert.equal(input.dataset.originalTitle, "Delete");
        assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [8, 14, "backward"]);
        assert.equal(input.getAttribute("aria-label"), language === "zh-CN" ? "会话名称" : "Session Name");
        assert.deepEqual(commandCalls(h), []);
        assertAuthoredContent(h);
      }
      input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key, bubbles: true }));
      await h.settle();
      assert.deepEqual(commandCalls(h).map(call => call.body), key === "Enter"
        ? [{ kind: "rename_session", sessionId: "session-1", title: "Unsaved Delete / Track 🎵" }] : []);
      assert.equal(h.document.activeElement, row);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("language changes refresh Session scope kinds, dates and Continue labels without changing authored labels", async () => {
  for (const [kind, english, chinese] of [
    ["track", "Track", "轨道"], ["clip", "Clip", "片段"],
    ["object", "Object", "对象"], ["selection", "Selection", "所选内容"],
  ] as const) {
    const state = sessionState();
    state.previousSessions[0]!.scope.kind = kind;
    state.previousSessions[0]!.scope.label = english;
    state.sessionContinueTarget = { kind, label: "Continue" };
    const h = await createDialogHarness(state);
    try {
      const entry = required(h, '[data-session-id="session-history"]');
      const button = required<HTMLButtonElement>(h, '[data-session-id="session-history"] .session-continue-button');
      const meta = required(h, '[data-session-id="session-history"] .session-meta');
      const originalDate = meta.title;
      const originalLabel = button.getAttribute("aria-label");
      button.focus();
      await changeLanguage(h, "zh-CN", "1");
      assert.equal(required(h, '[data-session-id="session-history"]'), entry);
      assert.equal(h.document.activeElement, button);
      assert.equal(button.textContent, "继续");
      assert.equal(button.getAttribute("aria-label"),
        `使用当前的${chinese} Continue 继续会话 Lead session。上次上下文标签：${chinese} ${english}。`);
      assert.equal(meta.textContent, `${chinese} · ${english}`);
      assert.match(meta.title, /^更新于 /);
      assert.notEqual(meta.title, originalDate);
      assertAuthoredContent(h);
      await changeLanguage(h, "en", "2");
      assert.equal(h.document.activeElement, button);
      assert.equal(button.textContent, "Continue");
      assert.equal(button.getAttribute("aria-label"), originalLabel);
      assert.equal(meta.textContent, `${english} · ${english}`);
      assert.equal(meta.title, originalDate);
      assert.deepEqual(commandCalls(h), []);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});
