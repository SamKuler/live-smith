import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityPreviewForProfile,
  resolveDiscoveredModels,
  runtimeProfileForSavedProfile,
} from "../app/model-request.js";
import type { DiscoveredModelInfo } from "../model/provider.js";
import { savedProfileRevision } from "../storage/settings.js";
import {
  chatConfiguredModels,
  chatRuntimeSummary,
  modelStateSourceForProfile,
  type ChatBridgeState,
} from "./chat-state.js";
import {
  commandCalls,
  createDialogHarness,
  profileFixture,
  renderedCapabilityStatuses,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

const catalog: DiscoveredModelInfo[] = [{
  id: "model-a",
  displayName: "Model A",
  capabilities: {
    temperature: "unsupported",
    reasoning: {
      supported: true, canDisable: false, efforts: ["low", "high"],
      budgetTokens: false, strategy: "effort",
    },
    inputs: { image: true, audio: false },
  },
}, {
  id: "model-b",
  displayName: "Model B",
  capabilities: {
    inputs: { image: false, audio: true, pdf: false },
  },
}, {
  id: "not-configured",
  displayName: "Not configured",
  capabilities: {},
}];

function subscriptionState(loaded = false): ChatBridgeState {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: { reasoning: { mode: "enabled", effort: "high" } },
      advanced: {},
    }, {
      model: "model-b",
      parameters: { reasoning: { mode: "default" } },
      advanced: {},
    }],
  });
  const models = loaded ? catalog : [];
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = savedProfileRevision(profile);
  state.modelStateSource = modelStateSourceForProfile(profile);
  Object.assign(state, capabilityPreviewForProfile(profile, models));
  state.availableModels = resolveDiscoveredModels(profile, models);
  state.configuredModels = chatConfiguredModels(profile, models);
  state.configuredModelsReady = loaded;
  state.runtimeProfile = chatRuntimeSummary(runtimeProfileForSavedProfile(profile, models));
  state.codexAuth = {
    status: "signed-in", accountLabel: "studio@example.test",
    planType: "pro", subscriptionEligible: true,
  };
  return state;
}

const unknownInputs = [
  ["Image ?", "unverified"],
  ["Audio ?", "unverified"],
  ["PDF ?", "unverified"],
];
const modelAInputs = [
  ["Image ✓", "supported"],
  ["Audio ×", "unsupported"],
  ["PDF ?", "unverified"],
];

