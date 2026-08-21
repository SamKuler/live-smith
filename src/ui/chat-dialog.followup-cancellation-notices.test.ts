import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

async function pauseRecovery(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  prompt: string,
): Promise<void> {
  harness.holdNextSend();
  harness.input("#prompt", prompt);
  harness.click("#sendButton");
  await Promise.resolve();
  harness.failNextSend("The request was not persisted.", "not_persisted");
  harness.releaseHeldSend();
  await harness.settle();
}

test("separate background Queue cancellations aggregate while foreground progress stays visible", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const second = state.sessions.find((session) => session.id === "session-2");
  assert.ok(second);
  state.sessions.push({
    ...second,
    id: "session-3",
    title: "Pad session",
    scope: { kind: "track", identity: "track-pad", label: "Pad" },
  });
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    await pauseRecovery(harness, "Second Session recovery");

    harness.click('[data-session-id="session-3"] .session-row');
    await harness.settle();
    await pauseRecovery(harness, "Third Session recovery");

    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Foreground request");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.click('[data-session-menu-button="session-2"]');
    harness.click('[data-session-id="session-2"] [data-session-action="archive"]');
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Starting Live Smith.*1 queued follow-up.*canceled/i,
    );

    harness.click('[data-session-menu-button="session-3"]');
    harness.click('[data-session-id="session-3"] [data-session-action="archive"]');
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Starting Live Smith.*2 queued follow-ups.*canceled/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});
