import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

for (const [outcome, status, label, open] of [
  ["success", "complete", "Completed", false],
  ["failed", "failed", "Failed", true],
  ["unknown", "unconfirmed", "No confirmed result", true],
  ["stopped", "stopped", "Stopped", true],
  [undefined, "unconfirmed", "No confirmed result", true],
] as const) {
  test(`tool history renders ${outcome ?? "legacy unspecified"} without interpreting result text`, async () => {
    const state = stateFixture();
    state.events = [
      { id: "call", createdAt: "2026-10-08T00:00:00.000Z", kind: "tool_call", name: "external", content: "{}" },
      { id: "result", createdAt: "2026-10-08T00:00:01.000Z", kind: "tool_result", name: "external", content: "Identical provider text", ...(outcome ? { outcome } : {}) },
    ];
    const harness = await createDialogHarness(state);
    try {
      const step = harness.document.querySelector<HTMLDetailsElement>('[data-activity-step-id="call"]')!;
      assert.ok(step, "A valid tool outcome must render its history step");
      assert.equal(step.dataset.status, status);
      assert.equal(step.querySelector(":scope > summary .activity-state")?.textContent, label);
      assert.equal(step.open, open);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("streamed tool outcomes survive authoritative history refresh and malformed outcomes are rejected", async () => {
  const state = stateFixture();
  state.events = [];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Run a tool");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    const call = { id: "stream-call", createdAt: "2026-10-08T00:00:00.000Z", kind: "tool_call", name: "external", content: "{}" };
    const result = { id: "stream-result", createdAt: "2026-10-08T00:00:01.000Z", kind: "tool_result", name: "external", content: "Provider text", outcome: "unknown" };
    harness.emitServerEvent({ type: "session_event", sendId, sessionId: state.activeSessionId, event: call });
    for (const event of [{ ...result, outcome: "invented" }, { ...result, kind: "assistant" }]) {
      harness.emitServerEvent({ type: "session_event", sendId, sessionId: state.activeSessionId, event });
      assert.equal(harness.readBootstrappedClientStateReference().events.some(entry => entry.id === result.id), false);
    }
    harness.emitServerEvent({ type: "session_event", sendId, sessionId: state.activeSessionId, event: result });
    assert.equal(harness.document.querySelector('[data-activity-step-id="stream-call"]')?.getAttribute("data-status"), "unconfirmed");
    const updated = { ...state, events: [call, result] };
    harness.emitServerEvent({ type: "done", sendId, sessionId: state.activeSessionId, state: updated });
    await harness.settle();
    assert.equal(harness.readBootstrappedClientStateReference().events.at(-1)?.outcome, "unknown");
    assert.equal(harness.document.querySelector('[data-activity-step-id="stream-call"] .activity-state')?.textContent, "No confirmed result");
    assert.deepEqual(harness.errors, []);
  } finally { harness.releaseHeldSend(); await harness.settle(); harness.close(); }
});
