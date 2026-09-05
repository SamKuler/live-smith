import assert from "node:assert/strict";
import test from "node:test";

import { EDIT_SCOPES, EDIT_SCOPE_LABELS } from "../agent/edit-scopes.js";
import {
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

function initialState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  return state;
}

function control<T extends HTMLElement>(harness: Harness, selector: string): T {
  const element = harness.document.querySelector<T>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

function selectedScopes(harness: Harness): string[] {
  return [...harness.document.querySelectorAll<HTMLInputElement>(
    "#editScopeOptions input:checked",
  )].map((entry) => entry.value);
}

test("independent Approval and Scope entries retain accessible inline help and legacy All scopes", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    const button = control<HTMLButtonElement>(harness, "#editScopeButton");
    const panel = control<HTMLElement>(harness, "#editScopePanel");
    const liveControls = button.closest(".composer-live-controls");
    const approval = control<HTMLSelectElement>(harness, "#approvalMode");
    const all = control<HTMLInputElement>(harness, "#editScopeAll");
    assert.ok(liveControls);
    assert.equal(approval.tagName, "SELECT");
    assert.equal(panel.contains(approval), false);
    assert.equal(harness.document.querySelector("#approvalModeHelp"), null);
    assert.equal(
      [...liveControls.querySelectorAll(".inline-help")].every((help) => panel.contains(help)),
      true,
    );
    assert.equal(liveControls.querySelectorAll("#approvalMode").length, 1);
    assert.equal(button.textContent, "All scopes");
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    assert.equal(button.getAttribute("aria-controls"), panel.id);
    assert.equal(panel.hidden, true);

    harness.click("#editScopeButton");
    assert.equal(panel.hidden, false);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(harness.document.activeElement, control(harness, "#editScope-midi"));
    assert.deepEqual(selectedScopes(harness), EDIT_SCOPES);
    assert.equal(all.type, "checkbox");
    assert.equal(all.checked, true);
    assert.equal(all.indeterminate, false);
    for (const scope of EDIT_SCOPES) {
      const checkbox = control<HTMLInputElement>(harness, `#editScope-${scope}`);
      assert.equal(checkbox.getAttribute("aria-label"), EDIT_SCOPE_LABELS[scope]);
    }
    assert.deepEqual(
      [...panel.querySelectorAll("#editScopeOptions label")].map((label) => label.textContent),
      ["MIDI", "Audio", "Devices", "Mixer", "Structure"],
    );
    assert.equal(panel.getAttribute("aria-describedby"), "editScopeSavedSummary");
    const savedSummary = control(harness, "#editScopeSavedSummary");
    assert.equal(savedSummary.classList.contains("visually-hidden"), true);
    assert.equal(savedSummary.getAttribute("aria-live"), "polite");
    for (const selector of [
      "#editScopeSaveButton", "#editScopeCancelButton",
      "#editScopeAllButton",
    ]) assert.equal(harness.document.querySelector(selector), null);
    const readOnly = control<HTMLButtonElement>(harness, "#editScopeReadOnlyButton");
    assert.equal(panel.contains(readOnly), true);
    assert.equal(readOnly.getAttribute("aria-disabled"), "false");
    for (const selector of [
      "#editScopeHelp", "#editScopeDevicesHelp", "#editScopeStructureHelp",
    ]) {
      const help = control(harness, selector);
      assert.equal(help.textContent, "?");
      assert.equal(help.classList.contains("inline-help"), true);
      assert.equal(help.tabIndex, 0);
      assert.ok(help.dataset.tooltip && help.dataset.tooltip.length > 1);
      assert.equal(help.getAttribute("aria-label"), help.dataset.tooltip);
      help.focus();
      assert.equal(harness.document.activeElement, help);
    }
    assert.equal(control(harness, "#editScope-devices").getAttribute("aria-describedby"), "editScopeDevicesHelp");
    assert.equal(control(harness, "#editScope-structure").getAttribute("aria-describedby"), "editScopeStructureHelp");
    assert.equal(commandCalls(harness).length, 0);
    control(harness, "#editScopeStructureHelp").dispatchEvent(new harness.window.KeyboardEvent(
      "keydown", { key: "Escape", bubbles: true, cancelable: true },
    ));
    assert.equal(panel.hidden, true);
    assert.equal(harness.document.activeElement, button);
    assert.equal(commandCalls(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the Read only shortcut saves an empty scope set, retains focus for Escape, and resumes writes only by explicit scope selection", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = ["midi", "devices"];
  state.sessions[0]!.approvalMode = "everything";
  state.approvalMode = "everything";
  const harness = await createDialogHarness(state);
  let held = false;
  try {
    harness.click("#editScopeButton");
    const readOnly = control<HTMLButtonElement>(harness, "#editScopeReadOnlyButton");
    assert.equal(harness.document.activeElement, control(harness, "#editScope-midi"));
    harness.holdNextCommand();
    held = true;
    harness.click("#editScopeReadOnlyButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [{
      kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [],
    }]);
    assert.equal(readOnly.getAttribute("aria-disabled"), "true");
    assert.equal(readOnly.disabled, false);
    assert.equal(harness.document.activeElement, readOnly);
    assert.equal(control(harness, "#editScopePanel").getAttribute("aria-busy"), "true");
    assert.equal(control(harness, "#permissionsSaveStatus").hidden, false);
    assert.equal(control(harness, "#editScopeButton").textContent, "2 scopes");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: MIDI content, Devices");
    assert.deepEqual(selectedScopes(harness), []);
    harness.click("#editScopeReadOnlyButton");
    assert.equal(commandCalls(harness).length, 1);
    harness.releaseHeldCommand();
    held = false;
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Read only");
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.equal(control(harness, "#permissionsSaveStatus").hidden, true);
    assert.equal(control<HTMLInputElement>(harness, "#editScopeAll").checked, false);
    assert.equal(control<HTMLInputElement>(harness, "#editScopeAll").indeterminate, false);
    assert.equal(readOnly.getAttribute("aria-disabled"), "true");
    assert.equal(readOnly.disabled, false);
    assert.equal(harness.document.activeElement, readOnly);
    harness.click("#editScopeReadOnlyButton");
    assert.equal(commandCalls(harness).length, 1);
    const hostMessagesBeforeEscape = harness.hostMessages.length;
    const escape = new harness.window.KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    });
    readOnly.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(control(harness, "#editScopePanel").hidden, true);
    assert.equal(harness.document.activeElement, control(harness, "#editScopeButton"));
    assert.equal(harness.hostMessages.length, hostMessagesBeforeEscape);
    harness.click("#editScopeButton");
    harness.click("#editScope-midi");
    await harness.settle();
    assert.deepEqual(selectedScopes(harness), ["midi"]);
    assert.equal(readOnly.getAttribute("aria-disabled"), "false");
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: ["midi"],
    });
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) harness.releaseHeldCommand();
    harness.close();
  }
});

