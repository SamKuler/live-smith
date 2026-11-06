import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

interface PendingAnimation {
  target: HTMLElement;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel(): void;
}

async function motionHarness() {
  const animations: PendingAnimation[] = [];
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state, undefined, {
    beforeParse(window) {
      window.HTMLElement.prototype.animate = function () {
        const animation: PendingAnimation = {
          target: this,
          onfinish: null,
          oncancel: null,
          cancel() { this.oncancel?.(); },
        };
        animations.push(animation);
        return animation as unknown as Animation;
      };
    },
  });
  return { h, animations, latest: (id: string) => animations.findLast((animation) => animation.target.id === id)! };
}

test("closing the Inspector immediately releases focus and interaction while its exit is pending", async () => {
  const { h, latest } = await motionHarness();
  try {
    h.click("#settingsButton");
    const inspector = h.document.getElementById("inspectorPane")!;
    const prompt = h.document.getElementById("prompt")!;
    assert.ok(latest("inspectorPane"));
    latest("inspectorPane").onfinish?.();
    inspector.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!.focus();
    h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const exit = latest("inspectorPane");
    const lateFinish = exit.onfinish;
    assert.equal(inspector.hidden, true);
    assert.equal(inspector.hasAttribute("inert"), true);
    assert.equal(inspector.getAttribute("aria-hidden"), "true");
    assert.equal(h.document.getElementById("chatPage")!.hasAttribute("inert"), false);
    assert.equal(h.document.activeElement?.id, "settingsButton");
    prompt.focus();
    assert.equal(h.document.activeElement, prompt);

    h.click("#settingsButton");
    assert.equal(inspector.hidden, false);
    assert.equal(inspector.hasAttribute("inert"), false);
    assert.equal(inspector.hasAttribute("aria-hidden"), false);
    lateFinish?.();
    assert.equal(inspector.hidden, false, "an old exit must not close the reopened Inspector");
    latest("inspectorPane").onfinish?.();
    assert.equal(inspector.hidden, false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a collapsing Session list stays isolated through view synchronization and can reopen immediately", async () => {
  const { h, latest } = await motionHarness();
  try {
    h.document.getElementById("sessionSearch")!.focus();
    h.click("#sessionsToggleButton");
    const sessions = h.document.getElementById("sessionsPane")!;
    assert.ok(latest("sessionsPane"));
    const lateFinish = latest("sessionsPane").onfinish;
    assert.equal(sessions.hidden, true);
    assert.equal(sessions.hasAttribute("inert"), true);
    assert.equal(h.document.activeElement?.id, "sessionsToggleButton");
    h.click("#settingsButton");
    assert.equal(sessions.hasAttribute("inert"), true);
    h.click("#sessionsToggleButton");
    assert.equal(sessions.hidden, false);
    assert.equal(sessions.hasAttribute("inert"), false);
    lateFinish?.();
    assert.equal(sessions.hidden, false);
    latest("sessionsPane").onfinish?.();
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Inspector fields keep IME candidate Escape until composition ends", async () => {
  const { h } = await motionHarness();
  try {
    h.click("#briefShortcut");
    const input = h.document.getElementById("creativeBrief")!;
    const inspector = h.document.getElementById("inspectorPane")!;
    input.focus();
    input.dispatchEvent(new h.window.CompositionEvent("compositionstart", { bubbles: true }));
    const candidateEscape = new h.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true });
    input.dispatchEvent(candidateEscape);
    assert.equal(candidateEscape.defaultPrevented, false);
    assert.equal(inspector.hidden, false);
    assert.equal(h.document.activeElement, input);
    input.dispatchEvent(new h.window.CompositionEvent("compositionend", { bubbles: true }));
    const closeEscape = new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(closeEscape);
    assert.equal(closeEscape.defaultPrevented, true);
    assert.equal(inspector.hidden, true);
    assert.equal(h.document.activeElement?.id, "settingsButton");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
