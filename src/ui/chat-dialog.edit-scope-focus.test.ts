import assert from "node:assert/strict";
import test from "node:test";

import { EDIT_SCOPES } from "../agent/edit-scopes.js";
import {
  cloneState,
  commandCalls,
  createDialogHarness,
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

function blurDisabledFocus(harness: Harness) {
  // JSDOM does not blur a newly disabled input as the native WebView does.
  const focused = harness.document.activeElement;
  if (focused?.matches(":disabled")) {
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.document.body.removeAttribute("tabindex");
  }
}

function escapeFromFocus(harness: Harness) {
  const messages = harness.hostMessages.length;
  const escape = new harness.window.KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  });
  harness.document.activeElement!.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(control(harness, "#editScopePanel").hidden, true);
  assert.equal(harness.document.activeElement, control(harness, "#editScopeButton"));
  assert.equal(harness.hostMessages.length, messages);
}

for (const scope of [...EDIT_SCOPES, "All"]) {
  const selector = scope === "All" ? "#editScopeAll" : `#editScope-${scope}`;
  test(`${scope} autosave keeps pending focus in Scope and restores the clicked checkbox`, async () => {
    const harness = await createDialogHarness(initialState());
    let held = false;
    try {
      harness.click("#editScopeButton");
      harness.holdNextCommandResponse();
      held = true;
      // click() deliberately does not focus: macOS mouse activation need not do so.
      harness.click(selector);
      await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
      blurDisabledFocus(harness);
      const checkbox = control<HTMLInputElement>(harness, selector);
      assert.equal(checkbox.disabled, true);
      assert.equal(control(harness, "#editScopePanel").getAttribute("aria-busy"), "true");
      assert.ok(control(harness, "#editScopeShell").contains(harness.document.activeElement));
      assert.equal(harness.document.activeElement!.matches(":disabled"), false);
      for (const other of [selector, "#editScopeAll", "#editScopeReadOnlyButton"]) harness.click(other);
      assert.equal(commandCalls(harness).length, 1, "pending saves must reject repeat activation");
      assert.deepEqual(commandCalls(harness)[0]!.body, {
        kind: "set_session_edit_scopes", sessionId: "session-1",
        editScopes: scope === "All" ? [] : EDIT_SCOPES.filter((id) => id !== scope),
      });
      harness.releaseHeldCommandResponse();
      held = false;
      await harness.settle();
      assert.equal(checkbox.disabled, false);
      assert.equal(harness.document.activeElement, checkbox);
      assert.equal(control(harness, "#editScopePanel").hidden, false);
      escapeFromFocus(harness);
      assert.deepEqual(harness.errors, []);
    } finally {
      if (held) { harness.releaseHeldCommandResponse(); await harness.settle(); }
      harness.close();
    }
  });
}

for (const selector of ["#editScope-midi", "#editScopeAll", "#editScopeReadOnlyButton"]) {
  test(`Escape during ${selector} autosave closes only Scope and completion does not reopen it`, async () => {
    const harness = await createDialogHarness(initialState());
    let held = false;
    try {
      harness.click("#editScopeButton");
      harness.holdNextCommandResponse();
      held = true;
      harness.click(selector);
      await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
      blurDisabledFocus(harness);
      escapeFromFocus(harness);
      harness.releaseHeldCommandResponse();
      held = false;
      await harness.settle();
      assert.equal(control(harness, "#editScopePanel").hidden, true);
      assert.equal(harness.document.activeElement, control(harness, "#editScopeButton"));
      assert.deepEqual(harness.errors, []);
    } finally {
      if (held) { harness.releaseHeldCommandResponse(); await harness.settle(); }
      harness.close();
    }
  });
}

