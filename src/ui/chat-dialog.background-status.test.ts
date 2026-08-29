import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_DISCOVERED_MODEL_COUNT,
} from "../model/catalog.js";

import {
  cloneState,
  capabilityEvidence,
  createDialogHarness,
  imageCapableState,
  imageFile,
  pendingAudio,
  pendingImage,
  stateFixture,
} from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

type DialogUi = {
  runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
};

async function startHeldSend(
  harness: Harness,
  prompt: string,
): Promise<string> {
  harness.holdNextSend();
  harness.input("#prompt", prompt);
  harness.click("#sendButton");
  await waitFor(
    () => harness.sendIds.length > 0 &&
      harness.sendIds.at(-1) !== "",
    "Expected the send request to start.",
  );
  return harness.sendIds.at(-1)!;
}

async function selectSession(harness: Harness, sessionId: string): Promise<void> {
  const row = harness.document.querySelector<HTMLButtonElement>(
    `.session-entry[data-session-id="${sessionId}"] .session-row`,
  );
  assert.ok(row);
  row.click();
  await waitFor(
    () => harness.calls.some((call) =>
      call.path === "/command" &&
      call.jsonBody &&
      typeof call.jsonBody === "object" &&
      "kind" in call.jsonBody &&
      call.jsonBody.kind === "select_session" &&
      "sessionId" in call.jsonBody &&
      call.jsonBody.sessionId === sessionId
    ),
    `Expected ${sessionId} to become selected.`,
  );
  await harness.settle();
}

async function runCommand(
  harness: Harness,
  kind: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
  assert.equal(await ui.runCommand(kind, extra), true);
  await harness.settle();
}

function stateWithThirdSession() {
  const state = cloneState(stateFixture());
  const template = state.sessions.find((session) => session.id === "session-2")!;
  state.sessions.push({
    ...template,
    id: "session-3",
    title: "Third session",
    scope: {
      kind: "track",
      identity: "track-3",
      label: "Third Track",
    },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  });
  state.activeSessionId = "session-3";
  state.approvalMode = "manual";
  state.events = [];
  state.pendingAttachments = [];
  return state;
}

function activateStateSession(
  state: ReturnType<typeof stateFixture>,
  sessionId: string,
): void {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  assert.ok(session);
  state.activeSessionId = sessionId;
  state.approvalMode = session.approvalMode ?? "manual";
  state.activeSkillIds = [...(session.activeSkillIds ?? [])];
}

function assertForegroundProgress(harness: Harness): void {
  assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
  assert.equal(
    harness.document.querySelector("#status")?.textContent,
    "Foreground still working",
  );
}

function assertBackgroundSessionTitle(
  harness: Harness,
  expected: string,
): void {
  assert.equal(
    harness.document.querySelector(
      '.session-entry[data-session-id="session-1"] .session-title',
    )?.textContent,
    expected,
  );
}