test("a failed Read only save retains saved scopes and approval and allows an explicit retry", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = ["audio", "mixer"];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.failNextCommand("Read-only scope could not be saved.");
    harness.click("#editScopeReadOnlyButton");
    await harness.settle();
    assert.deepEqual(selectedScopes(harness), ["audio", "mixer"]);
    assert.equal(control(harness, "#editScopeButton").textContent, "2 scopes");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Audio content, Mixer");
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.equal(control(harness, "#editScopePanel").getAttribute("aria-busy"), "false");
    assert.equal(control(harness, "#editScopeReadOnlyButton").getAttribute("aria-disabled"), "false");
    assert.match(control(harness, "#status").textContent ?? "", /could not be saved/i);
    harness.click("#editScopeReadOnlyButton");
    await harness.settle();
    assert.deepEqual(selectedScopes(harness), []);
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control(harness, "#editScopeReadOnlyButton").getAttribute("aria-disabled"), "true");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "manual");
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), Array.from({ length: 2 }, () => ({
      kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [],
    })));
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed Read only result cannot overwrite permissions saved more recently in another window", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = ["midi"];
  const harness = await createDialogHarness(state);
  let held = false;
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    held = true;
    harness.click("#editScopeReadOnlyButton");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending Read only save");
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: ["devices"],
      updatedAt: "2026-09-05T09:00:00.000Z", bridgeStateRevision: "3",
    });
    harness.emitServerEvent({
      type: "approval_mode_changed", sessionId: "session-1", approvalMode: "everything",
      updatedAt: "2026-09-05T09:01:00.000Z", bridgeStateRevision: "4",
    });
    harness.releaseHeldCommandResponse();
    held = false;
    await harness.settle();
    assert.deepEqual(selectedScopes(harness), ["devices"]);
    assert.equal(control(harness, "#editScopeButton").textContent, "Devices");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Devices");
    assert.equal(control(harness, "#editScopeReadOnlyButton").getAttribute("aria-disabled"), "false");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [{
      kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [],
    }]);
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) harness.releaseHeldCommandResponse();
    harness.close();
  }
});