test("a rejected ordinary scope save restores its trigger after rollback and permits retry", async () => {
  const harness = await createDialogHarness(initialState());
  let held = false;
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommand();
    held = true;
    harness.failNextCommand("Scope could not be saved.");
    harness.click("#editScopeAll");
    await waitForCondition(() => commandCalls(harness).length === 1, "Pending rejected save");
    blurDisabledFocus(harness);
    harness.releaseHeldCommand();
    held = false;
    await harness.settle();
    const all = control<HTMLInputElement>(harness, "#editScopeAll");
    assert.equal(all.checked, true);
    assert.equal(all.disabled, false);
    assert.equal(harness.document.activeElement, all);
    assert.match(control(harness, "#status").textContent ?? "", /could not be saved/i);
    harness.click("#editScopeAll");
    await harness.settle();
    assert.equal(commandCalls(harness).length, 2);
    assert.equal(all.checked, false);
    assert.equal(harness.document.activeElement, all);
    escapeFromFocus(harness);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) { harness.releaseHeldCommand(); await harness.settle(); }
    harness.close();
  }
});

for (const destination of ["help", "Scope button", "outside", "document"] as const) {
  test(`scope completion does not reclaim focus after the user moves it to ${destination}`, async () => {
    const harness = await createDialogHarness(initialState());
    let held = false;
    try {
      harness.click("#editScopeButton");
      harness.holdNextCommandResponse();
      held = true;
      harness.click("#editScope-audio");
      await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
      control(harness, "#editScopeDevicesHelp").focus();
      if (destination === "Scope button") control(harness, "#editScopeButton").focus();
      if (destination === "outside" || destination === "document") {
        control(harness, "#settingsButton").focus();
        if (destination === "document") control(harness, "#settingsButton").blur();
      }
      const movedFocus = harness.document.activeElement;
      harness.releaseHeldCommandResponse();
      held = false;
      await harness.settle();
      assert.equal(harness.document.activeElement, movedFocus);
      assert.equal(control(harness, "#editScopePanel").hidden, false);
      if (destination === "help" || destination === "Scope button") escapeFromFocus(harness);
      assert.deepEqual(harness.errors, []);
    } finally {
      if (held) { harness.releaseHeldCommandResponse(); await harness.settle(); }
      harness.close();
    }
  });
}

test("closing and reopening Scope during a save retires the previous popover's return focus", async () => {
  const harness = await createDialogHarness(initialState());
  let held = false;
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    held = true;
    harness.click("#editScope-audio");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
    harness.click("#editScopeButton");
    assert.equal(control(harness, "#editScopePanel").hidden, true);
    harness.click("#editScopeButton");
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    assert.equal(harness.document.activeElement, control(harness, "#editScopeButton"));
    harness.releaseHeldCommandResponse();
    held = false;
    await harness.settle();
    assert.equal(harness.document.activeElement, control(harness, "#editScopeButton"));
    escapeFromFocus(harness);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) { harness.releaseHeldCommandResponse(); await harness.settle(); }
    harness.close();
  }
});

test("a delayed scope HTTP response does not restore focus in a later Session", async () => {
  const state = initialState();
  const harness = await createDialogHarness(state);
  let held = false;
  try {
    harness.click("#editScopeButton");
    harness.holdNextCommandResponse();
    held = true;
    harness.click("#editScope-audio");
    await waitForCondition(() => harness.commandIds.length === 1, "Pending scope save");
    const saved = cloneState(state);
    saved.sessions[0]!.editScopes = EDIT_SCOPES.filter((scope) => scope !== "audio");
    harness.emitServerEvent({ type: "state", commandId: harness.commandIds[0], state: saved });
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.click("#editScopeButton");
    control(harness, "#editScopeDevicesHelp").focus();
    harness.releaseHeldCommandResponse();
    held = false;
    await harness.settle();
    assert.equal(harness.document.activeElement, control(harness, "#editScopeDevicesHelp"));
    assert.equal(control(harness, "#editScopePanel").hidden, false);
    escapeFromFocus(harness);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) { harness.releaseHeldCommandResponse(); await harness.settle(); }
    harness.close();
  }
});
