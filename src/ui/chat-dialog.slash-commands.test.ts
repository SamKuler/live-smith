import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  jsonCalls,
  modelStateSourceFixture,
  profileFixture,
  profileRevisionFixture,
  runtimeSummaryForHarnessProfile,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

function submitComposer(harness: Harness): void {
  harness.document.querySelector("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
    }),
  );
}

function slashState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  return state;
}

test("slash commands share one accessible composer completion list", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>(
      "#composerAutocomplete",
    );
    assert.ok(prompt && listbox);
    assert.equal(prompt.getAttribute("aria-controls"), "composerAutocomplete");
    assert.equal(listbox.getAttribute("aria-label"), "Composer suggestions");

    prompt.focus();
    harness.input("#prompt", "/");
    assert.equal(listbox.hidden, false);
    assert.deepEqual(
      [...listbox.querySelectorAll("[role='option'] strong")]
        .map((option) => option.textContent),
      ["/clear", "/compact", "/queue", "/steer"],
    );

    harness.input("#prompt", "/co");
    assert.deepEqual(
      [...listbox.querySelectorAll("[role='option'] strong")]
        .map((option) => option.textContent),
      ["/compact"],
    );
    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    }));
    assert.equal(prompt.value, "/compact ");
    assert.equal(listbox.hidden, true);

    for (const value of ["/clear $", "/compact $"]) {
      harness.input("#prompt", value);
      assert.equal(
        listbox.hidden,
        true,
        "Slash arguments must not offer ordinary Skill mentions.",
      );
    }
  } finally {
    harness.close();
  }
});

test("slash autocomplete cycles keyboard selection and Escape clears its ARIA state", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>(
      "#composerAutocomplete",
    );
    assert.ok(prompt && listbox);

    prompt.focus();
    harness.input("#prompt", "/");

    const press = (key: string) => {
      const event = new harness.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      assert.equal(prompt.dispatchEvent(event), false);
    };
    const selected = () => [...listbox.querySelectorAll("[role='option']")]
      .map((option) => option.getAttribute("aria-selected"));

    press("ArrowUp");
    assert.equal(
      prompt.getAttribute("aria-activedescendant"),
      "composerSuggestion-3",
    );
    assert.deepEqual(selected(), ["false", "false", "false", "true"]);

    press("ArrowDown");
    assert.equal(
      prompt.getAttribute("aria-activedescendant"),
      "composerSuggestion-0",
    );
    press("ArrowDown");
    assert.equal(
      prompt.getAttribute("aria-activedescendant"),
      "composerSuggestion-1",
    );
    assert.deepEqual(selected(), ["false", "true", "false", "false"]);

    press("Escape");
    assert.equal(prompt.value, "/");
    assert.equal(listbox.hidden, true);
    assert.equal(prompt.getAttribute("aria-expanded"), "false");
    assert.equal(prompt.hasAttribute("aria-activedescendant"), false);
    assert.equal(listbox.querySelectorAll("[role='option']").length, 0);
  } finally {
    harness.close();
  }
});

test("slash autocomplete supports mouse selection and closes after blur", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>(
      "#composerAutocomplete",
    );
    assert.ok(prompt && listbox);

    prompt.focus();
    harness.input("#prompt", "/co");
    const option = listbox.querySelector<HTMLButtonElement>("[role='option']");
    assert.ok(option);
    const mousedown = new harness.window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    assert.equal(option.dispatchEvent(mousedown), false);
    assert.equal(harness.document.activeElement, prompt);

    option.click();
    assert.equal(prompt.value, "/compact ");
    assert.equal(listbox.hidden, true);
    assert.equal(harness.document.activeElement, prompt);

    harness.input("#prompt", "/");
    assert.equal(listbox.hidden, false);
    prompt.blur();
    assert.equal(listbox.hidden, false);
    await harness.settle();
    assert.equal(listbox.hidden, true);
    assert.equal(prompt.getAttribute("aria-expanded"), "false");
    assert.equal(prompt.hasAttribute("aria-activedescendant"), false);
  } finally {
    harness.close();
  }
});

