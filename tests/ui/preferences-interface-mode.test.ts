import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture } from "./support/chat-dialog.test-harness.js";

test("interface mode persists through DOM changes and a rejected write restores the saved mode", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.click('#appTab');
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')?.value, 'modal');
    harness.select('#interfaceMode', 'browser'); await harness.settle();
    assert.deepEqual(commandCalls(harness).map(call => call.body), [{ kind: 'save_global_settings', interfaceMode: 'browser' }]);
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')!.value, 'browser');
    harness.failNextCommand('Write failed'); harness.select('#interfaceMode', 'modal'); await harness.settle();
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')!.value, 'browser');
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a delayed interface mode write cannot replace a newer peer publication", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  let released = false;
  try {
    harness.click('#appTab'); harness.holdNextCommandResponse();
    harness.select('#interfaceMode', 'browser'); await harness.settle();
    harness.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: 'queue', defaultFollowUpBehaviorRevision: '0', showContextUsage: true, contextUsageVisibilityRevision: '0', interfaceMode: 'modal', interfaceModeRevision: '2', commandId: 'peer-mode' });
    await harness.settle(); harness.releaseHeldCommandResponse(); released = true; await harness.settle();
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')!.value, 'modal');
    harness.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: 'queue', defaultFollowUpBehaviorRevision: '0', showContextUsage: true, contextUsageVisibilityRevision: '0', interfaceMode: 'browser', interfaceModeRevision: '1', commandId: 'stale-mode' });
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#interfaceMode')!.value, 'modal');
    assert.deepEqual(harness.errors, []);
  } finally { if (!released) harness.releaseHeldCommandResponse(); harness.close(); }
});

test('browser host hides modal Close and ignores its action independently of the saved preference', async () => {
  const harness = await createDialogHarness(stateFixture(), { baseUrl: 'http://bridge.test', token: 'test-token', hostMode: 'browser' } as never);
  try {
    assert.equal(harness.document.querySelector<HTMLButtonElement>('#closeButton')!.hidden, true);
    harness.input('#profileName', 'Unsaved draft');
    harness.click('#closeButton'); await harness.settle();
    assert.equal(harness.document.querySelector<HTMLElement>('#appConfirmation')!.hidden, true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
