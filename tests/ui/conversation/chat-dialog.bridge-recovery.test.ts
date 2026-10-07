import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

const stateReads = (harness: Awaited<ReturnType<typeof createDialogHarness>>) => harness.calls.filter(call => new URL(call.url).pathname === "/state").length;

test("an obsolete recovery response cannot unlock Send or suppress the next reconnect refresh", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextState(); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    harness.emitServerEventError(); harness.releaseHeldState(); await harness.settle();
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, true);
    const updated = stateFixture(); updated.openSettingsOnLoad = false;
    updated.events = [{ id: "missed", kind: "assistant", content: "Message saved during the outage", createdAt: "2026-10-07T00:00:00.000Z" }];
    harness.setServerState(updated); harness.emitServerEventOpen(); await harness.settle();
    assert.equal(stateReads(harness), 2);
    assert.match(harness.document.querySelector("#timeline")!.textContent!, /Message saved during the outage/);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a temporary recovery failure retries automatically without resubmitting a prompt", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Keep my unsent draft");
    harness.failNextState("Temporary failure"); harness.emitServerEventError(); harness.emitServerEventOpen();
    await waitForCondition(() => stateReads(harness) === 2, "automatic state recovery retry");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Keep my unsent draft");
    assert.equal(harness.sendIds.length, 0);
    assert.doesNotMatch(harness.document.querySelector("#status")!.textContent!, /could not|Lost connection|Restoring/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("recovery retries are bounded and the visible Retry control starts one new recovery", async () => {
  const { installWindowClock } = await import("../support/window-clock.js");
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const clock = installWindowClock(harness.window);
  try {
    harness.failNextState("Temporary failure"); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    for (const delay of [500, 1000, 2000]) {
      harness.failNextState("Still unavailable"); clock.advance(delay); await harness.settle();
    }
    assert.equal(stateReads(harness), 4);
    clock.advance(60_000); await harness.settle();
    assert.equal(stateReads(harness), 4, "Exhausted recovery must not poll indefinitely");
    const retry = harness.document.querySelector<HTMLButtonElement>("#bridgeRetryButton")!;
    assert.ok(retry); assert.equal(retry.hidden, false);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, true);
    harness.holdNextState(); harness.click("#bridgeRetryButton"); harness.click("#bridgeRetryButton"); await harness.settle();
    assert.equal(stateReads(harness), 5);
    harness.releaseHeldState(); await harness.settle();
    assert.equal(retry.hidden, true);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); clock.restore(); }
});

test("a timed-out recovery is replaced and its late response cannot overwrite recovered content", async () => {
  const { installWindowClock } = await import("../support/window-clock.js");
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const clock = installWindowClock(harness.window);
  try {
    harness.holdNextState(); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    clock.advance(15_000); await harness.settle();
    const latest = stateFixture(); latest.openSettingsOnLoad = false;
    latest.events = [{ id: "fresh", kind: "assistant", content: "Recovered latest content", createdAt: "2026-10-07T00:00:00.000Z" }];
    harness.setServerState(latest); clock.advance(500); await harness.settle();
    assert.equal(stateReads(harness), 2);
    assert.match(harness.document.querySelector("#timeline")!.textContent!, /Recovered latest content/);
    harness.setServerState(state); harness.releaseHeldState(); await harness.settle();
    assert.match(harness.document.querySelector("#timeline")!.textContent!, /Recovered latest content/);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); clock.restore(); }
});

test("pagehide cancels pending recovery retries and a cached page resumes with a fresh connection", async () => {
  const { installWindowClock } = await import("../support/window-clock.js");
  const harness = await createDialogHarness(stateFixture());
  const clock = installWindowClock(harness.window);
  try {
    harness.failNextState("Temporary failure"); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    clock.advance(60_000); await harness.settle();
    assert.equal(stateReads(harness), 1);
    harness.window.dispatchEvent(new harness.window.PageTransitionEvent("pageshow", { persisted: true }));
    assert.equal(harness.eventSourceUrls.length, 2);
    harness.emitServerEventOpen(); await harness.settle();
    assert.equal(stateReads(harness), 2);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); clock.restore(); }
});

test("a new connection can recover before the previous request finishes", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextState(); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    const latest = stateFixture(); latest.openSettingsOnLoad = false;
    latest.events = [{ id: "new-generation", kind: "assistant", content: "Content from the current connection", createdAt: "2026-10-07T00:00:00.000Z" }];
    harness.setServerState(latest); harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
    assert.equal(stateReads(harness), 2);
    assert.match(harness.document.querySelector("#timeline")!.textContent!, /Content from the current connection/);
    harness.setServerState(state); harness.releaseHeldState(); await harness.settle();
    assert.match(harness.document.querySelector("#timeline")!.textContent!, /Content from the current connection/);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const failure of ["forbidden", "malformed"] as const) {
  test(`${failure} recovery responses keep operations gated without automatic retry`, async () => {
    const { installWindowClock } = await import("../support/window-clock.js");
    const harness = await createDialogHarness(stateFixture());
    const clock = installWindowClock(harness.window);
    const fetch = harness.window.fetch;
    let reads = 0;
    Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (...args: Parameters<typeof fetch>) => {
      if (new URL(String(args[0])).pathname === "/state") {
        reads++;
        return new Response(failure === "forbidden" ? "Forbidden" : JSON.stringify({ unexpected: true }), { status: failure === "forbidden" ? 403 : 200 });
      }
      return fetch(...args);
    } });
    try {
      harness.emitServerEventError(); harness.emitServerEventOpen(); await harness.settle();
      clock.advance(60_000); await harness.settle();
      assert.equal(reads, 1);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")!.disabled, true);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#bridgeRetryButton")!.hidden, false);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); clock.restore(); }
  });
}
