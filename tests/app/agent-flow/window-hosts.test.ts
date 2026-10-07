import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as flow from "../../../src/app/agent-flow.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { arrangementSelectionInteractionContext } from "../../../src/live/context.js";
import { midiPreviewFixture } from "../../live/support/action-preview.test-harness.js";
import { getOrCreateDefaultSession, projectKeyForContext } from "../../../src/app/context/session-context.js";
import { listSessions } from "../../../src/storage/sessions.js";

function selectionFixture(directory: string) {
  const { track } = midiPreviewFixture();
  const context = {
    application: { song: { handle: { id: 1n }, tracks: [track], scenes: [], tempo: 120 } },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => track,
  };
  const selected = arrangementSelectionInteractionContext(context as never, {
    selected_lanes: [{ id: 10n }], time_selection_start: 32, time_selection_end: 40,
  });
  return { context, selected, changeSet: () => { context.application.song.handle.id = 2n; context.application.song.tracks = []; } };
}

const interaction: LiveInteractionContext = { summary: 'Set', presentation: { origin: 'object', objectKind: 'other', title: 'Set', details: [] }, scope: { kind: 'object', identity: 'song', label: 'Set' }, target: {} };
export function endpoint(url: string, route: string) { const parsed = new URL(url); return `${parsed.origin}${route}?token=${parsed.searchParams.get('token')}`; }

