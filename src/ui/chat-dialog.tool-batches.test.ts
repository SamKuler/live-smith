import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function toolEvent(
  id: string,
  kind: "tool_call" | "tool_result",
  name: string,
  content: string,
) {
  return {
    id,
    kind,
    name,
    content,
    createdAt: `2026-08-31T00:00:0${id.at(-1) ?? "0"}.000Z`,
  };
}

test("one tool step starts in a collapsed activity group", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent(
      "event-tool-1",
      "tool_call",
      "inspect_song_info",
      "Inspect the current Song",
    ),
    toolEvent(
      "event-tool-2",
      "tool_result",
      "inspect_song_info",
      "Song observed",
    ),
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      "#timeline > .timeline-activity-group",
    );
    assert.ok(group);
    assert.equal(group.open, false);
    assert.equal(
      group.querySelector(":scope > summary .timeline-activity-title")?.textContent,
      "Inspect song info",
    );
    assert.equal(
      group.querySelector(":scope > summary .timeline-activity-excerpt")?.textContent,
      "Song observed",
    );
    assert.match(
      group.querySelector(":scope > summary")?.getAttribute("aria-label") ?? "",
      /1 activity step in history/,
    );
    harness.click(".timeline-activity-group > summary");
    const step = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.ok(step);
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_call"),
      null,
    );
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_result"),
      null,
    );
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-activity-step"),
      null,
    );
    assert.doesNotMatch(step.textContent ?? "", /tool call/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("one unsuccessful tool step opens its group and detail without a legacy card", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent(
      "event-tool-1",
      "tool_call",
      "inspect_song_info",
      "Inspect the current Song",
    ),
    toolEvent(
      "event-tool-2",
      "tool_result",
      "inspect_song_info",
      'Tool call "inspect_song_info" has invalid arguments:\nCorrect the fields.',
    ),
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      "#timeline > .timeline-activity-group",
    );
    const step = group?.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.equal(group?.open, true);
    assert.equal(step?.dataset.status, "stopped");
    assert.equal(step?.open, true);
    assert.match(step?.textContent ?? "", /invalid arguments/);
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_result"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("activity keeps one collapsed group while a second tool step arrives", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const initialGroup = harness.document.querySelector<HTMLDetailsElement>(
      "#timeline > .timeline-activity-group",
    );
    const initialSummary = initialGroup?.querySelector<HTMLElement>(
      ":scope > summary",
    );
    assert.equal(initialGroup?.dataset.activityGroupId, "event-tool-1");
    assert.equal(initialGroup?.open, false);
    assert.ok(initialSummary);
    assert.equal(
      initialGroup?.querySelector(":scope > summary .timeline-activity-excerpt")
        ?.textContent,
      "Bass observed",
    );
    initialSummary.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-3",
        "tool_call",
        "inspect_track",
        "Inspect Lead",
      ),
    });

    let group = harness.document.querySelector<HTMLDetailsElement>(
      "#timeline > .timeline-activity-group",
    );
    assert.equal(group?.dataset.activityGroupId, "event-tool-1");
    assert.equal(group?.open, false);
    assert.equal(
      harness.document.activeElement,
      group?.querySelector(":scope > summary"),
    );
    assert.equal(
      harness.document.querySelectorAll("#timeline > .timeline-activity-group").length,
      1,
    );
    assert.equal(
      group?.querySelector(":scope > summary .timeline-activity-excerpt")
        ?.textContent,
      "Inspect Lead",
    );

    harness.click(".timeline-activity-group > summary");
    assert.equal(
      group?.querySelectorAll(":scope > .timeline-activity-group-items > .timeline-activity-step")
        .length,
      2,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-4",
        "tool_result",
        "inspect_track",
        "Lead observed",
      ),
    });

    group = harness.document.querySelector<HTMLDetailsElement>(
      "#timeline > .timeline-activity-group",
    );
    assert.equal(group?.open, true);
    assert.equal(
      group?.querySelector(":scope > summary .timeline-activity-excerpt")
        ?.textContent,
      "Lead observed",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("each consecutive tool run stays in one group with the latest step in its summary", async () => {
  const state = stateFixture();
  state.events = [
    {
      id: "event-user",
      kind: "user",
      content: "Inspect the arrangement.",
      createdAt: "2026-08-31T00:00:00.000Z",
    },
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "inspect_track", "Inspect Lead"),
    toolEvent("event-tool-4", "tool_result", "inspect_track", "Lead observed"),
    {
      id: "event-assistant",
      kind: "assistant",
      content: "I found the two parts.",
      createdAt: "2026-08-31T00:00:05.000Z",
    },
    toolEvent("event-tool-5", "tool_call", "inspect_song_info", "Inspect Song"),
    toolEvent("event-tool-6", "tool_result", "inspect_song_info", "Song observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    const groups = harness.document.querySelectorAll<HTMLDetailsElement>(
      "#timeline > details.timeline-activity-group",
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.open, false);
    assert.equal(
      groups[0]?.querySelector(
        ":scope > summary .timeline-activity-title",
      )?.textContent,
      "Inspect track",
    );
    assert.equal(
      groups[0]?.querySelector(
        ":scope > summary .timeline-activity-excerpt",
      )?.textContent,
      "Lead observed",
    );
    harness.click(
      '.timeline-activity-group[data-activity-group-id="event-tool-1"] > summary',
    );
    assert.equal(groups[0]?.open, true);
    const activitySteps = groups[0]?.querySelectorAll(
      ".timeline-activity-step",
    );
    assert.equal(activitySteps?.length, 2);
    assert.equal(
      activitySteps?.[0]?.querySelector(".timeline-activity-title")?.textContent,
      "Inspect track",
    );
    assert.equal(
      activitySteps?.[0]?.querySelector(".timeline-activity-excerpt")?.textContent,
      "Bass observed",
    );
    assert.deepEqual(
      [...(groups[0]?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])]
        .map((item) => item.dataset.eventId),
      ["event-tool-1", "event-tool-2", "event-tool-3", "event-tool-4"],
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(
        "#timeline > .timeline-item[data-event-id]",
      )].map((item) => item.dataset.eventId),
      ["event-user", "event-assistant"],
    );
    const standaloneGroup = groups[1];
    assert.equal(
      standaloneGroup?.querySelector(
        ":scope > summary .timeline-activity-title",
      )?.textContent,
      "Inspect song info",
    );
    assert.equal(
      standaloneGroup?.querySelector(
        ":scope > summary .timeline-activity-excerpt",
      )?.textContent,
      "Song observed",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("compact activity hides empty arguments and surfaces an apply message", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_live_set", "{}"),
    toolEvent(
      "event-tool-2",
      "tool_result",
      "inspect_live_set",
      "Live Set has 4 regular tracks.",
    ),
    toolEvent(
      "event-tool-3",
      "tool_call",
      "apply_live_actions",
      JSON.stringify({
        message: "Initialize future bass project",
        actions: [{ type: "set_tempo", tempo: 150 }],
      }),
    ),
    {
      id: "event-apply-requested",
      kind: "apply_requested",
      content: "Initialize future bass project\n\nActions:\n1. Set tempo to 150 BPM.",
      createdAt: "2026-08-31T00:00:04.000Z",
    },
    {
      id: "event-auto-approved",
      kind: "apply_auto_approved",
      content: "1 change · Accept Everything\nAutomatic approval.",
      createdAt: "2026-08-31T00:00:05.000Z",
    },
    {
      id: "event-apply-result",
      kind: "apply_result",
      content: "Applied:\n- Set tempo to 150 BPM.",
      createdAt: "2026-08-31T00:00:06.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    harness.click(".timeline-activity-group > summary");
    const inspectStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    const applyStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(
      inspectStep?.querySelector(".timeline-activity-excerpt")?.textContent,
      "Live Set has 4 regular tracks.",
    );
    assert.equal(
      applyStep?.querySelector(".timeline-activity-title")?.textContent,
      "Applied 1 change",
    );
    assert.equal(
      applyStep?.querySelector(".timeline-activity-excerpt")?.textContent,
      "Initialize future bass project",
    );
    assert.doesNotMatch(
      applyStep?.querySelector("summary")?.textContent ?? "",
      /\{"message"/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a rejected tool result opens inside compact activity", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "inspect_track", "Inspect Lead"),
    toolEvent("event-tool-4", "tool_result", "inspect_track", "Lead observed"),
    toolEvent(
      "event-tool-5",
      "tool_result",
      "apply_live_actions",
      'Tool call "apply_live_actions" has invalid arguments:\nCorrect the fields.',
    ),
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.equal(group?.open, true);
    const rejectedStep = group?.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-5"]',
    );
    assert.equal(rejectedStep?.open, true);
    assert.match(rejectedStep?.textContent ?? "", /invalid arguments/);
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_result"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("tool activity keeps its expanded state and summary focus across live updates", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "inspect_track", "Inspect Lead"),
    toolEvent("event-tool-4", "tool_result", "inspect_track", "Lead observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const summary = group?.querySelector<HTMLElement>(":scope > summary");
    assert.ok(group);
    assert.ok(summary);
    harness.click(".timeline-activity-group > summary");
    assert.equal(group.open, true);
    summary.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-4",
        "tool_result",
        "inspect_track",
        "Lead observed with updated details",
      ),
    });

    const renderedGroup = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.equal(renderedGroup?.open, true);
    assert.equal(
      harness.document.activeElement,
      renderedGroup?.querySelector(":scope > summary"),
    );
    assert.match(
      renderedGroup?.querySelector('[data-event-id="event-tool-4"]')
        ?.textContent ?? "",
      /updated details/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a live terminal failure opens a pending step once and preserves a later user close", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const initialStep = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    const initialGroup = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.equal(initialGroup?.open, false);
    assert.match(
      initialGroup?.querySelector(":scope > summary")?.getAttribute("aria-label") ?? "",
      /^In progress: .*1 activity step in history$/,
    );
    assert.equal(initialStep?.dataset.status, "pending");
    assert.equal(initialStep?.open, false);
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    assert.ok(prompt);
    prompt.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-2",
        "tool_result",
        "inspect_track",
        'Tool call "inspect_track" has invalid arguments:\nFirst rejection.',
      ),
    });

    let renderedStep = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.equal(renderedStep?.dataset.status, "stopped");
    assert.equal(renderedStep?.open, true);
    assert.equal(
      harness.document.querySelector<HTMLDetailsElement>(
        ".timeline-activity-group",
      )?.open,
      true,
    );
    assert.equal(harness.document.activeElement, prompt);
    harness.click('[data-activity-step-id="event-tool-1"] > summary');
    assert.equal(renderedStep?.open, false);

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-2",
        "tool_result",
        "inspect_track",
        'Tool call "inspect_track" has invalid arguments:\nUpdated rejection.',
      ),
    });

    renderedStep = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.equal(renderedStep?.open, false);
    assert.match(renderedStep?.textContent ?? "", /Updated rejection/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a live grouped failure opens the group once and preserves a later user close", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_call", "inspect_track", "Inspect Lead"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    const initialGroup = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.equal(initialGroup?.open, false);
    assert.equal(
      initialGroup?.querySelector(
        ":scope > summary .timeline-activity-excerpt",
      )?.textContent,
      "Inspect Lead",
    );
    assert.match(
      initialGroup?.querySelector(":scope > summary")?.getAttribute("aria-label") ?? "",
      /2 activity steps in history/,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-3",
        "tool_result",
        "inspect_track",
        'Tool call "inspect_track" has invalid arguments:\nFirst rejection.',
      ),
    });

    let renderedGroup = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const failedStep = renderedGroup?.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-2"]',
    );
    assert.equal(renderedGroup?.open, true);
    assert.equal(failedStep?.open, true);
    harness.click(".timeline-activity-group > summary");
    assert.equal(renderedGroup?.open, false);

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-3",
        "tool_result",
        "inspect_track",
        'Tool call "inspect_track" has invalid arguments:\nUpdated rejection.',
      ),
    });

    renderedGroup = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.equal(renderedGroup?.open, false);
    assert.match(renderedGroup?.textContent ?? "", /Updated rejection/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a focused history step stays visible when its activity group grows", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.click(".timeline-activity-group > summary");
    const step = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    const summary = step?.querySelector<HTMLElement>("summary");
    assert.equal(step?.open, false);
    assert.ok(summary);
    summary.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-3",
        "tool_call",
        "inspect_track",
        "Inspect Lead",
      ),
    });

    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const renderedStep = group?.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.equal(group?.open, true);
    assert.equal(renderedStep?.open, false);
    assert.equal(
      harness.document.activeElement,
      renderedStep?.querySelector("summary"),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a growing activity group does not hide an expanded history step", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.click(".timeline-activity-group > summary");
    const focusedEvent = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    const focusedSummary = focusedEvent?.querySelector<HTMLElement>("summary");
    assert.ok(focusedEvent);
    assert.ok(focusedSummary);
    focusedEvent.open = true;
    focusedSummary.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-3",
        "tool_call",
        "inspect_track",
        "Inspect Lead",
      ),
    });

    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const renderedStep = group?.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-1"]',
    );
    assert.equal(group?.open, true);
    assert.equal(renderedStep?.open, true);
    assert.equal(
      harness.document.activeElement,
      renderedStep?.querySelector("summary"),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("an expanded batch preserves focus on an individual tool event", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "inspect_track", "Inspect Lead"),
    toolEvent("event-tool-4", "tool_result", "inspect_track", "Lead observed"),
  ];

  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Continue checking");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.click(".timeline-activity-group > summary");
    const focusedStep = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    const focusedSummary = focusedStep?.querySelector<HTMLElement>("summary");
    assert.ok(focusedStep);
    assert.ok(focusedSummary);
    focusedStep.open = true;
    focusedSummary.focus();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: toolEvent(
        "event-tool-4",
        "tool_result",
        "inspect_track",
        "Lead observed with updated details",
      ),
    });

    const renderedStep = harness.document.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(
      harness.document.activeElement,
      renderedStep?.querySelector("summary"),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a rejected Apply opens its compact activity detail", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent(
      "event-tool-3",
      "tool_call",
      "apply_live_actions",
      JSON.stringify({
        message: "Replace the Bass clip",
        actions: [{ type: "delete_clip", trackIndex: 0, clipIndex: 0 }],
      }),
    ),
    {
      id: "event-tool-4",
      kind: "tool_result",
      content: "This Session's Edit Scope does not allow the requested change.\nNo Live changes from this plan were applied.",
      createdAt: "2026-08-31T00:00:04.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    assert.equal(
      group.querySelector(
        ":scope > summary .timeline-activity-title",
      )?.textContent,
      "Apply failed",
    );
    const applyStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(applyStep?.dataset.status, "failed");
    assert.equal(
      applyStep?.querySelector(".timeline-activity-title")?.textContent,
      "Apply failed",
    );
    assert.equal(group.open, true);
    assert.equal(applyStep?.open, true);
    assert.match(applyStep?.textContent ?? "", /Edit Scope/);
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_result"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unsuccessful Apply result ends the compact step without hiding the result", async () => {
  const terminalContents = [
    "User cancelled the proposed Live actions. Do not claim they were applied.",
    "Live action plan could not complete its first operation.\nNo operations from this plan were completed.",
    "Live action plan partially completed after 1 operation(s).\nCompleted: Set tempo to 128 BPM.",
  ];
  const expectedStatuses = ["stopped", "failed", "partial"];

  for (const [index, terminalContent] of terminalContents.entries()) {
    const state = stateFixture();
    state.events = [
      toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
      toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
      toolEvent(
        "event-tool-3",
        "tool_call",
        "apply_live_actions",
        JSON.stringify({
          message: "Update the Bass clip",
          actions: [{ type: "set_tempo", tempo: 128 }],
        }),
      ),
      {
        id: `event-apply-result-${index}`,
        kind: "apply_result",
        content: terminalContent,
        createdAt: `2026-08-31T00:00:0${index + 4}.000Z`,
      },
    ];

    const harness = await createDialogHarness(state);
    try {
      const group = harness.document.querySelector<HTMLDetailsElement>(
        ".timeline-activity-group",
      );
      assert.ok(group);
      assert.equal(
        group.querySelector<HTMLDetailsElement>(
          '[data-activity-step-id="event-tool-3"]',
        )?.getAttribute("data-status"),
        expectedStatuses[index],
      );
      const applyStep = group.querySelector<HTMLDetailsElement>(
        '[data-activity-step-id="event-tool-3"]',
      );
      assert.equal(group.open, true);
      assert.equal(applyStep?.open, true);
      assert.match(applyStep?.textContent ?? "", new RegExp(
        terminalContent.split("\n")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ));
      assert.equal(
        harness.document.querySelector("#timeline > .timeline-item.apply_result"),
        null,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("recovery resolution pairs its Apply result with the recovery call", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "resolve_live_recovery", "{}"),
    {
      id: "event-apply-result",
      kind: "apply_result",
      content: "Kept the completed Live changes and closed the unfinished operation.",
      createdAt: "2026-08-31T00:00:04.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    assert.equal(
      group.querySelector(
        ":scope > summary .timeline-activity-title",
      )?.textContent,
      "Resolve live recovery",
    );
    const recoveryStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(recoveryStep?.dataset.status, "complete");
    assert.equal(
      recoveryStep?.querySelector(".timeline-activity-title")?.textContent,
      "Resolve live recovery",
    );
    assert.equal(
      harness.document.querySelector(
        '#timeline > [data-event-id="event-apply-result"]',
      ),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a terminal error opens inside its compact activity step", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent(
      "event-tool-3",
      "tool_call",
      "apply_live_actions",
      JSON.stringify({
        message: "Update the Bass clip",
        actions: [{ type: "set_tempo", tempo: 128 }],
      }),
    ),
    {
      id: "event-apply-requested",
      kind: "apply_requested",
      content: "Update the Bass clip\n\nActions:\n1. Set tempo to 128 BPM.",
      createdAt: "2026-08-31T00:00:04.000Z",
    },
    {
      id: "event-error",
      kind: "error",
      content: "Live action preflight failed before execution.",
      createdAt: "2026-08-31T00:00:05.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    const applyStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(applyStep?.dataset.status, "failed");
    assert.equal(
      applyStep?.querySelector(".timeline-activity-title")?.textContent,
      "Apply failed",
    );
    assert.equal(group.open, true);
    assert.equal(applyStep?.open, true);
    assert.match(applyStep?.textContent ?? "", /preflight failed/);
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-error"]').length,
      1,
    );
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.error"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a declined recovery opens its compact activity detail", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent("event-tool-3", "tool_call", "resolve_live_recovery", "{}"),
    {
      id: "event-tool-4",
      kind: "tool_result",
      content: "The user kept the unfinished operation active. No Live changes were made.",
      createdAt: "2026-08-31T00:00:04.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    const recoveryStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(recoveryStep?.dataset.status, "stopped");
    assert.equal(
      recoveryStep?.querySelector(".timeline-activity-title")?.textContent,
      "Resolve live recovery",
    );
    assert.equal(group.open, true);
    assert.equal(recoveryStep?.open, true);
    assert.match(recoveryStep?.textContent ?? "", /kept the unfinished operation/);
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-tool-4"]').length,
      1,
    );
    assert.equal(
      harness.document.querySelector("#timeline > .timeline-item.tool_result"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("successful Apply details cannot be mistaken for a stopped result", async () => {
  const state = stateFixture();
  state.events = [
    toolEvent("event-tool-1", "tool_call", "inspect_track", "Inspect Bass"),
    toolEvent("event-tool-2", "tool_result", "inspect_track", "Bass observed"),
    toolEvent(
      "event-tool-3",
      "tool_call",
      "apply_live_actions",
      JSON.stringify({
        message: "Rename the Bass track",
        actions: [{ type: "rename_track", trackIndex: 0, name: "Cancelled" }],
      }),
    ),
    {
      id: "event-apply-result",
      kind: "apply_result",
      content: [
        "Applied:",
        '- Renamed track to "Cancelled".',
        '- Added note: "No operations from this plan were completed".',
      ].join("\n"),
      createdAt: "2026-08-31T00:00:04.000Z",
    },
  ];

  const harness = await createDialogHarness(state);
  try {
    const group = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    assert.ok(group);
    assert.equal(
      group.querySelector(
        '[data-activity-step-id="event-tool-3"]',
      )?.getAttribute("data-status"),
      "complete",
    );
    assert.equal(
      harness.document.querySelector(
        '#timeline > [data-event-id="event-apply-result"]',
      ),
      null,
    );
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-apply-result"]').length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
