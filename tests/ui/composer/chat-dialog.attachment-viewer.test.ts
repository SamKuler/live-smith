import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  commandCalls,
  createDialogHarness,
  documentFile,
  imageCapableState,
  imageFile,
  pendingAudio,
  pendingDocument,
  pendingImage,
  stateFixture,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

type State = ReturnType<typeof stateFixture>;
interface ImageRead { url: URL; signal: AbortSignal | null | undefined }

function imageResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "Content-Type": "image/png" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

async function viewerHarness(
  state: State,
  reply: (read: ImageRead) => Promise<Response> = async () => imageResponse(),
) {
  state.openSettingsOnLoad = false;
  const created: string[] = [];
  const revoked: string[] = [];
  const reads: ImageRead[] = [];
  const harness = await createDialogHarness(state, undefined, {
    beforeParse(window) {
      Object.defineProperty(window.URL, "createObjectURL", {
        value: () => {
          const value = `blob:attachment-${created.length + 1}`;
          created.push(value);
          return value;
        },
      });
      Object.defineProperty(window.URL, "revokeObjectURL", { value: (value: string) => revoked.push(value) });
    },
  });
  const originalFetch = harness.window.fetch;
  Object.defineProperty(harness.window, "fetch", {
    configurable: true,
    value: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/attachments/") && (!init?.method || init.method === "GET")) {
        const read = { url, signal: init?.signal };
        reads.push(read);
        return reply(read);
      }
      return originalFetch(input, init);
    },
  });
  return { harness, created, revoked, reads };
}

function button(harness: DialogHarness, selector: string): HTMLButtonElement {
  const element = harness.document.querySelector<HTMLButtonElement>(selector);
  assert.ok(element, selector);
  return element;
}

function preview(harness: DialogHarness): HTMLDialogElement {
  const element = harness.document.querySelector<HTMLDialogElement>(".attachment-viewer");
  assert.ok(element);
  return element;
}

function finishImageLoad(harness: DialogHarness): HTMLImageElement {
  const image = harness.document.querySelector<HTMLImageElement>(".attachment-viewer-image");
  assert.ok(image);
  assert.ok(image.getAttribute("src"));
  image.dispatchEvent(new harness.window.Event("load"));
  return image;
}

function closePreview(harness: DialogHarness): void {
  harness.click(".attachment-viewer-close");
}

function attachmentOpenCommands(harness: DialogHarness): unknown[] {
  return commandCalls(harness).map((call) => call.body)
    .filter((body) => (body as { kind?: string }).kind === "open_attachment");
}

function observeAudio(audio: HTMLAudioElement) {
  let pauses = 0;
  let loads = 0;
  let playing = false;
  Object.defineProperty(audio, "paused", { configurable: true, get: () => !playing });
  const Event = audio.ownerDocument.defaultView!.Event;
  Object.defineProperty(audio, "play", { value: async () => { playing = true; audio.dispatchEvent(new Event("play")); } });
  Object.defineProperty(audio, "pause", { value: () => { playing = false; pauses += 1; audio.dispatchEvent(new Event("pause")); } });
  Object.defineProperty(audio, "load", { value: () => { audio.currentTime = 0; loads += 1; } });
  return { get pauses() { return pauses; }, get loads() { return loads; } };
}

