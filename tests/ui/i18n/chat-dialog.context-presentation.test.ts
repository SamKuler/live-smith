import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("context uses the Session object's localized availability and preserves its authored name", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "zh-CN";
  state.contextSummary = 'The Live object for this Session is unavailable: Bass / Verse. No default Live target is available.';
  state.liveContext = { sessionId: state.activeSessionId, availability: "unavailable", label: "Bass / Verse" };
  const h = await createDialogHarness(state);
  try {
    assert.equal(h.document.querySelector("#context .context-title")!.textContent, "Bass / Verse");
    assert.match(h.document.querySelector("#context .context-empty")!.textContent!, /无法使用/);
    assert.equal(h.document.querySelector("#context pre"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("context shows structured selection coordinates and keeps original observation text in an explicit disclosure", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "zh-CN";
  state.contextSummary = 'Arrangement selection\nTrack "Bass / Verse", beats=4–12';
  state.liveContext = { sessionId: state.activeSessionId, availability: "available", value: {
    origin: "arrangement-selection", objectKind: "track", title: "Arrangement selection", details: [],
    range: { coordinate: "arrangement-beats", start: 4, end: 12 },
  } };
  const h = await createDialogHarness(state);
  try {
    assert.equal(h.document.querySelector("#context .context-title")!.textContent, "编曲选区");
    assert.equal(h.document.querySelector("#liveContextTitle")!.textContent, "编曲选区");
    assert.match(h.document.querySelector("#context .context-details")!.textContent!, /4.*12/);
    const details = h.document.querySelector<HTMLDetailsElement>("#context details")!;
    assert.equal(details.open, false);
    details.open = true;
    assert.equal(details.querySelector("pre")!.textContent, state.contextSummary);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
