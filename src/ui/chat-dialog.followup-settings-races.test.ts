import assert from "node:assert/strict";
import test from "node:test";

import type { DefaultFollowUpBehaviorRevision } from "../model/profile.js";
import {
  createDialogHarness,
  imageCapableState,
  imageFile,
  jsonCalls,
  stateFixture,
} from "./chat-dialog.test-harness.js";

function behaviorState(
  behavior: "queue" | "steer",
  revision: DefaultFollowUpBehaviorRevision = "0",
) {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.defaultFollowUpBehavior = behavior;
  state.settings.defaultFollowUpBehaviorRevision = revision;
  return state;
}

function selectedBehavior(harness: Awaited<ReturnType<typeof createDialogHarness>>) {
  return harness.document.querySelector<HTMLSelectElement>(
    "#defaultFollowUpBehavior",
  )?.value;
}

test("a stale non-global command state cannot roll back a newer global behavior event", async () => {
  const harness = await createDialogHarness(behaviorState("queue"));
  try {
    harness.holdNextCommandResponse();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await Promise.resolve();

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "external-setting-1",
    });
    assert.equal(selectedBehavior(harness), "steer");

    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a stale attachment state cannot roll back a newer global behavior event", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextAttachment();
    harness.dropAttachmentFiles([
      imageFile(harness.window, "stale-setting.png", "image/png"),
    ]);
    await Promise.resolve();

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "external-setting-1",
    });
    assert.equal(selectedBehavior(harness), "steer");

    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a newer terminal send state adopts a missed global behavior event", async () => {
  const harness = await createDialogHarness(behaviorState("queue", "0"));
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Request before missed settings event");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.setServerState(behaviorState("steer", "1"));
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(selectedBehavior(harness), "steer");

    harness.holdNextSend();
    harness.input("#prompt", "Active request after reconciliation");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Must use the adopted Steer mode");
    harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter",
      }),
    );
    await harness.settle();

    assert.equal(jsonCalls(harness, "/steer").length, 1);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a not_persisted send still adopts its authoritative global revision", async () => {
  const harness = await createDialogHarness(behaviorState("queue", "0"));
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Request that fails before persistence");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.failNextSend(
      "The prompt was not persisted.",
      "not_persisted",
      { state: behaviorState("steer", "1") },
    );
    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Request that fails before persistence",
    );
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Request that fails before persistence/,
    );
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("a later external revision supersedes an own committed save while its HTTP response waits", async () => {
  const harness = await createDialogHarness(behaviorState("queue"));
  try {
    harness.holdNextCommandResponse();
    harness.select("#defaultFollowUpBehavior", "steer");
    await Promise.resolve();
    const ownCommandId = harness.commandIds.at(-1);
    assert.ok(ownCommandId);

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: ownCommandId,
    });
    assert.equal(selectedBehavior(harness), "steer");

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "2",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "external-setting-2",
    });
    assert.equal(selectedBehavior(harness), "queue");

    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(selectedBehavior(harness), "queue");
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("an unrelated context setting cannot supersede a pending behavior save", async () => {
  const harness = await createDialogHarness(behaviorState("queue", "0"));
  let commandReleased = false;
  try {
    harness.holdNextCommandResponse();
    harness.select("#defaultFollowUpBehavior", "steer");
    await Promise.resolve();
    assert.equal(selectedBehavior(harness), "steer");

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId: "external-context-setting",
    });
    assert.equal(selectedBehavior(harness), "steer");

    const committed = behaviorState("steer", "1");
    committed.settings.showContextUsage = false;
    committed.settings.contextUsageVisibilityRevision = "1";
    harness.setServerState(committed);
    harness.releaseHeldCommandResponse();
    commandReleased = true;
    await harness.settle();
    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a newer terminal revision supersedes an older optimistic mode", async () => {
  const harness = await createDialogHarness(behaviorState("queue", "0"));
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Session one request");
    harness.click("#sendButton");
    await Promise.resolve();
    const firstSendId = harness.sendIds[0];
    assert.ok(firstSendId);

    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Session two request");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.holdNextCommandResponse();
    harness.select("#defaultFollowUpBehavior", "steer");
    await Promise.resolve();
    assert.equal(selectedBehavior(harness), "steer");

    const newer = behaviorState("queue", "2");
    newer.activeSessionId = "session-2";
    newer.approvalMode = "low-risk";
    harness.emitServerEvent({
      type: "done",
      sendId: firstSendId,
      sessionId: "session-1",
      state: newer,
    });
    await harness.settle();
    assert.equal(selectedBehavior(harness), "queue");

    harness.input("#prompt", "Must remain queued");
    harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter",
      }),
    );
    await harness.settle();
    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /Must remain queued/,
    );

    harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("global setting fields merge independently across out-of-order events", async () => {
  const harness = await createDialogHarness(behaviorState("queue"));
  try {
    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId: "context-first",
    });
    assert.equal(selectedBehavior(harness), "queue");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      true,
    );

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId: "behavior-second",
    });
    assert.equal(selectedBehavior(harness), "steer");

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "1",
      showContextUsage: true,
      contextUsageVisibilityRevision: "2",
      commandId: "context-newer",
    });
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      false,
    );

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId: "delayed-old-context",
    });
    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("invalid and stale global behavior revisions are ignored", async () => {
  const harness = await createDialogHarness(behaviorState("steer", "3"));
  try {
    for (const revision of [-1, 1.5, "", "03", "+4", "4.0", "2", "3"]) {
      harness.emitServerEvent({
        type: "global_settings_changed",
        defaultFollowUpBehavior: "queue",
        defaultFollowUpBehaviorRevision: revision,
        showContextUsage: true,
        contextUsageVisibilityRevision: "0",
        commandId: `invalid-or-stale-${revision}`,
      });
      assert.equal(selectedBehavior(harness), "steer");
    }
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});

test("browser reconciliation compares canonical revisions by decimal order", async () => {
  const harness = await createDialogHarness(
    behaviorState("queue", "9999999999999999"),
  );
  try {
    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "steer",
      defaultFollowUpBehaviorRevision: "10000000000000000",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "larger-revision",
    });
    assert.equal(selectedBehavior(harness), "steer");

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "9999999999999999",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "lexically-larger-but-stale",
    });
    assert.equal(selectedBehavior(harness), "steer");
    assert.equal(harness.errors.length, 0);
  } finally {
    harness.close();
  }
});
