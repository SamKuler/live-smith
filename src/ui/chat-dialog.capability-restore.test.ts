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
  jsonCalls,
  profileFixture,
  renderedCapabilityStatuses,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

type DialogHarness = Awaited<ReturnType<typeof createDialogHarness>>;

function capabilityCalls(harness: DialogHarness) {
  return jsonCalls(harness, "/session-model-capabilities");
}

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
    connection: { kind: "oauth-subscription", provider: "openai" },
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
  state.oauthAuth = {
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
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected missing subscription capabilities to load when the window opens.");
    await harness.settle();
    assert.deepEqual(capabilityCalls(harness).map((call) => call.body), [{
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
    assert.equal(capabilityCalls(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("restoring a saved subscription Session loads its reasoning capabilities after the command unlocks", async () => {
  const initial = subscriptionState();
  initial.openSettingsOnLoad = false;
  initial.oauthAuth = { status: "signed-out" };
  const historicalSession = {
    id: "session-history",
    title: "Historical subscription Session",
    projectKey: "previous-project",
    scope: { kind: "track" as const, identity: "track-history", label: "Drums" },
    modelSelection: {
      profileId: "profile-1",
      model: "model-b",
      reasoningEffort: "high" as const,
    },
    createdAt: "2026-08-01T00:02:00.000Z",
    updatedAt: "2026-08-01T00:02:00.000Z",
  };
  initial.previousSessions = [historicalSession];

  const server = subscriptionState(true);
  server.configuredModelsReady = false;
  server.previousSessions = [historicalSession];
  const modelB = server.availableModels.find((model) => model.id === "model-b")!;
  modelB.capabilities.reasoning = {
    supported: true,
    canDisable: false,
    efforts: ["low", "high"],
    budgetTokens: false,
    strategy: "effort",
  };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: server,
  });
  try {
    assert.deepEqual(capabilityCalls(harness), []);
    harness.click('[data-continue-session-id="session-history"]');
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected restored Session capabilities to load after restore_session completed.");
    await harness.settle();

    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{
      kind: "restore_session", sessionId: "session-history",
    }]);
    assert.deepEqual(capabilityCalls(harness).map((call) => call.body), [{
      kind: "load_session_model_capabilities",
      sessionId: "session-history",
      profileId: "profile-1",
    }]);
    assert.deepEqual(
      harness.calls
        .filter((call) => ["/command", "/session-model-capabilities"].includes(call.path))
        .map((call) => call.path),
      ["/command", "/session-model-capabilities"],
    );
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    )!;
    assert.equal(reasoning.closest<HTMLElement>(".composer-runtime-field")?.hidden, false);
    assert.deepEqual([...reasoning.options].map((option) => option.value), [
      "", "low", "high",
    ]);
    assert.equal(reasoning.value, "high");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a pending startup capability read leaves drafts and Session switching usable and deduplicates focus", async () => {
  const initial = subscriptionState();
  const loaded = subscriptionState(true);
  initial.openSettingsOnLoad = false;
  loaded.sessions[1]!.modelSelection = { profileId: "profile-1", model: "model-b" };
  initial.sessions[1]!.modelSelection = { ...loaded.sessions[1]!.modelSelection };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: loaded,
    holdInitialCommandResponse: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected the startup capability read to remain pending.");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    const model = harness.document.querySelector<HTMLSelectElement>("#composerModel")!;
    assert.equal(prompt.disabled, false);
    assert.equal(model.disabled, false);
    harness.input("#prompt", "Keep the Bass draft");
    model.focus();
    model.blur();
    model.focus();
    await harness.settle();
    assert.equal(capabilityCalls(harness).length, 1);
    assert.deepEqual(commandCalls(harness), []);

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => commandCalls(harness).length === 1,
      "Expected Session selection to execute while capability loading is pending.");
    await harness.settle();
    assert.deepEqual(commandCalls(harness)[0]?.body, {
      kind: "select_session", sessionId: "session-2",
    });
    assert.equal(harness.document.querySelector('.session-row[aria-pressed="true"]')
      ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId, "session-2");
    assert.equal(model.value, "model-b");
    harness.input("#prompt", "Keep the Lead draft");
    harness.input("#profileName", "Keep the unsaved Profile name");

    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.equal(prompt.value, "Keep the Lead draft");
    assert.equal(model.value, "model-b");
    assert.equal(harness.document.querySelector('.session-row[aria-pressed="true"]')
      ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId, "session-2");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Keep the unsaved Profile name");
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    assert.equal(capabilityCalls(harness).length, 1);

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(prompt.value, "Keep the Bass draft");
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("startup capability loading applies the runtime after an immediate Session switch", async () => {
  const selection = {
    profileId: "profile-1",
    model: "model-b",
    reasoningEffort: "high" as const,
  };
  const initial = subscriptionState();
  initial.openSettingsOnLoad = false;
  initial.sessions[1]!.modelSelection = { ...selection };
  const server = subscriptionState();
  server.openSettingsOnLoad = false;
  server.sessions[1]!.modelSelection = { ...selection };

  const loadedCatalog: DiscoveredModelInfo[] = catalog.map((model) =>
    model.id === "model-b"
      ? {
          ...model,
          capabilities: {
            ...model.capabilities,
            reasoning: {
              supported: true,
              canDisable: false,
              efforts: ["low", "high"],
              budgetTokens: false,
              strategy: "effort",
            },
          },
        }
      : model
  );
  const loaded = subscriptionState(true);
  const profile = loaded.settings.profiles[0]!;
  loaded.sessions[1]!.modelSelection = { ...selection };
  loaded.activeSessionId = "session-2";
  loaded.approvalMode = loaded.sessions[1]!.approvalMode ?? "manual";
  Object.assign(loaded, capabilityPreviewForProfile(profile, loadedCatalog));
  loaded.availableModels = resolveDiscoveredModels(profile, loadedCatalog);
  loaded.configuredModels = chatConfiguredModels(profile, loadedCatalog);
  loaded.configuredModelsReady = true;
  loaded.runtimeProfile = chatRuntimeSummary(runtimeProfileForSavedProfile(
    profile,
    loadedCatalog,
    { model: selection.model, reasoningEffort: selection.reasoningEffort },
  ));

  const harness = await createDialogHarness(initial, undefined, {
    serverState: server,
    holdInitialCommand: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected startup capability loading to wait before server mutation.");
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => commandCalls(harness).length === 1,
      "Expected the Session switch to complete while capability loading waits.");
    await waitForCondition(() => harness.document.querySelector(
      '.session-entry[data-session-id="session-2"] .session-row',
    )?.getAttribute("aria-pressed") === "true", "Expected Session 2 to become active.");

    const model = harness.document.querySelector<HTMLSelectElement>("#composerModel")!;
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    )!;
    assert.equal(model.value, "model-b");
    assert.equal(reasoning.closest<HTMLElement>(".composer-runtime-field")?.hidden, true);

    harness.setServerState(loaded);
    harness.releaseHeldCommand();
    released = true;
    await harness.settle();

    assert.equal(model.value, "model-b");
    assert.equal(reasoning.closest<HTMLElement>(".composer-runtime-field")?.hidden, false);
    assert.deepEqual([...reasoning.options].map((option) => option.value), [
      "", "low", "high",
    ]);
    assert.equal(reasoning.value, "high");
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("Send is admitted while the startup capability response is still pending", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
    holdInitialCommandResponse: true,
  });
  let capabilityReleased = false;
  let sendReleased = false;
  harness.holdNextSend();
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected the startup capability read to remain pending.");
    harness.input("#prompt", "Inspect the selected track");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
    harness.click("#sendButton");
    await waitForCondition(() => jsonCalls(harness, "/send").length === 1,
      "Expected Send to reach the bridge before capability loading finishes.");
    assert.deepEqual(jsonCalls(harness, "/send")[0]?.body, {
      prompt: "Inspect the selected track", sessionId: "session-1",
    });
    assert.deepEqual(commandCalls(harness), []);

    harness.releaseHeldCommandResponse();
    capabilityReleased = true;
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButtonLabel")?.textContent, "Stop");
    assert.equal(capabilityCalls(harness).length, 1);
    harness.releaseHeldSend();
    sendReleased = true;
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButtonLabel")?.textContent, "Send");
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!capabilityReleased) harness.releaseHeldCommandResponse();
    if (!sendReleased) harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a late capability response preserves a foreground Session model selection", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
    holdInitialCommandResponse: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected the startup capability read to remain pending.");
    harness.select("#composerModel", "model-b");
    await harness.settle();
    assert.deepEqual(commandCalls(harness)[0]?.body, {
      kind: "set_session_model_selection", sessionId: "session-1",
      profileId: "profile-1", model: "model-b", reasoningEffort: null,
    });
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value, "model-b");
    harness.input("#prompt", "Use the selected model");
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value, "model-b");
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value, "Use the selected model");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a late capability response cannot overwrite a newly saved revision of the same Profile", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
    holdInitialCommandResponse: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected the startup capability read to remain pending.");
    harness.input("#profileName", "Saved while capability loading was pending");
    harness.click("#saveProfileButton");
    await harness.settle();
    assert.equal((commandCalls(harness)[0]?.body as { kind?: string })?.kind, "save_profile");
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Saved while capability loading was pending");
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.selectedOptions[0]?.textContent,
      "Saved while capability loading was pending");
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.equal(capabilityCalls(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

for (const foreground of ["another Session", "a send"] as const) {
test(`a late capability error does not replace status for ${foreground}`, async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true), holdInitialCommandResponse: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1, "Expected startup read.");
    if (foreground === "another Session") {
      harness.click('.session-entry[data-session-id="session-2"] .session-row');
      await harness.settle();
    } else {
      harness.holdNextSend();
      harness.input("#prompt", "Inspect this track");
      harness.click("#sendButton");
      await waitForCondition(() => jsonCalls(harness, "/send").length === 1, "Expected send.");
    }
    const status = harness.document.querySelector("#status")?.textContent;
    harness.rejectNextCommandResponse("Old capability request failed.");
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.equal(harness.document.querySelector("#status")?.textContent, status);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    if (foreground === "a send") harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});
}

