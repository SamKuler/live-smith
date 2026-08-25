import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilities,
  capabilityEvidence,
  commandCalls,
  createDialogHarness,
  modelStateSourceFixture,
  profileFixture,
  renderedCapabilityStatuses,
  stateFixture,
} from "./chat-dialog.test-harness.js";

test("a typed non-catalog model stays unverified after Save and Use", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.click("#discoverModelsButton");
    await harness.settle();
    harness.input("#manualModelId", "typed-model-not-in-catalog");
    harness.click("#addManualModelButton");

    const expected = [
      ["Images · Unverified", "unverified"],
      ["Audio · Unverified", "unverified"],
      ["PDF · Unverified", "unverified"],
    ];
    assert.deepEqual(renderedCapabilityStatuses(harness), expected);

    harness.click("#saveProfileButton");
    await harness.settle();

    assert.equal(
      (commandCalls(harness).at(-1)?.body as { kind?: string }).kind,
      "save_profile",
    );
    assert.deepEqual(renderedCapabilityStatuses(harness), expected);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("explicit model input evidence survives Save and Use", async () => {
  const state = stateFixture();
  const profile = state.settings.profiles[0]!;
  const modelCapabilities = {
    ...capabilities(),
    inputs: { image: true, audio: false, pdf: false },
  };
  const modelEvidence = {
    ...capabilityEvidence(),
    inputs: {
      image: "supported" as const,
      audio: "unsupported" as const,
      pdf: "unverified" as const,
    },
  };
  state.capabilities = modelCapabilities;
  state.capabilityEvidence = modelEvidence;
  state.availableModels = [{
    id: profile.defaultModel,
    displayName: "Explicit model",
    capabilities: modelCapabilities,
    capabilityEvidence: modelEvidence,
  }];
  const harness = await createDialogHarness(state);
  try {
    const expected = [
      ["Images · Supported", "supported"],
      ["Audio · Unsupported", "unsupported"],
      ["PDF · Unverified", "unverified"],
    ];
    assert.deepEqual(renderedCapabilityStatuses(harness), expected);

    harness.input("#profileName", "Evidence renamed");
    harness.click("#saveProfileButton");
    await harness.settle();

    assert.deepEqual(renderedCapabilityStatuses(harness), expected);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("manual input overrides remain authoritative after an unverified Save", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#baseUrl", "https://unverified.example/v1");
    harness.input("#manualModelId", "typed-model-not-in-catalog");
    harness.click("#addManualModelButton");
    harness.click("#setDefaultModelButton");
    harness.select("#overrideInputImage", "true");
    harness.select("#overrideInputAudio", "false");
    harness.select("#overrideInputPdf", "true");
    harness.click("#saveProfileButton");
    await harness.settle();

    assert.deepEqual(renderedCapabilityStatuses(harness), [
      ["Images · Supported", "supported"],
      ["Audio · Unsupported", "unsupported"],
      ["PDF · Supported", "supported"],
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models keeps an explicit output-limit override above discovery", async () => {
  const state = stateFixture();
  state.settings.profiles = [];
  state.settings.activeProfileId = null;
  state.activeProfileRevision = null;
  state.runtimeProfile = null;
  state.modelStateSource = null;
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Override profile");
    harness.input("#baseUrl", "http://localhost:1234/v1");
    harness.input("#maxOutputTokens", "64000");
    harness.input("#overrideMaxOutputTokens", "64000");
    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value,
      "64000",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>(
        "#overrideMaxOutputTokens",
      )?.value,
      "64000",
    );

    harness.click("#saveProfileButton");
    await harness.settle();
    const saved = commandCalls(harness).findLast((call) =>
      (call.body as { kind?: string }).kind === "save_profile"
    )?.body as {
      profile?: {
        models?: Array<{
          parameters?: { maxOutputTokens?: number };
          advanced?: {
            capabilityOverrides?: { maxOutputTokens?: number };
          };
        }>;
      };
    };
    assert.equal(saved.profile?.models?.[0]?.parameters?.maxOutputTokens, 64000);
    assert.equal(
      saved.profile?.models?.[0]?.advanced?.capabilityOverrides?.maxOutputTokens,
      64000,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown reasoning evidence does not clean saved reasoning controls", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
    },
  });
  state.settings.profiles[0] = profile;
  state.settings.activeProfileId = profile.id;
  state.modelStateSource = modelStateSourceFixture(profile);
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: false,
      canDisable: false,
      efforts: [],
      budgetTokens: false,
      strategy: "none",
    },
  };
  state.capabilityEvidence = {
    ...capabilityEvidence(),
    reasoning: "unverified",
  };
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
      "enabled",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningEffort")?.value,
      "high",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value,
      "4096",
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

test("initial state rejects capability evidence that contradicts its values", async () => {
  const state = stateFixture();
  state.capabilityEvidence = {
    ...capabilityEvidence(),
    inputs: {
      ...capabilityEvidence().inputs,
      image: "supported",
    },
  };
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /invalid initial state/i,
    );
    assert.equal(
      harness.document.querySelector(".app")?.hasAttribute("inert"),
      true,
    );
    assert.deepEqual(harness.eventSourceUrls, []);
    assert.equal("LiveSmithUI" in harness.window, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("initial state rejects a malformed model-catalog load receipt", async () => {
  const state = stateFixture();
  state.modelCatalogLoadReceipt = "invalid receipt";
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /invalid initial state/i,
    );
    assert.equal(
      harness.document.querySelector(".app")?.hasAttribute("inert"),
      true,
    );
    assert.deepEqual(harness.eventSourceUrls, []);
    assert.equal("LiveSmithUI" in harness.window, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