test("manual compact routes optional instructions through a Session command", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.input("#prompt", "/compact preserve exact bar ranges and track names");
    submitComposer(harness);
    await harness.settle();

    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "compact_session",
      sessionId: "session-1",
      instructions: "preserve exact bar ranges and track names",
    }]);
    assert.equal(jsonCalls(harness, "/send").length, 0);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
  } finally {
    harness.close();
  }
});

test("manual compact reports correlated progress and preserves its draft when stopped", async () => {
  const harness = await createDialogHarness(slashState());
  const command = "/compact preserve the current arrangement plan";
  try {
    harness.failNextCommand("Command stopped by user.", undefined, {
      commandOutcome: "stopped",
      status: 409,
    });
    harness.holdNextCommand();
    harness.input("#prompt", command);
    submitComposer(harness);
    await waitForCondition(
      () => harness.commandIds.length === 1,
      "Expected compact to enter the command bridge.",
    );
    const commandId = harness.commandIds[0]!;
    const sendButton = harness.document.querySelector<HTMLButtonElement>(
      "#sendButton",
    );
    assert.ok(sendButton);
    assert.equal(sendButton.disabled, false);
    assert.equal(sendButton.getAttribute("aria-label"), "Stop current operation");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );

    for (const payload of [
      {
        type: "command_progress",
        commandId: "another-command",
        message: "Wrong command progress",
      },
      {
        type: "command_progress",
        commandId,
        message: "Malformed command progress",
        extra: true,
      },
      {
        type: "command_progress",
        commandId,
        message: 7,
      },
    ]) harness.emitRawServerEvent(payload);
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Wrong|Malformed/,
    );

    harness.emitRawServerEvent({
      type: "command_progress",
      commandId,
      message: "The model connection was interrupted. Reconnecting (1/5) in 500 ms…",
    });
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Reconnecting \(1\/5\)/,
    );

    harness.click("#sendButton");
    await waitForCondition(
      () => harness.commandStopIds.includes(commandId),
      "Expected Stop to carry the active command ID.",
    );
    assert.equal(harness.stopIds.length, 0);
    assert.equal(sendButton.disabled, true);
    assert.equal(sendButton.textContent?.trim(), "Stopping…");
    assert.equal(
      sendButton.getAttribute("aria-label"),
      "Stopping current operation",
    );
    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      command,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Command stopped/,
    );
    harness.emitRawServerEvent({
      type: "command_progress",
      commandId,
      message: "Late command progress",
    });
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Late command progress/,
    );
  } finally {
    harness.close();
  }
});

test("a compact checkpoint that commits after Stop still wins as a success", async () => {
  const harness = await createDialogHarness(slashState());
  const command = "/compact preserve exact track names";
  try {
    harness.holdNextCommandResponse();
    harness.queueCommandStopTerminals(true);
    harness.input("#prompt", command);
    submitComposer(harness);
    await waitForCondition(
      () => harness.commandIds.length === 1,
      "Expected compact to enter the command bridge.",
    );
    const commandId = harness.commandIds[0]!;

    harness.click("#sendButton");
    await waitForCondition(
      () => harness.commandStopIds.includes(commandId),
      "Expected Stop to target the compact command.",
    );
    harness.emitServerEventError();
    harness.releaseHeldCommandResponse();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.compaction").length,
      1,
    );
    harness.emitServerEventOpen();
    await waitForCondition(
      () => harness.document.querySelector<HTMLButtonElement>("#sendButton")
        ?.disabled === false,
      "Expected the reconnected event stream to finish state refresh.",
    );
  } finally {
    harness.close();
  }
});

