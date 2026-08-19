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

function queuePrompt(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  prompt: string,
): void {
  harness.input("#prompt", prompt);
  submitFromComposer(harness);
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

async function pauseOriginalForRecovery(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  prompt = "Original request",
): Promise<void> {
  harness.holdNextSend();
  harness.input("#prompt", prompt);
  harness.click("#sendButton");
  await Promise.resolve();
  harness.failNextSend("The original request was not persisted.", "not_persisted");
  harness.releaseHeldSend();
  await harness.settle();
}

test("an unknown original outcome pauses its queued tail", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Queued tail");

    harness.failNextSend("Original outcome is unknown.", "unknown", {
      state: stateFixture(),
    });
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), ["Original request"]);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Queued tail/,
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /unknown.*paused/i,
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("terminal Stop uses not_persisted classification before a delayed send response", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Definitely unpersisted request");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.failNextSend("The send never persisted.", "not_persisted");
    harness.queueStopOutcomes({
      terminal: true,
      promptPersistence: "not_persisted",
    });

    harness.click("#sendButton");
    await harness.settle();
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Definitely unpersisted request",
    );
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Definitely unpersisted request/,
    );
    assert.deepEqual(sentPrompts(harness), ["Definitely unpersisted request"]);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a delayed done event cannot cross the terminal Stop classification barrier", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original stopped request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Queued tail");
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.queueStopOutcomes(
      { terminal: false },
      { terminal: true, promptPersistence: "not_persisted" },
    );

    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.stopIds.length, 1);

    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: stateFixture(),
    });
    await new Promise<void>((resolve) => harness.window.setTimeout(resolve, 300));
    await harness.settle();

    assert.equal(harness.stopIds.length, 2);
    assert.deepEqual(sentPrompts(harness), ["Original stopped request"]);
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Original stopped request", "Queued tail"],
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Original stopped request",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a delayed state refresh cannot cross the terminal Stop classification barrier", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextState();
    harness.input("#prompt", "Original awaiting state");
    harness.click("#sendButton");
    for (let index = 0; index < 20; index += 1) {
      if (harness.calls.some((call) => call.path === "/state")) break;
      await Promise.resolve();
    }
    queuePrompt(harness, "Queued after state");
    harness.queueStopOutcomes(
      { terminal: false },
      { terminal: true, promptPersistence: "not_persisted" },
    );

    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.stopIds.length, 1);
    harness.releaseHeldState();
    await new Promise<void>((resolve) => harness.window.setTimeout(resolve, 300));
    await harness.settle();

    assert.equal(harness.stopIds.length, 2);
    assert.deepEqual(sentPrompts(harness), ["Original awaiting state"]);
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Original awaiting state", "Queued after state"],
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("persisted automatic recovery never requeues the promoted head", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Promoted second");
    queuePrompt(harness, "Queued third");

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["First request", "Promoted second"]);

    harness.rejectNextSend("Connection lost after prompt persistence.");
    harness.queueStopOutcomes({
      terminal: true,
      promptPersistence: "persisted",
    });
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), ["First request", "Promoted second"]);
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Queued third"],
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("explicit Stop intent upgrades an automatic recovery already polling", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Interrupted original");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Continue after explicit Stop");
    harness.rejectNextSend("Bridge connection was interrupted.");
    harness.queueStopOutcomes(
      { terminal: false },
      { terminal: true, promptPersistence: "persisted" },
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.stopIds.length, 1);

    harness.holdNextSend();
    harness.click("#sendButton");
    await new Promise<void>((resolve) => harness.window.setTimeout(resolve, 300));
    await harness.settle();

    assert.deepEqual(sentPrompts(harness), [
      "Interrupted original",
      "Continue after explicit Stop",
    ]);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("archiving a Session clears its composer-only draft before unarchive", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Draft that must not survive archive");
    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="archive"]');
    await harness.settle();

    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="unarchive"]');
    await harness.settle();
    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("an authoritative unknown delete keeps its queued cancellation notice", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    await pauseOriginalForRecovery(harness);
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-1",
    );
    authoritative.activeSessionId = "session-2";
    authoritative.approvalMode = "low-risk";
    harness.failNextCommand(
      "Session deletion storage could not be confirmed.",
      undefined,
      { commandOutcome: "unknown", state: authoritative },
    );

    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="delete"]');
    harness.click('[data-delete-session-id="session-1"] [data-delete-confirm]');
    await harness.settle();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /deletion storage could not be confirmed/i);
    assert.match(status, /1 queued follow-up.*canceled/i);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("an authoritative unknown archive keeps its queued cancellation notice", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    await pauseOriginalForRecovery(harness);
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    const archived = authoritative.sessions.find(
      (session) => session.id === "session-1",
    );
    assert.ok(archived);
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-1",
    );
    authoritative.archivedSessions = [{
      ...archived,
      archivedAt: "2026-08-20T23:00:00.000Z",
    }];
    authoritative.activeSessionId = "session-2";
    authoritative.approvalMode = "low-risk";
    harness.failNextCommand(
      "Session archive storage could not be confirmed.",
      undefined,
      { commandOutcome: "unknown", state: authoritative },
    );

    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="archive"]');
    await harness.settle();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /archive storage could not be confirmed/i);
    assert.match(status, /1 queued follow-up.*canceled/i);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a terminal send state prunes recovery owned by a removed background Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    await pauseOriginalForRecovery(harness, "Background recovery");
    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.disabled,
      false,
    );

    harness.holdNextSend();
    harness.input("#prompt", "Foreground request");
    harness.click("#sendButton");
    await Promise.resolve();
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-2",
    );
    harness.setServerState(authoritative);
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(
      harness.document.querySelector('[data-session-id="session-2"]'),
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

test("a persisted send failure preserves background Queue cancellation status", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    await pauseOriginalForRecovery(harness, "Background recovery");
    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Foreground persisted failure");
    harness.click("#sendButton");
    await Promise.resolve();
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-2",
    );
    harness.failNextSend(
      "The provider failed after persistence.",
      "persisted",
      { state: authoritative },
    );
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(
      harness.document.querySelector('[data-session-id="session-2"]'),
      null,
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

test("a paused recovery allows Profile repair before its explicit retry", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    await pauseOriginalForRecovery(harness, "Retry after Profile repair");

    const profileSelector = harness.document.querySelector<HTMLSelectElement>(
      "#profileSelector",
    );
    assert.equal(profileSelector?.disabled, false);
    harness.input("#profileName", "Repaired Studio");
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#discardProfileButton")?.disabled,
      false,
    );
    harness.click("#discardProfileButton");
    await harness.settle();
    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    assert.equal(profileSelector?.value, "profile-2");

    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    assert.deepEqual(sentPrompts(harness), [
      "Retry after Profile repair",
      "Retry after Profile repair",
    ]);
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a not_persisted authoritative state cancels recovery for a removed Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original removed-Session request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Tail that cannot be rerouted");
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-1",
    );
    authoritative.activeSessionId = "session-2";
    authoritative.approvalMode = "low-risk";
    harness.failNextSend(
      "The original prompt was not persisted.",
      "not_persisted",
      { state: authoritative },
    );
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(
      harness.document.querySelector('[data-session-id="session-1"]'),
      null,
    );
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.disabled,
      false,
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("an unknown promoted send cannot recreate recovery for a removed Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First request");
    harness.click("#sendButton");
    await Promise.resolve();
    queuePrompt(harness, "Promoted request");
    queuePrompt(harness, "Queued tail");
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();

    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-1",
    );
    authoritative.activeSessionId = "session-2";
    authoritative.approvalMode = "low-risk";
    harness.failNextSend(
      "The promoted send outcome is unknown.",
      "unknown",
      { state: authoritative },
    );
    harness.releaseHeldSend();
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
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("background cancellation preserves foreground progress then surfaces its count", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Background request");
    harness.click("#sendButton");
    await Promise.resolve();
    const backgroundSendId = harness.sendIds[0];
    assert.ok(backgroundSendId);
    queuePrompt(harness, "Background tail");

    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Foreground request");
    harness.click("#sendButton");
    await Promise.resolve();
    const foregroundSendId = harness.sendIds[1];
    assert.ok(foregroundSendId);

    harness.emitServerEvent({
      type: "error",
      sendId: backgroundSendId,
      sessionId: "session-2",
      message: "Background Session is unavailable.",
      promptPersistence: "not_persisted",
      sendFailureKind: "session_unavailable",
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Starting Live Smith/,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /queued follow-up.*canceled/i,
    );

    harness.emitServerEvent({
      type: "done",
      sendId: foregroundSendId,
      sessionId: "session-1",
      state: stateFixture(),
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /1 queued follow-up.*canceled/i,
    );

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("attachment reconciliation retains a removed background Queue count", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    await pauseOriginalForRecovery(harness, "Background attachment recovery");
    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();

    const authoritative = imageCapableState();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-2",
    );
    harness.setServerState(authoritative);
    harness.failNextAttachmentUnknown("Upload commit could not be confirmed.");
    harness.dropAttachmentFiles([
      imageFile(harness.window, "confirmed.png", "image/png"),
    ]);
    await harness.settleAttachmentOperation();

    const status = harness.document.querySelector("#status")?.textContent ?? "";
    assert.match(status, /confirmed attached.*do not upload/i);
    assert.match(status, /1 queued follow-up.*canceled/i);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});
