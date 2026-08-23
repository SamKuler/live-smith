import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  jsonCalls,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function header(call: { headers?: HeadersInit }, name: string): string {
  return new Headers(call.headers).get(name) ?? "";
}

function steeringState() {
  const state = stateFixture();
  state.settings.defaultFollowUpBehavior = "steer";
  return state;
}

function createSteeringDialogHarness(state = steeringState()) {
  state.settings.defaultFollowUpBehavior = "steer";
  return createDialogHarness(state);
}

function submitSteering(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): void {
  harness.document.querySelector("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
    }),
  );
}

test("active sends keep Stop available and post bounded steering input separately", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    const sendId = harness.sendIds[0];
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    assert.ok(sendId);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(prompt?.disabled, false);
    assert.equal(harness.document.querySelector("#steerButton"), null);

    harness.input("#prompt", "Keep it shorter");
    submitSteering(harness);
    await harness.settle();

    const steerCall = harness.calls.find((call) => call.path === "/steer");
    assert.deepEqual(jsonCalls(harness, "/steer"), [{
      path: "/steer",
      body: { prompt: "Keep it shorter", sessionId: "session-1" },
    }]);
    assert.equal(header(steerCall!, "X-Live-Smith-Send-Id"), sendId);
    assert.notEqual(header(steerCall!, "X-Live-Smith-Steer-Id"), "");
    assert.equal(prompt?.value, "");

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("pending steering is not duplicated and clears only the submitted draft", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the arrangement");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.holdNextSteer();
    harness.input("#prompt", "Move the chorus earlier");
    submitSteering(harness);
    submitSteering(harness);
    await Promise.resolve();

    assert.equal(jsonCalls(harness, "/steer").length, 1);
    harness.input("#prompt", "Move the chorus earlier, but keep the fill");
    harness.releaseHeldSteer();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Move the chorus earlier, but keep the fill",
    );

    harness.document.querySelector("#prompt")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }),
    );
    await harness.settle();

    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.notEqual(
      header(steerCalls[0]!, "X-Live-Smith-Steer-Id"),
      header(steerCalls[1]!, "X-Live-Smith-Steer-Id"),
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("failed steering keeps the draft retryable without stopping the send", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextSteer("The steering queue is full.");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Leave more headroom",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /steering queue is full/i,
    );
    assert.deepEqual(harness.stopIds, []);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("response-lost steering retries the same idempotency ID", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.rejectNextSteerResponseAfterCommit("connection reset after commit");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Leave more headroom",
    );
    submitSteering(harness);
    await harness.settle();

    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.equal(
      header(steerCalls[0]!, "X-Live-Smith-Steer-Id"),
      header(steerCalls[1]!, "X-Live-Smith-Steer-Id"),
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a durable incremental steering acknowledgement resolves response loss", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirmation-before-durable-ack",
      message: "Apply the original plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    assert.match(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"]',
      )?.textContent ?? "",
      /Needs approval/,
    );

    harness.rejectNextSteerResponseAfterCommit("connection reset after commit");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const firstCall = harness.calls.find((call) => call.path === "/steer");
    const firstSteerId = header(firstCall!, "X-Live-Smith-Steer-Id");
    harness.emitRawServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "mismatched-steering-ack",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "user",
        content: "Different guidance",
        steeringAck: { sendId, steerId: firstSteerId },
      },
      activity: { status: "running", message: "Guidance applied" },
      bridgeStateRevision: "2",
    });
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Leave more headroom",
    );
    assert.equal(
      harness.document.querySelector('[data-event-id="mismatched-steering-ack"]'),
      null,
    );
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "durable-steering-ack",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "user",
        content: "Leave more headroom",
        steeringAck: { sendId, steerId: firstSteerId },
      },
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Guidance applied",
    );
    const targetSession = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"]',
    );
    assert.match(targetSession?.textContent ?? "", /Working/);
    assert.doesNotMatch(targetSession?.textContent ?? "", /Needs approval/);
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.notEqual(
      header(steerCalls[1]!, "X-Live-Smith-Steer-Id"),
      firstSteerId,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Stop locks confirmation and ignores late activity until the send is terminal", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a change, then stop");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirmation-locked-by-stop",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.queueStopOutcomes({ terminal: false });
    harness.click("#sendButton");
    await harness.settle();
    const apply = harness.document.querySelector<HTMLButtonElement>(
      ".confirm-card button.primary",
    );
    assert.ok(apply);
    assert.equal(apply.disabled, true);
    apply.click();
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      0,
    );

    harness.emitServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Late progress after Stop",
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Stop requested|Stopping/i,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Late progress after Stop/,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed steering A event cannot overwrite steering B progress", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextSteer();
    harness.input("#prompt", "Guidance A");
    submitSteering(harness);
    await harness.settle();
    const firstCall = harness.calls.find((call) => call.path === "/steer");
    const firstSteerId = header(firstCall!, "X-Live-Smith-Steer-Id");
    const delayedFirstEvent = harness.deferServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "delayed-guidance-a",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "user",
        content: "Guidance A",
        steeringAck: { sendId, steerId: firstSteerId },
      },
    });
    harness.deferServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "hidden-confirmation-after-a",
      message: "Apply the revised plan?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });
    harness.emitRawServerEvent({
      type: "steer_accepted",
      sendId,
      sessionId: "session-1",
      steerId: firstSteerId,
      bridgeStateRevision: "4",
    });
    await harness.settle();
    harness.releaseHeldSteer();
    await harness.settle();

    harness.holdNextSteer();
    harness.input("#prompt", "Guidance B");
    submitSteering(harness);
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Applying guidance/,
    );
    harness.emitRawServerEvent(delayedFirstEvent);
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Applying guidance/,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /^Guidance applied$/,
    );

    harness.releaseHeldSteer();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a same-ID steering retry publishes after a newer deferred confirmation", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.rejectNextSteerResponseAfterCommit("connection reset after commit");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const delayedConfirmation = harness.deferServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirmation-after-lost-steer-response",
      message: "Apply the revised plan?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });

    submitSteering(harness);
    await harness.settle();
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Guidance applied/,
    );
    harness.emitRawServerEvent(delayedConfirmation);
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the revised plan/,
    );

    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.equal(
      header(steerCalls[0]!, "X-Live-Smith-Steer-Id"),
      header(steerCalls[1]!, "X-Live-Smith-Steer-Id"),
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("explicitly unknown steering persistence retries the same idempotency ID", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextSteer(
      "The steering persistence outcome could not be confirmed.",
      "unknown",
    );
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    submitSteering(harness);
    await harness.settle();

    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.equal(
      header(steerCalls[0]!, "X-Live-Smith-Steer-Id"),
      header(steerCalls[1]!, "X-Live-Smith-Steer-Id"),
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown steering blocks edited guidance until the original receipt resolves", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextSteer(
      "The steering persistence outcome could not be confirmed.",
      "unknown",
    );
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const firstCall = harness.calls.find((call) => call.path === "/steer");
    const firstSteerId = header(firstCall!, "X-Live-Smith-Steer-Id");

    harness.input("#prompt", "Leave slightly more headroom");
    submitSteering(harness);
    await harness.settle();

    assert.equal(jsonCalls(harness, "/steer").length, 1);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /unchanged guidance/i,
    );

    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const steerCalls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(steerCalls.length, 2);
    assert.equal(header(steerCalls[1]!, "X-Live-Smith-Steer-Id"), firstSteerId);

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("Queue mode cannot abandon an unresolved unknown steering receipt", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the arrangement");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextSteer("Steering outcome unknown.", "unknown");
    harness.input("#prompt", "Move the chorus earlier");
    submitSteering(harness);
    await harness.settle();

    harness.select("#defaultFollowUpBehavior", "queue");
    await harness.settle();
    harness.input("#prompt", "Queue something else");
    submitSteering(harness);
    await harness.settle();

    assert.equal(jsonCalls(harness, "/steer").length, 1);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /resolve.*guidance|guidance.*resolve/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("terminal Session state acknowledges steering when HTTP and SSE receipts were lost", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.rejectNextSteerResponseAfterCommit("connection reset after commit");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const steerCall = harness.calls.find((call) => call.path === "/steer");
    const steerId = header(steerCall!, "X-Live-Smith-Steer-Id");
    const terminalState = stateFixture();
    terminalState.openSettingsOnLoad = false;
    terminalState.events = [{
      id: "event-steering-receipt",
      createdAt: "2026-08-15T00:00:00.000Z",
      kind: "user",
      content: "Leave more headroom",
      steeringAck: {
        sendId,
        steerId,
      },
    }];

    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminalState,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(jsonCalls(harness, "/send").length, 1);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background terminal reconciles steering against its authoritative target", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.rejectNextSteerResponseAfterCommit("connection reset after commit");
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const steerCall = harness.calls.find((call) => call.path === "/steer");
    const steerId = header(steerCall!, "X-Live-Smith-Steer-Id");

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    const terminalState = stateFixture();
    terminalState.openSettingsOnLoad = false;
    terminalState.events = [{
      id: "background-steering-receipt",
      createdAt: "2026-08-15T00:00:00.000Z",
      kind: "user",
      content: "Keep the bass sparse",
      steeringAck: {
        sendId,
        steerId,
      },
    }];
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminalState,
    });
    await harness.settle();

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be reconciled/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background terminal without a receipt keeps steering retryable", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.rejectNextSteerResponseAfterCommit("connection reset before commit");
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();

    const terminalState = stateFixture();
    terminalState.openSettingsOnLoad = false;
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminalState,
    });
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Keep the bass sparse",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("terminal Session state without a steering receipt keeps the draft safely retryable", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.rejectNextSteerResponseAfterCommit("connection reset before commit");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();
    const terminalState = stateFixture();
    terminalState.openSettingsOnLoad = false;

    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminalState,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Leave more headroom",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");

    harness.releaseHeldSend();
    await harness.settle();
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 2);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a newer state clears a stale unavailable marker before Send settles", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.failNextSteer("Steering outcome unknown.", "unknown");
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await harness.settle();

    const missing = stateFixture();
    missing.openSettingsOnLoad = false;
    missing.sessions = missing.sessions.filter(
      (session) => session.id !== "session-1",
    );
    missing.activeSessionId = "session-2";
    missing.approvalMode = "low-risk";
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: missing,
    });
    await harness.settle();

    const restored = stateFixture();
    restored.openSettingsOnLoad = false;
    harness.setServerState(restored);
    harness.releaseHeldSend();
    await harness.settle();

    assert.ok(
      harness.document.querySelector(
        '.current-session-entry[data-session-id="session-1"]',
      ),
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /target Session is no longer available/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a covered steering receipt still applies its correlation feedback", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextSteer();
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const steerCall = harness.calls.find((call) => call.path === "/steer");
    const steerId = header(steerCall!, "X-Live-Smith-Steer-Id");
    assert.ok(steerId);

    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(
          kind: string,
          extra?: Record<string, unknown>,
        ): Promise<boolean>;
      };
    }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed during steering",
    });
    await harness.settle();
    const commandId = harness.commandIds[0];
    assert.ok(commandId);

    const covered = stateFixture();
    covered.openSettingsOnLoad = false;
    covered.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed during steering";
    covered.sessionActivities = [{
      sessionId: "session-1",
      status: "running",
      message: "Guidance applied",
      unread: false,
    }];
    harness.queueNextStatePublication("3", "2");
    harness.emitServerEvent({ type: "state", commandId, state: covered });
    assert.equal(await command, true);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Keep the bass sparse",
    );

    harness.emitServerEvent({
      type: "steer_accepted",
      sendId,
      sessionId: "session-1",
      steerId,
      bridgeStateRevision: "2",
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector("#status")?.textContent || "",
      /Guidance applied/,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    harness.releaseHeldCommandResponse();
    harness.releaseHeldSteer();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a later full state preserves the steering activity it claims to cover", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextSteer();
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const steerCall = harness.calls.find((call) => call.path === "/steer");
    const steerId = header(steerCall!, "X-Live-Smith-Steer-Id");
    harness.emitServerEvent({
      type: "steer_accepted",
      sendId,
      sessionId: "session-1",
      steerId,
      bridgeStateRevision: "2",
      activity: { status: "running", message: "Guidance applied" },
    });

    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(
          kind: string,
          extra?: Record<string, unknown>,
        ): Promise<boolean>;
      };
    }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed after steering",
    });
    await harness.settle();
    const commandId = harness.commandIds[0];
    assert.ok(commandId);
    const covered = stateFixture();
    covered.openSettingsOnLoad = false;
    covered.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed after steering";
    covered.sessionActivities = [{
      sessionId: "session-1",
      status: "running",
      message: "Guidance applied",
      unread: false,
    }];
    harness.queueNextStatePublication("3", "2");
    harness.emitServerEvent({ type: "state", commandId, state: covered });
    assert.equal(await command, true);
    await harness.settle();

    assert.match(
      harness.document.querySelector("#status")?.textContent || "",
      /Guidance applied/,
    );
    harness.releaseHeldCommandResponse();
    harness.releaseHeldSteer();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("steering acknowledgement keeps a confirmation created after its submission", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextSteer();
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const steerCall = harness.calls.find((call) => call.path === "/steer");
    const steerId = header(steerCall!, "X-Live-Smith-Steer-Id");

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "post-steer-confirmation",
      message: "Apply the revised plan?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
      bridgeStateRevision: "2",
    });
    harness.emitRawServerEvent({
      type: "steer_accepted",
      sendId,
      sessionId: "session-1",
      steerId,
      bridgeStateRevision: "3",
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent || "",
      /Apply the revised plan/,
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    harness.releaseHeldSteer();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a no-activity steering receipt preserves a newer canonical confirmation status", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the mix pass");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextSteer();
    harness.input("#prompt", "Keep the bass sparse");
    submitSteering(harness);
    await harness.settle();
    const delayedConfirmation = harness.deferServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "post-steer-delayed-confirmation",
      message: "Apply the revised plan?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });

    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
      };
    }).LiveSmithUI;
    assert.equal(await ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed while confirmation was delayed",
    }), true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );

    harness.releaseHeldSteer();
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );
    harness.emitRawServerEvent(delayedConfirmation);
    await harness.settle();
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the revised plan/,
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the harness keeps a superseded confirmation out of later full state", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare the original plan");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "superseded-confirmation",
      message: "Apply the original plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.input("#prompt", "Use the selected track instead");
    submitSteering(harness);
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Guidance applied",
    );

    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
      };
    }).LiveSmithUI;
    assert.equal(await ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed after superseding confirmation",
    }), true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Guidance applied",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed replay cannot restore the confirmation superseded by steering", async () => {
  const state = steeringState();
  state.openSettingsOnLoad = false;
  const harness = await createSteeringDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare the original plan");
    harness.click("#sendButton");
    await harness.settle();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "steer-superseded-confirmation",
      message: "Apply the original plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    const delayedReplay = harness.deferServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "steer-superseded-confirmation",
      message: "Apply the original plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.input("#prompt", "Use the selected track instead");
    submitSteering(harness);
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    harness.emitRawServerEvent(delayedReplay);
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      0,
    );
    assert.deepEqual(harness.stopIds, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late steering acknowledgement cannot clear a newer send draft", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start the first mix pass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.holdNextSteer();
    harness.input("#prompt", "Leave more headroom");
    submitSteering(harness);
    await Promise.resolve();

    harness.releaseHeldSend();
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Start the second mix pass");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Leave more headroom");

    harness.releaseHeldSteer();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Leave more headroom",
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("accepted steering clears its Session draft while another Session is visible", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Start on Bass");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.holdNextSteer();
    harness.input("#prompt", "Keep the Bass part sparse");
    submitSteering(harness);
    await Promise.resolve();

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.releaseHeldSteer();
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("assistant reset removes only the obsolete streaming assistant bubble", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Draft a response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: "Obsolete draft",
    });
    harness.flushAnimationFrames();
    assert.match(
      harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "",
      /Obsolete draft/,
    );

    harness.emitServerEvent({
      type: "assistant_reset",
      sendId,
      sessionId: "session-1",
    });
    assert.equal(
      harness.document.querySelector(".timeline-item.assistant.streaming"),
      null,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("confirmation leaves the composer available but scopes steering to the prompt", async () => {
  const harness = await createSteeringDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a Live change");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-before-steer",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    assert.equal(harness.document.querySelector(".composer")?.hasAttribute("inert"), false);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    harness.input("#prompt", "Do not create a track; use the selected track");
    const cancel = harness.document.querySelector<HTMLButtonElement>(
      "[data-confirm-cancel]",
    );
    cancel?.focus();
    cancel?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 0);

    submitSteering(harness);
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/steer"), [{
      path: "/steer",
      body: {
        prompt: "Do not create a track; use the selected track",
        sessionId: "session-1",
      },
    }]);
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
