import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneState,
  commandCalls,
  createDialogHarness,
  imageCapableState,
  jsonCalls,
  pendingImage,
  stateFixture,
  type DialogHarness,
} from "./chat-dialog.test-harness.js";

const historicalPrompt = "Original **request**\nKeep the exact source.";
const historyEdit = '[data-event-id="history-user"] [data-message-action="edit"]';
const recoveryEdit = '.queued-follow-up[data-queue-id] [data-message-action="edit"]';

function historyState() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "history-user",
    kind: "user",
    content: historicalPrompt,
    createdAt: "2026-08-01T00:00:00.000Z",
  }, {
    id: "history-error",
    kind: "error",
    content: "The request stopped after an earlier operation.",
    createdAt: "2026-08-01T00:00:01.000Z",
  }];
  return state;
}

function composer(harness: DialogHarness): HTMLTextAreaElement {
  const control = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
  assert.ok(control);
  return control;
}

function submitComposer(harness: DialogHarness): void {
  composer(harness).dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true,
    ctrlKey: true,
    key: "Enter",
  }));
}

function sentPrompts(harness: DialogHarness): unknown[] {
  return jsonCalls(harness, "/send").map(({ body }) =>
    body && typeof body === "object" && "prompt" in body ? body.prompt : undefined
  );
}