test('agent runtime owns a reachable backend independently of any modal', async () => {
  assert.equal(typeof flow.createAgentRuntime, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'window-hosts-'));
  let shown = false;
  try {
    const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: directory }, ui: { showModalDialog: async () => { shown = true; } } };
    const runtime = await flow.createAgentRuntime(context as never, interaction, { renderHtml: () => '<html></html>' }, 'browser');
    try {
      const first = await (await fetch(endpoint(runtime.url, '/state'))).json();
      assert.equal(shown, false);
      assert.equal((await fetch(runtime.url)).status, 200);
      await runtime.reopen();
      const second = await (await fetch(endpoint(runtime.url, '/state'))).json();
      assert.equal(second.activeSessionId, first.activeSessionId);
      assert.equal(second.sessions.length, 1);
    } finally { await runtime.close(); }
    await assert.rejects(fetch(endpoint(runtime.url, '/state')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser host reuses its invocation Session, isolates different selections, and sanitizes launch failures', async () => {
  const hosts = await import('../../../src/app/window-hosts.js').catch(() => undefined);
  assert.equal(typeof hosts?.createWindowHostController, 'function');
  const { saveGlobalSettings } = await import('../../../src/storage/settings.js');
  const directory = await mkdtemp(join(tmpdir(), 'window-controller-'));
  const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: directory }, ui: { showModalDialog: async () => {} } };
  const opened: string[] = [];
  let fail = false;
  const controller = hosts!.createWindowHostController(context as never, { renderHtml: () => '<html></html>', openBrowser: async (url) => { opened.push(url); if (fail) throw new Error(url); } });
  try {
    await saveGlobalSettings(directory, { interfaceMode: 'browser' });
    await controller.open(interaction);
    const first = await (await fetch(endpoint(opened[0]!, '/state'))).json();
    const { createSession } = await import('../../../src/storage/sessions.js');
    const other = await createSession(directory, { title: "Other Session", projectKey: first.sessions[0].projectKey, scope: { kind: 'track', identity: 'other-track', label: 'Other' } });
    const changed = await (await fetch(endpoint(opened[0]!, '/command'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Smith-Command-Id': 'new-session-in-browser' }, body: JSON.stringify({ kind: 'select_session', sessionId: other.id }) })).json();
    assert.notEqual(changed.activeSessionId, first.activeSessionId);
    await controller.open(interaction);
    assert.equal(opened[1], opened[0]);
    assert.equal((await (await fetch(endpoint(opened[1]!, '/state'))).json()).activeSessionId, first.activeSessionId);
    fail = true;
    await assert.rejects(controller.open({ ...interaction, scope: { kind: 'object', identity: 'other', label: 'Other' } }), error => error instanceof Error && /system browser/.test(error.message) && !/token=/.test(error.message));
    await assert.rejects(fetch(opened.at(-1)!));
  } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a browser runtime rejects send admission after its originating Live Set changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'window-stale-set-'));
  const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: directory } };
  const runtime = await flow.createAgentRuntime(context as never, interaction, { renderHtml: () => '<html></html>' }, 'browser');
  try {
    const state = await (await fetch(endpoint(runtime.url, '/state'))).json();
    context.application.song.handle.id = 2n;
    const response = await fetch(endpoint(runtime.url, '/send'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Smith-Send-Id': 'stale-set-send' }, body: JSON.stringify({ prompt: 'Work', sessionId: state.activeSessionId }) });
    const body = await response.text();
    assert.match(body, /Live Set changed/);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ['modal', 'browser'] as const) {
  test(`${mode} opening rejects an invocation whose Set changes during settings loading`, async () => {
    const { createWindowHostController } = await import('../../../src/app/window-hosts.js');
    const { saveGlobalSettings } = await import('../../../src/storage/settings.js');
    const directory = await mkdtemp(join(tmpdir(), 'window-opening-set-'));
    const fixture = selectionFixture(directory);
    let opened = false;
    const context = { ...fixture.context, ui: { showModalDialog: async () => { opened = true; } } };
    const controller = createWindowHostController(context as never, {
      renderHtml: () => '<html></html>', openBrowser: async () => { opened = true; },
    });
    try {
      await saveGlobalSettings(directory, { interfaceMode: mode });
      const opening = controller.open(fixture.selected);
      fixture.changeSet();
      await assert.rejects(opening, /Live Set changed/);
      assert.equal(opened, false);
      assert.deepEqual(await listSessions(directory), []);
    } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('runtime initialization binds its Set before resolving storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-opening-set-'));
  const fixture = selectionFixture(directory);
  let runtime: flow.AgentRuntime | undefined;
  try {
    const opening = flow.createAgentRuntime(fixture.context as never, fixture.selected, { renderHtml: () => '<html></html>' }, 'browser')
      .then(value => { runtime = value; return value; });
    fixture.changeSet();
    await assert.rejects(opening, /Live Set changed/);
    assert.deepEqual(await listSessions(directory), []);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('runtime initialization retains the originating project and rejects a Set change during Session creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-session-set-'));
  const fixture = selectionFixture(directory);
  const originalProjectKey = projectKeyForContext(fixture.context as never);
  let runtime: flow.AgentRuntime | undefined;
  try {
    const opening = flow.createAgentRuntime(fixture.context as never, fixture.selected, {
      renderHtml: () => '<html></html>',
      getOrCreateDefaultSession: async (...args) => {
        fixture.changeSet();
        return getOrCreateDefaultSession(...args);
      },
    }, 'browser').then(value => { runtime = value; return value; });
    await assert.rejects(opening, /Live Set changed/);
    const sessions = await listSessions(directory);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.projectKey, originalProjectKey);
    assert.notEqual(sessions[0]!.projectKey, projectKeyForContext(fixture.context as never));
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});


test('reopening a busy browser preserves its bounded selection and rejects another invocation without cancelling work', { timeout: 10_000 }, async () => {
  const { createWindowHostController } = await import('../../../src/app/window-hosts.js');
  const { saveGlobalSettings, saveSavedProfile } = await import('../../../src/storage/settings.js');
  const directory = await mkdtemp(join(tmpdir(), 'window-busy-'));
  const context = { application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: directory }, ui: { showModalDialog: async () => {} } };
  const opened: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  let observed = '';
  const selected: LiveInteractionContext = { ...interaction, summary: 'Selection beats 8–16', selectionContext: { identity: '8-16', refresh: () => selected } };
  const controller = createWindowHostController(context as never, {
    renderHtml: () => '<html></html>', openBrowser: async url => { opened.push(url); },
    requestModelTurn: async input => {
      observed = input.liveContext;
      input.signal?.addEventListener('abort', () => { aborted = true; release(); }, { once: true });
      entered(); await gate;
      return { content: 'Completed', toolCalls: [] };
    },
  });
  let send: Promise<Response> | undefined;
  try {
    await saveSavedProfile(directory, { id: 'window-profile', name: 'Provider', connection: { kind: 'direct-api', apiFamily: 'openai', apiMode: 'responses', baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, defaultModel: 'model', models: [{ model: 'model', parameters: { maxOutputTokens: 1024, reasoning: { mode: 'default' } }, advanced: {} }] });
    await saveGlobalSettings(directory, { interfaceMode: 'browser' });
    await controller.open(selected);
    const state = await (await fetch(endpoint(opened[0]!, '/state'))).json();
    send = fetch(endpoint(opened[0]!, '/send'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Smith-Send-Id': 'busy-browser-send' }, body: JSON.stringify({ prompt: 'Work', sessionId: state.activeSessionId }) });
    await started;
    await controller.open(selected);
    assert.equal(opened[1], opened[0]);
    await assert.rejects(controller.open({ ...selected, selectionContext: { ...selected.selectionContext!, identity: '24-32' } }), /finish or Stop/);
    assert.equal(aborted, false);
    assert.equal(observed, selected.summary);
    await saveGlobalSettings(directory, { interfaceMode: 'modal' });
    await controller.open(selected);
    assert.equal(aborted, false);
    const stopped = await fetch(endpoint(opened[0]!, '/stop'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Smith-Send-Id': 'busy-browser-send' }, body: '{}' });
    assert.equal(stopped.status, 200);
    await send;
    assert.equal(aborted, true);
  } finally { release(); await controller.close(); await send; await rm(directory, { recursive: true, force: true }); }
});
