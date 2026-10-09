import assert from "node:assert/strict";
import test from "node:test";
import { defaultSessionTabs, sessionInspectorTabs, sessionShortcutIds, type SessionShortcutId } from "../../../src/model/session-tabs.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const element = <T extends HTMLElement>(h: Harness, id: string) => h.document.getElementById(id) as T;
const visibleShortcuts = (h: Harness) => [...h.document.querySelectorAll<HTMLElement>("[data-session-shortcut]")]
  .filter((button) => !button.hidden).map((button) => button.dataset.sessionShortcut);
const visibleInspectorTabs = (h: Harness) => sessionInspectorTabs.filter((id) => !element(h, `${id}Tab`).hidden);
const peerTabs = (tabs: SessionShortcutId[], revision: string, settings = stateFixture().settings) => ({
  type: "global_settings_changed", commandId: `peer-tabs-${revision}`,
  defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
  defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
  showContextUsage: settings.showContextUsage,
  contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
  sessionTabs: tabs, sessionTabsRevision: revision,
});

test("composer shortcuts open full Inspector panels and preserve message and brief drafts", async (t) => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); t.after(() => h.close());
  assert.deepEqual(visibleShortcuts(h), defaultSessionTabs);
  h.input("#prompt", "Keep this message draft");
  h.click("#briefShortcut");
  assert.equal(element(h, "inspectorPane").hidden, false);
  assert.equal(element(h, "contextPanel").hidden, false);
  assert.equal(element(h, "contextTab").getAttribute("aria-selected"), "true");
  assert.equal(h.document.activeElement, element(h, "creativeBrief"));
  assert.deepEqual(visibleInspectorTabs(h), sessionInspectorTabs);
  h.input("#creativeBrief", "Preserve the melody");
  assert.equal(element(h, "briefShortcut").dataset.state, "draft");
  element(h, "contextTab").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(element(h, "toolsPanel").hidden, false);
  assert.equal(h.document.activeElement, element(h, "toolsTab"));
  h.click("#settingsButton"); h.click("#briefShortcut");
  assert.equal(element<HTMLTextAreaElement>(h, "creativeBrief").value, "Preserve the melody");
  assert.equal(element<HTMLTextAreaElement>(h, "prompt").value, "Keep this message draft");
  assert.deepEqual(commandCalls(h), []);
  assert.deepEqual(h.errors, []);
});

test("the Context shortcut locates Live context while Brief retains its own section", async (t) => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); t.after(() => h.close());
  const context = element(h, "context");
  const brief = element(h, "creativeBriefSection");
  const locations: string[] = [];
  context.scrollIntoView = () => { locations.push(context.id); };
  brief.scrollIntoView = () => { locations.push(brief.id); };
  h.input("#prompt", "Unsent music request");
  h.click("#briefShortcut"); h.input("#creativeBrief", "Unfinished brief");
  h.click("#settingsButton"); h.click("#liveContextSummaryButton");
  assert.deepEqual(locations, ["creativeBriefSection", "context"]);
  assert.equal(element(h, "contextPanel").hidden, false);
  assert.equal(h.document.activeElement, context);
  h.click("#settingsButton"); h.click("#briefShortcut");
  assert.equal(h.document.activeElement, element(h, "creativeBrief"));
  assert.equal(element<HTMLTextAreaElement>(h, "creativeBrief").value, "Unfinished brief");
  assert.equal(element<HTMLTextAreaElement>(h, "prompt").value, "Unsent music request");
  assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
});

test("hiding every composer shortcut preserves the complete Inspector navigation and Skill activation", async (t) => {
  const state = stateFixture(); state.settings.sessionTabs = [...sessionShortcutIds];
  state.sessions[0]!.activeSkillIds = [state.availableSkills[0]!.id];
  state.activeSkillIds = [...state.sessions[0]!.activeSkillIds];
  const h = await createDialogHarness(state); t.after(() => h.close());
  const skills = [...state.sessions[0]!.activeSkillIds];
  h.click("#appTab");
  for (const tab of sessionShortcutIds) { h.click(`#showSessionTab-${tab}`); await h.settle(); }
  assert.deepEqual(commandCalls(h).map((entry) => entry.body), sessionShortcutIds.map((_, index) => ({
    kind: "save_global_settings", sessionTabs: sessionShortcutIds.slice(index + 1),
  })));
  assert.deepEqual(visibleShortcuts(h), []);
  assert.equal(element(h, "composerShortcuts").hidden, true);
  assert.equal(element(h, "appPanel").hidden, false);
  h.click("#sessionInspectorScope");
  assert.deepEqual(visibleInspectorTabs(h), sessionInspectorTabs);
  h.click("#skillsTab");
  assert.equal(element(h, "skillsPanel").hidden, false);
  h.click("#settingsInspectorScope"); h.click("#appTab");
  h.click("#showSessionTab-brief"); await h.settle();
  assert.deepEqual(visibleShortcuts(h), ["brief"]);
  assert.equal(element(h, "composerShortcuts").hidden, false);
  assert.deepEqual([...h.readBootstrappedClientStateReference().sessions[0]!.activeSkillIds!], skills);
  assert.deepEqual(h.errors, []);
});