test("opening a saved subscription restores every configured model's capabilities without Save", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
  });
  try {
    await waitForCondition(() => commandCalls(harness).length === 1,
      "Expected missing subscription capabilities to load when the window opens.");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "load_session_model_capabilities", sessionId: "session-1", profileId: "profile-1",
    }]);
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    const models = harness.document.querySelector<HTMLSelectElement>("#modelConfigSelector");
    assert.deepEqual([...models!.options].map((option) => option.textContent), [
      "Model A · model-a · Default", "Model B · model-b",
    ]);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#composerReasoning")?.disabled, false);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#composerReasoning")?.value, "high");
    assert.deepEqual(
      [...harness.document.querySelector<HTMLSelectElement>("#composerReasoning")!.options]
        .map((option) => option.value),
      ["", "low", "high"],
    );
    harness.select("#modelConfigSelector", "1");
    assert.deepEqual(renderedCapabilityStatuses(harness), [
      ["Image ×", "unsupported"], ["Audio ✓", "supported"], ["PDF ×", "unsupported"],
    ]);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled, true);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an explicit same-source capability load updates Settings as well as the composer", async () => {
  const initial = subscriptionState();
  initial.codexAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: subscriptionState(true),
  });
  try {
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 1);
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("startup capability loading skips Direct API, ready catalogs and unavailable subscription accounts", async () => {
  const states = [stateFixture(), subscriptionState(true)];
  for (const auth of [
    undefined,
    { status: "signed-out" },
    { status: "unavailable", message: "Account unavailable", definitive: true },
    { status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" },
    { status: "signed-in", planType: "team", subscriptionEligible: false },
  ] as Array<ChatBridgeState["codexAuth"]>) {
    const state = subscriptionState();
    if (auth === undefined) delete state.codexAuth;
    else state.codexAuth = auth;
    states.push(state);
  }
  for (const state of states) {
    const harness = await createDialogHarness(state);
    try {
      await harness.settle();
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("a failed startup capability load stays unknown without looping and can be retried explicitly", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
    initialCommandError: "The model catalog is temporarily unavailable.",
  });
  try {
    await waitForCondition(() => commandCalls(harness).length === 1,
      "Expected a single startup capability attempt.");
    await harness.settle();
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /temporarily unavailable/);
    harness.click("#skillsTab");
    harness.click("#settingsTab");
    await harness.settle();
    assert.equal(commandCalls(harness).length, 1);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#discoverModelsButton")?.disabled, false);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 2);
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed same-source capability result restores Settings without reverting peer Session changes", async () => {
  const initial = subscriptionState();
  initial.codexAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: subscriptionState(true),
  });
  harness.holdNextCommandResponse();
  let released = false;
  try {
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await waitForCondition(() => commandCalls(harness).length === 1, "Expected the capability request.");
    harness.emitServerEvent({
      type: "approval_mode_changed", sessionId: "session-1", approvalMode: "everything",
      updatedAt: "2026-08-26T08:00:00.000Z",
    });
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value, "everything");
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("subscription capability loading cannot replace another connection's Draft evidence", async () => {
  const initial = subscriptionState();
  initial.codexAuth = { status: "signed-out" };
  const draft = profileFixture({
    connection: {
      kind: "direct-api", apiFamily: "openai", apiMode: "responses",
      baseUrl: "http://127.0.0.1:1234/v1", apiKey: "",
    },
  });
  const draftCatalog: DiscoveredModelInfo[] = [{
    id: "model-a", displayName: "Direct model",
    capabilities: { inputs: { image: false, audio: false, pdf: true } },
  }];
  initial.modelStateSource = modelStateSourceForProfile(draft);
  Object.assign(initial, capabilityPreviewForProfile(draft, draftCatalog));
  initial.availableModels = resolveDiscoveredModels(draft, draftCatalog);
  const harness = await createDialogHarness(initial, undefined, {
    serverState: subscriptionState(true),
  });
  try {
    harness.select("#connectionKind", "direct-api");
    harness.input("#baseUrl", "http://127.0.0.1:1234/v1");
    harness.input("#profileName", "Keep this unsaved connection");
    const expected = [["Image ×", "unsupported"], ["Audio ×", "unsupported"], ["PDF ✓", "supported"]];
    assert.deepEqual(renderedCapabilityStatuses(harness), expected);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(commandCalls(harness).length, 1);
    assert.deepEqual(renderedCapabilityStatuses(harness), expected);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#profileName")?.value, "Keep this unsaved connection");
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#connectionKind")?.value, "direct-api");
    assert.match(harness.document.querySelector("#modelConfigSelector")?.textContent ?? "", /Direct model/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late capability response cannot restore evidence from an older ChatGPT auth generation", async () => {
  const initial = subscriptionState();
  initial.codexAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial);
  harness.holdNextCommand();
  let released = false;
  try {
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await waitForCondition(() => commandCalls(harness).length === 1, "Expected the held capability request.");
    const signedOut = subscriptionState();
    signedOut.codexAuthGeneration = 1;
    signedOut.codexAuth = { status: "signed-out" };
    harness.setServerState(signedOut);
    harness.emitServerEvent({ type: "profile_settings_changed", commandId: "peer-refresh" });
    await waitForCondition(() => harness.calls.some((call) => call.path === "/state"), "Expected a newer authoritative state.");
    await harness.settle();
    harness.setServerState(subscriptionState(true));
    harness.releaseHeldCommand();
    released = true;
    await harness.settle();
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#composerReasoning")?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#codexSignInButton")?.hidden, false);
    assert.doesNotMatch(harness.document.querySelector("#modelConfigSelector")?.textContent ?? "", /Model A/);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});
