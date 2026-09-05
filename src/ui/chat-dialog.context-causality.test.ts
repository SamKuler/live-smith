import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import type { ChatBridgeState } from "./chat-state.js";
import {
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  waitForCondition,
  type DialogHarness,
} from "./chat-dialog.test-harness.js";

function initialState(): ChatBridgeState {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [];
  state.sessions[0]!.scope = { kind: "clip", identity: "101", label: "Original Bass" };
  state.sessionContinueTarget = { kind: "clip", label: "Original Bass" };
  state.contextSummary = "Observed the original Bass clip.";
  state.liveContext = {
    sessionId: state.activeSessionId,
    availability: "available",
    value: {
      origin: "object",
      objectKind: "midi-clip",
      title: "Original Bass",
      details: ["Arrangement", 'Track "Bass"'],
      range: { coordinate: "arrangement-beats", start: 64, end: 80 },
    },
  };
  return state;
}

function control<T extends HTMLElement = HTMLElement>(
  harness: DialogHarness,
  selector: string,
): T {
  const element = harness.document.querySelector<T>(selector);
  assert.ok(element, "Expected " + selector);
  return element;
}

test("an older same-Session send preserves newer context without blocking a subsequent fresh send", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  const snapshots: Array<{ path: string; state: ChatBridgeState }> = [];
  let releaseSendBody!: () => void;
  const delayedBody = new Promise<void>((resolve) => { releaseSendBody = resolve; });
  const fetch = harness.window.fetch;
  let sendBodyHeld = false;

  // Stall delivery only after the harness has built and stamped the actual
  // /send response. No synthetic terminal SSE or revision override is used.
  const fetchWithHeldSend: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const readJson = response.json.bind(response);
    const path = new URL(String(input)).pathname;
    response.json = async () => {
      const body = await readJson();
      if (["/send", "/command", "/state"].includes(path)) {
        snapshots.push({ path, state: path === "/send" ? body.state : body });
      }
      if (path === "/send" && !sendBodyHeld) {
        sendBodyHeld = true;
        await delayedBody;
      }
      return body;
    };
    return response;
  };
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: fetchWithHeldSend });

  try {
    assert.deepEqual(
      [state.bridgeStateRevision, state.bridgeStateCoveredThroughRevision],
      ["1", "0"],
    );
    const completed = cloneState(state);
    completed.events = [
      { id: "inspected-user", kind: "user", content: "Inspect the clip", createdAt: "2026-09-05T00:00:00.000Z" },
      { id: "inspected-result", kind: "assistant", content: "The clip was inspected.", createdAt: "2026-09-05T00:00:01.000Z" },
    ];
    harness.setServerState(completed);
    harness.input("#prompt", "Inspect the clip");
    harness.click("#sendButton");
    await waitForCondition(() => sendBodyHeld, "Expected the completed send's HTTP body to be held");

    const oldSend = snapshots.find((snapshot) => snapshot.path === "/send")!.state;
    assert.deepEqual(
      [oldSend.bridgeStateRevision, oldSend.bridgeStateCoveredThroughRevision],
      ["2", "1"],
    );
    assert.equal(harness.sendIds.length, 1);
    assert.ok(harness.sendIds[0]);
    assert.deepEqual(jsonCalls(harness, "/send").map(({ body }) => body), [
      { prompt: "Inspect the clip", sessionId: state.activeSessionId },
    ]);
    assert.equal(control(harness, "#sendButtonLabel").textContent, "Stop");

    // The send snapshot is already publication 2. This later command therefore
    // captures cut 2 and publishes 3, while the original HTTP body stays held.
    const newer = cloneState(completed);
    newer.contextSummary = "The bound Bass clip is unavailable.";
    newer.liveContext = { sessionId: state.activeSessionId, availability: "unavailable", label: "Unavailable Bass" };
    harness.setServerState(newer);
    harness.select("#approvalMode", "everything");
    await harness.settle();
    const commandState = snapshots.find((snapshot) => snapshot.path === "/command")!.state;
    assert.deepEqual(
      [commandState.bridgeStateRevision, commandState.bridgeStateCoveredThroughRevision],
      ["3", "2"],
    );
    assert.equal(control(harness, "#liveContextTitle").textContent, "Unavailable Bass");

    releaseSendBody();
    await waitForCondition(
      () => control(harness, "#sendButtonLabel").textContent === "Send",
      "Expected the correlated send response to settle its original request",
    );
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/state"), [], "The response must decode without fallback reconciliation");
    assert.deepEqual(harness.errors, []);
    assert.equal(control(harness, "#liveContextTitle").textContent, "Unavailable Bass");
    assert.equal(control(harness, "#liveContextLocation").textContent, "Unavailable");
    assert.ok(control(harness, "#context").textContent?.includes(newer.contextSummary));
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");

    // A later request must still be able to refresh this same Session. It starts
    // after publication 3, so its genuinely newer snapshot is publication 4 / cut 3.
    const latest = cloneState(commandState);
    latest.contextSummary = "The bound Bass clip is available in the latest observation.";
    latest.liveContext = cloneState(state.liveContext);
    assert.equal(latest.liveContext.availability, "available");
    latest.liveContext.value.title = "Latest observed Bass";
    latest.events.push(
      { id: "latest-user", kind: "user", content: "Inspect again", createdAt: "2026-09-05T00:00:02.000Z" },
      { id: "latest-result", kind: "assistant", content: "The current clip was inspected again.", createdAt: "2026-09-05T00:00:03.000Z" },
    );
    harness.setServerState(latest);
    harness.input("#prompt", "Inspect again");
    harness.click("#sendButton");
    await harness.settle();
    const latestSend = snapshots.filter((snapshot) => snapshot.path === "/send").at(-1)!.state;
    assert.deepEqual(
      [latestSend.bridgeStateRevision, latestSend.bridgeStateCoveredThroughRevision],
      ["4", "3"],
    );
    assert.equal(control(harness, "#liveContextTitle").textContent, "Latest observed Bass");
    assert.ok(control(harness, "#context").textContent?.includes(latest.contextSummary));
    assert.equal(harness.sendIds.length, 2);
    assert.notEqual(harness.sendIds[0], harness.sendIds[1]);
    assert.deepEqual(jsonCalls(harness, "/state"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    releaseSendBody();
    await harness.settle();
    harness.close();
  }
});

