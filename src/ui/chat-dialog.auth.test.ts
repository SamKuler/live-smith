import assert from "node:assert/strict";
import test from "node:test";

import type { SavedProfile } from "../model/profile.js";
import {
  capabilities,
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  modelStateSourceFixture,
  pendingAudio,
  pendingDocument,
  pendingImage,
  profileFixture,
  profileRevisionFixture,
  runtimeSummaryForHarnessProfile,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

function subscriptionProfile(): SavedProfile {
  return profileFixture({
    connection: { kind: "oauth-subscription", provider: "openai" },
    parameters: {
      reasoning: { mode: "default" },
    },
    advanced: {},
  });
}

function submitFromComposer(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): void {
  harness.document.querySelector("#prompt")?.dispatchEvent(
    new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Enter",
    }),
  );
}

test("ChatGPT sign-in crosses a concurrent unrelated Profile refresh", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.select("#connectionKind", "oauth-subscription");
    harness.holdNextCommand();
    harness.click("#oauthSignInButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "start_oauth_login"
      ),
      "Expected ChatGPT sign-in to remain in flight.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.settings.profiles[1]!.name = "External rename during sign-in";
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "external-rename-during-sign-in",
    });
    await harness.settle();

    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Waiting",
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "External rename during sign-in",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a same-account Check invalidates the previous subscription Draft catalog", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = profile.models.map((model) => ({
    model: model.model,
    label: model.model,
  }));
  state.configuredModelsReady = true;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    harness.click("#discoverModelsButton");
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );

    const refreshed = cloneState(state);
    refreshed.availableModels = [];
    refreshed.configuredModelsReady = false;
    delete refreshed.modelCatalogLoadReceipt;
    harness.setServerState(refreshed);
    harness.click("#oauthCheckAccountButton");
    await harness.settle();

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
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a peer subscription auth generation invalidates another dirty Draft catalog", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = profile.models.map((model) => ({
    model: model.model,
    label: model.model,
  }));
  state.configuredModelsReady = true;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: null,
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    harness.click("#discoverModelsButton");
    await harness.settle();
    harness.input("#profileName", "Dirty subscription Draft A");

    const peerProfile = profileFixture({
      id: "profile-2",
      name: "Direct Profile B",
      model: "peer-model",
    });
    const incoming = cloneState(state);
    incoming.settings.profiles = [profile, peerProfile];
    incoming.settings.activeProfileId = peerProfile.id;
    incoming.activeProfileRevision = profileRevisionFixture(peerProfile);
    incoming.modelStateSource = modelStateSourceFixture(peerProfile);
    incoming.runtimeProfile = runtimeSummaryForHarnessProfile(peerProfile);
    incoming.configuredModels = [{ model: "peer-model", label: "peer-model" }];
    incoming.configuredModelsReady = true;
    incoming.availableModels = [];
    incoming.oauthAuthGeneration = state.oauthAuthGeneration + 1;
    incoming.oauthAuth = {
      status: "signed-in",
      accountLabel: "new-account@example.test",
      planType: "pro",
      subscriptionEligible: true,
    };
    delete incoming.modelCatalogLoadReceipt;
    harness.setServerState(incoming);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "peer-subscription-generation-change",
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Dirty subscription Draft A",
    );
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
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Direct Session command drops an old subscription Draft catalog after auth changes", async () => {
  const state = stateFixture();
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.select("#connectionKind", "oauth-subscription");
    harness.click("#discoverModelsButton");
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );

    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "set_session_approval_mode"
      ),
      "Expected the Approval command to reach the bridge.",
    );
    const incoming = cloneState(state);
    incoming.oauthAuthGeneration += 1;
    incoming.approvalMode = "everything";
    incoming.sessions[0]!.approvalMode = "everything";
    incoming.availableModels = [];
    delete incoming.modelCatalogLoadReceipt;
    harness.setServerState(incoming);
    harness.releaseHeldCommandResponse();
    commandReleased = true;
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#connectionKind")?.value,
      "oauth-subscription",
    );
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
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a delayed old subscription catalog cannot cross a newer auth generation", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  const peerProfile = profileFixture({
    id: "profile-2",
    name: "Peer Direct Profile",
    model: "peer-model",
  });
  state.settings.profiles = [profile, peerProfile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = [{ model: profile.defaultModel, label: profile.defaultModel }];
  state.configuredModelsReady = false;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await waitForCondition(
      () => harness.commandIds.length > 0,
      "Expected Load Models to reach the bridge.",
    );
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);

    const newer = cloneState(state);
    newer.oauthAuthGeneration += 1;
    newer.oauthAuth = {
      status: "signed-in",
      accountLabel: "new-account@example.test",
      planType: "pro",
      subscriptionEligible: true,
    };
    newer.availableModels = [];
    newer.settings.profiles[1]!.name = "Peer renamed at new generation";
    delete newer.modelCatalogLoadReceipt;
    harness.setServerState(newer);
    const stateCallsBeforeRefresh = jsonCalls(harness, "/state").length;
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "peer-profile-and-auth-generation-change",
    });
    await waitForCondition(
      () => jsonCalls(harness, "/state").length > stateCallsBeforeRefresh,
      "Expected the peer Profile event to request current state.",
    );
    await waitForCondition(
      () => harness.document.querySelector<HTMLOptionElement>(
          '#profileSelector option[value="profile-2"]',
        )?.textContent === "Peer renamed at new generation",
      "Expected the newer peer Profile before the delayed catalog.",
    );
    await waitForCondition(
      () => harness.document.querySelector("#oauthAuthStatus")?.textContent
        ?.includes("new-account@example.test") === true,
      "Expected the newer auth generation before the delayed catalog.",
    );
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      [`${profile.defaultModel} · Default`],
      "the newer generation must render before the delayed catalog",
    );
    assert.doesNotMatch(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label") ?? "",
      /Image: Supported|Audio: Supported|PDF: Supported/,
    );

    const stale = cloneState(state);
    stale.availableModels = [{
      id: profile.defaultModel,
      displayName: "Old account model",
      capabilities: {
        ...capabilities(),
        inputs: { image: true, audio: true, pdf: true },
      },
      capabilityEvidence: {
        ...cloneState(state.capabilityEvidence),
        inputs: {
          image: "supported",
          audio: "supported",
          pdf: "supported",
        },
      },
    }];
    stale.capabilities = {
      ...capabilities(),
      inputs: { image: true, audio: true, pdf: true },
    };
    stale.capabilityEvidence = {
      ...cloneState(state.capabilityEvidence),
      inputs: {
        image: "supported",
        audio: "supported",
        pdf: "supported",
      },
    };
    stale.modelCatalogLoadReceipt = commandId;
    stale.configuredModels = [{
      model: profile.defaultModel,
      label: "Old runtime model",
    }];
    stale.configuredModelsReady = true;
    stale.bridgeStateRevision = "4";
    stale.bridgeStateCoveredThroughRevision = "1";
    harness.emitRawServerEvent({ type: "state", commandId, state: stale });
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      [`${profile.defaultModel} · Default`],
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#composerModel option",
      )].map((option) => option.textContent),
      [profile.defaultModel],
    );
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /studio@example\.test/,
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#profileSelector option[value="profile-2"]',
      )?.textContent,
      "Peer renamed at new generation",
    );
    assert.doesNotMatch(
      harness.document.querySelector("#inputCapabilitiesPreview")
        ?.getAttribute("aria-label") ?? "",
      /Image: Supported|Audio: Supported|PDF: Supported/,
    );
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldCommand();
    commandReleased = true;
    await harness.settle();
  } finally {
    if (!commandReleased) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("a Direct catalog remains independent of a newer subscription auth generation", async () => {
  const state = stateFixture();
  state.oauthAuthGeneration = 1;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "new-account@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const stale = cloneState(state);
  stale.oauthAuthGeneration = 0;
  stale.oauthAuth = {
    status: "signed-in",
    accountLabel: "old-account@example.test",
    planType: "plus",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    harness.setServerState(stale);
    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default", "Discovered model · model-discovered"],
    );
    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /new-account@example\.test/,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /old-account@example\.test/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a provider switch adopts its auth state without comparing another provider's generation", async () => {
  const openAIProfile = subscriptionProfile();
  const googleProfile = profileFixture({
    id: "google-profile",
    name: "Gemini subscription",
    connection: { kind: "oauth-subscription", provider: "google" },
    model: "gemini-3.1-pro-preview",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  const state = stateFixture();
  state.settings.profiles = [openAIProfile, googleProfile];
  state.settings.activeProfileId = openAIProfile.id;
  state.activeProfileRevision = profileRevisionFixture(openAIProfile);
  state.modelStateSource = modelStateSourceFixture(openAIProfile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(openAIProfile);
  state.oauthAuthProvider = "openai";
  state.oauthAuthGeneration = 3;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "chatgpt@example.test",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    const google = cloneState(state);
    google.settings.activeProfileId = googleProfile.id;
    google.activeProfileRevision = profileRevisionFixture(googleProfile);
    google.modelStateSource = modelStateSourceFixture(googleProfile);
    google.runtimeProfile = runtimeSummaryForHarnessProfile(googleProfile);
    google.configuredModels = [{
      model: googleProfile.defaultModel,
      label: googleProfile.defaultModel,
    }];
    google.oauthAuthProfileId = googleProfile.id;
    google.oauthAuthProvider = "google";
    google.oauthAuthGeneration = 1;
    google.oauthAuth = {
      status: "signed-in",
      accountLabel: "gemini@example.test",
      planType: "Google Antigravity",
      subscriptionEligible: true,
    };
    harness.setServerState(google);
    harness.emitServerEvent({
      type: "profile_settings_changed",
      commandId: "switch-to-google-provider",
    });
    await harness.settle();

    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /gemini@example\.test/,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /chatgpt@example\.test/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a new OAuth Profile does not inherit another Profile's signed-in account", async () => {
  const profile = subscriptionProfile();
  const state = stateFixture();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "openai";
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "first-profile@example.test",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Connected",
    );

    harness.click(".profile-actions button");
    await harness.settle();
    harness.select("#connectionKind", "oauth-subscription");

    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Not checked",
    );
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /first-profile@example\.test/,
    );

    harness.click("#oauthSignInButton");
    await harness.settle();
    const command = commandCalls(harness).at(-1);
    assert.equal(command?.path, "/command");
    assert.equal((command?.body as { kind?: string }).kind, "start_oauth_login");
    assert.equal((command?.body as { provider?: string }).provider, "openai");
    assert.equal(
      typeof (command?.body as { profileId?: unknown }).profileId,
      "string",
    );
    assert.notEqual(
      (command?.body as { profileId?: string }).profileId,
      profile.id,
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Waiting",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("provisional OAuth Draft exits discard the exact Profile before navigating", async (t) => {
  for (const action of ["add", "duplicate", "discard", "switch"] as const) {
    await t.test(action, async () => {
      const state = stateFixture();
      const harness = await createDialogHarness(state, undefined, {
        oauthLoginResult: {
          status: "signed-in",
          accountLabel: "draft@example.test",
          planType: "Google Antigravity",
          subscriptionEligible: true,
        },
      });
      try {
        harness.select("#connectionKind", "oauth-subscription");
        harness.select("#oauthProvider", "google");
        harness.click("#oauthSignInButton");
        await harness.settle();
        const login = commandCalls(harness).find((call) =>
          (call.body as { kind?: string }).kind === "start_oauth_login"
        );
        const profileId = (login?.body as { profileId?: string }).profileId;
        assert.equal(profileId, "profile-1");
        const callsBeforeAction = commandCalls(harness).length;

        if (action === "add") {
          harness.click("#addProfileButton");
          await harness.acceptAppConfirmation();
        } else if (action === "duplicate") {
          harness.click("#duplicateProfileButton");
          await harness.acceptAppConfirmation();
        } else if (action === "discard") {
          harness.click("#discardProfileButton");
        } else {
          harness.select("#profileSelector", "profile-2");
          await harness.acceptAppConfirmation();
        }
        await harness.settle();

        const actionCalls = commandCalls(harness).slice(callsBeforeAction);
        assert.deepEqual(actionCalls[0], {
          path: "/command",
          body: {
            kind: "discard_profile_oauth",
            profileId,
          },
        });
        if (action === "switch") {
          assert.deepEqual(actionCalls[1], {
            path: "/command",
            body: { kind: "activate_profile", profileId: "profile-2" },
          });
        }
        assert.deepEqual(harness.errors, []);
      } finally {
        harness.close();
      }
    });
  }
});

test("a matching OAuth command becomes provisional when its saved Profile changes in flight", async (t) => {
  for (const [change, action] of [
    ["direct", "add"],
    ["google", "discard"],
    ["deleted", "add"],
  ] as const) {
    await t.test(`${change} then ${action}`, async () => {
      const profile = subscriptionProfile();
      const peerProfile = profileFixture({
        id: "profile-2",
        name: "Peer Profile",
        model: "peer-model",
      });
      const state = stateFixture();
      state.settings.profiles = [profile, peerProfile];
      state.settings.activeProfileId = profile.id;
      state.activeProfileRevision = profileRevisionFixture(profile);
      state.modelStateSource = modelStateSourceFixture(profile);
      state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
      state.oauthAuthProfileId = profile.id;
      state.oauthAuthProvider = "openai";
      state.oauthAuth = { status: "signed-out" };
      const harness = await createDialogHarness(state, undefined, {
        oauthLoginResult: {
          status: "signed-in",
          accountLabel: "completed@example.test",
          planType: "ChatGPT subscription",
          subscriptionEligible: true,
        },
      });
      let released = false;
      try {
        harness.input("#profileName", "Local P draft");
        harness.holdNextCommand();
        harness.click("#oauthSignInButton");
        await waitForCondition(
          () => commandCalls(harness).some((call) =>
            (call.body as { kind?: string }).kind === "start_oauth_login"
          ),
          "Expected the matching OAuth command to reach the bridge.",
        );

        const authoritative = cloneState(state);
        authoritative.availableModels = [];
        delete authoritative.modelCatalogLoadReceipt;
        authoritative.oauthAuthGeneration += 1;
        if (change === "deleted") {
          authoritative.settings.profiles = [peerProfile];
          authoritative.settings.activeProfileId = peerProfile.id;
          authoritative.activeProfileRevision = profileRevisionFixture(peerProfile);
          authoritative.modelStateSource = modelStateSourceFixture(peerProfile);
          authoritative.runtimeProfile = runtimeSummaryForHarnessProfile(peerProfile);
          authoritative.configuredModels = peerProfile.models.map((model) => ({
            model: model.model,
            label: model.model,
          }));
          authoritative.configuredModelsReady = true;
          delete authoritative.oauthAuth;
          delete authoritative.oauthAuthProfileId;
          delete authoritative.oauthAuthProvider;
        } else {
          const changedProfile = profileFixture({
            id: profile.id,
            name: profile.name,
            connection: change === "direct"
              ? {
                  kind: "direct-api",
                  apiFamily: "openai",
                  apiMode: "responses",
                  baseUrl: "https://example.test/v1",
                  apiKey: "changed-key",
                }
              : { kind: "oauth-subscription", provider: "google" },
            model: change === "direct" ? "changed-direct-model" : "gemini-model",
            parameters: change === "direct"
              ? {
                  maxOutputTokens: 8_192,
                  reasoning: { mode: "default" },
                }
              : { reasoning: { mode: "default" } },
            advanced: {},
          });
          authoritative.settings.profiles = [changedProfile, peerProfile];
          authoritative.activeProfileRevision = profileRevisionFixture(changedProfile);
          authoritative.modelStateSource = modelStateSourceFixture(changedProfile);
          authoritative.runtimeProfile = runtimeSummaryForHarnessProfile(changedProfile);
          authoritative.configuredModels = changedProfile.models.map((model) => ({
            model: model.model,
            label: model.model,
          }));
          authoritative.configuredModelsReady = change === "direct";
          if (change === "direct") {
            delete authoritative.oauthAuth;
            delete authoritative.oauthAuthProfileId;
            delete authoritative.oauthAuthProvider;
          } else {
            authoritative.oauthAuthProfileId = changedProfile.id;
            authoritative.oauthAuthProvider = "google";
            authoritative.oauthAuth = { status: "signed-out" };
          }
        }
        harness.setServerState(authoritative);
        harness.emitServerEvent({
          type: "profile_settings_changed",
          commandId: `peer-${change}-during-auth`,
        });
        await harness.settle();
        assert.equal(
          harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
          "Local P draft",
        );

        harness.releaseHeldCommand();
        released = true;
        await harness.settle();
        const callsBeforeExit = commandCalls(harness).length;
        if (action === "add") {
          try {
            await waitForCondition(
              () =>
                harness.document.querySelector<HTMLButtonElement>(
                  "#addProfileButton",
                )?.disabled === false,
              "Expected Add to unlock after the OAuth command settled.",
            );
          } catch {
            assert.fail(`Add stayed locked after ${change}: ${JSON.stringify({
              profileBusy: harness.document.querySelector("#modelProfileControls")
                ?.getAttribute("aria-busy"),
              status: harness.document.querySelector("#status")?.textContent,
              stateCalls: jsonCalls(harness, "/state").length,
              addDisabled: harness.document.querySelector<HTMLButtonElement>(
                "#addProfileButton",
              )?.disabled,
              selectorDisabled: harness.document.querySelector<HTMLSelectElement>(
                "#profileSelector",
              )?.disabled,
              connectionKindDisabled:
                harness.document.querySelector<HTMLSelectElement>(
                  "#connectionKind",
                )?.disabled,
              oauthStatus: harness.document.querySelector("#oauthAuthStatus")
                ?.textContent,
            })}`);
          }
          harness.click("#addProfileButton");
          await Promise.resolve();
          if (
            harness.document.querySelector<HTMLElement>("#appConfirmation")
              ?.hidden === false
          ) {
            await harness.acceptAppConfirmation();
          }
        } else {
          harness.click("#discardProfileButton");
        }
        await harness.settle();

        assert.deepEqual(commandCalls(harness).slice(callsBeforeExit)[0], {
          path: "/command",
          body: {
            kind: "discard_profile_oauth",
            profileId: profile.id,
          },
        });
        assert.deepEqual(harness.errors, []);
      } finally {
        if (!released) harness.releaseHeldCommand();
        await harness.settle();
        harness.close();
      }
    });
  }
});

test("saved matching OAuth and Direct-only Draft exits do not request provisional cleanup", async (t) => {
  await t.test("saved matching provider", async () => {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.activeProfileRevision = profileRevisionFixture(profile);
    state.modelStateSource = modelStateSourceFixture(profile);
    state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
    state.oauthAuthProfileId = profile.id;
    state.oauthAuthProvider = "openai";
    state.oauthAuth = { status: "signed-out" };
    const harness = await createDialogHarness(state, undefined, {
      oauthLoginResult: {
        status: "signed-in",
        accountLabel: "saved@example.test",
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      },
    });
    try {
      harness.click("#oauthSignInButton");
      await harness.settle();
      harness.click("#addProfileButton");
      await harness.settle();
      assert.notEqual(
        harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
        profile.id,
      );
      assert.equal(
        commandCalls(harness).some((call) =>
          (call.body as { kind?: string }).kind === "discard_profile_oauth"
        ),
        false,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });

  await t.test("failed saved account check", async () => {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.activeProfileRevision = profileRevisionFixture(profile);
    state.modelStateSource = modelStateSourceFixture(profile);
    state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
    state.oauthAuthProfileId = profile.id;
    state.oauthAuthProvider = "openai";
    state.oauthAuth = {
      status: "signed-in",
      accountLabel: "saved@example.test",
      planType: "ChatGPT subscription",
      subscriptionEligible: true,
    };
    const harness = await createDialogHarness(state, undefined, {
      initialCommandError: "Account check failed before reaching OAuth.",
    });
    try {
      harness.click("#oauthCheckAccountButton");
      await harness.settle();
      harness.click("#addProfileButton");
      await harness.settle();
      assert.equal(
        commandCalls(harness).some((call) =>
          (call.body as { kind?: string }).kind === "discard_profile_oauth"
        ),
        false,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });

  await t.test("peer provisional auth projection", async () => {
    const state = stateFixture();
    state.oauthAuthProfileId = "profile-1";
    state.oauthAuthProvider = "google";
    state.oauthAuth = {
      status: "signed-in",
      accountLabel: "peer@example.test",
      planType: "Google Antigravity",
      subscriptionEligible: true,
    };
    const harness = await createDialogHarness(state);
    try {
      harness.input("#profileName", "Direct draft after peer OAuth");
      harness.click("#addProfileButton");
      await harness.acceptAppConfirmation();
      await harness.settle();
      assert.notEqual(
        harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
        "profile-1",
      );
      assert.equal(
        commandCalls(harness).some((call) =>
          (call.body as { kind?: string }).kind === "discard_profile_oauth"
        ),
        false,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });

  for (const action of ["add", "duplicate", "discard", "switch"] as const) {
    await t.test(`Direct-only ${action}`, async () => {
      const harness = await createDialogHarness();
      try {
        harness.input("#profileName", "Direct-only draft");
        if (action === "add") {
          harness.click("#addProfileButton");
          await harness.acceptAppConfirmation();
        } else if (action === "duplicate") {
          harness.click("#duplicateProfileButton");
          await harness.acceptAppConfirmation();
        } else if (action === "discard") {
          harness.click("#discardProfileButton");
        } else {
          harness.select("#profileSelector", "profile-2");
          await harness.acceptAppConfirmation();
        }
        await harness.settle();
        if (action === "add") {
          assert.notEqual(
            harness.document.querySelector<HTMLSelectElement>("#profileSelector")
              ?.value,
            "profile-1",
          );
        } else if (action === "duplicate") {
          assert.equal(
            harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
            "Direct-only draft Copy",
          );
        } else if (action === "discard") {
          assert.equal(
            harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
            "Studio",
          );
        } else {
          assert.equal(
            (commandCalls(harness).at(-1)?.body as { profileId?: string })
              .profileId,
            "profile-2",
          );
        }
        assert.equal(
          commandCalls(harness).some((call) =>
            (call.body as { kind?: string }).kind === "discard_profile_oauth"
          ),
          false,
        );
        assert.deepEqual(harness.errors, []);
      } finally {
        harness.close();
      }
    });
  }
});

test("a delayed Profile auth response cannot reuse another Profile's same-generation catalog or runtime", async () => {
  const profile = profileFixture({
    id: "profile-a",
    name: "Profile A",
    connection: { kind: "oauth-subscription", provider: "openai" },
    model: "profile-a-model",
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  const state = stateFixture();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.availableModels = [{
    id: profile.defaultModel,
    displayName: "Profile A catalog model",
    capabilities: capabilities(),
    capabilityEvidence: cloneState(state.capabilityEvidence),
  }];
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = [{
    model: profile.defaultModel,
    label: "Profile A runtime model",
  }];
  state.configuredModelsReady = true;
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "openai";
  state.oauthAuthGeneration = 1;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "profile-a@example.test",
    planType: "ChatGPT subscription",
    subscriptionEligible: true,
  };
  const pendingGoogleAuth = {
    status: "pending" as const,
    verificationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
    authorizationCodeInput: true as const,
  };
  const harness = await createDialogHarness(state, undefined, {
    oauthLoginResult: pendingGoogleAuth,
  });
  let released = false;
  try {
    harness.click(".profile-actions button");
    await harness.settle();
    harness.select("#connectionKind", "oauth-subscription");
    harness.select("#oauthProvider", "google");
    harness.holdNextCommandResponse();
    harness.click("#oauthSignInButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "start_oauth_login"
      ),
      "Expected the new Profile login to reach the bridge.",
    );
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();

    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Waiting",
    );
    const startedLogin = commandCalls(harness).find((call) =>
      (call.body as { kind?: string }).kind === "start_oauth_login"
    );
    const draftProfileId = (startedLogin?.body as { profileId?: string })
      .profileId;
    assert.ok(draftProfileId);
    const missedFailure = harness.deferServerEvent({
      type: "oauth_auth_changed",
      profileId: draftProfileId,
      provider: "google",
      oauthAuthGeneration: state.oauthAuthGeneration + 1,
      oauthAuth: {
        ...pendingGoogleAuth,
        browserLaunchFailed: true,
      },
    });
    harness.setServerState(cloneState(state));
    harness.emitServerEvent({ type: "global_state_invalidated" });
    await harness.settle();
    harness.emitRawServerEvent(missedFailure);
    await harness.settle();
    assert.match(
      harness.document.querySelector("#oauthAuthStateDetail")?.textContent ?? "",
      /could not open the system browser/i,
    );
    assert.match(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.title ?? "",
      /Open to load capabilities/i,
      "Profile A's ready runtime must not be paired with Profile B's auth",
    );

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#discardProfileButton",
      )?.disabled,
      true,
    );
    harness.click("#oauthLogoutButton");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#discardProfileButton",
      )?.disabled,
      false,
    );
    harness.click("#discardProfileButton");
    assert.doesNotMatch(
      harness.document.querySelector("#modelConfigSelector")?.textContent ?? "",
      /Profile A catalog model/,
      "Profile A's catalog must be invalidated while Profile B owns the auth projection",
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Not checked",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("connection selection separates Direct API from experimental ChatGPT subscription", async () => {
  const state = stateFixture();
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: true,
      canDisable: true,
      efforts: ["high"],
      budgetTokens: true,
      strategy: "budget-thinking",
    },
  };
  state.capabilityEvidence = {
    ...state.capabilityEvidence,
    reasoning: "supported",
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector<HTMLElement>("#directApiFields")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#oauthProviderField")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#oauthAuthPanel")?.hidden, true);

    harness.select("#apiFamily", "anthropic");
    harness.select("#apiFamily", "openai");
    harness.select("#apiMode", "responses");
    harness.input("#temperature", "0.8");
    harness.select("#reasoningMode", "disabled");
    harness.input("#reasoningBudgetTokens", "4096");
    harness.click("#webSearchEnabled");
    harness.select("#overrideInputImage", "true");
    harness.input("#extraBody", '{"custom":true}');

    harness.select("#connectionKind", "oauth-subscription");

    assert.equal(harness.document.querySelector<HTMLElement>("#directApiFields")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#oauthProviderField")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#oauthAuthPanel")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLDetailsElement>("#advancedSettings")?.hidden, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#temperature")?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#temperature")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.disabled, true);
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /set by the subscription backend/i,
    );
    assert.equal(harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value, "disabled");
    assert.equal(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#reasoningMode option")]
        .some((option) => option.value === "disabled"),
      true,
    );
    assert.equal(harness.document.querySelector<HTMLInputElement>("#webSearchEnabled")?.checked, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#webSearchEnabled")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#overrideInputImage")?.value, "inherit");
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#overrideInputImage")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#extraBody")?.value, "");
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#extraBody")?.disabled, true);
    assert.equal(
      harness.document.querySelector('label[for="connectionKind"]')?.textContent,
      "Type",
    );
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>(
        '#connectionKind option[value="oauth-subscription"]',
      )?.textContent,
      "Account subscription (OAuth)",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(".subscription-auth-note")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector(".subscription-auth-details summary")?.textContent,
      "Requirements",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll(".subscription-auth-details li")].map(
        (item) => item.textContent,
      ),
      [
        "No provider CLI or API key is required.",
        "OAuth credentials stay in Live Smith’s private Ableton storage.",
      ],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Sign in relies on the host browser launch and keeps a verified fallback link", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector<HTMLMetaElement>('meta[name="referrer"]')
        ?.content,
      "no-referrer",
    );
    harness.holdNextCommand();
    harness.document.querySelector<HTMLButtonElement>("#oauthSignInButton")?.focus();
    harness.click("#oauthSignInButton");

    assert.deepEqual(harness.windowOpenAttempts, []);

    harness.releaseHeldCommand();
    await harness.settle();

    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.equal(
      harness.document.querySelector<HTMLAnchorElement>("#oauthVerificationLink")
        ?.href,
      "https://auth.openai.com/codex/device",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a definitive login failure restores a focused retry", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(state, undefined, {
    oauthLoginResult: {
      status: "unavailable",
      message: "ChatGPT device authorization is unavailable.",
      definitive: true,
    },
  });
  try {
    const signIn = harness.document.querySelector<HTMLButtonElement>(
      "#oauthSignInButton",
    );
    signIn?.focus();
    harness.click("#oauthSignInButton");
    await harness.settle();

    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.equal(signIn?.hidden, false);
    assert.equal(signIn?.disabled, false);
    assert.equal(signIn?.textContent, "Try sign-in again");
    assert.equal(harness.document.activeElement, signIn);

    harness.click("#oauthSignInButton");
    await harness.settle();
    assert.equal(
      commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind === "start_oauth_login"
      ).length,
      2,
    );
    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("subscription model discovery and Save use only the OAuth connection contract", async () => {
  const harness = await createDialogHarness();
  try {
    harness.select("#connectionKind", "oauth-subscription");
    harness.click("#discoverModelsButton");
    await harness.settle();

    const discovery = commandCalls(harness).at(-1)?.body as {
      kind: string;
      profile: SavedProfile;
    };
    assert.equal(discovery.kind, "discover_models");
    assert.deepEqual(discovery.profile.connection, {
      kind: "oauth-subscription",
      provider: "openai",
    });
    assert.deepEqual(discovery.profile.models[0]?.advanced, {});
    assert.deepEqual(discovery.profile.models[0]?.parameters, {
      reasoning: { mode: "default" },
    });
    assert.equal("apiKey" in discovery.profile, false);

    harness.select("#modelConfigSelector", "1");
    harness.click("#setDefaultModelButton");
    harness.select("#modelConfigSelector", "0");
    harness.click("#removeModelConfigButton");
    harness.click("#saveProfileButton");
    await harness.settle();

    const saved = commandCalls(harness).at(-1)?.body as {
      kind: string;
      profile: SavedProfile;
    };
    assert.equal(saved.kind, "save_profile");
    assert.deepEqual(saved.profile.connection, {
      kind: "oauth-subscription",
      provider: "openai",
    });
    assert.deepEqual(saved.profile.models[0]?.advanced, {});
    assert.deepEqual(saved.profile.models[0]?.parameters, {
      reasoning: { mode: "default" },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code login controls send strict commands and render backend state safely", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(state);
  try {
    const panel = harness.document.querySelector<HTMLElement>("#oauthAuthPanel");
    const signIn = harness.document.querySelector<HTMLButtonElement>(
      "#oauthSignInButton",
    );
    const check = harness.document.querySelector<HTMLButtonElement>(
      "#oauthCheckAccountButton",
    );
    const logout = harness.document.querySelector<HTMLButtonElement>(
      "#oauthLogoutButton",
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthHeading")?.tagName,
      "H4",
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthState")?.getAttribute("role"),
      "status",
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthState")?.getAttribute("aria-atomic"),
      "true",
    );
    assert.equal(panel?.dataset.authState, "signed-out");
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Signed out",
    );
    assert.match(
      harness.document.querySelector(".subscription-auth-state-title")?.textContent ?? "",
      /sign in to continue/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthAuthStateDetail")?.hidden,
      true,
      "the signed-out state should not repeat the persistent billing note",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      true,
    );
    assert.equal(signIn?.textContent, "Sign in");
    assert.equal(signIn?.classList.contains("primary"), true);
    assert.equal(signIn?.hidden, false);
    assert.equal(check?.textContent, "Check account");
    assert.equal(logout?.hidden, true);

    harness.holdNextCommand();
    signIn?.focus();
    harness.click("#oauthSignInButton");
    await Promise.resolve();
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    assert.equal(harness.document.activeElement, harness.document.body);
    harness.releaseHeldCommand();
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "start_oauth_login",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    const link = harness.document.querySelector<HTMLAnchorElement>("#oauthAuthStatus a");
    assert.equal(link?.href, "https://auth.openai.com/codex/device");
    assert.equal(link?.target, "_blank");
    assert.match(link?.rel ?? "", /\bnoopener\b/);
    assert.match(link?.rel ?? "", /\bnoreferrer\b/);
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      "ABCD-EFGH",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      false,
    );
    assert.equal(panel?.dataset.authState, "pending");
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Waiting",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthDeviceCodeTicket")?.hidden,
      false,
    );
    assert.match(link?.textContent ?? "", /open ChatGPT sign-in page/i);
    assert.equal(signIn?.hidden, true);
    assert.equal(check?.textContent, "Check sign-in");
    assert.equal(check?.classList.contains("primary"), true);
    assert.equal(logout?.textContent, "Cancel sign-in");
    assert.equal(logout?.dataset.busyLabel, "Cancelling…");
    assert.equal(logout?.hidden, false);
    assert.equal(harness.document.activeElement, link);
    assert.equal(
      harness.document.querySelector("#oauthAuthState a"),
      null,
      "the polite status region must not contain interactive controls",
    );

    harness.click("#oauthCheckAccountButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "refresh_oauth_account",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /studio@example\.test \(pro\)/i,
    );
    assert.equal(panel?.dataset.authState, "signed-in");
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Connected",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthDeviceCodeTicket")?.hidden,
      true,
    );
    assert.equal(check?.textContent, "Refresh account");
    assert.equal(logout?.textContent, "Sign out");
    assert.equal(logout?.dataset.busyLabel, "");

    logout?.focus();
    harness.click("#oauthLogoutButton");
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "refresh_oauth_account",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    assert.match(
      harness.document.querySelector("#appConfirmation")?.textContent ?? "",
      /Sign out of ChatGPT.*pending login/is,
    );
    await harness.cancelAppConfirmation();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "refresh_oauth_account",
        profileId: "profile-1",
        provider: "openai",
      },
    });

    harness.click("#oauthLogoutButton");
    harness.document.querySelector<HTMLButtonElement>("#appConfirmationCancel")
      ?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    await Promise.resolve();
    assert.equal(
      harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden,
      true,
    );
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "refresh_oauth_account",
        profileId: "profile-1",
        provider: "openai",
      },
    });

    harness.holdNextCommand();
    harness.click("#oauthLogoutButton");
    await harness.acceptAppConfirmation();
    assert.equal(logout?.textContent, "Signing out…");
    harness.document.body.focus();
    assert.equal(harness.document.activeElement, harness.document.body);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "logout_oauth",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /sign in to continue/i,
    );
    assert.equal(panel?.dataset.authState, "signed-out");
    assert.equal(signIn?.hidden, false);
    assert.equal(logout?.hidden, true);
    assert.equal(harness.document.activeElement, signIn);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("pending sign-in cancellation restores its action after a failed command", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  };
  const harness = await createDialogHarness(state);
  try {
    const logout = harness.document.querySelector<HTMLButtonElement>(
      "#oauthLogoutButton",
    );
    const link = harness.document.querySelector<HTMLAnchorElement>(
      "#oauthVerificationLink",
    );
    harness.failNextCommand("Could not cancel sign-in");
    harness.holdNextCommand();
    logout?.focus();
    harness.click("#oauthLogoutButton");
    await harness.acceptAppConfirmation();

    assert.equal(logout?.textContent, "Cancelling…");
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(logout?.textContent, "Cancel sign-in");
    assert.equal(logout?.disabled, false);
    assert.equal(harness.document.activeElement, link);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not cancel sign-in/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code values are text-only and unsafe backend URLs are not links", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "pending",
    verificationUrl: "javascript:alert(1)",
    userCode: '<img src=x onerror="alert(1)">',
  };
  const harness = await createDialogHarness(state);
  try {
    const status = harness.document.querySelector("#oauthAuthStatus");
    const link = status?.querySelector<HTMLAnchorElement>("#oauthVerificationLink");
    assert.equal(link?.hidden, true);
    assert.equal(link?.hasAttribute("href"), false);
    assert.equal(status?.querySelector("img"), null);
    assert.equal(
      status?.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      '<img src=x onerror="alert(1)">',
    );
    assert.doesNotMatch(status?.textContent ?? "", /javascript:alert\(1\)/);
    assert.match(status?.textContent ?? "", /could not verify the sign-in page/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("device-code links are limited to the verified OpenAI HTTPS host", async () => {
  for (const verificationUrl of [
    "http://auth.openai.com/codex/device",
    "https://example.test/codex/device",
    "https://user@auth.openai.com/codex/device",
  ]) {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.modelStateSource = modelStateSourceFixture(profile);
    state.oauthAuth = {
      status: "pending",
      verificationUrl,
      userCode: "ABCD-EFGH",
    };
    const harness = await createDialogHarness(state);
    try {
      const link = harness.document.querySelector<HTMLAnchorElement>(
        "#oauthVerificationLink",
      );
      assert.equal(link?.hidden, true);
      assert.equal(link?.hasAttribute("href"), false);
      assert.doesNotMatch(
        harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
        new RegExp(verificationUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(
        harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
        /could not verify the sign-in page/i,
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("OAuth provider selection drives native Claude and Antigravity commands", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.select("#connectionKind", "oauth-subscription");
    harness.select("#oauthProvider", "anthropic");
    const authNote = harness.document.querySelector<HTMLElement>("#oauthAuthNote");
    assert.equal(authNote?.hidden, false);
    assert.match(authNote?.textContent ?? "", /Extra Usage.*billed/i);
    harness.click("#oauthSignInButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "start_oauth_login",
        profileId: "profile-1",
        provider: "anthropic",
      },
    });

    harness.select("#oauthProvider", "google");
    assert.equal(authNote?.hidden, true);
    assert.equal(authNote?.textContent, "");
    harness.click("#oauthCheckAccountButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "refresh_oauth_account",
        profileId: "profile-1",
        provider: "google",
      },
    });
  } finally {
    harness.close();
  }
});

test("browser OAuth pending state supports a link without a device code", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "oauth-subscription", provider: "anthropic" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "anthropic";
  state.oauthAuth = {
    status: "pending",
    verificationUrl: "https://claude.ai/oauth/authorize?client_id=test",
  };
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Changed while sign-in is pending");
    assert.equal(
      harness.document.querySelector<HTMLAnchorElement>("#oauthVerificationLink")?.href,
      "https://claude.ai/oauth/authorize?client_id=test",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(".subscription-auth-code-ticket")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#connectionKind")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#oauthProvider")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#oauthLogoutButton")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#discardProfileButton")?.disabled,
      true,
    );
    for (const selector of [
      "#profileSelector",
      "#addProfileButton",
      "#duplicateProfileButton",
      "#deleteProfileButton",
    ]) {
      assert.equal(
        harness.document.querySelector<HTMLButtonElement | HTMLSelectElement>(
          selector,
        )?.disabled,
        true,
        selector,
      );
    }
  } finally {
    harness.close();
  }
});

test("Antigravity browser OAuth accepts the hosted callback authorization code", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    id: "gemini-profile",
    connection: { kind: "oauth-subscription", provider: "google" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "google";
  state.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(state, undefined, {
    oauthLoginResult: {
      status: "pending",
      verificationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
      authorizationCodeInput: true,
    },
  });
  try {
    harness.click("#oauthSignInButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      false,
    );
    assert.match(
      harness.document.querySelector(
        ".subscription-auth-device-guidance",
      )?.textContent ?? "",
      /callback page displays this code/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.readOnly,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#oauthSubmitCodeButton")?.hidden,
      false,
    );
    harness.click("#oauthVerificationLink");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "open_oauth_authorization",
        profileId: profile.id,
        provider: "google",
      },
    });
    assert.deepEqual(harness.windowOpenAttempts, []);

    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    assert.equal(
      commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "refresh_oauth_account"
      ),
      false,
    );

    harness.input("#oauthUserCode", "4/test-antigravity-code");
    const submitCode = harness.document.querySelector<HTMLButtonElement>(
      "#oauthSubmitCodeButton",
    );
    assert.ok(submitCode);
    submitCode.focus();
    harness.click("#oauthSubmitCodeButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "submit_oauth_authorization_code",
        profileId: profile.id,
        provider: "google",
        authorizationCode: "4/test-antigravity-code",
      },
    });
    harness.emitServerEvent({
      type: "oauth_auth_changed",
      profileId: profile.id,
      provider: "google",
      oauthAuthGeneration: state.oauthAuthGeneration + 1,
      oauthAuth: {
        status: "pending",
        verificationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
        authorizationCodeInput: true,
        browserLaunchFailed: true,
      },
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      true,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStateDetail")?.textContent ?? "",
      /could not open the system browser/i,
    );
    const checkAccount = harness.document.querySelector<HTMLButtonElement>(
      "#oauthCheckAccountButton",
    );
    assert.equal(harness.document.activeElement, checkAccount);

    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "refresh_oauth_account"
      ),
      "Expected Antigravity OAuth to check after code submission.",
    );
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Connected",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthDeviceCodeTicket")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      true,
    );
    assert.equal(harness.document.activeElement, checkAccount);
    assert.equal(checkAccount?.closest("[hidden]"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed Antigravity browser launch keeps its active link retryable", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    id: "gemini-browser-retry",
    connection: { kind: "oauth-subscription", provider: "google" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "google";
  state.oauthAuth = { status: "signed-out" };
  const pendingAuth = {
    status: "pending" as const,
    verificationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test",
    authorizationCodeInput: true as const,
  };
  const harness = await createDialogHarness(state, undefined, {
    oauthLoginResult: pendingAuth,
  });
  let commandResponseReleased = false;
  try {
    harness.holdNextCommandResponse();
    harness.click("#oauthSignInButton");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "start_oauth_login"
      ),
      "Expected Antigravity sign-in to reach the bridge.",
    );

    const stateCallsBeforeFailure = jsonCalls(harness, "/state").length;
    harness.emitServerEvent({
      type: "oauth_auth_changed",
      profileId: profile.id,
      provider: "google",
      oauthAuthGeneration: state.oauthAuthGeneration + 1,
      oauthAuth: {
        ...pendingAuth,
        browserLaunchFailed: true,
      },
    });
    await harness.settle();
    assert.equal(jsonCalls(harness, "/state").length, stateCallsBeforeFailure);
    harness.input("#oauthUserCode", "code-being-pasted");

    assert.match(
      harness.document.querySelector("#oauthAuthStateDetail")?.textContent ?? "",
      /could not open the system browser/i,
    );
    assert.match(
      harness.document.querySelector("#oauthVerificationLinkLabel")?.textContent ?? "",
      /retry opening Antigravity sign-in page/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      "code-being-pasted",
    );
    harness.releaseHeldCommandResponse();
    commandResponseReleased = true;
    await harness.settle();
    assert.match(
      harness.document.querySelector("#oauthAuthStateDetail")?.textContent ?? "",
      /could not open the system browser/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      "code-being-pasted",
    );

    const coveredFailure = harness.deferServerEvent({
      type: "oauth_auth_changed",
      profileId: profile.id,
      provider: "google",
      oauthAuthGeneration: state.oauthAuthGeneration + 1,
      oauthAuth: {
        ...pendingAuth,
        browserLaunchFailed: true,
      },
    });
    harness.click("#oauthVerificationLink");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "open_oauth_authorization",
        profileId: profile.id,
        provider: "google",
      },
    });
    harness.emitRawServerEvent(coveredFailure);
    await harness.settle();
    assert.doesNotMatch(
      harness.document.querySelector("#oauthAuthStateDetail")?.textContent ?? "",
      /could not open the system browser/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandResponseReleased) harness.releaseHeldCommandResponse();
    harness.close();
  }
});