test("each scope change immediately saves the full set and keeps approval independent", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    const button = control<HTMLButtonElement>(harness, "#editScopeButton");
    const all = control<HTMLInputElement>(harness, "#editScopeAll");
    harness.click("#editScopeButton");
    for (const [selector, scopes, label, summary] of [
      ["#editScopeAll", [], "Read only", "Read only"],
      ["#editScope-midi", ["midi"], "MIDI", "MIDI content"],
      ["#editScope-mixer", ["midi", "mixer"], "2 scopes", "MIDI content, Mixer"],
      ["#editScopeAll", EDIT_SCOPES, "All scopes", "All"],
      ["#editScopeAll", [], "Read only", "Read only"],
    ] as const) {
      const countBeforeSave = commandCalls(harness).length;
      harness.click(selector);
      await harness.settle();
      assert.equal(commandCalls(harness).length, countBeforeSave + 1);
      assert.deepEqual(commandCalls(harness).at(-1)?.body, {
        kind: "set_session_edit_scopes",
        sessionId: "session-1",
        editScopes: scopes,
      });
      assert.deepEqual(selectedScopes(harness), scopes);
      assert.equal(button.textContent, label);
      assert.match(button.getAttribute("aria-label") ?? "", /scope/i);
      assert.ok(button.getAttribute("aria-label")?.includes(summary));
      assert.ok(button.title.includes(summary));
      assert.equal(all.checked, scopes.length === EDIT_SCOPES.length);
      assert.equal(all.indeterminate, scopes.length > 0 && scopes.length < EDIT_SCOPES.length);
      assert.equal(control<HTMLElement>(harness, "#editScopePanel").hidden, false);
      assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "manual");
    }
    const scopeBeforeApproval = {
      label: button.getAttribute("aria-label"), title: button.title, className: button.className,
    };
    harness.select("#approvalMode", "everything");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_approval_mode", sessionId: "session-1", approvalMode: "everything",
    });
    assert.equal(button.textContent, "Read only");
    assert.deepEqual({
      label: button.getAttribute("aria-label"), title: button.title, className: button.className,
    }, scopeBeforeApproval);
    assert.deepEqual(selectedScopes(harness), []);
    harness.click("#editScopeAll");
    await harness.settle();
    assert.equal(button.textContent, "All scopes");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");
    harness.select("#approvalMode", "low-risk");
    await harness.settle();
    assert.equal(button.textContent, "All scopes");
    assert.deepEqual(selectedScopes(harness), EDIT_SCOPES);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scope autosave shows pending checks, locks inputs, and rolls failed changes back to saved permissions", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    const devices = control<HTMLInputElement>(harness, "#editScope-devices");
    devices.focus();
    harness.holdNextCommand();
    harness.click("#editScope-devices");
    await harness.settle();
    const panel = control<HTMLElement>(harness, "#editScopePanel");
    const saveStatus = control(harness, "#permissionsSaveStatus");
    assert.equal(saveStatus.textContent, "Saving…");
    assert.equal(saveStatus.hidden, false);
    assert.equal(panel.getAttribute("aria-busy"), "true");
    for (const field of panel.querySelectorAll<HTMLInputElement>("input, select")) {
      assert.equal(field.disabled, true);
    }
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").disabled, true);
    assert.deepEqual(selectedScopes(harness), ["devices"]);
    assert.equal(control<HTMLInputElement>(harness, "#editScopeAll").indeterminate, true);
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Read only");
    harness.click("#editScope-midi");
    harness.click("#editScopeAll");
    assert.deepEqual(selectedScopes(harness), ["devices"]);
    assert.equal(commandCalls(harness).length, 1);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(panel.hidden, false);
    assert.equal(saveStatus.hidden, true);
    assert.equal(saveStatus.textContent, "");
    assert.equal(control(harness, "#editScopeButton").textContent, "Devices");
    assert.equal(harness.document.activeElement, devices);

    harness.failNextCommand("Scope could not be saved.");
    harness.click("#editScope-devices");
    await harness.settle();
    assert.equal(panel.hidden, false);
    assert.equal(panel.getAttribute("aria-busy"), "false");
    assert.equal(devices.disabled, false);
    assert.deepEqual(selectedScopes(harness), ["devices"]);
    assert.equal(control(harness, "#editScopeButton").textContent, "Devices");
    assert.match(control(harness, "#status").textContent ?? "", /Scope could not be saved/);
    harness.click("#editScope-devices");
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const change of ["scope", "approval"] as const) {
  for (const dismissal of ["Escape", "outside", "trigger"] as const) {
    test(`${dismissal} dismisses a pending ${change} save without canceling it or restoring focus inside the hidden panel`, async () => {
      const state = initialState();
      state.sessions[0]!.editScopes = [];
      const harness = await createDialogHarness(state);
      let commandHeld = false;
      try {
        const panel = control(harness, "#editScopePanel");
        const trigger = control<HTMLButtonElement>(harness, "#editScopeButton");
        const source = control(harness, change === "scope" ? "#editScope-devices" : "#approvalMode");
        if (change === "scope") harness.click("#editScopeButton");
        source.focus();
        harness.holdNextCommand();
        commandHeld = true;
        if (change === "scope") harness.click("#editScope-devices");
        else harness.select("#approvalMode", "everything");
        await harness.settle();
        if (change === "approval") {
          assert.equal(panel.hidden, true);
          trigger.focus();
          harness.click("#editScopeButton");
        }
        assert.equal(trigger.disabled, false);
        assert.equal(panel.getAttribute("aria-busy"), String(change === "scope"));
        assert.equal(control(harness, "#permissionsSaveStatus").textContent, change === "scope" ? "Saving…" : "");
        assert.equal(control(harness, "#permissionsSaveStatus").hidden, change !== "scope");
        for (const input of panel.querySelectorAll<HTMLInputElement>("input, select")) {
          assert.equal(input.disabled, true);
        }
        assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").disabled, true);
        assert.equal(trigger.textContent, "Read only");
        const focusTarget = dismissal === "outside"
          ? change === "scope" ? harness.document.body : control(harness, "#settingsButton")
          : trigger;
        if (dismissal === "Escape") {
          const help = control(harness, "#editScopeHelp");
          help.focus();
          help.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
            key: "Escape", bubbles: true, cancelable: true,
          }));
        } else if (dismissal === "outside") {
          if (focusTarget === harness.document.body) focusTarget.tabIndex = -1;
          focusTarget.focus();
          if (focusTarget === harness.document.body) focusTarget.removeAttribute("tabindex");
          focusTarget.dispatchEvent(new harness.window.MouseEvent("mousedown", { bubbles: true }));
        } else {
          harness.click("#editScopeButton");
          harness.click("#editScopeButton");
          assert.equal(panel.hidden, false);
          assert.deepEqual(selectedScopes(harness), change === "scope" ? ["devices"] : []);
          assert.equal(panel.getAttribute("aria-busy"), String(change === "scope"));
          harness.click("#editScopeButton");
        }
        assert.equal(panel.hidden, true);
        assert.equal(trigger.getAttribute("aria-expanded"), "false");
        assert.equal(harness.document.activeElement, focusTarget);
        assert.equal(commandCalls(harness).length, 1);
        harness.releaseHeldCommand();
        commandHeld = false;
        await harness.settle();
        assert.equal(panel.hidden, true);
        assert.equal(panel.getAttribute("aria-busy"), "false");
        assert.equal(harness.document.activeElement, focusTarget);
        assert.equal(trigger.textContent, change === "scope" ? "Devices" : "Read only");
        harness.click("#editScopeButton");
        assert.deepEqual(selectedScopes(harness), change === "scope" ? ["devices"] : []);
        assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value,
          change === "scope" ? "manual" : "everything");
        assert.equal(commandCalls(harness).length, 1);
        assert.deepEqual(harness.errors, []);
      } finally {
        if (commandHeld) harness.releaseHeldCommand();
        await harness.settle();
        harness.close();
      }
    });
  }
}

