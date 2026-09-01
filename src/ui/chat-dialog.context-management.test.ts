import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  modelStateSourceFixture,
  profileFixture,
  profileRevisionFixture,
  runtimeSummaryForHarnessProfile,
  stateFixture,
} from "./chat-dialog.test-harness.js";

test("Direct model context settings render and save with the selected model", async () => {
  const state = stateFixture();
  const model = state.settings.profiles[0]!.models[0]!;
  model.parameters.contextWindowTokens = 200_000;
  model.parameters.autoCompactTokenLimit = 150_000;
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#contextWindowTokens")?.value,
      "200000",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#autoCompactTokenLimit")?.value,
      "150000",
    );

    harness.input("#contextWindowTokens", "240000");
    harness.input("#autoCompactTokenLimit", "180000");
    harness.click("#saveProfileButton");
    await harness.settle();

    const save = commandCalls(harness).find(
      (call) => (call.body as { kind?: string }).kind === "save_profile",
    );
    assert.ok(save);
    const parameters = (save.body as {
      profile: { models: Array<{ parameters: Record<string, unknown> }> };
    }).profile.models[0]!.parameters;
    assert.equal(parameters.contextWindowTokens, 240_000);
    assert.equal(parameters.autoCompactTokenLimit, 180_000);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("subscription models expose context settings without Direct generation controls", async () => {
  const state = stateFixture();
  const profile = profileFixture({
    connection: { kind: "oauth-subscription", provider: "openai" },
    parameters: {
      contextWindowTokens: 180_000,
      autoCompactTokenLimit: 140_000,
      reasoning: { mode: "default" },
    },
    advanced: {},
  });
  state.settings.profiles = [profile];
  state.settings.activeProfileId = profile.id;
  state.activeProfileRevision = profileRevisionFixture(profile);
  state.modelStateSource = modelStateSourceFixture(profile);
  state.runtimeProfile = runtimeSummaryForHarnessProfile(profile);
  state.configuredModels = [{ model: profile.defaultModel, label: profile.defaultModel }];
  state.configuredModelsReady = true;
  state.oauthAuth = {
    status: "signed-in",
    accountLabel: "studio@example.test",
    planType: "pro",
    subscriptionEligible: true,
  };
  const harness = await createDialogHarness(state);
  try {
    const contextWindow = harness.document.querySelector<HTMLInputElement>(
      "#contextWindowTokens",
    );
    const compactAt = harness.document.querySelector<HTMLInputElement>(
      "#autoCompactTokenLimit",
    );
    assert.equal(contextWindow?.disabled, false);
    assert.equal(contextWindow?.value, "180000");
    assert.equal(compactAt?.disabled, false);
    assert.equal(compactAt?.value, "140000");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.disabled,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a compaction checkpoint is one collapsed timeline marker", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-compaction",
    kind: "compaction",
    content: "Keep the Bass arrangement and continue with the drop.",
    createdAt: "2026-09-01T00:00:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const item = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.compaction",
    );
    assert.ok(item);
    assert.equal(item.open, false);
    assert.equal(
      item.querySelector("summary")?.textContent,
      "Context compacted — Conversation checkpoint",
    );
    assert.match(item.textContent ?? "", /Keep the Bass arrangement/);
    assert.equal(
      harness.document.querySelectorAll('[data-event-id="event-compaction"]').length,
      1,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
