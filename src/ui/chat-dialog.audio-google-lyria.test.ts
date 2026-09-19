import assert from "node:assert/strict";
import test from "node:test";

import { googleLyriaPlugin, GOOGLE_LYRIA_MUSIC_MODELS } from "../plugins/builtins/google-lyria.js";
import { createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";
import { audioCommands, toggle } from "./chat-dialog.audio-test-helpers.js";

test("Google Lyria uses the shared API-key editor and explains each documented model contract", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "Gemini music");
    harness.select("#audioServiceProvider", "google-lyria");

    const provider = harness.document.querySelector<HTMLOptionElement>(
      '#audioServiceProvider option[value="google-lyria"]',
    )!;
    assert.equal(provider.disabled, false);
    assert.equal(provider.textContent, "Google Lyria (Gemini API)");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceKeyField")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceModelField")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /Gemini API billing.*single-turn.*WebSocket/i);
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /lyria-3\.5.*prompt-guided duration/i);

    const model = harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!;
    assert.equal(model.getAttribute("list"), "audioServiceModelOptions");
    assert.deepEqual(
      Array.from(harness.document.querySelectorAll<HTMLOptionElement>("#audioServiceModelOptions option"))
        .map((option) => option.value),
      [...GOOGLE_LYRIA_MUSIC_MODELS],
    );

    harness.input("#audioServiceModel", "lyria-3-clip-preview");
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /always generates 30 seconds/i);
    harness.input("#audioServiceModel", "lyria-realtime-exp");
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /streaming generation.*instrumental audio only/i);

    harness.input("#audioServiceApiKey", "fixture-google-lyria-key");
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const patch = audioCommands(harness)[0]!.integrationConnections;
    if (patch.action !== "upsert") assert.fail("expected an upsert");
    assert.deepEqual(patch.connection, {
      id: patch.connection.id,
      name: "Gemini music",
      pluginId: googleLyriaPlugin.id,
      enabled: true,
      configuration: { modelId: "lyria-realtime-exp" },
      secrets: { apiKey: "fixture-google-lyria-key" },
    });
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Google Lyria model guidance is localized with the rest of the connection editor", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "zh-CN";
  const harness = await createDialogHarness(state);
  try {
    harness.click("#addAudioServiceButton");
    harness.select("#audioServiceProvider", "google-lyria");
    assert.equal(
      harness.document.querySelector<HTMLOptionElement>('#audioServiceProvider option[value="google-lyria"]')!.textContent,
      "Google Lyria（Gemini API）",
    );
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /提示词引导时长/);
    harness.input("#audioServiceModel", "lyria-realtime-exp");
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /流式生成.*仅生成器乐/);
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /Gemini API 计费.*WebSocket/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
