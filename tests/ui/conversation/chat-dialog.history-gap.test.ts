import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { URL } from "node:url";
import { appendSessionEvent, loadSessionEventPage, type SessionEvent } from "../../../src/storage/events.js";
import { chatSessionEvent } from "../../../src/ui/chat-state.js";
import { createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

for (const streamed of [false, true]) {
  test(`a disconnected history advances by event identity across global sequence gaps${streamed ? " after an SSE append" : ""}`, async t => {
    const root = await mkdtemp("/private/tmp/live-smith-history-dom-");
    t.after(() => rm(root, { recursive: true, force: true }));
    for (let index = 0; index < 120; index++) {
      await appendSessionEvent(root, "other-session", { kind: "assistant", content: `Other ${index}` });
    }
    for (let index = 0; index < 100; index++) {
      await appendSessionEvent(root, "session-1", { kind: "assistant", content: `Initial ${index}` });
    }
    const initial = await loadSessionEventPage(root, "session-1", { limit: 100 });
    assert.equal(initial.total, 100);
    assert.equal(initial.latestSequence, 220);
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const { events: initialEvents, ...initialHistory } = initial;
    state.events = initialEvents.map(chatSessionEvent); state.eventHistory = initialHistory;
    const h = await createDialogHarness(state);
    const originalFetch = h.window.fetch;
    const requests: Record<string, unknown>[] = [];
    Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/send-receipt") return { ok: true, json: async () => ({ status: "absent" }) };
      if (path !== "/session-events") return originalFetch(input, init);
      const body: Record<string, unknown> = JSON.parse(String(init?.body)); requests.push(body);
      const result = await loadSessionEventPage(root, "session-1", {
        limit: 100,
        ...(typeof body.historyId === "string" ? { historyId: body.historyId } : {}),
        ...(typeof body.after === "number" ? { after: body.after } : {}),
        ...(typeof body.afterEventId === "string" ? { afterEventId: body.afterEventId } : {}),
      });
      return { ok: true, json: async () => ({ ...result, events: result.events.map(chatSessionEvent), sessionId: "session-1" }) };
    } });
    try {
      let boundary = initialEvents.at(-1)!;
      if (streamed) {
        h.holdNextSend(); h.input("#prompt", "Continue"); h.click("#sendButton");
        await waitForCondition(() => h.sendIds.length === 1, "Expected active send");
        boundary = await appendSessionEvent(root, "session-1", { kind: "assistant", content: "Streamed boundary" });
        h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: chatSessionEvent(boundary) });
        await h.settle();
        assert.ok(h.document.querySelector(`[data-event-id="${boundary.id}"]`));
      }
      for (let index = 0; index < 25; index++) {
        await appendSessionEvent(root, "other-session", { kind: "assistant", content: `Interleaved ${index}` });
      }
      const appended: SessionEvent[] = [];
      for (let index = 0; index < 101; index++) {
        appended.push(await appendSessionEvent(root, "session-1", { kind: "assistant", content: `New ${index}` }));
      }
      const { events: latestEvents, ...latestHistory } = await loadSessionEventPage(root, "session-1", { limit: 100 });
      h.setServerState({ ...state, events: latestEvents.map(chatSessionEvent), eventHistory: latestHistory });
      h.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
      const newer = () => h.document.querySelector<HTMLButtonElement>('[data-history-action="newer"]');
      await waitForCondition(() => Boolean(newer() && !newer()!.hidden), "Expected forward paging for the disconnected window");
      await h.settle();
      const boundaryNode = h.document.querySelector(`[data-event-id="${boundary.id}"]`)!;
      const copy = boundaryNode.querySelector<HTMLButtonElement>('[data-message-action="copy"]')!;
      newer()!.click(); copy.focus();
      await waitForCondition(() => requests.length === 1, "Expected history request");
      assert.deepEqual(requests[0], { sessionId: "session-1", historyId: initial.historyId, afterEventId: boundary.id });
      await waitForCondition(() => Boolean(h.document.querySelector(`[data-event-id="${appended[99]!.id}"]`)), "Expected one forward page to add new messages");
      await h.settle();
      assert.ok(h.document.querySelector(`[data-event-id="${appended[0]!.id}"]`));
      assert.equal(h.document.querySelector(`[data-event-id="${boundary.id}"]`), boundaryNode);
      assert.equal(h.document.activeElement, copy);
      assert.equal(h.document.querySelectorAll("#timeline article[data-event-id]").length, streamed ? 201 : 200);
      assert.equal(h.document.querySelectorAll(`[data-event-id="${boundary.id}"]`).length, 1);
      newer()!.click();
      await waitForCondition(() => Boolean(h.document.querySelector(`[data-event-id="${appended[100]!.id}"]`)), "Expected the next numeric cursor to reach the latest message");
      assert.equal(typeof requests[1]?.after, "number");
      assert.equal(requests[1]?.afterEventId, undefined);
      assert.equal(h.document.querySelectorAll("#timeline article[data-event-id]").length, streamed ? 202 : 201);
      assert.deepEqual(h.errors, []);
    } finally {
      if (streamed) { h.releaseHeldSend(); await h.settle(); }
      h.close();
    }
  });
}
