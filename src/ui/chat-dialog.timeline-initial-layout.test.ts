import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
  type DialogHarness,
} from "./chat-dialog.test-harness.js";

function historyState(): ReturnType<typeof stateFixture> {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`,
    kind: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Message ${index}\n\n${"Existing conversation. ".repeat(20)}`,
    createdAt: new Date(Date.UTC(2026, 8, 4, 0, 0, index)).toISOString(),
  }));
  return state;
}

function timelineLayout(harness: DialogHarness) {
  const timeline = harness.document.querySelector<HTMLElement>("#timeline")!;
  const layout = { height: 0, contentHeight: 3200, top: 0, writes: [] as number[] };
  Object.defineProperties(timeline, {
    clientHeight: { configurable: true, get: () => layout.height },
    scrollHeight: {
      configurable: true,
      get: () => layout.height > 0 ? layout.contentHeight : 0,
    },
    scrollTop: {
      configurable: true,
      get: () => layout.top,
      set: (value: number) => {
        layout.writes.push(value);
        layout.top = Math.max(0, Math.min(value, layout.contentHeight - layout.height));
      },
    },
  });
  return { timeline, layout };
}

function notifyWindowLayout(harness: DialogHarness): void {
  harness.window.dispatchEvent(new harness.window.Event("resize"));
}

test("initial history waits for a nonzero layout and uses the final layout once", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { timeline, layout } = timelineLayout(harness);
    assert.equal(timeline.children.length, 40);
    assert.equal(harness.flushAnimationFrames(), 0);
    notifyWindowLayout(harness);
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.deepEqual(layout.writes, []);

    layout.height = 500;
    notifyWindowLayout(harness);
    notifyWindowLayout(harness);
    assert.equal(layout.top, 0);
    assert.deepEqual(layout.writes, []);
    layout.contentHeight = 3600;
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 3100);
    assert.deepEqual(layout.writes, [3600]);

    layout.top = 120;
    layout.contentHeight = 4000;
    notifyWindowLayout(harness);
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.equal(layout.top, 120);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a hidden pending frame waits for another layout signal without polling", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { layout } = timelineLayout(harness);
    layout.height = 500;
    notifyWindowLayout(harness);
    layout.height = 0;
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.deepEqual(layout.writes, []);

    layout.height = 600;
    notifyWindowLayout(harness);
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 2600);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const input of ["wheel", "pointerdown", "ArrowUp", "PageDown", "Home", " "]) {
  test(`reader ${JSON.stringify(input)} input cancels deferred initial positioning`, async () => {
    const harness = await createDialogHarness(historyState());
    try {
      const { timeline, layout } = timelineLayout(harness);
      layout.height = 500;
      notifyWindowLayout(harness);
      timeline.dispatchEvent(input === "wheel" || input === "pointerdown"
        ? new harness.window.Event(input, { bubbles: true })
        : new harness.window.KeyboardEvent("keydown", { key: input, bubbles: true }));
      layout.top = 180;
      timeline.dispatchEvent(new harness.window.Event("scroll"));
      assert.equal(harness.flushAnimationFrames(), 0);
      notifyWindowLayout(harness);
      assert.equal(harness.flushAnimationFrames(), 0);
      assert.equal(layout.top, 180);
      assert.deepEqual(layout.writes, []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("composer navigation and non-scrolling keys do not cancel initial positioning", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { timeline, layout } = timelineLayout(harness);
    layout.height = 500;
    notifyWindowLayout(harness);
    harness.document.querySelector("#prompt")!.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    timeline.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 2700);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("switching Session retires its old positioning frame before positioning new history", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { layout } = timelineLayout(harness);
    const frames: FrameRequestCallback[] = [];
    const requestFrame = harness.window.requestAnimationFrame.bind(harness.window);
    harness.window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return requestFrame(callback);
    };
    layout.height = 500;
    notifyWindowLayout(harness);
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(frames.length, 2);
    assert.deepEqual(layout.writes, []);
    frames[0]!(0);
    assert.deepEqual(layout.writes, []);
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 2700);
    assert.deepEqual(layout.writes, [3200]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("ResizeObserver tracks only pending Session positioning and disconnects after completion", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { timeline, layout } = timelineLayout(harness);
    const observers: Array<{
      notify(): void;
      target: Element | null;
      disconnected: boolean;
    }> = [];
    Object.defineProperty(harness.window, "ResizeObserver", {
      configurable: true,
      value: class {
        target: Element | null = null;
        disconnected = false;
        constructor(private callback: () => void) { observers.push(this); }
        observe(target: Element) { this.target = target; }
        disconnect() { this.disconnected = true; }
        notify() { this.callback(); }
      },
    });
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(observers.length, 1);
    assert.equal(observers[0]!.target, timeline);
    observers[0]!.notify();
    assert.equal(harness.flushAnimationFrames(), 0);
    layout.height = 500;
    observers[0]!.notify();
    observers[0]!.notify();
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 2700);
    assert.equal(observers[0]!.disconnected, true);

    layout.top = 100;
    observers[0]!.notify();
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.equal(layout.top, 100);

    harness.click('[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(observers.length, 2);
    timeline.dispatchEvent(new harness.window.Event("wheel", { bubbles: true }));
    assert.equal(observers[1]!.disconnected, true);
    observers[1]!.notify();
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.equal(layout.top, 100);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("completed initial positioning preserves streaming follow-bottom and reader position", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { timeline, layout } = timelineLayout(harness);
    layout.height = 500;
    notifyWindowLayout(harness);
    assert.equal(harness.flushAnimationFrames(), 1);
    harness.holdNextSend();
    harness.input("#prompt", "Continue this conversation");
    harness.click("#sendButton");
    await Promise.resolve();
    layout.writes.length = 0;
    const emit = (delta: string) => harness.emitServerEvent({
      type: "assistant_delta",
      sessionId: "session-1",
      sendId: harness.sendIds[0],
      delta,
    });
    emit("At the bottom.");
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.deepEqual(layout.writes, [3200]);
    layout.top = 120;
    layout.writes.length = 0;
    emit(" Still reading history.");
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 120);
    assert.deepEqual(layout.writes, []);
    assert.equal(
      timeline.querySelector(".assistant.streaming .timeline-content")?.textContent,
      "At the bottom. Still reading history.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (harness.sendIds.length) harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("streaming while the initial timeline is hidden preserves pending layout positioning", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    const { layout } = timelineLayout(harness);
    harness.holdNextSend();
    harness.input("#prompt", "Continue while the window opens");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.emitServerEvent({
      type: "assistant_delta",
      sessionId: "session-1",
      sendId: harness.sendIds[0],
      delta: "Already responding.",
    });
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.deepEqual(layout.writes, []);
    assert.equal(harness.flushAnimationFrames(), 0);
    layout.height = 500;
    notifyWindowLayout(harness);
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(layout.top, 2700);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (harness.sendIds.length) harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});
