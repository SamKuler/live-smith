import assert from "node:assert/strict";
import test from "node:test";

import { MUREKA_MUSIC_MODELS } from "../audio-services/capabilities.js";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioCommands, toggle } from "./chat-dialog.audio-test-helpers.js";

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
    assert.match(harness.document.querySelector("#audioServiceOperations")!.textContent!, /Music generation/);
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

    const patch = audioCommands(harness)[0]!.audioServices;
    if (patch.action !== "upsert") assert.fail("expected an upsert");
    assert.deepEqual(patch.connection, { id: patch.connection.id, name: "Mureka studio", provider: "mureka",
      enabled: true, apiKey: "fixture-mureka-ui-key", modelId: "mureka-9.5" });
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