test("inline images expose authenticated lazy previews in pending files and history and open on image click", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("draft-image", "draft.png")];
  state.events = [{ id: "inline-history", kind: "user", content: "Image reference", createdAt: "2026-10-01T00:00:00.000Z",
    attachments: [pendingImage("inline-image", "earlier.png")] }];
  const { harness, reads } = await viewerHarness(state);
  try {
    for (const [selector, id, fileName] of [
      ["#pendingAttachments .attachment-preview-image", "draft-image", "draft.png"],
      ["#timeline .attachment-preview-image", "inline-image", "earlier.png"],
    ]) {
      const image = harness.document.querySelector<HTMLImageElement>(selector!);
      assert.ok(image);
      const source = new URL(image.src);
      assert.equal(source.pathname, `/attachments/${id}`);
      assert.equal(source.searchParams.get("sessionId"), state.activeSessionId);
      assert.equal(source.searchParams.get("token"), "test-token");
      assert.equal(image.loading, "lazy");
      assert.equal(image.alt, fileName);
      image.dispatchEvent(new harness.window.Event("load"));
      assert.equal(image.hidden, false);
    }
    assert.equal(reads.length, 0);
    harness.click("#timeline .attachment-image-preview");
    await harness.settle();
    assert.equal(reads[0]!.url.pathname, "/attachments/inline-image");
    assert.equal(finishImageLoad(harness).alt, "earlier.png");
    closePreview(harness);
    harness.click("#pendingAttachments .attachment-image-preview");
    await harness.settle();
    assert.equal(reads.at(-1)!.url.pathname, "/attachments/draft-image");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("inline audio controls play and seek without autoplay and survive streaming updates", async () => {
  const state = stateFixture();
  state.events = [{ id: "audio-history", kind: "user", content: "Audio reference", createdAt: "2026-10-01T00:00:00.000Z",
    attachments: [pendingAudio("inline-audio", "take.wav")] }];
  const { harness, reads } = await viewerHarness(state);
  try {
    const audio = harness.document.querySelector<HTMLAudioElement>("#timeline .attachment-inline-audio");
    assert.ok(audio);
    const source = new URL(audio.src);
    assert.equal(source.pathname, "/attachments/inline-audio");
    assert.equal(source.searchParams.get("sessionId"), state.activeSessionId);
    assert.equal(source.searchParams.get("token"), "test-token");
    assert.equal(audio.controls, false);
    assert.equal(audio.preload, "none");
    assert.equal(audio.autoplay, false);
    const playback = observeAudio(audio);
    const seek = harness.document.querySelector<HTMLInputElement>("#timeline .attachment-audio-seek")!;
    const toggle = button(harness, "#timeline .attachment-audio-toggle");
    assert.equal(seek.disabled, true);
    assert.equal(harness.document.querySelector(".attachment-audio-time")?.textContent, "0:00 / 0:01");
    Object.defineProperty(audio, "duration", { configurable: true, value: 10 });
    audio.dispatchEvent(new harness.window.Event("loadedmetadata"));
    assert.equal(seek.disabled, false);
    toggle.click();
    await harness.settle();
    assert.equal(audio.paused, false);
    assert.equal(toggle.getAttribute("aria-label"), "Pause attached audio take.wav");
    seek.value = "1.25";
    seek.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    assert.equal(audio.currentTime, 1.25);
    assert.equal(seek.getAttribute("aria-valuetext"), "0:01 / 0:10");
    audio.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(attachmentOpenCommands(harness), []);
    harness.holdNextSend();
    harness.input("#prompt", "Describe the next section");
    harness.click("#sendButton");
    await harness.settle();
    harness.emitServerEvent({ type: "assistant_delta", sessionId: state.activeSessionId,
      sendId: harness.sendIds.at(-1), modelTurnEpoch: 0, delta: "The section starts" });
    harness.flushAnimationFrames();
    assert.equal(harness.document.querySelector("#timeline .attachment-inline-audio"), audio);
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 1.25);
    assert.equal(playback.pauses, 0);
    assert.equal(playback.loads, 0);
    assert.deepEqual(reads, []);
    toggle.click();
    assert.equal(audio.paused, true);
    assert.equal(toggle.getAttribute("aria-label"), "Play attached audio take.wav");
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(audio.paused, true);
    assert.equal(audio.hasAttribute("src"), false);
    assert.equal(audio.currentTime, 0);
    assert.equal(playback.pauses, 2);
    assert.equal(playback.loads, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("starting another attachment pauses the previous preview and preserves its playback position", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingAudio("draft-audio", "draft.wav")];
  state.events = [{ id: "audio-history", kind: "user", content: "Audio reference", createdAt: "2026-10-01T00:00:00.000Z",
    attachments: [pendingAudio("earlier-audio", "earlier.wav")] }];
  const { harness } = await viewerHarness(state);
  try {
    const earlier = harness.document.querySelector<HTMLAudioElement>("#timeline .attachment-inline-audio")!;
    const draft = harness.document.querySelector<HTMLAudioElement>("#pendingAttachments .attachment-inline-audio")!;
    observeAudio(earlier);
    observeAudio(draft);
    const earlierToggle = button(harness, "#timeline .attachment-audio-toggle");
    const draftToggle = button(harness, "#pendingAttachments .attachment-audio-toggle");
    earlierToggle.click();
    await harness.settle();
    earlier.currentTime = 0.5;
    draftToggle.click();
    await harness.settle();
    assert.equal(earlier.paused, true);
    assert.equal(earlier.currentTime, 0.5);
    assert.equal(earlierToggle.getAttribute("aria-label"), "Play attached audio earlier.wav");
    assert.equal(draft.paused, false);
    earlierToggle.click();
    await harness.settle();
    assert.equal(draft.paused, true);
    assert.equal(draftToggle.getAttribute("aria-label"), "Play attached audio draft.wav");
    assert.equal(earlier.paused, false);
    assert.equal(earlier.currentTime, 0.5);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("removing draft audio pauses its player and resets the resource without opening another app", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingAudio("draft-audio", "draft.wav")];
  const { harness } = await viewerHarness(state);
  try {
    const audio = harness.document.querySelector<HTMLAudioElement>("#pendingAttachments .attachment-inline-audio");
    assert.ok(audio);
    const playback = observeAudio(audio);
    await audio.play();
    audio.currentTime = 1;
    harness.click(".attachment-remove");
    await harness.settleAttachmentOperation();
    assert.equal(audio.isConnected, false);
    assert.equal(audio.paused, true);
    assert.equal(audio.hasAttribute("src"), false);
    assert.equal(audio.currentTime, 0);
    assert.equal(playback.pauses, 1);
    assert.equal(playback.loads, 1);
    assert.deepEqual(attachmentOpenCommands(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("inline media failures keep retry and native open reachable with safe feedback", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("failed-image", "failed.png"), pendingAudio("failed-audio", "failed.wav")];
  const { harness } = await viewerHarness(state);
  try {
    const image = harness.document.querySelector<HTMLImageElement>(".attachment-preview-image")!;
    image.dispatchEvent(new harness.window.Event("error"));
    assert.equal(image.hidden, true);
    assert.match(harness.document.querySelector('[data-attachment-id="failed-image"] [role="status"]')!.textContent!, /click to open the preview/i);
    harness.click(".attachment-image-preview");
    await harness.settle();
    assert.equal(finishImageLoad(harness).hidden, false);
    closePreview(harness);
    const audio = harness.document.querySelector<HTMLAudioElement>(".attachment-inline-audio")!;
    audio.dispatchEvent(new harness.window.Event("error"));
    const status = harness.document.querySelector<HTMLElement>('[data-attachment-id="failed-audio"] [role="status"]')!;
    assert.equal(status.hidden, false);
    assert.match(status.textContent!, /open the file in the default app/i);
    harness.click('[data-attachment-id="failed-audio"] .attachment-chip-label');
    await harness.settle();
    assert.deepEqual(attachmentOpenCommands(harness), [{
      kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: "failed-audio",
    }]);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("pagehide stops inline audio and clears image sources without repeating teardown", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("page-image", "reference.png"), pendingAudio("page-audio", "take.wav")];
  const { harness } = await viewerHarness(state);
  try {
    const audio = harness.document.querySelector<HTMLAudioElement>(".attachment-inline-audio")!;
    const image = harness.document.querySelector<HTMLImageElement>(".attachment-preview-image")!;
    const playback = observeAudio(audio);
    await audio.play();
    audio.currentTime = 1;
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    assert.equal(audio.paused, true);
    assert.equal(audio.hasAttribute("src"), false);
    assert.equal(audio.currentTime, 0);
    assert.equal(image.hasAttribute("src"), false);
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    assert.equal(playback.pauses, 1);
    assert.equal(playback.loads, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("cached pagehide pauses inline audio and preserves media for restored controls", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("cache-image", "reference.png"), pendingAudio("cache-audio", "take.wav")];
  const { harness } = await viewerHarness(state);
  try {
    const audio = harness.document.querySelector<HTMLAudioElement>(".attachment-inline-audio")!;
    const image = harness.document.querySelector<HTMLImageElement>(".attachment-preview-image")!;
    const playback = observeAudio(audio);
    const audioSource = audio.src; const imageSource = image.src;
    await audio.play(); audio.currentTime = 1;
    harness.window.dispatchEvent(new harness.window.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(audio.paused, true);
    assert.equal(audio.src, audioSource); assert.equal(image.src, imageSource);
    assert.equal(audio.currentTime, 1); assert.equal(playback.loads, 0);
    harness.window.dispatchEvent(new harness.window.PageTransitionEvent("pageshow", { persisted: true }));
    harness.emitServerEventOpen(); await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-inline-audio"), audio);
    harness.click(".attachment-audio-toggle"); await harness.settle();
    assert.equal(audio.paused, false);
    harness.window.dispatchEvent(new harness.window.PageTransitionEvent("pagehide", { persisted: false }));
    assert.equal(audio.hasAttribute("src"), false); assert.equal(image.hasAttribute("src"), false);
    assert.equal(playback.loads, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("pending image preview loads authenticated bytes, opens its exact file, and restores focus on Escape", async () => {
  const state = imageCapableState();
  state.pendingAttachments = [pendingImage("pending-image", "reference.png")];
  const { harness, reads, created, revoked } = await viewerHarness(state);
  try {
    const label = button(harness, '[data-attachment-id="pending-image"] .attachment-chip-label');
    label.focus();
    label.click();
    const dialog = preview(harness);
    assert.equal(dialog.getAttribute("aria-label"), "Image preview: reference.png");
    assert.equal(dialog.getAttribute("aria-busy"), "true");
    assert.equal(harness.document.activeElement, button(harness, ".attachment-viewer-close"));
    assert.match(dialog.querySelector('[role="status"]')!.textContent!, /loading image/i);
    await harness.settle();
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.url.pathname, "/attachments/pending-image");
    assert.equal(reads[0]!.url.searchParams.get("sessionId"), state.activeSessionId);
    assert.equal(reads[0]!.url.searchParams.get("token"), "test-token");
    const image = finishImageLoad(harness);
    assert.equal(image.alt, "reference.png");
    assert.equal(image.hidden, false);
    assert.equal(dialog.getAttribute("aria-busy"), "false");
    assert.equal(dialog.querySelector<HTMLElement>(".attachment-viewer-status")!.hidden, true);

    const native = button(harness, ".attachment-viewer-actions button:last-child");
    button(harness, ".attachment-viewer-close").dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Tab", shiftKey: true, bubbles: true, cancelable: true,
    }));
    assert.equal(harness.document.activeElement, native);
    native.click();
    await harness.settle();
    assert.deepEqual(attachmentOpenCommands(harness), [{
      kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: "pending-image",
    }]);
    assert.equal(preview(harness), dialog);
    native.dispatchEvent(new harness.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.equal(harness.document.activeElement, label);
    assert.deepEqual(revoked, created);
    assert.equal(reads[0]!.signal!.aborted, true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("historical image preview closes through the dialog cancel event without changing messages", async () => {
  const state = stateFixture();
  state.events = [{ id: "history-message", kind: "user", content: "Reference", createdAt: "2026-10-01T00:00:00.000Z",
    attachments: [pendingImage("history-image", "earlier.png")] }];
  const { harness, reads, revoked, created } = await viewerHarness(state);
  try {
    const label = button(harness, '[data-event-id="history-message"] .timeline-attachment-open');
    label.focus();
    label.click();
    await harness.settle();
    finishImageLoad(harness);
    assert.equal(reads[0]!.url.pathname, "/attachments/history-image");
    preview(harness).dispatchEvent(new harness.window.Event("cancel", { cancelable: true }));
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.equal(harness.document.activeElement, label);
    assert.equal(harness.readBootstrappedClientStateReference().events[0]!.id, "history-message");
    assert.deepEqual(revoked, created);
    assert.deepEqual(attachmentOpenCommands(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("document, audio, MIDI, and historical Office references submit their own immutable Session identities", async () => {
  const state = stateFixture();
  const attachments = [pendingDocument("pdf-file", "score.pdf", "application/pdf"),
    pendingDocument("text-file", "notes.txt", "text/plain"),
    pendingDocument("midi-file", "melody.mid", "audio/midi"),
    pendingAudio("audio-file", "reference.wav")];
  state.pendingAttachments = attachments;
  const historical = pendingDocument("old-file", "score.doc", "application/msword");
  state.events = [{ id: "old-message", kind: "user", content: "Earlier document", createdAt: "2026-10-01T00:00:00.000Z",
    attachments: [historical] }];
  const { harness, reads, created } = await viewerHarness(state);
  try {
    for (const attachment of attachments) {
      harness.click(`#pendingAttachments [data-attachment-id="${attachment.id}"] .attachment-chip-label`);
      await harness.settle();
    }
    harness.click('[data-event-id="old-message"] .timeline-attachment-open');
    await harness.settle();
    assert.deepEqual(attachmentOpenCommands(harness), [...attachments, historical].map((attachment) => ({
      kind: "open_attachment", sessionId: state.activeSessionId, attachmentId: attachment.id,
    })));
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.deepEqual(reads, []);
    assert.deepEqual(created, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("removing a pending image never opens a preview or native application", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("remove-image", "remove.png")];
  const { harness, reads, created } = await viewerHarness(state);
  try {
    harness.click('[data-attachment-id="remove-image"] .attachment-remove');
    await harness.settleAttachmentOperation();
    assert.equal(harness.document.querySelector('[data-attachment-id="remove-image"]'), null);
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.deepEqual(attachmentOpenCommands(harness), []);
    assert.deepEqual(reads, []);
    assert.deepEqual(created, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a stored image stays viewable while another file uploads and removal is locked", async () => {
  const state = imageCapableState();
  state.pendingAttachments = [pendingImage("stored-image", "stored.png")];
  const { harness, reads } = await viewerHarness(state);
  try {
    harness.holdNextAttachment();
    harness.dispatchDrop([documentFile(harness.window, "new.txt", "text/plain")]);
    await harness.settle();
    assert.equal(button(harness, '[data-attachment-id="stored-image"] .attachment-remove').disabled, true);
    const label = button(harness, '[data-attachment-id="stored-image"] .attachment-chip-label');
    assert.equal(label.disabled, false);
    label.click();
    await harness.settle();
    assert.equal(finishImageLoad(harness).hidden, false);
    assert.equal(reads[0]!.url.pathname, "/attachments/stored-image");
    closePreview(harness);
    harness.releaseHeldAttachment();
    await harness.settleAttachmentOperation();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("pending-message and queued images remain viewable while generation runs", async () => {
  const state = imageCapableState();
  state.pendingAttachments = [pendingImage("send-image", "first.png")];
  const { harness, reads } = await viewerHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Initial request");
    harness.click("#sendButton");
    await harness.settle();
    harness.click(".local-user-message .timeline-attachment-open");
    await harness.settle();
    finishImageLoad(harness);
    assert.equal(reads.at(-1)!.url.pathname, "/attachments/send-image");
    closePreview(harness);
    harness.dispatchDrop([imageFile(harness.window, "queued.png", "image/png")]);
    await harness.settleAttachmentOperation();
    const queuedId = harness.document.querySelector<HTMLElement>("#pendingAttachments [data-attachment-id]")!.dataset.attachmentId!;
    harness.input("#prompt", "Follow-up request");
    harness.document.querySelector("#prompt")!.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true,
    }));
    await harness.settle();
    harness.click(".queued-follow-up .timeline-attachment-open");
    await harness.settle();
    assert.equal(finishImageLoad(harness).hidden, false);
    assert.equal(reads.at(-1)!.url.pathname, `/attachments/${queuedId}`);
    assert.equal(reads.at(-1)!.url.searchParams.get("sessionId"), state.activeSessionId);
    assert.equal(harness.calls.filter((call) => call.path === "/send").length, 1);
    assert.equal(harness.document.querySelectorAll(".queued-follow-up").length, 1);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("closing a loading preview aborts the read and ignores its late response", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("late-image", "late.png")];
  const held = deferredResponse();
  const { harness, reads, created } = await viewerHarness(state, () => held.promise);
  try {
    harness.click(".attachment-chip-label");
    closePreview(harness);
    assert.equal(reads[0]!.signal!.aborted, true);
    held.resolve(imageResponse());
    await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.deepEqual(created, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an earlier read cannot populate a newer image preview", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("old-image", "old.png"), pendingImage("new-image", "new.png")];
  const held = deferredResponse();
  const { harness, reads, created, revoked } = await viewerHarness(state, (read) =>
    read.url.pathname.endsWith("old-image") ? held.promise : Promise.resolve(imageResponse()));
  try {
    harness.click('[data-attachment-id="old-image"] .attachment-chip-label');
    harness.click('[data-attachment-id="new-image"] .attachment-chip-label');
    await harness.settle();
    const image = finishImageLoad(harness);
    assert.equal(image.alt, "new.png");
    assert.equal(reads[0]!.signal!.aborted, true);
    held.resolve(imageResponse());
    await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-viewer-image"), image);
    assert.deepEqual(created, ["blob:attachment-1"]);
    closePreview(harness);
    assert.deepEqual(revoked, created);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("switching Session revokes a preview and stale attachment buttons cannot open under the new Session", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("session-image", "reference.png"), pendingDocument("session-document", "notes.txt", "text/plain")];
  const { harness, created, revoked } = await viewerHarness(state);
  try {
    const staleImage = button(harness, '[data-attachment-id="session-image"] .attachment-chip-label');
    const staleDocument = button(harness, '[data-attachment-id="session-document"] .attachment-chip-label');
    staleImage.click();
    await harness.settle();
    finishImageLoad(harness);
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(button(harness, '[data-session-id="session-2"] .session-row').getAttribute("aria-pressed"), "true");
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.deepEqual(revoked, created);
    staleImage.click();
    staleDocument.click();
    await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.deepEqual(attachmentOpenCommands(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Session change during a read prevents a late response from restoring the old preview", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("session-image", "reference.png")];
  const held = deferredResponse();
  const { harness, reads, created } = await viewerHarness(state, () => held.promise);
  try {
    harness.click(".attachment-chip-label");
    harness.click('[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.equal(reads[0]!.signal!.aborted, true);
    held.resolve(imageResponse());
    await harness.settle();
    assert.deepEqual(created, []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("missing images and invalid media replies give safe retry feedback, and decode failures revoke bytes", async () => {
  for (const failure of [new Response(JSON.stringify({ error: "private /Users/local/image token=secret" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  }), new Response("<html>private response</html>", { headers: { "Content-Type": "text/html" } })]) {
    const state = stateFixture();
    state.pendingAttachments = [pendingImage("retry-image", "reference.png")];
    let first = true;
    const { harness, reads, created, revoked } = await viewerHarness(state, async () => {
      if (!first) return imageResponse();
      first = false;
      return failure;
    });
    try {
      harness.click(".attachment-chip-label");
      await harness.settle();
      assert.equal(preview(harness).getAttribute("aria-busy"), "false");
      assert.match(preview(harness).textContent!, /could not be loaded/i);
      assert.doesNotMatch(preview(harness).textContent!, /private|\/Users|secret|<html>/i);
      assert.deepEqual(created, []);
      harness.click(".attachment-viewer-actions button:not([hidden])");
      await harness.settle();
      const image = harness.document.querySelector<HTMLImageElement>(".attachment-viewer-image")!;
      image.dispatchEvent(new harness.window.Event("error"));
      assert.equal(image.hasAttribute("src"), false);
      assert.deepEqual(revoked, created);
      assert.match(preview(harness).textContent!, /could not be loaded/i);
      harness.click(".attachment-viewer-actions button:not([hidden])");
      await harness.settle();
      finishImageLoad(harness);
      assert.equal(reads.length, 3);
      assert.equal(harness.document.querySelector<HTMLElement>(".attachment-viewer-status")!.hidden, true);
      closePreview(harness);
      assert.deepEqual(revoked, created);
      assert.deepEqual(harness.errors, []);
    } finally { harness.close(); }
  }
});

test("failed native open inside an image preview stays retryable without clearing its image", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("native-image", "reference.png")];
  const { harness, revoked } = await viewerHarness(state);
  try {
    harness.click(".attachment-chip-label");
    await harness.settle();
    const image = finishImageLoad(harness);
    harness.failNextCommand("File is no longer available.");
    harness.click(".attachment-viewer-actions button:last-child");
    await harness.settle();
    assert.match(harness.document.querySelector(".attachment-viewer-open-status")!.textContent!, /could not be opened/i);
    const native = button(harness, ".attachment-viewer-actions button:last-child");
    assert.equal(native.disabled, false);
    assert.equal(image.hidden, false);
    assert.deepEqual(revoked, []);
    native.click();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLElement>(".attachment-viewer-open-status")!.hidden, true);
    assert.equal(attachmentOpenCommands(harness).length, 2);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("pagehide closes the image preview and releases its object URL once", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingImage("closing-image", "reference.png")];
  const { harness, reads, created, revoked } = await viewerHarness(state);
  try {
    harness.click(".attachment-chip-label");
    await harness.settle();
    finishImageLoad(harness);
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    assert.equal(harness.document.querySelector(".attachment-viewer"), null);
    assert.equal(reads[0]!.signal!.aborted, true);
    assert.deepEqual(revoked, created);
    harness.window.dispatchEvent(new harness.window.Event("pagehide"));
    assert.deepEqual(revoked, created);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});


test("audio play rejection shows retryable feedback and ended playback restores the play action", async () => {
  const state = stateFixture();
  state.pendingAttachments = [pendingAudio("play-error", "take.wav")];
  const { harness } = await viewerHarness(state);
  try {
    const audio = harness.document.querySelector<HTMLAudioElement>(".attachment-inline-audio")!;
    Object.defineProperty(audio, "play", { configurable: true, value: async () => { throw new Error("Decoder failed"); } });
    harness.click(".attachment-audio-toggle");
    await harness.settle();
    const notice = harness.document.querySelector<HTMLElement>(".attachment-media-unavailable")!;
    assert.equal(notice.hidden, false);
    const playback = observeAudio(audio);
    harness.click(".attachment-audio-toggle");
    await harness.settle();
    assert.equal(notice.hidden, true);
    assert.equal(audio.paused, false);
    Object.defineProperty(audio, "ended", { value: true });
    audio.dispatchEvent(new harness.window.Event("ended"));
    assert.equal(button(harness, ".attachment-audio-toggle").getAttribute("aria-label"), "Play attached audio take.wav");
    assert.equal(playback.pauses, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
