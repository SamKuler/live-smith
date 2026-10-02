import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { selectSavedAttachment } from "../../../src/app/attachments/attachment-selection.js";
import { consumedAttachmentIds } from "../../../src/app/agent-request.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { saveSessionAttachment, readSessionAttachmentBytes, listPendingSessionAttachments, listSessionAttachments, deleteSessionAttachment, sessionAttachmentRefFromStored } from "../../../src/storage/attachments.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { waveBytes, mp3Bytes } from "../../storage/support/audio-storage-test-helpers.js";

for (const durable of [false, true]) test(`attachment selection preserves originals and draft undo across send (${durable ? "disk" : "memory"})`, async (t) => {
  const directory = durable ? await fs.mkdtemp("/private/tmp/selection-test-") : undefined;
  if (directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = `selection-${durable}`;
  const signal = createHostAbortController().signal;
  const originalBytes = waveBytes(1);
  const original = await saveSessionAttachment(directory, session, { fileName: "original.wav", bytes: originalBytes }, { preSavePendingAttachmentRefs: [] });
  const other = await saveSessionAttachment(directory, session, { fileName: "other.wav", bytes: waveBytes(1) }, { preSavePendingAttachmentRefs: [original] });
  const pending = async () => listPendingSessionAttachments(directory, session, consumedAttachmentIds(await loadSessionEvents(directory, session)));
  const select = async (id: string, replace = true) => selectSavedAttachment(directory, { sessionId: session, attachmentId: id, mode: "excerpt", replace, startSeconds: .1, endSeconds: .3, bytes: new Uint8Array() }, await pending(), signal);
  await select(original.id);
  const first = (await pending()).find((item) => item.id !== other.id)!;
  assert.deepEqual(first.provenance, { sourceId: original.id, replacedIds: [original.id], startSeconds: .1, endSeconds: .3 });
  assert.equal((await pending()).length, 2, "replacement admits within the two-audio quota");
  assert.equal((await listSessionAttachments(directory, session)).length, 3);
  assert.deepEqual(await readSessionAttachmentBytes(directory, session, original.id), originalBytes);
  await selectSavedAttachment(directory, { sessionId: session, attachmentId: first.id, mode: "copy", replace: true, bytes: new Uint8Array() }, await pending(), signal);
  const second = (await pending()).find((item) => item.id !== other.id)!;
  assert.deepEqual(second.provenance?.replacedIds, [first.id, original.id]);
  assert.deepEqual((await listPendingSessionAttachments(directory, session, [], second.id)).map((item) => item.id), [other.id, first.id]);
  assert.deepEqual((await pending()).map((item) => item.id), [other.id, second.id], "prospective removal must not mutate storage");
  await deleteSessionAttachment(directory, session, second.id);
  assert.deepEqual((await pending()).map((item) => item.id), [other.id, first.id]);
  await deleteSessionAttachment(directory, session, first.id);
  assert.deepEqual((await pending()).map((item) => item.id), [original.id, other.id]);
  await select(original.id);
  const sent = (await pending()).find((item) => item.id !== other.id)!;
  await appendSessionEvent(directory, session, { kind: "user", content: "Hear the selection", attachments: [sessionAttachmentRefFromStored(sent)] });
  assert.deepEqual((await pending()).map((item) => item.id), [other.id]);
  await deleteSessionAttachment(directory, session, other.id);
  await selectSavedAttachment(directory, { sessionId: session, attachmentId: original.id, mode: "copy", replace: false, bytes: new Uint8Array() }, await pending(), signal);
  const reused = (await pending())[0]!;
  assert.notEqual(reused.id, original.id); assert.deepEqual(reused.provenance?.replacedIds, []);
  assert.deepEqual(await readSessionAttachmentBytes(directory, session, reused.id), originalBytes);
  await deleteSessionAttachment(directory, session, reused.id);
  assert.deepEqual(await pending(), []);
  assert.deepEqual(await readSessionAttachmentBytes(directory, session, original.id), originalBytes);
});

test("selection rejects cross-Session, stale replacement, invalid conversion, and cancelled work without saving", async () => {
  const session = "selection-rejections";
  const source = await saveSessionAttachment(undefined, session, { fileName: "source.mp3", bytes: mp3Bytes() }, { preSavePendingAttachmentRefs: [] });
  const signal = createHostAbortController().signal;
  const input = { sessionId: session, attachmentId: source.id, mode: "copy" as const, replace: true, bytes: new Uint8Array() };
  await assert.rejects(selectSavedAttachment(undefined, { ...input, sessionId: "another-session", replace: false }, [], signal), /does not exist/);
  await assert.rejects(selectSavedAttachment(undefined, input, [], signal), /no longer/);
  await assert.rejects(selectSavedAttachment(undefined, { ...input, mode: "excerpt", startSeconds: 0, endSeconds: .01 }, [source], signal), /explicit WAV conversion/);
  await assert.rejects(selectSavedAttachment(undefined, { ...input, mode: "convert-mp3", startSeconds: 0, endSeconds: .01, bytes: waveBytes(1) }, [source], signal), /preserve/);
  const controller = createHostAbortController(); controller.abort(new Error("cancelled selection"));
  await assert.rejects(selectSavedAttachment(undefined, input, [source], controller.signal), /cancelled selection/);
  assert.deepEqual((await listSessionAttachments(undefined, session)).map((item) => item.id), [source.id]);
});


test("event storage owns nested attachment provenance in append and list results", async () => {
  const session = "provenance-event-ownership";
  const attachment = await saveSessionAttachment(undefined, session, { fileName: "selection.wav", bytes: waveBytes(1) }, {
    preSavePendingAttachmentRefs: [], provenance: { sourceId: "original-source", replacedIds: ["original-source"], startSeconds: 0, endSeconds: 1 },
  });
  const ref = sessionAttachmentRefFromStored(attachment);
  const appended = await appendSessionEvent(undefined, session, { kind: "user", content: "Selection", attachments: [ref] });
  ref.provenance!.replacedIds.push("caller-change");
  appended.attachments![0]!.provenance!.sourceId = "returned-change";
  appended.attachments![0]!.provenance!.replacedIds.length = 0;
  const first = await loadSessionEvents(undefined, session);
  assert.deepEqual(first[0]!.attachments![0]!.provenance, { sourceId: "original-source", replacedIds: ["original-source"], startSeconds: 0, endSeconds: 1 });
  first[0]!.attachments![0]!.provenance!.replacedIds.push("list-change");
  assert.deepEqual(consumedAttachmentIds(await loadSessionEvents(undefined, session)), [attachment.id, "original-source"]);
});

test("original restoration resolves nested excerpts without changing or losing saved sources", async () => {
  const session = "selection-original-restore", signal = createHostAbortController().signal;
  const bytes = waveBytes(2);
  const original = await saveSessionAttachment(undefined, session, { fileName: "source.wav", bytes }, { preSavePendingAttachmentRefs: [] });
  const pending = () => listPendingSessionAttachments(undefined, session, []);
  let selected = original;
  for (const endSeconds of [1, .5]) {
    await selectSavedAttachment(undefined, { sessionId: session, attachmentId: selected.id, mode: "excerpt", replace: true, startSeconds: 0, endSeconds, bytes: new Uint8Array() }, await pending(), signal);
    selected = (await pending())[0]!;
  }
  await selectSavedAttachment(undefined, { sessionId: session, attachmentId: selected.id, mode: "original", replace: true, bytes: new Uint8Array() }, await pending(), signal);
  const restored = (await pending())[0]!;
  assert.notEqual(restored.id, original.id); assert.equal(restored.fileName, original.fileName); assert.equal(restored.sha256, original.sha256);
  assert.equal(restored.provenance?.startSeconds, undefined);
  assert.deepEqual(await readSessionAttachmentBytes(undefined, session, restored.id), bytes);
  assert.equal((await listSessionAttachments(undefined, session)).length, 4);
});
