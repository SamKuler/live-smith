import assert from "node:assert/strict";
import test from "node:test";

import {
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

async function startHeldSend(harness: Harness, prompt: string): Promise<string> {
  harness.holdNextSend();
  harness.input("#prompt", prompt);
  harness.click("#sendButton");
  await waitForCondition(
    () => Boolean(harness.sendIds.at(-1)),
    "Expected a held send to start.",
  );
  return harness.sendIds.at(-1)!;
}

async function selectSession(harness: Harness, sessionId: string): Promise<void> {
  const row = harness.document.querySelector<HTMLButtonElement>(
    `.session-entry[data-session-id="${sessionId}"] .session-row`,
  );
  assert.ok(row);
  row.click();
  await harness.settle();
}

function usageValue(harness: Harness): string {
  return harness.document.querySelector("#contextUsageValue")?.textContent ?? "";
}

function usageUpdate(
  sendId: string,
  sessionId: string,
  modelTurnEpoch: number,
  usedTokens: number | null,
): Record<string, unknown> {
  return {
    type: "context_usage_update",
    sendId,
    sessionId,
    modelTurnEpoch,
    usage: usedTokens === null
      ? null
      : { usedTokens, contextWindowTokens: 1_000 },
  };
}

function modelTurnState(
  sendId: string,
  contextUsage: Record<string, unknown> | null | undefined,
  modelTurnEpoch = 1,
): Record<string, unknown> {
  return {
    type: "model_turn_state",
    sendId,
    sessionId: "session-1",
    modelTurnEpoch,
    assistantDraft: "",
    webSearchUpdates: [],
    ...(contextUsage === undefined ? {} : { contextUsage }),
    progress: "Reading model response",
    resolvedConfirmationGeneration: 0,
  };
}

test("context usage rejects stale, mismatched, and malformed updates per Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const firstSendId = await startHeldSend(harness, "Measure Bass context");
    harness.emitServerEvent(usageUpdate(firstSendId, "session-1", 1, 250));
    assert.equal(usageValue(harness), "25%");

    for (const payload of [
      usageUpdate(firstSendId, "session-1", 0, 900),
      usageUpdate("wrong-send", "session-1", 2, 900),
      { ...usageUpdate(firstSendId, "session-1", 2, 900), extra: true },
      {
        ...usageUpdate(firstSendId, "session-1", 2, 900),
        usage: { usedTokens: -1, contextWindowTokens: 1_000 },
      },
      {
        ...usageUpdate(firstSendId, "session-1", 2, 900),
        usage: {
          usedTokens: 900,
          contextWindowTokens: 1_000,
          extra: true,
        },
      },
      {
        ...usageUpdate(firstSendId, "session-1", 2, 900),
        usage: { usedTokens: 1, contextWindowTokens: 0.5 },
      },
    ]) {
      harness.emitRawServerEvent(payload);
      assert.equal(usageValue(harness), "25%");
    }

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(usageValue(harness), "25%", "terminal sends retain exact usage");

    await selectSession(harness, "session-2");
    assert.equal(usageValue(harness), "?");
    const secondSendId = await startHeldSend(harness, "Measure Lead context");
    harness.emitServerEvent(usageUpdate(secondSendId, "session-2", 1, 500));
    assert.equal(usageValue(harness), "50%");
    harness.emitRawServerEvent(usageUpdate(firstSendId, "session-2", 2, 900));
    assert.equal(usageValue(harness), "50%", "an old send cannot replace usage");

    await selectSession(harness, "session-1");
    assert.equal(usageValue(harness), "25%");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("accepted missing usage clears evidence while send-start reconnect preserves it", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const firstSendId = await startHeldSend(harness, "Initial exact usage");
    harness.emitServerEvent(usageUpdate(firstSendId, "session-1", 1, 250));
    assert.equal(usageValue(harness), "25%");
    harness.releaseHeldSend();
    await harness.settle();

    const sendId = await startHeldSend(harness, "Reconnect usage");
    harness.emitServerEvent(modelTurnState(sendId, undefined, 0));
    assert.equal(usageValue(harness), "25%");

    harness.emitServerEvent(modelTurnState(sendId, {
      usedTokens: 400,
      contextWindowTokens: 1_000,
    }));
    assert.equal(usageValue(harness), "40%");

    harness.emitRawServerEvent(modelTurnState(sendId, {
      usedTokens: 401.5,
      contextWindowTokens: 1_000,
    }));
    assert.equal(usageValue(harness), "40%");

    harness.emitServerEvent(modelTurnState(sendId, null, 2));
    assert.equal(usageValue(harness), "?", "reconnect recovers a missed clear");
    harness.emitServerEvent(modelTurnState(sendId, {
      usedTokens: 300,
      contextWindowTokens: 1_000,
    }, 2));
    assert.equal(usageValue(harness), "30%");
    harness.emitServerEvent(usageUpdate(sendId, "session-1", 3, null));
    assert.equal(usageValue(harness), "?", "accepted missing usage clears live");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("authoritative Session removal clears retained context usage", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Usage before deletion");
    harness.emitServerEvent(usageUpdate(sendId, "session-1", 1, 250));
    harness.releaseHeldSend();
    await harness.settle();

    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
      };
    }).LiveSmithUI;
    assert.equal(
      await ui.runCommand("delete_session", { sessionId: "session-1" }),
      true,
    );
    assert.equal(usageValue(harness), "?");

    const reintroduced = stateFixture();
    reintroduced.openSettingsOnLoad = false;
    harness.setServerState(reintroduced);
    assert.equal(
      await ui.runCommand("select_session", { sessionId: "session-1" }),
      true,
    );
    assert.equal(usageValue(harness), "?");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("changing the active Profile endpoint clears context usage for the same model id", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Usage before endpoint change");
    harness.emitServerEvent(usageUpdate(sendId, "session-1", 1, 250));
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(usageValue(harness), "25%");

    const changed = JSON.parse(JSON.stringify(state)) as typeof state;
    const connection = changed.settings.profiles[0]?.connection;
    assert.equal(connection?.kind, "direct-api");
    if (connection?.kind === "direct-api") {
      connection.baseUrl = "https://replacement.example/v1";
    }
    harness.setServerState(changed);
    const ui = (harness.window as unknown as {
      LiveSmithUI: {
        runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
      };
    }).LiveSmithUI;
    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "manual",
      }),
      true,
    );
    assert.equal(usageValue(harness), "?");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
