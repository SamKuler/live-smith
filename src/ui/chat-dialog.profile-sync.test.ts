import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

function activateSecondProfile(state: ReturnType<typeof stateFixture>) {
  const next = JSON.parse(JSON.stringify(state)) as typeof state;
  const profile = next.settings.profiles.find((entry) => entry.id === "profile-2");
  assert.ok(profile);
  assert.equal(profile.connection.kind, "direct-api");
  if (profile.connection.kind !== "direct-api") return next;
  next.settings.activeProfileId = profile.id;
  next.runtimeProfile!.profile = {
    id: profile.id,
    name: profile.name,
    connectionKind: profile.connection.kind,
    apiFamily: profile.connection.apiFamily,
    apiMode: profile.connection.apiMode,
  };
  next.runtimeProfile!.selection = {
    model: profile.defaultModel,
    reasoning: { mode: "default" },
  };
  next.configuredModels = profile.models.map((entry) => ({
    model: entry.model,
    label: entry.model,
  }));
  next.modelStateSource = {
    profileId: profile.id,
    connection: JSON.parse(JSON.stringify(profile.connection)),
    model: profile.defaultModel,
  };
  return next;
}

test("an external Profile event gates Send until authoritative runtime and Settings refresh", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.setServerState(activateSecondProfile(state));
    harness.holdNextState();
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-save",
    });
    await Promise.resolve();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-a",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    harness.input("#prompt", "Wait for Profile synchronization");
    harness.click("#sendButton");
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/send").length,
      0,
    );

    harness.releaseHeldState();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an external Profile refresh cannot unlock settings during an active send", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep Profile settings locked");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the send to stay active.",
    );

    harness.setServerState(activateSecondProfile(state));
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-during-send",
    });
    await waitForCondition(
      () => harness.document.querySelector<HTMLInputElement>("#profileName")
        ?.value === "Mix review",
      "Expected the external Profile state to render.",
    );

    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "true",
    );
    for (const selector of [
      "#profileName",
      "#apiKey",
      "#baseUrl",
      "#temperature",
      "#saveProfileButton",
    ]) {
      assert.equal(
        harness.document.querySelector<HTMLInputElement | HTMLButtonElement>(selector)
          ?.disabled,
        true,
        `${selector} must remain locked`,
      );
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a failed external Profile refresh keeps the stale runtime blocked", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.setServerState(activateSecondProfile(state));
    harness.failNextState("State unavailable");
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-save",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-a",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /close and reopen/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unrelated Profile edit updates selector text without marking the local Draft stale", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Local Profile 1 draft");
    const next = JSON.parse(JSON.stringify(state)) as typeof state;
    next.settings.profiles[1]!.name = "Externally renamed Profile 2";
    harness.setServerState(next);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-rename",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Local Profile 1 draft",
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Unsaved changes",
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "Externally renamed Profile 2",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Session command cannot re-enable a Draft blocked by its authoritative Profile state", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Local stale Draft");
    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_approval_mode"
      ),
      "Expected the Session command to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[0]!.name = "External Profile revision";
    external.runtimeProfile!.profile.name = "External Profile revision";
    harness.setServerState(external);
    harness.releaseHeldCommandResponse();
    await harness.settle();

    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Draft blocked · Profile changed elsewhere",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")
        ?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#deleteProfileButton")
        ?.disabled,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Session command adopts an incoming Profile catalog with its saved state", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_approval_mode"
      ),
      "Expected the Session command to remain in flight.",
    );

    const incoming = activateSecondProfile(state);
    incoming.approvalMode = "everything";
    incoming.sessions[0]!.approvalMode = "everything";
    incoming.availableModels = [{
      id: "model-b",
      displayName: "Model B catalog",
      capabilities: JSON.parse(JSON.stringify(incoming.capabilities)),
      capabilityEvidence: JSON.parse(JSON.stringify(incoming.capabilityEvidence)),
    }];
    harness.setServerState(incoming);
    harness.releaseHeldCommandResponse();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Model B catalog · model-b · Default"],
    );
    assert.doesNotMatch(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label") ?? "",
      /Unverified/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an external active connection change invalidates a retained Draft capability preview", async () => {
  const state = stateFixture();
  state.availableModels = [{
    id: "model-a",
    displayName: "Catalog name from the old active connection",
    capabilities: JSON.parse(JSON.stringify(state.capabilities)),
    capabilityEvidence: JSON.parse(JSON.stringify(state.capabilityEvidence)),
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Keep this local Draft");
    harness.input("#temperature", "0.4");
    const external = activateSecondProfile(state);
    external.capabilities.temperature = "unsupported";
    external.capabilityEvidence.temperature = "unsupported";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-active-connection-change",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Keep this local Draft",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#temperature")?.value,
      "0.4",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );
    assert.equal(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label"),
      "Input capabilities. Image: Unverified. Audio: Unverified. PDF: Unverified.",
    );
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /unknown/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("changing the Draft connection removes display names owned by the old catalog", async () => {
  const state = stateFixture();
  state.availableModels = [{
    id: "model-a",
    displayName: "Catalog name from API A",
    capabilities: JSON.parse(JSON.stringify(state.capabilities)),
    capabilityEvidence: JSON.parse(JSON.stringify(state.capabilityEvidence)),
  }];
  const harness = await createDialogHarness(state);
  try {
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Catalog name from API A · model-a · Default"],
    );

    harness.input("#baseUrl", "https://api-b.example/v1");

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );
    assert.equal(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label"),
      "Input capabilities. Image: Unverified. Audio: Unverified. PDF: Unverified.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a correlated model discovery survives an unrelated Profile refresh", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Local draft during model discovery");
    harness.input("#baseUrl", "https://new-connection.example/v1");
    harness.input("#apiKey", "new-connection-key");
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "discover_models"
      ),
      "Expected model discovery to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[1]!.name = "Unrelated external rename";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-unrelated-profile-rename",
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the external Profile refresh to complete.",
    );
    await harness.settle();

    harness.releaseHeldCommand();
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Local draft during model discovery",
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "Unrelated external rename",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("model discovery applies after a concurrent Profile refresh unlocks", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: { discoverModels(): Promise<void> };
  }).LiveSmithUI;
  let commandReleased = false;
  let stateReleased = false;
  try {
    harness.input("#baseUrl", "https://pending-discovery.example/v1");
    harness.input("#apiKey", "pending-discovery-key");
    harness.holdNextCommand();
    const discovery = ui.discoverModels();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "discover_models"
      ),
      "Expected model discovery to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[1]!.name = "External rename during discovery";
    harness.setServerState(external);
    harness.holdNextState();
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-refresh-during-discovery",
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the concurrent Profile refresh to remain in flight.",
    );

    harness.releaseHeldCommand();
    commandReleased = true;
    await discovery;
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );

    harness.setServerState(external);
    harness.releaseHeldState();
    stateReleased = true;
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.doesNotMatch(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label") ?? "",
      /Unverified/,
    );
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /Model output limit: [0-9]+/,
    );
    harness.input("#baseUrl", "https://connection-c.example/v1");
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-discovered · Default"],
    );
    assert.match(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label") ?? "",
      /Unverified/,
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "External rename during discovery",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommand();
    if (!stateReleased) harness.releaseHeldState();
    await harness.settle();
    harness.close();
  }
});

