import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  waitForCondition,
  type DialogHarness,
} from "./chat-dialog.test-harness.js";

function initialState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.liveContext = {
    sessionId: state.activeSessionId,
    availability: "available",
    value: {
      origin: "object",
      objectKind: "midi-clip",
      title: "Bass <take>",
      details: ["Arrangement", "Track: Bass"],
      range: { coordinate: "arrangement-beats", start: 64, end: 80 },
    },
  };
  return state;
}

function summary(harness: DialogHarness): HTMLButtonElement {
  const button = harness.document.querySelector<HTMLButtonElement>("#liveContextSummaryButton");
  assert.ok(button);
  return button;
}

async function refreshContext(harness: DialogHarness, state: ReturnType<typeof stateFixture>): Promise<void> {
  const previousRequests = harness.calls.filter((call) => call.path.startsWith("/state")).length;
  harness.setServerState(state);
  harness.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId });
  await waitForCondition(
    () => harness.calls.filter((call) => call.path.startsWith("/state")).length > previousRequests,
    "Expected an authoritative Session refresh",
  );
  await harness.settle();
}

test("the Session context summary renders long object names and details as text with a beat range", async () => {
  const state = initialState();
  assert.equal(state.liveContext.availability, "available");
  const title = "低音 <take> & ".repeat(24);
  state.liveContext.value.title = title;
  state.liveContext.value.details = ["Arrangement", "Track: <em>低音</em>"];
  const harness = await createDialogHarness(state);
  try {
    const button = summary(harness);
    assert.equal(button.hidden, false);
    assert.ok(button.textContent?.includes(title));
    assert.equal(button.querySelector("take, em"), null);
    assert.match(button.textContent ?? "", /beats\s+64\s*[–-]\s*80/i);
    assert.ok(button.getAttribute("aria-label")?.includes("Track: <em>低音</em>"));
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the native summary button opens Context and a later refresh preserves Inspector focus", async () => {
  const state = initialState();
  state.contextSummary = "Observed Bass clip with notes and track details.";
  const harness = await createDialogHarness(state);
  try {
    const button = summary(harness);
    assert.equal(button.type, "button");
    assert.equal(button.disabled, false);
    assert.ok(button.tabIndex >= 0);
    button.focus();
    assert.equal(harness.document.activeElement, button);
    // Native keyboard activation produces a click with detail 0 in the host.
    button.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, detail: 0 }));
    await harness.settle();
    const panel = harness.document.querySelector<HTMLElement>("#contextPanel");
    assert.ok(panel);
    assert.equal(panel.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#inspectorPane")?.hidden, false);
    assert.equal(harness.document.querySelector("#contextTab")?.getAttribute("aria-selected"), "true");
    assert.ok(panel.textContent?.includes(state.contextSummary));
    panel.focus();
    const refreshed = cloneState(state);
    refreshed.contextSummary = "Refreshed details for the same Bass clip.";
    await refreshContext(harness, refreshed);
    assert.equal(harness.document.activeElement, panel);
    assert.ok(panel.textContent?.includes(refreshed.contextSummary));
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a multi-lane Arrangement summary retains its selection details and omits an unknown range", async () => {
  const state = initialState();
  state.liveContext = {
    sessionId: state.activeSessionId,
    availability: "available",
    value: {
      origin: "arrangement-selection",
      objectKind: "track",
      title: "Bass and Drums passage",
      details: ["Bass lane", "Drums lane"],
      range: { coordinate: "arrangement-beats", start: 0, end: 16 },
    },
  };
  const harness = await createDialogHarness(state);
  try {
    assert.ok(summary(harness).textContent?.includes("Bass and Drums passage"));
    assert.ok(summary(harness).getAttribute("aria-label")?.includes("Bass lane"));
    assert.ok(summary(harness).getAttribute("aria-label")?.includes("Drums lane"));
    assert.match(summary(harness).textContent ?? "", /beats\s+0\s*[–-]\s*16/i);
    const withoutRange = cloneState(state);
    assert.equal(withoutRange.liveContext.availability, "available");
    delete withoutRange.liveContext.value.range;
    await refreshContext(harness, withoutRange);
    assert.ok(summary(harness).textContent?.includes("Bass and Drums passage"));
    assert.doesNotMatch(summary(harness).textContent ?? "", /beats/i);
    assert.doesNotMatch(summary(harness).getAttribute("aria-label") ?? "", /beats/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unavailable projection replaces stale object details while keeping Context accessible", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  try {
    const unavailable = cloneState(state);
    unavailable.liveContext = {
      sessionId: state.activeSessionId,
      availability: "unavailable",
      label: "Opening selection is no longer available <details>",
    };
    unavailable.contextSummary = "A lane in this Session's opening selection was removed.";
    await refreshContext(harness, unavailable);
    assert.equal(summary(harness).hidden, false);
    assert.ok(summary(harness).textContent?.includes(unavailable.liveContext.label));
    assert.equal(summary(harness).querySelector("details"), null);
    assert.doesNotMatch(summary(harness).textContent ?? "", /Bass <take>|64|80/);
    harness.click("#liveContextSummaryButton");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLElement>("#contextPanel")?.hidden, false);
    assert.ok(harness.document.querySelector("#contextPanel")?.textContent?.includes(unavailable.contextSummary));
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a projection belonging to another Session stays hidden until matching authoritative context arrives", async () => {
  const state = initialState();
  state.liveContext.sessionId = "session-2";
  const harness = await createDialogHarness(state);
  try {
    assert.equal(summary(harness).hidden, true);
    const matching = initialState();
    await refreshContext(harness, matching);
    assert.equal(summary(harness).hidden, false);
    assert.ok(summary(harness).textContent?.includes("Bass <take>"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed old Session send response cannot replace the selected Session summary or draft", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  let held = false;
  try {
    harness.holdNextSend();
    held = true;
    harness.input("#prompt", "Inspect the Bass clip");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 1);
    const target = cloneState(state);
    target.activeSessionId = "session-2";
    target.contextSummary = "Observed Lead audio clip.";
    target.liveContext = {
      sessionId: target.activeSessionId,
      availability: "available",
      value: { origin: "object", objectKind: "audio-clip", title: "Lead audio", details: [] },
    };
    harness.setServerState(target);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.ok(summary(harness).textContent?.includes("Lead audio"));
    harness.input("#prompt", "Keep this next-session draft.");
    const terminal = cloneState(state);
    terminal.events = [{
      id: "bass-response", kind: "assistant", content: "Bass clip inspected.",
      createdAt: "2026-09-05T00:00:00.000Z",
    }];
    harness.setServerState(terminal);
    harness.releaseHeldSend();
    held = false;
    await harness.settle();
    assert.ok(summary(harness).textContent?.includes("Lead audio"));
    assert.doesNotMatch(summary(harness).textContent ?? "", /Bass <take>/);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value, "Keep this next-session draft.");
    assert.equal(harness.document.querySelector('[data-event-id="bass-response"]'), null);
    harness.click("#liveContextSummaryButton");
    assert.ok(harness.document.querySelector("#contextPanel")?.textContent?.includes(target.contextSummary));
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [
      { kind: "select_session", sessionId: "session-2" },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) harness.releaseHeldSend();
    harness.close();
  }
});

test("switching to an unavailable historical binding does not borrow the current object's matching name", async () => {
  const state = initialState();
  state.sessions[1]!.scope.label = "Bass <take>";
  const harness = await createDialogHarness(state);
  try {
    const target = cloneState(state);
    target.activeSessionId = "session-2";
    target.contextSummary = "This saved Session's original object can no longer be resolved.";
    target.liveContext = {
      sessionId: target.activeSessionId,
      availability: "unavailable",
      label: "Saved Bass context unavailable",
    };
    harness.setServerState(target);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.ok(summary(harness).textContent?.includes(target.liveContext.label));
    assert.doesNotMatch(summary(harness).textContent ?? "", /64|80/);
    harness.setServerState(state);
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.ok(summary(harness).textContent?.includes("Bass <take>"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const [label, corrupt] of [
  ["missing projection", () => undefined],
  ["unavailable projection carrying stale object data", (context) => ({ ...context, availability: "unavailable", label: "Gone" })],
  ["unknown selection origin", (context) => ({ ...context, value: { ...context.value, origin: "global-selection" } })],
  ["non-text details", (context) => ({ ...context, value: { ...context.value, details: [{ title: "Bass" }] } })],
  ["reversed beat range", (context) => ({ ...context, value: { ...context.value, range: { coordinate: "arrangement-beats", start: 80, end: 64 } } })],
  ["non-beat coordinates", (context) => ({ ...context, value: { ...context.value, range: { coordinate: "bars", start: 4, end: 8 } } })],
] satisfies Array<[string, (context: Extract<ReturnType<typeof stateFixture>["liveContext"], { availability: "available" }>) => unknown]>) {
  test(`a wire state with ${label} cannot replace rendered context`, async () => {
    const state = initialState();
    assert.equal(state.liveContext.availability, "available");
    const harness = await createDialogHarness(state);
    try {
      const invalid = {
        ...state,
        contextSummary: "Rejected context must not reach the Inspector.",
        liveContext: corrupt(state.liveContext),
      };
      await refreshContext(harness, invalid as ReturnType<typeof stateFixture>);
      assert.ok(summary(harness).textContent?.includes("Bass <take>"));
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, true);
      harness.click("#liveContextSummaryButton");
      assert.ok(!harness.document.querySelector("#contextPanel")?.textContent?.includes(invalid.contextSummary));
      await refreshContext(harness, {
        ...state,
        contextSummary: "A valid publication can still be applied.",
        liveContext: { ...state.liveContext, value: { ...state.liveContext.value, title: "Valid refreshed Bass" } },
      });
      assert.ok(summary(harness).textContent?.includes("Valid refreshed Bass"));
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}
