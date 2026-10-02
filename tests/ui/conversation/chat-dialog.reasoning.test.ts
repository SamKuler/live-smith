import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneState,
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "../support/chat-dialog.test-harness.js";

test("reasoning stream shows a stage, visible text, reconnect state, and rejects stale epochs", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  try {
    harness.input("#prompt", "Inspect the current clip");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[0]),
      "Expected a held send to start.",
    );
    const sendId = harness.sendIds[0]!;

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "start" },
    });
    harness.flushAnimationFrames();
    assert.equal(
      harness.document.querySelector(".timeline-item.reasoning.streaming")
        ?.textContent,
      "Thinking…",
    );

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: "Checking **clip state**." },
    });
    harness.flushAnimationFrames();
    const live = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.reasoning.streaming",
    );
    assert.ok(live instanceof harness.window.HTMLDetailsElement);
    assert.equal(live.open, true);
    assert.match(live.querySelector("summary")?.textContent ?? "", /Thinking/u);
    assert.doesNotMatch(live.querySelector("summary")?.textContent ?? "", /\*\*/u);
    assert.equal(live.querySelector("summary")?.getAttribute("aria-label"), "Thinking…: Checking clip state.");
    assert.equal(live.querySelector("strong")?.textContent, "clip state");

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "replace", content: "Summarized **route**." },
    });
    harness.flushAnimationFrames();
    assert.doesNotMatch(
      harness.document.querySelector(".timeline-item.reasoning.streaming")
        ?.textContent ?? "",
      /clip state/u,
    );
    assert.equal(
      harness.document.querySelector(
        ".timeline-item.reasoning.streaming strong",
      )?.textContent,
      "route",
    );
    assert.equal(live.querySelector("summary")?.getAttribute("aria-label"), "Thinking…: Summarized route.");

    harness.emitServerEvent({
      type: "model_turn_state",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      assistantDraft: "",
      reasoningDraft: "Recovered reasoning",
      webSearchUpdates: [],
      progress: "Recovered",
      resolvedConfirmationGeneration: 0,
    });
    assert.match(
      harness.document.querySelector(".timeline-item.reasoning.streaming")
        ?.textContent ?? "",
      /Recovered reasoning/u,
    );
    harness.emitRawServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: " stale" },
    });
    harness.emitRawServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      update: { type: "signature", signature: "private-signature" },
    });
    harness.emitRawServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      update: { type: "replace", content: 7 },
    });
    harness.flushAnimationFrames();
    assert.doesNotMatch(
      harness.document.querySelector(".timeline-item.reasoning.streaming")
        ?.textContent ?? "",
      /stale/u,
    );
    assert.doesNotMatch(
      harness.document.querySelector(".timeline-item.reasoning.streaming")
        ?.textContent ?? "",
      /private-signature/u,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("accepted reasoning is expandable while empty reasoning is omitted from history", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "reasoning-with-content",
    createdAt: "2026-09-12T00:00:00.000Z",
    kind: "reasoning",
    content: "Checking the selected track.\n\nThe routing is valid.",
  }, {
    id: "reasoning-stage-only",
    createdAt: "2026-09-12T00:00:01.000Z",
    kind: "reasoning",
    content: "",
  }, {
    id: "reasoning-whitespace-only",
    createdAt: "2026-09-12T00:00:01.500Z",
    kind: "reasoning",
    content: " \n\t ",
  }, {
    id: "assistant-after-reasoning",
    createdAt: "2026-09-12T00:00:02.000Z",
    kind: "assistant",
    content: "The routing is valid.",
  }];

  const harness = await createDialogHarness(state);
  try {
    const detailed = harness.document.querySelector<HTMLDetailsElement>(
      '[data-event-id="reasoning-with-content"]',
    );
    assert.ok(detailed instanceof harness.window.HTMLDetailsElement);
    assert.equal(detailed.open, false);
    assert.match(
      detailed.querySelector("summary")?.textContent ?? "",
      /Thinking.*Checking the selected track/u,
    );
    detailed.querySelector("summary")?.click();
    assert.equal(detailed.open, true);
    assert.match(detailed.textContent ?? "", /The routing is valid/u);

    const stageOnly = harness.document.querySelector(
      '[data-event-id="reasoning-stage-only"]',
    );
    assert.equal(stageOnly, null);
    assert.equal(harness.document.querySelector('[data-event-id="reasoning-whitespace-only"]'), null);
    assert.equal(
      harness.document.querySelector('[data-event-id="assistant-after-reasoning"] .timeline-content')?.textContent,
      "The routing is valid.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a live thinking indicator disappears when the accepted reasoning has no text", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "zh-CN";
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  try {
    harness.input("#prompt", "Inspect the current clip");
    harness.click("#sendButton");
    await waitForCondition(() => Boolean(harness.sendIds[0]), "Expected a held send to start.");
    const sendId = harness.sendIds[0]!;
    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "start" },
    });
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector(".reasoning.streaming")?.textContent, "正在思考…");

    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: null,
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "accepted-empty-reasoning",
        createdAt: "2026-09-12T00:00:00.000Z",
        kind: "reasoning",
        content: "",
      },
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "assistant-after-empty-reasoning",
        createdAt: "2026-09-12T00:00:01.000Z",
        kind: "assistant",
        content: "The clip is ready.",
      },
    });
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector(".timeline-item.reasoning"), null);
    assert.equal(
      harness.document.querySelector('[data-event-id="assistant-after-empty-reasoning"] .timeline-content')?.textContent,
      "The clip is ready.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a full timeline reconciliation preserves a collapsed live reasoning item and summary focus", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  try {
    harness.input("#prompt", "Inspect the current clip");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[0]),
      "Expected a held send to start.",
    );
    const sendId = harness.sendIds[0]!;

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: "Checking the clip." },
    });
    harness.flushAnimationFrames();
    const original = harness.document.querySelector<HTMLDetailsElement>(
      '[data-message-key="reasoning-streaming"]',
    );
    assert.ok(original instanceof harness.window.HTMLDetailsElement);
    original.open = false;
    original.querySelector("summary")?.focus();

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: " Routing is valid." },
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      event: {
        id: "tool-call-during-reasoning",
        createdAt: "2026-09-12T00:00:00.000Z",
        kind: "tool_call",
        name: "inspect_track",
        content: "{}",
      },
    });

    const reconciled = harness.document.querySelector<HTMLDetailsElement>(
      '[data-message-key="reasoning-streaming"]',
    );
    assert.ok(reconciled instanceof harness.window.HTMLDetailsElement);
    assert.notEqual(reconciled, original);
    assert.equal(reconciled.open, false);
    assert.equal(harness.document.activeElement, reconciled.querySelector("summary"));
    assert.match(reconciled.textContent ?? "", /Routing is valid/u);
    harness.flushAnimationFrames();
    assert.equal(reconciled.open, false);
    assert.equal(harness.document.activeElement, reconciled.querySelector("summary"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("accepted reasoning hands summary focus from its transient item to its durable event", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "earlier-empty-reasoning",
    createdAt: "2026-09-11T00:00:00.000Z",
    kind: "reasoning",
    content: "",
  }];
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  try {
    harness.input("#prompt", "Inspect the current clip");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[0]),
      "Expected a held send to start.",
    );
    const sendId = harness.sendIds[0]!;
    const content = "Checking the accepted routing.";

    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: content },
    });
    harness.flushAnimationFrames();
    const transientSummary = harness.document.querySelector<HTMLElement>(
      '[data-message-key="reasoning-streaming"] > summary',
    );
    assert.ok(transientSummary);
    transientSummary.focus();

    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: null,
    });
    assert.equal(
      harness.document.querySelector('[data-message-key="reasoning-streaming"]'),
      null,
    );
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "accepted-reasoning",
        createdAt: "2026-09-12T00:00:00.000Z",
        kind: "reasoning",
        content,
      },
    });

    const durableSummary = harness.document.querySelector<HTMLElement>(
      '[data-event-id="accepted-reasoning"] > summary',
    );
    assert.ok(durableSummary);
    assert.equal(harness.document.activeElement, durableSummary);
    durableSummary.click();
    assert.equal((durableSummary.parentElement as HTMLDetailsElement).open, true);
    assert.equal(durableSummary.nextElementSibling?.textContent, content);

    const laterContent = "Checking a later routing change.";
    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      update: { type: "delta", delta: laterContent },
    });
    harness.flushAnimationFrames();
    harness.document.querySelector<HTMLElement>(
      '[data-message-key="reasoning-streaming"] > summary',
    )?.focus();
    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 2,
      usage: null,
    });
    const sendButton = harness.document.querySelector<HTMLButtonElement>(
      "#sendButton",
    );
    assert.ok(sendButton);
    sendButton.focus();
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 2,
      event: {
        id: "later-reasoning",
        createdAt: "2026-09-12T00:00:01.000Z",
        kind: "reasoning",
        content: laterContent,
      },
    });
    assert.equal(harness.document.activeElement, sendButton);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a failed reasoning focus handoff cannot target a later Send", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const content = "Repeated reasoning.";
  harness.holdNextSend();
  try {
    harness.input("#prompt", "First request");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[0]),
      "Expected the first held send to start.",
    );
    const firstSendId = harness.sendIds[0]!;
    harness.emitServerEvent({
      type: "reasoning_update",
      sendId: firstSendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: content },
    });
    harness.flushAnimationFrames();
    harness.document.querySelector<HTMLElement>(
      '[data-message-key="reasoning-streaming"] > summary',
    )?.focus();
    harness.emitServerEvent({
      type: "context_usage_update",
      sendId: firstSendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: null,
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId: firstSendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "first-reasoning-error",
        createdAt: "2026-09-12T00:00:00.000Z",
        kind: "error",
        content: "The first request failed.",
      },
    });
    harness.releaseHeldSend();
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Second request");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[1]),
      "Expected the second held send to start.",
    );
    const secondSendId = harness.sendIds[1]!;
    harness.emitServerEvent({
      type: "reasoning_update",
      sendId: secondSendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: content },
    });
    harness.flushAnimationFrames();
    harness.emitServerEvent({
      type: "context_usage_update",
      sendId: secondSendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: null,
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId: secondSendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "second-reasoning",
        createdAt: "2026-09-12T00:00:01.000Z",
        kind: "reasoning",
        content,
      },
    });

    const secondSummary = harness.document.querySelector(
      '[data-event-id="second-reasoning"] > summary',
    );
    assert.ok(secondSummary);
    assert.notEqual(harness.document.activeElement, secondSummary);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("batched authoritative events expire reasoning focus before a later match", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const content = "Repeated reasoning.";
  harness.holdNextSend();
  try {
    harness.input("#prompt", "First request");
    harness.click("#sendButton");
    await waitForCondition(
      () => Boolean(harness.sendIds[0]),
      "Expected the held send to start.",
    );
    const sendId = harness.sendIds[0]!;
    harness.emitServerEvent({
      type: "reasoning_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      update: { type: "delta", delta: content },
    });
    harness.flushAnimationFrames();
    harness.document.querySelector<HTMLElement>(
      '[data-message-key="reasoning-streaming"] > summary',
    )?.focus();
    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: null,
    });

    const authoritative = cloneState(state);
    authoritative.events = [{
      id: "first-request-error",
      createdAt: "2026-09-12T00:00:00.000Z",
      kind: "error",
      content: "The first request failed.",
    }, {
      id: "later-reasoning",
      createdAt: "2026-09-12T00:00:01.000Z",
      kind: "reasoning",
      content,
    }];
    authoritative.sessionActivities = [{
      sessionId: "session-1",
      sendId,
      status: "failed",
      message: "The first request failed.",
      unread: false,
    }];
    harness.emitServerEvent({
      type: "error",
      sendId,
      sessionId: "session-1",
      message: "The first request failed.",
      promptPersistence: "persisted",
      state: authoritative,
    });
    await harness.settle();

    const laterSummary = harness.document.querySelector(
      '[data-event-id="later-reasoning"] > summary',
    );
    assert.ok(laterSummary);
    assert.notEqual(harness.document.activeElement, laterSummary);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});
