import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DISCOVERED_MODEL_COUNT } from "../model/catalog.js";
import {
  capabilities,
  capabilityEvidence,
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

test("composer model and reasoning selectors use Session runtime without touching the Profile Draft", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "enabled", effort: "high" },
        },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "enabled", effort: "low" },
        },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: true,
      canDisable: true,
      efforts: ["high"],
      budgetTokens: false,
      strategy: "effort",
    },
  };
  state.capabilityEvidence.reasoning = "supported";
  state.runtimeProfile!.capabilities = JSON.parse(
    JSON.stringify(state.capabilities),
  ) as typeof state.capabilities;
  state.runtimeProfile!.selection = {
    model: "model-a",
    reasoning: { mode: "enabled", effort: "high" },
  };
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const settings = harness.document.querySelector<HTMLButtonElement>("#settingsButton");
    const model = harness.document.querySelector<HTMLSelectElement>("#composerModel");
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(harness.document.querySelector("header")?.contains(settings), true);
    assert.equal(settings?.getAttribute("aria-controls"), "inspectorPane");
    assert.equal(model?.closest(".composer")?.classList.contains("composer"), true);
    assert.equal(model?.value, "model-a");
    assert.equal(model?.selectedOptions[0]?.textContent, "Model A");
    assert.equal(reasoning?.value, "high");
    assert.equal(
      reasoning?.closest<HTMLElement>(".composer-runtime-field")?.hidden,
      false,
    );
    assert.equal(model?.getAttribute("aria-label"), "Model for the active Session");
    assert.equal(
      reasoning?.getAttribute("aria-label"),
      "Reasoning effort for the active Session",
    );
    const originalModelOption = model?.options[0];

    harness.input("#manualModelId", "unsaved-draft-model");
    harness.click("#addManualModelButton");
    harness.select("#reasoningMode", "default");

    assert.equal(model?.options[0], originalModelOption);
    assert.equal(model?.value, "model-a");
    assert.equal(reasoning?.value, "high");
    harness.select("#composerModel", "model-b");
    await harness.settle();
    const selection = commandCalls(harness).find((call) =>
      (call.body as { kind?: string }).kind === "set_session_model_selection"
    );
    assert.deepEqual(selection?.body, {
      kind: "set_session_model_selection",
      sessionId: "session-1",
      profileId: "profile-1",
      model: "model-b",
      reasoningEffort: null,
    });
    assert.equal(model?.value, "model-b");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#modelConfigSelector",
      )?.selectedOptions[0]?.textContent,
      "unsaved-draft-model",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer selections stay visible while their Session update is pending", async () => {
  const state = stateFixture();
  const profile = state.settings.profiles[0]!;
  profile.models.push({
    ...JSON.parse(JSON.stringify(profile.models[0])),
    model: "model-b",
  });
  state.configuredModels.push({ model: "model-b", label: "Model B" });
  state.runtimeProfile!.capabilities.reasoning = {
    supported: true,
    canDisable: true,
    efforts: ["low", "high"],
    budgetTokens: false,
    strategy: "effort",
  };
  state.runtimeProfile!.selection.reasoning = {
    mode: "enabled",
    effort: "low",
  };
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const model = harness.document.querySelector<HTMLSelectElement>(
      "#composerModel",
    );
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    const status = harness.document.querySelector<HTMLElement>("#status");
    assert.ok(model);
    assert.ok(reasoning);
    assert.ok(status);
    const modelOptions = [...model.options];
    const reasoningOptions = [...reasoning.options];

    harness.holdNextCommandResponse();
    harness.select("#composerModel", "model-b");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_model_selection"
      ),
      "Expected the model selection command to remain pending.",
    );
    assert.equal(model.value, "model-b");
    assert.equal(model.getAttribute("aria-busy"), "true");
    assert.equal(status.hidden, true);
    assert.deepEqual([...model.options], modelOptions);
    assert.deepEqual([...reasoning.options], reasoningOptions);
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(model.value, "model-b");

    harness.holdNextCommandResponse();
    harness.select("#composerReasoning", "high");
    await waitForCondition(
      () => commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_model_selection"
      ).length === 2,
      "Expected the reasoning selection command to remain pending.",
    );
    assert.equal(reasoning.value, "high");
    assert.equal(reasoning.getAttribute("aria-busy"), "true");
    assert.equal(status.hidden, true);
    assert.deepEqual([...model.options], modelOptions);
    assert.deepEqual([...reasoning.options], reasoningOptions);
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(reasoning.value, "high");

    harness.holdNextCommand();
    harness.failNextCommand("Could not save Session model selection");
    harness.select("#composerModel", "model-a");
    await waitForCondition(
      () => commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_model_selection"
      ).length === 3,
      "Expected the failed model selection command to remain pending.",
    );
    assert.equal(model.value, "model-a");
    assert.deepEqual([...model.options], modelOptions);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(model.value, "model-b");
    assert.match(status.textContent ?? "", /Could not save/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a single-model Profile can save a Session reasoning override", async () => {
  const state = stateFixture();
  state.runtimeProfile!.capabilities.reasoning = {
    supported: true,
    canDisable: true,
    efforts: ["low", "high"],
    budgetTokens: false,
    strategy: "effort",
  };
  state.runtimeProfile!.selection.reasoning = {
    mode: "enabled",
    effort: "low",
  };
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const model = harness.document.querySelector<HTMLSelectElement>(
      "#composerModel",
    );
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(model?.disabled, true);
    assert.equal(reasoning?.disabled, false);

    harness.holdNextCommandResponse();
    harness.select("#composerReasoning", "high");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_model_selection"
      ),
      "Expected a reasoning-only Session selection command.",
    );
    assert.equal(reasoning?.value, "high");
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_model_selection",
      sessionId: "session-1",
      profileId: "profile-1",
      model: "model-a",
      reasoningEffort: "high",
    });
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(reasoning?.value, "high");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer hides reasoning when the model has no selectable efforts", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(
      reasoning?.closest<HTMLElement>(".composer-runtime-field")?.hidden,
      true,
    );
    assert.equal(reasoning?.disabled, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer hides leftover efforts when explicit reasoning is unsupported", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.runtimeProfile!.capabilities.reasoning = {
    supported: false,
    canDisable: false,
    efforts: ["high"],
    budgetTokens: false,
    strategy: "effort",
  };
  const harness = await createDialogHarness(state);
  try {
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(
      reasoning?.closest<HTMLElement>(".composer-runtime-field")?.hidden,
      true,
    );
    assert.equal(reasoning?.disabled, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer hides efforts without a configured reasoning strategy", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.runtimeProfile!.capabilities.reasoning = {
    supported: true,
    canDisable: false,
    efforts: ["high"],
    budgetTokens: false,
    strategy: "none",
  };
  const harness = await createDialogHarness(state);
  try {
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(
      reasoning?.closest<HTMLElement>(".composer-runtime-field")?.hidden,
      true,
    );
    assert.equal(reasoning?.disabled, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer keeps live, runtime, and follow-up controls as independent layout groups", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const toolbar = harness.document.querySelector(".composer-toolbar");
    const live = toolbar?.querySelector(":scope > .composer-live-controls");
    const runtime = toolbar?.querySelector(":scope > .composer-runtime-controls");
    const followUp = toolbar?.querySelector(":scope > #followUpShortcutHint");
    assert.ok(live);
    assert.ok(runtime);
    assert.ok(followUp);
    const scopePanel = live.querySelector("#editScopePanel");
    const approval = live.querySelector("#approvalMode");
    assert.ok(live.querySelector("#editScopeButton"));
    assert.ok(scopePanel);
    assert.ok(approval);
    assert.equal(scopePanel.contains(approval), false);
    assert.equal(scopePanel.querySelectorAll("select").length, 0);
    for (const selector of ["#approvalMode", "#composerModel", "#composerReasoning"]) {
      assert.equal(
        toolbar?.querySelector(selector)?.classList.contains("composer-select"),
        true,
        `${selector} should use the shared composer select treatment`,
      );
    }
    assert.equal(runtime.querySelector("#composerModel") !== null, true);
    assert.equal(runtime.querySelector("#composerReasoning") !== null, true);
    assert.equal(runtime.querySelector("#contextUsage") !== null, true);
    assert.equal(runtime.querySelector("#sendButton") !== null, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models merges the provider catalog into the Profile", async () => {
  const state = stateFixture();
  state.availableModels = [
    {
      id: "model-a",
      displayName: "Model A",
      capabilities: capabilities(),
      capabilityEvidence: capabilityEvidence(),
    },
    {
      id: "model-b",
      displayName: "Model B",
      capabilities: { ...capabilities(), maxOutputTokens: 4096 },
      capabilityEvidence: capabilityEvidence(),
    },
    {
      id: "model-c",
      displayName: "Model C",
      capabilities: { ...capabilities(), maxOutputTokens: 32768 },
      capabilityEvidence: capabilityEvidence(),
    },
  ];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "1 model in this Profile",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Model A · model-a · Default"],
    );
    assert.equal(
      harness.document.querySelector("label[for='modelConfigSelector']")?.textContent,
      "Profile models",
    );
    assert.equal(
      harness.document.querySelector("#removeModelConfigButton")?.textContent,
      "Remove",
    );
    assert.equal(
      harness.document.querySelector("#setDefaultModelButton")?.textContent,
      "Make Default",
    );

    harness.input("#maxOutputTokens", "7000");
    harness.click("#manualModelEntry summary");
    harness.input("#manualModelId", "pending-manual-model");
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);
    const discoveryState = cloneState(state);
    discoveryState.availableModels[0]!.capabilities.maxOutputTokens = 4096;
    discoveryState.modelCatalogLoadReceipt = commandId;
    discoveryState.modelStateSource = modelStateSourceFixture(
      state.settings.profiles[0]!,
    );
    harness.emitServerEvent({ type: "state", commandId, state: discoveryState });
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      [
        "Model A · model-a · Default",
        "Model B · model-b",
        "Model C · model-c",
      ],
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value,
      "4096",
    );
    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "3 models in this Profile",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#manualModelId")?.value,
      "pending-manual-model",
    );
    harness.select("#modelConfigSelector", "1");
    harness.document.querySelector<HTMLButtonElement>("#setDefaultModelButton")
      ?.focus();
    harness.click("#setDefaultModelButton");
    assert.equal(
      harness.document.querySelector("#modelConfigDefault")?.textContent,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#modelConfigDefault")?.hidden,
      true,
    );
    assert.equal(harness.document.activeElement?.id, "modelConfigSelector");

    harness.releaseHeldCommand();
    await harness.settle();
    harness.click("#saveProfileButton");
    await harness.settle();
    const saved = commandCalls(harness).findLast((call) =>
      (call.body as { kind?: string }).kind === "save_profile"
    )?.body as {
      profile?: {
        defaultModel?: string;
        models?: Array<{
          model?: string;
          parameters?: { maxOutputTokens?: number };
        }>;
      };
    };
    assert.equal(saved.profile?.defaultModel, "model-b");
    assert.deepEqual(
      saved.profile?.models?.map((entry) => [
        entry.model,
        entry.parameters?.maxOutputTokens,
      ]),
      [["model-a", 4096], ["model-b", 4096], ["model-c", 8192]],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a duplicated connection change still replaces models on first load", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#baseUrl", "https://duplicated-api.example/v1");
    harness.click("#duplicateProfileButton");
    await harness.acceptAppConfirmation();
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio Copy",
    );

    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models does not merge an old catalog without its command receipt", async () => {
  const state = stateFixture();
  state.availableModels = [{
    id: "stale-model",
    displayName: "Stale model",
    capabilities: capabilities(),
    capabilityEvidence: capabilityEvidence(),
  }];
  delete state.modelCatalogLoadReceipt;
  const harness = await createDialogHarness(state);
  try {
    harness.rejectNextCommand("The request never reached the bridge.");
    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Saved",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a matching receipt cannot replace models from a mismatched catalog source", async () => {
  const state = stateFixture();
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#baseUrl", "https://different-api.example/v1");
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);

    const mismatched = cloneState(state);
    mismatched.availableModels = [{
      id: "wrong-source-model",
      displayName: "Wrong source model",
      capabilities: capabilities(),
      capabilityEvidence: capabilityEvidence(),
    }];
    mismatched.modelCatalogLoadReceipt = commandId;
    harness.emitServerEvent({ type: "state", commandId, state: mismatched });
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );
    harness.releaseHeldCommand();
    await harness.settle();

    harness.click("#discoverModelsButton");
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models can preserve one manual model beside a full catalog", async () => {
  const state = stateFixture();
  state.availableModels = [];
  const catalog = Array.from(
    { length: MAX_DISCOVERED_MODEL_COUNT },
    (_, index) => ({
      id: `catalog-model-${index}`,
      displayName: `Catalog model ${index}`,
      capabilities: capabilities(),
      capabilityEvidence: capabilityEvidence(),
    }),
  );
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);
    const discoveryState = cloneState(state);
    discoveryState.availableModels = catalog;
    discoveryState.modelCatalogLoadReceipt = commandId;
    harness.emitServerEvent({ type: "state", commandId, state: discoveryState });
    await harness.settle();

    assert.equal(
      harness.document.querySelectorAll("#modelConfigSelector option").length,
      MAX_DISCOVERED_MODEL_COUNT + 1,
    );
    harness.releaseHeldCommand();
    await harness.settle();
    harness.click("#saveProfileButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelectorAll("#composerModel option").length,
      MAX_DISCOVERED_MODEL_COUNT + 1,
    );
    assert.equal(
      harness.document.querySelector("#draftStatus")?.textContent,
      "Saved",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Direct API keeps manual model IDs in a secondary disclosure", async () => {
  const state = stateFixture();
  state.availableModels = [];
  state.modelStateSource = null;
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "1 model in this Profile",
    );
    const manualEntry = harness.document.querySelector<HTMLDetailsElement>(
      "#manualModelEntry",
    );
    assert.equal(manualEntry?.hidden, false);
    assert.equal(manualEntry?.open, false);
    harness.click("#manualModelEntry summary");
    assert.equal(manualEntry?.open, true);
    harness.input("#manualModelId", "custom-chat-model");
    harness.document.querySelector<HTMLInputElement>("#manualModelId")
      ?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default", "custom-chat-model"],
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#modelConfigSelector",
      )?.selectedOptions[0]?.textContent,
      "custom-chat-model",
    );
    assert.equal(
      harness.document.querySelector("#manualModelIdHint")?.textContent,
      "Use this only when the provider does not list the model.",
    );
    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "2 models in this Profile",
    );
    harness.document.querySelector<HTMLButtonElement>("#removeModelConfigButton")
      ?.focus();
    harness.click("#removeModelConfigButton");
    assert.equal(harness.document.activeElement?.id, "modelConfigSelector");
    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "1 model in this Profile",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("subscription Profiles load catalog models and hide manual IDs", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "old-account-model",
    models: [
      {
        model: "old-account-model",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
      {
        model: "model-discovered",
        parameters: { reasoning: { mode: "enabled", effort: "high" } },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.availableModels = [{
    id: "model-discovered",
    displayName: "Discovered model",
    capabilities: {
      ...capabilities(),
      reasoning: {
        supported: true,
        canDisable: false,
        efforts: ["low", "high"],
        budgetTokens: false,
        strategy: "effort",
      },
    },
    capabilityEvidence: {
      ...capabilityEvidence(),
      reasoning: "supported",
    },
  }];
  state.configuredModels = profile.models.map((model) => ({
    model: model.model,
    label: model.model,
  }));
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    assert.equal(
      harness.document.querySelector<HTMLDetailsElement>("#manualModelEntry")?.hidden,
      true,
    );
    harness.select("#modelConfigSelector", "1");
    harness.select("#reasoningEffort", "low");
    harness.holdNextCommand();
    harness.click("#discoverModelsButton");
    await harness.settle();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);
    const discovery = cloneState(state);
    discovery.availableModels = [{
      id: "model-discovered",
      displayName: "Discovered model",
      capabilities: {
        ...capabilities(),
        reasoning: {
          supported: true,
          canDisable: false,
          efforts: ["low", "high"],
          budgetTokens: false,
          strategy: "effort",
        },
      },
      capabilityEvidence: {
        ...capabilityEvidence(),
        reasoning: "supported",
      },
    }];
    const discoveredModel = discovery.availableModels[0];
    assert.ok(discoveredModel);
    discovery.capabilities = discoveredModel.capabilities;
    discovery.capabilityEvidence = discoveredModel.capabilityEvidence;
    discovery.modelStateSource = modelStateSourceFixture(profile);
    discovery.modelCatalogLoadReceipt = commandId;
    harness.emitServerEvent({ type: "state", commandId, state: discovery });
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
      "enabled",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningEffort")?.value,
      "low",
    );
    harness.releaseHeldCommand();
    commandReleased = true;
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("an external Session model event refreshes authoritative runtime without using its payload as capabilities", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const meta = harness.document.querySelector<HTMLElement>(
      '.session-entry[data-session-id="session-1"] .session-meta',
    );
    assert.ok(meta);
    const previousTimestamp = meta.title;
    harness.holdNextState();
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-1",
      modelSelection: { profileId: "profile-1", model: "model-b" },
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    await Promise.resolve();
    const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-a",
    );
    assert.notEqual(meta.title, previousTimestamp);
    assert.equal(send?.disabled, true);
    harness.input("#prompt", "Must wait for the authoritative model");
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
    assert.equal(send?.disabled, false);
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/state").length,
      1,
    );
    assert.equal(state.runtimeProfile?.selection.model, "model-a");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("selecting a Session with an uncovered model event refreshes before Send", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.sessions[1]!.modelSelection = {
    profileId: profile.id,
    model: "model-a",
  };
  state.openSettingsOnLoad = false;
  const staleSelected = cloneState(state);
  state.sessions = state.sessions.filter((session) => session.id !== "session-2");
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.holdNextCommandResponse();
    harness.holdNextState();
    const command = ui.runCommand("select_session", { sessionId: "session-2" });
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ),
      "Expected the Session selection to wait for its response.",
    );
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-2",
      modelSelection: { profileId: profile.id, model: "model-b" },
      updatedAt: "2026-08-25T00:03:00.000Z",
      bridgeStateRevision: "3",
    });

    staleSelected.activeSessionId = "session-2";
    staleSelected.approvalMode = "low-risk";
    staleSelected.runtimeProfile!.selection.model = "model-a";
    staleSelected.modelStateSource = modelStateSourceFixture(profile);
    harness.setServerState(staleSelected);
    harness.queueNextStatePublication("4", "1");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/state"),
      "Expected an authoritative model refresh for the newly active Session.",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );

    const refreshed = cloneState(staleSelected);
    refreshed.sessions[1]!.modelSelection = {
      profileId: profile.id,
      model: "model-b",
    };
    refreshed.runtimeProfile!.selection.model = "model-b";
    refreshed.modelStateSource = {
      ...modelStateSourceFixture(profile),
      model: "model-b",
    };
    harness.setServerState(refreshed);
    harness.queueNextStatePublication("5", "3");
    harness.releaseHeldState();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
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

