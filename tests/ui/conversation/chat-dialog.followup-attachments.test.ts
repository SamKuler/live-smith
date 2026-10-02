import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PENDING_ATTACHMENT_COUNT } from "../../../src/attachments/contracts.js";
import {
  cloneState, createDialogHarness, documentFile, jsonCalls, pendingDocument, stateFixture, waitForCondition,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

function submit(harness: DialogHarness, prompt: string) {
  harness.input("#prompt", prompt);
  harness.document.querySelector("#prompt")!.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
    bubbles: true, ctrlKey: true, key: "Enter",
  }));
}

function selection(harness: DialogHarness, path: string, index = -1): string[] {
  const call = harness.calls.filter((candidate) => candidate.path === path).at(index);
  assert.ok(call);
  return JSON.parse(new Headers(call.headers).get("X-Live-Smith-Attachment-Ids")!);
}

async function attach(harness: DialogHarness, name: string) {
  await harness.settle();
  harness.dispatchDrop([documentFile(harness.window, name, "text/plain")]);
  await harness.settle();
  await harness.settleAttachmentOperation();
  const chip = [...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")]
    .find((entry) => entry.textContent?.includes(name));
  assert.ok(chip, harness.document.querySelector("#status")?.textContent ?? "Missing uploaded file");
  return pendingDocument(chip.dataset.attachmentId!, name, "text/plain");
}

function startState(behavior: "queue" | "steer") {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.defaultFollowUpBehavior = behavior;
  return state;
}

test("generation accepts files and upload leaves the text draft editable while submission waits", async () => {
  const harness = await createDialogHarness(startState("queue"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), []);
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#attachmentMenuButton")!.disabled, false);
    harness.holdNextAttachment();
    harness.dispatchDrop([documentFile(harness.window, "notes.txt", "text/plain")]);
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.disabled, false);
    submit(harness, "Draft written during upload");
    assert.equal(harness.document.querySelector(".queued-follow-up"), null);
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Draft written during upload");
    assert.match(harness.document.querySelector("#pendingAttachments")!.textContent!, /notes.txt/);
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Queue binds each file to its message and leaves later draft files out of promoted sends", async () => {
  const harness = await createDialogHarness(startState("queue"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const first = await attach(harness, "first.txt");
    submit(harness, "First follow-up");
    await harness.settle();
    assert.match(harness.document.querySelector(".queued-follow-up")!.textContent!, /first.txt/);
    assert.equal(harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length, 0);
    const second = await attach(harness, "second.txt");
    submit(harness, "Second follow-up");
    const draft = await attach(harness, "draft.txt");
    harness.input("#prompt", "Later draft");
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), [first.id]);
    assert.equal(harness.document.querySelectorAll(".queued-follow-up").length, 1);
    assert.match(harness.document.querySelector("#pendingAttachments")!.textContent!, /draft.txt/);
    const state = { ...cloneState(harness.readBootstrappedClientStateReference()), pendingAttachments: [second, draft] };
    state.events.push({ id: "first-follow-up", kind: "user", content: "First follow-up", attachments: [first], createdAt: new Date().toISOString() });
    harness.setServerState(state);
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), [second.id]);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Later draft");
    assert.deepEqual([...harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]")].map((chip) => (chip as HTMLElement).dataset.attachmentId), [draft.id]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Steer snapshots attachments and its acknowledgement preserves a newer uploaded draft", async () => {
  const harness = await createDialogHarness(startState("steer"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const first = await attach(harness, "guidance.txt");
    harness.holdNextSteer();
    submit(harness, "Use this guidance");
    await harness.settle();
    assert.deepEqual(selection(harness, "/steer"), [first.id]);
    const draft = await attach(harness, "later.txt");
    harness.input("#prompt", "Newer draft");
    harness.releaseHeldSteer();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Newer draft");
    assert.deepEqual([...harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]")].map((chip) => (chip as HTMLElement).dataset.attachmentId), [draft.id]);
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("uncertain Steer retries its original file snapshot rather than including a newer attachment", async () => {
  const harness = await createDialogHarness(startState("steer"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const first = await attach(harness, "guidance.txt");
    harness.failNextSteer("Receipt unavailable", "unknown");
    submit(harness, "Guidance");
    await harness.settle();
    const later = await attach(harness, "later.txt");
    submit(harness, "Guidance");
    await harness.settle();
    const calls = harness.calls.filter((call) => call.path === "/steer");
    assert.equal(calls.length, 2);
    assert.deepEqual(selection(harness, "/steer", 0), [first.id]);
    assert.deepEqual(selection(harness, "/steer", 1), [first.id]);
    assert.equal(new Headers(calls[0]!.headers).get("X-Live-Smith-Steer-Id"), new Headers(calls[1]!.headers).get("X-Live-Smith-Steer-Id"));
    assert.equal(harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]").length, 1);
    assert.equal((harness.document.querySelector("#pendingAttachments [data-attachment-id]") as HTMLElement).dataset.attachmentId, later.id);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a rejected Steer leaves its file in the editable draft", async () => {
  const harness = await createDialogHarness(startState("steer"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const first = await attach(harness, "guidance.txt");
    harness.failNextSteer("File cannot be included");
    submit(harness, "Guidance");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Guidance");
    assert.equal((harness.document.querySelector("#pendingAttachments [data-attachment-id]") as HTMLElement).dataset.attachmentId, first.id);
    assert.equal(harness.document.querySelector<HTMLButtonElement>(".attachment-remove")!.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("persisted send attachments release the upload quota while the model is still generating", async () => {
  const state = startState("queue");
  state.pendingAttachments = Array.from({ length: MAX_PENDING_ATTACHMENT_COUNT }, (_, index) =>
    pendingDocument("initial-" + index, "initial-" + index + ".txt", "text/plain"));
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    submit(harness, "Read these files");
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), state.pendingAttachments.map((attachment) => attachment.id));
    harness.emitServerEvent({ type: "session_event", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      event: { id: "persisted-initial-user", kind: "user", content: "Read these files",
        createdAt: "2026-10-02T01:00:00.000Z", attachments: state.pendingAttachments } });
    assert.equal(harness.readBootstrappedClientStateReference().pendingAttachments.length, 0);
    const next = await attach(harness, "next.txt");
    assert.equal(harness.calls.filter((call) => call.path === "/attachments").length, 1);
    assert.deepEqual([...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")]
      .map((chip) => chip.dataset.attachmentId), [next.id]);
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a late upload snapshot keeps the newer persisted consumption and the uploaded draft file", async () => {
  const state = startState("queue");
  const initial = pendingDocument("initial-file", "initial.txt", "text/plain");
  state.pendingAttachments = [initial];
  const harness = await createDialogHarness(state);
  let uploadSnapshotCaptured = false;
  let releaseUpload!: () => void;
  const uploadResponse = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const originalFetch = harness.window.fetch;
  const delayedFetch: typeof harness.window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === "/attachments" && init?.method === "POST") {
      const snapshot = await response.json();
      uploadSnapshotCaptured = true;
      response.json = async () => { await uploadResponse; return snapshot; };
    }
    return response;
  };
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: delayedFetch });
  try {
    harness.holdNextSend();
    submit(harness, "Read the initial file");
    await harness.settle();
    harness.dispatchDrop([documentFile(harness.window, "next.txt", "text/plain")]);
    await harness.settle();
    await waitForCondition(() => uploadSnapshotCaptured,
      "Expected the upload snapshot before the send's persisted event arrives.");
    harness.emitServerEvent({ type: "session_event", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      event: { id: "persisted-during-upload", kind: "user", content: "Read the initial file",
        createdAt: "2026-10-02T01:00:00.000Z", attachments: [initial] } });
    releaseUpload();
    await harness.settleAttachmentOperation();
    assert.ok(harness.document.querySelector('[data-event-id="persisted-during-upload"]'));
    const chips = [...harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]")];
    assert.equal(chips.length, 1);
    assert.match(chips[0]!.textContent!, /next\.txt/);
    assert.equal((chips[0] as HTMLElement).dataset.attachmentId === initial.id, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    releaseUpload();
    await harness.settleAttachmentOperation();
    harness.close();
  }
});

for (const attachBeforePromotion of [true, false]) {
  for (const switchBeforeFailure of [false, true]) {
    test(`failed queued sends preserve a file-only draft uploaded ${attachBeforePromotion ? "before" : "after"} promotion${switchBeforeFailure ? " across Session changes" : ""}`, async () => {
      const harness = await createDialogHarness(startState("queue"));
      try {
        harness.holdNextSend();
        submit(harness, "Initial request");
        const queuedFile = await attach(harness, "queued.txt");
        submit(harness, "Queued request");
        let draftFile = attachBeforePromotion ? await attach(harness, "draft.txt") : undefined;
        harness.holdNextSend();
        harness.releaseHeldSend();
        await harness.settle();
        assert.deepEqual(selection(harness, "/send"), [queuedFile.id]);
        if (!draftFile) draftFile = await attach(harness, "draft.txt");
        if (switchBeforeFailure) {
          harness.click('.session-entry[data-session-id="session-2"] .session-row');
          await harness.settle();
        }
        harness.failNextSend("Queued request was not persisted", "not_persisted");
        harness.releaseHeldSend();
        await harness.settle();
        if (switchBeforeFailure) {
          harness.click('.session-entry[data-session-id="session-1"] .session-row');
          await harness.settle();
        }
        assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "");
        assert.deepEqual([...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")]
          .map((chip) => chip.dataset.attachmentId), [draftFile.id]);
        const failed = harness.document.querySelector(".queued-follow-up.message-recovery")!;
        assert.ok(failed);
        assert.match(failed.textContent!, /queued\.txt/);
        assert.doesNotMatch(failed.textContent!, /draft\.txt/);
        harness.holdNextSend();
        submit(harness, "Use the new draft file");
        await harness.settle();
        assert.deepEqual(selection(harness, "/send"), [draftFile.id]);
        assert.equal(jsonCalls(harness, "/send").length, 3);
        assert.deepEqual(harness.errors, []);
      } finally { harness.close(); }
    });
  }
}

test("a file upload admitted before queued send failure preserves the draft before the upload completes", async () => {
  const harness = await createDialogHarness(startState("queue"));
  let heldUpload = false;
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const queuedFile = await attach(harness, "queued.txt");
    submit(harness, "Queued request");
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), [queuedFile.id]);
    harness.holdNextAttachment(); heldUpload = true;
    harness.dispatchDrop([documentFile(harness.window, "draft.txt", "text/plain")]);
    await harness.settle();
    await waitForCondition(() => harness.calls.filter((call) => call.path === "/attachments").length === 2,
      "Expected the new draft upload to be admitted before the send fails.");
    harness.failNextSend("Queued request was not persisted", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "");
    harness.releaseHeldAttachment(); heldUpload = false;
    await harness.settleAttachmentOperation();
    const chips = [...harness.document.querySelectorAll("#pendingAttachments [data-attachment-id]")];
    assert.equal(chips.length, 1);
    assert.match(chips[0]!.textContent!, /draft\.txt/);
    assert.match(harness.document.querySelector(".queued-follow-up.message-recovery")!.textContent!, /queued\.txt/);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (heldUpload) { harness.releaseHeldAttachment(); await harness.settleAttachmentOperation(); }
    harness.close();
  }
});

test("a queued send promoted in a background Session leaves failed recovery available for explicit editing", async () => {
  const harness = await createDialogHarness(startState("queue"));
  try {
    harness.holdNextSend();
    submit(harness, "Initial request");
    const queuedFile = await attach(harness, "queued.txt");
    submit(harness, "Queued request");
    const draftFile = await attach(harness, "draft.txt");
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(selection(harness, "/send"), [queuedFile.id]);
    harness.failNextSend("Queued request was not persisted", "not_persisted");
    harness.releaseHeldSend();
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "");
    assert.deepEqual([...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")]
      .map((chip) => chip.dataset.attachmentId), [draftFile.id]);
    const failed = harness.document.querySelector(".queued-follow-up.message-recovery")!;
    assert.ok(failed);
    assert.match(failed.textContent!, /queued\.txt/);
    const edit = [...failed.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "Edit and resend")!;
    assert.ok(edit);
    assert.equal(edit.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
