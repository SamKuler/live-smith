import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

test("Sessions collapse is local, accessible, and restores the intact list", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const pane = harness.document.querySelector<HTMLElement>("#sessionsPane");
    const toggle = harness.document.querySelector<HTMLButtonElement>(
      "#sessionsToggleButton",
    );
    const firstRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    assert.ok(pane);
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-controls"), "sessionsPane");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.title, "Collapse Sessions");
    const sessionIds = [...harness.document.querySelectorAll<HTMLElement>(
      ".session-entry",
    )].map((entry) => entry.dataset.sessionId);

    firstRow?.focus();
    (harness.window as unknown as {
      LiveSmithUI: { toggleSessionsPane(): void };
    }).LiveSmithUI.toggleSessionsPane();

    assert.equal(pane.hidden, true);
    assert.equal(
      harness.document.querySelector(".app")?.classList.contains(
        "sessions-collapsed",
      ),
      true,
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Show Sessions");
    assert.equal(toggle.title, "Show Sessions");
    assert.equal(harness.document.activeElement, toggle);
    assert.deepEqual(commandCalls(harness), []);

    toggle.click();
    assert.equal(pane.hidden, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(".session-entry")]
        .map((entry) => entry.dataset.sessionId),
      sessionIds,
    );
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-1",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("collapsing Sessions does not disturb current or background sends", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep this request running");
    harness.click("#sendButton");
    await Promise.resolve();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.click("#sessionsToggleButton");
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    harness.click("#sessionsToggleButton");

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    const commandCount = commandCalls(harness).length;

    harness.click("#sessionsToggleButton");
    harness.click("#sessionsToggleButton");
    assert.equal(commandCalls(harness).length, commandCount);
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-2",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
