import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";
import type { ChatBridgeState } from "./chat-state.js";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, broadcast, integrationConnectionView, job, musicService,
  selectAudioService, toggle, type Harness } from "./chat-dialog.audio-test-helpers.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
const account = { serviceId: website.id, status: "signed_in" as const, accountId: "user_personal", accountName: "Musician" };
const remotes = [
  { key: "11111111-1111-4111-8111-111111111111", role: "music" as const },
  { key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "music_alternative" as const },
];
function previewState(): ChatBridgeState {
  const state = audioState([website, musicService]);
  state.sunoAccounts = [account];
  state.audioJobs = [job(state.activeSessionId, { serviceId: website.id, provider: "suno", operation: "generate_music",
    stems: [], status: "ready", outputs: [], remoteOutputs: remotes.map((output) => ({ ...output })), resumable: false })];
  return state;
}
const button = (h: Harness, selector: string) => h.document.querySelector<HTMLButtonElement>(selector)!;
const download = (h: Harness, index = 0) => button(h, `[data-download-audio-output="${remotes[index]!.key}"]`);
const frame = (h: Harness) => h.document.querySelector<HTMLIFrameElement>("#audioJobs iframe");
const downloadCommands = (h: Harness) => commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "download_audio_output");
const savedOutput = (state: ChatBridgeState, role: "music" | "music_alternative" = "music") => ({
  ...job(state.activeSessionId).outputs[0]!, role, label: "Saved take", mediaType: "audio/mpeg" as const, origin: { kind: "generated" as const },
});
async function refresh(h: Harness, state: ChatBridgeState) {
  h.setServerState(state);
  h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId });
  await h.settle();
}