test("scope edits remain available during an active send and its delayed terminal cannot reset the saved scope", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Inspect the selected track");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.sendIds.length, 1);
    assert.equal(control<HTMLButtonElement>(harness, "#editScopeButton").disabled, false);
    harness.click("#editScopeButton");
    harness.click("#editScope-midi");
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "MIDI");
    assert.equal(control(harness, "#sendButtonLabel").textContent, "Stop");
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "MIDI");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session switching locks permission inputs and renders each Session's separately saved permissions", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  state.sessions[1]!.editScopes = ["audio", "devices"];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.click("#editScope-mixer");
    await harness.settle();
    harness.holdNextCommandResponse();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => harness.commandIds.length === 2, "Pending Session switch");
    for (const field of harness.document.querySelectorAll<HTMLInputElement>("#editScopePanel input, #editScopePanel select")) {
      assert.equal(field.disabled, true);
    }
    assert.equal(control(harness, "#editScopeReadOnlyButton").getAttribute("aria-disabled"), "true");
    harness.click("#editScope-midi");
    harness.click("#editScopeReadOnlyButton");
    assert.equal(commandCalls(harness).length, 2);
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control<HTMLElement>(harness, "#editScopePanel").hidden, true);
    assert.equal(control(harness, "#editScopeButton").textContent, "2 scopes");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "low-risk");
    harness.click("#editScopeButton");
    assert.deepEqual(selectedScopes(harness), ["audio", "devices"]);
    harness.click("#editScope-devices");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_edit_scopes", sessionId: "session-2", editScopes: ["audio"],
    });
    harness.click("#editScopeReadOnlyButton");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_edit_scopes", sessionId: "session-2", editScopes: [],
    });
    assert.deepEqual(selectedScopes(harness), []);
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "low-risk");
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Mixer");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "manual");
    harness.click("#editScopeButton");
    assert.deepEqual(selectedScopes(harness), ["mixer"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a new Session renders its authoritative default rather than the former Session permissions", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = ["midi"];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    harness.click("#newSessionButton");
    await waitForCondition(() => harness.commandIds.length === 1, "New Session command");
    const created = cloneState(state);
    created.sessions.push({ ...created.sessions[0]!, id: "session-3", title: "", editScopes: [...EDIT_SCOPES] });
    created.activeSessionId = "session-3";
    harness.emitServerEvent({ type: "state", commandId: harness.commandIds[0], state: created });
    await harness.settle();
    assert.equal(control<HTMLElement>(harness, "#editScopePanel").hidden, true);
    assert.equal(control(harness, "#editScopeButton").textContent, "All scopes");
    harness.click("#editScopeButton");
    assert.deepEqual(selectedScopes(harness), EDIT_SCOPES);
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "All scopes");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scope patches update open permission inputs without changing another Session's controls", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    harness.click("#editScopeButton");
    const meta = control(harness, '.session-entry[data-session-id="session-2"] .session-meta');
    const previousTimestamp = meta.title;
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-2", editScopes: ["audio"],
      updatedAt: "2026-08-26T09:00:00.000Z", bridgeStateRevision: "2",
    });
    assert.notEqual(meta.title, previousTimestamp);
    assert.equal(control(harness, "#editScopeButton").textContent, "All scopes");
    assert.deepEqual(selectedScopes(harness), EDIT_SCOPES);
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T09:01:00.000Z", bridgeStateRevision: "3",
    });
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Read only");
    assert.deepEqual(selectedScopes(harness), []);
    assert.equal(control<HTMLInputElement>(harness, "#editScopeAll").checked, false);
    assert.equal(control<HTMLInputElement>(harness, "#editScopeAll").indeterminate, false);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Audio");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "low-risk");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed scope autosave cannot overwrite a newer ABA scope patch or newer Approval", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    harness.click("#editScope-midi");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: ["devices"],
      updatedAt: "2026-08-26T09:00:00.000Z", bridgeStateRevision: "3",
    });
    harness.emitServerEvent({
      type: "approval_mode_changed", sessionId: "session-1", approvalMode: "everything",
      updatedAt: "2026-08-26T09:01:00.000Z", bridgeStateRevision: "4",
    });
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T09:02:00.000Z", bridgeStateRevision: "5",
    });
    assert.deepEqual(selectedScopes(harness), ["midi"]);
    assert.equal(control(harness, "#editScopeSavedSummary").textContent, "Saved: Read only");
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.deepEqual(selectedScopes(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a delayed Session switch snapshot keeps the target's newer scope patch", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    harness.holdNextCommandResponse();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(() => harness.commandIds.length === 1, "Pending Session selection");
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-2", editScopes: ["mixer"],
      updatedAt: "2026-08-26T10:00:00.000Z", bridgeStateRevision: "3",
    });
    assert.equal(control(harness, "#editScopeButton").textContent, "All scopes");
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Mixer");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "low-risk");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a fuller authoritative snapshot supersedes covered scope patches and ignores older replays", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    harness.click("#editScope-midi");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: ["devices"],
      updatedAt: "2026-08-26T10:00:00.000Z", bridgeStateRevision: "3",
    });
    const newer = cloneState(state);
    newer.sessions[0]!.editScopes = ["audio"];
    harness.queueNextStatePublication("5", "4");
    harness.emitServerEvent({ type: "state", commandId: harness.commandIds[0], state: newer });
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Audio");
    harness.emitRawServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "4",
    });
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Audio");
    assert.deepEqual(selectedScopes(harness), ["audio"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scope reconnect replay survives a response-loss reconciliation snapshot captured earlier", async () => {
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.truncateNextCommandResponseAfterCommit();
    harness.click("#editScope-mixer");
    await harness.settle();
    harness.holdNextState();
    harness.emitServerEventError();
    await waitForCondition(() => harness.calls.some((call) => call.path === "/state"), "Scope reconciliation request");
    harness.emitServerEventOpen();
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T10:00:00.000Z", bridgeStateRevision: "4",
    });
    harness.releaseHeldState();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.equal(control<HTMLButtonElement>(harness, "#editScopeButton").disabled, false);
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.deepEqual(selectedScopes(harness), []);
    assert.equal(control(harness, "#permissionsSaveStatus").hidden, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scope timestamps share the Session metadata frontier with Approval", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    const meta = control(harness, '.session-entry[data-session-id="session-1"] .session-meta');
    harness.emitServerEvent({
      type: "approval_mode_changed", sessionId: "session-1", approvalMode: "everything",
      updatedAt: "2026-08-26T10:02:00.000Z", bridgeStateRevision: "4",
    });
    const latestTimestamp = meta.title;
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: ["structure"],
      updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "3",
    });
    assert.equal(meta.title, latestTimestamp);
    assert.equal(control(harness, "#editScopeButton").textContent, "Structure");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "everything");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("malformed scope patches are rejected before consuming a projection revision", async () => {
  const harness = await createDialogHarness(initialState());
  try {
    for (const editScopes of [null, "midi", ["midi", "midi"], ["unknown"], [{ apiKey: "invalid-wire-field" }]]) {
      harness.emitRawServerEvent({
        type: "session_edit_scopes_changed", sessionId: "session-1", editScopes,
        updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "9",
      });
    }
    harness.emitRawServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "9", settings: {},
    });
    harness.emitRawServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T10:01:00.000Z",
    });
    assert.equal(control(harness, "#editScopeButton").textContent, "All scopes");
    harness.emitRawServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-1", editScopes: [],
      updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "9",
    });
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("initial and command state reject invalid scope metadata in every Session collection", async () => {
  const initial = initialState();
  initial.sessions[0]!.editScopes = ["midi", "midi"];
  const invalidHarness = await createDialogHarness(initial);
  try {
    assert.equal(invalidHarness.document.querySelector(".app")?.hasAttribute("inert"), true);
    assert.match(control(invalidHarness, "#status").textContent ?? "", /invalid initial state/i);
  } finally {
    invalidHarness.close();
  }
  const state = initialState();
  state.sessions[0]!.editScopes = [];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    harness.click("#editScope-midi");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
    for (const collection of ["sessions", "previousSessions", "archivedSessions"] as const) {
      const invalid = cloneState(state);
      invalid[collection].push({ ...invalid.sessions[0]!, id: "session-invalid", editScopes: ["midi", "midi"] });
      harness.emitServerEvent({ type: "state", commandId: harness.commandIds[0], state: invalid });
      assert.equal(control(harness, "#permissionsSaveStatus").textContent, "Saving…");
      assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    }
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "MIDI");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scope patches for a not-yet-observed Session overlay its older creation snapshot", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextCommandResponse();
    harness.click("#newSessionButton");
    await waitForCondition(() => harness.commandIds.length === 1, "New Session command");
    harness.emitServerEvent({
      type: "session_edit_scopes_changed", sessionId: "session-3", editScopes: [],
      updatedAt: "2026-08-26T10:01:00.000Z", bridgeStateRevision: "3",
    });
    const created = cloneState(state);
    created.sessions.push({ ...created.sessions[0]!, id: "session-3", title: "" });
    created.activeSessionId = "session-3";
    harness.queueNextStatePublication("4", "1");
    harness.emitServerEvent({ type: "state", commandId: harness.commandIds[0], state: created });
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unknown Read only commit renders reconciled permissions instead of a pre-command rollback", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  try {
    const authoritative = cloneState(state);
    authoritative.sessions[0]!.editScopes = [];
    harness.failNextCommand(
      "The scope commit could not be confirmed.", undefined,
      { commandOutcome: "unknown", state: authoritative },
    );
    harness.click("#editScopeButton");
    harness.click("#editScopeReadOnlyButton");
    await harness.settle();
    assert.equal(control(harness, "#editScopeButton").textContent, "Read only");
    assert.deepEqual(selectedScopes(harness), []);
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.equal(control<HTMLButtonElement>(harness, "#sendButton").disabled, false);
    assert.equal(control(harness, "#editScopeReadOnlyButton").getAttribute("aria-disabled"), "true");
    assert.equal(control<HTMLSelectElement>(harness, "#approvalMode").value, "manual");
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [{
      kind: "set_session_edit_scopes", sessionId: "session-1", editScopes: [],
    }]);
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.match(control(harness, "#status").textContent ?? "", /could not be confirmed/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
