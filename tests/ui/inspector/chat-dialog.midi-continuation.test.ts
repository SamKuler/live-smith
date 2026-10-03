import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { pluginParameterPanel, type PluginParameterPanel } from "../../../src/plugins/parameter-panel.js";
import type { MidiContinuationView } from "../../../src/agent/midi-continuation-contracts.js";
import { isWireMidiContinuation } from "../../../src/ui/client/wire-contracts/midi-continuation.js";
import { cloneState, commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

function viewFixture(sessionId: string, count?: number): MidiContinuationView {
  const panel = pluginParameterPanel("mcp_midi_generator", { type: "object", properties: {
    source_midi: { type: "string" }, section_length: { type: "number" },
    style: { type: "string", title: "Style", default: "Legato" },
    density: { type: "number", title: "Density", minimum: 0, maximum: 1, default: .5 },
  }, required: ["source_midi", "section_length", "style"], additionalProperties: false }, {})!;
  const view: MidiContinuationView = { sessionId, stale: false, clipsTruncated: false,
    clips: [{ trackId: "2", clipId: "20", trackName: "Piano", clipName: "Theme", location: "arrangement", startBeat: 8, durationBeats: 8, noteCount: 12 },
      { trackId: "3", clipId: "30", trackName: "Bass", clipName: "Bass line", location: "arrangement", startBeat: 8, durationBeats: 8, noteCount: 8 }],
    generators: [{ toolName: panel.toolName, label: "MIDI variations", signature: panel.signature, inputArgument: "source_midi", lengthArgument: "section_length", panel }] };
  if (count !== undefined) view.buffer = { id: "buffer-one", sessionId, sourceArtifactRef: "source-midi", sourceFingerprint: "a".repeat(64),
    sourceClips: [{ trackId: "2", clipId: "20" }, { trackId: "3", clipId: "30" }], segmentBeats: 8, capacity: 2,
    insertBeat: 16, nextSequence: count, consumedCount: 0, ...(count ? { lastArtifactRef: `future-${count}` } : {}),
    queue: Array.from({ length: count }, (_, index) => ({ artifactRef: `future-${index + 1}`, sequence: index, label: `Continuation ${index + 1}`, noteCount: 8 })),
    generator: { kind: "model", profileId: "profile-1", model: "model", configurationFingerprint: "b".repeat(64) }, prompt: "Keep the rhythm", updatedAt: "2026-10-03T00:00:00Z" };
  return view;
}

async function setup(input: { initialCount?: number; loaded?: boolean; plugin?: boolean; deferPreview?: boolean } = {}) {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  let view = viewFixture(state.activeSessionId, input.initialCount);
  if (input.plugin && view.buffer) { const choice = view.generators[0]!; view.buffer.generator = { kind: "plugin", toolName: choice.toolName, signature: choice.signature,
    inputArgument: choice.inputArgument, lengthArgument: choice.lengthArgument, arguments: { style: "Saved style", density: .25 } }; view.buffer.prompt = ""; }
  if (input.loaded !== false) state.midiContinuation = cloneState(view);
  let consume = true; let fillTo: number | undefined; let previews = 0; let releases!: () => void;
  const gate = new Promise<void>((resolve) => { releases = resolve; });
  const h = await createDialogHarness(state);
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/midi-import-preview") {
      previews++; if (input.deferPreview) await gate;
      return { ok: true, json: async () => ({ sessionId: body.sessionId, artifactRef: body.artifactRef, label: "Continuation",
        durationBeats: 8, parts: [{ id: "track-0-channel-1", sourceTrackIndex: 0, sourceTrackName: "Piano", channel: 1, noteCount: 8, durationBeats: 8 }],
        timing: { tempoEventCount: 0, timeSignatureEventCount: 0 }, targets: [{ trackId: "2", trackName: "Piano" }], unavailableTargetCount: 0, maxActions: 64 }) };
    }
    if (path === "/command" && String(body.kind).endsWith("midi_continuation")) {
      if (body.kind === "configure_midi_continuation") {
        const base = viewFixture(body.sessionId, 0).buffer!;
        const plugin = view.generators.find((choice) => choice.toolName === body.generator.toolName);
        view.buffer = { ...base, id: "buffer-configured", sourceClips: body.sourceClips, segmentBeats: body.segmentBeats, capacity: body.capacity,
          prompt: body.prompt, generator: body.generator.kind === "model" ? base.generator : { ...body.generator, inputArgument: plugin!.inputArgument, lengthArgument: plugin!.lengthArgument } };
        view.stale = false; delete view.staleReason;
      }
      if (body.kind === "fill_midi_continuation" && view.buffer) {
        const buffer = view.buffer;
        buffer.queue = Array.from({ length: fillTo ?? buffer.capacity }, (_, index) => ({ artifactRef: `future-${buffer.consumedCount + index + 1}`,
          sequence: buffer.consumedCount + index, label: `Continuation ${buffer.consumedCount + index + 1}`, noteCount: 8 }));
        buffer.nextSequence = buffer.consumedCount + buffer.queue.length;
        buffer.lastArtifactRef = buffer.queue.at(-1)!.artifactRef;
      }
      if (body.kind === "import_midi_continuation" && consume && view.buffer) {
        const head = view.buffer.queue.shift()!; view.buffer.consumedCount++;
        view.buffer.insertBeat = body.startBeat - head.sequence * view.buffer.segmentBeats;
      }
      const current = { ...cloneState(h.readBootstrappedClientStateReference()), midiContinuation: cloneState(view) }; h.setServerState(current);
    }
    if (path === "/command" && body.kind === "select_session") {
      const current = { ...cloneState(h.readBootstrappedClientStateReference()) }; delete current.midiContinuation; h.setServerState(current);
    }
    return originalFetch(url, init);
  } });
  h.click("#sessionInspectorScope"); h.click("#toolsTab"); await h.settle();
  return { h, state, get view() { return view; }, setView(value: MidiContinuationView) { view = value; },
    setConsume(value: boolean) { consume = value; }, setFillTo(value: number) { fillTo = value; },
    releasePreview: releases, get previews() { return previews; } };
}
function button(h: Awaited<ReturnType<typeof setup>>["h"], text: string) {
  const node = [...h.document.querySelectorAll<HTMLButtonElement>("#midiContinuationSection button")].find((entry) => entry.textContent === text);
  assert.ok(node, text); return node;
}
const midiCommands = (h: Awaited<ReturnType<typeof setup>>["h"]) => commandCalls(h).filter((call) => String((call.body as { kind: string }).kind).endsWith("midi_continuation"));
async function settleCommand(h: Awaited<ReturnType<typeof setup>>["h"]) {
  await h.settle(); await waitForCondition(() => h.document.querySelector("#midiContinuationSection")!.getAttribute("aria-busy") === "false", "Expected settled continuation operation");
}

