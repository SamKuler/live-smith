import assert from "node:assert/strict";
import test from "node:test";
import { chatDialogStateForWire, serializeChatStateForHtml } from "./chat-state.js";
import { createDialogHarness, waitForCondition } from "./chat-dialog.test-harness.js";
import { audioState, service, musicService, toggle, audioCommands, broadcast, selectAudioService, selectedAudioService } from "./chat-dialog.audio-test-helpers.js";

test("HTML and full-state projections redact every audio key without mutating saved connections", () => {
  const state = audioState([service, musicService]);
  state.settings.audioServices = { revision: "1", connections: [service, musicService].map(({ apiKeyConfigured: _, ...value }, i) =>
    ({ ...value, apiKey: "fixture-private-" + i })) };
  const wire = chatDialogStateForWire(state);
  assert.equal(Object.hasOwn(wire.settings, "audioServices"), false, "the top-level view is the only browser audio-settings owner");
  assert.doesNotMatch(JSON.stringify(wire), /fixture-private-/);
  assert.doesNotMatch(serializeChatStateForHtml(state), /fixture-private-/);
  assert.equal(state.settings.audioServices.connections[1]!.apiKey, "fixture-private-1");
});

test("Add starts disabled, requires a unique name and key to enable, and submits a write-only key", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceFields")!.hidden, true);
    harness.click("#addAudioServiceButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.type, "password");
    harness.input("#audioServiceName", "My separation");
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).length, 0);
    assert.equal(harness.document.activeElement?.id, "audioServiceApiKey");
    harness.input("#audioServiceApiKey", "fixture-ui-key");
    harness.holdNextCommand();
    harness.click("#saveAudioServiceButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-ui-key/);
    harness.releaseHeldCommand();
    await harness.settle();
    const patch = audioCommands(harness)[0]!.audioServices;
    assert.equal(patch.action, "upsert");
    if (patch.action !== "upsert") throw new Error("Expected upsert");
    assert.deepEqual(patch, { action: "upsert", expectedRevision: "0", connection: {
      id: patch.connection.id, name: "My separation", provider: "lalal", enabled: true, apiKey: "fixture-ui-key",
    } });
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("multiple providers and same-provider accounts save, clear, and remove only the selected connection", async () => {
  const harness = await createDialogHarness(audioState([service, musicService]));
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "Personal separation");
    harness.input("#audioServiceApiKey", "fixture-personal-key");
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const added = audioCommands(harness).at(-1)!.audioServices;
    if (added.action !== "upsert") throw new Error("Expected upsert");
    const personalId = added.connection.id;
    assert.equal(harness.document.querySelectorAll("[data-audio-service-id]").length, 3);
    selectAudioService(harness, service.id);
    harness.input("#audioServiceName", "Work updated");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const edited = audioCommands(harness).at(-1)!.audioServices;
    if (edited.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(edited.connection.id, service.id);
    assert.equal(Object.hasOwn(edited.connection, "apiKey"), false);
    harness.click("#clearAudioServiceButton");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    selectAudioService(harness, personalId);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    harness.click("#removeAudioServiceButton");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(audioCommands(harness).at(-1)!.audioServices, { action: "remove", serviceId: personalId, expectedRevision: "4" });
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, true);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, "music_v2");
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /separate API charges/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("provider switches clear unsaved key and model fields and cannot reuse another provider's saved key", async () => {
  const harness = await createDialogHarness(audioState([service, musicService]));
  try {
    harness.input("#audioServiceApiKey", "fixture-never-cross-provider");
    harness.select("#audioServiceProvider", "elevenlabs");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "No API key configured");
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).length, 0);
    harness.input("#audioServiceApiKey", "fixture-replacement");
    harness.input("#audioServiceModel", "music_v2");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const patch = audioCommands(harness).at(-1)!.audioServices;
    if (patch.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(patch.connection.provider, "elevenlabs");
    assert.equal(patch.connection.apiKey, "fixture-replacement");
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("selection preserves non-secret drafts but clears keys; collection changes require explicit reload", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "Unfinished name");
    harness.input("#audioServiceApiKey", "fixture-selection-draft");
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    selectAudioService(harness, service.id);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Unfinished name");
    const next = { connections: [service, { ...musicService, name: "New music studio" }], revision: "2" };
    harness.setServerState({ ...state, audioServices: next });
    harness.emitServerEvent(broadcast(state, next));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, false);
    assert.equal(harness.document.querySelector(`[data-audio-service-id="${service.id}"] .audio-service-status`)!.textContent, "Needs attention");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Unfinished name");
    harness.click("#reloadAudioServiceButton");
    harness.input("#audioServiceName", "Reloaded name");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).at(-1)!.audioServices.expectedRevision, "2");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("conflicting peer revisions retain fields, clear keys, require reload, and reject older snapshots", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "Draft name");
    harness.input("#audioServiceApiKey", "fixture-stale-draft");
    const next = { connections: [{ ...service, enabled: false }], revision: "2" };
    harness.emitServerEvent(broadcast(state, next));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Draft name");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    harness.emitServerEvent(broadcast(state, state.audioServices));
    await harness.settle();
    harness.click("#reloadAudioServiceButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, service.name);
    harness.setServerState({ ...state, audioServices: next });
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).at(-1)!.audioServices.expectedRevision, "2");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("rejected stale save retains non-secret draft fields and never restores a submitted key", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "Keep my draft");
    harness.input("#audioServiceApiKey", "fixture-rejected-key");
    harness.setServerState({ ...state, audioServices: { connections: [service], revision: "2" } });
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep my draft");
    assert.match(harness.document.querySelector("#status")!.textContent!, /changed in another window/);
    assert.equal(harness.document.querySelector("#appTab")?.getAttribute("aria-selected"), "true");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const [isNew, withState] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`unknown save ${withState ? "with state" : "requiring refresh"} retains ${isNew ? "unsaved Add" : "saved connection"} draft and clears submitted key`, async () => {
    const state = audioState([service, musicService]);
    const harness = await createDialogHarness(state);
    let heldState = false;
    try {
      if (isNew) harness.click("#addAudioServiceButton");
      const id = selectedAudioService(harness);
      harness.input("#audioServiceName", "Keep unknown draft");
      harness.input("#audioServiceApiKey", "fixture-unknown-key");
      if (withState) harness.failNextCommand("Settings save outcome unknown.", undefined, { commandOutcome: "unknown", state });
      else harness.rejectNextCommand("Settings save outcome unknown.");
      harness.click("#saveAudioServiceButton");
      await harness.settle();
      if (!withState) {
        assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
        assert.match(harness.document.querySelector("#status")!.textContent!, /Waiting for authoritative bridge state/);
        // Keep reconciliation pending, then supply a publication whose causal cut
        // covers the attempted command while the saved audio collection stays unchanged.
        harness.holdNextState();
        heldState = true;
        harness.queueNextStatePublication("101", "100");
        harness.emitServerEventError();
        await harness.settle();
        assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
        assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep unknown draft");
        assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
        harness.releaseHeldState();
        heldState = false;
        await harness.settle();
        harness.queueNextStatePublication("102", "101");
        harness.emitServerEventOpen();
        await waitForCondition(() => !harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled,
          "Expected covering authoritative state and stream reconnection to finish reconciliation.");
        assert.deepEqual(JSON.parse(JSON.stringify(harness.readBootstrappedClientStateReference().audioServices)), state.audioServices);
      }
      assert.equal(selectedAudioService(harness), id);
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep unknown draft");
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, false,
        harness.document.querySelector("#status")!.textContent!);
      if (withState) assert.match(harness.document.querySelector("#status")!.textContent!, /outcome unknown/);
      assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-unknown-key/);
      selectAudioService(harness, musicService.id);
      selectAudioService(harness, id);
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep unknown draft");
      harness.click("#saveAudioServiceButton");
      await harness.settle();
      const retry = audioCommands(harness).at(-1)!.audioServices;
      assert.equal(retry.action, "upsert");
      if (retry.action === "upsert") assert.equal(Object.hasOwn(retry.connection, "apiKey"), false);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
      assert.deepEqual(harness.errors, []);
    } finally {
      if (heldState) harness.releaseHeldState();
      harness.close();
    }
  });
}

