import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test from "node:test";

import { AttachmentProcessingError } from "../../src/attachments/contracts.js";
import { oneNoteMidi } from "../attachments/support/attachment-test-helpers.js";
import { createSession } from "../../src/storage/sessions.js";
import { appendSessionEvent, loadSessionEvents } from "../../src/storage/events.js";
import {
  listPendingSessionAttachments,
  readSessionAttachmentBytes,
  saveSessionAttachment,
  sessionAttachmentRefFromStored,
} from "../../src/storage/attachments.js";

test("readable code with an unknown extension survives storage, event persistence and reload", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-text-attachment-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Code reference", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" },
  });
  const bytes = Buffer.from("tempo = 120\nmelody = [60, 64, 67]\n// 乐句 🎵\n", "utf8");
  const stored = await saveSessionAttachment(directory, session.id, {
    fileName: "phrase.musiccode", claimedMediaType: "application/octet-stream", bytes,
  }, { preSavePendingAttachmentRefs: [] });
  assert.equal(stored.kind, "document");
  assert.equal(stored.mediaType, "text/plain");
  assert.deepEqual(await readSessionAttachmentBytes(directory, session.id, stored.id), new Uint8Array(bytes));
  await appendSessionEvent(directory, session.id, {
    kind: "user", content: "Use this phrase", attachments: [sessionAttachmentRefFromStored(stored)],
  });
  const events = await loadSessionEvents(directory, session.id);
  assert.deepEqual(events[0]?.attachments, [sessionAttachmentRefFromStored(stored)]);
  assert.deepEqual(await listPendingSessionAttachments(directory, session.id, [stored.id]), []);
});

test("MIDI is persisted as symbolic document data and never gains an audio source grant", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-attachment-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stored = await saveSessionAttachment(directory, "session-midi", {
    fileName: "phrase.midi", bytes: oneNoteMidi, claimedMediaType: "audio/midi",
  }, { preSavePendingAttachmentRefs: [] });
  assert.equal(stored.kind, "document");
  assert.equal(stored.mediaType, "audio/midi");
  assert.deepEqual(await readSessionAttachmentBytes(directory, "session-midi", stored.id), oneNoteMidi);
  const ref = sessionAttachmentRefFromStored(stored);
  await appendSessionEvent(directory, "session-midi", { kind: "user", content: "Continue", attachments: [ref] });
  const events = await loadSessionEvents(directory, "session-midi");
  assert.equal(events[0]?.attachments?.[0]?.kind, "document");
  await assert.rejects(appendSessionEvent(directory, "session-midi", {
    kind: "user", content: "Invalid classification", attachments: [{ ...ref, kind: "audio" } as never],
  }));
});

test("new text fallback rejects binary data even when its filename claims code or text", async () => {
  for (const [index, fileName] of ["payload.txt", "payload.py", "payload.unknown"].entries()) {
    await assert.rejects(saveSessionAttachment(undefined, `binary-text-${index}`, {
      fileName, bytes: new Uint8Array([0, 1, 2, 3, 0xff, 0xff]), claimedMediaType: "text/plain",
    }, { preSavePendingAttachmentRefs: [] }), (error: unknown) =>
      error instanceof AttachmentProcessingError && error.code === "invalid_document",
    );
  }
});

test("historical legacy Office references remain valid persisted Session events", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-legacy-reference-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Historical references", projectKey: "set", scope: { kind: "selection", identity: "set", label: "Set" },
  });
  for (const [index, mediaType] of ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].entries()) {
    const ref = { id: `legacy-${index}`, kind: "document" as const, fileName: `legacy-${index}.bin`,
      mediaType, byteLength: 1, sha256: "a".repeat(64) };
    await appendSessionEvent(directory, session.id, { kind: "user", content: `Reference ${index}`, attachments: [ref as never] });
  }
  const events = await loadSessionEvents(directory, session.id);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.attachments?.[0]?.mediaType),
    ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
});
