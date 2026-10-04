import assert from "node:assert/strict";
import test from "node:test";
import { EditScopeDeniedError } from "../../../src/agent/edit-scopes.js";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("a scope revoked after approval renders one failed Apply activity from the loop history", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [];
  let turn = 0;
  await runAgentLoop({
    maxConsecutiveFailures: 2,
    askModel: async () => ++turn === 1 ? { content: null, toolCalls: [{ id: "apply-denied", name: "apply_live_actions",
      arguments: JSON.stringify({ message: "Tempo", actions: [{ type: "set_tempo", tempo: 125 }] }) }] }
      : { content: "The changes were not applied.", toolCalls: [] },
    observe: async () => assert.fail("A scope denial needs no recovery observation"),
    preflightActions: async () => async () => { throw new EditScopeDeniedError(["structure"]); },
    confirmActions: async () => true,
    executeActions: async () => assert.fail("A rejected plan must not execute"),
    onEvent: (event) => { state.events.push({ ...event, id: `event-${state.events.length}`, createdAt: "2026-10-04T00:00:00Z" }); },
  });
  const h = await createDialogHarness(state);
  try {
    const activities = h.document.querySelectorAll<HTMLElement>(".timeline-activity-step");
    assert.equal(activities.length, 1);
    assert.equal(activities[0]!.dataset.status, "failed");
    assert.match(activities[0]!.textContent ?? "", /edit scope/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
