import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, service, musicService, sunoService, selectAudioService, selectedAudioService, audioCommands, job, broadcast } from "./chat-dialog.audio-test-helpers.js";

test("audio connections are visible with status, and editing expands only on explicit selection", async () => {
  const h = await createDialogHarness(audioState([service, musicService, { ...sunoService, enabled: false }]));
  try {
    assert.equal(h.document.querySelectorAll("[data-audio-service-id]").length, 3);
    const rows = h.document.querySelector("#audioServiceSelector")!.textContent!;
    assert.match(rows, /Work separation.*Ready.*Music studio.*Ready.*Third-party studio.*Disabled/s);
    assert.equal(h.document.querySelector(`[data-audio-service-id="${service.id}"] .activity-state`)?.getAttribute("data-status"), "complete");
    assert.equal(h.document.querySelector(`[data-audio-service-id="${sunoService.id}"] .activity-state`)?.getAttribute("data-status"), "stopped");
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceFields")!.open, false);
    const row = h.document.querySelector<HTMLButtonElement>(`[data-audio-service-id="${musicService.id}"]`)!;
    row.focus(); row.click();
    assert.equal(selectedAudioService(h), musicService.id);
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceFields")!.open, true);
    assert.equal(h.document.activeElement, row, "selection must not destroy keyboard focus");
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, musicService.name);
    assert.equal(h.document.querySelector("#audioServiceProvider")?.getAttribute("name"), "audioServiceProvider");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("API-key audio services use the shared authentication surface", async () => {
  const services = [
    service,
    musicService,
    sunoService,
    {
      id: "audio-suno-platform",
      name: "Official Suno API",
      provider: "suno-platform" as const,
      enabled: true,
      apiKeyConfigured: true,
    },
  ];
  const h = await createDialogHarness(audioState(services));
  try {
    for (const audioService of services) {
      selectAudioService(h, audioService.id);
      const panel = h.document.querySelector<HTMLElement>("#audioServiceKeyField")!;
      assert.equal(panel.classList.contains("connection-auth-panel"), true, audioService.provider);
      assert.equal(panel.dataset.authState, "signed-in", audioService.provider);
      assert.equal(panel.querySelector(".connection-auth-state-badge")?.textContent, "Ready");
      assert.equal(panel.querySelector(".connection-auth-state-title")?.id, "audioServiceKeyStatus");
    }
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("an unconfigured API-key audio service exposes the shared setup state", async () => {
  const unconfigured = { ...service, id: "audio-unconfigured", enabled: false, apiKeyConfigured: false };
  const h = await createDialogHarness(audioState([unconfigured]));
  try {
    selectAudioService(h, unconfigured.id);
    const panel = h.document.querySelector<HTMLElement>("#audioServiceKeyField")!;
    assert.equal(panel.dataset.authState, "signed-out");
    assert.equal(panel.querySelector(".connection-auth-state-badge")?.textContent, "Needs setup");
    assert.equal(panel.querySelector("#audioServiceKeyStatus")?.textContent, "No API key configured");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("new connection opens its editor and optional model controls do not dominate the form", async () => {
  const h = await createDialogHarness(audioState());
  try {
    h.click("#addAudioServiceButton");
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceFields")!.open, true);
    assert.equal(h.document.activeElement?.id, "audioServiceName");
    h.select("#audioServiceProvider", "elevenlabs");
    const advanced = h.document.querySelector<HTMLDetailsElement>("#audioServiceModelField")!;
    assert.equal(advanced.hidden, false); assert.equal(advanced.open, false);
    h.click("#audioServiceModelSummary");
    assert.equal(advanced.open, true);
  } finally { h.close(); }
});

test("connection maintenance closes when its selected connection changes", async () => {
  const h = await createDialogHarness(audioState([service, musicService]));
  try {
    selectAudioService(h, service.id);
    const maintenance = h.document.querySelector<HTMLDetailsElement>("#audioServiceMaintenance")!;
    h.click("#audioServiceMaintenance > summary");
    assert.equal(maintenance.open, true);
    selectAudioService(h, musicService.id);
    assert.equal(maintenance.open, false);
  } finally { h.close(); }
});

test("reopening the selected connection preserves its unsaved key until Save", async () => {
  const h = await createDialogHarness(audioState());
  try {
    selectAudioService(h, service.id);
    h.input("#audioServiceApiKey", "synthetic-replacement-key");
    assert.equal(h.document.querySelector("#audioDraftStatus")?.textContent, "Unsaved changes");
    h.click("#audioServiceEditorSummary");
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceFields")!.open, false);
    selectAudioService(h, service.id);
    assert.equal(h.document.querySelector<HTMLDetailsElement>("#audioServiceFields")!.open, true);
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "synthetic-replacement-key");
    h.click("#saveAudioServiceButton"); await h.settle();
    const command = audioCommands(h).at(-1)!.audioServices;
    assert.equal(command.action, "upsert");
    if (command.action !== "upsert") throw new Error("Expected upsert");
    assert.equal(command.connection.apiKey, "synthetic-replacement-key");
  } finally { h.close(); }
});

test("clearing or removing a saved connection requires confirmation and cancelling preserves it", async () => {
  const h = await createDialogHarness(audioState());
  try {
    selectAudioService(h, service.id);
    for (const selector of ["#clearAudioServiceButton", "#removeAudioServiceButton"]) {
      h.click(selector);
      await h.cancelAppConfirmation();
      await h.settle();
      assert.equal(audioCommands(h).length, 0);
      assert.equal(selectedAudioService(h), service.id);
      assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceEnabled")!.checked, true);
    }
    h.click("#removeAudioServiceButton");
    await h.acceptAppConfirmation(); await h.settle();
    assert.equal(audioCommands(h).at(-1)?.audioServices.action, "remove");
    const editor = h.document.querySelector<HTMLDetailsElement>(
      "#audioServiceFields",
    )!;
    assert.equal(h.document.querySelectorAll("[data-audio-service-id]").length, 0);
    assert.equal(editor.hidden, true);
    assert.equal(editor.open, false);
  } finally { h.close(); }
});

test("audio outputs show duration and format before playback without replacing their player", async () => {
  const state = audioState(); state.audioJobs = [job(state.activeSessionId)];
  const h = await createDialogHarness(state);
  try {
    const output = h.document.querySelector("[data-audio-output]")!;
    const card = h.document.querySelector<HTMLElement>("[data-audio-job-id]")!;
    assert.equal(card.querySelector("h4")?.textContent, "Audio 1 · Stem separation");
    assert.equal(card.querySelector(".activity-state")?.textContent, "Partial audio results");
    assert.equal(card.querySelector(".activity-state")?.getAttribute("data-status"), "partial");
    assert.match(card.getAttribute("aria-describedby") ?? "", /audio-job-status-job-one audio-job-route-job-one/);
    assert.match(output.textContent!, /14:59.*WAV/);
    const player = output.querySelector("audio");
    selectAudioService(h, service.id);
    h.input("#audioServiceName", "Draft label");
    assert.equal(output.querySelector("audio"), player);
  } finally { h.close(); }
});

test("unchanged audio status text is not rewritten during draft input", async () => {
  const state = audioState();
  state.audioJobs = [job(state.activeSessionId, { status: "completed", resumable: false })];
  const h = await createDialogHarness(state);
  try {
    selectAudioService(h, service.id);
    h.input("#audioServiceName", "First draft name");
    const draftStatus = h.document.querySelector("#audioDraftStatus")!;
    const resultsStatus = h.document.querySelector("#sessionAudioResultsStatus")!;
    const mutations: MutationRecord[] = [];
    const observer = new h.window.MutationObserver((records) => mutations.push(...records));
    observer.observe(draftStatus, { childList: true, characterData: true, subtree: true });
    observer.observe(resultsStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    h.input("#audioServiceName", "Second draft name");
    await Promise.resolve();
    observer.disconnect();
    assert.deepEqual(mutations, []);
  } finally { h.close(); }
});

test("confirmation translates live and cannot delete a connection changed by another window", async () => {
  const state = audioState();
  const h = await createDialogHarness(state);
  try {
    selectAudioService(h, service.id);
    h.click("#removeAudioServiceButton");
    h.emitServerEvent({ ...broadcast(state, state.audioServices), uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.settle();
    assert.match(h.document.querySelector("#appConfirmationTitle")!.textContent!, /移除/);
    const changed = { revision: "2", connections: [{ ...service, name: "Changed in another window" }] };
    h.emitServerEvent({ ...broadcast(state, changed), commandId: "peer-audio-change", uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.acceptAppConfirmation(); await h.settle();
    assert.equal(audioCommands(h).length, 0);
  } finally { h.close(); }
});
