import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneState,
  createDialogHarness,
  jsonCalls,
  pendingImage,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

test("a cross-window Session invalidation refreshes authoritative content without losing the composer draft", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.input("#prompt", "Keep this local draft");

  const peerState = cloneState(initial);
  peerState.sessions[0]!.title = "Renamed in another window";
  peerState.sessions[0]!.updatedAt = "2026-08-01T00:02:00.000Z";
  peerState.events = [{
    id: "event-from-peer",
    kind: "assistant",
    content: "Persisted in the peer window",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  peerState.pendingAttachments = [pendingImage(
    "attachment-from-peer",
    "peer.png",
  )];
  harness.setServerState(peerState);
  harness.holdNextState();
  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: initial.activeSessionId,
  });

  await waitForCondition(() =>
    harness.calls.some((call) => new URL(call.url).pathname === "/state")
  , "Session state refresh request");
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    true,
  );
  harness.click("#sendButton");
  assert.equal(
    harness.calls.some((call) => new URL(call.url).pathname === "/send"),
    false,
  );
  harness.emitServerEvent({
    type: "profile_settings_changed",
    commandId: "peer-profile-refresh",
  });
  harness.emitServerEvent({
    type: "approval_mode_changed",
    sessionId: initial.activeSessionId,
    approvalMode: "low-risk",
    updatedAt: "2026-08-01T00:03:00.000Z",
  });
  await waitForCondition(() =>
    harness.calls.filter((call) => new URL(call.url).pathname === "/state")
      .length === 2
  , "concurrent Profile state refresh request");
  await waitForCondition(() =>
    (harness.document.querySelector("#pendingAttachments")?.textContent ?? "")
      .includes("peer.png")
  , "Profile refresh authoritative Session content");
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );

  harness.releaseHeldState();
  await waitForCondition(() =>
    (harness.document.querySelector(
      '[data-session-id="session-1"] .session-title',
    )?.textContent ?? "").includes("Renamed in another window")
  , "refreshed Session title");
  assert.equal(
    harness.document.querySelector<HTMLInputElement>("#prompt")?.value,
    "Keep this local draft",
  );
  assert.match(
    harness.document.querySelector("#timeline")?.textContent ?? "",
    /Persisted in the peer window/,
  );
  assert.match(
    harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
    /peer\.png/,
  );
  assert.equal(
    harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
    "low-risk",
  );
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
});

test("Session rename input enforces the shared Unicode character limit", async (t) => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  await harness.settle();
  harness.click('[data-session-menu-button="session-1"]');
  harness.click('[data-session-id="session-1"] [data-session-action="rename"]');
  const input = harness.document.querySelector<HTMLInputElement>(
    ".session-rename-input",
  );
  assert.ok(input);
  assert.equal(input.maxLength, 160);
  input.value = "😀".repeat(81);
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  assert.equal([...input.value].length, 80);
  input.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    key: "Enter",
  }));
  await harness.settle();
  const rename = harness.calls.find((call) =>
    call.jsonBody &&
    typeof call.jsonBody === "object" &&
    (call.jsonBody as { kind?: string }).kind === "rename_session"
  );
  assert.ok(rename);
  assert.equal(
    [...String((rename.jsonBody as { title?: string }).title)].length,
    80,
  );
});

test("an inactive Session invalidation waits for target content instead of claiming active state", async (t) => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  t.after(() => harness.close());
  await harness.settle();

  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: "session-2",
  });
  await harness.settle();

  assert.equal(
    harness.calls.some((call) => new URL(call.url).pathname === "/state"),
    false,
  );
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
});

test("event-stream reconnect restores a dropped completed send from authoritative state", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "Recover this send");
  harness.click("#sendButton");
  await waitForCondition(() =>
    harness.calls.some((call) => new URL(call.url).pathname === "/send")
  , "held send request");

  const terminal = cloneState(initial);
  const activeSendId = harness.sendIds[0];
  assert.ok(activeSendId);
  terminal.events = [
    {
      id: "reconnected-user",
      kind: "user",
      content: "Recover this send",
      createdAt: "2026-08-01T00:01:00.000Z",
    },
    {
      id: "reconnected-assistant",
      kind: "assistant",
      content: "Recovered terminal response",
      createdAt: "2026-08-01T00:02:00.000Z",
    },
  ];
  terminal.sessionActivities = [{
    sessionId: initial.activeSessionId,
    sendId: activeSendId,
    status: "completed",
    message: "Completed",
    unread: false,
  }];
  harness.setServerState(terminal);
  harness.emitServerEventError();
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
    true,
  );
  harness.emitServerEventOpen();
  await waitForCondition(() =>
    (harness.document.querySelector("#timeline")?.textContent ?? "")
      .includes("Recovered terminal response")
  , "reconnected terminal state");
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );

  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});

