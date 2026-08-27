import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
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

test("unused track Sessions stay hidden in current and History lists and bulk selection", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const base = state.sessions[0]!;
  state.sessions = ["Bass", "Lead", "Drums"].map((label, index) => ({
    ...base,
    id: `session-${index + 1}`,
    title: "",
    scope: { kind: "track", identity: `track-${index + 1}`, label },
    hasContent: false,
  }));
  state.activeSessionId = "session-3";
  state.previousSessions = [{
    ...state.sessions[0]!,
    id: "session-previous-empty",
    projectKey: "previous-project",
  }, {
    ...base,
    id: "session-previous-content",
    projectKey: "previous-project",
    hasContent: true,
  }];
  state.archivedSessions = [{
    ...state.sessions[0]!,
    id: "session-archived-empty",
    archivedAt: "2026-08-02T00:00:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(".session-entry")]
        .map((entry) => entry.dataset.sessionId),
      ["session-3", "session-previous-content", "session-archived-empty"],
    );
    const lastRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-archived-empty"] .session-row',
    );
    assert.ok(lastRow);
    lastRow.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      shiftKey: true,
    }));
    assert.equal(
      harness.document.querySelector("#sessionSelectionCount")?.textContent,
      "3 selected",
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an empty Session stays reachable after switching for the current dialog only", async () => {
  const dialogState = (activeSessionId: string) => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    const base = state.sessions[0]!;
    state.sessions = [{
      ...base,
      id: "session-empty-visited",
      title: "",
      hasContent: false,
    }, {
      ...base,
      id: "session-with-content",
      scope: { kind: "track", identity: "content-track", label: "Content" },
      hasContent: true,
    }, {
      ...base,
      id: "session-empty-unvisited",
      title: "",
      scope: { kind: "track", identity: "unvisited-track", label: "Unvisited" },
      hasContent: false,
    }];
    state.activeSessionId = activeSessionId;
    return state;
  };
  const state = dialogState("session-empty-visited");
  const emptyRow =
    '.session-entry[data-session-id="session-empty-visited"] .session-row';
  const contentRow =
    '.session-entry[data-session-id="session-with-content"] .session-row';
  const unvisitedRow =
    '.session-entry[data-session-id="session-empty-unvisited"] .session-row';

  const harness = await createDialogHarness(state);
  try {
    assert.ok(harness.document.querySelector(emptyRow));
    assert.ok(harness.document.querySelector(contentRow));
    assert.equal(harness.document.querySelector(unvisitedRow), null);

    harness.click(contentRow);
    await harness.settle();
    assert.ok(harness.document.querySelector(emptyRow));
    harness.click(emptyRow);
    await harness.settle();
    assert.equal(
      harness.document.querySelector(emptyRow)?.getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }

  const reopened = dialogState("session-with-content");
  const reopenedHarness = await createDialogHarness(reopened);
  try {
    assert.deepEqual(reopenedHarness.errors, []);
    assert.equal(reopenedHarness.document.querySelector(emptyRow), null);
    assert.ok(reopenedHarness.document.querySelector(contentRow));
    assert.equal(reopenedHarness.document.querySelector(unvisitedRow), null);
  } finally {
    reopenedHarness.close();
  }
});

test("Session switching does not flash a global status message", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  let released = false;
  try {
    harness.holdNextCommandResponse();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    assert.deepEqual(commandCalls(harness)[0]?.body, {
      kind: "select_session",
      sessionId: "session-2",
    });
    assert.equal(harness.document.querySelector("#status")?.textContent, "");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#status")?.hidden,
      true,
    );
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a History containing only unused Sessions has no empty section", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.sessions = state.sessions.map((session) => ({
    ...session, title: "", hasContent: false,
  }));
  state.previousSessions = [{
    ...state.sessions[1]!,
    id: "session-previous-empty",
    projectKey: "previous-project",
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(".session-entry")]
        .map((entry) => entry.dataset.sessionId),
      ["session-1"],
    );
    assert.equal(harness.document.querySelector('[data-session-section="history"]'), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unsent Session draft survives switching and refreshed state", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  Object.assign(state.sessions[0]!, { title: "", hasContent: false });
  const harness = await createDialogHarness(state);
  const bassRow = '.session-entry[data-session-id="session-1"] .session-row';
  const leadRow = '.session-entry[data-session-id="session-2"] .session-row';
  try {
    harness.input("#prompt", "Unsent bass instructions");
    harness.click(leadRow);
    await harness.settle();
    assert.ok(harness.document.querySelector(bassRow));

    harness.select("#approvalMode", "everything");
    await harness.settle();
    harness.click(bassRow);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Unsent bass instructions",
    );

    harness.input("#prompt", "   ");
    harness.click(leadRow);
    await harness.settle();
    assert.ok(harness.document.querySelector(bassRow));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a content-free Session with a send or recoverable queue stays reachable", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  Object.assign(state.sessions[0]!, { title: "", hasContent: false });
  const harness = await createDialogHarness(state);
  const bassRow = '.session-entry[data-session-id="session-1"] .session-row';
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Queued request");
    harness.document.querySelector("#prompt")!.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter",
      }),
    );
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.ok(harness.document.querySelector(bassRow));

    harness.failNextSend("Original was not persisted.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    harness.click(bassRow);
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((entry) => entry.textContent),
      ["Original request", "Queued request"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an in-flight user message renders only in its owning Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Only show this in the Bass Session");
    harness.click("#sendButton");

    assert.equal(
      harness.document.querySelector(".timeline-item.user.local-user-message .timeline-content")
        ?.textContent,
      "Only show this in the Bass Session",
    );

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(".timeline-item.user.local-user-message"),
      null,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#timeline")?.textContent ?? "",
      /Only show this in the Bass Session/,
    );

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(".timeline-item.user.local-user-message .timeline-content")
        ?.textContent,
      "Only show this in the Bass Session",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});
