import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneState,
  commandCalls,
  createDialogHarness,
  modelStateSourceFixture,
  profileFixture,
  profileRevisionFixture,
  runtimeSummaryForHarnessProfile,
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
  await waitForCondition(
    () => commandCalls(harness).some((call) =>
      call.body && typeof call.body === "object" &&
      "kind" in call.body && call.body.kind === "select_session" &&
      "sessionId" in call.body && call.body.sessionId === sessionId
    ),
    `Expected ${sessionId} selection to reach the bridge.`,
  );
  await harness.settle();
  await waitForCondition(
    () => !row.hasAttribute("data-switching") &&
      row.getAttribute("aria-pressed") === "true",
    `Expected ${sessionId} selection to finish.`,
  );
}

function usageValue(harness: Harness): string {
  return harness.document.querySelector("#contextUsageValue")?.textContent ?? "";
}

test("persisted context visibility applies on initial render", async () => {
  const state = stateFixture();
  state.settings.showContextUsage = false;
  state.settings.contextUsageVisibilityRevision = "4";
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#showContextUsage")?.checked,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("context usage visibility saves globally and follows newer settings", async () => {
  const harness = await createDialogHarness();
  try {
    const indicator = harness.document.querySelector<HTMLElement>("#contextUsage");
    const control = harness.document.querySelector<HTMLInputElement>(
      "#showContextUsage",
    );
    assert.ok(indicator);
    assert.ok(control);
    assert.equal(indicator.hidden, false);
    assert.equal(control.checked, true);

    harness.click("#showContextUsage");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        showContextUsage: false,
      },
    });
    assert.equal(indicator.hidden, true);
    assert.equal(control.checked, false);

    await selectSession(harness, "session-2");
    assert.equal(indicator.hidden, true);
    assert.equal(control.checked, false);

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: true,
      contextUsageVisibilityRevision: "2",
      commandId: "external-context-visibility",
    });
    assert.equal(indicator.hidden, false);
    assert.equal(control.checked, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed context visibility save restores the confirmed setting", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextCommand("Could not save context visibility.");
    harness.click("#showContextUsage");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#showContextUsage")?.checked,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a newer context visibility event supersedes a pending local toggle", async () => {
  const harness = await createDialogHarness();
  let commandReleased = false;
  try {
    harness.holdNextCommandResponse();
    harness.click("#showContextUsage");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: false,
      contextUsageVisibilityRevision: "1",
      commandId,
    });
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      true,
    );

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "0",
      showContextUsage: true,
      contextUsageVisibilityRevision: "2",
      commandId: "external-context-visibility-2",
    });
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#showContextUsage")?.checked,
      true,
    );

    harness.releaseHeldCommandResponse();
    commandReleased = true;
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a background terminal state applies newer context visibility", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(
      harness,
      "Background context visibility",
    );
    harness.emitServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Working in the background",
    });
    await selectSession(harness, "session-2");

    const hidden = stateFixture();
    hidden.openSettingsOnLoad = false;
    hidden.activeSessionId = "session-2";
    hidden.approvalMode = "low-risk";
    hidden.settings.showContextUsage = false;
    hidden.settings.contextUsageVisibilityRevision = "1";
    harness.setServerState(hidden);
    harness.releaseHeldSend();
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden === true,
      "Expected the background terminal state to hide context usage.",
    );

    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextUsage")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#showContextUsage")?.checked,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

function subscriptionState() {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "codex-subscription", provider: "openai" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = [{ model: profile.defaultModel, label: profile.defaultModel }];
  state.configuredModelsReady = true;
  state.codexAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  state.openSettingsOnLoad = false;
  return state;
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

test("a subscription auth generation change clears retained context usage", async () => {
  const state = subscriptionState();
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Usage before account change");
    harness.emitServerEvent(usageUpdate(sendId, "session-1", 1, 250));
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(usageValue(harness), "25%");

    const changed = cloneState(state);
    changed.codexAuthGeneration += 1;
    changed.codexAuth = {
      status: "signed-in",
      accountLabel: "new-account@example.test",
      planType: "pro",
      subscriptionEligible: true,
    };
    changed.availableModels = [];
    delete changed.modelCatalogLoadReceipt;
    changed.configuredModelsReady = false;
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
    assert.match(
      harness.document.querySelector("#contextUsage")?.getAttribute("aria-label") ?? "",
      /unavailable/i,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#contextUsage")?.getAttribute("aria-label") ?? "",
      /250|1,000/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Direct runtime retains context usage across subscription auth generations", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const sendId = await startHeldSend(harness, "Direct usage stays independent");
    harness.emitServerEvent(usageUpdate(sendId, "session-1", 1, 250));
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(usageValue(harness), "25%");

    const changed = cloneState(state);
    changed.codexAuthGeneration += 1;
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

    assert.equal(usageValue(harness), "25%");
    assert.match(
      harness.document.querySelector("#contextUsage")?.getAttribute("aria-label") ?? "",
      /250 of 1,000/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
