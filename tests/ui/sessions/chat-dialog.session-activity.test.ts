import assert from "node:assert/strict";
import test from "node:test";
import { cloneState, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("Session timestamps display saved chat activity while retaining the metadata clock", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  state.sessions[0]!.updatedAt = "2026-07-01T00:00:00.000Z";
  state.sessions[0]!.lastMessageAt = "2026-10-09T00:00:00.000Z";
  state.sessions[1]!.updatedAt = "2026-11-09T00:00:00.000Z";
  state.sessions[1]!.lastMessageAt = "2026-10-09T00:00:00.000Z";
  const h = await createDialogHarness(state);
  try {
    assert.match(h.document.querySelector<HTMLElement>('[data-session-id="session-1"] .session-meta')!.title, /Oct/);
    assert.match(h.document.querySelector<HTMLElement>('[data-session-id="session-2"] .session-meta')!.title, /Nov/);
    assert.equal(h.readBootstrappedClientStateReference().sessions[0]!.updatedAt, "2026-07-01T00:00:00.000Z");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const background of [false, true]) {
  test(`saved chat events refresh ${background ? "background" : "active"} Session timestamps without regressing on older events`, async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.settings.uiLanguage = "en";
    const h = await createDialogHarness(state);
    h.holdNextSend();
    try {
      h.input("#prompt", "Continue the arrangement");
      h.click("#sendButton");
      await h.settle();
      const sendId = h.sendIds[0];
      assert.ok(sendId);
      if (background) {
        h.click('[data-session-id="session-2"] .session-row');
        await h.settle();
      }
      const emit = (id: string, createdAt: string, kind: "assistant" | "user" | "reasoning") =>
        h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
          event: { id, createdAt, kind, content: "Persisted content" } });
      emit("latest-chat", "2026-10-09T00:00:00.000Z", "assistant");
      await h.settle();
      const metadata = () => h.document.querySelector<HTMLElement>('[data-session-id="session-1"] .session-meta')!;
      assert.match(metadata().title, /Oct/);
      emit("late-older-chat", "2026-09-09T00:00:00.000Z", "user");
      emit("reasoning-only", "2026-11-09T00:00:00.000Z", "reasoning");
      await h.settle();
      assert.match(metadata().title, /Oct/);
      assert.deepEqual(h.errors, []);
    } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
  });
}

for (const terminal of ["done", "http", "invalidation", "reconnect"] as const) {
  for (const newerEventReceived of [false, true]) {
    test(`${terminal} state reconciles saved chat activity ${newerEventReceived ? "without replacing a newer event" : "after a missed assistant event"}`, async () => {
      const state = stateFixture();
      state.openSettingsOnLoad = false;
      state.settings.uiLanguage = "en";
      state.events = [];
      state.sessions[0]!.updatedAt = "2026-01-01T00:00:00.000Z";
      const h = await createDialogHarness(state);
      h.holdNextSend();
      let released = false;
      let stateHeld = false;
      try {
        h.input("#prompt", "Continue the arrangement");
        h.click("#sendButton");
        await h.settle();
        const sendId = h.sendIds[0]!;
        if (terminal === "invalidation" || terminal === "reconnect") {
          h.holdNextState();
          stateHeld = true;
          if (terminal === "invalidation") h.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
          else { h.emitServerEventError(); h.emitServerEventOpen(); }
          await h.settle();
        }
        const user = { id: "new-user", kind: "user" as const, content: "Continue the arrangement", createdAt: "2026-10-08T00:00:00.000Z" };
        const assistant = { id: "new-assistant", kind: "assistant" as const, content: "A new variation", createdAt: "2026-10-09T00:00:00.000Z" };
        h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0, event: user });
        if (newerEventReceived) h.emitServerEvent({ type: "session_event", sendId, sessionId: "session-1", modelTurnEpoch: 0,
          event: { id: "later-assistant", kind: "assistant", content: "Another saved variation", createdAt: "2026-10-11T00:00:00.000Z" } });
        await h.settle();
        const completed = cloneState(state);
        completed.events = [user, assistant];
        completed.sessions[0]!.lastMessageAt = assistant.createdAt;
        h.setServerState(completed);
        if (terminal === "done") h.emitServerEvent({ type: "done", sendId, sessionId: "session-1", state: completed });
        else if (terminal === "http") { h.releaseHeldSend(); released = true; }
        else { h.releaseHeldState(); stateHeld = false; }
        await h.settle();
        assert.match(h.document.querySelector("#timeline")!.textContent!, /A new variation/);
        assert.match(h.document.querySelector<HTMLElement>('[data-session-id="session-1"] .session-meta')!.title,
          newerEventReceived ? /Oct 11/ : /Oct 9/);
        assert.deepEqual(h.errors, []);
      } finally { if (stateHeld) h.releaseHeldState(); if (!released) h.releaseHeldSend(); await h.settle(); h.close(); }
    });
  }
}
