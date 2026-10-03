import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { URL } from "node:url";
import { inspectAudioAttachment } from "../../../src/attachments/audio.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";
import { audioCapableState, cloneState, createDialogHarness, pendingAudio, pendingDocument, waitForCondition, type DialogHarness } from "../support/chat-dialog.test-harness.js";

type SelectionCall = { url: URL; init: RequestInit };
async function setup(options: { lostResponse?: boolean; mp3?: boolean; deferredRead?: boolean } = {}) {
  const state = audioCapableState(); state.openSettingsOnLoad = false;
  const attachment = pendingAudio("original-audio", "Reference.wav", options.mp3 ? "audio/mpeg" : "audio/wav", 8044, 1);
  assert.ok(attachment.kind === "audio");
  state.pendingAttachments = [attachment];
  const selections: SelectionCall[] = [];
  let decodeCount = 0;
  let releaseRead!: () => void;
  let readSignal: AbortSignal | null | undefined;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  const harness = await createDialogHarness(state, undefined, {
    beforeParse(window) {
      Object.defineProperty(window.HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} });
      if (options.mp3) Object.defineProperty(window, "AudioContext", { value: class {
        async decodeAudioData() { decodeCount++; return { sampleRate: 48000, numberOfChannels: 2, length: 48000, duration: 1, getChannelData: () => new Float32Array(48000).fill(.5) }; }
        async close() {}
      } });
    },
  });
  const fetchOriginal = harness.window.fetch;
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/attachments/") && (!init?.method || init.method === "GET")) {
      readSignal = init?.signal;
      if (options.deferredRead) await heldRead;
      return new Response(new Uint8Array(waveBytes(1)), { headers: { "Content-Type": options.mp3 ? "audio/mpeg" : "audio/wav" } });
    }
    if (url.pathname.startsWith("/attachments/") && init?.method === "POST") {
      selections.push({ url, init });
      const current = cloneState(harness.readBootstrappedClientStateReference());
      const copy = url.searchParams.get("mode") === "copy";
      const next = { ...attachment, id: `selected-${selections.length}`, fileName: copy ? attachment.fileName : "Reference [0.250-0.500s].wav", mediaType: "audio/wav" as const, durationSeconds: copy ? 1 : .25,
        provenance: { sourceId: attachment.id, replacedIds: url.searchParams.get("replace") === "true" ? [attachment.id] : [], ...(copy ? {} : { startSeconds: .25, endSeconds: .5 }) } };
      harness.setServerState({ ...current, pendingAttachments: [next] });
      if (options.lostResponse) throw new Error("Interrupted response");
      return fetchOriginal("http://bridge.test/state?token=test-token");
    }
    return fetchOriginal(input, init);
  } });
  return { harness, selections, attachment, releaseRead, get readSignal() { return readSignal; }, get decodeCount() { return decodeCount; } };
}

async function openEditor(harness: DialogHarness) {
  harness.click("#pendingAttachments .attachment-audio-select");
  await waitForCondition(() => !harness.document.querySelector<HTMLInputElement>(".attachment-selection-start")?.disabled, "Expected the waveform and selection to be ready");
}
function field(harness: DialogHarness, selector: string, value: string) { harness.input(selector, value); }

