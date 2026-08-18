import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      steeringReceipt: {
        sendId,
        id: steerId,
        sha256: createHash("sha256").update("Leave more headroom").digest("hex"),
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

    harness.emitServerEvent({ type: "assistant_delta", sendId, delta: "Obsolete draft" });
    harness.flushAnimationFrames();
    assert.match(
      harness.document.querySelector(".timeline-item.assistant.streaming")?.textContent ?? "",
      /Obsolete draft/,
    );

    harness.emitServerEvent({ type: "assistant_reset", sendId });
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
