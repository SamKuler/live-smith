import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AttachmentStorageCorruptionError,
  AttachmentTooLargeError,
  deleteSessionAttachment,
  deleteSessionAttachments,
  listSessionAttachments,
  MAX_IMAGE_ATTACHMENT_BYTES,
  readSessionAttachmentBytes,
  saveSessionAttachment,
  UnsupportedAttachmentError,
} from "./attachments.js";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1,
]);

test("session attachment stores private image bytes and immutable metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));

  const stored = await saveSessionAttachment(directory, "session-001", {
    fileName: "../screenshots/\r\nidea.png",
    bytes: pngBytes,
  });

  assert.equal(stored.kind, "image");
  assert.equal(stored.mediaType, "image/png");
  assert.equal(stored.fileName, "idea.png");
  assert.equal(stored.byteLength, pngBytes.byteLength);
  assert.match(stored.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await listSessionAttachments(directory, "session-001"), [stored]);
  assert.deepEqual(
    await readSessionAttachmentBytes(directory, "session-001", stored.id),
    pngBytes,
  );

  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-001",
  );
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(sessionDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await fs.stat(path.join(sessionDirectory, `${stored.id}.bin`))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await fs.stat(path.join(sessionDirectory, `${stored.id}.json`))).mode & 0o777,
      0o600,
    );
  }
});

test("attachment image signature detects JPEG and WebP without trusting names", async () => {
  const sessionId = `memory-signatures-${Date.now()}`;
  const jpeg = await saveSessionAttachment(undefined, sessionId, {
    fileName: "claimed.png",
    bytes: jpegBytes,
  });
  const webp = await saveSessionAttachment(undefined, sessionId, {
    fileName: "no-extension",
    bytes: webpBytes,
  });

  assert.equal(jpeg.mediaType, "image/jpeg");
  assert.equal(webp.mediaType, "image/webp");
  await deleteSessionAttachments(undefined, sessionId);
});

test("session attachment rejects unsupported bytes and per-image overflow", async () => {
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-unsupported-${Date.now()}`, {
      fileName: "payload.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }),
    (error: unknown) => error instanceof UnsupportedAttachmentError,
  );
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-large-${Date.now()}`, {
      fileName: "large.png",
      bytes: new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1),
    }),
    (error: unknown) => error instanceof AttachmentTooLargeError,
  );
});

test("session attachment APIs reject traversal-shaped storage IDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));
  await assert.rejects(
    saveSessionAttachment(directory, "../outside", {
      fileName: "image.png",
      bytes: pngBytes,
    }),
    /Session ID is invalid/,
  );
  await assert.rejects(
    readSessionAttachmentBytes(directory, "session-001", "../outside"),
    /Attachment ID is invalid/,
  );
  await assert.rejects(
    deleteSessionAttachment(directory, "session-001", "../outside"),
    /Attachment ID is invalid/,
  );
});

test("session attachment missing blobs and tampering are corruption", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));
  const stored = await saveSessionAttachment(directory, "session-corrupt", {
    fileName: "image.png",
    bytes: pngBytes,
  });
  const blob = path.join(
    directory,
    "live-smith-attachments",
    "session-corrupt",
    `${stored.id}.bin`,
  );
  await fs.writeFile(blob, new Uint8Array([0x89, 0x50]));

  await assert.rejects(
    readSessionAttachmentBytes(directory, "session-corrupt", stored.id),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
  await assert.rejects(
    listSessionAttachments(directory, "session-corrupt"),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("corrupt and duplicate attachment metadata block reads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));
  const stored = await saveSessionAttachment(directory, "session-metadata", {
    fileName: "image.png",
    bytes: pngBytes,
  });
  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-metadata",
  );
  const duplicateTarget = path.join(sessionDirectory, "attachment-duplicate.json");
  await fs.writeFile(duplicateTarget, JSON.stringify(stored));

  await assert.rejects(
    listSessionAttachments(directory, "session-metadata"),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("session attachment memory fallback returns copies and supports deletion", async () => {
  const sessionId = `memory-attachment-${Date.now()}`;
  const stored = await saveSessionAttachment(undefined, sessionId, {
    fileName: "image.png",
    bytes: pngBytes,
  });
  const first = await readSessionAttachmentBytes(undefined, sessionId, stored.id);
  first[0] = 0;
  const second = await readSessionAttachmentBytes(undefined, sessionId, stored.id);
  assert.equal(second[0], 0x89);

  await deleteSessionAttachment(undefined, sessionId, stored.id);
  assert.deepEqual(await listSessionAttachments(undefined, sessionId), []);

  await saveSessionAttachment(undefined, sessionId, {
    fileName: "image.jpg",
    bytes: jpegBytes,
  });
  await deleteSessionAttachments(undefined, sessionId);
  assert.deepEqual(await listSessionAttachments(undefined, sessionId), []);
});