test("waveform range, loop audition and excerpt submission replace only the next-request file", async () => {
  const { harness, selections } = await setup();
  try {
    await openEditor(harness);
    const waveform = harness.document.querySelector(".attachment-waveform path")!;
    assert.ok(waveform.getAttribute("d"));
    field(harness, ".attachment-selection-start", ".25"); field(harness, ".attachment-selection-end", ".5");
    const media = harness.document.querySelector<HTMLAudioElement>(".attachment-selection-audio")!;
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    media.currentTime = .51; media.dispatchEvent(new harness.window.Event("timeupdate"));
    assert.equal(media.currentTime, .25);
    const loop = harness.document.querySelector<HTMLInputElement>(".attachment-selection-loop")!; loop.checked = false;
    media.currentTime = .6; media.dispatchEvent(new harness.window.Event("timeupdate")); assert.equal(media.currentTime, .5);
    field(harness, ".attachment-selection-end", ".1");
    assert.equal(harness.document.querySelector<HTMLButtonElement>(".attachment-use-excerpt")!.disabled, true);
    assert.equal(selections.length, 0);
    field(harness, ".attachment-selection-end", ".5"); harness.click(".attachment-use-excerpt");
    await harness.settleAttachmentOperation();
    assert.equal(selections.length, 1); assert.equal(selections[0]!.url.searchParams.get("mode"), "excerpt");
    assert.equal(selections[0]!.url.searchParams.get("start"), "0.25"); assert.equal(selections[0]!.url.searchParams.get("end"), "0.5");
    assert.equal(selections[0]!.url.searchParams.get("replace"), "true");
    assert.deepEqual([...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")].map((chip) => chip.dataset.attachmentId), ["selected-1"]);
    assert.match(harness.document.querySelector(".attachment-selection-label")!.textContent!, /0\.250–0\.500 s/);
    assert.match(harness.document.querySelector(".attachment-remove")!.getAttribute("aria-label")!, /Undo selection/);
    assert.equal(harness.document.querySelector(".attachment-audio-editor"), null);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("MP3 waveform inspection never uploads; only explicit WAV export submits converted samples", async () => {
  const scenario = await setup({ mp3: true }); const { harness, selections } = scenario;
  try {
    await openEditor(harness); assert.equal(scenario.decodeCount, 1); assert.equal(selections.length, 0);
    assert.match(harness.document.querySelector(".attachment-selection-note")!.textContent!, /16-bit PCM WAV.*original MP3 is kept/);
    field(harness, ".attachment-selection-start", ".25"); field(harness, ".attachment-selection-end", ".5");
    harness.click(".attachment-use-excerpt"); await harness.settleAttachmentOperation();
    await waitForCondition(() => selections.length === 1, "Expected the explicit converted selection submission");
    const call = selections[0]!; assert.equal(call.url.searchParams.get("mode"), "convert-mp3");
    const bytes = new Uint8Array(call.init.body as unknown as Uint8Array);
    const inspection = await inspectAudioAttachment({ bytes });
    assert.deepEqual(inspection, { mediaType: "audio/wav", durationSeconds: .25, sampleRate: 48000, channels: 2 });
    assert.equal(Buffer.from(bytes).readUInt16LE(34), 16);
  } finally { harness.close(); }
});

test("closing an audio selection cancels its read and a late waveform cannot submit anything", async () => {
  const scenario = await setup({ deferredRead: true }); const { harness, selections } = scenario;
  try {
    harness.click("#pendingAttachments .attachment-audio-select"); await harness.settle();
    harness.click(".attachment-viewer-close");
    assert.equal(scenario.readSignal?.aborted, true);
    scenario.releaseRead(); await harness.settle();
    assert.equal(harness.document.querySelector(".attachment-audio-editor"), null); assert.equal(selections.length, 0);
    assert.match(harness.document.querySelector("#pendingAttachments")!.textContent!, /Reference.wav/);
    assert.deepEqual(harness.errors, []);
  } finally { scenario.releaseRead(); harness.close(); }
});

test("response loss reconciles the new excerpt without restoring or resubmitting its source", async () => {
  const { harness, selections } = await setup({ lostResponse: true });
  try {
    await openEditor(harness); field(harness, ".attachment-selection-start", ".25"); field(harness, ".attachment-selection-end", ".5");
    harness.click(".attachment-use-excerpt"); await harness.settleAttachmentOperation();
    assert.equal(selections.length, 1);
    assert.deepEqual([...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")].map((chip) => chip.dataset.attachmentId), ["selected-1"]);
  } finally { harness.close(); }
});

test("an attachment reserved by a Send after opening its editor cannot be replaced", async () => {
  const { harness, selections } = await setup();
  try {
    await openEditor(harness); field(harness, ".attachment-selection-start", ".25"); field(harness, ".attachment-selection-end", ".5");
    harness.holdNextSend(); harness.input("#prompt", "Hear this reference"); harness.click("#sendButton"); await harness.settle();
    harness.click(".attachment-use-excerpt"); await harness.settleAttachmentOperation();
    assert.equal(selections.length, 0); assert.match(harness.document.querySelector(".attachment-viewer-status")!.textContent!, /no longer in the next request/);
  } finally { harness.releaseHeldSend(); await harness.settle(); harness.close(); }
});

test("history reuse submits only the saved reference without a file upload", async () => {
  const state = audioCapableState(); state.openSettingsOnLoad = false;
  state.events = [{ id: "history-event", createdAt: new Date().toISOString(), kind: "user", content: "Reference", attachments: [pendingDocument("saved-document", "Notes.txt", "text/plain")] }];
  const harness = await createDialogHarness(state);
  const requests: URL[] = []; const original = harness.window.fetch;
  Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/attachments/saved-document") { requests.push(url); assert.equal((init?.body as Uint8Array).byteLength, 0); return original("http://bridge.test/state?token=test-token"); }
    return original(input, init);
  } });
  try {
    harness.click(".timeline-attachments .attachment-reuse"); await harness.settleAttachmentOperation();
    assert.equal(requests.length, 1); assert.equal(requests[0]!.searchParams.get("mode"), "copy"); assert.equal(requests[0]!.searchParams.get("replace"), "false");
    assert.equal(harness.calls.filter((call) => call.path === "/attachments").length, 0);
  } finally { harness.close(); }
});

for (const peerChange of ["replace", "undo", "add"] as const) {
  test(`a delayed excerpt response preserves the peer ${peerChange} of the next-request files`, async () => {
    const { harness, attachment } = await setup();
    const fetch = harness.window.fetch;
    let release!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { release = resolve; });
    let selectedResponse: ReturnType<typeof audioCapableState> | undefined;
    let peerResponse: ReturnType<typeof audioCapableState> | undefined;
    Object.defineProperty(harness.window, "fetch", { configurable: true, value: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      const url = new URL(String(input));
      const readJson = response.json.bind(response);
      if (url.pathname.startsWith("/attachments/") && init?.method === "POST") {
        response.json = async () => {
          const body = await readJson();
          selectedResponse = body;
          await delayedResponse;
          return body;
        };
      } else if (url.pathname === "/state") {
        response.json = async () => { const body = await readJson(); peerResponse = body; return body; };
      }
      return response;
    } });
    const pendingIds = () => [...harness.document.querySelectorAll<HTMLElement>("#pendingAttachments [data-attachment-id]")]
      .map((chip) => chip.dataset.attachmentId);
    try {
      await openEditor(harness);
      field(harness, ".attachment-selection-start", ".25"); field(harness, ".attachment-selection-end", ".5");
      harness.click(".attachment-use-excerpt");
      await waitForCondition(() => selectedResponse !== undefined, "Expected the committed excerpt response to be held");
      const peer = cloneState(selectedResponse!);
      const selected = peer.pendingAttachments[0]!;
      if (peerChange === "replace") peer.pendingAttachments = [{ ...selected, id: "peer-excerpt", durationSeconds: .125,
        provenance: { sourceId: selected.id, replacedIds: [selected.id, attachment.id], startSeconds: 0, endSeconds: .125 },
      } as typeof attachment];
      else if (peerChange === "undo") peer.pendingAttachments = [attachment];
      else peer.pendingAttachments.push(pendingDocument("peer-notes", "Notes.txt", "text/plain"));
      const expectedIds = peer.pendingAttachments.map((item) => item.id);
      harness.setServerState(peer);
      harness.emitServerEvent({ type: "session_state_invalidated", sessionId: "session-1" });
      await waitForCondition(() => peerResponse !== undefined && pendingIds().join() === expectedIds.join(),
        "Expected the peer pending snapshot before the delayed excerpt response");
      assert.ok(BigInt(peerResponse!.bridgeStateCoveredThroughRevision) >= BigInt(selectedResponse!.bridgeStateRevision));
      release();
      await harness.settleAttachmentOperation();
      assert.deepEqual(pendingIds(), expectedIds);
      harness.input("#prompt", "Hear the current files"); harness.click("#sendButton");
      await harness.settle();
      const sent = harness.calls.find((call) => call.path === "/send")!;
      assert.deepEqual(JSON.parse(new Headers(sent.headers).get("X-Live-Smith-Attachment-Ids")!), expectedIds);
      assert.deepEqual(harness.errors, []);
    } finally {
      release();
      await harness.settle();
      harness.close();
    }
  });
}
