import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, audioCommands, broadcast, integrationConnectionView,
  musicService, selectAudioService } from "./chat-dialog.audio-test-helpers.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: false, apiKeyConfigured: false };
const account = { serviceId: website.id, status: "saved" as const, accountId: "user_personal", accountName: "Musician" };
const models = [
  { id: "model-new", name: "Latest <version>", canUse: true, isDefault: true },
  { id: "model-previous", name: "Previous version", canUse: true, isDefault: false },
  { id: "model-locked", name: "Locked version", canUse: false },
  { id: "model-unknown", name: "Unknown version" },
];
const initial = () => ({ ...audioState([website, musicService]), sunoAccounts: [{ ...account }] });
const catalog = () => ({ serviceId: website.id, accountId: account.accountId, integrationConnectionsRevision: "1", models: models.map(model => ({ ...model })) });

test("Suno versions load through one read-only account command and save only an explicit selected ID", async () => {
  const state = initial();
  const h = await createDialogHarness(state);
  try {
    const picker = h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!;
    assert.equal(picker.value, "");
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#sunoCookieEditor")!.open, false);
    h.holdNextCommand();
    h.click("#loadSunoModelsButton");
    assert.equal(h.document.querySelector("#sunoModelSelection")!.getAttribute("aria-busy"), "true");
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSunoModelsButton")!.disabled, true);
    h.setServerState({ ...state, sunoModelCatalog: catalog() });
    h.releaseHeldCommand(); await h.settle();
    assert.deepEqual(commandCalls(h).map(call => call.body), [{ kind: "load_suno_models", serviceId: website.id }]);
    assert.equal(audioCommands(h).length, 0);
    assert.match(picker.options[0]!.textContent!, /Account default.*Latest <version>/);
    assert.equal(picker.querySelector("version"), null);
    assert.equal(picker.querySelector<HTMLOptionElement>('[value="model-locked"]')!.disabled, true);
    assert.equal(picker.querySelector<HTMLOptionElement>('[value="model-unknown"]')!.disabled, true);
    h.select("#sunoModelPicker", "model-previous");
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, "model-previous");
    h.setServerState({ ...state, sunoModelCatalog: { ...catalog(), integrationConnectionsRevision: "2" } });
    h.click("#saveAudioServiceButton"); await h.settle();
    const write = audioCommands(h).at(-1)!.integrationConnections;
    assert.equal(write.action, "upsert");
    if (write.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(write.connection.configuration.modelId, "model-previous");
    assert.equal(write.connection.enabled, false, "version selection never enables generation");
    assert.equal(Object.hasOwn(write.connection, "secrets"), false);
    assert.equal(picker.value, "model-previous");
    assert.equal(picker.selectedOptions[0]!.textContent, "Previous version", "saving a version retains its account catalog label");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("account default removes the override and missing saved models never silently switch", async () => {
  const state = { ...initial(), integrationConnections: { revision: "1", connections: [
    integrationConnectionView({ ...website, modelId: "model-removed" }),
  ] }, sunoModelCatalog: catalog() };
  const h = await createDialogHarness(state);
  try {
    const picker = h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!;
    assert.equal(picker.value, "model-removed");
    assert.match(picker.selectedOptions[0]!.textContent!, /not in loaded catalog/);
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceModelField")!.open, false);
    h.select("#sunoModelPicker", "");
    h.click("#saveAudioServiceButton"); await h.settle();
    const write = audioCommands(h).at(-1)!.integrationConnections;
    if (write.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(Object.hasOwn(write.connection.configuration, "modelId"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("loading failure is inline, leaves the saved version intact and permits explicit retry", async () => {
  const state = { ...initial(), integrationConnections: { revision: "1", connections: [
    integrationConnectionView({ ...website, modelId: "model-previous" }),
  ] } };
  const h = await createDialogHarness(state);
  try {
    h.failNextCommand("Suno.com audio service: request rejected (HTTP 503).");
    h.click("#loadSunoModelsButton"); await h.settle();
    assert.match(h.document.querySelector("#sunoModelStatus")!.textContent!, /Could not load versions/);
    assert.equal(h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!.value, "model-previous");
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSunoModelsButton")!.disabled, false);
    assert.equal(commandCalls(h).length, 1);
    assert.equal(audioCommands(h).length, 0);
    h.setServerState({ ...state, sunoModelCatalog: catalog() });
    h.click("#loadSunoModelsButton"); await h.settle();
    assert.equal(commandCalls(h).length, 2);
    assert.equal(h.document.querySelector("#sunoModelStatus")!.classList.contains("field-error"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("late catalog for another connection does not overwrite the selected connection or model draft", async () => {
  const state = initial();
  const h = await createDialogHarness(state);
  try {
    h.holdNextCommand(); h.click("#loadSunoModelsButton");
    selectAudioService(h, musicService.id);
    h.setServerState({ ...state, sunoModelCatalog: catalog() });
    h.releaseHeldCommand(); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceModel")!.value, musicService.modelId);
    selectAudioService(h, website.id);
    h.select("#sunoModelPicker", "model-previous");
    h.emitServerEvent({ ...broadcast(state, state.integrationConnections), uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!.value, "model-previous");
    assert.match(h.document.querySelector("#sunoModelPicker")!.textContent!, /账号默认/);
    assert.equal(audioCommands(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("peer edits invalidate the old catalog and retain the explicit draft under conflict", async () => {
  const state = { ...initial(), sunoModelCatalog: catalog() };
  const h = await createDialogHarness(state);
  try {
    h.select("#sunoModelPicker", "model-previous");
    const next = { ...state.integrationConnections, revision: "2" };
    h.emitServerEvent(broadcast(state, next)); await h.settle();
    const picker = h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!;
    assert.equal(picker.value, "model-previous");
    assert.equal(picker.disabled, true);
    assert.equal(picker.querySelector('[value="model-new"]'), null);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSunoModelsButton")!.disabled, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("unsigned/new Suno connections expose setup guidance instead of loading an unrelated account", async () => {
  const h = await createDialogHarness({ ...initial(), sunoAccounts: [{ serviceId: website.id, status: "signed_out" }] });
  try {
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#sunoCookieEditor")!.open, true);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSunoModelsButton")!.disabled, true);
    assert.match(h.document.querySelector("#sunoModelStatus")!.textContent!, /Connect this Suno account/);
    h.click("#loadSunoModelsButton");
    assert.equal(commandCalls(h).length, 0);
  } finally { h.close(); }
});

test("discarding a version draft restores the saved choice without saving or loading another catalog", async () => {
  const h = await createDialogHarness({ ...initial(), sunoModelCatalog: catalog() });
  try {
    h.select("#sunoModelPicker", "model-previous");
    const discard = h.document.querySelector<HTMLButtonElement>("#reloadAudioServiceButton")!;
    assert.equal(discard.hidden, false);
    assert.equal(discard.textContent, "Discard");
    h.click("#reloadAudioServiceButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>("#sunoModelPicker")!.value, "");
    assert.equal(h.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#loadSunoModelsButton")!.disabled, false);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("editing the music version does not present the saved Suno account as disconnected", async () => {
  const h = await createDialogHarness({ ...initial(), sunoModelCatalog: catalog() });
  try {
    const name = h.document.querySelector<HTMLElement>("#sunoAccountName")!;
    const status = h.document.querySelector("#sunoLoginStatus")!;
    const original = status.textContent;
    h.select("#sunoModelPicker", "model-previous");
    assert.equal(name.hidden, false);
    assert.match(name.textContent!, /Musician/);
    assert.equal(status.textContent, original);
    assert.equal(commandCalls(h).length, 0);
  } finally { h.close(); }
});

test("an unknown catalog outcome retains its warning and never announces a confirmed load", async () => {
  const state = initial();
  const h = await createDialogHarness(state);
  try {
    h.failNextCommand("Catalog receipt is uncertain.", undefined, { commandOutcome: "unknown",
      state: { ...state, bridgeStateRevision: "100", bridgeStateCoveredThroughRevision: "100" } });
    h.click("#loadSunoModelsButton"); await h.settle();
    assert.match(h.document.querySelector("#status")!.textContent!, /Catalog receipt is uncertain/);
    assert.equal(h.document.querySelector("#sunoModelStatus")!.classList.contains("field-error"), true);
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