test("event-stream reconnect settles a completed background Session and promotes only its queue", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  initial.settings.defaultFollowUpBehavior = "queue";
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "Background request");
  harness.click("#sendButton");
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 1,
    "held background request",
  );

  harness.input("#prompt", "Background follow-up");
  harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "Enter",
    }),
  );
  await harness.settle();
  harness.click('[data-session-id="session-2"] .session-row');
  await waitForCondition(
    () => harness.document.querySelector(
      '[data-session-id="session-2"] .session-row',
    )?.getAttribute("aria-pressed") === "true",
    "switch to the foreground Session",
  );
  const backgroundSendId = harness.sendIds[0];
  assert.ok(backgroundSendId);
  harness.emitServerEvent({
    type: "progress",
    sendId: backgroundSendId,
    sessionId: "session-1",
    message: "Finishing in the background",
  });

  const terminal = cloneState(initial);
  terminal.activeSessionId = "session-2";
  terminal.approvalMode = "low-risk";
  terminal.sessionActivities = [{
    sessionId: "session-1",
    sendId: backgroundSendId,
    status: "completed",
    message: "Completed",
    unread: true,
  }];
  harness.setServerState(terminal);
  harness.emitServerEventError();
  harness.emitServerEventOpen();

  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 2,
    "background queue promotion after reconnect",
  );
  assert.deepEqual(jsonCalls(harness, "/send")[1]?.body, {
    prompt: "Background follow-up",
    sessionId: "session-1",
  });
  assert.equal(
    harness.document.querySelector(
      '[data-session-id="session-2"] .session-row',
    )?.getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    harness.document.querySelector("#sendButtonLabel")?.textContent,
    "Send",
  );

  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});

test("send-owned progress replaces an older activity correlation before terminal recovery", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  initial.sessionActivities = [{
    sessionId: initial.activeSessionId,
    sendId: "older-completed-send",
    status: "completed",
    message: "Completed",
    unread: false,
  }];
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  const clientState = harness.readBootstrappedClientStateReference();

  harness.holdNextSend();
  harness.input("#prompt", "Start a new correlated send");
  harness.click("#sendButton");
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 1,
    "new held send",
  );
  const sendId = harness.sendIds[0];
  assert.ok(sendId);
  assert.notEqual(sendId, "older-completed-send");

  harness.emitServerEvent({
    type: "progress",
    sendId,
    sessionId: initial.activeSessionId,
    message: "New send is running",
  });
  const incrementalActivity = clientState.sessionActivities?.find(
    (activity) => activity.sessionId === initial.activeSessionId,
  );
  assert.equal(incrementalActivity?.sessionId, initial.activeSessionId);
  assert.equal(incrementalActivity?.sendId, sendId);
  assert.equal(incrementalActivity?.status, "running");
  assert.equal(incrementalActivity?.message, "New send is running");
  assert.equal(incrementalActivity?.unread, false);

  const terminal = cloneState(initial);
  terminal.events = [{
    id: "recovered-new-send",
    kind: "assistant",
    content: "Recovered the new send",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  terminal.sessionActivities = [{
    sessionId: initial.activeSessionId,
    sendId,
    status: "completed",
    message: "Completed",
    unread: false,
  }];
  harness.setServerState(terminal);
  harness.emitServerEventError();
  harness.emitServerEventOpen();
  await waitForCondition(
    () => harness.document.querySelector("#sendButton")?.textContent === "Send",
    "current send terminal recovery",
  );
  assert.match(
    harness.document.querySelector("#timeline")?.textContent ?? "",
    /Recovered the new send/,
  );

  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});

test("event-stream reconnect does not settle a new Send from an older completed activity", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  initial.sessionActivities = [{
    sessionId: initial.activeSessionId,
    sendId: "send-from-an-earlier-request",
    status: "completed",
    message: "Completed",
    unread: false,
  }];
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "New request after old completion");
  harness.click("#sendButton");
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 1,
    "new held send",
  );
  assert.notEqual(harness.sendIds[0], "send-from-an-earlier-request");

  harness.setServerState(cloneState(initial));
  harness.emitServerEventError();
  harness.emitServerEventOpen();
  await waitForCondition(
    () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
    "reconnect state refresh",
  );
  await harness.settle();

  assert.equal(
    harness.document.querySelector("#sendButton")?.textContent,
    "Stop",
  );
  assert.doesNotMatch(
    harness.document.querySelector("#status")?.textContent ?? "",
    /^Completed$/,
  );
  assert.equal(jsonCalls(harness, "/send").length, 1);

  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});