test("an explicit same-source capability load updates Settings as well as the composer", async () => {
  const initial = subscriptionState();
  initial.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: subscriptionState(true),
  });
  try {
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(capabilityCalls(harness).length, 1);
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
  ] as Array<ChatBridgeState["oauthAuth"]>) {
    const state = subscriptionState();
    if (auth === undefined) delete state.oauthAuth;
    else state.oauthAuth = auth;
    states.push(state);
  }
  for (const state of states) {
    const harness = await createDialogHarness(state);
    try {
      await harness.settle();
      assert.deepEqual(capabilityCalls(harness), []);
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
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected a single startup capability attempt.");
    await harness.settle();
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /temporarily unavailable/);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled, false);
    harness.input("#prompt", "Keep working while the catalog is unavailable");
    harness.click("#skillsTab");
    harness.click("#settingsTab");
    await harness.settle();
    assert.equal(capabilityCalls(harness).length, 1);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#discoverModelsButton")?.disabled, false);
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(capabilityCalls(harness).length, 2);
    assert.deepEqual(renderedCapabilityStatuses(harness), modelAInputs);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Keep working while the catalog is unavailable");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed capability transport leaves foreground commands usable without automatic reconciliation", async () => {
  const harness = await createDialogHarness(subscriptionState(), undefined, {
    serverState: subscriptionState(true),
    holdInitialCommandResponse: true,
  });
  let released = false;
  try {
    await waitForCondition(() => capabilityCalls(harness).length === 1,
      "Expected the startup capability read to remain pending.");
    harness.rejectNextCommandResponse("The catalog response was lost.");
    harness.releaseHeldCommandResponse();
    released = true;
    await harness.settle();
    assert.deepEqual(renderedCapabilityStatuses(harness), unknownInputs);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /response was lost/);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled, false);
    assert.deepEqual(jsonCalls(harness, "/state"), []);

    harness.select("#approvalMode", "everything");
    await harness.settle();
    assert.deepEqual(commandCalls(harness)[0]?.body, {
      kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "everything",
    });
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value, "everything");
    assert.equal(capabilityCalls(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a delayed same-source capability result restores Settings without reverting peer Session changes", async () => {
  const initial = subscriptionState();
  initial.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial, undefined, {
    serverState: subscriptionState(true),
  });
  harness.holdNextCommandResponse();
  let released = false;
  try {
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await waitForCondition(() => capabilityCalls(harness).length === 1, "Expected the capability request.");
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
  initial.oauthAuth = { status: "signed-out" };
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
    assert.equal(capabilityCalls(harness).length, 1);
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
  initial.oauthAuth = { status: "signed-out" };
  const harness = await createDialogHarness(initial);
  harness.holdNextCommand();
  let released = false;
  try {
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await waitForCondition(() => capabilityCalls(harness).length === 1, "Expected the held capability request.");
    const signedOut = subscriptionState();
    signedOut.oauthAuthGeneration = 1;
    signedOut.oauthAuth = { status: "signed-out" };
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
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#oauthSignInButton")?.hidden, false);
    assert.doesNotMatch(harness.document.querySelector("#modelConfigSelector")?.textContent ?? "", /Model A/);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!released) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});