test("a failed external model refresh keeps Send blocked against the stale runtime label", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.failNextState("State unavailable");
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-1",
      modelSelection: { profileId: "profile-1", model: "model-b" },
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
    harness.input("#prompt", "Do not send with the stale model label");
    harness.click("#sendButton");
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/send").length,
      0,
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

for (const commandKind of ["rename_session", "discover_models"] as const) {
test(`a delayed ${commandKind} command cannot roll back a refreshed Session model runtime`, async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.holdNextCommandResponse();
    const command = ui.runCommand(
      commandKind,
      commandKind === "rename_session"
        ? { sessionId: "session-2", title: "Renamed peer" }
        : { profile },
    );
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === commandKind
      ),
      "Expected the peer command to wait for its response.",
    );

    const refreshed = JSON.parse(JSON.stringify(state)) as typeof state;
    refreshed.sessions[0]!.modelSelection = {
      profileId: "profile-1",
      model: "model-b",
    };
    refreshed.runtimeProfile!.selection.model = "model-b";
    harness.setServerState(refreshed);
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-1",
      modelSelection: { profileId: "profile-1", model: "model-b" },
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the external model event to refresh state.",
    );
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );

    const delayed = JSON.parse(JSON.stringify(state)) as typeof state;
    if (commandKind === "rename_session") {
      delayed.sessions[1]!.title = "Renamed peer";
    } else {
      delayed.availableModels = [{
        id: "model-discovered",
        displayName: "Discovered model",
        capabilities: delayed.capabilities,
        capabilityEvidence: delayed.capabilityEvidence,
      }];
    }
    harness.setServerState(delayed);
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
}