test("a newer Session invalidation retries a failed authoritative refresh", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.failNextState("Temporary Session state failure");

  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: initial.activeSessionId,
  });
  await waitForCondition(
    () => harness.calls.filter(
      (call) => new URL(call.url).pathname === "/state",
    ).length === 1,
    "failed Session state refresh",
  );
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    true,
  );

  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: initial.activeSessionId,
  });
  await waitForCondition(
    () => harness.calls.filter(
      (call) => new URL(call.url).pathname === "/state",
    ).length === 2,
    "retried Session state refresh",
  );
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
  assert.deepEqual(harness.errors, []);
});

test("an in-flight Session refresh retries when a newer invalidation precedes its failure", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.failNextState("Older in-flight Session refresh failed");

  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: initial.activeSessionId,
  });
  harness.emitServerEvent({
    type: "session_state_invalidated",
    sessionId: initial.activeSessionId,
  });

  await waitForCondition(
    () => harness.calls.filter(
      (call) => new URL(call.url).pathname === "/state",
    ).length === 2,
    "newer in-flight Session refresh retry",
  );
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
  assert.deepEqual(harness.errors, []);
});

test("a queued follow-up waits for event-stream state reconciliation before promotion", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  initial.settings.defaultFollowUpBehavior = "queue";
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "First request");
  harness.click("#sendButton");
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 1,
    "first held send",
  );

  harness.input("#prompt", "Queued after reconnect");
  harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "Enter",
    }),
  );
  await harness.settle();
  harness.emitServerEventError();
  harness.releaseHeldSend();
  await harness.settle();

  assert.equal(jsonCalls(harness, "/send").length, 1);
  assert.match(
    harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
    /Queued after reconnect/,
  );

  harness.emitServerEventOpen();
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 2,
    "queued send after reconnect reconciliation",
  );
  assert.deepEqual(
    jsonCalls(harness, "/send").map((call) => call.body),
    [
      { prompt: "First request", sessionId: initial.activeSessionId },
      { prompt: "Queued after reconnect", sessionId: initial.activeSessionId },
    ],
  );
  assert.deepEqual(harness.errors, []);
});

test("a newer event-stream generation retries after the older state refresh fails", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.failNextState("Older reconnect state failed");

  harness.emitServerEventError();
  harness.emitServerEventOpen();
  harness.emitServerEventError();
  harness.emitServerEventOpen();

  await waitForCondition(
    () => harness.calls.filter((call) => new URL(call.url).pathname === "/state")
      .length === 2,
    "newer reconnect state retry",
  );
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
  harness.input("#prompt", "Send after the latest reconnect");
  harness.click("#sendButton");
  await waitForCondition(
    () => jsonCalls(harness, "/send").length === 1,
    "send after latest reconnect state",
  );
  assert.deepEqual(harness.errors, []);
});

test("send carries acknowledged global and active Session coverage", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  await harness.settle();
  harness.emitServerEvent({
    type: "profile_settings_changed",
    commandId: "coverage-profile-refresh",
  });
  await waitForCondition(() =>
    harness.calls.some((call) => new URL(call.url).pathname === "/state")
  , "authoritative global state refresh");
  await harness.settle();
  harness.input("#prompt", "Send with coverage");
  harness.click("#sendButton");
  await waitForCondition(() =>
    harness.calls.some((call) => new URL(call.url).pathname === "/send")
  , "covered send request");
  const send = harness.calls.findLast(
    (call) => new URL(call.url).pathname === "/send",
  );
  const headers = send?.headers as Record<string, string> | undefined;
  assert.match(
    headers?.["X-Live-Smith-Global-State-Covered-Through"] ?? "",
    /^[1-9][0-9]*$/,
  );
  assert.equal(
    headers?.["X-Live-Smith-Session-State-Covered-Through"],
    headers?.["X-Live-Smith-Global-State-Covered-Through"],
  );
});

test("a stale-state Send rejection refreshes before allowing the preserved prompt", async (t) => {
  const initial = stateFixture();
  initial.openSettingsOnLoad = false;
  const harness = await createDialogHarness(initial);
  t.after(() => harness.close());
  harness.failNextSend(
    "Live Smith state changed in another window.",
    "not_persisted",
    { sendFailureKind: "state_stale" },
  );
  harness.input("#prompt", "Preserve this prompt");
  harness.click("#sendButton");
  await waitForCondition(() =>
    harness.calls.some((call) => new URL(call.url).pathname === "/state")
  , "stale-state reconciliation request");
  await harness.settle();

  assert.equal(
    harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
    "Preserve this prompt",
  );
  assert.equal(
    harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
    false,
  );
});
