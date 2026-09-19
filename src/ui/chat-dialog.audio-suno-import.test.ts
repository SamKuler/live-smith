import assert from "node:assert/strict";
import test from "node:test";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioCommands, audioState, broadcast, integrationConnectionView,
  musicService, selectAudioService, selectedAudioService } from "./chat-dialog.audio-test-helpers.js";

const cookie = "eyJmaXh0dXJlIjp0cnVlfQ.eyJzdWIiOiJ1aS10ZXN0In0.c3ludGhldGlj";
const fullCookie = `Cookie: ignored=private; __session=${cookie}; __client_uat=123`;
const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: false, apiKeyConfigured: false };
type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const inputValue = (harness: Harness) => harness.document.querySelector<HTMLInputElement>("#sunoSessionValue")!.value;
function assertNoRetainedCookie(harness: Harness) {
  assert.equal(inputValue(harness), "");
  assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /eyJmaXh0dXJl/);
  for (const storage of [harness.window.localStorage, harness.window.sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      assert.doesNotMatch(storage.getItem(storage.key(index)!)!, /eyJmaXh0dXJl/);
    }
  }
}

test("opening Suno from a draft only opens the default browser, without saving or claiming sign-in", async () => {
  const harness = await createDialogHarness(audioState([musicService]));
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "My Suno");
    harness.select("#audioServiceProvider", "suno");
    harness.holdNextCommand();
    harness.click("#openSunoWebsiteButton");
    harness.click("#openSunoWebsiteButton");
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "open_suno_website" }]);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(audioCommands(harness).length, 0);
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "");
    assert.equal(harness.document.querySelector("#connectSunoButton")!.textContent, "Save and connect");
    assert.deepEqual(harness.windowOpenAttempts, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const value of [cookie, "__client=" + cookie, fullCookie]) {
  test(`saved connection imports ${value.startsWith("Cookie:") ? "a current Cookie header" : value.startsWith("__client") ? "an exact Cookie assignment" : "the raw Cookie value"} without a settings save`, async () => {
    const harness = await createDialogHarness(audioState([website, musicService]));
    try {
      harness.input("#sunoSessionValue", value);
      harness.holdNextCommand();
      harness.click("#connectSunoButton");
      assertNoRetainedCookie(harness);
      assert.deepEqual(commandCalls(harness).map((call) => call.body), [
        { kind: "import_suno_session", serviceId: website.id, sessionValue: value },
      ]);
      selectAudioService(harness, musicService.id);
      harness.releaseHeldCommand();
      await harness.settle();
      assert.equal(selectedAudioService(harness), musicService.id);
      selectAudioService(harness, website.id);
      assertNoRetainedCookie(harness);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("invalid Cookie formats never save or import, clear the field and focus it for correction", async () => {
  const harness = await createDialogHarness(audioState([website]));
  try {
    for (const value of ["Cookie: __client_uat=123", "__client=not-a-jwt", "__session=not-a-jwt",
      '[{"name":"__client","value":"' + cookie + '"}]', cookie + "\nCookie:other=value", "a".repeat(16_385), ""]) {
      harness.input("#sunoSessionValue", value);
      harness.document.querySelector("#sunoSessionValue")!.dispatchEvent(new harness.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await harness.settle();
      assert.equal(commandCalls(harness).length, 0);
      assert.equal(harness.document.activeElement?.id, "sunoSessionValue");
      assertNoRetainedCookie(harness);
    }
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

for (const failure of ["rejected", "unknown", "lost response", "invalid name"] as const) {
  test(`${failure} draft save cannot import or restore the submitted Cookie`, async () => {
    const state = audioState([website, musicService]);
    const harness = await createDialogHarness(state);
    try {
      harness.input("#audioServiceName", failure === "invalid name" ? "" : "Edited Suno");
      harness.input("#sunoSessionValue", cookie);
      if (failure === "rejected") harness.failNextCommand("Save failed.");
      if (failure === "unknown") harness.failNextCommand("Save outcome unknown.", undefined, {
        commandOutcome: "unknown", state: { ...state, integrationConnections: { revision: "2",
          connections: [integrationConnectionView({ ...website, name: "Edited Suno" }),
            integrationConnectionView(musicService)] } },
      });
      if (failure === "lost response") harness.rejectNextCommandResponse("Save response lost.");
      harness.click("#connectSunoButton");
      await harness.settle();
      assert.equal(commandCalls(harness).some((call) => (call.body as { kind: string }).kind === "import_suno_session"), false);
      assertNoRetainedCookie(harness);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

for (const change of ["provider", "removed", "newer identical save", "close"] as const) {
  test(`${change} during automatic save cannot transfer the pending Cookie`, async () => {
    const state = audioState([website, musicService]);
    const harness = await createDialogHarness(state);
    try {
      harness.input("#audioServiceName", "Edited Suno");
      harness.input("#sunoSessionValue", cookie);
      harness.holdNextCommandResponse();
      harness.click("#connectSunoButton");
      await harness.settle();
      assert.equal(audioCommands(harness).length, 1);
      if (change === "close") {
        harness.click("#closeButton");
        await harness.settle();
        await harness.cancelAppConfirmation();
      } else {
        const connections = change === "removed" ? [musicService] : [{ ...website, name: "Edited Suno",
          ...(change === "provider" ? { provider: "lalal" as const } : {}) }, musicService];
        const next = { revision: "3", connections: connections.map(integrationConnectionView) };
        harness.setServerState({ ...state, integrationConnections: next });
        harness.emitServerEvent(broadcast(state, next));
        await harness.settle();
      }
      harness.releaseHeldCommandResponse();
      await harness.settle();
      assert.equal(commandCalls(harness).length, 1, "only the settings command may have been submitted");
      assertNoRetainedCookie(harness);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  });
}

test("Cookie input never becomes a connection draft and is cleared on selection, provider, editor, inspector, tab and window closure", async () => {
  const harness = await createDialogHarness(audioState([website, musicService]));
  try {
    harness.click("#appTab");
    selectAudioService(harness, website.id);
    harness.input("#sunoSessionValue", cookie);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    selectAudioService(harness, musicService.id);
    selectAudioService(harness, website.id);
    assertNoRetainedCookie(harness);
    harness.input("#sunoSessionValue", cookie);
    harness.select("#audioServiceProvider", "lalal");
    harness.select("#audioServiceProvider", "suno");
    assertNoRetainedCookie(harness);
    harness.input("#sunoSessionValue", cookie);
    harness.click("#audioServiceEditorSummary");
    await harness.settle();
    assertNoRetainedCookie(harness);
    harness.click("#audioServiceEditorSummary");
    harness.input("#sunoSessionValue", cookie);
    harness.click("#settingsButton");
    await harness.settle();
    assertNoRetainedCookie(harness);
    harness.click("#appTab");
    harness.input("#sunoSessionValue", cookie);
    harness.click("#agentTab");
    await harness.settle();
    assertNoRetainedCookie(harness);
    harness.click("#appTab");
    harness.input("#sunoSessionValue", cookie);
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    assertNoRetainedCookie(harness);
    harness.input("#sunoSessionValue", cookie);
    harness.click("#closeButton");
    await harness.settle();
    assertNoRetainedCookie(harness);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("failed import keeps saved account evidence and requires a new local paste for retry", async () => {
  const state = { ...audioState([website]), sunoAccounts: [{ serviceId: website.id, status: "signed_in" as const,
    accountId: "existing_account", accountName: "Existing musician" }] };
  const harness = await createDialogHarness(state);
  try {
    harness.input("#sunoSessionValue", cookie);
    harness.failNextCommand("Suno Cookie could not be verified.");
    harness.click("#connectSunoButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "Suno account: Existing musician");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#connectSunoButton")!.disabled, true);
    assertNoRetainedCookie(harness);
    harness.click("#connectSunoButton");
    assert.equal(commandCalls(harness).length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("draft connect clears the Cookie immediately, saves only configuration, then imports once to that exact saved service", async () => {
  const harness = await createDialogHarness(audioState([musicService]));
  try {
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "My Suno");
    harness.select("#audioServiceProvider", "suno");
    const id = selectedAudioService(harness);
    const input = harness.document.querySelector<HTMLInputElement>("#sunoSessionValue")!;
    assert.equal(input.type, "password");
    assert.equal(input.autocomplete, "off");
    assert.equal(input.maxLength, 16384);
    harness.input("#sunoSessionValue", cookie);
    harness.holdNextCommand();
    harness.click("#connectSunoButton");
    assert.equal(input.value, "");
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /eyJmaXh0dXJl/);
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "save_global_settings", integrationConnections: {
      action: "upsert", expectedRevision: "1", connection: {
        id, name: "My Suno", pluginId: builtInAudioPluginId("suno"), enabled: false,
        configuration: {},
      },
    } }]);
    harness.click("#connectSunoButton");
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body).slice(1), [
      { kind: "import_suno_session", serviceId: id, sessionValue: cookie },
    ]);
    assert.equal(input.value, "");
    assert.equal(harness.document.querySelector("#connectSunoButton")!.textContent, "Connect");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
