import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function withFollowUpBehavior(behavior: "queue" | "steer") {
  const state = stateFixture();
  Object.assign(state.settings, { defaultFollowUpBehavior: behavior });
  return state;
}

function submitFromComposer(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  options: { composing?: boolean } = {},
): void {
  const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  assert.ok(prompt);
  prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    isComposing: options.composing === true,
    key: "Enter",
  }));
}

test("active Queue mode exposes only Stop and promotes an Up next item into a fresh Send", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const behavior = harness.document.querySelector<HTMLSelectElement>(
      "#defaultFollowUpBehavior",
    );
    assert.equal(behavior?.value, "queue");
    assert.deepEqual(
      [...(behavior?.options ?? [])].map((option) => [option.value, option.textContent]),
      [["queue", "Queue"], ["steer", "Steer"]],
    );
    assert.equal(harness.document.querySelector("#steerButton"), null);
    assert.equal(harness.document.querySelector("#queueButton"), null);

    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    const stop = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(stop?.textContent, "Stop");
    assert.equal(stop?.getAttribute("aria-label"), "Stop current response");
    assert.equal(stop?.getAttribute("aria-keyshortcuts"), null);

    harness.input("#prompt", "Make the next pass shorter");
    submitFromComposer(harness);
    await harness.settle();

    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Up next.*Make the next pass shorter/s,
    );
    assert.equal(jsonCalls(harness, "/steer").length, 0);

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/send"), [
      {
        path: "/send",
        body: { prompt: "Build the first version", sessionId: "session-1" },
      },
      {
        path: "/send",
        body: { prompt: "Make the next pass shorter", sessionId: "session-1" },
      },
    ]);
    assert.equal(stop?.textContent, "Stop");
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(stop?.textContent, "Send");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("changing the global behavior routes the next follow-up immediately while save is pending", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the arrangement");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.holdNextCommandResponse();
    harness.select("#defaultFollowUpBehavior", "steer");
    await Promise.resolve();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );

    harness.input("#prompt", "Keep the active pass concise");
    submitFromComposer(harness);
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/steer"), [{
      path: "/steer",
      body: { prompt: "Keep the active pass concise", sessionId: "session-1" },
    }]);
    assert.equal(jsonCalls(harness, "/send").length, 1);

    harness.releaseHeldCommandResponse();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older terminal Send state cannot roll back the latest follow-up behavior", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start before the setting changes");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];

    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#defaultFollowUpBehavior")?.value,
      "steer",
    );

    const staleTerminalState = withFollowUpBehavior("queue");
    staleTerminalState.openSettingsOnLoad = false;
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: staleTerminalState,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#defaultFollowUpBehavior")?.value,
      "steer",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("follow-up shortcut is prompt-scoped and ignores IME composition", async () => {
  const state = withFollowUpBehavior("steer");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a response");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.input("#prompt", "Redirect this response");
    const unrelated = harness.document.querySelector<HTMLButtonElement>("#newSessionButton");
    unrelated?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "Enter",
    }));
    submitFromComposer(harness, { composing: true });
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 0);

    submitFromComposer(harness);
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 1);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Queue leaves an open Apply confirmation active", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
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
      id: "confirm-before-queue",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.input("#prompt", "After this, revise the bass part");
    submitFromComposer(harness);
    await harness.settle();

    const card = harness.document.querySelector(".confirm-card");
    assert.ok(card);
    assert.equal(card.getAttribute("aria-busy"), null);
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(".confirm-buttons .primary")?.disabled,
      false,
    );
    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /revise the bass part/,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Queue is FIFO and each promoted item receives a distinct ordinary Send", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First turn");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.input("#prompt", "Second turn");
    submitFromComposer(harness);
    harness.input("#prompt", "Third turn");
    submitFromComposer(harness);
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["Second turn", "Third turn"],
    );

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/send").at(-1), {
      path: "/send",
      body: { prompt: "Second turn", sessionId: "session-1" },
    });

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/send").at(-1), {
      path: "/send",
      body: { prompt: "Third turn", sessionId: "session-1" },
    });
    assert.equal(new Set(harness.sendIds).size, 3);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a queued follow-up stays bound to its Session while another Session is visible", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Work on Bass");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Continue on Bass next");
    submitFromComposer(harness);

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/send").at(-1), {
      path: "/send",
      body: { prompt: "Continue on Bass next", sessionId: "session-1" },
    });
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed global behavior save rolls future follow-ups back to the confirmed mode", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the current turn");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextCommand("Could not save follow-up behavior.");
    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#defaultFollowUpBehavior")?.value,
      "queue",
    );

    harness.input("#prompt", "This should wait for the next turn");
    submitFromComposer(harness);
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /This should wait/,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Steer immediately locks an obsolete Apply decision until guidance is accepted", async () => {
  const state = withFollowUpBehavior("steer");
  state.openSettingsOnLoad = false;
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
      id: "obsolete-confirmation",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.holdNextSteer();
    harness.input("#prompt", "Use the selected track instead");
    submitFromComposer(harness);
    await Promise.resolve();
    const card = harness.document.querySelector(".confirm-card");
    assert.equal(card?.getAttribute("aria-busy"), "true");
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(".confirm-buttons .primary")?.disabled,
      true,
    );

    harness.releaseHeldSteer();
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a global behavior event from another dialog routes the next follow-up immediately", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the response");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.emitServerEvent({
      type: "default_follow_up_behavior_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      commandId: "external-follow-up-setting-1",
    });
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#defaultFollowUpBehavior")?.value,
      "steer",
    );

    harness.input("#prompt", "Apply this guidance now");
    submitFromComposer(harness);
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 1);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Stop terminates only the running turn and then starts the queued follow-up", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Long-running first turn");
    harness.click("#sendButton");
    await Promise.resolve();
    const firstSendId = harness.sendIds[0];

    harness.input("#prompt", "Run this after Stop");
    submitFromComposer(harness);
    harness.holdNextSend();
    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(harness.stopIds, [firstSendId]);
    assert.deepEqual(jsonCalls(harness, "/send").at(-1), {
      path: "/send",
      body: { prompt: "Run this after Stop", sessionId: "session-1" },
    });
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Close confirmation suspends Queue promotion and cancel resumes it", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Running while Close opens");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Must wait behind Close");
    submitFromComposer(harness);
    await harness.settle();

    harness.click("#closeButton");
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 1);

    await harness.cancelAppConfirmation();
    await harness.settle();
    assert.deepEqual(
      jsonCalls(harness, "/send").map((call) =>
        (call.body as { prompt?: string }).prompt
      ),
      ["Running while Close opens", "Must wait behind Close"],
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("accepting Close never promotes the Queue behind its confirmation", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Running before Close");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Discard on Close");
    submitFromComposer(harness);
    await harness.settle();

    harness.click("#closeButton");
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 1);
    await harness.acceptAppConfirmation();
    await harness.settle();

    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.hostMessages)), [{
      method: "close_and_send",
      params: [JSON.stringify({ kind: "close" })],
    }]);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("Stop stays available while an allowed Session command is pending", async () => {
  const state = withFollowUpBehavior("queue");
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep Stop reachable");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextCommand();
    harness.select("#approvalMode", "everything");
    await Promise.resolve();
    const stop = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(stop?.textContent, "Stop");
    assert.equal(stop?.disabled, false);
    harness.queueStopOutcomes(
      { terminal: false },
      { terminal: true, promptPersistence: "persisted" },
    );
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(harness.stopIds, [sendId]);

    harness.releaseHeldCommand();
    harness.releaseHeldSend();
    await new Promise<void>((resolve) => harness.window.setTimeout(resolve, 300));
    await harness.settle();
    assert.deepEqual(harness.stopIds, [sendId, sendId]);
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});
