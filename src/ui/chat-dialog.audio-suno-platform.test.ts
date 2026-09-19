import assert from "node:assert/strict";
import test from "node:test";

import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioCommands, toggle } from "./chat-dialog.audio-test-helpers.js";

test("official Suno Platform has a distinct key workflow and no website Cookie or model controls", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "Official Suno");
    harness.select("#audioServiceProvider", "suno-platform");
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceModelField")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceKeyField")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoPlatformActions")!.hidden, false);
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /Official Suno API/);
    assert.match(harness.document.querySelector("#audioServiceOperations")!.textContent!, /Music generation/);

    harness.click("#openSunoPlatformButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness)[0]!.body, { kind: "open_suno_platform" });
    assert.match(harness.document.querySelector("#status")!.textContent!, /default browser/);

    harness.input("#audioServiceApiKey", "fixture-official-suno-key");
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const patch = audioCommands(harness)[0]!.integrationConnections;
    if (patch.action !== "upsert") assert.fail("expected an upsert");
    assert.deepEqual(patch.connection, {
      id: patch.connection.id,
      name: "Official Suno",
      pluginId: "live-smith.suno-platform",
      enabled: true,
      configuration: {},
      secrets: { apiKey: "fixture-official-suno-key" },
    });
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-official-suno-key/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("provider choices name official Platform, website subscription and third-party API without ambiguity", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#addAudioServiceButton");
    const options = [...harness.document.querySelectorAll<HTMLOptionElement>("#audioServiceProvider option")]
      .map((option) => [option.value, option.textContent]);
    assert.ok(options.some(([id, label]) => id === "suno-platform" && label === "Suno Platform (official API)"));
    assert.ok(options.some(([id, label]) => id === "suno" && label === "Suno.com subscription (experimental)"));
    assert.ok(options.some(([id, label]) => id === "sunoapi" && /third-party/.test(label!)));
  } finally { harness.close(); }
});
