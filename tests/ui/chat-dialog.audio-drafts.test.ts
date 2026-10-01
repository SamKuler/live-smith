import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness } from "./support/chat-dialog.test-harness.js";
import {
  audioCommands, audioState, broadcast, musicService, selectAudioService,
  selectedAudioService, service, sunoService, toggle, type Harness,
} from "./support/chat-dialog.audio-test-helpers.js";

function assertDraft(harness: Harness, dirty: boolean) {
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, !dirty);
  assert.equal(harness.document.querySelector<HTMLButtonElement>("#reloadAudioServiceButton")!.disabled, !dirty);
  assert.equal(harness.document.querySelector("#audioDraftStatus")!.textContent, dirty ? "Unsaved changes" : "");
}

function visitMcp(harness: Harness) {
  harness.click("#mcpExtensionTab");
  harness.click("#audioExtensionTab");
}

test("restoring saved audio public fields disables Save and Discard without a write", async () => {
  const harness = await createDialogHarness(audioState([sunoService]));
  try {
    assertDraft(harness, false);
    for (const [selector, edited, saved] of [
      ["#audioServiceName", "Temporary name", sunoService.name],
      ["#audioServiceModel", "V5", sunoService.modelId!],
      ["#audioServiceCallback", "https://hooks.example.com/other", sunoService.callbackUrl!],
    ]) {
      harness.input(selector!, edited!);
      assertDraft(harness, true);
      harness.input(selector!, saved!);
      assertDraft(harness, false);
    }
    toggle(harness, false);
    assertDraft(harness, true);
    toggle(harness, true);
    assertDraft(harness, false);
    assert.equal(audioCommands(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("erasing a replacement audio key returns its otherwise unchanged editor to clean", async () => {
  const harness = await createDialogHarness(audioState());
  try {
    harness.input("#audioServiceApiKey", "fixture-replacement");
    assertDraft(harness, true);
    harness.input("#audioServiceApiKey", "");
    assertDraft(harness, false);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.equal(audioCommands(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const destination of ["category", "account", "new account"] as const) {
  test(`leaving an audio key-only draft for another ${destination} clears its dirty state`, async () => {
    const harness = await createDialogHarness(audioState([service, musicService]));
    try {
      harness.click("#extensionsTab");
      harness.input("#audioServiceApiKey", "fixture-leaving-key");
      assertDraft(harness, true);
      let newId: string | undefined;
      if (destination === "category") visitMcp(harness);
      else {
        if (destination === "new account") {
          harness.click("#addAudioServiceButton");
          newId = selectedAudioService(harness);
        } else selectAudioService(harness, musicService.id);
        selectAudioService(harness, service.id);
      }
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
      assertDraft(harness, false);
      if (newId) {
        selectAudioService(harness, newId);
        assertDraft(harness, true);
        assert.equal(harness.document.querySelector<HTMLButtonElement>("#removeAudioServiceButton")!.hidden, true);
      }
      assert.equal(audioCommands(harness).length, 0);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("audio navigation keeps changed public fields and an unsaved new account", async () => {
  const harness = await createDialogHarness(audioState([service, musicService]));
  try {
    harness.input("#audioServiceName", "Still editing");
    harness.input("#audioServiceApiKey", "fixture-public-edit-key");
    visitMcp(harness);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Still editing");
    assertDraft(harness, true);
    selectAudioService(harness, musicService.id);
    selectAudioService(harness, service.id);
    assertDraft(harness, true);
    harness.click("#addAudioServiceButton");
    const newId = selectedAudioService(harness);
    visitMcp(harness);
    assert.equal(selectedAudioService(harness), newId);
    assertDraft(harness, true);
    assert.equal(audioCommands(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("navigation preserves an audio credential conflict even when public fields match", async () => {
  const state = audioState();
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceApiKey", "fixture-before-conflict");
    harness.emitServerEvent(broadcast(state, { ...state.integrationConnections, revision: "2" }));
    await harness.settle();
    visitMcp(harness);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#reloadAudioServiceButton")!.disabled, false);
    assert.equal(audioCommands(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an unknown key-only audio save retains recovery through input and navigation until an explicit retry", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    harness.input("#audioServiceApiKey", "fixture-unknown-replacement");
    harness.failNextCommand("Settings outcome unknown.", undefined, { commandOutcome: "unknown", state });
    harness.holdNextCommand();
    harness.click("#saveAudioServiceButton");
    visitMcp(harness);
    assert.equal(harness.document.querySelector("#audioDraftStatus")!.textContent, "Unsaved changes");
    harness.releaseHeldCommand();
    await harness.settle();
    assertDraft(harness, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    visitMcp(harness);
    selectAudioService(harness, musicService.id);
    selectAudioService(harness, service.id);
    harness.input("#audioServiceName", service.name);
    assertDraft(harness, true);
    assert.match(harness.document.querySelector("#status")!.textContent!, /Settings outcome unknown/u);
    assert.equal(audioCommands(harness).length, 1);
    harness.input("#audioServiceApiKey", "fixture-explicit-retry");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const retry = audioCommands(harness).at(-1)!.integrationConnections;
    assert.equal(retry.expectedRevision, "1");
    if (retry.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(retry.connection.secrets?.apiKey, "fixture-explicit-retry");
    assertDraft(harness, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a rejected audio key-only save keeps its draft until a deliberate no-op edit", async () => {
  const harness = await createDialogHarness(audioState());
  try {
    harness.input("#audioServiceApiKey", "fixture-rejected-replacement");
    harness.failNextCommand("Settings could not be saved.");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assertDraft(harness, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    harness.input("#audioServiceName", service.name);
    assertDraft(harness, false);
    assert.equal(audioCommands(harness).length, 1);
    assert.match(harness.document.querySelector("#status")!.textContent!, /Settings could not be saved/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