test("a same-Session context refresh preserves composer focus and its draft when the source becomes unavailable", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  const refresh = async (next: ChatBridgeState) => {
    const previousRequests = jsonCalls(harness, "/state").length;
    harness.setServerState(next);
    harness.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId });
    await waitForCondition(
      () => jsonCalls(harness, "/state").length > previousRequests,
      "Expected the Session invalidation to request authoritative state",
    );
    await harness.settle();
  };
  try {
    harness.input("#prompt", "Keep this unsent idea while the context refreshes.");
    control<HTMLTextAreaElement>(harness, "#prompt").focus();
    const renamed = cloneState(state);
    assert.equal(renamed.liveContext.availability, "available");
    renamed.liveContext.value.title = "Renamed Bass";
    await refresh(renamed);
    assert.equal(control(harness, "#liveContextTitle").textContent, "Renamed Bass");
    assert.equal(harness.document.activeElement, control(harness, "#prompt"));

    const unavailable = cloneState(renamed);
    unavailable.liveContext = { sessionId: state.activeSessionId, availability: "unavailable", label: "Bass unavailable" };
    await refresh(unavailable);
    assert.equal(harness.document.activeElement, control(harness, "#prompt"));
    assert.equal(control<HTMLTextAreaElement>(harness, "#prompt").value, "Keep this unsent idea while the context refreshes.");
    assert.equal(control(harness, "#liveContextTitle").textContent, "Bass unavailable");
    assert.equal(control(harness, "#liveContextLocation").textContent, "Unavailable");
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
