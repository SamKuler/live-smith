import assert from "node:assert/strict";
import test from "node:test";
import { uiMessage } from "./i18n/ui-message.js";
import { audioState, broadcast, job, musicService } from "./chat-dialog.audio-test-helpers.js";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
const remotes = [{ key: "11111111-1111-4111-8111-111111111111", role: "music" as const },
  { key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "music_alternative" as const }];
function resultState() {
  const state = audioState([website, musicService]);
  state.sunoAccounts = [{ serviceId: website.id, status: "signed_in", accountId: "user_personal" }];
  state.audioJobs = [job(state.activeSessionId, { provider: "suno", serviceId: website.id, operation: "generate_music",
    status: "ready", stems: [], outputs: [], remoteOutputs: remotes, resumable: false })];
  return state;
}

test("one preview button toggles its player, label and expanded state without paid commands", async () => {
  const h = await createDialogHarness(resultState());
  try {
    const preview = h.document.querySelector<HTMLButtonElement>("[data-preview-audio]")!;
    preview.click();
    assert.equal(preview.textContent, "Close preview");
    assert.equal(preview.getAttribute("aria-expanded"), "true");
    assert.equal(h.document.querySelector("[data-close-audio-preview]"), null);
    assert.equal(h.document.querySelectorAll("#audioJobs iframe").length, 1);
    preview.click();
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(preview.textContent, "Preview");
    assert.equal(preview.getAttribute("aria-expanded"), "false");
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("chronological job numbers, creation times and newest marker survive a new job", async () => {
  const state = resultState();
  const old = state.audioJobs![0]!;
  old.createdAt = "2026-09-15T13:24:03.008Z";
  state.audioJobs = [job(state.activeSessionId, { ...old, id: "job-new", createdAt: "2026-09-15T13:58:44.750Z" }), old];
  const h = await createDialogHarness(state);
  try {
    const cards = [...h.document.querySelectorAll<HTMLElement>("[data-audio-job-id]")];
    assert.match(cards[0]!.querySelector("h4")!.textContent!, /Audio 2/);
    assert.match(cards[1]!.querySelector("h4")!.textContent!, /Audio 1/);
    assert.equal(cards[0]!.querySelector("time")!.dateTime, state.audioJobs[0]!.createdAt);
    assert.equal(cards[0]!.querySelector("[data-audio-latest]")!.textContent, "Latest");
    assert.equal(cards[1]!.querySelector<HTMLElement>("[data-audio-latest]")!.hidden, true);
    h.setServerState({ ...state, audioJobs: [job(state.activeSessionId, { ...old, id: "job-third", createdAt: "2026-09-15T14:20:00.000Z" }), ...state.audioJobs] });
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector('[data-audio-job-id="job-one"]'), cards[1]);
    assert.match(cards[1]!.querySelector("h4")!.textContent!, /Audio 1/);
    assert.match(h.document.querySelector("#audioJobs h4")!.textContent!, /Audio 3/);
  } finally { h.close(); }
});

test("saved versions have one result row, canonical translated labels and local preview", async () => {
  const state = resultState();
  const local = { ...job(state.activeSessionId).outputs[0]!, role: "music" as const, label: "Music", origin: { kind: "generated" as const } };
  state.audioJobs![0]!.outputs = [local];
  state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  try {
    assert.equal(h.document.querySelectorAll("[data-audio-result]").length, 2);
    const output = h.document.querySelector<HTMLElement>('[data-audio-output="asset-one"]')!;
    assert.match(output.textContent!, /版本 1.*已下载到 Live Smith/);
    assert.doesNotMatch(output.textContent!, /Music/);
    assert.equal(output.querySelector("[data-download-local-audio]")!.textContent, "导出 WAV");
    output.querySelector<HTMLButtonElement>("[data-preview-audio]")!.click();
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(output.querySelector<HTMLAudioElement>("audio")!.hidden, false);
    const player = output.querySelector("audio");
    h.emitServerEvent({ ...broadcast(state, state.integrationConnections), uiLanguage: "en", uiLanguageRevision: "1" }); await h.settle();
    assert.equal(output.querySelector("audio"), player);
    assert.match(output.textContent!, /Version 1/);
    assert.equal(output.querySelector("[data-preview-audio]")!.textContent, "Close preview");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("authored audio details translate but diagnostic and title strings remain literal", async () => {
  const state = resultState(); state.settings.uiLanguage = "zh-CN";
  state.audioJobs![0] = { ...state.audioJobs![0]!, title: "Music <img src=x>",
    message: uiMessage("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.") };
  const h = await createDialogHarness(state);
  try {
    assert.match(h.document.querySelector("#audioJobs h4")!.textContent!, /Music <img src=x>/);
    assert.equal(h.document.querySelector("#audioJobs img"), null);
    assert.match(h.document.querySelector(".audio-job-details p")!.textContent!, /已下载到 Live Smith/);
    h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, message: "provider diagnostic Music <b>raw</b>" }] });
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector(".audio-job-details p")!.textContent, "provider diagnostic Music <b>raw</b>");
  } finally { h.close(); }
});