test("a terminal Stop acknowledgement reconciles a lost compact response without consuming its draft", async () => {
  const harness = await createDialogHarness(slashState());
  const command = "/compact keep the exact arrangement checkpoint";
  const originalSetTimeout = harness.window.setTimeout.bind(harness.window);
  try {
    harness.window.setTimeout = ((handler, timeout, ...args) =>
      originalSetTimeout(
        handler,
        timeout === 5_000 ? 0 : timeout,
        ...args,
      )) as typeof harness.window.setTimeout;
    harness.holdNextCommandResponse();
    harness.queueCommandStopTerminals(true);
    harness.input("#prompt", command);
    submitComposer(harness);
    await waitForCondition(
      () => harness.commandIds.length === 1,
      "Expected compact to enter the command bridge.",
    );

    harness.click("#sendButton");
    await waitForCondition(
      () => jsonCalls(harness, "/state").length === 1,
      "Expected terminal Stop to reconcile the lost command response.",
    );
    await waitForCondition(
      () => harness.document.querySelector<HTMLTextAreaElement>("#prompt")
        ?.disabled === false,
      "Expected command reconciliation to release the composer.",
    );

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      command,
    );
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.compaction").length,
      1,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /verify the command outcome/i,
    );
  } finally {
    harness.window.setTimeout = originalSetTimeout;
    harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("clear opens an empty Session without sending or deleting history", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.focus();
    harness.input("#prompt", "/clear");
    submitComposer(harness);
    await harness.settle();

    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "new_session",
    }]);
    assert.equal(jsonCalls(harness, "/send").length, 0);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(harness.document.activeElement?.id, "prompt");
  } finally {
    harness.close();
  }
});

test("mouse Send follows Slash command Profile admission as the prompt changes", async () => {
  const state = slashState();
  state.settings.profiles = [];
  state.settings.activeProfileId = null;
  state.activeProfileRevision = null;
  state.runtimeProfile = null;
  state.modelStateSource = null;
  state.availableModels = [];
  state.configuredModels = [];
  state.configuredModelsReady = false;
  const harness = await createDialogHarness(state);
  try {
    const sendButton = harness.document.querySelector<HTMLButtonElement>(
      "#sendButton",
    );
    assert.ok(sendButton);
    assert.equal(sendButton.disabled, true);

    harness.input("#prompt", "/clear");
    assert.equal(sendButton.disabled, false);

    harness.input("#prompt", "/compact preserve exact bar ranges");
    assert.equal(sendButton.disabled, true);
    submitComposer(harness);
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);

    harness.input("#prompt", "/clear extra");
    assert.equal(sendButton.disabled, false);
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(commandCalls(harness).length, 0);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /usage/i,
    );

    harness.input("#prompt", "/clear");
    assert.equal(sendButton.disabled, false);
    harness.click("#sendButton");
    await harness.settle();

    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "new_session",
    }]);
  } finally {
    harness.close();
  }
});

test("compact ignores an unsaved Profile draft but still requires subscription auth", async () => {
  const dirtyHarness = await createDialogHarness(slashState());
  try {
    const sendButton = dirtyHarness.document.querySelector<HTMLButtonElement>(
      "#sendButton",
    );
    assert.ok(sendButton);
    dirtyHarness.input("#profileName", "Unsaved Profile name");
    assert.equal(sendButton.disabled, true);

    dirtyHarness.input("#prompt", "/compact keep the current arrangement");
    assert.equal(sendButton.disabled, false);
    dirtyHarness.click("#sendButton");
    await dirtyHarness.settle();

    assert.deepEqual(commandCalls(dirtyHarness).map((call) => call.body), [{
      kind: "compact_session",
      sessionId: "session-1",
      instructions: "keep the current arrangement",
    }]);
  } finally {
    dirtyHarness.close();
  }

  const signedOutState = slashState();
  const profile = profileFixture({
    connection: { kind: "oauth-subscription", provider: "openai" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  signedOutState.settings.profiles = [profile];
  signedOutState.settings.activeProfileId = profile.id;
  signedOutState.activeProfileRevision = profileRevisionFixture(profile);
  signedOutState.modelStateSource = modelStateSourceFixture(profile);
  signedOutState.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  signedOutState.configuredModels = [{
    model: profile.defaultModel,
    label: profile.defaultModel,
  }];
  signedOutState.configuredModelsReady = true;
  signedOutState.oauthAuth = { status: "signed-out" };
  const signedOutHarness = await createDialogHarness(signedOutState);
  try {
    const sendButton = signedOutHarness.document.querySelector<HTMLButtonElement>(
      "#sendButton",
    );
    assert.ok(sendButton);
    signedOutHarness.input(
      "#prompt",
      "/compact keep the current arrangement",
    );
    assert.equal(sendButton.disabled, true);
    signedOutHarness.click("#sendButton");
    submitComposer(signedOutHarness);
    await signedOutHarness.settle();
    assert.equal(commandCalls(signedOutHarness).length, 0);

    signedOutHarness.input("#prompt", "/clear");
    assert.equal(sendButton.disabled, false);
  } finally {
    signedOutHarness.close();
  }
});

for (const command of ["queue", "steer"] as const) {
  test(`idle /${command} sends its argument as an ordinary request`, async () => {
    const harness = await createDialogHarness(slashState());
    try {
      harness.input("#prompt", `/${command} build the next section`);
      submitComposer(harness);
      await harness.settle();

      assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
        prompt: "build the next section",
        sessionId: "session-1",
      }]);
      assert.equal(jsonCalls(harness, "/steer").length, 0);
    } finally {
      harness.close();
    }
  });

  test(`idle /${command} restores the exact Slash draft when Send was not persisted`, async () => {
    const harness = await createDialogHarness(slashState());
    const source = `/${command}   build the next section  `;
    try {
      harness.failNextSend("The request was not persisted.", "not_persisted");
      harness.input("#prompt", source);
      submitComposer(harness);
      await harness.settle();

      assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
        prompt: "build the next section",
        sessionId: "session-1",
      }]);
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        source,
      );
      const queuedRecovery = harness.document.querySelector(
        ".queued-follow-up",
      )?.textContent ?? "";
      assert.match(queuedRecovery, /build the next section/);
      assert.doesNotMatch(queuedRecovery, new RegExp(`/${command}`));
    } finally {
      harness.close();
    }
  });
}

