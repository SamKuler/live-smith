import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function messageState(): ReturnType<typeof stateFixture> {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [
    {
      id: "message-user",
      kind: "user" as const,
      content: "Keep **this** rhythm.\nSecond line.",
      createdAt: "2026-09-04T00:00:00.000Z",
    },
    {
      id: "message-assistant",
      kind: "assistant" as const,
      content: "A **small** change:\n\n```text\nkick → snare\n```",
      createdAt: "2026-09-04T00:00:01.000Z",
    },
  ];
  return state;
}

test("message copy writes original Markdown without speaker or action labels", async () => {
  const state = messageState();
  const harness = await createDialogHarness(state);
  try {
    for (const event of state.events) {
      const button = harness.document.querySelector<HTMLButtonElement>(
        `[data-event-id="${event.id}"] [data-message-action="copy"]`,
      );
      assert.ok(button);
      assert.equal(button.type, "button");
      button.click();
      await harness.settle();
      assert.equal(button.dataset.copyState, "copied");
      assert.equal(button.disabled, false);
    }
    assert.deepEqual(harness.clipboardWrites, state.events.map((event) => event.content));
    assert.match(
      harness.document.querySelector("#messageActionAnnouncements")?.textContent ?? "",
      /copied/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("copy falls back inside the document without changing the composer or selection", async () => {
  const harness = await createDialogHarness(messageState());
  try {
    Object.defineProperty(harness.window.navigator, "clipboard", { value: undefined });
    const writes: string[] = [];
    Object.defineProperty(harness.document, "execCommand", {
      value: (command: string) => {
        assert.equal(command, "copy");
        writes.push((harness.document.activeElement as HTMLTextAreaElement).value);
        return true;
      },
    });
    harness.input("#prompt", "Keep my draft intact");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    prompt.focus();
    prompt.setSelectionRange(2, 7);
    harness.click('[data-event-id="message-user"] [data-message-action="copy"]');
    await harness.settle();

    assert.deepEqual(writes, [messageState().events[0]!.content]);
    assert.equal(harness.document.activeElement, prompt);
    assert.equal(prompt.value, "Keep my draft intact");
    assert.equal(prompt.selectionStart, 2);
    assert.equal(prompt.selectionEnd, 7);
    assert.equal(harness.document.querySelector("[data-clipboard-fallback]"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("failed clipboard access remains retryable and does not claim success or echo its cause", async () => {
  const harness = await createDialogHarness(messageState());
  try {
    Object.defineProperty(harness.window.navigator, "clipboard", {
      value: { writeText: async () => { throw new Error("private clipboard cause"); } },
    });
    Object.defineProperty(harness.document, "execCommand", { value: () => false });
    const button = harness.document.querySelector<HTMLButtonElement>(
      '[data-event-id="message-assistant"] [data-message-action="copy"]',
    )!;
    assert.ok(button);
    button.click();
    await harness.settle();
    assert.equal(button.dataset.copyState, "failed");
    assert.equal(button.disabled, false);
    const announcement = harness.document.querySelector("#messageActionAnnouncements")?.textContent ?? "";
    assert.match(announcement, /could not copy|copy unavailable/i);
    assert.doesNotMatch(announcement, /private clipboard cause/i);
    assert.deepEqual(harness.clipboardWrites, []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("message actions and copy feedback keep their DOM identity through unrelated timeline updates", async () => {
  const state = messageState();
  state.events.splice(1, 0, {
    id: "earlier-tool", kind: "tool_call", name: "inspect_track", content: "{}",
    createdAt: "2026-09-04T00:00:00.100Z",
  }, {
    id: "earlier-result", kind: "tool_result", name: "inspect_track", content: "Track inspected",
    createdAt: "2026-09-04T00:00:00.200Z",
  });
  const harness = await createDialogHarness(state);
  try {
    let finishCopy!: () => void;
    Object.defineProperty(harness.window.navigator, "clipboard", {
      value: { writeText: () => new Promise<void>((resolve) => { finishCopy = resolve; }) },
    });
    const message = harness.document.querySelector('[data-event-id="message-assistant"]');
    const button = message?.querySelector<HTMLButtonElement>('[data-message-action="copy"]');
    assert.ok(button);
    button.focus();
    button.click();
    harness.holdNextSend();
    harness.input("#prompt", "Continue from that idea");
    harness.click("#sendButton");
    assert.equal(harness.document.querySelector('[data-event-id="message-assistant"]'), message);
    assert.equal(harness.document.activeElement, button);
    finishCopy();
    await harness.settle();
    assert.equal(button.dataset.copyState, "copied");
    assert.equal(button.isConnected, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (harness.sendIds.length) harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("only new messages enter with motion, not history or a persisted pending-message replacement", async () => {
  const harness = await createDialogHarness(messageState());
  try {
    assert.equal(harness.document.querySelector(".message-enter"), null);
    harness.holdNextSend();
    harness.input("#prompt", "New message");
    harness.click("#sendButton");
    const pending = harness.document.querySelector(".local-user-message");
    assert.ok(pending);
    assert.equal(pending.classList.contains("message-enter"), true);
    pending.dispatchEvent(new harness.window.Event("animationend"));
    assert.equal(pending.classList.contains("message-enter"), false);
    harness.emitServerEvent({
      type: "session_event",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      event: {
        id: "new-user-event",
        kind: "user",
        content: "New message",
        createdAt: "2026-09-04T00:01:00.000Z",
      },
    });
    assert.equal(harness.document.querySelector(".local-user-message"), null);
    assert.equal(harness.document.querySelector(".message-enter"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("streaming enters once and does not reanimate on every token", async () => {
  const harness = await createDialogHarness(messageState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Develop this idea");
    harness.click("#sendButton");
    const emit = (delta: string) => harness.emitServerEvent({
      type: "assistant_delta",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      delta,
    });
    emit("Start");
    harness.flushAnimationFrames();
    const streaming = harness.document.querySelector(".assistant.streaming");
    assert.ok(streaming);
    assert.equal(streaming.classList.contains("message-enter"), true);
    streaming.dispatchEvent(new harness.window.Event("animationend"));
    emit(" with the bass.");
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector(".assistant.streaming"), streaming);
    assert.equal(streaming.classList.contains("message-enter"), false);
    assert.equal(streaming.querySelector(".timeline-content")?.textContent, "Start with the bass.");
    harness.emitServerEvent({
      type: "session_event", sendId: harness.sendIds[0], sessionId: "session-1",
      event: {
        id: "persisted-assistant", kind: "assistant", content: "Start with the bass.",
        createdAt: "2026-09-04T00:01:00.000Z",
      },
    });
    assert.equal(harness.document.querySelector(".assistant.streaming"), null);
    assert.equal(
      harness.document.querySelector('[data-event-id="persisted-assistant"]')?.classList.contains("message-enter"),
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a late copy result does not announce success in another Session or animate navigated history", async () => {
  const harness = await createDialogHarness(messageState());
  try {
    let finishCopy!: () => void;
    Object.defineProperty(harness.window.navigator, "clipboard", {
      value: { writeText: () => new Promise<void>((resolve) => { finishCopy = resolve; }) },
    });
    harness.click('[data-event-id="message-user"] [data-message-action="copy"]');
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    finishCopy();
    await harness.settle();
    assert.equal(harness.document.querySelector("#messageActionAnnouncements")?.textContent, "");
    assert.equal(harness.document.querySelector(".message-enter"), null);
    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector(".message-enter"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
