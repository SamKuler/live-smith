import assert from "node:assert/strict";
import test from "node:test";
import { isAudioServiceCallbackUrl } from "../model/profile.js";
import { chatDialogStateForWire, serializeChatStateForHtml } from "./chat-state.js";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioCommands, audioState, broadcast, job, musicService, service, sunoService, toggle, selectAudioService } from "./chat-dialog.audio-test-helpers.js";

test("Add SunoAPI requires a user callback to enable, keeps other services, and round-trips redacted configuration", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    harness.click("#addAudioServiceButton");
    harness.input("#audioServiceName", "My SunoAPI");
    harness.select("#audioServiceProvider", "sunoapi");
    assert.equal(harness.document.querySelector<HTMLOptionElement>('#audioServiceProvider option[value="sunoapi"]')!.disabled, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, false);
    const callback = harness.document.querySelector<HTMLInputElement>("#audioServiceCallback")!;
    assert.equal(callback.value, "");
    assert.equal(callback.placeholder, "");
    const disclosure = harness.document.querySelector<HTMLElement>("#audioServiceDisclosure")!;
    assert.equal(disclosure.textContent, "?");
    assert.match(disclosure.getAttribute("aria-label")!, /third-party API service/);
    assert.equal(disclosure.dataset.tooltip, disclosure.getAttribute("aria-label"));
    assert.equal(
      harness.document.querySelector("#audioServiceProvider")!.getAttribute("aria-describedby"),
      "audioServiceOperations audioServiceDisclosure",
    );
    const callbackHelp = harness.document.querySelector<HTMLElement>("#audioServiceCallbackHint")!;
    assert.equal(callbackHelp.textContent, "?");
    assert.match(callbackHelp.getAttribute("aria-label")!, /notifications here.*polls for results/);
    assert.equal(callbackHelp.dataset.tooltip, callbackHelp.getAttribute("aria-label"));
    assert.match(harness.document.querySelector("#audioServiceModelHint")!.textContent!, /V6/);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.getAttribute("list"), "audioServiceModelOptions");
    assert.deepEqual(Array.from(harness.document.querySelectorAll<HTMLOptionElement>("#audioServiceModelOptions option"))
      .map((option) => option.value), ["V6", "V6_WILD", "V6_MINI", "V5_5", "V5", "V4_5PLUS", "V4_5ALL", "V4_5", "V4"]);
    harness.input("#audioServiceApiKey", "fixture-suno-ui");
    toggle(harness, true);
    assert.equal(callback.required, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).length, 0);
    assert.equal(harness.document.activeElement?.id, callback.id);
    harness.input("#audioServiceCallback", sunoService.callbackUrl!);
    harness.holdNextCommand();
    harness.click("#saveAudioServiceButton");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-suno-ui/);
    harness.releaseHeldCommand();
    await harness.settle();
    const patch = audioCommands(harness)[0]!.audioServices;
    if (patch.action !== "upsert") throw new Error("Expected upsert");
    assert.deepEqual(patch.connection, { id: patch.connection.id, name: "My SunoAPI", provider: "sunoapi",
      enabled: true, apiKey: "fixture-suno-ui", callbackUrl: sunoService.callbackUrl });
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, musicService.modelId);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    selectAudioService(harness, patch.connection.id);
    assert.equal(callback.value, sunoService.callbackUrl);
    harness.input("#audioServiceModel", "V4_5ALL");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const updated = audioCommands(harness).at(-1)!.audioServices;
    if (updated.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(updated.connection.callbackUrl, sunoService.callbackUrl);
    assert.equal(updated.connection.modelId, "V4_5ALL");
    assert.equal(Object.hasOwn(updated.connection, "apiKey"), false);

    const projection = audioState([service, musicService, sunoService]);
    projection.settings.audioServices = { revision: "1", connections: [service, musicService, sunoService].map(
      ({ apiKeyConfigured: _, ...fields }) => ({ ...fields, apiKey: "fixture-private-suno" })) };
    const wire = chatDialogStateForWire(projection);
    assert.equal(wire.audioServices!.connections[2]!.callbackUrl, sunoService.callbackUrl);
    assert.equal(Object.hasOwn(wire.settings, "audioServices"), false);
    assert.doesNotMatch(serializeChatStateForHtml(projection), /fixture-private-suno|fixture-suno-ui/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("disabled SunoAPI may omit callback; provider changes clear callback, model and unsaved key", async () => {
  const harness = await createDialogHarness(audioState([sunoService, musicService]));
  try {
    harness.input("#audioServiceApiKey", "fixture-unused");
    harness.select("#audioServiceProvider", "lalal");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceCallback")!.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, "");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceCallbackField")!.hidden, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const switched = audioCommands(harness)[0]!.audioServices;
    if (switched.action !== "upsert") throw new Error("Expected upsert");
    assert.deepEqual(switched.connection, { id: sunoService.id, name: sunoService.name, provider: "lalal", enabled: false });
    harness.select("#audioServiceProvider", "sunoapi");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    const disabled = audioCommands(harness).at(-1)!.audioServices;
    if (disabled.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(Object.hasOwn(disabled.connection, "callbackUrl"), false);
    assert.equal(disabled.connection.enabled, false);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "No API key configured");
    harness.input("#audioServiceCallback", sunoService.callbackUrl!);
    toggle(harness, true);
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).length, 2);
    assert.equal(harness.document.activeElement?.id, "audioServiceApiKey");
    selectAudioService(harness, musicService.id);
    assert.equal(harness.document.querySelector("#audioServiceKeyStatus")!.textContent, "API key configured");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("callback input and wire validation reject only malformed or credential-bearing addresses", async () => {
  const state = audioState([sunoService]);
  const harness = await createDialogHarness(state);
  const invalid = ["ftp://hooks.example.com/cb", "https:///hooks.example.com/cb",
    "https://hooks.example.com/cb#", "https://@hooks.example.com/cb",
    "https://%66ixture-secret@hooks.example.com/cb", "https://fixture-secret%3Apass%40hooks.example.com/cb",
    "https://hooks.example.com\\@localhost/cb", "https://hooks.example.com/c b", "https://hooks.example.com/%20",
    "https://hooks.example.com/%5c", "https://hooks.example.com/%0a", "https://hooks.example.com/%GG",
    "https://hooks.example.com/%C0%AF", "https://hooks.example.com/" + "a".repeat(2048)];
  try {
    for (const callbackUrl of invalid) {
      assert.equal(isAudioServiceCallbackUrl(callbackUrl), false, callbackUrl);
      harness.input("#audioServiceCallback", callbackUrl);
      harness.click("#saveAudioServiceButton");
      await harness.settle();
      assert.equal(audioCommands(harness).length, 0, callbackUrl);
      assert.equal(harness.document.activeElement?.id, "audioServiceCallback");
      assert.doesNotMatch(harness.document.querySelector("#status")!.textContent!, /fixture-secret/);
      harness.emitServerEvent(broadcast(state, { revision: "2", connections: [{ ...sunoService, callbackUrl, name: "Rejected" }] }));
      await harness.settle();
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, sunoService.name);
      assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, true);
    }
    assert.equal(harness.calls.some((call) => call.url.startsWith("https://")), false);
    harness.input("#audioServiceCallback", "https://hooks.example.com/%66ixture-callback-key");
    harness.input("#audioServiceApiKey", "fixture-callback-key");
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(audioCommands(harness).length, 0);
    assert.match(harness.document.querySelector("#status")!.textContent!, /must not contain API credentials/);
    assert.doesNotMatch(harness.document.querySelector("#status")!.textContent!, /fixture-callback-key/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("unknown SunoAPI save cannot consume its draft based on matching visible fields and key presence", async () => {
  const state = audioState([sunoService, musicService]);
  const harness = await createDialogHarness(state);
  const callbackUrl = "https://hooks.example.com/new-callback";
  try {
    harness.input("#audioServiceName", "Keep uncertain SunoAPI");
    harness.input("#audioServiceCallback", callbackUrl);
    harness.input("#audioServiceApiKey", "fixture-unknown-suno");
    harness.failNextCommand("Settings save outcome unknown.", undefined, { commandOutcome: "unknown", state: {
      ...state, audioServices: { revision: "2", connections: [
        { ...sunoService, name: "Keep uncertain SunoAPI", callbackUrl }, musicService,
      ] },
    } });
    harness.click("#saveAudioServiceButton");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Keep uncertain SunoAPI");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceCallback")!.value, callbackUrl);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, "V4_5ALL");
    assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(harness.document.querySelector<HTMLElement>("#audioServiceConflict")!.hidden, false);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-unknown-suno/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("audio wire projections reject callback and model fields without their provider consumer", async () => {
  const state = audioState([service, musicService]);
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Read the set");
    harness.click("#sendButton");
    await harness.settle();
    for (const invalid of [{ ...service, modelId: "unused" }, { ...musicService, modelId: "m".repeat(129) },
      ...[service, musicService].map((value) => ({ ...value, callbackUrl: sunoService.callbackUrl })),
      { ...sunoService, callbackUrl: undefined }, { ...sunoService, callbackUrl: "https://127.1/callback#fragment" }]) {
      harness.emitServerEvent(broadcast(state, { revision: "2", connections: [invalid] }));
      harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, audioServices: { revision: "2", connections: [invalid] } } });
      await harness.settle();
      assert.equal(harness.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, service.name);
      assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/);
    }
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("user-selected callback URLs with local hosts, ports and queries share storage and DOM validation", async () => {
  const harness = await createDialogHarness(audioState([sunoService]));
  try {
    for (const callbackUrl of ["https://hooks.example.com/%E9%9F%B3", "http://localhost:8787/cb?token=fixture",
      "https://127.0.0.1:9443/cb?stage=done", "https://hooks.example.com/" + "a".repeat(2022)]) {
      assert.equal(isAudioServiceCallbackUrl(callbackUrl), true, callbackUrl);
      harness.input("#audioServiceCallback", callbackUrl);
      harness.click("#saveAudioServiceButton");
      await harness.settle();
      const patch = audioCommands(harness).at(-1)!.audioServices;
      if (patch.action !== "upsert") throw new Error("Expected upsert");
      assert.equal(patch.connection.callbackUrl, callbackUrl);
      assert.equal(harness.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    }
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("SunoAPI music job snapshots enforce operation, output roles and asset ownership", async () => {
  const state = audioState([sunoService]);
  const base = job(state.activeSessionId);
  const valid = { ...base, provider: sunoService.provider, serviceId: sunoService.id,
    operation: "generate_music" as const, stems: [], outputs: ["music", "music_alternative"].map((role, i) => ({
      ...base.outputs[0]!, id: "take-" + i, role: role as "music" | "music_alternative", origin: { kind: "generated" as const },
    })) };
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Generate music");
    harness.click("#sendButton");
    await harness.settle();
    for (const audioJob of [{ ...valid, operation: "generate_sound_effect" },
      { ...valid, provider: "lalal" }, { ...valid, provider: "elevenlabs" },
      ...[{ role: "sound_effect" }, { role: "vocals" }, { origin: { kind: "attachment" } },
        { sessionId: "foreign" }, { jobId: "foreign" }].map((fields) => ({ ...valid, outputs: [{ ...valid.outputs[0], ...fields }] }))]) {
      harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, audioJobs: [audioJob] } });
      await harness.settle();
      assert.equal(harness.document.querySelector("#audioJobs audio"), null);
      assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/);
    }
    harness.setServerState({ ...state, audioJobs: [valid] });
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelectorAll("#audioJobs audio").length, 2);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