test("peer shortcut preferences leave the open panel, focus and unsaved draft intact", async (t) => {
  const h = await createDialogHarness(stateFixture()); t.after(() => h.close());
  h.click("#contextTab"); h.input("#creativeBrief", "Unsaved per-Session notes");
  element(h, "creativeBrief").focus();
  for (const [index, shortcuts] of [["artifacts"], [], ["brief"]].entries()) {
    h.emitServerEvent(peerTabs(shortcuts as SessionShortcutId[], String(index + 1))); await h.settle();
    assert.equal(h.document.activeElement, element(h, "creativeBrief"));
    assert.equal(element(h, "contextPanel").hidden, false);
    assert.deepEqual(visibleInspectorTabs(h), sessionInspectorTabs);
    assert.deepEqual(visibleShortcuts(h), shortcuts);
  }
  assert.equal(element<HTMLTextAreaElement>(h, "creativeBrief").value, "Unsaved per-Session notes");
  assert.deepEqual(commandCalls(h), []);
  assert.deepEqual(h.errors, []);
});

test("hiding a focused shortcut returns focus to the composer without changing the message", async (t) => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); t.after(() => h.close());
  h.input("#prompt", "Keep the melody");
  element(h, "briefShortcut").focus();
  h.emitServerEvent(peerTabs([], "1")); await h.settle();
  assert.equal(h.document.activeElement, element(h, "prompt"));
  assert.equal(element<HTMLTextAreaElement>(h, "prompt").value, "Keep the melody");
  assert.deepEqual(commandCalls(h), []);
  assert.deepEqual(h.errors, []);
});

test("rejected tab visibility saves roll back controls and unknown committed saves reconcile", async (t) => {
  const h = await createDialogHarness(stateFixture()); t.after(() => h.close());
  h.click("#appTab"); h.failNextCommand("Could not save tabs.");
  h.click("#showSessionTab-brief"); await h.settle();
  assert.equal(element<HTMLInputElement>(h, "showSessionTab-brief").checked, true);
  assert.equal(element<HTMLFieldSetElement>(h, "sessionTabs").disabled, false);
  h.rejectNextCommandResponse("Lost reply");
  h.click("#showSessionTab-brief"); await h.settle();
  h.emitServerEventError(); await h.settle();
  h.emitServerEventOpen(); await h.settle();
  assert.equal(element<HTMLInputElement>(h, "showSessionTab-brief").checked, false);
  assert.equal(element<HTMLFieldSetElement>(h, "sessionTabs").disabled, false);
  h.click("#sessionInspectorScope");
  assert.deepEqual(visibleShortcuts(h), ["context", "artifacts"]);
  assert.deepEqual(h.errors, []);
});

test("newer peer tab preferences win over a delayed local save and stale Session snapshots", async (t) => {
  const state = stateFixture(); const h = await createDialogHarness(state); t.after(() => h.close());
  h.click("#appTab"); h.holdNextCommandResponse();
  try {
    h.click("#showSessionTab-tools"); await h.settle();
    h.emitServerEvent(peerTabs(["brief"], "2")); await h.settle();
  } finally { h.releaseHeldCommandResponse(); }
  await h.settle();
  h.click("#sessionInspectorScope"); assert.deepEqual(visibleShortcuts(h), ["brief"]);
  const stale = cloneState(state); stale.settings.sessionTabs = [...sessionShortcutIds];
  h.setServerState(stale); h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId });
  await h.settle();
  assert.deepEqual(visibleShortcuts(h), ["brief"]);
  assert.equal(element<HTMLInputElement>(h, "showSessionTab-tools").checked, false);
  assert.deepEqual(h.errors, []);
});

test("tab configuration stays available during generation without consuming a draft or changing the send", async (t) => {
  const h = await createDialogHarness(stateFixture()); t.after(() => h.close());
  h.holdNextSend();
  try {
    h.input("#prompt", "Continue the arrangement"); h.click("#sendButton"); await h.settle();
    h.input("#prompt", "Pending follow-up"); h.click("#appTab");
    assert.equal(element<HTMLFieldSetElement>(h, "sessionTabs").disabled, false);
    h.click("#showSessionTab-skills"); await h.settle();
    assert.deepEqual(commandCalls(h).map((entry) => entry.body), [{
      kind: "save_global_settings", sessionTabs: ["context", "brief", "artifacts", "skills"],
    }]);
    assert.equal(element<HTMLTextAreaElement>(h, "prompt").value, "Pending follow-up");
    assert.equal(h.sendIds.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); }
});


test("an Artifacts-only shortcut loads its library only when that shortcut opens it", async (t) => {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.sessionTabs = ["artifacts"];
  const h = await createDialogHarness(state); t.after(() => h.close());
  assert.equal(h.calls.filter((call) => call.path === "/session-artifacts").length, 0);
  h.click("#settingsButton"); await h.settle();
  assert.equal(h.calls.filter((call) => call.path === "/session-artifacts").length, 0);
  h.click("#settingsButton"); h.click("#artifactsShortcut"); await h.settle();
  assert.equal(h.calls.filter((call) => call.path === "/session-artifacts").length, 1);
  assert.equal(element(h, "artifactsPanel").hidden, false);
  assert.deepEqual(h.errors, []);
});
