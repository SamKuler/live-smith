import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  imageCapableState,
  imageFile,
  jsonCalls,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function submitFromComposer(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): void {
  const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  assert.ok(prompt);
  prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    key: "Enter",
  }));
}

function queuePrompts(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  ...prompts: string[]
): void {
  for (const prompt of prompts) {
    harness.input("#prompt", prompt);
    submitFromComposer(harness);
  }
}

function sentPrompts(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): unknown[] {
  return jsonCalls(harness, "/send").map(({ body }) =>
    body && typeof body === "object" && "prompt" in body
      ? body.prompt
      : undefined
  );
}

test("an attachment blocker wakes the central queue pump after a background terminal", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Background first turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Wake after attachment");

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextAttachment();
    harness.dropAttachmentFiles([
      imageFile(harness.window, "blocking.png", "image/png"),
    ]);
    await Promise.resolve();

    const terminalState = imageCapableState();
    terminalState.openSettingsOnLoad = false;
    terminalState.activeSessionId = "session-2";
    terminalState.approvalMode = "low-risk";
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: terminalState,
    });
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 1);

    harness.holdNextSend();
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.deepEqual(jsonCalls(harness, "/send").at(-1), {
      path: "/send",
      body: { prompt: "Wake after attachment", sessionId: "session-1" },
    });

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a not_persisted original send preserves a newer composer draft", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Queued tail");
    harness.input("#prompt", "Newer unsent draft");

    harness.failNextSend("Original was not persisted.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Newer unsent draft",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Original request", "Queued tail"],
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /newer composer draft was preserved/i,
    );

    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), [
      "Original request",
      "Newer unsent draft",
      "Original request",
      "Queued tail",
    ]);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a recovered prompt starts with a fresh Send correlation ID", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.failNextSend("The first request was not persisted.", "not_persisted");
    harness.input("#prompt", "Retry with a fresh identity");
    harness.click("#sendButton");
    await harness.settle();

    const failedSendId = harness.sendIds[0];
    assert.ok(failedSendId);
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const retrySendId = harness.sendIds[1];
    assert.ok(retrySendId);
    assert.notEqual(retrySendId, failedSendId);

    harness.emitRawServerEvent({
      type: "error",
      sendId: failedSendId,
      sessionId: "session-1",
      message: "Delayed terminal from the failed request",
      promptPersistence: "not_persisted",
    });
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.deepEqual(sentPrompts(harness), [
      "Retry with a fresh identity",
      "Retry with a fresh identity",
    ]);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("editing a restored original keeps the failed head ahead of its tail", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Queued tail");
    harness.failNextSend("Original was not persisted.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Original request",
    );

    harness.input("#prompt", "Deliberate newer request");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const queuedBeforeNewerCompletes = [
      ...harness.document.querySelectorAll(".queued-follow-up .timeline-content"),
    ].map((item) => item.textContent);
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(queuedBeforeNewerCompletes, [
      "Original request",
      "Queued tail",
    ]);
    assert.deepEqual(sentPrompts(harness), [
      "Original request",
      "Deliberate newer request",
      "Original request",
      "Queued tail",
    ]);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a not_persisted original send pauses its queued tail across later commands", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Queued tail");

    harness.failNextSend("Original was not persisted.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Original request"]);

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Original request"]);

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Original request", "Queued tail"],
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Original request",
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("deleting a Session cancels its paused recovery and unlocks settings", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.failNextSend("Original was not persisted.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Original request/,
    );

    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="delete"]');
    harness.click('[data-delete-session-id="session-1"] [data-delete-confirm]');
    await harness.settle();

    assert.equal(
      harness.document.querySelector('[data-session-id="session-1"]'),
      null,
    );
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /1 queued follow-up.*canceled/i,
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a transient queued-head failure pauses FIFO until a deliberate manual Send", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Second turn", "Third turn");

    harness.failNextSend("Temporary send blocker.", "not_persisted");
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: stateFixture(),
    });
    await harness.settle();
    assert.deepEqual(
      sentPrompts(harness),
      ["First turn", "Second turn"],
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Second turn",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Second turn", "Third turn"],
    );

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 2);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Second turn",
    );

    harness.releaseHeldSend();
    await harness.settle();
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(
      sentPrompts(harness),
      ["First turn", "Second turn", "Second turn", "Third turn"],
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a failed queued head preserves newer composer text in a paused recovery slot", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Queued A");
    harness.input("#prompt", "Newer draft B");

    harness.failNextSend("Temporary send blocker.", "not_persisted");
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: stateFixture(),
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Newer draft B",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Queued A"],
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /newer composer draft was preserved/i,
    );

    harness.releaseHeldSend();
    await harness.settle();

    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), [
      "First turn",
      "Queued A",
      "Newer draft B",
      "Queued A",
    ]);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("session_unavailable cancels the shifted queued head and its full tail", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Invalid head", "Invalid tail");

    const unavailableState = stateFixture();
    unavailableState.openSettingsOnLoad = false;
    unavailableState.sessions = unavailableState.sessions.filter(
      (session) => session.id !== "session-1",
    );
    unavailableState.activeSessionId = "session-2";
    unavailableState.approvalMode = "low-risk";
    harness.failNextSend(
      "That Session is not available in this Live Set.",
      "not_persisted",
      {
        sendFailureKind: "session_unavailable",
        state: unavailableState,
      },
    );
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: stateFixture(),
    });
    await harness.settle();

    assert.deepEqual(
      sentPrompts(harness),
      ["First turn", "Invalid head"],
    );
    assert.equal(
      harness.document.querySelector('[data-session-id="session-1"]'),
      null,
    );
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /2 queued follow-ups.*canceled/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 2);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("session_unavailable cancels the full FIFO even when state is unavailable", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Unavailable head", "Unavailable tail");

    harness.failNextSend(
      "That Session is not available in this Live Set.",
      "not_persisted",
      { sendFailureKind: "session_unavailable" },
    );
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: stateFixture(),
    });
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), ["First turn", "Unavailable head"]);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /2 queued follow-ups.*canceled.*state is unavailable/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("unknown steering keeps its confirmation locked across Session and timeline renders", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a Live change");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "locked-confirmation",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Delete track"] }],
    });

    harness.failNextSteer("Steering outcome is unknown.", "unknown");
    harness.input("#prompt", "Do not delete the track");
    submitFromComposer(harness);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        ".confirm-buttons .primary",
      )?.disabled,
      true,
    );

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "rerender-event",
        kind: "tool_call",
        name: "inspect_track",
        content: "Inspect the selected track",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        ".confirm-buttons .primary",
      )?.disabled,
      true,
    );

    harness.click(".confirm-buttons .primary");
    await harness.settle();
    assert.equal(jsonCalls(harness, "/confirm").length, 0);

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("Steer waits for an in-flight Apply decision instead of racing it", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a confirmed change");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.emitServerEvent({
      type: "confirm_request",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      id: "confirm-in-flight",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.holdNextConfirmation();
    harness.click(".confirm-buttons .primary");
    await Promise.resolve();
    harness.input("#prompt", "Redirect while Apply is pending");
    submitFromComposer(harness);
    await Promise.resolve();

    assert.equal(jsonCalls(harness, "/confirm").length, 1);
    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Apply decision.*before steering/i,
    );

    harness.releaseHeldConfirmation();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("Stop on a promoted turn cancels it and continues the remaining FIFO", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Second turn", "Third turn");

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["First turn", "Second turn"]);

    harness.holdNextSend();
    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), [
      "First turn",
      "Second turn",
      "Third turn",
    ]);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("an interrupted original turn pauses its FIFO instead of advancing unknown work", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Possibly persisted first turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Do not advance across an unknown outcome");
    harness.rejectNextSend("Connection lost");
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), ["Possibly persisted first turn"]);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Do not advance across an unknown outcome/,
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Queued follow-ups remain paused/i,
    );

    harness.holdNextSend();
    harness.input("#prompt", "Continue after reviewing the timeline");
    harness.click("#sendButton");
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), [
      "Possibly persisted first turn",
      "Continue after reviewing the timeline",
      "Do not advance across an unknown outcome",
    ]);

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("SSE promotion preserves the newly started queued attempt status", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompts(harness, "Second turn");
    harness.holdNextSend();

    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: stateFixture(),
    });
    await Promise.resolve();

    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Starting Live Smith…",
    );

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("active Queue exposes an accessible shortcut hint and Close counts discarded items", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();

    const hint = harness.document.querySelector<HTMLElement>("#followUpShortcutHint");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    assert.equal(hint?.tagName, "SPAN");
    assert.equal(hint?.hidden, false);
    assert.match(hint?.textContent ?? "", /Cmd\/Ctrl\+Enter.*Queue/i);
    assert.match(prompt?.getAttribute("aria-keyshortcuts") ?? "", /Meta\+Enter/);
    assert.match(prompt?.getAttribute("aria-describedby") ?? "", /followUpShortcutHint/);
    assert.equal(harness.document.querySelector("#queueButton"), null);
    assert.equal(harness.document.querySelector("#steerButton"), null);

    queuePrompts(harness, "Second turn", "Third turn");
    harness.click("#closeButton");
    assert.match(
      harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "",
      /2 queued follow-ups will be discarded/i,
    );
    await harness.cancelAppConfirmation();

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});