test("a delayed local model command cannot overwrite a newer peer selection", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: ["model-a", "model-b", "model-c"].map((model) => ({
      model,
      parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" as const } },
      advanced: {},
    })),
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = profile.models.map((entry) => ({
    model: entry.model,
    label: entry.model,
  }));
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.holdNextCommandResponse();
    const command = ui.runCommand("set_session_model_selection", {
      sessionId: "session-1",
      profileId: "profile-1",
      model: "model-b",
      reasoningEffort: null,
    });
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_model_selection"
      ),
      "Expected the local model command to wait for its response.",
    );

    const peer = JSON.parse(JSON.stringify(state)) as typeof state;
    peer.sessions[0]!.modelSelection = {
      profileId: "profile-1",
      model: "model-c",
    };
    peer.runtimeProfile!.selection.model = "model-c";
    harness.setServerState(peer);
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-1",
      modelSelection: { profileId: "profile-1", model: "model-c" },
    });
    await waitForCondition(
      () => harness.calls.some((call) => new URL(call.url).pathname === "/state"),
      "Expected the peer model selection to refresh state.",
    );
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-c",
    );

    const delayed = JSON.parse(JSON.stringify(state)) as typeof state;
    delayed.sessions[0]!.modelSelection = {
      profileId: "profile-1",
      model: "model-b",
    };
    delayed.runtimeProfile!.selection.model = "model-b";
    harness.setServerState(delayed);
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-c",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("composer reasoning represents a disabled Profile default as Off", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.runtimeProfile!.selection.reasoning = { mode: "disabled" };
  state.runtimeProfile!.capabilities.reasoning = {
    supported: true,
    canDisable: true,
    efforts: ["low", "high"],
    budgetTokens: false,
    strategy: "effort",
  };
  const harness = await createDialogHarness(state);
  try {
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(reasoning?.value, "");
    assert.equal(reasoning?.selectedOptions[0]?.textContent, "Off");
    assert.equal(reasoning?.title, "Reasoning · Off");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("authoritative Profile changes refresh a clean Settings form and preserve a dirty Draft visibly", async () => {
  const state = stateFixture();
  const profileA = profileFixture({
    id: "profile-1",
    name: "Profile 1",
    defaultModel: "model-a",
  });
  const profileB = profileFixture({
    id: "profile-2",
    name: "Profile 2",
    defaultModel: "model-b",
    models: [{
      model: "model-b",
      parameters: { maxOutputTokens: 8192, reasoning: { mode: "default" } },
      advanced: {},
    }],
  });
  state.settings.profiles = [profileA, profileB];
  state.settings.activeProfileId = profileA.id;
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;

  function authoritativeState(profile: typeof profileA): typeof state {
    const next = JSON.parse(JSON.stringify(state)) as typeof state;
    next.settings.activeProfileId = profile.id;
    next.runtimeProfile!.profile = {
      id: profile.id,
      name: profile.name,
      connectionKind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
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

  try {
    harness.setServerState(authoritativeState(profileB));
    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "manual",
      }),
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Profile 2",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-2",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");

    harness.input("#profileName", "Local unsaved Profile 2");
    harness.setServerState(authoritativeState(profileA));
    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "manual",
      }),
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Local unsaved Profile 2",
    );
    assert.match(
      harness.document.querySelector("#draftStatus")?.textContent ?? "",
      /changed elsewhere/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-a",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unrelated newer SSE does not hide Profile settings from a Session command state", async () => {
  const state = stateFixture();
  const profileB = state.settings.profiles.find(
    (profile) => profile.id === "profile-2",
  );
  assert.ok(profileB);
  assert.equal(profileB.connection.kind, "direct-api");
  if (profileB.connection.kind !== "direct-api") return;
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.holdNextCommandResponse();
    const command = ui.runCommand("select_session", { sessionId: "session-2" });
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ),
      "Expected the Session command to wait for its response.",
    );

    const external = JSON.parse(JSON.stringify(state)) as typeof state;
    external.activeSessionId = "session-2";
    external.approvalMode = "low-risk";
    external.activeSkillIds = [];
    external.settings.activeProfileId = profileB.id;
    external.runtimeProfile!.profile = {
      id: profileB.id,
      name: profileB.name,
      connectionKind: profileB.connection.kind,
      apiFamily: profileB.connection.apiFamily,
      apiMode: profileB.connection.apiMode,
    };
    external.runtimeProfile!.selection = {
      model: profileB.defaultModel,
      reasoning: { mode: "default" },
    };
    external.configuredModels = profileB.models.map((entry) => ({
      model: entry.model,
      label: entry.model,
    }));
    external.modelStateSource = {
      profileId: profileB.id,
      connection: JSON.parse(JSON.stringify(profileB.connection)),
      model: profileB.defaultModel,
    };
    harness.setServerState(external);
    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      bridgeStateRevision: "3",
    });
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      profileB.defaultModel,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      profileB.name,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      profileB.id,
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a stale Profile save keeps the Draft and refreshes the latest discard target", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Local edit");
    const latest = JSON.parse(JSON.stringify(state)) as typeof state;
    latest.settings.profiles[0]!.name = "External edit";
    latest.runtimeProfile!.profile.name = "External edit";
    harness.setServerState(latest);
    harness.failNextCommand(
      "This Profile changed in another Live Smith window.",
      undefined,
      { status: 409 },
    );

    harness.click("#saveProfileButton");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Local edit",
    );
    assert.match(
      harness.document.querySelector("#draftStatus")?.textContent ?? "",
      /changed elsewhere/i,
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
    assert.equal(
      harness.calls.filter((call) => new URL(call.url).pathname === "/state").length,
      1,
    );

    harness.click("#discardProfileButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "External edit",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the context ring distinguishes unavailable and exact latest-turn usage", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: {
          maxOutputTokens: 8192,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.runtimeProfile!.capabilities.reasoning = {
    supported: true,
    canDisable: true,
    efforts: ["high"],
    budgetTokens: false,
    strategy: "effort",
  };
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const usage = harness.document.querySelector<HTMLElement>("#contextUsage");
    const value = harness.document.querySelector("#contextUsageValue");
    assert.equal(usage?.dataset.state, "unavailable");
    assert.equal(value?.textContent, "?");
    assert.match(usage?.getAttribute("aria-label") ?? "", /usage unavailable/i);
    assert.match(usage?.getAttribute("title") ?? "", /usage unavailable/i);

    harness.holdNextSend();
    harness.input("#prompt", "Measure this context");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: { usedTokens: 64_000, contextWindowTokens: 128_000 },
    });

    assert.equal(usage?.dataset.state, "exact");
    assert.equal(value?.textContent, "50%");
    assert.match(
      usage?.getAttribute("aria-label") ?? "",
      /64.?000.*128.?000.*50%/,
    );
    assert.equal(usage?.getAttribute("aria-label"), usage?.getAttribute("title"));

    harness.emitServerEvent({
      type: "context_usage_update",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      usage: { usedTokens: 150, contextWindowTokens: 100 },
    });
    assert.equal(value?.textContent, "100%");
    harness.releaseHeldSend();
    await harness.settle();
    harness.select("#composerReasoning", "high");
    await harness.settle();
    assert.equal(value?.textContent, "100%", "reasoning-only changes keep usage");
    harness.select("#composerModel", "model-b");
    await harness.settle();
    assert.equal(value?.textContent, "?", "model changes clear old-model usage");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the circular transport button preserves Send and Stop semantics", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const button = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    assert.equal(button?.textContent?.trim(), "Send");
    assert.equal(button?.dataset.action, "send");
    assert.equal(button?.getAttribute("aria-label"), "Send message");
    assert.equal(button?.querySelectorAll("svg[aria-hidden='true']").length, 2);
    assert.ok(button?.querySelector(".send-button-label.visually-hidden"));
    assert.match(button?.getAttribute("title") ?? "", /Cmd\/Ctrl\+Enter/);

    harness.holdNextSend();
    harness.input("#prompt", "Hold this response");
    harness.click("#sendButton");
    await Promise.resolve();

    assert.equal(button?.textContent?.trim(), "Stop");
    assert.equal(button?.dataset.action, "stop");
    assert.equal(button?.getAttribute("aria-label"), "Stop current response");
    assert.equal(button?.getAttribute("aria-keyshortcuts"), null);
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerReasoning")?.disabled,
      true,
    );

    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(button?.textContent?.trim(), "Send");
    assert.equal(button?.dataset.action, "send");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Settings follows the Profile to Conversation Behavior workflow", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector("#settingsTab")?.textContent, "Settings");
    const flow = [
      ["profileSettingsSection", "Profile"],
      ["connectionSettingsSection", "Connection"],
      ["modelSettingsSection", "Model"],
      ["capabilitySettingsSection", "Capabilities"],
      ["generationSettings", "Generation"],
      ["followUpSettingsSection", "Conversation Behavior"],
    ] as const;
    for (const [index, [id, heading]] of flow.entries()) {
      const node = harness.document.getElementById(id);
      assert.ok(node, `Expected #${id}`);
      assert.match(
        node.textContent ?? "",
        new RegExp(heading, "i"),
      );
      const next = flow[index + 1];
      if (next) {
        const nextNode = harness.document.getElementById(next[0]);
        assert.ok(nextNode);
        assert.equal(
          Boolean(node.compareDocumentPosition(nextNode) &
            harness.window.Node.DOCUMENT_POSITION_FOLLOWING),
          true,
          `Expected #${id} before #${next[0]}`,
        );
      }
    }

    assert.ok(
      harness.document.querySelector("#modelSettingsSection #discoverModelsButton"),
    );
    assert.ok(
      harness.document.querySelector("#modelSettingsSection #modelConfigSelector"),
    );
    assert.ok(
      harness.document.querySelector("#capabilitySettingsSection #webSearchEnabled"),
    );
    assert.ok(
      harness.document.querySelector("#capabilitySettingsSection #advancedSettings"),
    );
    assert.ok(harness.document.querySelector("#generationSettings #temperature"));
    assert.ok(harness.document.querySelector("#generationSettings #reasoningMode"));
    assert.ok(
      harness.document.querySelector(
        "#followUpSettingsSection #defaultFollowUpBehavior",
      ),
    );
    const boundary = harness.document.querySelector("#webSearchBoundaryHint");
    assert.equal((boundary as HTMLElement | null)?.hidden, true);
    harness.select("#connectionKind", "codex-subscription");
    assert.equal((boundary as HTMLElement | null)?.hidden, false);
    assert.match(
      boundary?.textContent ?? "",
      /managed.*model-only.*Direct API.*OpenAI Responses.*Anthropic Messages/i,
    );
    assert.match(
      harness.document.querySelector("#webSearchEnabled")?.getAttribute(
        "aria-describedby",
      ) ?? "",
      /webSearchHint.*webSearchBoundaryHint/,
    );
    assert.equal(harness.document.querySelector("#microphoneButton"), null);
    assert.equal(harness.document.querySelector("#voiceButton"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