test("automatic OAuth checks do not turn a saved Profile provisional while another command runs", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    id: "gemini-saved-pending",
    connection: { kind: "oauth-subscription", provider: "google" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "google";
  state.oauthAuth = {
    status: "pending",
    verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  };
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.holdNextCommand();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "set_session_approval_mode"
      ),
      "Expected the Session command to remain in flight.",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    assert.equal(
      commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "refresh_oauth_account"
      ),
      false,
    );

    harness.releaseHeldCommand();
    commandReleased = true;
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "refresh_oauth_account"
      ),
      "Expected the automatic OAuth check after the Session command.",
    );
    await harness.settle();
    assert.equal(
      harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
      "Connected",
    );

    harness.click("#addProfileButton");
    await harness.settle();
    assert.equal(
      commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "discard_profile_oauth"
      ),
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("Antigravity account verification is actionable without a one-time code", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    id: "gemini-validation-profile",
    connection: { kind: "oauth-subscription", provider: "google" },
    parameters: { reasoning: { mode: "default" } },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.oauthAuthProfileId = profile.id;
  state.oauthAuthProvider = "google";
  state.oauthAuth = {
    status: "unavailable",
    message: "Google requires an additional account verification before Antigravity can be used.",
    definitive: true,
    verificationUrl: "https://accounts.google.com/signin/continue?test=1",
    verificationLabel: "Verify Google account",
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector("#oauthVerificationLinkLabel")?.textContent,
      "Verify Google account",
    );
    assert.equal(
      harness.document.querySelector<HTMLAnchorElement>("#oauthVerificationLink")?.href,
      "https://accounts.google.com/signin/continue?test=1",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthDeviceCodeTicket")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".subscription-auth-code-ticket",
      )?.hidden,
      true,
    );
    harness.click("#oauthVerificationLink");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "open_oauth_authorization",
        profileId: profile.id,
        provider: "google",
      },
    });
    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("global follow-up saves and events preserve pending credential-free auth state", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "pending",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  };
  const harness = await createDialogHarness(state);
  try {
    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      "ABCD-EFGH",
    );

    harness.emitServerEvent({
      type: "global_settings_changed",
      defaultFollowUpBehavior: "queue",
      defaultFollowUpBehaviorRevision: "2",
      showContextUsage: true,
      contextUsageVisibilityRevision: "0",
      commandId: "other-dialog-save",
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#oauthUserCode")?.value,
      "ABCD-EFGH",
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

test("Apply confirmation locks Profile and auth controls but permits follow-up saves", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare a protected Live change");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "subscription-confirm",
      message: "Apply the proposed changes?",
      groups: [{ title: "Tracks", rows: ["Create track"] }],
    });

    for (const selector of [
      "#profileName",
      "#connectionKind",
      "#saveProfileButton",
      "#oauthSignInButton",
      "#oauthCheckAccountButton",
      "#oauthLogoutButton",
    ]) {
      assert.equal(
        harness.document.querySelector<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
          selector,
        )?.disabled,
        true,
        selector,
      );
    }
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#defaultFollowUpBehavior",
      )?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#showContextUsage")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#networkProxyModeSystem")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(".skill-view")?.disabled,
      false,
    );

    harness.select("#defaultFollowUpBehavior", "steer");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "save_global_settings",
        defaultFollowUpBehavior: "steer",
      },
    });
    assert.ok(harness.document.querySelector(".confirm-card"));
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        "#oauthCheckAccountButton",
      )?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /studio@example\.test \(pro\)/i,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clean subscription Profiles disable Send until an eligible account is signed in", async () => {
  const cases = [
    {
      auth: { status: "signed-out" } as const,
      badge: "Signed out",
      checkLabel: "Check account",
      detailHidden: true,
      logoutHidden: true,
      message: /sign in to ChatGPT before sending/i,
      panelState: "signed-out",
      signInHidden: false,
      title: /sign in to continue/i,
    },
    {
      auth: {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      } as const,
      badge: "Waiting",
      checkLabel: "Check sign-in",
      detailHidden: false,
      logoutHidden: false,
      message: /complete ChatGPT sign-in before sending/i,
      panelState: "pending",
      signInHidden: true,
      title: /finish sign-in/i,
    },
    {
      auth: {
        status: "unavailable",
        definitive: true,
        message:
          "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
      } as const,
      badge: "Unavailable",
      checkLabel: "Check again",
      detailHidden: false,
      logoutHidden: false,
      message: /Manual proxy could not be reached/i,
      panelState: "unavailable",
      signInHidden: false,
      title: /sign-in failed/i,
    },
    {
      auth: {
        status: "signed-in",
        accountLabel: "managed@example.test",
        planType: "business",
        subscriptionEligible: false,
      } as const,
      badge: "Not eligible",
      checkLabel: "Refresh account",
      detailHidden: false,
      logoutHidden: false,
      message: /account is not eligible for subscription requests/i,
      panelState: "ineligible",
      signInHidden: true,
      title: /account isn.t supported/i,
    },
  ];

  for (const entry of cases) {
    const state = stateFixture();
    const profile = subscriptionProfile();
    state.settings.profiles = [profile];
    state.settings.activeProfileId = profile.id;
    state.modelStateSource = modelStateSourceFixture(profile);
    state.oauthAuth = entry.auth;
    const harness = await createDialogHarness(state);
    try {
      const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
      assert.equal(
        harness.document.querySelector<HTMLElement>("#oauthAuthPanel")?.dataset.authState,
        entry.panelState,
      );
      assert.equal(
        harness.document.querySelector("#oauthAuthStateBadge")?.textContent,
        entry.badge,
      );
      assert.match(
        harness.document.querySelector("#oauthAuthStateLabel")?.textContent ?? "",
        entry.title,
      );
      assert.equal(
        harness.document.querySelector<HTMLButtonElement>("#oauthSignInButton")?.hidden,
        entry.signInHidden,
      );
      assert.equal(
        harness.document.querySelector("#oauthCheckAccountButton")?.textContent,
        entry.checkLabel,
      );
      assert.equal(
        harness.document.querySelector<HTMLElement>("#oauthAuthStateDetail")?.hidden,
        entry.detailHidden,
      );
      assert.equal(
        harness.document.querySelector<HTMLButtonElement>("#oauthLogoutButton")?.hidden,
        entry.logoutHidden,
      );
      assert.equal(send?.disabled, true, entry.auth.status);
      assert.match(send?.title ?? "", entry.message);
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        entry.message,
      );
      harness.input("#prompt", `Blocked ${entry.auth.status} subscription request`);
      submitFromComposer(harness);
      await harness.settle();
      assert.equal(
        harness.calls.some((call) => call.path === "/send"),
        false,
        entry.auth.status,
      );
      assert.equal(
        harness.document.querySelector("#status")?.textContent,
        send?.title,
        entry.auth.status,
      );
      if (entry.auth.status === "signed-in") {
        assert.match(
          harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
          /cannot use the selected subscription backend/i,
        );
        assert.equal(
          harness.document.querySelector<HTMLButtonElement>(
            "#oauthCheckAccountButton",
          )?.disabled,
          false,
        );
        assert.equal(
          harness.document.querySelector<HTMLButtonElement>(
            "#oauthLogoutButton",
          )?.disabled,
          false,
        );
      }
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("a definitive sign-in failure offers a new ChatGPT sign-in attempt", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "unavailable",
    message: "ChatGPT sign-in did not complete. Start a new sign-in and try again.",
    definitive: true,
  };
  const harness = await createDialogHarness(state);
  try {
    const signIn = harness.document.querySelector<HTMLButtonElement>(
      "#oauthSignInButton",
    );
    assert.equal(signIn?.hidden, false);
    assert.equal(signIn?.disabled, false);
    assert.match(signIn?.textContent ?? "", /try sign-in again/i);

    harness.click("#oauthSignInButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "start_oauth_login",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unavailable OAuth account can sign out before starting over", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "unavailable",
    message: "ChatGPT OAuth refresh failed.",
  };
  const harness = await createDialogHarness(state);
  try {
    const logout = harness.document.querySelector<HTMLButtonElement>(
      "#oauthLogoutButton",
    );
    assert.equal(logout?.hidden, false);
    assert.equal(logout?.disabled, false);

    harness.click("#oauthLogoutButton");
    await harness.acceptAppConfirmation();
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "logout_oauth",
        profileId: "profile-1",
        provider: "openai",
      },
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clean subscription Profiles enable Send for an eligible signed-in account", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: '<img src=x onerror="alert(1)">',
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector("#oauthAuthStatus img"), null);
    assert.match(
      harness.document.querySelector("#oauthAuthStatus")?.textContent ?? "",
      /<img src=x onerror="alert\(1\)">/,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#oauthAuthStateDetail")?.hidden,
      false,
    );
    const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(send?.disabled, false);
    assert.equal(send?.title, "Send (Cmd/Ctrl+Enter)");
    harness.input("#prompt", "Send through the eligible subscription");
    submitFromComposer(harness);
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clean Direct API Profiles keep the composer shortcut available", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.input("#prompt", "Send through the direct API");
    submitFromComposer(harness);
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("OAuth subscription image input is sendable while audio and PDF stay disabled", async () => {
  const state = stateFixture();
  const profile = subscriptionProfile();
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  state.runtimeProfile = {
    profile: {
      id: profile.id,
      name: profile.name,
      connectionKind: "oauth-subscription",
      apiFamily: "openai",
      apiMode: null,
    },
    selection: {
      model: profile.defaultModel,
      reasoning: { mode: "default" },
    },
    capabilities: {
      ...capabilities(),
      inputs: { image: true, audio: true, pdf: true },
    },
    inputCapabilityEvidence: {
      image: "supported",
      audio: "supported",
      pdf: "supported",
    },
  };
  state.pendingAttachments = [pendingImage("image-1", "cover.png")];
  const supportedHarness = await createDialogHarness(state);
  try {
    supportedHarness.input("#prompt", "Review these inputs");
    supportedHarness.click("#sendButton");
    await supportedHarness.settle();
    assert.equal(
      supportedHarness.calls.filter((call) => call.path === "/send").length,
      1,
    );
    assert.deepEqual(supportedHarness.errors, []);
  } finally {
    supportedHarness.close();
  }

  state.pendingAttachments = [pendingAudio("audio-1", "mix.wav")];
  const audioHarness = await createDialogHarness(state);
  try {
    audioHarness.input("#prompt", "Review the audio");
    audioHarness.click("#sendButton");
    await audioHarness.settle();
    assert.equal(audioHarness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      audioHarness.document.querySelector("#status")?.textContent ?? "",
      /OpenAI Chat Completions Profile/i,
    );
    assert.deepEqual(audioHarness.errors, []);
  } finally {
    audioHarness.close();
  }

  state.pendingAttachments = [pendingDocument("pdf-1", "score.pdf", "application/pdf")];
  const pdfHarness = await createDialogHarness(state);
  try {
    pdfHarness.input("#prompt", "Review the PDF");
    pdfHarness.click("#sendButton");
    await pdfHarness.settle();
    assert.equal(pdfHarness.calls.some((call) => call.path === "/send"), false);
    assert.match(
      pdfHarness.document.querySelector("#status")?.textContent ?? "",
      /PDF attachments require verified PDF input support with OpenAI Responses or Anthropic Messages/i,
    );
    assert.deepEqual(pdfHarness.errors, []);
  } finally {
    pdfHarness.close();
  }
});
