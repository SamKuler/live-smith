import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness } from "../support/chat-dialog.test-harness.js";
import { audioState, job } from "../support/chat-dialog.audio-test-helpers.js";
import { installNativeDragBridge, nativeBridge, replyNativeDrag, type NativeDragMessage } from "../support/native-drag.test-harness.js";

function state() { const state = audioState(); state.openSettingsOnLoad = false; state.audioJobs = [job(state.activeSessionId)]; return state; }

test("native audio drag prepares the exact artifact and starts only after a held pointer moves", async () => {
  const initial = state(); const messages: NativeDragMessage[] = [];
  const h = await createDialogHarness(initial, nativeBridge, { beforeParse: window => installNativeDragBridge(window, messages) });
  try {
    const button = h.document.querySelector<HTMLButtonElement>("[data-drag-local-audio]")!; assert.ok(button);
    button.dispatchEvent(new h.window.MouseEvent("pointerenter", { bubbles: true }));
    const prepare = messages[0]!;
    assert.deepEqual({ type: prepare.type, sessionId: prepare.sessionId, artifact: prepare.artifact }, {
      type: "prepare", sessionId: initial.activeSessionId, artifact: { kind: "audio", id: "asset-one" },
    });
    replyNativeDrag(h.window, { type: "prepared", id: prepare.id, token: "opaque-file-token" }); await h.settle();
    button.dispatchEvent(new h.window.MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: 20, clientY: 20 }));
    assert.equal(messages.filter(message => message.type === "start").length, 0);
    h.document.dispatchEvent(new h.window.MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 34, clientY: 20 }));
    assert.equal(messages.filter(message => message.type === "start").length, 1);
    assert.equal(messages.at(-1)!.token, "opaque-file-token");
    assert.equal(commandCalls(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("releasing before preparation finishes never starts a native drag; failures can retry", async () => {
  const messages: NativeDragMessage[] = [];
  const h = await createDialogHarness(state(), nativeBridge, { beforeParse: window => installNativeDragBridge(window, messages) });
  try {
    const button = h.document.querySelector<HTMLButtonElement>("[data-drag-local-audio]")!;
    button.dispatchEvent(new h.window.MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: 20, clientY: 20 }));
    h.document.dispatchEvent(new h.window.MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 34, clientY: 20 }));
    h.document.dispatchEvent(new h.window.MouseEvent("pointerup", { bubbles: true, buttons: 0 }));
    replyNativeDrag(h.window, { type: "prepare_failed", id: messages[0]!.id }); await h.settle();
    button.click(); assert.equal(messages.filter(message => message.type === "prepare").length, 2);
    replyNativeDrag(h.window, { type: "prepared", id: messages.at(-1)!.id, token: "retry-file" }); await h.settle();
    assert.equal(messages.filter(message => message.type === "start").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("ordinary browser keeps download and hides native-only dragging", async () => {
  const h = await createDialogHarness(state(), { ...nativeBridge, hostMode: "browser", nativeArtifactDrag: false });
  try { assert.equal(h.document.querySelector("[data-drag-local-audio]"), null); assert.ok(h.document.querySelector("[data-download-local-audio]")); }
  finally { h.close(); }
});