test("active /steer overrides Queue mode without persisting the command text", async () => {
  const state = slashState();
  state.settings.defaultFollowUpBehavior = "queue";
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.input("#prompt", "/steer keep the bass shorter");
    submitComposer(harness);
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/steer").map((call) => call.body), [{
      prompt: "keep the bass shorter",
      sessionId: "session-1",
    }]);
    assert.doesNotMatch(JSON.stringify(harness.calls), /\/steer keep/);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("accepted active steering closes autocomplete with its submitted draft", async () => {
  const state = slashState();
  state.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>(
      "#composerAutocomplete",
    );
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$arr");
    assert.equal(listbox.hidden, false);

    submitComposer(harness);
    await harness.settle();

    assert.equal(prompt.value, "");
    assert.equal(listbox.hidden, true);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("active /queue overrides Steer mode and keeps the Stop button unchanged", async () => {
  const state = slashState();
  state.settings.defaultFollowUpBehavior = "steer";
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.input("#prompt", "/queue add a quiet outro");
    submitComposer(harness);
    await harness.settle();

    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.match(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /add a quiet outro/,
    );
    assert.doesNotMatch(
      harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
      /\/queue/,
    );
    assert.equal(
      harness.document.querySelector("#sendButton")?.getAttribute("aria-label"),
      "Stop current response",
    );
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

for (const command of ["queue", "steer"] as const) {
  test(`active /${command} keeps using the admitted Send after a peer removes the active Profile`, async () => {
    const harness = await createDialogHarness(slashState());
    try {
      harness.holdNextSend();
      harness.input("#prompt", "Build the first version");
      harness.click("#sendButton");
      await waitForCondition(
        () => jsonCalls(harness, "/send").length === 1,
        "Expected the active Send to start.",
      );

      const peerState = slashState();
      peerState.settings.profiles = [];
      peerState.settings.activeProfileId = null;
      peerState.activeProfileRevision = null;
      peerState.runtimeProfile = null;
      peerState.modelStateSource = null;
      peerState.availableModels = [];
      peerState.configuredModels = [];
      peerState.configuredModelsReady = false;
      const stateCallsBefore = jsonCalls(harness, "/state").length;
      harness.setServerState(peerState);
      harness.emitServerEvent({
        type: "profile_settings_changed",
        commandId: `peer-profile-${command}`,
      });
      await waitForCondition(
        () => jsonCalls(harness, "/state").length > stateCallsBefore,
        "Expected the peer Profile mutation to refresh state.",
      );
      await harness.settle();

      harness.input("#prompt", `/${command} keep the bass shorter`);
      submitComposer(harness);
      await harness.settle();

      assert.equal(jsonCalls(harness, "/send").length, 1);
      if (command === "steer") {
        assert.deepEqual(jsonCalls(harness, "/steer").map((call) => call.body), [{
          prompt: "keep the bass shorter",
          sessionId: "session-1",
        }]);
      } else {
        assert.match(
          harness.document.querySelector(".queued-follow-up")?.textContent ?? "",
          /keep the bass shorter/,
        );
      }
    } finally {
      harness.releaseHeldSend();
      await harness.settle();
      harness.close();
    }
  });
}

test("explicit /queue cannot abandon an unresolved /steer receipt", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.failNextSteer("Steering outcome unknown.", "unknown");
    harness.input("#prompt", "/steer move the chorus earlier");
    submitComposer(harness);
    await harness.settle();

    harness.input("#prompt", "/queue add a quiet outro");
    submitComposer(harness);
    await harness.settle();

    assert.equal(jsonCalls(harness, "/steer").length, 1);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "/queue add a quiet outro",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /resolve.*guidance|guidance.*resolve/i,
    );
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("active /compact stays editable until the current request finishes", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    const command = "/compact preserve the current arrangement plan";
    harness.input("#prompt", command);
    submitComposer(harness);
    await harness.settle();

    assert.equal(commandCalls(harness).length, 0);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      command,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /active request.*finish.*compacting/i,
    );
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("active /clear starts a fresh Session without steering or queuing", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build the first version");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.input("#prompt", "/clear");
    submitComposer(harness);
    await harness.settle();

    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "new_session",
    }]);
    assert.equal(jsonCalls(harness, "/steer").length, 0);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a failed control command restores its exact Slash draft", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    harness.failNextCommand("Could not create a fresh Session.");
    harness.input("#prompt", "/clear");
    submitComposer(harness);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "/clear",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Could not create/,
    );
  } finally {
    harness.close();
  }
});

