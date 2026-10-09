import assert from "node:assert/strict";
import test from "node:test";
import { cloneState, commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";
import { audioState, musicService, selectAudioService, service } from "../support/chat-dialog.audio-test-helpers.js";

for (const field of ["brief", "composer"] as const) for (const background of [false, true]) {
  test(`Close protects ${background ? "another" : "the active"} Session's ${field} draft`, async () => {
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const h = await createDialogHarness(state);
    try {
      const selector = field === "brief" ? "#creativeBrief" : "#prompt";
      h.input(selector, "Unsaved musical direction");
      if (background) { h.click('[data-session-id="session-2"] .session-row'); await h.settle(); }
      h.click("#closeButton");
      assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
      assert.deepEqual(h.hostMessages, []);
      h.click("#appConfirmationCancel"); await h.settle();
      if (background) { h.click('[data-session-id="session-1"] .session-row'); await h.settle(); }
      assert.equal(h.document.querySelector<HTMLTextAreaElement>(selector)!.value, "Unsaved musical direction");
      h.click("#closeButton"); h.click("#appConfirmationAccept"); await h.settle();
      assert.equal(h.hostMessages.length, 1);
      assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "set_session_creative_brief").length, 0);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("Close needs no draft confirmation after the brief is saved and the composer cleared", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  try {
    h.input("#creativeBrief", "Saved direction"); h.click("#saveCreativeBriefButton"); await h.settle();
    h.input("#prompt", "Draft direction"); h.input("#prompt", "");
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a brief matching the refreshed saved value stays clean after Session navigation", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  try {
    h.input("#creativeBrief", "Shared direction");
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    const next = cloneState(h.readBootstrappedClientStateReference()); next.sessions.find((entry) => entry.id === "session-1")!.creativeBrief = "Shared direction";
    h.setServerState(next); h.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
    h.click('[data-session-id="session-1"] .session-row'); await h.settle();
    h.click('[data-session-id="session-2"] .session-row'); await h.settle();
    h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const setting of ["instructions", "network", "skill"] as const) {
  test(`Close protects ${setting} input and ignores it after save or clearing`, async () => {
    const h = await createDialogHarness(stateFixture());
    try {
      if (setting === "instructions") h.input("#customInstructions", "Preserve distinct instrumental voices");
      if (setting === "network") h.click('input[name="networkProxyMode"][value="system"]');
      if (setting === "skill") h.input("#skillPasteText", "# Editing skill draft");
      h.click("#closeButton");
      assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
      assert.deepEqual(h.hostMessages, []);
      h.click("#appConfirmationCancel"); await h.settle();
      if (setting === "instructions") h.click("#saveCustomInstructionsButton");
      if (setting === "network") h.click("#applyNetworkProxyButton");
      if (setting === "skill") h.input("#skillPasteText", "");
      await h.settle(); h.click("#closeButton"); await h.settle();
      assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
      assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("Close protects an unselected audio connection draft and Discard clears it", async () => {
  const h = await createDialogHarness(audioState([service, musicService]));
  try {
    selectAudioService(h, service.id); h.input("#audioServiceName", "Draft audio name");
    selectAudioService(h, musicService.id);
    h.click("#closeButton");
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    assert.deepEqual(h.hostMessages, []);
    h.click("#appConfirmationCancel"); await h.settle();
    selectAudioService(h, service.id);
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Draft audio name");
    h.click("#reloadAudioServiceButton"); h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Close protects hidden MCP edits and Discard restores a clean window", async () => {
  const state = stateFixture(); state.integrationConnections = { revision: "1", connections: [{
    id: "studio", name: "Studio", enabled: true, mcp: { type: "streamable-http", url: "https://mcp.example.test/tools" },
    configuredSecrets: [], artifactInputApproved: false, artifactOutputApproved: false,
  }] };
  const h = await createDialogHarness(state);
  try {
    h.click('[data-connection-id="studio"] .connection-choice');
    h.input('.plugin-connection-editor [name="connectionName"]', "Draft studio"); h.click("#skillsExtensionTab");
    h.click("#closeButton");
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    assert.deepEqual(h.hostMessages, []);
    h.click("#appConfirmationCancel"); await h.settle();
    h.click("#mcpExtensionTab"); h.click(".plugin-connection-editor .editor-discard");
    h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const action of ["saveAudioServiceButton", "reloadAudioServiceButton"]) test(`Close protects an audio key replacement until ${action}`, async () => {
  const h = await createDialogHarness(audioState());
  try {
    selectAudioService(h, service.id);
    h.input("#audioServiceApiKey", "synthetic-replacement-key");
    h.click("#closeButton");
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    assert.deepEqual(h.hostMessages, []);
    h.click("#appConfirmationCancel"); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "synthetic-replacement-key");
    h.click(`#${action}`); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const owner of ["Profile", "MCP"] as const) test(`Close uses the existing ${owner} dirty state for credential-only edits`, async () => {
  const state = stateFixture(); state.integrationConnections = { revision: "1", connections: [{
    id: "studio", name: "Studio", enabled: true, mcp: { type: "streamable-http", url: "https://mcp.example.test/tools" },
    configuredSecrets: ["Authorization"], artifactInputApproved: false, artifactOutputApproved: false,
  }] };
  const h = await createDialogHarness(state);
  try {
    if (owner === "MCP") h.click('[data-connection-id="studio"] .connection-choice');
    h.input(owner === "Profile" ? "#apiKey" : '.plugin-connection-editor [name="secretValue-0"]', "synthetic-replacement-key");
    h.click("#closeButton");
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    assert.deepEqual(h.hostMessages, []);
    h.click("#appConfirmationCancel"); await h.settle();
    h.click(owner === "Profile" ? "#discardProfileButton" : ".plugin-connection-editor .editor-discard"); await h.settle();
    h.click("#closeButton"); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("draft close cancellation preserves provisional OAuth and a failed cleanup keeps the window open", async () => {
  const h = await createDialogHarness(stateFixture(), undefined, { oauthLoginResult: {
    status: "signed-in", accountLabel: "draft@example.test", planType: "Google Antigravity", subscriptionEligible: true,
  } });
  try {
    h.select("#connectionKind", "oauth-subscription"); h.select("#oauthProvider", "google");
    h.click("#oauthSignInButton"); await h.settle();
    h.input("#creativeBrief", "Keep this direction until saved");
    const cleanup = () => commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "discard_profile_oauth");
    h.click("#closeButton"); h.click("#appConfirmationCancel"); await h.settle();
    assert.equal(cleanup().length, 0); assert.deepEqual(h.hostMessages, []);
    h.failNextCommand("OAuth cleanup failed");
    h.click("#closeButton"); h.click("#appConfirmationAccept"); await h.settle();
    assert.deepEqual(cleanup()[0]!.body, { kind: "discard_profile_oauth", profileId: "profile-1" });
    assert.deepEqual(h.hostMessages, []);
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#creativeBrief")!.value, "Keep this direction until saved");
    h.click("#closeButton"); h.click("#appConfirmationAccept"); await h.settle();
    assert.equal(cleanup().length, 2); assert.equal(h.hostMessages.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("draft close confirmation still describes running work and discarded queued follow-ups", async () => {
  const h = await createDialogHarness(stateFixture()); h.holdNextSend();
  try {
    h.input("#prompt", "Start generation"); h.click("#sendButton"); await h.settle();
    h.input("#prompt", "/queue Continue the phrase");
    h.document.querySelector("#prompt")!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await h.settle();
    h.input("#creativeBrief", "Unsaved direction"); h.click("#closeButton");
    const message = h.document.querySelector("#appConfirmationMessage")!.textContent!;
    assert.match(message, /unsaved drafts/); assert.match(message, /current operation will stop/);
    assert.match(message, /1 queued follow-up will be discarded/);
    h.click("#appConfirmationAccept"); await h.settle();
    assert.equal(h.hostMessages.length, 1); assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});
