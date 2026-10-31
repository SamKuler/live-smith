import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import type { SessionArtifact, SessionArtifacts } from "../../../src/app/session/session-artifacts.js";
import { captureParameterDevice } from "../../../src/live/device-parameters.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

type Input = { sessionId: string; offset: number; query?: string; kind?: "audio" | "midi" | "device-parameters" };
async function setup(read?: (input: Input) => Promise<SessionArtifacts>) {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = "en";
  const live = deviceParameterFixture(2); const snapshot = await captureParameterDevice(live.context, live.target);
  const saved = { ...snapshot, id: 'parameters-v1', sessionId: state.activeSessionId!, label: 'Warm synth', createdAt: '2026-10-31T00:00:00Z',
    source: { kind: 'captured' as const }, version: { groupId: 'parameters-v1', number: 1 } };
  const parameters: SessionArtifact = { ref: { kind: 'device-parameters', id: saved.id }, label: saved.label, sourceLabel: 'Captured device parameters', createdAt: saved.createdAt,
    version: { ...saved.version, groupLabel: saved.label }, versions: [1, 2].map(number => ({ id: `parameters-v${number}`, label: `Sound ${number}`, number, createdAt: saved.createdAt })),
    primary: { kind: 'device-parameters', id: saved.id }, deviceParameters: { parameterCount: 2, target: saved.target, source: 'captured' },
    history: [{ id: 'application', artifact: { kind: 'device-parameters', id: 'parameters-v2' }, createdAt: saved.createdAt, action: 'parameters', status: 'kept' }] };
  const audio: SessionArtifact = { ref: { kind: 'audio', id: 'audio-a' }, label: 'Texture', sourceLabel: 'Plugin-generated audio', createdAt: saved.createdAt,
    version: { groupId: 'audio-a', number: 1, groupLabel: 'Texture' }, versions: [{ id: 'audio-a', number: 1, label: 'Texture', createdAt: saved.createdAt }],
    audio: { durationSeconds: 1, mediaType: 'audio/wav', sampleRate: 8000, channels: 1 } };
  const midi: SessionArtifact = { ref: { kind: 'midi', id: 'midi-a' }, label: 'Melody', sourceLabel: 'AI-generated MIDI', createdAt: saved.createdAt,
    version: { groupId: 'midi-a', number: 1, groupLabel: 'Melody' }, versions: [{ id: 'midi-a', number: 1, label: 'Melody', createdAt: saved.createdAt }],
    midi: { durationBeats: 4, noteCount: 1, omittedNoteCount: 0, parts: [{ id: 'track-0-channel-1', channel: 1, sourceTrackIndex: 0, noteCount: 1, durationBeats: 4 }],
      notes: [{ partId: 'track-0-channel-1', pitch: 60, startTime: 0, duration: 1 }] } };
  const entries = [parameters, audio, midi]; const reads: { input: Input; signal?: AbortSignal | null }[] = []; const requests: { path: string; body: any }[] = [];
  const h = await createDialogHarness(state); const original = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {}; requests.push({ path, body });
    if (path === '/session-artifacts') {
      reads.push({ input: body, ...(init?.signal === undefined ? {} : { signal: init.signal }) });
      const filtered = body.sessionId === state.activeSessionId ? entries.filter(entry => (!body.kind || entry.ref.kind === body.kind) && (!body.query || entry.label.includes(body.query))) : [];
      const result = read ? await read(body) : { ...body, artifacts: filtered, total: filtered.length, unavailableCount: 0 };
      return { ok: true, json: async () => result };
    }
    if (path === '/device-parameters') return { ok: true, json: async () => ({ sessionId: body.sessionId, devices: [snapshot.target], artifact: saved, current: snapshot }) };
    if (path === '/audio-assets/audio-a') { const bytes = waveBytes(); return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; }
    return original(input, init);
  } });
  const openSummary = async () => { h.click('#artifactsShortcut'); await h.settle(); };
  return { h, state, entries, saved, reads, requests, openSummary };
}

