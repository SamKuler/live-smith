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

test("consecutive tool activity collapses as one batch only when it becomes noisy", async () => {
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
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.open, false);
    assert.equal(
      groups[0]?.querySelector(":scope > summary")?.textContent,
      "Activity · 2 steps",
    );
    harness.click(".timeline-activity-group > summary");
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
      ["event-user", "event-assistant", "event-tool-5", "event-tool-6"],
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

test("a rejected tool result stays visible outside collapsed activity", async () => {
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
    assert.equal(group?.open, false);
    assert.equal(
      harness.document.querySelector<HTMLDetailsElement>(
        '#timeline > [data-event-id="event-tool-5"]',
      )?.open,
      true,
    );
    assert.match(
      harness.document.querySelector('[data-event-id="event-tool-5"]')?.textContent ?? "",
      /invalid arguments/,
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

test("a growing tool run does not hide an expanded event when it becomes a batch", async () => {
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

    const focusedEvent = harness.document.querySelector<HTMLDetailsElement>(
      '[data-event-id="event-tool-1"]',
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

test("a rejected Apply closes its activity step and stays visible", async () => {
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
    assert.equal(group.dataset.status, "complete");
    assert.equal(
      group.querySelector(":scope > summary")?.textContent,
      "Activity · 2 steps",
    );
    const applyStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(applyStep?.dataset.status, "stopped");
    const visibleResult = harness.document.querySelector<HTMLDetailsElement>(
      '#timeline > [data-event-id="event-tool-4"]',
    );
    assert.equal(visibleResult?.open, true);
    assert.match(visibleResult?.textContent ?? "", /Edit Scope/);
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
      assert.equal(group.dataset.status, "complete");
      assert.equal(
        group.querySelector(
          '[data-activity-step-id="event-tool-3"]',
        )?.getAttribute("data-status"),
        "stopped",
      );
      const visibleResult = harness.document.querySelector<HTMLDetailsElement>(
        `#timeline > [data-event-id="event-apply-result-${index}"]`,
      );
      assert.equal(visibleResult?.open, true);
      assert.match(visibleResult?.textContent ?? "", new RegExp(
        terminalContent.split("\n")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ));
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
      group.querySelector(":scope > summary")?.textContent,
      "Activity · 2 steps",
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

test("a terminal error closes the active step and remains top-level", async () => {
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
    assert.equal(group.dataset.status, "complete");
    assert.equal(
      group.querySelector(
        '[data-activity-step-id="event-tool-3"]',
      )?.getAttribute("data-status"),
      "stopped",
    );
    const error = harness.document.querySelector<HTMLDetailsElement>(
      '#timeline > [data-event-id="event-error"]',
    );
    assert.equal(error?.open, true);
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-error"]').length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a declined recovery closes its step and keeps the result visible", async () => {
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
    assert.equal(group.dataset.status, "complete");
    const recoveryStep = group.querySelector<HTMLDetailsElement>(
      '[data-activity-step-id="event-tool-3"]',
    );
    assert.equal(recoveryStep?.dataset.status, "stopped");
    assert.equal(
      recoveryStep?.querySelector(".timeline-activity-title")?.textContent,
      "Resolve live recovery",
    );
    const visibleResult = harness.document.querySelector<HTMLDetailsElement>(
      '#timeline > [data-event-id="event-tool-4"]',
    );
    assert.equal(visibleResult?.open, true);
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-tool-4"]').length,
      1,
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
    assert.equal(group.dataset.status, "complete");
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