test("source selection and bounded setup save without generation; Fill uses the saved buffer", async () => {
  const s = await setup({ loaded: false }); const { h } = s;
  try {
    assert.deepEqual(h.errors, []); assert.equal(h.document.querySelector<HTMLElement>(".midi-continuation-setup")!.hidden, true);
    h.click("#loadMidiContinuationButton"); await settleCommand(h);
    h.click('[aria-label="Piano · Theme"]'); h.click('[aria-label="Bass · Bass line"]');
    h.input(".midi-continuation-capacity", "5"); assert.equal(button(h, "Save continuation setup").disabled, true);
    h.input(".midi-continuation-capacity", "2"); h.input(".midi-continuation-length", "8"); h.input(".midi-continuation-prompt", "Continue the motif");
    button(h, "Save continuation setup").click(); await settleCommand(h);
    assert.deepEqual(midiCommands(h)[1]!.body, { kind: "configure_midi_continuation", sessionId: s.state.activeSessionId, expectedBufferId: null,
      sourceClips: [{ trackId: "2", clipId: "20" }, { trackId: "3", clipId: "30" }], segmentBeats: 8, capacity: 2, prompt: "Continue the motif", generator: { kind: "model" } });
    assert.equal(midiCommands(h).length, 2); assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 0);
    assert.equal(button(h, "Save continuation setup").disabled, true, "an unchanged setup must not reset the existing buffer");
    button(h, "Fill buffer").click(); await settleCommand(h);
    assert.deepEqual(midiCommands(h)[2]!.body, { kind: "fill_midi_continuation", sessionId: s.state.activeSessionId, bufferId: "buffer-configured" });
    assert.match(h.document.querySelector(".midi-continuation-queue")!.textContent!, /Section 1.*Section 2/s);
    assert.equal(button(h, "Fill buffer").disabled, true); assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Plugin schema fields edit saved parameters without exposing conditioning fields or invoking a tool", async () => {
  const s = await setup({ initialCount: 0, plugin: true }); const { h } = s;
  try {
    const parameterForm = h.document.querySelector<HTMLFormElement>(".midi-continuation-parameters form")!;
    const styleLabel = [...parameterForm.querySelectorAll<HTMLLabelElement>("label")].find((entry) => entry.textContent === "Style")!;
    const style = h.document.getElementById(styleLabel.htmlFor) as HTMLTextAreaElement;
    assert.equal(style.value, "Saved style"); assert.doesNotMatch(parameterForm.textContent!, /source_midi|section_length|Run tool/);
    h.input("#" + style.id, "Staccato");
    parameterForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await settleCommand(h);
    assert.deepEqual(midiCommands(h)[0]!.body, { kind: "configure_midi_continuation", sessionId: s.state.activeSessionId, expectedBufferId: "buffer-one",
      sourceClips: [{ trackId: "2", clipId: "20" }, { trackId: "3", clipId: "30" }], segmentBeats: 8, capacity: 2, prompt: "",
      generator: { kind: "plugin", toolName: s.view.generators[0]!.toolName, signature: s.view.generators[0]!.signature, arguments: { style: "Staccato", density: .25 } } });
    assert.equal(commandCalls(h).some((call) => (call.body as { kind: string }).kind === "run_plugin_tool"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("preview and cancelled import retain the head; only a new server queue advances the next section", async () => {
  const s = await setup({ initialCount: 2 }); const { h } = s;
  try {
    h.click(".midi-continuation-section > summary");
    button(h, "Preview saved MIDI").click(); await h.settle();
    assert.equal(s.previews, 1); assert.equal(midiCommands(h).length, 0);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 2);
    s.setConsume(false);
    h.click(".midi-continuation-import .plugin-result-import"); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>(".midi-import-dialog .plugin-result-beat")!.value, "17");
    h.select(".midi-import-dialog .plugin-result-track", "2");
    h.click(".midi-import-dialog .plugin-result-apply"); await settleCommand(h);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 2);
    assert.deepEqual(midiCommands(h)[0]!.body, { kind: "import_midi_continuation", sessionId: s.state.activeSessionId, artifactRef: "future-1",
      startBeat: 16, mappings: [{ partId: "track-0-channel-1", trackId: "2", trackName: "Piano" }], bufferId: "buffer-one" });
    s.setConsume(true); h.click(".midi-continuation-import .plugin-result-import"); await h.settle();
    h.select(".midi-import-dialog .plugin-result-track", "2"); h.input(".midi-import-dialog .plugin-result-beat", "25");
    h.click(".midi-import-dialog .plugin-result-apply"); await settleCommand(h);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 1);
    assert.match(h.document.querySelector(".midi-continuation-queue")!.textContent!, /Section 2.*beats 33–41/s);
    h.click(".midi-continuation-import .plugin-result-import"); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>(".midi-import-dialog .plugin-result-beat")!.value, "33");
    assert.equal(button(h, "Fill buffer").disabled, false);
    assert.equal(midiCommands(h).some((call) => (call.body as { kind: string }).kind === "fill_midi_continuation"), false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Stop uses the active command and partial saved sections remain previewable", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s; let held = false;
  try {
    s.setFillTo(1); h.holdNextCommand(); held = true; button(h, "Fill buffer").click();
    await waitForCondition(() => midiCommands(h).length === 1, "Expected Fill command");
    assert.equal(button(h, "Save continuation setup").disabled, true); assert.equal(h.document.querySelector<HTMLButtonElement>("#loadMidiContinuationButton")!.disabled, true);
    h.click(".midi-continuation-section > summary");
    button(h, "Preview saved MIDI").click(); await h.settle(); assert.equal(s.previews, 1);
    button(h, "Stop").click(); await h.settle(); assert.equal(h.commandStopIds.length, 1);
    h.releaseHeldCommand(); held = false; await settleCommand(h);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 1);
    assert.match(h.document.querySelector(".midi-continuation-buffer")!.textContent!, /1 of 2/);
    assert.equal(button(h, "Fill buffer").disabled, false); assert.equal(midiCommands(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); h.close(); }
});

test("a retried continuation preview keeps its source parts through language changes", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s;
  const originalFetch = h.window.fetch;
  let failPreview = true;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    if (failPreview && new URL(String(url)).pathname === "/midi-import-preview") {
      failPreview = false;
      return { ok: false, json: async () => ({ error: "Temporary preview failure" }) };
    }
    return originalFetch(url, init);
  } });
  try {
    h.click(".midi-continuation-section > summary");
    button(h, "Preview saved MIDI").click(); await h.settle();
    const preview = h.document.querySelector<HTMLElement>(".midi-continuation-preview")!;
    assert.match(preview.textContent!, /Temporary preview failure/);
    button(h, "Preview saved MIDI").click(); await h.settle();
    assert.match(preview.textContent!, /Track 1 · Piano · Channel 1 · 8 notes · 8 Beats/);
    const part = preview.firstElementChild;
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "peer-language" });
    await h.settle();
    assert.equal(preview.firstElementChild, part);
    assert.match(preview.textContent!, /Piano/);
    assert.doesNotMatch(preview.textContent!, /Temporary preview failure|Channel|notes|Beats/);
    assert.equal(s.previews, 1);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("failed Fill leaves saved sections intact and requires another explicit action", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s;
  try {
    s.setFillTo(1); h.failNextCommand("Generator is unavailable", undefined, { commandOutcome: "unknown", status: 500,
      state: { ...cloneState(s.state), midiContinuation: cloneState(s.view) } });
    button(h, "Fill buffer").click(); await settleCommand(h);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 1);
    assert.match(h.document.querySelector(".midi-continuation-status")!.textContent!, /stopped or failed/);
    assert.equal(button(h, "Fill buffer").disabled, false); assert.equal(midiCommands(h).length, 1);
    assert.equal(jsonCalls(h, "/send").length, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("stale snapshots block Fill/import, and a Session switch discards delayed previews", async () => {
  const s = await setup({ initialCount: 1, deferPreview: true }); const { h } = s;
  try {
    const stale = cloneState(h.readBootstrappedClientStateReference());
    stale.midiContinuation!.stale = true; stale.midiContinuation!.staleReason = "source_changed";
    h.setServerState(stale); h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.state.activeSessionId }); await h.settle();
    assert.equal(button(h, "Fill buffer").disabled, true); assert.equal(h.document.querySelector<HTMLFieldSetElement>(".midi-continuation-import")!.disabled, true);
    assert.match(h.document.querySelector(".midi-continuation-status")!.textContent!, /Source Clips changed/);
    h.click(".midi-continuation-section > summary");
    button(h, "Preview saved MIDI").click(); await waitForCondition(() => s.previews === 1, "Expected a read-only preview");
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    s.releasePreview(); await h.settle();
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 0);
    assert.equal(h.document.querySelector<HTMLElement>(".midi-continuation-setup")!.hidden, true);
    assert.equal(midiCommands(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { s.releasePreview(); h.close(); }
});

test("continuation wire validation rejects cross-Session buffers and contradictory queue facts", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s;
  try {
    const valid = s.view;
    const admittedPanel = (value: unknown): value is PluginParameterPanel => value === valid.generators[0]!.panel;
    const validate = (value: unknown) => isWireMidiContinuation(value, s.state.activeSessionId, admittedPanel);
    assert.equal(validate(valid), true);
    assert.equal(validate({ ...valid, sessionId: "other" }), false);
    assert.equal(validate({ ...valid, buffer: { ...valid.buffer, sessionId: "other" } }), false);
    assert.equal(validate({ ...valid, buffer: { ...valid.buffer, capacity: 5 } }), false);
    assert.equal(validate({ ...valid, buffer: { ...valid.buffer, nextSequence: 2 } }), false);
    assert.equal(validate({ ...valid, generators: [{ ...valid.generators[0], signature: "changed" }] }), false);
    assert.equal(validate({ ...valid, clips: [valid.clips[0], valid.clips[0]] }), false);
  } finally { h.close(); }
});

test("a delayed Fill HTTP reply cannot rewind a newer server buffer snapshot", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s; let held = false;
  try {
    h.holdNextCommandResponse(); held = true; button(h, "Fill buffer").click();
    await waitForCondition(() => midiCommands(h).length === 1, "Expected held Fill response");
    const commandId = h.commandIds.at(-1)!;
    const newer = { ...cloneState(h.readBootstrappedClientStateReference()), midiContinuation: cloneState(s.view) };
    newer.midiContinuation.buffer!.queue.shift(); newer.midiContinuation.buffer!.consumedCount = 1;
    h.queueNextStatePublication("500", "499");
    h.emitServerEvent({ type: "state", commandId, state: newer }); await h.settle();
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 1);
    assert.match(h.document.querySelector(".midi-continuation-queue")!.textContent!, /Section 2/);
    h.releaseHeldCommandResponse(); held = false; await settleCommand(h);
    assert.equal(h.document.querySelectorAll(".midi-continuation-section").length, 1);
    assert.match(h.document.querySelector(".midi-continuation-buffer")!.textContent!, /1 imported/);
    assert.match(h.document.querySelector(".midi-continuation-queue")!.textContent!, /Section 2/);
    assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommandResponse(); h.close(); }
});


