import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { audioParameterGroups } from "../../../src/plugins/builtins/parameter-panel.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { audioState, job } from "../support/chat-dialog.audio-test-helpers.js";
import { createDialogHarness, pendingAudio, stateFixture, waitForCondition, type DialogHarness } from "../support/chat-dialog.test-harness.js";
import { installNativeDragBridge, nativeBridge, replyNativeDrag, type NativeDragMessage } from "../support/native-drag.test-harness.js";

async function switchLanguage(harness: DialogHarness, state: ReturnType<typeof stateFixture>, language: "en" | "zh-CN", revision: string) {
  harness.emitServerEvent({
    type: "global_settings_changed",
    defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
    showContextUsage: state.settings.showContextUsage,
    contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
    uiLanguage: language,
    uiLanguageRevision: revision,
    commandId: "peer-language-" + revision,
  });
  await harness.settle();
  assert.equal(harness.document.documentElement.lang, language);
}

test("native drag translates idle, preparing and retry labels without losing the drag state", async () => {
  const state = audioState();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  state.audioJobs = [job(state.activeSessionId)];
  const messages: NativeDragMessage[] = [];
  const h = await createDialogHarness(state, nativeBridge, { beforeParse: window => installNativeDragBridge(window, messages) });
  try {
    h.click("#sessionAudioResults > summary");
    const button = h.document.querySelector<HTMLButtonElement>("[data-drag-local-audio]")!;
    await switchLanguage(h, state, "zh-CN", "1");
    assert.equal(button.textContent, "拖出音频");
    assert.equal(button.title, "将此文件拖到 DAW 轨道或文件夹。");

    button.focus();
    const prepare = messages.at(-1)!;
    assert.equal(prepare.type, "prepare");
    await switchLanguage(h, state, "en", "2");
    assert.equal(button.textContent, "Preparing file…");
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(h.document.activeElement, button);

    replyNativeDrag(h.window, { type: "prepare_failed", id: prepare.id });
    await h.settle();
    await switchLanguage(h, state, "zh-CN", "3");
    assert.equal(button.firstChild?.textContent, "重试准备文件");
    assert.equal(button.querySelector(".field-hint")?.textContent, "也可以使用导出。");
    assert.equal(button.hasAttribute("title"), false);
    assert.equal(button.hasAttribute("aria-busy"), false);

    button.click();
    const retry = messages.at(-1)!;
    assert.equal(retry.type, "prepare");
    assert.notEqual(retry.id, prepare.id);
    replyNativeDrag(h.window, { type: "prepared", id: retry.id, token: "prepared-file" });
    await h.settle();
    assert.equal(button.textContent, "拖出音频");
    assert.equal(button.title, "将此文件拖到 DAW 轨道或文件夹。");
    assert.equal(button.hasAttribute("aria-busy"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("an open audio tool refreshes localized controls in place and preserves the edited draft", async () => {
  const connection = { id: "suno-studio", name: "Suno Studio", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
  const state = audioState([connection]);
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  const groups = audioParameterGroups({
    services: [{ ...connection, pluginId: "live-smith.suno-website" }],
    hasJobs: false,
    identity: () => "account-owner",
  }).map(group => ({ ...group, tools: group.tools.map(tool => ({ ...tool, description: tool.description.slice(0, 512) })) }));
  state.sessionToolCatalog = {
    sessionId: state.activeSessionId, loadedAt: "2026-09-30T00:00:00.000Z",
    modelToolsSupported: false, truncated: false, groups, issues: [],
  };
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope");
    h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const entry = '[data-tool-key$=":builtin_suno_generate_music"]';
    h.click(entry + " > summary");
    h.click(entry + " .audio-open-panel");

    const dialog = h.document.querySelector(".audio-parameter-dialog")!;
    const mode = dialog.querySelector<HTMLSelectElement>("select")!;
    h.select(".audio-parameter-dialog select", "1");
    const draft = dialog.querySelector<HTMLTextAreaElement>('[name=".variant.prompt"]')!;
    h.input('[name=".variant.prompt"]', "A line of lyrics");
    h.click('[aria-label="Include Weirdness (%)"]');
    const weirdnessSelector = '[name=".variant.options.weirdness"]';
    const weirdness = dialog.querySelector<HTMLInputElement>(weirdnessSelector)!;
    h.input(weirdnessSelector, "101");
    h.click('.audio-parameter-dialog button[type="submit"]');
    assert.equal(weirdness.validationMessage, "Check the value for Weirdness (%).");
    draft.focus();
    draft.setSelectionRange(2, 6);
    await switchLanguage(h, state, "zh-CN", "1");

    assert.equal(dialog.querySelector("h3")!.textContent, "生成音乐");
    assert.equal(dialog.querySelector('button[type="submit"]')!.textContent, "运行工具");
    assert.equal(mode.getAttribute("aria-label"), "参数");
    assert.equal(dialog.querySelector(".audio-parameter-connection")!.textContent, "Suno Studio");
    assert.equal(weirdness.validationMessage, "请检查 创意程度（%） 的值。");
    assert.equal(weirdness.value, "101");
    assert.equal(h.document.activeElement, draft);
    assert.equal(draft.value, "A line of lyrics");
    assert.deepEqual([draft.selectionStart, draft.selectionEnd, mode.value], [2, 6, "1"]);
    await switchLanguage(h, state, "en", "2");
    assert.equal(dialog.querySelector("h3")!.textContent, "Generate music");
    assert.equal(h.document.activeElement, draft);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the audio selection dialog updates localized labels while playback and the selected range continue", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  state.pendingAttachments = [pendingAudio("draft-audio", "Draft.wav")];
  const h = await createDialogHarness(state);
  const fetchOriginal = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: (input: string | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/attachments/draft-audio") {
      return Promise.resolve(new Response(new Uint8Array(waveBytes(1)), { headers: { "Content-Type": "audio/wav" } }));
    }
    return fetchOriginal(input, init);
  } });
  try {
    h.click('#pendingAttachments [data-media-kind="audio"] .attachment-chip-label');
    const dialog = h.document.querySelector(".attachment-audio-editor")!;
    const start = dialog.querySelector<HTMLInputElement>(".attachment-selection-start")!;
    const end = dialog.querySelector<HTMLInputElement>(".attachment-selection-end")!;
    const media = dialog.querySelector<HTMLAudioElement>(".attachment-selection-audio")!;
    const loop = dialog.querySelector<HTMLInputElement>(".attachment-selection-loop")!;
    await waitForCondition(() => !start.disabled, "Expected the waveform and selection to be ready");
    h.input(".attachment-selection-start", "0.25");
    h.input(".attachment-selection-end", "0.75");
    loop.click();
    start.focus();
    let playing = true;
    Object.defineProperty(media, "paused", { configurable: true, get: () => !playing });
    Object.defineProperty(media, "pause", { configurable: true, value: () => { playing = false; } });
    media.currentTime = 0.5;
    media.dispatchEvent(new h.window.Event("play"));
    await switchLanguage(h, state, "zh-CN", "1");

    assert.equal(dialog.getAttribute("aria-label"), "音频预览：Draft.wav");
    assert.equal(dialog.querySelector(".attachment-viewer-close")!.getAttribute("aria-label"), "关闭预览");
    assert.equal(dialog.querySelector(".attachment-use-whole")!.textContent, "使用完整文件");
    assert.match(dialog.querySelector(".attachment-viewer-status")!.textContent!, /选区.*0\.500/);
    assert.equal(dialog.querySelector(".attachment-selection-loop-label input"), loop);
    assert.equal(h.document.activeElement, start);
    assert.deepEqual([start.value, end.value, loop.checked, media.paused, media.currentTime], ["0.25", "0.75", false, false, 0.5]);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
