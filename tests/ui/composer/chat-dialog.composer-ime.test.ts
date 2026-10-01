import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

function promptFor(harness: DialogHarness): HTMLTextAreaElement {
  const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  assert.ok(prompt);
  return prompt;
}

function composition(
  harness: DialogHarness,
  type: "compositionstart" | "compositionend",
  data = "",
): void {
  promptFor(harness).dispatchEvent(new harness.window.CompositionEvent(type, {
    bubbles: true,
    data,
  }));
}

function pressKey(
  harness: DialogHarness,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    keyCode: 13,
    isComposing: false,
    ...options,
  });
  promptFor(harness).dispatchEvent(event);
  return event;
}

function assertNoComposerActions(harness: DialogHarness): void {
  assert.deepEqual(jsonCalls(harness, "/send"), []);
  assert.deepEqual(jsonCalls(harness, "/steer"), []);
  assert.deepEqual(commandCalls(harness), []);
}

test("composition lifecycle owns Enter even when the keyboard composing flag is false", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "nihao");
    composition(harness, "compositionstart");
    for (const options of [{}, { metaKey: true }, { ctrlKey: true }, { repeat: true }]) {
      const event = pressKey(harness, options);
      assert.equal(event.defaultPrevented, false);
      assert.equal(promptFor(harness).value, "nihao");
    }
    assertNoComposerActions(harness);

    harness.input("#prompt", "你好");
    composition(harness, "compositionend", "你好");
    assert.equal(pressKey(harness).defaultPrevented, true);
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
      prompt: "你好", sessionId: "session-1",
    }]);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.settle();
    harness.close();
  }
});

test("IME-processed Enter remains native before compositionstart and after compositionend", async () => {
  for (const boundary of ["before-start", "after-end"] as const) {
    const harness = await createDialogHarness();
    try {
      harness.input("#prompt", "已经上屏的中文");
      if (boundary === "after-end") {
        composition(harness, "compositionstart");
        composition(harness, "compositionend", "中文");
      }
      for (const options of [{}, { metaKey: true }, { ctrlKey: true }, { repeat: true }]) {
        const event = pressKey(harness, { ...options, keyCode: 229 });
        assert.equal(event.defaultPrevented, false, boundary);
        assert.equal(promptFor(harness).value, "已经上屏的中文", boundary);
      }
      assertNoComposerActions(harness);

      assert.equal(pressKey(harness).defaultPrevented, true);
      await harness.settle();
      assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
        prompt: "已经上屏的中文", sessionId: "session-1",
      }]);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.settle();
      harness.close();
    }
  }
});

test("IME candidate keys cannot select or close composer autocomplete", async () => {
  const state = stateFixture();
  state.availableSkills = [{ id: "midi-editor", description: "Edit notes", source: "user" }];
  const harness = await createDialogHarness(state);
  try {
    const prompt = promptFor(harness);
    const listbox = harness.document.querySelector<HTMLElement>("#composerAutocomplete");
    assert.ok(listbox);
    prompt.focus();
    harness.input("#prompt", "$mi");
    assert.equal(listbox.hidden, false);
    composition(harness, "compositionstart");
    for (const [key, keyCode] of [["ArrowDown", 40], ["Tab", 9], ["Enter", 13], ["Escape", 27]] as const) {
      assert.equal(pressKey(harness, { key, keyCode }).defaultPrevented, false);
      assert.equal(prompt.value, "$mi");
      assert.equal(listbox.hidden, false);
    }
    composition(harness, "compositionend");
    assert.equal(pressKey(harness, { keyCode: 229 }).defaultPrevented, false);
    assert.equal(prompt.value, "$mi");
    assertNoComposerActions(harness);

    assert.equal(pressKey(harness).defaultPrevented, true);
    assert.equal(prompt.value, "$midi-editor ");
    assertNoComposerActions(harness);
    pressKey(harness);
    await harness.settle();
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.settle();
    harness.close();
  }
});

test("composition cancellation and blur release ordinary Enter without a cooldown", async () => {
  for (const ending of ["cancel", "blur"] as const) {
    const harness = await createDialogHarness();
    try {
      const prompt = promptFor(harness);
      prompt.focus();
      harness.input("#prompt", "保留的草稿");
      composition(harness, "compositionstart");
      if (ending === "cancel") composition(harness, "compositionend");
      else prompt.blur();
      prompt.focus();

      assert.equal(pressKey(harness).defaultPrevented, true, ending);
      await harness.settle();
      assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
        prompt: "保留的草稿", sessionId: "session-1",
      }]);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.settle();
      harness.close();
    }
  }
});

test("IME confirmation cannot queue or steer an active Send", async () => {
  for (const behavior of ["queue", "steer"] as const) {
    const state = stateFixture();
    state.settings.defaultFollowUpBehavior = behavior;
    const harness = await createDialogHarness(state);
    try {
      harness.holdNextSend();
      harness.input("#prompt", "Original request");
      harness.click("#sendButton");
      harness.input("#prompt", "后续中文");
      composition(harness, "compositionstart");
      assert.equal(pressKey(harness).defaultPrevented, false, behavior);
      composition(harness, "compositionend", "中文");
      assert.equal(pressKey(harness, { keyCode: 229 }).defaultPrevented, false, behavior);
      assert.equal(harness.document.querySelectorAll(".queued-follow-up").length, 0);
      assert.equal(jsonCalls(harness, "/send").length, 1);
      assert.deepEqual(jsonCalls(harness, "/steer"), []);
      assert.equal(promptFor(harness).value, "后续中文");

      pressKey(harness);
      await harness.settle();
      if (behavior === "queue") {
        assert.equal(harness.document.querySelectorAll(".queued-follow-up").length, 1);
      } else {
        assert.equal(jsonCalls(harness, "/steer").length, 1);
      }
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.releaseHeldSend();
      await harness.settle();
      harness.close();
    }
  }
});

test("IME boundary Enter cannot execute a composer control command", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "/clear ");
    composition(harness, "compositionstart");
    composition(harness, "compositionend");
    assert.equal(pressKey(harness, { keyCode: 229 }).defaultPrevented, false);
    assertNoComposerActions(harness);
    assert.equal(promptFor(harness).value, "/clear ");

    pressKey(harness);
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [{ kind: "new_session" }]);
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.settle();
    harness.close();
  }
});
