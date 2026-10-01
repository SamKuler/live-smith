import assert from "node:assert/strict";
import test from "node:test";
import type { ChatBridgeState } from "../../src/ui/chat-state.js";
import { createDialogHarness, commandCalls, stateFixture, waitForCondition } from "./support/chat-dialog.test-harness.js";

test("startup discovers tool descriptions once without locking the composer or taking its focus", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (value) => {
    await held;
    return value;
  } });
  try {
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    assert.equal(h.document.querySelector("#sessionTools")?.getAttribute("aria-busy"), "true");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.disabled, false);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#saveProfileButton")!.disabled, true);
    assert.equal(h.document.activeElement?.id, "prompt");
    h.input("#prompt", "Keep this draft");
    release();
    await h.settle();
    assert.ok(h.document.querySelector(".tool-entry"));
    h.click("#settingsButton"); h.click("#sessionInspectorScope"); h.click("#toolsTab");
    await h.settle();
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 1);
    assert.equal(h.document.querySelector("#sessionTools")?.getAttribute("aria-busy"), "false");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Keep this draft");
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

test("failed automatic discovery stays local and waits for an explicit retry", async () => {
  let attempts = 0;
  const h = await createDialogHarness(undefined, undefined, { toolCatalogResponse: async (value) => {
    if (++attempts === 1) throw new Error("Synthetic metadata failure");
    return value;
  } });
  try {
    await h.settle();
    assert.equal(attempts, 1);
    assert.match(h.document.querySelector("#sessionToolsStatus")!.textContent!, /not loaded/u);
    assert.doesNotMatch(h.document.querySelector("#status")!.textContent!, /Synthetic/u);
    h.click("#sessionInspectorScope"); h.click("#toolsTab");
    await h.settle();
    assert.equal(attempts, 1);
    h.click("#loadSessionToolsButton"); await h.settle();
    assert.equal(attempts, 2);
    assert.ok(h.document.querySelector(".tool-entry"));
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a late tool response cannot switch Sessions or overwrite an edited Profile", async () => {
  const pending: { state: ChatBridgeState; signal: AbortSignal | null | undefined; resolve(value: ChatBridgeState): void }[] = [];
  const h = await createDialogHarness(undefined, undefined, { toolCatalogResponse: (state, signal) =>
    new Promise((resolve) => { pending.push({ state, signal, resolve }); }) });
  try {
    assert.equal(pending.length, 1);
    h.input("#profileName", "Unsubmitted name");
    h.click('.session-entry[data-session-id="session-2"] .session-row');
    await h.settle();
    await waitForCondition(() => pending.length === 2, "new Session tool discovery");
    assert.equal(pending[0]!.signal?.aborted, true);
    pending[1]!.resolve(pending[1]!.state); await h.settle();
    pending[0]!.resolve(pending[0]!.state); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#profileName")!.value, "Unsubmitted name");
    assert.match(h.document.querySelector('.session-row[aria-pressed="true"]')!.textContent!, /Lead/u);
    assert.ok(h.document.querySelector(".tool-entry"));
    assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "save_profile").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { for (const value of pending) value.resolve(value.state); h.close(); }
});

test("foreground work cancels discovery and resumes it only after the Session is idle", async () => {
  const pending: { state: ChatBridgeState; signal: AbortSignal | null | undefined; resolve(value: ChatBridgeState): void }[] = [];
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: (snapshot, signal) =>
    new Promise((resolve) => { pending.push({ state: snapshot, signal, resolve }); }) });
  let sendHeld = false;
  try {
    h.holdNextSend(); sendHeld = true;
    h.input("#prompt", "Inspect this Session"); h.click("#sendButton");
    await h.settle();
    assert.equal(pending[0]!.signal?.aborted, true);
    pending[0]!.resolve(pending[0]!.state); await h.settle();
    assert.equal(h.document.querySelector(".tool-entry"), null);
    assert.equal(pending.length, 1);
    h.releaseHeldSend(); sendHeld = false;
    await h.settle();
    assert.equal(pending.length, 2);
    pending[1]!.resolve(pending[1]!.state); await h.settle();
    assert.ok(h.document.querySelector(".tool-entry"));
    assert.equal(h.calls.filter((call) => call.path === "/send").length, 1);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally {
    if (sendHeld) h.releaseHeldSend();
    h.close();
    for (const value of pending) value.resolve(value.state);
  }
});
