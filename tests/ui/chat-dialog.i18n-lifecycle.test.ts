import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "./support/chat-dialog.test-harness.js";

function languageEvent(state: ReturnType<typeof stateFixture>, language = "zh-CN", revision = "1") {
  return {
    type: "global_settings_changed",
    defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
    showContextUsage: state.settings.showContextUsage,
    contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
    networkProxy: state.settings.networkProxy,
    networkProxyRevision: state.settings.networkProxyRevision,
    uiLanguage: language,
    uiLanguageRevision: revision,
    commandId: "peer-language",
  };
}

test("a Send terminal catches up a missed language event after progress without entering Stop recovery", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Read the set"); h.click("#sendButton"); await h.settle();
    h.emitServerEvent({ type: "progress", sendId: h.sendIds[0], sessionId: state.activeSessionId, message: "Reading Live state…" });
    const terminal = stateFixture();
    terminal.settings.uiLanguage = "zh-CN"; terminal.settings.uiLanguageRevision = "1";
    h.setServerState(terminal); h.releaseHeldSend(); await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");
    assert.equal(h.document.querySelector<HTMLSelectElement>("#uiLanguage")!.value, "zh-CN");
    assert.equal(h.document.querySelector<HTMLElement>("#sendButton")!.dataset.action, "send");
    assert.doesNotMatch(h.document.querySelector("#status")!.textContent!, /stack size|Retry Stop/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("language shares the settings command lock and unlocks after a peer change and failed save", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  let held = false;
  try {
    h.click("#appTab"); h.holdNextCommand(); held = true; h.failNextCommand("Could not save context visibility.");
    h.click("#showContextUsage"); await h.settle();
    const control = h.document.querySelector<HTMLSelectElement>("#uiLanguage")!;
    assert.equal(control.disabled, true);
    h.emitServerEvent(languageEvent(state)); await h.settle();
    assert.equal(control.disabled, true);
    h.releaseHeldCommand(); held = false; await h.settle();
    assert.equal(control.disabled, false);
    assert.equal(h.document.querySelector<HTMLInputElement>("#showContextUsage")!.disabled, false);
    assert.equal(h.document.documentElement.lang, "zh-CN");
    assert.equal(h.document.querySelector("#status")!.textContent, "Could not save context visibility.");
    h.select("#uiLanguage", "en"); await h.settle();
    assert.equal(h.document.documentElement.lang, "en");
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("a background Send can refresh language without replacing the visible Session or draft", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Read Bass"); h.click("#sendButton"); await h.settle();
    h.emitServerEvent({ type: "progress", sendId: h.sendIds[0], sessionId: state.activeSessionId, message: "Reading Bass" });
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    h.input("#prompt", "Unsent Lead draft");
    const terminal = stateFixture();
    terminal.settings.uiLanguage = "zh-CN"; terminal.settings.uiLanguageRevision = "1";
    h.setServerState(terminal); h.releaseHeldSend(); await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");
    assert.equal(h.document.querySelector('[data-session-id="session-2"] .session-row')!.getAttribute("aria-pressed"), "true");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Unsent Lead draft");
    assert.equal(h.document.querySelector<HTMLElement>("#sendButton")!.dataset.action, "send");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("language save retains an unknown-commit warning after applying the returned state", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.click("#appTab");
    const committed = stateFixture();
    committed.settings.uiLanguage = "zh-CN"; committed.settings.uiLanguageRevision = "1";
    h.failNextCommand("Global settings storage could not be confirmed.", undefined, { commandOutcome: "unknown", state: committed });
    h.select("#uiLanguage", "zh-CN"); await h.settle();
    assert.equal(h.document.documentElement.lang, "zh-CN");
    assert.equal(h.document.querySelector("#status")!.textContent, "Global settings storage could not be confirmed.");
    assert.equal(h.document.querySelector("#status")!.classList.contains("error"), true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("peer language changes translate local running status and preserve provider progress verbatim", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  try {
    h.holdNextSend(); h.input("#prompt", "Read the set"); h.click("#sendButton"); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, "Starting Live Smith…");
    h.emitServerEvent(languageEvent(state)); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, "正在启动 Live Smith…");
    h.emitServerEvent({ type: "progress", sendId: h.sendIds[0], sessionId: state.activeSessionId, message: "Provider raw progress: Delete / Agent" });
    h.emitServerEvent(languageEvent(state, "en", "2")); await h.settle();
    assert.equal(h.document.querySelector("#status")!.textContent, "Provider raw progress: Delete / Agent");
    assert.equal(h.document.querySelector<HTMLElement>("#sendButton")!.dataset.action, "stop");
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});

test("translated command buttons restore their current idle language after success or failure", async () => {
  const state = stateFixture(); state.settings.uiLanguage = "zh-CN";
  const h = await createDialogHarness(state);
  let held = false;
  try {
    h.input("#profileName", "Studio edited"); h.click("#saveProfileButton"); await h.settle();
    assert.equal(h.document.querySelector("#saveProfileButton")!.textContent, "保存并使用");
    h.holdNextCommand(); held = true; h.failNextCommand("Catalog unavailable."); h.click("#discoverModelsButton"); await h.settle();
    h.emitServerEvent(languageEvent(state, "en")); await h.settle();
    h.releaseHeldCommand(); held = false; await h.settle();
    assert.equal(h.document.querySelector("#discoverModelsButton")!.textContent, "Load Models");
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});
