import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import test from "node:test";

import { HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND } from "../model/tools.js";
import { MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES } from "./chat-state.js";
import {
  cloneState,
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

function webSearch(id: string, query = "Ableton Live routing") {
  return {
    id,
    status: "searching" as const,
    action: "search" as const,
    queries: [query],
    sources: [],
  };
}

function modelTurnState(
  sendId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "model_turn_state",
    sendId,
    sessionId: "session-1",
    modelTurnEpoch: 0,
    assistantDraft: "Authoritative draft",
    webSearchUpdates: [webSearch("search-snapshot")],
    progress: "Authoritative progress",
    resolvedConfirmationGeneration: 0,
    ...overrides,
  };
}

async function startHeldSend(
  harness: Harness,
  prompt = "Test model-turn recovery",
): Promise<string> {
  harness.holdNextSend();
  harness.input("#prompt", prompt);
  harness.click("#sendButton");
  await waitForCondition(
    () => Boolean(harness.sendIds.at(-1)),
    "Expected a held send to start.",
  );
  return harness.sendIds.at(-1)!;
}

function streamingText(harness: Harness): string {
  return harness.document.querySelector(".timeline-item.assistant.streaming")
    ?.textContent ?? "";
}

function submitFollowUp(harness: Harness): void {
  const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  assert.ok(prompt);
  prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    key: "Enter",
  }));
}

async function selectSession(
  harness: Harness,
  sessionId: string,
): Promise<void> {
  const row = harness.document.querySelector<HTMLButtonElement>(
    `.session-entry[data-session-id="${sessionId}"] .session-row`,
  );
  assert.ok(row);
  row.click();
  await waitForCondition(
    () => harness.calls.some((call) =>
      call.path === "/command" &&
      call.jsonBody &&
      typeof call.jsonBody === "object" &&
      "kind" in call.jsonBody &&
      call.jsonBody.kind === "select_session" &&
      "sessionId" in call.jsonBody &&
      call.jsonBody.sessionId === sessionId
    ),
    `Expected ${sessionId} to be selected.`,
  );
  await harness.settle();
}

