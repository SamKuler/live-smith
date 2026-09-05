import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";

test("scroll visibility is owned by each scrolled surface and scrollend hides only that surface", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const surfaces = ["#sessions", "#prompt", ".status", "#agentPanel", "#appPanel", "#contextPanel"].map(selector => {
      const element = harness.document.querySelector<HTMLElement>(selector)!;
      assert.ok(element);
      Object.defineProperty(element, "onscrollend", { configurable: true, value: null });
      return element;
    });
    surfaces[1]!.focus();
    for (const surface of surfaces) surface.dispatchEvent(new harness.window.Event("scroll"));
    assert.ok(surfaces.every(surface => surface.classList.contains("is-scrolling")));
    assert.equal(harness.document.querySelector("#timeline")!.classList.contains("is-scrolling"), false);
    surfaces[0]!.dispatchEvent(new harness.window.Event("scrollend"));
    assert.equal(surfaces[0]!.classList.contains("is-scrolling"), false);
    assert.ok(surfaces.slice(1).every(surface => surface.classList.contains("is-scrolling")));
    for (const surface of surfaces.slice(1)) surface.dispatchEvent(new harness.window.Event("scrollend"));
    assert.ok(surfaces.every(surface => !surface.classList.contains("is-scrolling")));
    assert.equal(harness.document.activeElement, surfaces[1]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("non-timeline scroll surfaces hide after an idle interval without scrollend support", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const sessions = harness.document.querySelector<HTMLElement>("#sessions")!;
    Object.defineProperty(sessions, "onscrollend", { configurable: true, value: undefined });
    sessions.dispatchEvent(new harness.window.Event("scroll"));
    assert.equal(sessions.classList.contains("is-scrolling"), true);
    await new Promise(resolve => harness.window.setTimeout(resolve, 700));
    assert.equal(sessions.classList.contains("is-scrolling"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
