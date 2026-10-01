import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "./support/chat-dialog.test-harness.js";

test("confirmation messages reject malformed parameters and preserve the bound decision across replay", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Preview changes"); h.click("#sendButton"); await h.settle();
    const request = {
      type: "confirm_request", sendId: h.sendIds[0], sessionId: state.activeSessionId,
      id: "message-contract", modelTurnEpoch: 0, confirmationGeneration: 1,
      kind: "apply", message: "Original model description: Delete",
    };
    let tooDeep: unknown = "raw";
    for (let depth = 0; depth < 20; depth += 1) tooDeep = { source: "{value}", values: { value: tooDeep } };
    for (const invalid of [
      { source: "Delete" },
      { source: "Delete", values: [] },
      { source: "Delete", values: { target: null } },
      { source: "Delete", values: { target: ["Track"] } },
      { source: "Delete", values: {}, unexpected: true },
      tooDeep,
    ]) {
      h.emitServerEvent({ ...request, groups: [{ title: "raw", rows: [invalid] }] });
      await h.settle();
      assert.equal(h.document.querySelector(".confirm-card"), null);
    }
    const groups = [{
      title: { source: "Delete", values: {} },
      rows: [{ source: "Beats {start}–{end}", values: { start: 8, end: 16 } }, "Delete"],
    }];
    h.emitServerEvent({ ...request, groups }); await h.settle();
    assert.equal(h.document.querySelector(".confirm-group-title")!.textContent, "删除");
    const rows = () => [...h.document.querySelectorAll(".confirm-rows li")].map(row => row.textContent);
    assert.deepEqual(rows(), ["第 8–16 拍", "Delete"]);
    assert.equal(h.document.querySelector("#pendingConfirmationMessage")!.textContent, request.message);
    const replayRevision = String(BigInt(h.readBootstrappedClientStateReference().bridgeStateRevision) + 1n);
    h.emitRawServerEvent({ ...request,
      bridgeStateRevision: replayRevision,
      activity: { status: "waiting_confirmation", message: "Waiting for confirmation" }, groups: [{
      rows: [{ values: { end: 16, start: 8 }, source: "Beats {start}–{end}" }, "Delete"],
      title: { values: {}, source: "Delete" },
    }] }); await h.settle();
    assert.deepEqual(rows(), ["第 8–16 拍", "Delete"]);
    assert.equal(h.readBootstrappedClientStateReference().bridgeStateRevision, replayRevision);
    h.emitRawServerEvent({ ...request,
      bridgeStateRevision: String(BigInt(replayRevision) + 1n),
      activity: { status: "waiting_confirmation", message: "Waiting for confirmation" },
      groups: [{ ...groups[0], rows: [{ source: "Beats {start}–{end}", values: { start: 8, end: 32 } }] }] });
    await h.settle();
    assert.deepEqual(rows(), ["第 8–16 拍", "Delete"]);
    assert.equal(h.readBootstrappedClientStateReference().bridgeStateRevision, replayRevision);
    h.click("[data-confirm-cancel]"); await h.settle();
    const confirmation = h.calls.find(call => call.path === "/confirm");
    assert.ok(confirmation);
    assert.equal((confirmation.jsonBody as { id: string }).id, request.id);
    assert.equal((confirmation.jsonBody as { apply: boolean }).apply, false);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});