test("language changes refresh continuation controls while preserving source and parameter drafts", async () => {
  const s = await setup({ initialCount: 1 }); const { h } = s;
  try {
    h.input('.midi-continuation-prompt', 'Keep the English motif');
    h.input('.midi-continuation-length', '12');
    const prompt = h.document.querySelector<HTMLTextAreaElement>('.midi-continuation-prompt')!;
    const source = h.document.querySelector<HTMLInputElement>('.midi-continuation-sources input')!;
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'zh-CN', uiLanguageRevision: '1', commandId: 'peer-language' });
    await h.settle();
    assert.equal(h.document.querySelector('.midi-continuation-setup h3')!.textContent, '源 MIDI Clip');
    assert.equal(button(h, '保存续写设置').disabled, false);
    assert.match(h.document.querySelector('.midi-continuation-queue')!.textContent!, /段落 1/);
    assert.equal(h.document.querySelector('.midi-continuation-prompt'), prompt); assert.equal(prompt.value, 'Keep the English motif');
    assert.equal(h.document.querySelector<HTMLInputElement>('.midi-continuation-length')!.value, '12');
    assert.equal(h.document.querySelector('.midi-continuation-sources input'), source); assert.equal(source.checked, true);
    assert.equal(commandCalls(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("continuation Plugin parameters translate interface controls without touching authored fields or drafts", async () => {
  const s = await setup({ initialCount: 0, plugin: true }); const { h } = s;
  try {
    const form = h.document.querySelector<HTMLFormElement>('.midi-continuation-parameters form')!;
    const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
    h.input('#' + field.id, 'Primary');
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'zh-CN', uiLanguageRevision: '1', commandId: 'peer-language' });
    await h.settle();
    assert.equal(form.querySelector('h4')!.textContent, '参数');
    assert.equal(form.querySelector('button[type="submit"]')!.textContent, '保存续写设置');
    assert.equal(h.document.querySelector('.midi-continuation-parameters textarea'), field);
    assert.equal(field.value, 'Primary');
    assert.equal(form.querySelector(`label[for="${field.id}"]`)!.textContent, 'Style');
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await settleCommand(h);
    assert.equal((commandCalls(h).at(-1)!.body as any).generator.arguments.style, 'Primary');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("bounded MIDI generation progress retains its counters through language changes", async () => {
  const s = await setup({ initialCount: 0 }); const { h } = s; let held = false;
  try {
    h.holdNextCommand(); held = true; button(h, 'Fill buffer').click(); await h.settle();
    h.emitServerEvent({ type: 'command_progress', commandId: h.commandIds[0],
      message: { source: 'Generating MIDI section {section} ({count}/{capacity})', values: { section: '3', count: '2', capacity: '4' } } });
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'zh-CN', uiLanguageRevision: '1', commandId: 'peer-language' });
    await h.settle();
    assert.equal(h.document.querySelector('#status')!.textContent, '正在生成第 3 段 MIDI（2/4）');
    h.releaseHeldCommand(); held = false; await settleCommand(h); assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); h.close(); }
});