test("a reconnect snapshot replaces same-epoch transient state and restores its progress on open", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      delta: "Incomplete draft",
    });
    harness.flushAnimationFrames();
    harness.emitServerEventError();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Lost connection/,
    );
    harness.emitServerEventOpen();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Starting Live Smith…",
    );

    harness.emitServerEvent(modelTurnState(sendId, {
      assistantDraft: "The chord is C major, not C",
      progress: "Reconnected to model turn",
    }));
    harness.flushAnimationFrames();
    assert.match(streamingText(harness), /The chord is C major, not C/);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Reconnected to model turn",
    );
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      delta: "7.",
    });
    harness.flushAnimationFrames();
    assert.match(streamingText(harness), /The chord is C major, not C7\./);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("model-turn snapshots reject malformed exact or nested wire data atomically", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent(modelTurnState(sendId, {
      assistantDraft: "Trusted draft",
      progress: "Trusted progress",
      webSearchUpdates: [webSearch("trusted-search")],
    }));
    harness.flushAnimationFrames();

    const valid = modelTurnState(sendId, {
      assistantDraft: "Poisoned draft",
      progress: "Poisoned progress",
      webSearchUpdates: [webSearch("poisoned-search")],
    });
    const without = (key: string) => {
      const copy = { ...valid };
      delete copy[key];
      return copy;
    };
    const tooManySearches = Array.from(
      { length: HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND + 1 },
      (_, index) => webSearch(`search-${index}`),
    );
    const invalidPayloads = [
      without("progress"),
      { ...valid, extra: true },
      { ...valid, modelTurnEpoch: -1 },
      { ...valid, modelTurnEpoch: 0.5 },
      { ...valid, progress: 7 },
      { ...valid, resolvedConfirmationGeneration: -1 },
      { ...valid, resolvedConfirmationGeneration: 0.5 },
      {
        ...valid,
        webSearchUpdates: [
          webSearch("duplicate-search"),
          webSearch("duplicate-search", "different query"),
        ],
      },
      { ...valid, webSearchUpdates: tooManySearches },
      {
        ...valid,
        webSearchUpdates: [{ ...webSearch("invalid-search"), queries: [" padded "] }],
      },
    ];

    for (const payload of invalidPayloads) {
      harness.emitRawServerEvent(payload);
      harness.flushAnimationFrames();
      assert.match(streamingText(harness), /Trusted draft/);
      assert.doesNotMatch(streamingText(harness), /Poisoned draft/);
      assert.equal(
        harness.document.querySelector("#status")?.textContent,
        "Trusted progress",
      );
      assert.equal(
        harness.document.querySelectorAll(".timeline-item.web_search.live").length,
        1,
      );
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("transient model-turn events enforce monotonic epochs and idempotent resets", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent(modelTurnState(sendId, {
      modelTurnEpoch: 1,
      assistantDraft: "Epoch one",
      webSearchUpdates: [],
    }));
    harness.flushAnimationFrames();

    harness.emitRawServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: " missing epoch",
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 2,
      delta: "Epoch two",
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      delta: " stale",
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 2,
      delta: " current",
    });
    harness.flushAnimationFrames();
    assert.match(streamingText(harness), /Epoch two current/);
    assert.doesNotMatch(streamingText(harness), /missing epoch|stale/);

    harness.emitServerEvent({
      type: "assistant_reset",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 2,
    });
    assert.match(streamingText(harness), /Epoch two current/);
    harness.emitServerEvent({
      type: "assistant_reset",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 3,
    });
    assert.equal(streamingText(harness), "");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("every epoch-scoped decoder rejects missing, negative, and fractional epochs before mutation", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent(modelTurnState(sendId, {
      assistantDraft: "Trusted epoch draft",
      webSearchUpdates: [],
    }));
    harness.flushAnimationFrames();

    for (const [index, modelTurnEpoch] of [undefined, -1, 0.5].entries()) {
      const epoch = modelTurnEpoch === undefined ? {} : { modelTurnEpoch };
      harness.emitRawServerEvent({
        type: "assistant_delta",
        sendId,
        sessionId: "session-1",
        ...epoch,
        delta: " poisoned delta",
      });
      harness.emitRawServerEvent({
        type: "assistant_reset",
        sendId,
        sessionId: "session-1",
        ...epoch,
      });
      harness.emitRawServerEvent({
        type: "web_search_update",
        sendId,
        sessionId: "session-1",
        ...epoch,
        update: webSearch(`invalid-epoch-search-${index}`),
      });
      harness.emitRawServerEvent({
        type: "session_event",
        sendId,
        sessionId: "session-1",
        ...epoch,
        event: {
          id: `invalid-epoch-event-${index}`,
          createdAt: `2026-08-23T00:00:0${index}.000Z`,
          kind: "assistant",
          content: "Invalid epoch event",
        },
        bridgeStateRevision: "50",
      });
      harness.emitRawServerEvent({
        type: "confirm_request",
        sendId,
        sessionId: "session-1",
        ...epoch,
        id: `invalid-epoch-confirmation-${index}`,
        confirmationGeneration: 1,
        message: "Invalid epoch confirmation",
        groups: [{ title: "Tracks", rows: ["Delete track"] }],
        activity: {
          status: "waiting_confirmation",
          message: "Waiting for confirmation",
        },
        bridgeStateRevision: "51",
      });
    }
    harness.flushAnimationFrames();
    assert.match(streamingText(harness), /Trusted epoch draft/);
    assert.doesNotMatch(streamingText(harness), /poisoned delta/);
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search.live").length,
      0,
    );
    assert.equal(
      harness.document.querySelector('[data-event-id^="invalid-epoch-event-"]'),
      null,
    );
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.emitRawServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      event: {
        id: "valid-event-after-invalid-epochs",
        createdAt: "2026-08-23T00:00:10.000Z",
        kind: "error",
        content: "Valid after invalid epoch payloads",
      },
      bridgeStateRevision: "50",
    });
    assert.match(
      harness.document.querySelector(
        '[data-event-id="valid-event-after-invalid-epochs"]',
      )?.textContent ?? "",
      /Valid after invalid epoch payloads/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("session events preserve durable history without clearing a newer same-epoch draft", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent(modelTurnState(sendId, {
      modelTurnEpoch: 1,
      assistantDraft: "Newer draft",
      webSearchUpdates: [webSearch("newer-search")],
    }));
    harness.flushAnimationFrames();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "older-assistant-event",
        createdAt: "2026-08-23T00:00:01.000Z",
        kind: "assistant",
        content: "Older answer",
      },
    });
    assert.match(streamingText(harness), /Newer draft/);
    assert.match(
      harness.document.querySelector('[data-event-id="older-assistant-event"]')
        ?.textContent ?? "",
      /Older answer/,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      event: {
        id: "lower-epoch-assistant-event",
        createdAt: "2026-08-23T00:00:02.000Z",
        kind: "assistant",
        content: "Newer draft",
      },
    });
    assert.match(streamingText(harness), /Newer draft/);
    assert.match(
      harness.document.querySelector('[data-event-id="lower-epoch-assistant-event"]')
        ?.textContent ?? "",
      /Newer draft/,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "matching-assistant-event",
        createdAt: "2026-08-23T00:00:03.000Z",
        kind: "assistant",
        content: "  Newer draft  ",
      },
    });
    assert.equal(streamingText(harness), "");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("snapshot frontiers and confirmation epochs reject superseded confirmation replay", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      id: "confirmation-one",
      confirmationGeneration: 1,
      message: "Apply generation one?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /generation one/,
    );

    harness.emitServerEvent(modelTurnState(sendId, {
      modelTurnEpoch: 1,
      assistantDraft: "",
      webSearchUpdates: [],
      resolvedConfirmationGeneration: 1,
    }));
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      id: "stale-confirmation-two",
      confirmationGeneration: 2,
      message: "Stale generation two?",
      groups: [{ title: "Tracks", rows: ["Delete track"] }],
    });
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      id: "confirmation-two",
      confirmationGeneration: 2,
      message: "Apply current generation two?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /current generation two/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a background reconnect snapshot is restored when its Session becomes active", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background model turn");
    await selectSession(harness, "session-2");
    harness.emitServerEvent(modelTurnState(sendId, {
      assistantDraft: "Background recovered draft",
      progress: "Background recovered progress",
      webSearchUpdates: [],
    }));
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Background recovered progress/,
    );

    await selectSession(harness, "session-1");
    harness.flushAnimationFrames();
    assert.match(streamingText(harness), /Background recovered draft/);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Background recovered progress",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("model-turn snapshots enforce the shared UTF-8 transient draft limit atomically", {
  timeout: 5_000,
}, async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const exactDraft = "é".repeat(MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES / 2);
  const renderedDraft = () => harness.document.querySelector(
    ".timeline-item.assistant.streaming .timeline-content",
  )?.textContent ?? "";
  assert.equal(
    NodeBuffer.byteLength(exactDraft, "utf8"),
    MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES,
  );
  try {
    const sendId = await startHeldSend(harness);
    harness.emitRawServerEvent(modelTurnState(sendId, {
      assistantDraft: exactDraft,
      webSearchUpdates: [],
      progress: "Exact UTF-8 boundary accepted",
    }));
    harness.flushAnimationFrames();
    assert.equal(renderedDraft() === exactDraft, true);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Exact UTF-8 boundary accepted",
    );

    harness.emitRawServerEvent(modelTurnState(sendId, {
      assistantDraft: `${exactDraft}a`,
      webSearchUpdates: [webSearch("poisoned-over-limit-search")],
      progress: "Poisoned one-byte-over snapshot",
    }));
    harness.flushAnimationFrames();
    assert.equal(renderedDraft() === exactDraft, true);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Exact UTF-8 boundary accepted",
    );
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search.live").length,
      0,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("connection overlay reveals the latest state, profile gate, command, Queue, and Stop underlay", async (context) => {
  await context.test("state and profile gate", async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.status = "State is ready";
    const harness = await createDialogHarness(state);
    try {
      harness.emitServerEventError();
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /Lost connection/,
      );
      assert.equal(
        harness.document.querySelector("#status")?.classList.contains("error"),
        true,
      );
      harness.emitServerEventOpen();
      assert.equal(harness.document.querySelector("#status")?.textContent, "State is ready");
      assert.equal(
        harness.document.querySelector("#status")?.classList.contains("error"),
        false,
      );
      assert.equal(harness.document.querySelector<HTMLElement>("#status")?.hidden, false);
      harness.emitServerEventOpen();
      assert.equal(harness.document.querySelector("#status")?.textContent, "State is ready");
    } finally {
      harness.close();
    }

    const profileState = cloneState(stateFixture());
    profileState.openSettingsOnLoad = false;
    profileState.settings.activeProfileId = null;
    profileState.runtimeProfile = null;
    profileState.modelStateSource = null;
    const profileHarness = await createDialogHarness(profileState);
    try {
      profileHarness.emitServerEventError();
      profileHarness.emitServerEventOpen();
      assert.match(
        profileHarness.document.querySelector("#status")?.textContent ?? "",
        /Create and save a model profile/,
      );
    } finally {
      profileHarness.close();
    }
  });

  await context.test("command", async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    const harness = await createDialogHarness(state);
    try {
      harness.holdNextCommand();
      const ui = (harness.window as unknown as {
        LiveSmithUI: {
          runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
        };
      }).LiveSmithUI;
      const command = ui.runCommand("rename_session", {
        sessionId: "session-2",
        title: "Renamed",
      });
      await waitForCondition(
        () => harness.calls.some((call) => call.path === "/command"),
        "Expected a held command.",
      );
      harness.emitServerEventError();
      harness.emitServerEventOpen();
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /Renaming Session/,
      );
      harness.releaseHeldCommand();
      await command;
      await harness.settle();
    } finally {
      harness.close();
    }
  });

  await context.test("Queue and Stop", async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    const harness = await createDialogHarness(state);
    try {
      await startHeldSend(harness);
      harness.emitServerEventError();
      harness.input("#prompt", "Queue after reconnect");
      submitFollowUp(harness);
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /Lost connection/,
      );
      harness.emitServerEventOpen();
      assert.equal(harness.document.querySelector("#status")?.textContent, "Follow-up queued.");

      harness.queueStopOutcomes({ terminal: false });
      harness.emitServerEventError();
      harness.click("#sendButton");
      await harness.settle();
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /Stop requested|Stopping/,
      );
      harness.emitServerEventOpen();
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /Stop requested|Stopping/,
      );
      harness.releaseHeldSend();
      await harness.settle();
    } finally {
      harness.close();
    }
  });
});
