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

    const delayed = JSON.parse(JSON.stringify(state)) as typeof state;
    delayed.settings.profiles[0]!.name = "Own older save";
    delayed.runtimeProfile!.profile.name = "Own older save";
    harness.setServerState(delayed);
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