test("Suno keeps essential connection facts visible and moves adapter details into aligned help", async () => {
  const harness = await createDialogHarness(audioState([{ ...service, provider: "suno", enabled: false, apiKeyConfigured: false }]));
  try {
    assert.equal(harness.document.querySelector<HTMLOptionElement>('#audioServiceProvider option[value="suno"]')!.disabled, false);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.disabled, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceEnabledField")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceKeyField")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceModelField")!.hidden, false);
    for (const selector of ["#audioServiceCallbackField", "#clearAudioServiceButton"]) {
      assert.equal(harness.document.querySelector<HTMLElement>(selector)!.hidden, true, selector);
    }
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, false);
    const operations = harness.document.querySelector<HTMLElement>("#audioServiceOperations")!;
    assert.equal(operations.hidden, false);
    assert.match(operations.textContent!, /Custom lyrics.*Extend.*Library.*Retrieve/);
    assert.match(harness.document.querySelector("#audioServiceDisclosure")!.getAttribute("aria-label")!, /Suno credits.*save.*never retried/i);
    const heading = harness.document.querySelector("#sunoConnectionHeading");
    const help = harness.document.querySelector<HTMLElement>("#sunoFeatureHelp")!;
    assert.equal(heading?.nextElementSibling, help);
    assert.equal(help.parentElement?.classList.contains("field-label-row"), true);
    assert.equal(help.textContent, "?");
    assert.equal(help.tabIndex, 0);
    assert.equal(help.getAttribute("role"), "note");
    assert.equal(help.dataset.tooltip, help.getAttribute("aria-label"));
    assert.match(help.dataset.tooltip ?? "", /adapter gaps, not restrictions on Live Smith/i);
    assert.match(help.dataset.tooltip ?? "", /Suno Studio workspace editing or publishing/i);
    assert.equal(harness.document.querySelector("#sunoLoginControls details#sunoFeatureHelp"), null);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#sunoSessionValue")!.type, "password");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#openSunoWebsiteButton")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const action of ["clear", "remove"]) {
  test(`unknown ${action} outcome retains edited audio fields without restoring a key`, async () => {
    const state = audioState([service, musicService]);
    const harness = await createDialogHarness(state);
    try {
      harness.input("#audioServiceName", "Keep edited connection");
      harness.input("#audioServiceApiKey", "fixture-unsubmitted-key");
      harness.failNextCommand("Settings outcome unknown.", undefined, { commandOutcome: "unknown", state });
      harness.click(action === "clear" ? "#clearAudioServiceButton" : "#removeAudioServiceButton");
      await harness.acceptAppConfirmation();
      await harness.settle();
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep edited connection");
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, false);
      assert.equal(harness.document.querySelectorAll("[data-audio-service-id]").length, 2);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("key-only peer changes invalidate an existing draft even when every visible field is identical", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "My pending edit");
    harness.input("#audioServiceApiKey", "fixture-stale-replacement");
    harness.emitServerEvent(broadcast(state, { ...state.audioServices, revision: "2" }));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, false);
    harness.click("#saveAudioServiceButton");
    assert.equal(audioCommands(harness).length, 0);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "My pending edit");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("removing a selected connection in a peer window cannot let its draft recreate or inherit the connection", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceName", "Removed draft");
    harness.emitServerEvent(broadcast(state, { connections: [musicService], revision: "2" }));
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    harness.click("#reloadAudioServiceButton");
    assert.equal(selectedAudioService(harness), musicService.id);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, musicService.name);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
