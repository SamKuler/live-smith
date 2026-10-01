import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("system language selects Chinese or falls back to English without changing Session content", async () => {
  for (const [languages, expected] of [[['zh-CN'], 'zh-CN'], [['fr-FR'], 'en']] as const) {
    const state = stateFixture();
    state.events = [{ id: 'message-1', kind: 'assistant', content: 'Agent <span data-i18n="Agent">Agent</span>', createdAt: '2026-09-06T00:00:00.000Z' }];
    const harness = await createDialogHarness(state, undefined, { navigatorLanguages: [...languages] });
    try {
      assert.equal(harness.document.documentElement.lang, expected);
      assert.equal(harness.document.querySelector('[data-event-id="message-1"] .timeline-content')?.textContent, state.events[0]!.content);
      assert.equal(commandCalls(harness).length, 0);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("switching UI language saves only language and preserves message and Profile drafts", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = 'en';
  const harness = await createDialogHarness(state);
  try {
    harness.input('#prompt', 'Keep my English draft: Agent / Delete.');
    harness.input('#profileName', 'My unsaved Profile');
    const profileInput = harness.document.querySelector<HTMLInputElement>('#profileName')!;
    const prompt = harness.document.querySelector<HTMLTextAreaElement>('#prompt')!;
    const language = harness.document.querySelector<HTMLSelectElement>('#uiLanguage')!;
    harness.click('#appTab');
    language.focus();
    harness.select('#uiLanguage', 'zh-CN');
    await harness.settle();
    assert.equal(harness.document.documentElement.lang, 'zh-CN');
    assert.equal(language.value, 'zh-CN');
    assert.equal(prompt.value, 'Keep my English draft: Agent / Delete.');
    assert.equal(profileInput.value, 'My unsaved Profile');
    assert.equal(harness.document.querySelector('#profileName'), profileInput);
    assert.deepEqual(commandCalls(harness).map(call => call.body), [{ kind: 'save_global_settings', uiLanguage: 'zh-CN' }]);
    assert.equal(harness.document.querySelector('#agentTab')?.textContent, '智能体');
    harness.select('#uiLanguage', 'en');
    await harness.settle();
    assert.equal(harness.document.documentElement.lang, 'en');
    assert.equal(harness.document.querySelector('#agentTab')?.textContent, 'Agent');
    assert.equal(prompt.value, 'Keep my English draft: Agent / Delete.');
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an external language change refreshes an open confirmation without changing its pending decision", async () => {
  const state = stateFixture(); state.settings.uiLanguage = 'en';
  const harness = await createDialogHarness(state);
  try {
    harness.input('#profileName', 'Unsaved exact name');
    harness.click('#addProfileButton');
    await harness.settle();
    const modal = harness.document.querySelector<HTMLElement>('#appConfirmation')!;
    assert.equal(modal.hidden, false);
    harness.emitServerEvent({type:'global_settings_changed', ...{
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
      uiLanguage:'zh-CN',uiLanguageRevision:'1',commandId:'language-external',
    }});
    await harness.settle();
    assert.equal(modal.hidden,false);
    assert.equal(harness.document.documentElement.lang,'zh-CN');
    assert.match(harness.document.querySelector('#appConfirmationTitle')!.textContent!,/放弃/);
    assert.equal(harness.document.querySelector('#appConfirmationCancel')!.textContent,'取消');
    harness.click('#appConfirmationCancel'); await harness.settle();
    assert.equal(harness.document.querySelector<HTMLInputElement>('#profileName')!.value,'Unsaved exact name');
    assert.deepEqual(commandCalls(harness),[]);
    assert.deepEqual(harness.errors,[]);
  } finally {harness.close();}
});

test("a delayed language-save response cannot replace a newer language chosen in another window", async () => {
  const state=stateFixture();state.settings.uiLanguage='en';
  const harness=await createDialogHarness(state);
  let released = false;
  try {
    harness.click('#appTab');harness.holdNextCommandResponse();
    harness.select('#uiLanguage','zh-CN');await harness.settle();
    assert.equal(harness.document.documentElement.lang,'zh-CN');
    harness.emitServerEvent({type:'global_settings_changed',
      defaultFollowUpBehavior:state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision:state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage:state.settings.showContextUsage,
      contextUsageVisibilityRevision:state.settings.contextUsageVisibilityRevision,
      uiLanguage:'en',uiLanguageRevision:'2',commandId:'newer-language',
    });
    await harness.settle();harness.releaseHeldCommandResponse();released = true;await harness.settle();
    assert.equal(harness.document.documentElement.lang,'en');
    assert.equal(harness.document.querySelector<HTMLSelectElement>('#uiLanguage')!.value,'en');
    assert.deepEqual(harness.errors,[]);
  } finally {if (!released) harness.releaseHeldCommandResponse();harness.close();}
});

test("a rejected language save restores the saved locale and permits retry", async () => {
  const state=stateFixture();state.settings.uiLanguage='en';
  const harness=await createDialogHarness(state);
  try {
    harness.click('#appTab');harness.failNextCommand('Could not save language.');
    harness.select('#uiLanguage','zh-CN');await harness.settle();
    assert.equal(harness.document.documentElement.lang,'en');
    const control=harness.document.querySelector<HTMLSelectElement>('#uiLanguage')!;
    assert.equal(control.value,'en');assert.equal(control.disabled,false);
    assert.match(harness.document.querySelector('#status')!.textContent!,/Could not save language/);
    harness.select('#uiLanguage','zh-CN');await harness.settle();
    assert.equal(harness.document.documentElement.lang,'zh-CN');
    assert.equal(control.disabled,false);
    assert.deepEqual(harness.errors,[]);
  } finally {harness.close();}
});

test("built-in Skill summaries are localized while user Skill descriptions remain authored text", async () => {
  const state=stateFixture();state.settings.uiLanguage='zh-CN';
  const source=state.availableSkills.find(skill=>skill.source==='built-in')!.description;
  state.availableSkills.push({id:'authored-description',description:source,source:'user'});
  const harness=await createDialogHarness(state);
  try {
    assert.ok(!harness.document.querySelector('#builtInSkillList')!.textContent!.includes(source));
    assert.ok(harness.document.querySelector('#userSkillList')!.textContent!.includes(source));
    assert.deepEqual(harness.errors,[]);
  } finally {harness.close();}
});
