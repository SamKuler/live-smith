import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilities,
  commandCalls,
  createDialogHarness,
  profileFixture,
  stateFixture,
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
    assert.equal(model?.getAttribute("aria-label"), "Model for the active Session");
    assert.equal(
      reasoning?.getAttribute("aria-label"),
      "Reasoning effort for the active Session",
    );

    harness.input("#model", "unsaved-draft-model");
    harness.select("#reasoningMode", "default");

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
      harness.document.querySelector<HTMLInputElement>("#model")?.value,
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
    assert.equal(runtime.querySelector("#composerModel") !== null, true);
    assert.equal(runtime.querySelector("#composerReasoning") !== null, true);
    assert.equal(runtime.querySelector("#contextUsage") !== null, true);
    assert.equal(runtime.querySelector("#sendButton") !== null, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Settings adds, removes, and chooses a default full model configuration", async () => {
  const harness = await createDialogHarness();
  try {
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["model-a · Default"],
    );
    harness.click("#addModelConfigButton");
    harness.input("#model", "model-b");
    harness.input("#maxOutputTokens", "16384");
    harness.click("#setDefaultModelButton");
    assert.equal(
      harness.document.querySelector("#modelConfigDefault")?.textContent,
      "Default for new Sessions",
    );
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
      [["model-a", 8192], ["model-b", 16384]],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("subscription composer loads model capabilities only when its selector is opened", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "codex-subscription", provider: "openai" },
    defaultModel: "model-a",
    models: [
      {
        model: "model-a",
        parameters: { reasoning: { mode: "enabled", effort: "high" } },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: { reasoning: { mode: "default" } },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = profile;
  state.settings.activeProfileId = profile.id;
  state.runtimeProfile = {
    profile: {
      id: profile.id,
      name: profile.name,
      connectionKind: "codex-subscription",
      apiFamily: "openai",
      apiMode: null,
    },
    selection: {
      model: "model-a",
      reasoning: { mode: "enabled", effort: "high" },
    },
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
    inputCapabilityEvidence: {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  };
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.configuredModelsReady = false;
  state.codexAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    assert.equal(reasoning?.disabled, true);
    assert.equal(reasoning?.textContent, "Load capabilities…");
    harness.document.querySelector<HTMLSelectElement>("#composerModel")?.focus();
    await harness.settle();
    assert.equal(
      commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind ===
          "load_session_model_capabilities"
      ).length,
      1,
    );
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "load_session_model_capabilities",
      sessionId: "session-1",
      profileId: "profile-1",
    });
    assert.equal(reasoning?.disabled, false);
    assert.deepEqual(
      [...(reasoning?.options || [])].map((option) => option.value),
      ["", "low", "high"],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
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
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.emitServerEvent({
      type: "session_model_selection_changed",
      sessionId: "session-1",
      modelSelection: { profileId: "profile-1", model: "model-b" },
    });
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
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
      harness.document.querySelector("#connectionSettingsSection #discoverModelsButton"),
    );
    assert.ok(harness.document.querySelector("#modelSettingsSection #model"));
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