test("latest ready status distinguishes earlier failures and unfinished chosen downloads", async () => {
  const state = resultState();
  const latest = job(state.activeSessionId, { ...state.audioJobs![0]!, status: "partial", remoteOutcome: "completed", outputs: [{ ...job(state.activeSessionId).outputs[0]!, role: "music", origin: { kind: "generated" } }] });
  state.audioJobs = [latest, job(state.activeSessionId, { id: "job-old", status: "failed", resumable: false, outputs: [], createdAt: "2026-09-06T00:00:00.000Z" })];
  const h = await createDialogHarness(state);
  try {
    assert.match(h.document.querySelector("#audioJobs .activity-state")!.textContent!, /Generated.*1 downloaded/);
    assert.equal(h.document.querySelector("#audioJobs .activity-state")!.getAttribute("data-status"), "complete");
    assert.match(h.document.querySelector("#sessionAudioResultsStatus")!.textContent!, /Latest.*Generated.*1 earlier task/);
  } finally { h.close(); }
});

test("a downloaded version upgrades its existing preview row to paused local audio", async () => {
  const state = resultState();
  const h = await createDialogHarness(state);
  try {
    const output = h.document.querySelector<HTMLElement>("[data-remote-audio-key]")!;
    const preview = output.querySelector<HTMLButtonElement>("[data-preview-audio]")!;
    preview.click(); const remote = output.querySelector("iframe")!;
    const local = { ...job(state.activeSessionId).outputs[0]!, role: "music" as const, label: "Music", origin: { kind: "generated" as const } };
    h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, outputs: [local] }] });
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector("[data-remote-audio-key]"), output);
    assert.equal(remote.isConnected, false);
    assert.equal(output.querySelector("[data-download-audio-output]"), null);
    const player = output.querySelector<HTMLAudioElement>("audio")!;
    assert.equal(player.hidden, false); assert.equal(player.paused, true); assert.equal(player.autoplay, false);
    assert.equal(preview.textContent, "Close preview");
    preview.click(); assert.equal(player.hidden, true);
    preview.click(); assert.equal(output.querySelector("audio"), player);
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(h.document.querySelectorAll("[data-audio-result]").length, 2);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a pending download translates its bound version while retaining the original connection name", async () => {
  const state = resultState();
  const h = await createDialogHarness(state);
  try {
    h.click('[data-download-audio-output="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]');
    assert.match(h.document.querySelector("#appConfirmationMessage")!.textContent!, /Version 2.*Personal Suno/);
    h.emitServerEvent({ ...broadcast(state, state.integrationConnections), uiLanguage: "zh-CN", uiLanguageRevision: "1" }); await h.settle();
    assert.match(h.document.querySelector("#appConfirmationMessage")!.textContent!, /Personal Suno.*版本 2/);
    assert.doesNotMatch(h.document.querySelector("#appConfirmationMessage")!.textContent!, /Version 2/);
    assert.equal(h.document.querySelector("#appConfirmationAccept")!.textContent, "下载到 Live Smith");
    await h.cancelAppConfirmation(); await h.settle();
    assert.equal(commandCalls(h).length, 0);
  } finally { h.close(); }
});

test("preview, download and export control names distinguish different jobs", async () => {
  const state = resultState();
  const original = state.audioJobs![0]!;
  const local = { ...job(state.activeSessionId).outputs[0]!, role: "music" as const, origin: { kind: "generated" as const } };
  state.audioJobs = [{ ...original, title: "First take", outputs: [local] },
    { ...original, id: "job-second", title: "Second take", outputs: [{ ...local, id: "asset-second", jobId: "job-second" }] }];
  const h = await createDialogHarness(state);
  try {
    for (const selector of ["[data-preview-audio]", "[data-download-audio-output]", "[data-download-local-audio]"]) {
      const names = [...h.document.querySelectorAll(selector)].map(control => control.getAttribute("aria-label")!);
      assert.ok(names.some(name => name.includes("First take")), selector);
      assert.ok(names.some(name => name.includes("Second take")), selector);
      assert.equal(new Set(names).size, names.length, selector);
    }
  } finally { h.close(); }
});
