import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function selectionDescription(document: Document, row: Element): string {
  const descriptionId = row.getAttribute("aria-describedby");
  assert.ok(descriptionId);
  const description = document.getElementById(descriptionId);
  assert.ok(description);
  assert.equal(description.classList.contains("visually-hidden"), true);
  return description.textContent ?? "";
}

test("keyboard bulk selection exposes each Session state without changing active state", async () => {
  const state = stateFixture();
  state.previousSessions = [{
    id: "session-previous",
    title: "Previous drum arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const row = (sessionId: string) => {
      const element = harness.document.querySelector<HTMLButtonElement>(
        `.session-entry[data-session-id="${sessionId}"] .session-row`,
      );
      assert.ok(element);
      return element;
    };
    const bass = row("session-1");
    const lead = row("session-2");
    const previous = row("session-previous");
    const descriptions = () => [bass, lead, previous].map(
      (sessionRow) => selectionDescription(harness.document, sessionRow),
    );
    const assertActiveState = () => {
      assert.deepEqual(
        [bass, lead, previous].map(
          (sessionRow) => sessionRow.getAttribute("aria-pressed"),
        ),
        ["true", "false", null],
      );
    };

    assert.deepEqual(descriptions(), [
      "Not selected for bulk actions.",
      "Not selected for bulk actions.",
      "Not selected for bulk actions.",
    ]);
    assertActiveState();

    bass.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
      metaKey: true,
    }));
    assert.deepEqual(descriptions(), [
      "Selected for bulk actions.",
      "Not selected for bulk actions.",
      "Not selected for bulk actions.",
    ]);
    assertActiveState();

    previous.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
      shiftKey: true,
    }));
    assert.deepEqual(descriptions(), [
      "Selected for bulk actions.",
      "Selected for bulk actions.",
      "Selected for bulk actions.",
    ]);
    assertActiveState();

    lead.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
      metaKey: true,
    }));
    assert.deepEqual(descriptions(), [
      "Selected for bulk actions.",
      "Not selected for bulk actions.",
      "Selected for bulk actions.",
    ]);
    assertActiveState();

    const escapeAccepted = harness.document.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    assert.equal(escapeAccepted, false);
    assert.deepEqual(descriptions(), [
      "Not selected for bulk actions.",
      "Not selected for bulk actions.",
      "Not selected for bulk actions.",
    ]);
    assert.equal(
      harness.document.querySelectorAll(".session-entry[data-selected]").length,
      0,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#sessionSelectionCount")?.hidden,
      true,
    );
    assertActiveState();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