test("Suno preview mounts only after a click with a canonical embed URL and constrained iframe permissions", async () => {
  const h = await createDialogHarness(previewState());
  try {
    assert.equal(frame(h), null);
    assert.equal(h.document.querySelector("#audioJobs audio"), null);
    assert.equal(h.document.querySelector("#audioJobs h4")!.textContent, "Audio 1 · Music generation");
    assert.equal(h.document.querySelector("#audioJobs .activity-state")!.textContent, "Generated · online");
    assert.equal(h.document.querySelector("[data-audio-output]"), null);
    assert.equal(h.document.querySelectorAll("[data-remote-audio-key]").length, 2);
    assert.equal(h.calls.some((call) => call.url.startsWith("https://suno.com")), false);
    const preview = button(h, "[data-preview-audio]");
    assert.equal(preview.getAttribute("aria-expanded"), "false");
    preview.click();
    const player = frame(h)!;
    assert.equal(player.src, "https://suno.com/embed/" + remotes[0]!.key);
    assert.equal(player.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(player.getAttribute("sandbox"), "allow-scripts allow-same-origin");
    assert.equal(player.hasAttribute("allow"), false, "no autoplay, download, or popup delegation");
    assert.equal(player.title, "Suno online player · Version 1");
    assert.ok(h.document.getElementById(preview.getAttribute("aria-controls")!)!.contains(player));
    assert.equal(preview.getAttribute("aria-expanded"), "true");
    preview.click();
    assert.equal(frame(h), null);
    assert.equal(h.document.querySelectorAll("iframe").length, 0);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.windowOpenAttempts, []);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("unrelated state and language updates preserve the actual online frame and local player nodes", async () => {
  const state = previewState();
  state.audioJobs![0]!.outputs = [savedOutput(state)];
  const h = await createDialogHarness(state);
  try {
    button(h, '[data-remote-audio-key="' + remotes[1]!.key + '"] [data-preview-audio]').click();
    const player = frame(h)!;
    const browsingContext = player.contentWindow;
    const local = h.document.querySelector("audio");
    const card = h.document.querySelector("[data-remote-audio-key]");
    selectAudioService(h, musicService.id);
    h.input("#audioServiceName", "Unsaved other connection");
    h.emitServerEvent({ ...broadcast(state, state.integrationConnections), uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.settle();
    await refresh(h, { ...state, audioJobs: [{ ...state.audioJobs![0]!, message: "Sibling output unchanged" }] });
    assert.equal(frame(h), player);
    assert.equal(player.contentWindow, browsingContext, "do not detach and reinsert the iframe during a refresh");
    assert.equal(h.document.querySelector("audio"), local);
    assert.equal(h.document.querySelector("[data-remote-audio-key]"), card);
    assert.match(player.title, /Suno 在线播放器/);
    assert.equal(button(h, "[data-download-local-audio]").textContent, "导出 MP3");
    assert.match(h.document.querySelector("[data-audio-local-download-help]")!.textContent!, /默认浏览器.*保持 Live Smith 打开.*不会请求音频服务/);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Close preview removes the frame, restores focus, and a later click creates a fresh frame", async () => {
  const h = await createDialogHarness(previewState());
  try {
    const preview = button(h, "[data-preview-audio]");
    preview.click(); const first = frame(h)!;
    preview.click();
    assert.equal(frame(h), null);
    assert.equal(first.isConnected, false);
    assert.equal(h.document.activeElement, preview);
    assert.equal(preview.getAttribute("aria-expanded"), "false");
    assert.equal(h.document.querySelector("[data-close-audio-preview]"), null);
    preview.click();
    assert.notEqual(frame(h), first);
    assert.equal(frame(h)!.src, first.src);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const removal of ["output", "job", "session"] as const) {
  test(`removing the ${removal} removes its preview and stale detached cards cannot preview or download`, async () => {
    const state = previewState();
    const h = await createDialogHarness(state);
    try {
      const preview = button(h, "[data-preview-audio]");
      const staleDownload = download(h);
      preview.click(); const first = frame(h)!;
      if (removal === "session") {
        h.setServerState({ ...state, audioJobs: [] });
        h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
        assert.equal(h.document.querySelector<HTMLElement>("#audioJobs")!.dataset.sessionId, "session-2");
      } else await refresh(h, { ...state, audioJobs: removal === "job" ? [] : [{ ...state.audioJobs![0]!, remoteOutputs: [remotes[1]!] }] });
      assert.equal(first.isConnected, false);
      assert.equal(frame(h), null);
      preview.click(); staleDownload.click(); await h.settle();
      assert.equal(frame(h), null);
      assert.equal(downloadCommands(h).length, 0);
      assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("download cancellation sends nothing; confirmation accepts one selected output and repeated clicks cannot duplicate it", async () => {
  const state = previewState();
  const h = await createDialogHarness(state);
  try {
    selectAudioService(h, musicService.id);
    download(h, 1).click();
    assert.match(h.document.querySelector("#appConfirmationMessage")!.textContent!, /Version 2.*Personal Suno.*up to one existing Suno download allowance.*No allowance or quota will be purchased/);
    assert.equal(downloadCommands(h).length, 0);
    assert.equal(frame(h), null);
    await h.cancelAppConfirmation(); await h.settle();
    assert.equal(downloadCommands(h).length, 0);
    h.holdNextCommand();
    download(h, 1).click(); download(h, 1).click(); download(h).click();
    assert.equal(download(h).disabled, true);
    await h.acceptAppConfirmation(); await h.settle();
    download(h, 1).click(); download(h).click();
    h.click("[data-preview-audio]");
    assert.ok(frame(h), "read-only preview stays available while a download is busy");
    h.click("[data-preview-audio]");
    assert.equal(frame(h), null, "preview can be closed while the download is busy");
    assert.deepEqual(downloadCommands(h).map((call) => call.body), [{
      kind: "download_audio_output", sessionId: state.activeSessionId, jobId: state.audioJobs![0]!.id, outputKey: remotes[1]!.key,
    }]);
    assert.match(h.document.querySelector("#sendButton")!.textContent!, /Stop/);
    const saved = savedOutput(state, "music_alternative");
    h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, outputs: [saved] }] });
    h.releaseHeldCommand(); await h.settle();
    assert.equal(download(h, 1), null, "a saved role loses its remote download button");
    assert.equal(download(h).disabled, false);
    assert.equal(h.document.querySelectorAll("[data-download-local-audio]").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const changed of ["account", "account-away-and-back", "signed-out", "disabled", "removed", "provider", "model", "job", "key", "role", "saved-output", "cancelled"] as const) {
  test(`${changed} changes during download confirmation invalidate the original action`, async () => {
    const state = previewState();
    const h = await createDialogHarness(state);
    try {
      download(h).click();
      const next = structuredClone(state);
      if (changed === "account" || changed === "account-away-and-back") next.sunoAccounts![0]!.accountId = "user_replacement";
      else if (changed === "signed-out") next.sunoAccounts = [{ serviceId: website.id, status: "signed_out" }];
      else if (["disabled", "removed", "provider", "model"].includes(changed)) {
        next.integrationConnections!.revision = "2";
        const service = next.integrationConnections!.connections[0]!;
        if (changed === "disabled") service.enabled = false;
        if (changed === "removed") { next.integrationConnections!.connections.shift(); next.sunoAccounts = []; }
        if (changed === "provider") {
          service.pluginId = builtInAudioPluginId("elevenlabs");
          service.configuredSecrets = ["apiKey"];
          next.sunoAccounts = [];
        }
        if (changed === "model") service.configuration.modelId = "changed-model";
      } else {
        const result = next.audioJobs![0]!;
        if (changed === "job") result.serviceId = musicService.id;
        if (changed === "key") result.remoteOutputs![0]!.key = "22222222-2222-4222-8222-222222222222";
        if (changed === "role") result.remoteOutputs = [{ ...remotes[0]!, role: "music_alternative" }];
        if (changed === "saved-output") result.outputs = [savedOutput(state)];
        if (changed === "cancelled") result.status = "cancelled";
      }
      await refresh(h, next);
      if (changed === "account-away-and-back") await refresh(h, state);
      await h.acceptAppConfirmation(); await h.settle();
      assert.equal(downloadCommands(h).length, 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("switching Sessions or removing a card during confirmation cannot send the stale selection", async () => {
  for (const change of ["session", "detached"] as const) {
    const state = previewState();
    const h = await createDialogHarness(state);
    try {
      const original = download(h);
      original.click();
      if (change === "detached") original.closest("[data-remote-audio-key]")!.remove();
      else {
        h.setServerState({ ...state, audioJobs: [] });
        h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
      }
      await h.acceptAppConfirmation(); await h.settle();
      original.click(); await h.settle();
      assert.equal(downloadCommands(h).length, 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});

test("remote download uses saved connection enablement and usable account evidence independently of the settings editor", async () => {
  for (const status of ["signed_in", "saved", "signed_out", "expired", "unavailable"] as const) {
    const state = previewState();
    state.sunoAccounts = [status === "signed_in" || status === "saved" ? { ...account, status } : { serviceId: website.id, status }];
    const h = await createDialogHarness(state);
    try {
      selectAudioService(h, musicService.id);
      assert.equal(download(h).disabled, !["signed_in", "saved"].includes(status));
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
  const state = previewState(); state.integrationConnections!.connections[0]!.enabled = false;
  const h = await createDialogHarness(state);
  try {
    toggle(h, true);
    assert.equal(download(h).disabled, true, "draft enablement cannot authorize a download");
    download(h).click(); await h.settle();
    assert.equal(downloadCommands(h).length, 0);
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("busy operations prevent download admission and Stop cancels only the active single-output command", async () => {
  const state = previewState();
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Inspect the current track"); h.click("#sendButton"); await h.settle();
    assert.equal(download(h).disabled, true);
    download(h).click(); await h.settle();
    assert.equal(downloadCommands(h).length, 0);
    h.releaseHeldSend(); await h.settle();
    h.failNextCommand("Command stopped by user.", undefined, { commandOutcome: "stopped", status: 409, state });
    h.holdNextCommand(); download(h).click(); await h.acceptAppConfirmation(); await h.settle();
    h.click("#sendButton"); h.releaseHeldCommand(); await h.settle();
    assert.equal(h.commandStopIds.length, 1);
    assert.equal(downloadCommands(h).length, 1);
    assert.equal(download(h).disabled, false);
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.disabled, false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("saved files request a default-browser download without WebView navigation and retain playback after service removal", async () => {
  for (const mediaType of ["audio/mpeg", "audio/wav"] as const) {
    const state = previewState();
    const asset = { ...savedOutput(state), mediaType };
    state.audioJobs![0]!.outputs = [asset];
    const h = await createDialogHarness(state);
    try {
      const player = h.document.querySelector<HTMLAudioElement>("[data-audio-output] audio")!;
      const localDownload = button(h, "[data-download-local-audio]");
      const location = h.window.location.href;
      assert.equal(download(h), null);
      assert.equal(player.controls, true); assert.equal(player.preload, "none"); assert.equal(player.autoplay, false);
      const playback = new URL(player.src);
      assert.equal(playback.pathname, "/audio-assets/" + asset.id);
      assert.ok(playback.searchParams.get("token"));
      assert.equal(playback.searchParams.get("sessionId"), state.activeSessionId);
      assert.equal(playback.searchParams.has("download"), false);
      assert.equal(localDownload.tagName, "BUTTON");
      assert.equal(localDownload.type, "button");
      assert.equal(localDownload.getAttribute("aria-label"), "Export Version 1 as " + (mediaType === "audio/mpeg" ? "MP3" : "WAV") + " · Audio 1 · Music generation");
      assert.equal(localDownload.textContent, "Export " + (mediaType === "audio/mpeg" ? "MP3" : "WAV"));
      assert.equal(localDownload.hasAttribute("href"), false);
      assert.equal(localDownload.hasAttribute("download"), false);
      assert.doesNotMatch(localDownload.outerHTML, /test-token|file:|https?:|formaction/);
      const help = h.document.getElementById(localDownload.getAttribute("aria-describedby")!)!;
      assert.match(help.textContent!, /default browser.*does not contact an audio service or use provider allowance/i);
      assert.match(help.textContent!, /keep Live Smith open until it finishes/i);
      const services = {
        revision: "2",
        connections: [integrationConnectionView(musicService)],
      };
      h.emitServerEvent(broadcast(state, services)); await h.settle();
      assert.equal(h.document.querySelector("audio"), player);
      assert.equal(h.document.querySelector("[data-download-local-audio]"), localDownload);
      assert.equal(localDownload.disabled, false);
      assert.equal(download(h, 1).disabled, true);
      assert.equal(player.closest<HTMLElement>("[data-audio-result]")!.hidden, false);
      h.holdNextCommand(); localDownload.click(); await h.settle();
      assert.deepEqual(commandCalls(h).map((call) => call.body), [{
        kind: "open_audio_download", sessionId: state.activeSessionId, assetId: asset.id,
      }]);
      const message = "The local audio file was sent to your default browser for download. Keep Live Smith open until it finishes.";
      h.emitServerEvent({ type: "command_progress", commandId: h.commandIds.at(-1), message });
      await h.settle();
      assert.equal(h.document.querySelector("#status")!.textContent, message);
      h.releaseHeldCommand(); await h.settle();
      assert.doesNotMatch(h.document.querySelector("#status")!.textContent!, /download (?:completed|finished)|downloaded successfully/i);
      assert.equal(h.document.querySelector("[data-audio-results] a"), null);
      assert.equal(h.document.querySelector("iframe"), null);
      assert.equal(h.window.location.href, location);
      assert.deepEqual(h.windowOpenAttempts, []);
      assert.equal(h.calls.some((call) => call.path.startsWith("/audio-assets/")), false);
      assert.equal(downloadCommands(h).length, 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});

for (const change of ["session", "detached", "output", "job"] as const) {
  test(`local export rejects ${change} changes even when the stale control is clicked directly`, async () => {
    const state = previewState();
    const asset = savedOutput(state);
    state.audioJobs![0]!.outputs = [asset];
    const h = await createDialogHarness(state);
    try {
      const localDownload = button(h, "[data-download-local-audio]");
      const output = localDownload.closest("[data-audio-output]")!;
      const card = localDownload.closest("[data-audio-job-id]")!;
      if (change === "detached") localDownload.remove();
      else if (change === "session") {
        h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, outputs: [{ ...asset, sessionId: "session-2" }] }] });
        h.holdNextCommand();
        h.click('.session-entry[data-session-id="session-2"] .session-row');
        localDownload.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
        h.releaseHeldCommand(); await h.settle();
        assert.equal(h.document.querySelector<HTMLElement>("#audioJobs")!.dataset.sessionId, "session-2");
        h.document.querySelector("#audioJobs")!.append(card);
      } else {
        await refresh(h, { ...state, audioJobs: change === "job" ? [] : [{ ...state.audioJobs![0]!, outputs: [] }] });
        if (change === "job") h.document.querySelector("#audioJobs")!.append(card);
        else h.document.querySelector("[data-audio-results]")!.append(output);
      }
      localDownload.disabled = false;
      localDownload.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
      await h.settle();
      assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "open_audio_download").length, 0);
      assert.equal(h.window.location.href, "http://dialog.test/chat");
      assert.deepEqual(h.windowOpenAttempts, []);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("local export blocks busy sends and pending remote confirmation, suppresses duplicates, and supports Stop", async () => {
  const state = previewState();
  state.audioJobs![0]!.outputs = [savedOutput(state)];
  const h = await createDialogHarness(state);
  try {
    const localDownload = button(h, "[data-download-local-audio]");
    const exports = () => commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "open_audio_download");
    h.holdNextSend(); h.input("#prompt", "Inspect the current track"); h.click("#sendButton"); await h.settle();
    assert.equal(localDownload.disabled, true);
    localDownload.click();
    localDownload.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true })); await h.settle();
    assert.equal(exports().length, 0);
    h.releaseHeldSend(); await h.settle();
    download(h, 1).click();
    assert.equal(localDownload.disabled, true);
    localDownload.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true })); await h.settle();
    assert.equal(exports().length, 0);
    await h.cancelAppConfirmation(); await h.settle();
    assert.equal(localDownload.disabled, false);
    h.failNextCommand("Command stopped by user.", undefined, { commandOutcome: "stopped", status: 409, state });
    h.holdNextCommand(); localDownload.click(); localDownload.click();
    localDownload.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true })); await h.settle();
    assert.equal(exports().length, 1);
    assert.equal(localDownload.disabled, true);
    assert.match(h.document.querySelector("#sendButton")!.textContent!, /Stop/);
    const commandId = h.commandIds.at(-1);
    h.click("#sendButton"); await h.settle();
    assert.deepEqual(h.commandStopIds, [commandId]);
    h.releaseHeldCommand(); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, "Command stopped.");
    assert.equal(localDownload.disabled, false);
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.disabled, false);
    assert.equal(downloadCommands(h).length, 0);
    assert.deepEqual(h.windowOpenAttempts, []);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("wire decoder accepts successful partial Suno output subsets and rejects malformed identities or provider locators", async () => {
  const state = previewState();
  const h = await createDialogHarness(state);
  try {
    await refresh(h, { ...state, audioJobs: [{ ...state.audioJobs![0]!, status: "partial", remoteOutputs: [remotes[1]!] }] });
    assert.equal(h.document.querySelectorAll("[data-remote-audio-key]").length, 1);
    assert.equal(h.document.querySelector<HTMLElement>("[data-remote-audio-key]")!.dataset.remoteAudioRole, "music_alternative");
    h.holdNextSend(); h.input("#prompt", "Inspect the current track"); h.click("#sendButton"); await h.settle();
    const invalid: unknown[] = [
      null, {}, [null], [{ ...remotes[0], key: "not-a-uuid" }], [{ ...remotes[1], key: remotes[1]!.key.toUpperCase() }],
      [{ ...remotes[0], key: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }],
      ...["https://suno.com/embed/", "/api/forbidden/", "https://cdn1.suno.ai/"].map((prefix) => [{ ...remotes[0], key: prefix + remotes[0]!.key }]),
      [{ ...remotes[0], role: "sound_effect" }], [{ ...remotes[0], role: "vocals" }],
      [{ key: remotes[0]!.key }], [{ role: "music" }], [{ ...remotes[0], url: "https://suno.com/api/forbidden/fixture" }],
      [remotes[0], { ...remotes[1], key: remotes[0]!.key }], [remotes[0], { ...remotes[1], role: "music" }],
      [...remotes, { key: "22222222-2222-4222-8222-222222222222", role: "music" }],
    ];
    const validJob = state.audioJobs![0]!;
    const invalidJobs: unknown[] = [
      ...invalid.map((remoteOutputs) => ({ ...validJob, remoteOutputs })),
      { ...validJob, remoteOutputs: [] }, { ...validJob, remoteOutputs: undefined },
      { ...validJob, remoteOutputs: [], provider: "elevenlabs", serviceId: musicService.id },
      { ...validJob, status: "completed", provider: "elevenlabs", serviceId: musicService.id },
      { ...validJob, operation: "get_whole_song" },
      { ...validJob, operation: "get_whole_song", remoteOutputs: [remotes[1]] },
      { ...validJob, status: "online" },
    ];
    for (const invalidJob of invalidJobs) {
      h.emitServerEvent({ type: "done", sendId: h.sendIds[0], sessionId: state.activeSessionId, state: { ...state, audioJobs: [invalidJob] } });
      await h.settle();
      assert.match(h.document.querySelector("#sendButton")!.textContent!, /Stop/, JSON.stringify(invalidJob));
      assert.equal(h.document.querySelectorAll("[data-remote-audio-key]").length, 1);
      assert.equal(frame(h), null);
    }
    h.setServerState(state); h.releaseHeldSend(); await h.settle();
    assert.match(h.document.querySelector("#sendButton")!.textContent!, /Send/);
    assert.equal(h.document.querySelectorAll("[data-remote-audio-key]").length, 2);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