test("a background HTTP completion cannot clear the visible send progress", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.omitNextSendState();
    const backgroundSendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");
    const foregroundSendId = await startHeldSend(harness, "Foreground request");
    assert.notEqual(backgroundSendId, foregroundSendId);
    harness.emitServerEvent({
      type: "progress",
      sendId: foregroundSendId,
      sessionId: "session-2",
      message: "Foreground still working",
    });
    assertForegroundProgress(harness);

    const authoritative = cloneState(stateFixture());
    activateStateSession(authoritative, "session-2");
    authoritative.sessions.find((session) => session.id === "session-1")!.title =
      "Background title from HTTP";
    harness.setServerState(authoritative);
    harness.releaseHeldSend();
    await waitFor(
      () => harness.calls.some((call) => call.path === "/state"),
      "Expected the background HTTP completion to refresh state.",
    );
    await harness.settle();

    assertForegroundProgress(harness);
    assertBackgroundSessionTitle(harness, "Background title from HTTP");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background SSE done cannot clear the visible send progress", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const backgroundSendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");
    const foregroundSendId = await startHeldSend(harness, "Foreground request");
    harness.emitServerEvent({
      type: "progress",
      sendId: foregroundSendId,
      sessionId: "session-2",
      message: "Foreground still working",
    });
    assertForegroundProgress(harness);

    const authoritative = cloneState(stateFixture());
    activateStateSession(authoritative, "session-2");
    authoritative.sessions.find((session) => session.id === "session-1")!.title =
      "Background title from SSE";
    authoritative.sessionActivities = [
      {
        sessionId: "session-1",
        status: "completed",
        message: "Completed",
        unread: true,
      },
      {
        sessionId: "session-2",
        status: "running",
        message: "Foreground still working",
        unread: false,
      },
    ];
    harness.emitServerEvent({
      type: "done",
      sendId: backgroundSendId,
      sessionId: "session-1",
      state: authoritative,
    });
    await harness.settle();

    assertForegroundProgress(harness);
    assertBackgroundSessionTitle(harness, "Background title from SSE");
    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("send-scoped SSE without a Session ID is ignored instead of inferred", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Keep exact Session ownership");
    assert.equal(harness.document.querySelector("#status")?.textContent, "Starting Live Smith…");

    harness.emitServerEvent({
      type: "progress",
      sendId,
      message: "Must not be inferred",
    });
    await harness.settle();

    assert.equal(harness.document.querySelector("#status")?.textContent, "Starting Live Smith…");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older background terminal cannot delete a newer foreground Session draft", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    const newer = stateWithThirdSession();
    harness.setServerState(newer);
    await runCommand(harness, "select_session", { sessionId: "session-3" });
    harness.input("#prompt", "Unsaved foreground draft");

    const older = cloneState(stateFixture());
    older.activeSessionId = "session-1";
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: older,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Unsaved foreground draft",
    );
    assert.ok(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-3"]',
      ),
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older background terminal cannot roll back newer Session metadata", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");
    const newer = cloneState(stateFixture());
    activateStateSession(newer, "session-2");
    newer.sessions.find((session) => session.id === "session-1")!.updatedAt =
      "2026-08-03T00:00:00.000Z";
    harness.setServerState(newer);
    await runCommand(harness, "rename_session", {
      sessionId: "session-1",
      title: "Newer command title",
    });
    assertBackgroundSessionTitle(harness, "Newer command title");

    const older = cloneState(stateFixture());
    older.activeSessionId = "session-1";
    harness.queueNextStatePublication("4", "1");
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: older,
    });
    await harness.settle();

    assertBackgroundSessionTitle(harness, "Newer command title");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older unavailable background target cannot replace newer foreground state", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    const newer = stateWithThirdSession();
    harness.setServerState(newer);
    await runCommand(harness, "select_session", { sessionId: "session-3" });
    harness.input("#prompt", "Keep this newer draft");

    const older = cloneState(stateFixture());
    older.sessions = older.sessions.filter((session) => session.id !== "session-1");
    activateStateSession(older, "session-2");
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: older,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Keep this newer draft",
    );
    assert.ok(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-3"]',
      ),
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"]',
      ),
      null,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older visible unavailable state cannot roll back newer peer metadata", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Visible request");
    await runCommand(harness, "rename_session", {
      sessionId: "session-2",
      title: "Newer peer title",
    });

    const older = cloneState(stateFixture());
    older.openSettingsOnLoad = false;
    older.sessions = older.sessions.filter(
      (session) => session.id !== "session-1",
    );
    older.activeSessionId = "session-2";
    older.approvalMode = "low-risk";
    harness.emitServerEvent({
      type: "error",
      sendId,
      sessionId: "session-1",
      message: "The target Session is unavailable.",
      promptPersistence: "not_persisted",
      sendFailureKind: "session_unavailable",
      state: older,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector('[data-session-id="session-1"]'),
      null,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Newer peer title",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unavailable background move preserves newer target metadata", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");
    await runCommand(harness, "rename_session", {
      sessionId: "session-1",
      title: "Newer moved title",
    });

    const older = cloneState(stateFixture());
    older.openSettingsOnLoad = false;
    const moved = older.sessions.find((session) => session.id === "session-1")!;
    older.sessions = older.sessions.filter(
      (session) => session.id !== "session-1",
    );
    older.previousSessions = [moved];
    older.activeSessionId = "session-2";
    older.approvalMode = "low-risk";
    harness.emitServerEvent({
      type: "error",
      sendId,
      sessionId: "session-1",
      message: "The target Session is unavailable.",
      promptPersistence: "not_persisted",
      sendFailureKind: "session_unavailable",
      state: older,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.current-session-entry[data-session-id="session-1"]',
      ),
      null,
    );
    assert.equal(
      harness.document.querySelector(
        '[data-session-id="session-1"] .session-title',
      )?.textContent,
      "Newer moved title",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older visible terminal cannot roll back newer peer Session metadata", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Visible request");
    const newer = cloneState(stateFixture());
    newer.sessions.find((session) => session.id === "session-2")!.updatedAt =
      "2026-08-03T00:00:00.000Z";
    harness.setServerState(newer);
    await runCommand(harness, "rename_session", {
      sessionId: "session-2",
      title: "Newer peer title",
    });
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Newer peer title",
    );

    const older = cloneState(stateFixture());
    older.activeSessionId = "session-1";
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: older,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Newer peer title",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older command response cannot roll back a newer approval event", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    const meta = harness.document.querySelector<HTMLElement>(
      '.session-entry[data-session-id="session-1"] .session-meta',
    );
    assert.ok(meta);
    const initialTimestamp = meta.title;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-1",
      title: "Renamed current",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "rename_session"
      ),
      "Expected the rename command to wait for its response.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    const eventTimestamp = meta.title;
    assert.notEqual(eventTimestamp, initialTimestamp);

    const staleResponse = cloneState(state);
    staleResponse.sessions.find((session) => session.id === "session-1")!.title =
      "Renamed current";
    harness.setServerState(staleResponse);

    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.equal(meta.title, eventTimestamp);
    assertBackgroundSessionTitle(harness, "Renamed current");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a stale state first introducing a Session preserves its newer approval patch", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const stale = cloneState(state);
  state.sessions = state.sessions.filter((session) => session.id !== "session-2");
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("select_session", { sessionId: "session-2" });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "select_session"
      ),
      "Expected the selection command to wait for its response.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });
    activateStateSession(stale, "session-2");
    harness.setServerState(stale);
    harness.queueNextStatePublication("4", "1");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.ok(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"]',
      ),
    );
    const formatter = new harness.window.Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
    });
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        '.session-entry[data-session-id="session-2"] .session-meta',
      )?.title,
      `Updated ${formatter.format(new harness.window.Date(
        "2026-08-25T00:03:00.000Z",
      ))}`,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an older attachment response cannot roll back a newer approval event", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextAttachment();
    harness.dropAttachmentFiles([
      imageFile(harness.window, "causal-state.png", "image/png"),
    ]);
    await waitFor(
      () => harness.calls.some((call) => call.path === "/attachments"),
      "Expected the attachment response to wait.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );

    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /causal-state\.png/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("command response-loss reconciliation preserves a newer approval event", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.truncateNextCommandResponseAfterCommit();
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Committed after response loss",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "rename_session"
      ),
      "Expected the response-lost command to start.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    harness.emitServerEventError();
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Committed after response loss",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("attachment response-loss reconciliation preserves a newer approval event", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.truncateNextAttachmentResponseAfterCommit();
    harness.holdNextAttachment();
    harness.dropAttachmentFiles([
      imageFile(harness.window, "response-loss.png", "image/png"),
    ]);
    await waitFor(
      () => harness.calls.some((call) => call.path === "/attachments"),
      "Expected the response-lost attachment operation to start.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.match(
      harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
      /response-loss\.png/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Skill response-loss reconciliation preserves a newer approval event", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.availableSkills = [{
    id: "mix-review",
    description: "Review balance",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.truncateNextSkillResponseAfterCommit();
    harness.holdNextState();
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='mix-review'] .skill-delete",
    );
    assert.ok(deleteButton);
    deleteButton.click();
    await harness.acceptAppConfirmation();
    await waitFor(
      () => harness.calls.some((call) => call.path === "/state"),
      "Expected the response-lost Skill operation to refresh state.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    harness.releaseHeldState();
    await waitFor(
      () => harness.calls.filter(
        (call) => call.path === "/skills/mix-review",
      ).length === 2,
      "Expected the Skill delete to retry after reconciliation.",
    );
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.equal(
      harness.document.querySelector("[data-skill-id='mix-review']"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const responseLoss of [false, true]) {
  test(`a delayed peer command ${
    responseLoss ? "state refresh" : "response"
  } preserves newer active Session projections`, async () => {
    const state = imageCapableState();
    state.openSettingsOnLoad = false;
    state.pendingAttachments = [pendingImage("old-image", "old.png")];
    const harness = await createDialogHarness(state);
    try {
      const sendId = await startHeldSend(harness, "Refresh active projections");
      const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
      if (responseLoss) harness.truncateNextCommandResponseAfterCommit();
      harness.holdNextCommandResponse();
      const command = ui.runCommand("rename_session", {
        sessionId: "session-2",
        title: "Committed peer title",
      });
      await waitFor(
        () => harness.calls.some((call) =>
          call.path === "/command" &&
          (call.jsonBody as { kind?: string } | undefined)?.kind ===
            "rename_session"
        ),
        "Expected the delayed peer command to start.",
      );

      const newer = cloneState(state);
      newer.events = [{
        id: "newest-assistant-event",
        kind: "assistant",
        content: "Newest assistant event",
        createdAt: "2026-08-04T00:00:00.000Z",
      }];
      newer.pendingAttachments = [];
      newer.contextSummary = "Newer context";
      newer.sessionContinueTarget = { kind: "track", label: "Keys" };
      newer.sessionActivities = [{
        sessionId: "session-1",
        status: "completed",
        message: "Completed",
        unread: false,
      }];
      newer.bridgeStateRevision = "3";
      harness.emitServerEvent({
        type: "done",
        sendId,
        sessionId: "session-1",
        state: newer,
      });
      await harness.settle();
      assert.match(
        harness.document.querySelector("#timeline")?.textContent ?? "",
        /Newest assistant event/,
      );
      assert.doesNotMatch(
        harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
        /old\.png/,
      );
      assert.match(
        harness.document.querySelector("#context")?.textContent ?? "",
        /Newer context/,
      );

      const delayed = cloneState(state);
      delayed.sessions.find((session) => session.id === "session-2")!.title =
        "Committed peer title";
      delayed.events = [{
        id: "delayed-authoritative-event",
        kind: "assistant",
        content: "Delayed authoritative event",
        createdAt: "2026-08-03T23:59:00.000Z",
      }];
      delayed.pendingAttachments = [
        pendingImage("old-image", "old.png"),
        pendingImage("delayed-image", "delayed.png"),
      ];
      delayed.sessionActivities = [{
        sessionId: "session-2",
        status: "running",
        message: "Working",
        unread: false,
      }];
      if (responseLoss) {
        delayed.events = [
          ...newer.events,
          ...delayed.events,
        ];
        delayed.pendingAttachments = [];
        delayed.contextSummary = newer.contextSummary;
        delayed.sessionContinueTarget = newer.sessionContinueTarget;
        delayed.sessionActivities = newer.sessionActivities;
      }
      delayed.bridgeStateRevision = "2";
      harness.setServerState(delayed);
      if (responseLoss) harness.emitServerEventError();
      harness.releaseHeldCommandResponse();
      assert.equal(await command, true);
      await harness.settle();

      assert.equal(
        harness.document.querySelector(
          '.session-entry[data-session-id="session-2"] .session-title',
        )?.textContent,
        "Committed peer title",
      );
      assert.match(
        harness.document.querySelector("#timeline")?.textContent ?? "",
        /Newest assistant event/,
      );
      assert.match(
        harness.document.querySelector("#timeline")?.textContent ?? "",
        /Delayed authoritative event/,
      );
      assert.doesNotMatch(
        harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
        /old\.png/,
      );
      assert.doesNotMatch(
        harness.document.querySelector("#pendingAttachments")?.textContent ?? "",
        /delayed\.png/,
      );
      assert.match(
        harness.document.querySelector("#context")?.textContent ?? "",
        /Newer context/,
      );
      assert.match(
        harness.document.querySelector(
          '.session-entry[data-session-id="session-1"] .session-meta',
        )?.textContent ?? "",
        /Completed/,
      );
      assert.doesNotMatch(
        harness.document.querySelector(
          '.session-entry[data-session-id="session-2"] .session-meta',
        )?.textContent ?? "",
        /Working/,
      );
      harness.releaseHeldSend();
      await harness.settle();
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("a newer Send terminal supersedes an earlier peer command projection", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.contextSummary = "Baseline context";
  state.previousSessions = [{
    ...state.sessions[1]!,
    id: "previous-session",
    title: "Previous lead work",
    projectKey: "previous-project",
  }];
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Build a newer terminal");
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Earlier peer title",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "rename_session"
      ),
      "Expected the earlier peer command to start.",
    );

    const intermediate = cloneState(state);
    intermediate.bridgeStateRevision = "2";
    intermediate.contextSummary = "Intermediate context";
    intermediate.sessions.find((session) => session.id === "session-2")!.title =
      "Earlier peer title";
    harness.setServerState(intermediate);
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.match(
      harness.document.querySelector("#context")?.textContent ?? "",
      /Intermediate context/,
    );

    const newest = cloneState(intermediate);
    newest.bridgeStateRevision = "3";
    newest.contextSummary = "Newest context";
    newest.sessionContinueTarget = { kind: "track", label: "Keys" };
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: newest,
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector("#context")?.textContent ?? "",
      /Newest context/,
    );
    assert.match(
      harness.document.querySelector(
        '[data-continue-session-id="previous-session"]',
      )?.getAttribute("aria-label") || "",
      /current track Keys/,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Earlier peer title",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("revision tracking preserves an approval field after an ABA event sequence", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.sessions.find((session) => session.id === "session-1")!.approvalMode =
    "manual";
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed through ABA",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "rename_session"
      ),
      "Expected the ABA peer command to start.",
    );

    const stale = cloneState(state);
    stale.approvalMode = "low-risk";
    stale.sessions.find((session) => session.id === "session-1")!.approvalMode =
      "low-risk";
    stale.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed through ABA";
    harness.setServerState(stale);
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "manual",
      updatedAt: "2026-08-25T00:04:00.000Z",
      bridgeStateRevision: "4",
    });

    harness.queueNextStatePublication("5", "1");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-title',
      )?.textContent,
      "Renamed through ABA",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an equal-cut state supersedes a pending approval value", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed at the equal cut",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "rename_session"
      ),
      "Expected the equal-cut peer command to start.",
    );

    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:02:00.000Z",
      bridgeStateRevision: "2",
    });
    const authoritative = cloneState(state);
    authoritative.approvalMode = "low-risk";
    authoritative.sessions.find((session) => session.id === "session-1")!
      .approvalMode = "low-risk";
    authoritative.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed at the equal cut";
    harness.setServerState(authoritative);
    harness.queueNextStatePublication("3", "2");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("covered approval state for an absent Session cannot affect its later commands", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const introduced = cloneState(state);
  state.sessions = state.sessions.filter((session) => session.id !== "session-2");
  const harness = await createDialogHarness(state);
  try {
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:02:00.000Z",
      bridgeStateRevision: "2",
    });
    harness.queueNextStatePublication("3", "2");
    await runCommand(harness, "rename_session", {
      sessionId: "session-1",
      title: "Covered current",
    });

    activateStateSession(introduced, "session-2");
    harness.setServerState(introduced);
    harness.queueNextStatePublication("4", "1");
    await runCommand(harness, "select_session", { sessionId: "session-2" });
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );

    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("set_session_approval_mode", {
      sessionId: "session-2",
      approvalMode: "everything",
    });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "set_session_approval_mode"
      ),
      "Expected the later approval command to wait for its response.",
    );
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:05:00.000Z",
      bridgeStateRevision: "5",
    });
    harness.queueNextStatePublication("6", "1");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a selecting command derives active approval from its merged Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.sessionActivities = [{
    sessionId: "session-2",
    status: "completed",
    message: "Completed",
    unread: true,
  }];
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("select_session", { sessionId: "session-2" });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "select_session"
      ),
      "Expected the selection command to wait for its response.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    await runCommand(harness, "select_session", { sessionId: "session-1" });
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-unread-dot',
      ),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a lifecycle command keeps its own move while merging a newer field event", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("archive_session", { sessionId: "session-2" });
    await waitFor(
      () => harness.calls.some((call) =>
        call.path === "/command" &&
        (call.jsonBody as { kind?: string } | undefined)?.kind ===
          "archive_session"
      ),
      "Expected the archive command to wait for its response.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
    });
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.current-session-entry[data-session-id="session-2"]',
      ),
      null,
    );
    assert.ok(
      harness.document.querySelector(
        '.archived-session-entry[data-session-id="session-2"]',
      ),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a full state does not cover a lower publication that happened after its cut", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed peer",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the command correlation ID.",
    );

    const stale = cloneState(state);
    stale.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed peer";
    harness.queueNextStatePublication("3", "1");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: stale,
    });
    assert.equal(await command, true);

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:02:00.000Z",
      bridgeStateRevision: "2",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a reconnect replay repairs an approval patch missed after a stale Send cut", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Finish across an SSE gap");
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:02:00.000Z",
      bridgeStateRevision: "2",
    });

    const staleCutTerminal = cloneState(state);
    staleCutTerminal.bridgeStateRevision = "4";
    staleCutTerminal.bridgeStateCoveredThroughRevision = "0";
    harness.emitRawServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: staleCutTerminal,
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );

    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "manual",
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a full state suppresses a delayed mutable patch that its cut already covers", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed peer",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the command correlation ID.",
    );

    const covered = cloneState(state);
    covered.approvalMode = "everything";
    covered.sessions.find((session) => session.id === "session-1")!.approvalMode =
      "everything";
    covered.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed peer";
    harness.queueNextStatePublication("3", "2");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: covered,
    });
    assert.equal(await command, true);

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "manual",
      bridgeStateRevision: "2",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a newer approval patch wins over an older command-owned approval field", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("set_session_approval_mode", {
      sessionId: "session-1",
      approvalMode: "low-risk",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the approval command correlation ID.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    const stale = cloneState(state);
    stale.approvalMode = "low-risk";
    stale.sessions.find((session) => session.id === "session-1")!.approvalMode =
      "low-risk";
    harness.queueNextStatePublication("2", "1");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: stale,
    });
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a visible unavailable terminal selects the authoritative fallback Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Delete this target");
    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      bridgeStateRevision: "2",
    });
    const authoritative = cloneState(state);
    authoritative.sessions = authoritative.sessions.filter(
      (session) => session.id !== "session-1",
    );
    activateStateSession(authoritative, "session-2");
    authoritative.approvalMode = "everything";
    authoritative.sessions.find((session) => session.id === "session-2")!
      .approvalMode = "everything";
    harness.setServerState(authoritative);
    authoritative.bridgeStateRevision = "3";
    authoritative.bridgeStateCoveredThroughRevision = "2";
    harness.emitRawServerEvent({
      type: "error",
      sendId,
      sessionId: "session-1",
      message: "The target Session is unavailable.",
      promptPersistence: "not_persisted",
      sendFailureKind: "session_unavailable",
      state: authoritative,
    });
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Send to the fallback");
    harness.click("#sendButton");
    await waitFor(
      () => harness.calls.filter((call) => call.path === "/send").length === 2,
      "Expected a second Send request.",
    );
    const secondSend = harness.calls.filter((call) => call.path === "/send")[1];
    assert.ok(secondSend);
    assert.deepEqual(secondSend.jsonBody, {
      prompt: "Send to the fallback",
      sessionId: "session-2",
    });
    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("selecting another Session replaces rather than unions its event projection", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "bass-only",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "assistant",
    content: "Bass only event",
  }];
  const harness = await createDialogHarness(state);
  try {
    const selected = cloneState(state);
    selected.events = [{
      id: "lead-only",
      createdAt: "2026-08-01T00:01:00.000Z",
      kind: "assistant",
      content: "Lead only event",
    }];
    harness.setServerState(selected);
    await selectSession(harness, "session-2");

    assert.match(harness.document.body.textContent || "", /Lead only event/);
    assert.doesNotMatch(harness.document.body.textContent || "", /Bass only event/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background terminal advances the causal marker before an older command state", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed peer",
    });
    await waitFor(
      () => harness.commandIds.length === 2,
      "Expected the peer command correlation ID.",
    );

    const terminal = cloneState(state);
    activateStateSession(terminal, "session-2");
    terminal.sessions.find((session) => session.id === "session-1")!.title =
      "New terminal title";
    harness.queueNextStatePublication("4", "1");
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminal,
    });

    const olderCommandState = cloneState(state);
    activateStateSession(olderCommandState, "session-2");
    olderCommandState.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed peer";
    harness.queueNextStatePublication("3", "2");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[1],
      state: olderCommandState,
    });
    assert.equal(await command, true);
    await harness.settle();

    assertBackgroundSessionTitle(harness, "New terminal title");
    harness.releaseHeldCommandResponse();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unversioned mutable patch is ignored", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("cross-type Session metadata events keep the newest timestamp", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const meta = harness.document.querySelector<HTMLElement>(
      '.session-entry[data-session-id="session-2"] .session-meta',
    );
    assert.ok(meta);
    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      updatedAt: "2026-08-22T08:02:00.000Z",
      bridgeStateRevision: "2",
    });
    const approvalTimestamp = meta.title;
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-2",
      modelSelection: { profileId: "profile-1", model: "model-a" },
      updatedAt: "2026-08-24T08:04:00.000Z",
      bridgeStateRevision: "4",
    });
    const modelTimestamp = meta.title;
    assert.notEqual(modelTimestamp, approvalTimestamp);

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "low-risk",
      updatedAt: "2026-08-23T08:03:00.000Z",
      bridgeStateRevision: "3",
    });
    assert.equal(meta.title, modelTimestamp);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a covered confirmation publication still restores its correlation UI", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Prepare a confirmation");
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed while waiting",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the peer command correlation ID.",
    );

    const covered = cloneState(state);
    covered.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed while waiting";
    covered.sessionActivities = [{
      sessionId: "session-1",
      status: "waiting_confirmation",
      message: "Waiting for confirmation",
      unread: false,
    }];
    harness.queueNextStatePublication("3", "2");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: covered,
    });
    assert.equal(await command, true);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "covered-confirmation",
      message: "Apply the covered change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
      bridgeStateRevision: "2",
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent || "",
      /Apply the covered change/,
    );
    harness.releaseHeldCommandResponse();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a fuller snapshot supersedes an earlier local approval marker it covers", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed with newer approval",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the peer command correlation ID.",
    );

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "2",
    });
    const fuller = cloneState(state);
    fuller.sessions.find((session) => session.id === "session-1")!.approvalMode =
      "low-risk";
    fuller.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed with newer approval";
    fuller.approvalMode = "low-risk";
    harness.queueNextStatePublication("4", "3");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: fuller,
    });
    assert.equal(await command, true);

    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "low-risk",
      bridgeStateRevision: "3",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a fuller snapshot supersedes an earlier progress marker it covers", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Run multiple phases");
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("rename_session", {
      sessionId: "session-2",
      title: "Renamed during progress",
    });
    await waitFor(
      () => harness.commandIds.length === 1,
      "Expected the peer command correlation ID.",
    );

    harness.emitServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Phase A",
      bridgeStateRevision: "2",
    });
    const fuller = cloneState(state);
    fuller.sessions.find((session) => session.id === "session-2")!.title =
      "Renamed during progress";
    fuller.sessionActivities = [{
      sessionId: "session-1",
      status: "running",
      message: "Phase B",
      unread: false,
    }];
    harness.queueNextStatePublication("4", "3");
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: fuller,
    });
    assert.equal(await command, true);

    harness.emitServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Phase B",
      bridgeStateRevision: "3",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Phase B",
    );
    harness.releaseHeldCommandResponse();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background partial merge does not claim coverage for its visible peer", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Background request");
    await selectSession(harness, "session-2");

    const terminal = cloneState(state);
    terminal.activeSessionId = "session-2";
    terminal.approvalMode = "everything";
    terminal.sessions.find((session) => session.id === "session-2")!.approvalMode =
      "everything";
    harness.queueNextStatePublication("4", "3");
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: terminal,
    });
    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-2",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const fullStateFirst of [false, true]) {
  test(`confirmation activity is canonical when the ${
    fullStateFirst ? "full state" : "resolved patch"
  } arrives first`, async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    const harness = await createDialogHarness(state);
    try {
      const sendId = await startHeldSend(harness, "Prepare confirmation ordering");
      harness.emitServerEvent({
        type: "confirm_request",
        sendId,
        sessionId: "session-1",
        id: "ordered-confirmation",
        message: "Apply the ordered change?",
        groups: [{ title: "Tracks", rows: ["Create track"] }],
        bridgeStateRevision: "2",
      });

      const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
      harness.holdNextCommandResponse();
      const command = ui.runCommand("rename_session", {
        sessionId: "session-2",
        title: "Renamed during confirmation",
      });
      await waitFor(
        () => harness.commandIds.length === 1,
        "Expected the peer command correlation ID.",
      );
      const fullState = cloneState(state);
      fullState.sessions.find((session) => session.id === "session-2")!.title =
        "Renamed during confirmation";
      fullState.sessionActivities = [{
        sessionId: "session-1",
        status: "running",
        message: "Applying confirmed changes",
        unread: false,
      }];
      const resolved = {
        type: "confirm_resolved",
        sendId,
        sessionId: "session-1",
        id: "ordered-confirmation",
        bridgeStateRevision: "3",
        activity: {
          status: "running",
          message: "Applying confirmed changes",
        },
      };
      const publishFullState = () => {
        harness.queueNextStatePublication("4", "3");
        harness.emitServerEvent({
          type: "state",
          commandId: harness.commandIds[0],
          state: fullState,
        });
      };

      if (fullStateFirst) {
        publishFullState();
        assert.equal(await command, true);
        harness.emitServerEvent(resolved);
      } else {
        harness.emitServerEvent(resolved);
        publishFullState();
        assert.equal(await command, true);
      }
      await harness.settle();

      assert.equal(
        harness.document.querySelector("#status")?.textContent,
        "Applying confirmed changes",
      );
      harness.releaseHeldCommandResponse();
      harness.releaseHeldSend();
      await harness.settle();
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("confirmation HTTP completion cannot clear newer canonical activity", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Apply a confirmed change");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "held-confirmation",
      message: "Apply this change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
      bridgeStateRevision: "2",
    });
    harness.holdNextConfirmation();
    harness.click(".confirm-card button.primary");
    await waitFor(
      () => harness.calls.some((call) => call.path === "/confirm"),
      "Expected the confirmation response to be held.",
    );

    harness.emitServerEvent({
      type: "confirm_resolved",
      sendId,
      sessionId: "session-1",
      id: "held-confirmation",
      bridgeStateRevision: "3",
      activity: {
        status: "running",
        message: "Applying confirmed changes",
      },
    });
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a confirmation HTTP receipt cannot cover a delayed approval publication", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Confirm across both channels");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "cross-channel-confirmation",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    const delayedApproval = harness.deferServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
    });

    harness.click(".confirm-card button.primary");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );

    harness.emitRawServerEvent(delayedApproval);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an authoritative confirmation SSE prevents response-loss recovery from stopping the send", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Keep applying after response loss");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "response-lost-confirmation",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    harness.holdNextConfirmation();
    harness.rejectNextConfirmationResponseAfterCommit(
      "confirmation response lost after commit",
    );
    harness.click(".confirm-card button.primary");
    await waitFor(
      () => harness.calls.some((call) => call.path === "/confirm"),
      "Expected the confirmation request to start.",
    );

    harness.emitServerEvent({
      type: "confirm_resolved",
      sendId,
      sessionId: "session-1",
      id: "response-lost-confirmation",
      activity: {
        status: "running",
        message: "Applying confirmed changes",
      },
    });
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.deepEqual(harness.stopIds, []);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("confirmation response-loss waits for its delayed authoritative SSE before stopping", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Wait for delayed confirmation SSE");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "delayed-response-lost-confirmation",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    harness.holdNextConfirmation();
    harness.rejectNextConfirmationResponseAfterCommit(
      "confirmation response lost before SSE delivery",
    );
    harness.click(".confirm-card button.primary");
    await waitFor(
      () => harness.calls.some((call) => call.path === "/confirm"),
      "Expected the confirmation request to start.",
    );

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.deepEqual(harness.stopIds, []);
    harness.emitServerEvent({
      type: "confirm_resolved",
      sendId,
      sessionId: "session-1",
      id: "delayed-response-lost-confirmation",
      activity: {
        status: "running",
        message: "Applying confirmed changes",
      },
    });
    await harness.settle();

    assert.deepEqual(harness.stopIds, []);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a successor confirmation releases the prior response-loss wait", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Advance to another confirmation");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "lost-prior-confirmation",
      message: "Apply the first change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    harness.holdNextConfirmation();
    harness.rejectNextConfirmationResponseAfterCommit(
      "first confirmation response and SSE were lost",
    );
    harness.click(".confirm-card button.primary");
    await waitFor(
      () => harness.calls.some((call) => call.path === "/confirm"),
      "Expected the first confirmation request to start.",
    );
    harness.releaseHeldConfirmation();
    await harness.settle();

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "successor-confirmation",
      message: "Apply the second change?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });
    await harness.settle();
    const applyButton = harness.document.querySelector<HTMLButtonElement>(
      ".confirm-card button.primary",
    );
    assert.ok(applyButton);
    assert.equal(applyButton.disabled, false);
    applyButton.click();
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      2,
    );
    assert.deepEqual(harness.stopIds, []);
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Applying confirmed changes",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed same-ID confirmation replay cannot restore a resolved decision", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Resolve before replay delivery");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "resolved-before-replay",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    const delayedReplay = harness.deferServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "resolved-before-replay",
      message: "Apply the change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    harness.click(".confirm-card button.primary");
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    harness.emitRawServerEvent(delayedReplay);
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      1,
    );
    assert.deepEqual(harness.stopIds, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a mismatched resolved generation cannot poison later confirmations", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Keep confirmation generations causal");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "generation-one",
      message: "Apply the first change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    harness.emitRawServerEvent({
      type: "confirm_resolved",
      sendId,
      sessionId: "session-1",
      id: "generation-one",
      confirmationGeneration: 2,
      activity: {
        status: "running",
        message: "Applying confirmed changes",
      },
      bridgeStateRevision: "2",
    });

    harness.click(".confirm-card button.primary");
    await harness.settle();
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "generation-two",
      message: "Apply the second change?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the second change/,
    );
    assert.deepEqual(harness.stopIds, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("confirmation generations are consecutive and immutable once published", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Keep confirmation identity immutable");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "immutable-generation-one",
      message: "Apply the original plan?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    const activity = {
      status: "waiting_confirmation",
      message: "Waiting for confirmation",
    };
    harness.emitRawServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "immutable-generation-one",
      confirmationGeneration: 1,
      message: "Apply changed replay content?",
      groups: [{ title: "Tracks", rows: ["Delete track"] }],
      activity,
      bridgeStateRevision: "2",
    });
    harness.emitRawServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "skipped-generation-three",
      confirmationGeneration: 3,
      message: "Apply a skipped generation?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
      activity,
      bridgeStateRevision: "2",
    });
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the original plan/,
    );
    assert.doesNotMatch(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /changed replay|skipped generation/i,
    );

    harness.click(".confirm-card button.primary");
    await harness.settle();
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "consecutive-generation-two",
      message: "Apply the next plan?",
      groups: [{ title: "Tracks", rows: ["Rename track"] }],
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the next plan/,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("confirmation rendering does not invent client-only action diff quotas", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Render the complete validated plan");
    const groups = Array.from({ length: 65 }, (_, index) => ({
      title: `Group ${index + 1}`,
      rows: [`Action ${index + 1}`],
    }));
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "large-valid-diff",
      message: "Apply the complete plan?",
      groups,
    });
    await harness.settle();

    const confirmationText =
      harness.document.querySelector(".confirm-card")?.textContent ?? "";
    assert.match(confirmationText, /Group 65/);
    assert.match(confirmationText, /Action 65/);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a malformed confirmation publication is ignored before projection mutation", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Validate confirmation payloads");
    assert.doesNotThrow(() => harness.emitRawServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      id: "validated-confirmation",
      confirmationGeneration: 1,
      kind: "apply",
      message: "Apply the valid change?",
      groups: [null],
      activity: {
        status: "waiting_confirmation",
        message: "Waiting for confirmation",
      },
      bridgeStateRevision: "2",
    }));
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    harness.emitRawServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      id: "validated-confirmation",
      confirmationGeneration: 1,
      kind: "apply",
      message: "Apply the valid change?",
      groups: [],
      activity: {
        status: "waiting_confirmation",
        message: "Waiting for confirmation",
      },
      bridgeStateRevision: "2",
    });
    assert.equal(harness.document.querySelector(".confirm-card"), null);

    harness.emitRawServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      id: "validated-confirmation",
      confirmationGeneration: 1,
      kind: "apply",
      message: "Apply the valid change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
      activity: {
        status: "waiting_confirmation",
        message: "Waiting for confirmation",
      },
      bridgeStateRevision: "2",
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply the valid change/,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a malformed Session event is ignored before timeline mutation", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Validate Session events");
    assert.doesNotThrow(() => harness.emitRawServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      event: null,
      bridgeStateRevision: "2",
    }));
    assert.equal(
      harness.document.querySelector('[data-event-id="valid-wire-event"]'),
      null,
    );

    harness.emitRawServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 0,
      event: {
        id: "valid-wire-event",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "assistant",
        content: "Valid event after malformed input",
      },
      bridgeStateRevision: "2",
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector('[data-event-id="valid-wire-event"]')
        ?.textContent ?? "",
      /Valid event after malformed input/,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("state-change decoders require their event-specific wire fields", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const followUp = harness.document.querySelector<HTMLSelectElement>(
      "#defaultFollowUpBehavior",
    );
    assert.equal(followUp?.value, "queue");
    harness.emitRawServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      bridgeStateRevision: "2",
    });
    assert.equal(followUp?.value, "queue");

    const approval = harness.document.querySelector<HTMLSelectElement>(
      "#approvalMode",
    );
    assert.equal(approval?.value, "manual");
    harness.emitRawServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "2",
    });
    assert.equal(approval?.value, "manual");

    const sendId = await startHeldSend(harness, "Validate progress fields");
    harness.emitRawServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Progress with an extra field",
      activity: {
        status: "running",
        message: "Progress with an extra field",
      },
      bridgeStateRevision: "3",
      extra: true,
    });
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Progress with an extra field/,
    );
    harness.emitRawServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      activity: { status: "running", message: "Malformed progress" },
      bridgeStateRevision: "3",
    });
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Malformed progress/,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("error envelopes are validated before terminal or confirmation mutation", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Validate error envelopes");
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "error-envelope-confirmation",
      message: "Apply the pending change?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });
    const malformedErrors = [
      {
        type: "error",
        sendId,
        sessionId: "session-1",
        promptPersistence: "not_persisted",
      },
      {
        type: "error",
        sendId,
        sessionId: "session-1",
        commandId: "command-mixed",
        message: "Mixed correlation",
        promptPersistence: "not_persisted",
      },
      {
        type: "error",
        sendId,
        sessionId: "session-1",
        message: "Invalid nested state",
        promptPersistence: "persisted",
        state: { ...cloneState(state), sessions: [null] },
      },
    ];
    for (const payload of malformedErrors) {
      assert.doesNotThrow(() => harness.emitRawServerEvent(payload));
    }
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.ok(harness.document.querySelector(".confirm-card"));

    harness.emitRawServerEvent({
      type: "error",
      message: "A separate presentation error",
    });
    await harness.settle();
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /separate presentation error/,
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.ok(harness.document.querySelector(".confirm-card"));

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session event decoder rejects invalid nested discriminated contracts", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Validate nested event fields");
    const base = {
      createdAt: "2026-08-23T00:00:00.000Z",
      content: "Malformed nested event",
    };
    const malformedEvents = [
      {
        ...base,
        id: "bad-attachment-event",
        kind: "user",
        attachments: [{
          id: "attachment_bad",
          kind: "image",
          fileName: "bad.mp3",
          mediaType: "audio/mpeg",
          byteLength: 1,
          sha256: "a".repeat(64),
        }],
      },
      {
        ...base,
        id: "bad-citation-event",
        kind: "assistant",
        citations: [{ url: "javascript:alert(1)", title: "Unsafe" }],
      },
      {
        ...base,
        id: "bad-search-event",
        kind: "web_search",
        webSearch: {
          id: "bad-search",
          status: "searching",
          action: "search",
          queries: ["query"],
          sources: [],
        },
      },
      {
        ...base,
        id: "bad-recovery-event",
        kind: "apply_result",
        recovery: {
          active: true,
          completedActionDigests: ["not-a-digest"],
          extra: true,
        },
      },
      {
        ...base,
        id: "bad-steering-ack-event",
        kind: "user",
        steeringAck: {
          sendId,
          steerId: "bad-steering-ack",
          extra: true,
        },
      },
    ];
    for (const [index, event] of malformedEvents.entries()) {
      harness.emitRawServerEvent({
        type: "session_event",
        sendId,
        sessionId: "session-1",
        event,
        bridgeStateRevision: String(index + 2),
      });
      assert.equal(
        harness.document.querySelector(`[data-event-id="${event.id}"]`),
        null,
      );
    }
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session event decoder accepts the shared two-audio attachment quota", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Validate shared audio quotas");
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      event: {
        id: "two-audio-wire-event",
        createdAt: "2026-08-23T00:00:00.000Z",
        kind: "user",
        content: "Listen to both references",
        attachments: [
          pendingAudio("wire-audio-wav", "take.wav", "audio/wav", 1_024, 2),
          pendingAudio("wire-audio-mp3", "reference.mp3", "audio/mpeg", 2_048, 3),
        ],
      },
    });
    await harness.settle();

    const event = harness.document.querySelector(
      '[data-event-id="two-audio-wire-event"]',
    );
    assert.match(event?.textContent ?? "", /take\.wav/);
    assert.match(event?.textContent ?? "", /reference\.mp3/);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a malformed authoritative state cannot mutate or settle its Send", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Reject malformed full state");
    const malformedStates = [
      { ...cloneState(state), sessions: [null] },
      { ...cloneState(state), events: [null] },
      {
        ...cloneState(state),
        events: [{
          id: "legacy-path-event",
          createdAt: "2026-08-23T00:00:00.000Z",
          kind: "user",
          content: "Legacy path",
          attachments: [{
            id: "legacy-path-attachment",
            kind: "image",
            fileName: "/Users/alice/private.png",
            mediaType: "image/png",
            byteLength: 1,
            sha256: "a".repeat(64),
          }],
        }],
      },
      {
        ...cloneState(state),
        settings: { ...cloneState(state).settings, profiles: [null] },
      },
      { ...cloneState(state), availableModels: [null] },
      {
        ...cloneState(state),
        availableModels: [{
          id: "model-missing-evidence",
          displayName: "Missing evidence",
          capabilities: cloneState(state).capabilities,
        }],
      },
      {
        ...cloneState(state),
        capabilityEvidence: {
          ...capabilityEvidence(),
          reasoning: "guessed",
        },
      },
      {
        ...cloneState(state),
        capabilityEvidence: {
          ...capabilityEvidence(),
          inputs: {
            ...capabilityEvidence().inputs,
            image: "supported",
          },
        },
      },
      {
        ...cloneState(state),
        capabilityEvidence: {
          ...capabilityEvidence(),
          maxOutputTokens: "unverified",
        },
      },
      {
        ...cloneState(state),
        capabilities: {
          ...cloneState(state).capabilities,
          contextWindowTokens: MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS + 1,
        },
      },
      {
        ...cloneState(state),
        availableModels: [{
          id: " ",
          displayName: "Whitespace model",
          capabilities: cloneState(state).capabilities,
          capabilityEvidence: capabilityEvidence(),
        }],
      },
      {
        ...cloneState(state),
        availableModels: [{
          id: "model-conflicting-evidence",
          displayName: "Conflicting evidence",
          capabilities: cloneState(state).capabilities,
          capabilityEvidence: {
            ...capabilityEvidence(),
            temperature: "unsupported",
          },
        }],
      },
      {
        ...cloneState(state),
        availableModels: [{
          id: "model-invalid-evidence",
          displayName: "Invalid evidence",
          capabilities: cloneState(state).capabilities,
          capabilityEvidence: {
            ...capabilityEvidence(),
            contextWindowTokens: "supported",
          },
        }],
      },
      {
        ...cloneState(state),
        availableModels: Array.from(
          { length: MAX_DISCOVERED_MODEL_COUNT + 1 },
          (_, index) => ({
            id: `model-${index}`,
            displayName: `Model ${index}`,
            capabilities: cloneState(state).capabilities,
            capabilityEvidence: capabilityEvidence(),
          }),
        ),
      },
      { ...cloneState(state), sessionActivities: [null] },
      {
        ...cloneState(state),
        previousSessions: [cloneState(state).sessions[0]],
      },
    ];
    for (const malformed of malformedStates) {
      assert.doesNotThrow(() => harness.emitRawServerEvent({
        type: "done",
        sendId,
        sessionId: "session-1",
        state: malformed,
      }));
    }
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.match(harness.document.body.textContent ?? "", /Bass session/);

    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: cloneState(state),
    });
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("malformed initial state fails closed before UI factories or SSE start", async () => {
  const malformed = {
    ...stateFixture(),
    sessions: [null],
  } as unknown as Parameters<typeof createDialogHarness>[0];
  const harness = await createDialogHarness(malformed);
  try {
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /invalid initial state/i,
    );
    assert.equal(
      harness.document.querySelector(".app")?.hasAttribute("inert"),
      true,
    );
    assert.deepEqual(harness.eventSourceUrls, []);
    assert.equal("LiveSmithUI" in harness.window, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("command response-loss rejects a malformed state refresh", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const malformed = cloneState(state) as unknown as Record<string, unknown>;
    malformed.sessions = [null];
    harness.setServerState(
      malformed as unknown as Parameters<typeof harness.setServerState>[0],
    );
    harness.truncateNextCommandResponseAfterCommit();
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    const command = ui.runCommand("save_global_settings", {
      defaultFollowUpBehavior: "steer",
    });
    await waitFor(
      () => harness.calls.some((call) => call.path === "/command"),
      "Expected the command request before the stream gap.",
    );
    harness.emitServerEventError();
    assert.equal(await command, false);
    await harness.settle();
    harness.emitServerEventOpen();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.value,
      "queue",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be reconciled|authoritative state|could not be confirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a contradictory command error envelope cannot apply its supplied state", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const injected = cloneState(state);
  injected.sessions[0]!.title = "Injected contradictory state";
  injected.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.failNextCommand(
      "The command outcome is unknown.",
      undefined,
      {
        commandOutcome: "unknown",
        state: injected,
        reconciliationRequired: true,
      },
    );
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    const command = ui.runCommand("save_global_settings", {
      defaultFollowUpBehavior: "steer",
    });
    await waitFor(
      () => harness.calls.some((call) => call.path === "/command"),
      "Expected the contradictory command response before reconciliation.",
    );
    harness.emitServerEventError();
    await command;
    await harness.settle();

    assert.doesNotMatch(
      harness.document.body.textContent ?? "",
      /Injected contradictory state/,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.value,
      "queue",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an uncorrelated unknown command envelope cannot apply its supplied state", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const injected = cloneState(state);
  injected.sessions[0]!.title = "Injected uncorrelated state";
  injected.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.omitNextCommandId();
    harness.failNextCommand(
      "The command outcome is unknown.",
      undefined,
      { commandOutcome: "unknown", state: injected },
    );
    const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
    const command = ui.runCommand("save_global_settings", {
      defaultFollowUpBehavior: "steer",
    });
    await waitFor(
      () => harness.calls.some((call) => call.path === "/command"),
      "Expected the uncorrelated command response before reconciliation.",
    );
    harness.emitServerEventError();
    await command;
    await harness.settle();

    assert.doesNotMatch(
      harness.document.body.textContent ?? "",
      /Injected uncorrelated state/,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.value,
      "queue",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("authoritative history keeps strict legacy attachment compatibility", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Load legacy attachment history");
    const authoritative = cloneState(state);
    authoritative.events = [{
      id: "legacy-audio-event",
      createdAt: "2025-01-01T00:00:00.000Z",
      kind: "user",
      content: "Legacy audio reference",
      attachments: [{
        id: "legacy-audio",
        kind: "audio",
        fileName: "legacy.mp3",
        mediaType: "audio/mpeg",
        byteLength: 1_024,
        sha256: "d".repeat(64),
      }],
    }];
    harness.emitServerEvent({
      type: "done",
      sendId,
      sessionId: "session-1",
      state: authoritative,
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector('[data-event-id="legacy-audio-event"]')
        ?.textContent ?? "",
      /legacy\.mp3/,
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const responseLoss of [false, true]) {
  test(`an unrelated command ${
    responseLoss ? "state refresh" : "response"
  } adopts uncontested active context as one projection`, async () => {
    const state = stateFixture();
    state.openSettingsOnLoad = false;
    state.previousSessions = [{
      ...state.sessions[1]!,
      id: "previous-session",
      title: "Previous lead work",
      projectKey: "previous-project",
    }];
    const harness = await createDialogHarness(state);
    try {
      const ui = (harness.window as unknown as { LiveSmithUI: DialogUi }).LiveSmithUI;
      if (responseLoss) harness.truncateNextCommandResponseAfterCommit();
      harness.holdNextCommandResponse();
      const command = ui.runCommand("rename_session", {
        sessionId: "session-2",
        title: "Renamed peer",
      });
      await waitFor(
        () => harness.commandIds.length === 1,
        "Expected the peer command to start.",
      );
      harness.emitServerEvent({
        type: "approval_mode_changed",
        sessionId: "session-1",
        approvalMode: "everything",
      });
      const authoritative = cloneState(state);
      authoritative.sessions.find((session) => session.id === "session-1")!
        .approvalMode = "everything";
      authoritative.approvalMode = "everything";
      authoritative.sessions.find((session) => session.id === "session-2")!.title =
        "Renamed peer";
      authoritative.contextSummary = "Fresh context";
      authoritative.sessionContinueTarget = { kind: "track", label: "Keys" };
      harness.setServerState(authoritative);
      if (responseLoss) harness.emitServerEventError();
      harness.releaseHeldCommandResponse();
      assert.equal(await command, true);
      await harness.settle();

      assert.match(
        harness.document.querySelector("#context")?.textContent ?? "",
        /Fresh context/,
      );
      assert.match(
        harness.document.querySelector(
          '[data-continue-session-id="previous-session"]',
        )?.getAttribute("aria-label") ?? "",
        /current track Keys/,
      );
      assert.equal(
        harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
        "everything",
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
