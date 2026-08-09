import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1,
]);
const jpegBytes = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0xff, 0xd9,
]);
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0,
  0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
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
  assert.deepEqual(
    await listSessionAttachments(directory, "session-corrupt"),
    [stored],
  );
});

test("attachment image headers require bounded non-zero dimensions", async () => {
  const invalidPng = new Uint8Array(pngBytes);
  invalidPng.fill(0, 16, 24);
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-dimensions-${Date.now()}`, {
      fileName: "invalid.png",
      bytes: invalidPng,
    }),
    (error: unknown) => error instanceof UnsupportedAttachmentError,
  );
});

test("attachment reads reject symbolic-link blobs without following them", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-symlink-"));
  const stored = await saveSessionAttachment(directory, "session-symlink", {
    fileName: "image.png",
    bytes: pngBytes,
  });
  const external = path.join(directory, "external.bin");
  await fs.writeFile(external, pngBytes);
  const blob = path.join(
    directory,
    "live-smith-attachments",
    "session-symlink",
    `${stored.id}.bin`,
  );
  await fs.unlink(blob);
  await fs.symlink(external, blob);

  await assert.rejects(
    readSessionAttachmentBytes(directory, "session-symlink", stored.id),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
  assert.deepEqual(await fs.readFile(external), Buffer.from(pngBytes));
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

test("attachment ID collisions and orphan blobs are never overwritten", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-collision-"));
  const first = await saveSessionAttachment(directory, "session-collision", {
    fileName: "first.png",
    bytes: pngBytes,
  }, { createId: () => "attachment-collision" });
  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-collision",
  );
  const orphanPath = path.join(sessionDirectory, "attachment-orphan.bin");
  const orphanBytes = new Uint8Array([7, 7, 7]);
  await fs.writeFile(orphanPath, orphanBytes);
  const candidates = [
    "attachment-collision",
    "attachment-orphan",
    "attachment-unique",
  ];

  const second = await saveSessionAttachment(directory, "session-collision", {
    fileName: "second.jpg",
    bytes: jpegBytes,
  }, { createId: () => candidates.shift() ?? "attachment-fallback" });

  assert.equal(first.id, "attachment-collision");
  assert.equal(second.id, "attachment-unique");
  assert.deepEqual(
    await readSessionAttachmentBytes(directory, "session-collision", first.id),
    pngBytes,
  );
  assert.deepEqual(await fs.readFile(orphanPath), Buffer.from(orphanBytes));
});

test("attachment deletion is retryable after blob-first partial cleanup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-delete-"));
  const stored = await saveSessionAttachment(directory, "session-delete-retry", {
    fileName: "image.png",
    bytes: pngBytes,
  });
  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-delete-retry",
  );
  await fs.unlink(path.join(sessionDirectory, `${stored.id}.bin`));

  await deleteSessionAttachment(directory, "session-delete-retry", stored.id);

  assert.deepEqual(await fs.readdir(sessionDirectory), []);
});
