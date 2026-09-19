import assert from "node:assert/strict";
import test from "node:test";

import { murekaPlugin, MUREKA_MUSIC_MODELS } from "../plugins/builtins/mureka.js";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioCommands, audioState, job, toggle } from "./chat-dialog.audio-test-helpers.js";

test("Mureka uses the named API-key workflow and provider-owned model suggestions", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "Mureka studio");
    harness.select("#audioServiceProvider", "mureka");

    const provider = harness.document.querySelector<HTMLOptionElement>('#audioServiceProvider option[value="mureka"]')!;
    assert.equal(provider.disabled, false);
    assert.equal(provider.textContent, "Mureka");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoPlatformActions")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceKeyField")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceModelField")!.hidden, false);
    assert.match(harness.document.querySelector("#audioServiceOperations")!.textContent!, /Generate lyrics.*Lyrics to song.*Music generation/);
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /prompt.*external service.*API charges/i);
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /auto.*prompt-based generation/i);

    const model = harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!;
    assert.equal(model.getAttribute("list"), "audioServiceModelOptions");
    assert.deepEqual(Array.from(harness.document.querySelectorAll<HTMLOptionElement>("#audioServiceModelOptions option"))
      .map((option) => option.value), [...MUREKA_MUSIC_MODELS]);

    harness.input("#audioServiceModel", "mureka-9.5");
    harness.input("#audioServiceApiKey", "fixture-mureka-ui-key");
    toggle(harness, true);
    harness.holdNextCommand();
    harness.click("#saveAudioServiceButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-mureka-ui-key/);
    harness.releaseHeldCommand();
    await harness.settle();

    const patch = audioCommands(harness)[0]!.integrationConnections;
    if (patch.action !== "upsert") assert.fail("expected an upsert");
    assert.deepEqual(patch.connection, {
      id: patch.connection.id,
      name: "Mureka studio",
      pluginId: murekaPlugin.id,
      enabled: true,
      configuration: { modelId: "mureka-9.5" },
      secrets: { apiKey: "fixture-mureka-ui-key" },
    });
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Mureka lyrics-to-song jobs retain their Plugin operation and translated audio card", async () => {
  const connection = {
    id: "mureka-studio",
    name: "Mureka studio",
    provider: "mureka" as const,
    enabled: true,
    apiKeyConfigured: true,
    modelId: "mureka-9.5",
  };
  const state = audioState([connection]);
  const output = {
    ...job(state.activeSessionId).outputs[0]!,
    role: "music" as const,
    label: "Music",
    origin: { kind: "generated" as const },
  };
  state.audioJobs = [job(state.activeSessionId, {
    provider: "mureka",
    serviceId: connection.id,
    operation: "generate_song_from_lyrics",
    modelId: connection.modelId,
    stems: [],
    status: "completed",
    resumable: false,
    outputs: [output],
  })];
  state.settings.uiLanguage = "zh-CN";
  const harness = await createDialogHarness(state);
  try {
    const card = harness.document.querySelector<HTMLElement>("[data-audio-job-id]")!;
    assert.match(card.textContent!, /按歌词生成歌曲.*Mureka studio.*Mureka.*mureka-9\.5/s);
    assert.equal(card.querySelectorAll("audio").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
