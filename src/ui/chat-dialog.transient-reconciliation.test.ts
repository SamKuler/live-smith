import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

test("a repeated session event keeps its existing timeline position", async () => {
  const state = stateFixture();
  const earlierError = {
    id: "event-earlier-error",
    createdAt: "2026-08-23T00:00:01.000Z",
    kind: "error" as const,
    content: "Original error.",
  };
  state.events = [
    earlierError,
    {
      id: "event-later-assistant",
      createdAt: "2026-08-23T00:00:02.000Z",
      kind: "assistant",
      content: "A later response.",
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep the timeline order stable");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        ...earlierError,
        content: "Updated error.",
      },
    });

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(
        "#timeline > .timeline-item",
      )].map((item) => item.dataset.eventId),
      ["event-earlier-error", "event-later-assistant"],
    );
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-earlier-error"]')
        .length,
      1,
    );
    assert.match(
      harness.document.querySelector('[data-event-id="event-earlier-error"]')
        ?.textContent ?? "",
      /Updated error/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("assistant reset clears the interrupted Session draft and live search", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Reconnect after a partial response");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "search-before-reset",
        status: "searching",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      },
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: "A partial response",
    });
    harness.flushAnimationFrames();
    assert.ok(harness.document.querySelector(".timeline-item.web_search.live"));
    assert.ok(harness.document.querySelector(".timeline-item.streaming"));

    harness.emitServerEvent({
      type: "assistant_reset",
      sendId,
      sessionId: "session-1",
    });

    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});
