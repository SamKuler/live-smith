import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  cloneState,
  commandCalls,
  createDialogHarness,
  documentFile,
  pendingAudio,
  pendingDocument,
  stateFixture,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

type State = ReturnType<typeof stateFixture>;
const list = "#contextAttachmentList";
const preview = ".context-attachment-open";
const reuse = ".context-attachment-reuse";

function rows(harness: DialogHarness) {
  assert.deepEqual(harness.errors, []);
  return [...harness.document.querySelectorAll<HTMLLIElement>(`${list} .context-attachment-row`)];
}

function rowButton(row: HTMLLIElement, selector: string) {
  const button = row.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, selector);
  return button;
}

function message(id: string, ...attachments: NonNullable<State["events"][number]["attachments"]>): State["events"][number] {
  return { id, kind: "user", content: "Reference", createdAt: "2026-10-01T00:00:00.000Z", attachments };
}

function stateWithHistory() {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const historical = pendingDocument("prior-notes", "Notes.txt", "text/plain");
  state.events = [message("reference", historical)];
  return { state, historical };
}

test("Session attachments preview the exact audio files and excerpts retained after compaction", async () => {
  const { state, historical } = stateWithHistory();
  const sourceId = "source-audio";
  const excerpt = { ...pendingAudio("excerpt-one", "Audio excerpt.wav"), provenance: {
    sourceId, replacedIds: [], startSeconds: .25, endSeconds: .5,
  } };
  const otherExcerpt = { ...excerpt, id: "excerpt-two", provenance: {
    sourceId, replacedIds: [], startSeconds: .5, endSeconds: .75,
  } };
  state.events.push(message("legacy-reference", {
    kind: "audio", mediaType: "audio/mpeg", id: "legacy-audio", fileName: "Old recording.mp3",
    byteLength: 24, sha256: "e".repeat(64),
  }), message("audio-references", excerpt, otherExcerpt), {
    id: "checkpoint", kind: "compaction", content: "The discussion used these references.",
    createdAt: "2026-10-02T00:00:00.000Z",
  }, message("later-references",
    { ...historical, id: "notes-copy", provenance: { sourceId: historical.id, replacedIds: [] } },
    { ...excerpt, id: "excerpt-copy" },
  ));
  state.pendingAttachments = [
    { ...historical, id: "notes-draft", provenance: { sourceId: historical.id, replacedIds: [] } },
    { ...historical, id: "another-name", fileName: "Named separately.txt" },
  ];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#liveContextSummaryButton");
    const [pending, anotherName, firstExcerpt, secondExcerpt, legacyAudio] = rows(harness);
    assert.deepEqual(rows(harness).map((row) => rowButton(row, preview).textContent),
      ["Notes.txt", "Named separately.txt", "Audio excerpt.wav", "Audio excerpt.wav", "Old recording.mp3"]);
    for (const row of [pending!, anotherName!]) {
      assert.equal(row.querySelector<HTMLElement>(".context-attachment-status")?.hidden, false);
      assert.equal(rowButton(row, reuse).hidden, true);
    }
    for (const row of [firstExcerpt!, secondExcerpt!, legacyAudio!]) {
      assert.equal(rowButton(row, reuse).hidden, false);
      const fileButton = rowButton(row, preview);
      fileButton.click();
      const player = harness.document.querySelector<HTMLDialogElement>(".attachment-audio-editor");
      assert.ok(player);
      assert.equal(player.open, true);
      assert.equal(player.querySelector("h2")?.textContent, fileButton.textContent);
      harness.click(".attachment-audio-editor .attachment-open-external");
      await harness.settle();
      harness.click(".attachment-audio-editor .attachment-viewer-close");
      assert.equal(harness.document.querySelector(".attachment-audio-editor"), null);
    }
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [
      { kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: "excerpt-copy" },
      { kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: "excerpt-two" },
      { kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: "legacy-audio" },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("attaching during a reply uses the saved-copy route and keeps the queued file visible", async () => {
  const { state, historical } = stateWithHistory();
  const harness = await createDialogHarness(state);
  const requests: URL[] = [];
  const originalFetch = harness.window.fetch;
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === `/attachments/${historical.id}` && init?.method === "POST") {
      requests.push(url);
      harness.setServerState({
        ...cloneState(harness.readBootstrappedClientStateReference()),
        pendingAttachments: [{ ...historical, id: "notes-copy", provenance: { sourceId: historical.id, replacedIds: [] } }],
      });
      return originalFetch("http://bridge.test/state?token=test-token");
    }
    return originalFetch(input, init);
  } });
  try {
    harness.holdNextSend();
    harness.input("#prompt", "First request");
    harness.click("#sendButton");
    await harness.settle();
    assert.equal(harness.calls.filter((call) => call.path === "/send").length, 1);
    harness.click("#liveContextSummaryButton");
    const [row] = rows(harness);
    const button = rowButton(row!, reuse);
    button.click();
    await harness.settleAttachmentOperation();
    assert.equal(requests.length, 1);
    const { searchParams } = requests[0]!;
    assert.equal(searchParams.get("sessionId"), state.activeSessionId);
    assert.equal(searchParams.get("mode"), "copy");
    assert.equal(searchParams.get("replace"), "false");
    assert.equal(rows(harness).length, 1);
    assert.equal(rows(harness)[0], row);
    assert.equal(button.hidden, true);
    button.click();
    await harness.settle();
    assert.equal(requests.length, 1);
    assert.ok(harness.document.querySelector('#pendingAttachments [data-attachment-id="notes-copy"]'));
    harness.input("#prompt", "Follow up with the file");
    harness.document.querySelector("#prompt")!.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true,
    }));
    await harness.settle();
    assert.equal(harness.document.querySelector(".queued-follow-up")?.textContent?.includes(historical.fileName), true);
    assert.equal(harness.document.querySelector('#pendingAttachments [data-attachment-id="notes-copy"]'), null);
    assert.equal(rows(harness)[0], row);
    assert.equal(button.hidden, true);
    assert.equal(row!.querySelector<HTMLElement>(".context-attachment-status")?.hidden, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("Session attachment reuse respects an active file operation and leaves a rejected copy available to retry", async () => {
  const { state, historical } = stateWithHistory();
  const harness = await createDialogHarness(state);
  const failures = [
    { status: 404, message: "The saved attachment could not be found." },
    { status: 413, message: "The Session already has too many pending files." },
  ];
  const originalFetch = harness.window.fetch;
  let requests = 0;
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === `/attachments/${historical.id}` && init?.method === "POST") {
      const { message, status } = failures[requests++]!;
      return new Response(JSON.stringify({ error: message }), { status });
    }
    return originalFetch(input, init);
  } });
  try {
    harness.click("#liveContextSummaryButton");
    const [row] = rows(harness);
    const button = rowButton(row!, reuse);
    harness.holdNextAttachment();
    harness.dispatchDrop([documentFile(harness.window, "draft.txt", "text/plain")]);
    await harness.settle();
    assert.equal(button.disabled, true);
    assert.equal(rowButton(row!, preview).disabled, false);
    button.click();
    assert.equal(requests, 0);
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.equal(button.disabled, false);
    for (const failure of failures) {
      button.click();
      await harness.settleAttachmentOperation();
      assert.equal(harness.document.querySelector("#status")?.textContent, failure.message);
      assert.equal(button.disabled || button.hidden, false);
    }
    assert.equal(requests, 2);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("switching Session replaces the attachment rows and prevents clicks on detached prior-Session rows", async () => {
  const { state } = stateWithHistory();
  const harness = await createDialogHarness(state);
  try {
    harness.click("#liveContextSummaryButton");
    const [oldRow] = rows(harness);
    const oldOpen = rowButton(oldRow!, preview);
    const oldReuse = rowButton(oldRow!, reuse);
    harness.setServerState({
      ...cloneState(state), activeSessionId: "session-2",
      events: [message("other-reference", pendingDocument("other-file", "Other.txt", "text/plain"))],
    });
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.deepEqual(rows(harness).map((row) => rowButton(row, preview).textContent), ["Other.txt"]);
    oldOpen.click();
    oldReuse.click();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map(({ body }) => body), [
      { kind: "select_session", sessionId: "session-2" },
    ]);
    assert.equal(harness.calls.some((call) => call.path === "/attachments/prior-notes"), false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