test("editing historical user text fills a new draft without sending or changing history", async () => {
  const state = historyState();
  const harness = await createDialogHarness(state);
  try {
    harness.click(historyEdit);
    await harness.settle();
    assert.equal(composer(harness).value, historicalPrompt);
    assert.equal(harness.document.activeElement, composer(harness));
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(cloneState(harness.readBootstrappedClientStateReference()).events, state.events);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /new request/i);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("editing another message asks before replacing an existing draft", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.input("#prompt", "Unsent draft");
    harness.click(historyEdit);
    assert.equal(composer(harness).value, "Unsent draft");
    await harness.cancelAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "Unsent draft");

    harness.click(historyEdit);
    assert.equal(harness.document.querySelector("#appConfirmationAccept")?.textContent, "Replace draft");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, historicalPrompt);
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a newer draft written during replacement confirmation is never overwritten", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.input("#prompt", "Draft when asked");
    harness.click(historyEdit);
    harness.input("#prompt", "Newer draft while waiting");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "Newer draft while waiting");
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a draft changed away and back during replacement still invalidates the old confirmation", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.input("#prompt", "Original draft");
    harness.click(historyEdit);
    harness.input("#prompt", "Intervening draft");
    harness.input("#prompt", "Original draft");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "Original draft");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("switching Session during replacement does not copy text into the new Session", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.input("#prompt", "Session one draft");
    harness.click(historyEdit);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.input("#prompt", "Session two draft");
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "Session two draft");
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(composer(harness).value, "Session one draft");
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("history edit stays locked while a send has unresolved authoritative state", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.failNextSend("Request outcome unavailable.", "unknown");
    harness.failNextState("Current state unavailable.");
    harness.input("#prompt", "Unresolved request");
    harness.click("#sendButton");
    await harness.settle();
    const button = harness.document.querySelector<HTMLButtonElement>(historyEdit);
    assert.ok(button);
    assert.equal(button.disabled, true);
    harness.click(historyEdit);
    assert.equal(composer(harness).value, "");
    assert.deepEqual(sentPrompts(harness), ["Unresolved request"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a send started during replacement confirmation prevents late draft restoration", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.input("#prompt", "Request submitted while waiting");
    harness.click(historyEdit);
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "");
    assert.deepEqual(sentPrompts(harness), ["Request submitted while waiting"]);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("history editing keeps consumed attachments in history and current pending files unchanged", async () => {
  const state = imageCapableState();
  state.openSettingsOnLoad = false;
  const consumed = pendingImage("consumed-image", "old.png", "image/png");
  const pending = pendingImage("pending-image", "new.png", "image/png");
  state.events = [{
    id: "history-user",
    kind: "user",
    content: historicalPrompt,
    createdAt: "2026-08-01T00:00:00.000Z",
    attachments: [consumed],
  }];
  state.pendingAttachments = [pending];
  const harness = await createDialogHarness(state);
  try {
    harness.click(historyEdit);
    await harness.settle();
    const current = cloneState(harness.readBootstrappedClientStateReference());
    assert.deepEqual(current.events, state.events);
    assert.deepEqual(current.pendingAttachments, [pending]);
    assert.equal(harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length, 1);
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /attachments.*history/i);
    assert.deepEqual(jsonCalls(harness, "/send"), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("explicitly editing a paused recovery replaces that head and preserves the queued tail", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Failed original");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Queued tail");
    submitComposer(harness);
    harness.input("#prompt", "Newer unsent draft");
    harness.failNextSend("The prompt was not saved.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();

    harness.click(recoveryEdit);
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "Failed original");
    harness.input("#prompt", "Edited recovery");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Failed original", "Edited recovery", "Queued tail"]);
    assert.notEqual(harness.sendIds[0], harness.sendIds[1]);
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("editing historical text detaches it from an automatically restored failed draft", async () => {
  const state = historyState();
  const harness = await createDialogHarness(state);
  try {
    harness.failNextSend("The original was not saved.", "not_persisted");
    harness.input("#prompt", historicalPrompt);
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(composer(harness).value, historicalPrompt);
    harness.click(historyEdit);
    await harness.settle();
    harness.input("#prompt", "Deliberate separate request");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), [historicalPrompt, "Deliberate separate request", historicalPrompt]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an edited recovery remains owned by its original Session across navigation", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.failNextSend("The original was not saved.", "not_persisted");
    harness.input("#prompt", "Failed original");
    harness.click("#sendButton");
    await harness.settle();
    harness.input("#prompt", "Edited for session one");
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.input("#prompt", "Session two draft");
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(composer(harness).value, "Edited for session one");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Failed original", "Edited for session one"]);
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(composer(harness).value, "Session two draft");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("editing a failed Slash submission restores its source and sends only the edited argument", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "/queue   original guidance  ");
    submitComposer(harness);
    await Promise.resolve();
    harness.input("#prompt", "Newer draft");
    harness.failNextSend("The guidance was not saved.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    harness.click(recoveryEdit);
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.equal(composer(harness).value, "/queue   original guidance  ");
    harness.input("#prompt", "/queue   edited guidance  ");
    submitComposer(harness);
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["original guidance", "edited guidance"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("repeated edited failures retain only the latest failed head before the original tail", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Original request");
    harness.click("#sendButton");
    await Promise.resolve();
    harness.input("#prompt", "Queued tail");
    submitComposer(harness);
    harness.failNextSend("Original was not saved.", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    const recoveryId = harness.document.querySelector<HTMLElement>(".queued-follow-up")?.dataset.queueId;
    assert.ok(recoveryId);

    harness.input("#prompt", "First revision");
    harness.failNextSend("Revision was not saved.", "not_persisted");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(composer(harness).value, "First revision");
    assert.equal(harness.document.querySelector<HTMLElement>(".queued-follow-up")?.dataset.queueId, recoveryId);
    assert.deepEqual(
      [...harness.document.querySelectorAll(".queued-follow-up .timeline-content")]
        .map((item) => item.textContent),
      ["First revision", "Queued tail"],
    );

    harness.input("#prompt", "Final revision");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Original request", "First revision", "Final revision", "Queued tail"]);
    assert.equal(new Set(harness.sendIds).size, 4);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const command of ["/compact", "/clear"]) {
  test(`consuming ${command} detaches its draft from the retained failed request`, async () => {
    const harness = await createDialogHarness(historyState());
    try {
      harness.failNextSend("The original was not saved.", "not_persisted");
      harness.input("#prompt", "Failed original");
      harness.click("#sendButton");
      await harness.settle();
      const recoveryId = harness.document.querySelector<HTMLElement>(".queued-follow-up")?.dataset.queueId;
      assert.ok(recoveryId);

      harness.input("#prompt", command);
      submitComposer(harness);
      await harness.settle();
      if (command === "/clear") {
        harness.click('.session-entry[data-session-id="session-1"] .session-row');
        await harness.settle();
      }
      assert.equal(composer(harness).value, "");
      assert.equal(harness.document.querySelector<HTMLElement>(".queued-follow-up")?.dataset.queueId, recoveryId);
      assert.deepEqual(sentPrompts(harness), ["Failed original"]);

      harness.input("#prompt", "Unrelated new request");
      harness.click("#sendButton");
      await harness.settle();
      assert.deepEqual(sentPrompts(harness), ["Failed original", "Unrelated new request", "Failed original"]);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("clearing and rewriting a restored draft still replaces the failed request", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.failNextSend("The original was not saved.", "not_persisted");
    harness.input("#prompt", "Failed original");
    harness.click("#sendButton");
    await harness.settle();
    harness.input("#prompt", "");
    harness.input("#prompt", "Rewritten failed request");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Failed original", "Rewritten failed request"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a command cannot detach a newer recovery edit when its source draft no longer matches", async () => {
  const harness = await createDialogHarness(historyState());
  try {
    harness.failNextSend("The original was not saved.", "not_persisted");
    harness.input("#prompt", "Failed original");
    harness.click("#sendButton");
    await harness.settle();
    harness.holdNextCommand();
    harness.input("#prompt", "/compact");
    submitComposer(harness);
    await Promise.resolve();
    harness.input("#prompt", "Edited original while the command ran");
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(composer(harness).value, "Edited original while the command ran");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["Failed original", "Edited original while the command ran"]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const content of ["/clear", "/unknown value", "/queue /clear", "/steer /compact", "/"]) {
  test(`historical literal ${JSON.stringify(content)} stays a message when edited and sent`, async () => {
    const state = historyState();
    state.events[0]!.content = content;
    const harness = await createDialogHarness(state);
    try {
      harness.click(historyEdit);
      await harness.settle();
      assert.equal(composer(harness).value, `/queue ${content}`);
      assert.equal(harness.document.querySelector('[data-event-id="history-user"] .timeline-content')?.textContent, content);
      harness.click("#sendButton");
      await harness.settle();
      assert.deepEqual(jsonCalls(harness, "/send").map((call) => call.body), [{
        prompt: content,
        sessionId: "session-1",
      }]);
      assert.deepEqual(commandCalls(harness), []);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

test("a failed edited literal command restores its safe composer source for further editing", async () => {
  const state = historyState();
  state.events[0]!.content = "/clear";
  const harness = await createDialogHarness(state);
  try {
    harness.click(historyEdit);
    await harness.settle();
    harness.failNextSend("The literal message was not saved.", "not_persisted");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(composer(harness).value, "/queue /clear");
    harness.input("#prompt", "/queue /unknown revised");
    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(sentPrompts(harness), ["/clear", "/unknown revised"]);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