for (const command of [
  "/clear",
  "/compact preserve exact bar ranges",
] as const) {
  test(`a reconciled but unconfirmed ${command} keeps its Slash draft`, async () => {
    const harness = await createDialogHarness(slashState());
    try {
      harness.rejectNextCommand("Bridge response was lost before admission.");
      harness.input("#prompt", command);
      submitComposer(harness);
      await waitForCondition(
        () => /waiting for authoritative bridge state/i.test(
          harness.document.querySelector("#status")?.textContent ?? "",
        ),
        "Expected the command response loss to enter reconciliation.",
      );
      harness.emitServerEventError();
      await waitForCondition(
        () => jsonCalls(harness, "/state").length >= 1,
        "Expected the lost command to finish state reconciliation.",
      );

      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        command,
      );
      assert.equal(
        harness.readBootstrappedClientStateReference().activeSessionId,
        "session-1",
      );
      assert.deepEqual(harness.calls.slice(0, 2).map((call) => call.path), [
        "/command",
        "/state",
      ]);
      harness.emitServerEventOpen();
      await harness.settle();
    } finally {
      harness.close();
    }
  });
}

for (const input of ["/unknown", "/clear extra", "/queue", "/steer"] as const) {
  test(`invalid Slash input ${JSON.stringify(input)} stays editable`, async () => {
    const harness = await createDialogHarness(slashState());
    try {
      harness.input("#prompt", input);
      submitComposer(harness);
      await harness.settle();

      assert.equal(harness.calls.length, 0);
      assert.equal(
        harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
        input,
      );
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /command|usage/i,
      );
    } finally {
      harness.close();
    }
  });
}

test("a slash outside the first character remains ordinary prompt text", async () => {
  const harness = await createDialogHarness(slashState());
  try {
    const prompt = "Please explain /clear before doing anything.";
    harness.input("#prompt", prompt);
    submitComposer(harness);
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
      prompt,
      sessionId: "session-1",
    }]);
    assert.equal(commandCalls(harness).length, 0);
  } finally {
    harness.close();
  }
});
