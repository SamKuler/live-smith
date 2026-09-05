import assert from "node:assert/strict";
import test from "node:test";

import type { LiveContextPresentation } from "../live/context.js";
import {
  commandCalls,
  createDialogHarness,
  jsonCalls,
  pendingAudio,
  stateFixture,
} from "./chat-dialog.test-harness.js";

const contexts: LiveContextPresentation[] = [
  { origin: "object", objectKind: "midi-clip", title: "Bass MIDI", details: ["Session", 'Track "Bass"'] },
  { origin: "object", objectKind: "audio-clip", title: "Vocal audio", details: ["Arrangement"] },
  { origin: "object", objectKind: "track", title: "Drums", details: ["MIDI track"] },
  { origin: "object", objectKind: "device", title: "Filter", details: ['Track "Bass"'] },
  { origin: "arrangement-selection", objectKind: "other", title: "Arrangement selection", details: ["Bass", "Drums"], range: { coordinate: "arrangement-beats", start: 16, end: 32 } },
  { origin: "clip-slot-selection", objectKind: "other", title: "Clip slot selection", details: ["Bass slot 1", "Lead slot 2"] },
];

for (const context of contexts) {
  test(`${context.title} keeps one direct conversation entry with its own context`, async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.events = [];
    state.liveContext = { sessionId: state.activeSessionId, availability: "available", value: context };
    state.pendingAttachments = [pendingAudio("attachment-reference", "reference.wav")];
    const harness = await createDialogHarness(state);
    try {
      assert.equal(harness.document.querySelector("#writeTargetButton"), null);
      assert.equal(harness.document.querySelectorAll("#timeline button").length, 0);
      assert.ok(harness.document.querySelector("#timeline .empty"));
      const summary = harness.document.querySelector<HTMLButtonElement>("#liveContextSummaryButton")!;
      assert.equal(summary.hidden, false);
      assert.ok(summary.textContent?.includes(context.title));
      for (const detail of context.details) assert.ok(summary.getAttribute("aria-label")?.includes(detail));
      harness.input("#prompt", "Keep the main idea; adjust the balance and explain the changes.");
      const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt")!;
      prompt.focus();
      harness.click("#liveContextSummaryButton");
      await harness.settle();
      assert.equal(harness.document.querySelector<HTMLElement>("#contextPanel")!.hidden, false);
      assert.equal(prompt.value, "Keep the main idea; adjust the balance and explain the changes.");
      assert.equal(harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length, 1);
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(jsonCalls(harness, "/send"), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("a direct request sends only prompt and Session ID without a task or target command", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Help me understand the arrangement and suggest what to change next.");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/send").map(({ body }) => body), [{
      prompt: "Help me understand the arrangement and suggest what to change next.",
      sessionId: state.activeSessionId,
    }]);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
