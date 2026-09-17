import assert from "node:assert/strict";
import test from "node:test";
import { uiMessage } from "../i18n/ui-message.js";
import { audioState, broadcast, job } from "./chat-dialog.audio-test-helpers.js";
import { createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";
import { audioProcessingTools } from "../agent/audio-tools.js";
import { AUDIO_SERVICE_CAPABILITIES } from "../audio-services/capabilities.js";
import type { AudioProvider } from "../audio-services/contracts.js";
import { uiCatalogs } from "./i18n/messages.js";

test("serializable audio progress translates on locale changes and structural replay", async () => {
  const state = audioState(); state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Separate audio"); h.click("#sendButton"); await h.settle();
    const message = uiMessage("Separating stems ({progress}%)", { progress: 42 });
    h.emitServerEvent({ type: "progress", sendId: h.sendIds[0], sessionId: state.activeSessionId, message,
      activity: { status: "running", message: JSON.parse(JSON.stringify(message)) } });
    assert.equal(h.document.querySelector("#status")!.textContent, "正在分离音轨（42%）");
    h.emitServerEvent({ ...broadcast(state, state.audioServices), uiLanguage: "en", uiLanguageRevision: "1" }); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, "Separating stems (42%)");
    h.emitServerEvent({ type: "progress", sendId: h.sendIds[0], sessionId: state.activeSessionId,
      message: { source: "Separating stems", values: { invalid: { html: "<img>" } } } });
    assert.equal(h.document.querySelector("#status")!.textContent, "Separating stems (42%)");
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});

test("audio command progress and terminal notices retain locale identity", async () => {
  const state = audioState(); state.settings.uiLanguage = "zh-CN";
  state.audioJobs = [job(state.activeSessionId)];
  const notice = uiMessage("Audio is downloaded to Live Smith. Importing into Live is a separate scoped operation.");
  const h = await createDialogHarness(state);
  let held = false;
  try {
    h.holdNextCommand(); held = true; h.click("[data-resume-audio-job]"); await h.settle();
    h.emitServerEvent({ type: "command_progress", commandId: h.commandIds[0], message: uiMessage("Downloading the selected Suno song") });
    assert.equal(h.document.querySelector("#status")!.textContent, "正在下载所选 Suno 歌曲");
    h.setServerState({ ...state, status: notice }); h.releaseHeldCommand(); held = false; await h.settle();
    assert.match(h.document.querySelector("#status")!.textContent!, /已下载到 Live Smith/);
    h.emitServerEvent({ ...broadcast(state, state.audioServices), uiLanguage: "en", uiLanguageRevision: "1" }); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, notice.source);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("nested stem labels translate without interpreting diagnostic parameters", async () => {
  const state = audioState(); state.settings.uiLanguage = "zh-CN";
  state.status = uiMessage("Downloading stem: {stem}", { stem: uiMessage("Electric guitar") });
  state.audioJobs = [job(state.activeSessionId, { message: "Provider diagnostic: Electric guitar <b>original</b>" })];
  const h = await createDialogHarness(state);
  try {
    assert.equal(h.document.querySelector("#status")!.textContent, "正在下载音轨：电吉他");
    assert.equal(h.document.querySelector(".audio-job-details p")!.textContent, "Provider diagnostic: Electric guitar <b>original</b>");
    assert.equal(h.document.querySelector("#audioJobs b"), null);
  } finally { h.close(); }
});

test("every registered audio tool has a translated title in the real activity DOM", async () => {
  const services = Object.keys(AUDIO_SERVICE_CAPABILITIES).map(provider => ({ id: "test-" + provider, name: provider, provider: provider as AudioProvider }));
  for (const tool of audioProcessingTools(services, true)) {
    const state = stateFixture(); state.settings.uiLanguage = "zh-CN";
    const name = tool.function.name;
    const source = name.split("_").join(" ").replace(/^./, first => first.toUpperCase());
    const translated = uiCatalogs["zh-CN"][source];
    assert.ok(translated, name);
    state.events = [{ id: "event-audio-call", name, kind: "tool_call", content: "{}", createdAt: "2026-09-15T13:00:00.000Z" },
      { id: "event-audio-result", name, kind: "tool_result", content: "{}", createdAt: "2026-09-15T13:00:01.000Z" }];
    const h = await createDialogHarness(state);
    try {
      assert.ok(h.document.querySelector(".timeline-activity-group")!.textContent!.includes(translated), name);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  }
});