test("Profile change events reject embedded Profile or credential data", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.emitRawServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-save",
      bridgeStateRevision: "2",
      profile: { apiKey: "must-not-enter-this-event" },
    });
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/state").length,
      0,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed own Profile response cannot roll back a newer external refresh", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: { saveProfile(): Promise<void> };
  }).LiveSmithUI;
  try {
    harness.input("#profileName", "Own older save");
    harness.holdNextCommandResponse();
    const command = ui.saveProfile();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "save_profile"
      ),
      "Expected the Profile save to wait for its response.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[0]!.name = "External latest save";
    external.runtimeProfile!.profile.name = "External latest save";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-newer-save",
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the external Profile event to refresh state.",
    );
    await harness.settle();

    harness.releaseHeldCommandResponse();
    await command;
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "External latest save",
    );
    assert.match(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.title ?? "",
      /External latest save/,
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Profile save crosses a concurrent unrelated Profile refresh", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Own saved Profile");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "save_profile"
      ),
      "Expected the Profile save to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[1]!.name = "External Profile 2 rename";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-profile-2-rename-during-save",
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the unrelated Profile refresh to complete.",
    );
    await harness.settle();

    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Own saved Profile",
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Saved",
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "External Profile 2 rename",
    );
    assert.match(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.title ?? "",
      /Own saved Profile/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed Profile command state barrier keeps the editor fail-closed", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.input("#profileName", "Unreconciled saved Draft");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "save_profile"
      ),
      "Expected the Profile save to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[1]!.name = "External refresh before barrier";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-refresh-before-failed-barrier",
    });
    await harness.settle();

    harness.rejectNextState("The terminal Profile state is unavailable.");
    harness.releaseHeldCommand();
    commandReleased = true;
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Unreconciled saved Draft",
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Unsaved changes",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#settingsPanel")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /close and reopen/i,
    );
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/state").length,
      2,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("a Profile save that never reached the bridge preserves its local Draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Unpersisted Profile draft");
    harness.rejectNextCommand("The save request never reached the bridge.");
    harness.click("#saveProfileButton");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();
    harness.emitServerEventOpen();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Unpersisted Profile draft",
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Unsaved changes",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")
        ?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Profile delete that never reached the bridge preserves its local Draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Draft kept across unknown delete");
    harness.rejectNextCommand("The delete request never reached the bridge.");
    harness.click("#deleteProfileButton");
    await harness.acceptAppConfirmation();
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Draft kept across unknown delete",
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Unsaved changes",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