test("composer Artifacts opens a compact metadata summary without any full previews or Live reads", async () => {
  const { h, reads, requests, openSummary } = await setup();
  try {
    await openSummary();
    assert.equal(h.document.getElementById('chatPage')!.hidden, false); assert.equal(h.document.getElementById('artifactsPage')!.hidden, true);
    assert.equal(h.document.getElementById('inspectorPane')!.hidden, false); assert.equal(h.document.getElementById('artifactsTab')!.getAttribute('aria-selected'), 'true');
    const rows = [...h.document.querySelectorAll('.artifact-summary-row')]; assert.equal(rows.length, 3);
    assert.match(rows[0]!.textContent!, /Parameters · v1.*Last application · v2 · kept/);
    assert.equal(h.document.querySelector('#artifactSummary audio, #artifactSummary table, #artifactSummary svg, #artifactSummary select'), null);
    assert.deepEqual(reads.map(read => read.input), [{ sessionId: 'session-1', offset: 0 }]);
    assert.equal(requests.some(request => ['/device-parameters', '/session-artifact', '/midi-artifact-diff', '/midi-artifact-preview'].includes(request.path) || request.path.startsWith('/audio-assets/')), false);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a summary row opens its exact displayed version in the standalone page", async () => {
  const { h, saved, requests, openSummary } = await setup();
  try {
    await openSummary(); h.click(`[data-artifact-ref="${saved.id}"]`); await h.settle();
    assert.equal(h.document.getElementById('artifactsPage')!.hidden, false); assert.equal(h.document.getElementById('inspectorPane')!.hidden, true);
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, saved.id);
    assert.ok(requests.some(request => request.path === '/device-parameters' && request.body.artifactId === saved.id));
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const total of [0, 31]) test(`Open all opens the complete library from a ${total}-work bounded summary`, async () => {
  const s = await setup(); const { h, entries, openSummary } = s;
  if (total === 0) entries.splice(0); else entries.splice(0, entries.length, ...Array.from({ length: 31 }, (_, index) => ({ ...entries[1]!, ref: { kind: 'audio' as const, id: `audio-${index}` },
    version: { groupId: `audio-${index}`, number: 1, groupLabel: `Work ${index}` }, versions: [{ id: `audio-${index}`, number: 1, label: `Work ${index}`, createdAt: entries[1]!.createdAt }] })));
  const original = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/session-artifacts') { const body = JSON.parse(String(init?.body)); return { ok: true, json: async () => ({ ...body, artifacts: entries.slice(body.offset, body.offset + 24), total, unavailableCount: 0 }) }; }
    return original(input, init);
  } });
  try {
    await openSummary(); assert.equal(h.document.querySelectorAll('.artifact-summary-row').length, Math.min(total, 24));
    if (total) assert.match(h.document.getElementById('artifactSummary')!.textContent!, /24 of 31 works/);
    h.click('#openArtifactsButton'); await h.settle();
    assert.equal(h.document.getElementById('artifactsPage')!.hidden, false); assert.equal(h.document.getElementById('inspectorPane')!.hidden, true);
    assert.equal(h.document.querySelectorAll('.artifact-open').length, Math.min(total, 24));
    if (total) assert.ok([...h.document.querySelectorAll<HTMLButtonElement>('#artifactLibrary button')].find(button => button.textContent === 'Next page' && !button.hidden));
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("summary visibility and actual invalidation refresh independently of main-library filters and audio", async () => {
  const { h, reads, openSummary } = await setup();
  try {
    await openSummary(); h.click('#openArtifactsButton'); await h.settle();
    h.click('[data-artifact-kind="audio"]'); await h.settle(); h.input('#artifactSearch', 'Texture');
    await waitForCondition(() => reads.at(-1)?.input.query === 'Texture', 'Expected main search'); await h.settle();
    const audio = h.document.querySelector('.artifact-card audio'); assert.ok(audio);
    h.click('#settingsButton'); await h.settle();
    assert.deepEqual(reads.at(-1)!.input, { sessionId: 'session-1', offset: 0 });
    assert.equal(h.document.querySelector<HTMLInputElement>('#artifactSearch')!.value, 'Texture'); assert.equal(h.document.querySelector('.artifact-card audio'), audio);
    h.click('#contextTab'); const before = reads.length; h.click('#artifactsTab'); await h.settle(); assert.equal(reads.length, before + 1);
    const focusedRow = h.document.querySelector<HTMLButtonElement>('.artifact-summary-row')!; focusedRow.focus();
    h.emitServerEvent({ type: 'session_state_invalidated', sessionId: 'session-1' }); await h.settle();
    assert.equal(h.document.activeElement, focusedRow);
    assert.equal(h.document.querySelector<HTMLInputElement>('#artifactSearch')!.value, 'Texture'); assert.equal(h.document.querySelector('.artifact-card audio'), audio);
    h.click('#openArtifactsButton'); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>('#artifactSearch')!.value, '');
    assert.equal(h.document.querySelector('[data-artifact-kind=""]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(h.document.querySelectorAll('.artifact-open').length, 3); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const reason of ['hide', 'session', 'pagehide'] as const) test(`summary cancels ${reason} reads and ignores their late result`, async () => {
  let release!: (value: SessionArtifacts) => void;
  const held = new Promise<SessionArtifacts>(resolve => { release = resolve; }); let calls = 0;
  const s = await setup(async input => { calls++; return calls === 1 ? held : { ...input, artifacts: [], total: 0, unavailableCount: 0 }; }); const { h, reads, entries } = s;
  try {
    h.click('#artifactsShortcut'); await waitForCondition(() => reads.length === 1, 'Expected summary read');
    if (reason === 'hide') h.click('#settingsButton');
    else if (reason === 'session') { h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle(); }
    else h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide', { persisted: true }));
    assert.equal(reads[0]!.signal!.aborted, true);
    release({ sessionId: 'session-1', offset: 0, artifacts: entries, total: 3, unavailableCount: 0 }); await h.settle();
    assert.equal(h.document.querySelectorAll('.artifact-summary-row').length, 0);
    if (reason === 'hide') { h.click('#settingsButton'); await h.settle(); assert.equal(calls, 2); }
    if (reason === 'pagehide') { h.window.dispatchEvent(new h.window.PageTransitionEvent('pageshow', { persisted: true })); await h.settle(); assert.ok(calls > 1); }
    assert.deepEqual(commandCalls(h).filter(call => (call.body as { kind: string }).kind !== 'select_session'), []); assert.deepEqual(h.errors, []);
  } finally { release({ sessionId: 'session-1', offset: 0, artifacts: [], total: 0, unavailableCount: 0 }); h.close(); }
});

test("hiding the configured Artifacts entry cancels its visible summary and selects a visible Inspector tab", async () => {
  const { h, state, openSummary } = await setup();
  try {
    await openSummary(); h.document.getElementById('openArtifactsButton')!.focus();
    h.emitServerEvent({ type: 'global_settings_changed', commandId: 'hide-artifacts', sessionTabs: ['context', 'brief'], sessionTabsRevision: '1',
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage, contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision }); await h.settle();
    assert.equal(h.document.getElementById('artifactsTab')!.hidden, true); assert.equal(h.document.getElementById('artifactsShortcut')!.hidden, true);
    assert.equal(h.document.getElementById('contextTab')!.getAttribute('aria-selected'), 'true'); assert.equal(h.document.activeElement?.id, 'contextTab');
    assert.equal(h.document.getElementById('artifactsPage')!.hidden, true); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("the Session artifact summary remains read-only and available during generation", async () => {
  const { h, reads, requests, openSummary } = await setup(); let held = false;
  try {
    h.holdNextSend(); held = true; h.input('#prompt', 'Write a variation'); h.click('#sendButton'); await h.settle();
    await openSummary(); assert.equal(reads.length, 1);
    assert.equal(h.document.querySelectorAll('.artifact-summary-row').length, 3);
    assert.ok([...h.document.querySelectorAll<HTMLButtonElement>('.artifact-summary-row')].every(button => !button.disabled));
    assert.equal(requests.some(request => request.path === '/device-parameters' || request.path.startsWith('/audio-assets/')), false);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
    h.releaseHeldSend(); held = false; await h.settle();
  } finally { if (held) { h.releaseHeldSend(); await h.settle(); } h.close(); }
});

for (const delivery of ['incremental', 'terminal'] as const) test(`the open summary refreshes this view's saved artifacts from ${delivery} state`, async () => {
  const { h, entries, reads, requests, openSummary } = await setup(); const audio = entries[1]!; entries.splice(0); let held = false;
  try {
    h.holdNextSend(); held = true; h.input('#prompt', 'Create a texture'); h.click('#sendButton'); await h.settle();
    await openSummary(); assert.equal(reads.length, 1); assert.equal(h.document.querySelectorAll('.artifact-summary-row').length, 0);
    h.emitServerEvent({ type: 'assistant_delta', sendId: h.sendIds[0], sessionId: 'session-1', delta: 'Working' });
    h.emitServerEvent({ type: 'session_event', sendId: h.sendIds[0], sessionId: 'session-1', event: {
      id: 'observation', kind: 'tool_result', name: 'inspect_live_set', outcome: 'success', content: 'Observed', createdAt: audio.createdAt } });
    await h.settle(); assert.equal(reads.length, 1, 'Text tokens and unrelated results do not reload the catalogue');
    entries.push(audio);
    const saved = { type: 'session_event', sendId: h.sendIds[0], sessionId: 'session-1', event: {
      id: 'saved-texture', kind: 'tool_result', name: 'generate_audio', outcome: 'success', content: 'Saved', createdAt: audio.createdAt, artifacts: [audio.ref] } };
    if (delivery === 'incremental') h.emitServerEvent(saved);
    else { h.deferServerEvent(saved); h.releaseHeldSend(); held = false; }
    await h.settle();
    assert.equal(reads.length, 2); assert.equal(h.document.querySelectorAll('.artifact-summary-row').length, 1);
    assert.equal(h.document.querySelector('.artifact-summary-row')?.getAttribute('data-artifact-ref'), audio.ref.id);
    if (delivery === 'incremental') {
      h.emitServerEvent(saved); await h.settle(); assert.equal(reads.length, 2, 'Replayed metadata does not reload the catalogue');
      h.releaseHeldSend(); held = false; await h.settle(); assert.equal(reads.length, 2, 'Matching final state needs no duplicate read');
    }
    assert.equal(h.document.getElementById('artifactsPanel')!.hidden, false);
    assert.equal(requests.some(request => request.path === '/device-parameters' || request.path.startsWith('/audio-assets/')), false);
    assert.deepEqual(h.errors, []);
  } finally { if (held) { h.releaseHeldSend(); await h.settle(); } h.close(); }
});

test("the open summary follows persisted artifact import outcomes without treating approval as success", async () => {
  const { h, entries, reads, openSummary } = await setup(); const audio = entries[1]!; entries.splice(0, entries.length, audio); let held = false;
  try {
    h.holdNextSend(); held = true; h.input('#prompt', 'Import the texture'); h.click('#sendButton'); await h.settle(); await openSummary();
    const publish = (event: Record<string, unknown>) => h.emitServerEvent({ type: 'session_event', sendId: h.sendIds[0], sessionId: 'session-1',
      event: { createdAt: audio.createdAt, content: 'Import operation', ...event } });
    publish({ id: 'unrelated-request', kind: 'apply_requested', applyOperation: { id: 'unrelated', status: 'proposed' } });
    publish({ id: 'unrelated-result', kind: 'apply_result', applyOperation: { id: 'unrelated', status: 'applied' } });
    await h.settle(); assert.equal(reads.length, 1, 'An operation without artifact references does not reload the catalogue');
    audio.history = [{ id: 'import', action: 'import', artifact: audio.ref, createdAt: audio.createdAt, status: 'unknown' }];
    publish({ id: 'import-request', kind: 'apply_requested', applyOperation: { id: 'import', status: 'proposed', artifacts: [audio.ref] } });
    await h.settle(); assert.equal(reads.length, 2); assert.match(h.document.querySelector('.artifact-summary-outcome')!.textContent!, /unknown/);
    publish({ id: 'import-approval', kind: 'apply_auto_approved', applyOperation: { id: 'import', status: 'approved' } });
    await h.settle(); assert.equal(reads.length, 2); assert.match(h.document.querySelector('.artifact-summary-outcome')!.textContent!, /unknown/);
    audio.history[0]!.status = 'partial';
    publish({ id: 'import-result', kind: 'apply_result', applyOperation: { id: 'import', status: 'partial' } });
    await h.settle(); assert.equal(reads.length, 3); assert.match(h.document.querySelector('.artifact-summary-outcome')!.textContent!, /v1 · partial/);
    assert.deepEqual(h.errors, []);
  } finally { if (held) { h.releaseHeldSend(); await h.settle(); } h.close(); }
});

test("persisted failed and cancelled summary outcomes update with the interface language", async () => {
  const { h, state, entries, reads, openSummary } = await setup();
  entries[0]!.history![0]!.status = 'failed';
  entries[1]!.history = [{ id: 'cancelled-import', action: 'import', artifact: entries[1]!.ref, createdAt: entries[1]!.createdAt, status: 'cancelled' }];
  try {
    await openSummary(); const row = h.document.querySelector<HTMLButtonElement>('.artifact-summary-row')!; row.focus();
    h.emitServerEvent({ type: 'global_settings_changed', commandId: 'summary-language', uiLanguage: 'zh-CN', uiLanguageRevision: '1',
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage, contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision }); await h.settle();
    const outcomes = [...h.document.querySelectorAll('.artifact-summary-outcome')].filter(element => !(element as HTMLElement).hidden).map(element => element.textContent);
    assert.deepEqual(outcomes, ['最近应用 · v2 · 已失败', '最近导入 · v1 · 已取消']);
    assert.equal(h.document.querySelector('.artifact-summary-row strong')!.textContent, 'Warm synth');
    assert.equal(h.document.activeElement, row); assert.equal(reads.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
