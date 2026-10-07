import assert from 'node:assert/strict';
import test from 'node:test';
import { createDialogHarness, stateFixture, jsonCalls, cloneState } from '../support/chat-dialog.test-harness.js';
const command = { id: 'retained-import', sessionId: 'session-1', stopping: false };
const confirmation = { type: 'command_confirm_request', commandId: command.id, sessionId: command.sessionId, id: 'confirm-import', kind: 'apply', message: 'Import saved MIDI', groups: [{ title: 'MIDI track', rows: ['Create clip'] }], operationId: 'apply-midi' };

for (const outcome of ['approve', 'stop'] as const) test(`a fresh page recovers a pending command and can ${outcome}`, async () => {
  const h = await createDialogHarness(stateFixture());
  try {
    h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
    await h.settle();
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Stop');
    if (outcome === 'approve') {
      h.emitServerEvent(confirmation); await h.settle();
      assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, false);
      await h.acceptAppConfirmation(); await h.settle();
      assert.deepEqual(jsonCalls(h, '/confirm').at(-1)?.body, { id: confirmation.id, apply: true });
    } else {
      h.click('#sendButton'); await h.settle();
      assert.deepEqual(h.commandStopIds, [command.id]);
      h.emitServerEvent(confirmation); await h.settle();
      assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
    }
    h.emitServerEvent({ type: 'command_activity', command: null, bridgeStateRevision: '101' }); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Send');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('command confirmation needs authoritative ownership and stale activity cannot revive a terminal command', async () => {
  const h = await createDialogHarness(stateFixture());
  try {
    h.emitServerEvent(confirmation); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
    h.emitServerEvent({ type: 'command_activity', command: { ...command, stopping: 'no' }, bridgeStateRevision: '90' }); await h.settle();
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Send');
    h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
    h.emitServerEvent({ type: 'command_activity', command: null, bridgeStateRevision: '101' }); await h.settle();
    h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
    h.emitServerEvent(confirmation); await h.settle();
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Send');
    assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test('retained command terminal preserves newer events from a concurrent send', async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.sessionActivities = [{ sessionId: 'session-1', sendId: 'retained-send', status: 'running', message: 'Working', unread: false }];
  const h = await createDialogHarness(state);
  try {
    h.emitRawServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
    const stale = h.deferServerEvent({ type: 'state', commandId: command.id, state: cloneState(state) });
    h.emitRawServerEvent({ type: 'session_event', modelTurnEpoch: 0, sendId: 'retained-send', sessionId: 'session-1', bridgeStateRevision: '101',
      event: { id: 'newer-event', kind: 'user', content: 'Newer concurrently persisted output', createdAt: '2026-10-07T00:00:00.000Z' } });
    await h.settle(); h.flushAnimationFrames();
    assert.match(h.document.querySelector('#timeline')!.textContent!, /Newer concurrently persisted output/);
    h.emitRawServerEvent(stale); await h.settle(); h.flushAnimationFrames();
    assert.match(h.document.querySelector('#timeline')!.textContent!, /Newer concurrently persisted output/);
    assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Stop');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const localOutcome of ['rejected', 'completed'] as const) {
  test(`a peer command keeps its approval after a competing local command ${localOutcome}`, async () => {
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const h = await createDialogHarness(state);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (localOutcome === 'rejected') h.releaseHeldCommand();
      else h.releaseHeldCommandResponse();
    };
    try {
      if (localOutcome === 'rejected') {
        h.holdNextCommand();
        h.failNextCommand('Another Live Smith operation is already in progress.', undefined, { status: 409 });
      } else h.holdNextCommandResponse();
      h.click('#newSessionButton'); await h.settle();
      h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
      h.emitServerEvent(confirmation); await h.settle();
      assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
      release(); await h.settle();
      assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Stop');
      assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, false);
      await h.acceptAppConfirmation(); await h.settle();
      assert.deepEqual(jsonCalls(h, '/confirm').map(call => call.body), [{ id: confirmation.id, apply: true }]);
      assert.equal(jsonCalls(h, '/command').length, 1);
      h.emitServerEvent({ type: 'command_activity', command: null, bridgeStateRevision: '101' }); await h.settle();
      assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Send');
      assert.deepEqual(h.errors, []);
    } finally { release(); h.close(); }
  });
}

for (const update of ['resolved', 'stopping', 'terminal'] as const) {
  test(`a deferred peer command respects ${update} before local ownership ends`, async () => {
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const h = await createDialogHarness(state);
    let released = false;
    try {
      h.holdNextCommand();
      h.failNextCommand('Another Live Smith operation is already in progress.', undefined, { status: 409 });
      h.click('#newSessionButton'); await h.settle();
      h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
      h.emitServerEvent(confirmation);
      if (update === 'terminal') {
        const latest = cloneState(state);
        latest.events = [{ id: 'peer-command-result', kind: 'assistant', content: 'Peer import completed', createdAt: '2026-10-08T00:00:00.000Z' }];
        h.setServerState(latest);
        h.emitServerEvent({ type: 'state', commandId: command.id, state: latest });
      }
      if (update === 'resolved') h.emitServerEvent({ type: 'command_confirm_resolved', commandId: command.id, sessionId: command.sessionId, id: confirmation.id });
      else h.emitServerEvent({ type: 'command_activity', command: update === 'terminal' ? null : { ...command, stopping: true }, bridgeStateRevision: '101' });
      h.emitRawServerEvent({ type: 'command_activity', command, bridgeStateRevision: '99' });
      h.releaseHeldCommand(); released = true; await h.settle();
      assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
      assert.deepEqual(jsonCalls(h, '/confirm'), []);
      if (update === 'terminal') {
        assert.equal(h.document.querySelector('#sendButton')?.textContent, 'Send');
        assert.match(h.document.querySelector('#timeline')!.textContent!, /Peer import completed/);
      }
      else if (update === 'stopping') assert.equal(h.document.querySelector<HTMLButtonElement>('#sendButton')!.disabled, true);
      else {
        h.click('#sendButton'); await h.settle();
        assert.deepEqual(h.commandStopIds, [command.id]);
      }
      assert.deepEqual(h.errors, []);
    } finally { if (!released) h.releaseHeldCommand(); h.close(); }
  });
}

test('a newer deferred command owns only its own confirmation', async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  const newerCommand = { ...command, id: 'newer-import' };
  const newerConfirmation = { ...confirmation, commandId: newerCommand.id, id: 'newer-confirmation' };
  let released = false;
  try {
    h.holdNextCommand();
    h.failNextCommand('Another Live Smith operation is already in progress.', undefined, { status: 409 });
    h.click('#newSessionButton'); await h.settle();
    h.emitServerEvent({ type: 'command_activity', command, bridgeStateRevision: '100' });
    h.emitServerEvent(confirmation);
    h.emitServerEvent({ type: 'command_activity', command: newerCommand, bridgeStateRevision: '102' });
    h.emitServerEvent(newerConfirmation);
    h.emitServerEvent({ type: 'command_confirm_resolved', commandId: command.id, sessionId: command.sessionId, id: confirmation.id });
    h.emitRawServerEvent({ type: 'command_activity', command: null, bridgeStateRevision: '101' });
    h.releaseHeldCommand(); released = true; await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, false);
    await h.acceptAppConfirmation(); await h.settle();
    assert.deepEqual(jsonCalls(h, '/confirm').map(call => call.body), [{ id: newerConfirmation.id, apply: true }]);
    assert.deepEqual(h.errors, []);
  } finally { if (!released) h.releaseHeldCommand(); h.close(); }
});
