import assert from 'node:assert/strict';
import test from 'node:test';
import { createDialogHarness, stateFixture } from '../support/chat-dialog.test-harness.js';

async function setup(width: number) {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state, undefined, { beforeParse(window) { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width }); } });
  const open = () => { h.click('#artifactsShortcut'); h.click('#openArtifactsButton'); };
  return { h, open };
}

test('narrow artifact navigation overlays the detail, dismisses with Escape and restores chat layout', async () => {
  const {h,open} = await setup(360);
  try {
    const pane = h.document.getElementById('sessionsPane')!;
    const page = h.document.getElementById('artifactsPage')!;
    h.input('#prompt', 'Keep the draft'); open();
    assert.equal(pane.hidden, true);
    h.click('#sessionsToggleButton');
    assert.equal(pane.hidden, false);
    assert.equal(page.hasAttribute('inert'), true);
    h.document.getElementById('sessionSearch')!.focus();
    h.document.getElementById('sessionSearch')!.dispatchEvent(new h.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    assert.equal(pane.hidden, true);
    assert.equal(page.hidden, false); assert.equal(page.hasAttribute('inert'), false);
    assert.equal(h.document.activeElement?.id, 'sessionsToggleButton');
    h.click('#sessionsToggleButton'); h.document.getElementById('sessionSearch')!.focus(); h.click('#sessionsToggleButton');
    assert.equal(h.document.activeElement?.id, 'sessionsToggleButton');
    assert.equal(pane.hidden, true); assert.equal(page.hidden, false);
    h.click('#closeArtifactsButton');
    assert.equal(pane.hidden, false);
    assert.equal(h.document.querySelector<HTMLTextAreaElement>('#prompt')!.value, 'Keep the draft');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('artifact resize closes navigation and keeps inspector and session overlays mutually exclusive', async () => {
  const {h,open} = await setup(1000);
  try {
    open(); assert.equal(h.document.getElementById('sessionsPane')!.hidden,false);
    Object.defineProperty(h.window,'innerWidth',{configurable:true,value:360});
    h.window.dispatchEvent(new h.window.Event('resize'));
    assert.equal(h.document.getElementById('sessionsPane')!.hidden,true);
    h.click('#sessionsToggleButton'); h.click('#settingsButton');
    assert.equal(h.document.getElementById('sessionsPane')!.hidden,true);
    assert.equal(h.document.getElementById('inspectorPane')!.hidden,false);
    h.click('#sessionsToggleButton');
    assert.equal(h.document.getElementById('inspectorPane')!.hidden,true);
    assert.equal(h.document.getElementById('sessionsPane')!.hidden,false);
    h.document.getElementById('sessionSearch')!.focus();
    Object.defineProperty(h.window,'innerWidth',{configurable:true,value:1000});
    h.window.dispatchEvent(new h.window.Event('resize'));
    assert.equal(h.document.getElementById('sessionsPane')!.hidden,false);
    assert.equal(h.document.getElementById('artifactsPage')!.hasAttribute('inert'),false);
    assert.equal(h.document.activeElement?.id,'sessionSearch');
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('returning from artifacts preserves a previously collapsed chat Session list', async () => {
  const {h,open} = await setup(360);
  try {
    h.click('#sessionsToggleButton'); open(); h.click('#sessionsToggleButton');
    h.window.LiveSmithUI.returnToChat();
    assert.equal(h.document.getElementById('sessionsPane')!.hidden,true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test('a narrow Inspector isolates the covered Session list and releases it on close', async () => {
  const {h} = await setup(360);
  try {
    h.click('#artifactsShortcut');
    assert.equal(h.document.getElementById('sessionsPane')!.hasAttribute('inert'),true);
    h.click('#settingsButton');
    assert.equal(h.document.getElementById('sessionsPane')!.hasAttribute('inert'),false);
    assert.deepEqual(h.errors,[]);
  } finally { h.close(); }
});

for (const [paneId, toggleId] of [['sessionsPane', 'sessionsToggleButton'], ['inspectorPane', 'settingsButton']] as const) {
  test(`${paneId} shares overlay isolation and returns focus to its own toggle on both close paths`, async () => {
    const { h, open } = await setup(586);
    try {
      open();
      const page = h.document.getElementById('artifactsPage')!;
      const pane = h.document.getElementById(paneId)!;
      for (const closeWith of ['Escape', 'button']) {
        page.focus();
        h.click('#' + toggleId);
        assert.equal(pane.hidden, false);
        assert.equal(page.hasAttribute('inert'), true);
        assert.equal(pane.contains(h.document.activeElement), true);
        if (closeWith === 'Escape') h.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else h.click('#' + toggleId);
        assert.equal(pane.hidden, true);
        assert.equal(page.hasAttribute('inert'), false);
        assert.equal(h.document.activeElement?.id, toggleId);
      }
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}
