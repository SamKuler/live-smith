import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers";
import test from "node:test";

import { packageBytes } from "../attachments/ooxml-test-helpers.js";
import {
  AttachmentProcessingError,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import { createHostAbortController } from "../runtime/host.js";
import {
  AttachmentPendingQuotaError,
  AttachmentStorageCorruptionError,
  AttachmentTooLargeError,
  deleteSessionAttachment,
  deleteSessionAttachments,
  listSessionAttachments,
  listPendingSessionAttachments,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_SESSION_ATTACHMENT_BYTES,
  MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES,
  readSessionAttachmentBytes,
  saveSessionAttachment,
  UnsupportedAttachmentError,
} from "./attachments.js";
import { withStorageTransaction } from "./persistence.js";

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
const noPendingAttachmentRefs = {
  preSavePendingAttachmentRefs: [],
} as const;

function pngBytesAtSize(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set(pngBytes);
  return bytes;
}

function pdfBytesAtSize(byteLength: number): Uint8Array {
  const header = Buffer.from("%PDF-1.7\n", "ascii");
  const trailer = Buffer.from("\n%%EOF\n", "ascii");
  assert.ok(byteLength >= header.byteLength + trailer.byteLength);
  const bytes = new Uint8Array(byteLength);
  bytes.set(header);
  bytes.set(trailer, byteLength - trailer.byteLength);
  return bytes;
}

function pendingImageRef(id: string, byteLength: number) {
  return {
    id,
    kind: "image" as const,
    fileName: `${id}.png`,
    mediaType: "image/png" as const,
    byteLength,
    sha256: "a".repeat(64),
  };
}

test("session attachment stores private image bytes and immutable metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));

  const stored = await saveSessionAttachment(directory, "session-001", {
    fileName: "../screenshots/\r\nidea.png",
    bytes: pngBytes,
  }, noPendingAttachmentRefs);

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
  }, noPendingAttachmentRefs);
  const webp = await saveSessionAttachment(undefined, sessionId, {
    fileName: "no-extension",
    bytes: webpBytes,
  }, noPendingAttachmentRefs);

  assert.equal(jpeg.mediaType, "image/jpeg");
  assert.equal(webp.mediaType, "image/webp");
  await deleteSessionAttachments(undefined, sessionId);
});

test("session attachment rejects invalid document bytes and per-image overflow", async () => {
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-unsupported-${Date.now()}`, {
      fileName: "payload.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }, noPendingAttachmentRefs),
    (error: unknown) =>
      error instanceof AttachmentProcessingError && error.code === "invalid_document",
  );
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-large-${Date.now()}`, {
      fileName: "large.png",
      bytes: pngBytesAtSize(MAX_IMAGE_ATTACHMENT_BYTES + 1),
    }, noPendingAttachmentRefs),
    (error: unknown) => error instanceof AttachmentTooLargeError,
  );
});

test("session attachment accepts exactly five MiB and rejects one byte more", async () => {
  const sessionId = `memory-image-boundary-${Date.now()}`;
  const exact = await saveSessionAttachment(undefined, sessionId, {
    fileName: "exact.png",
    bytes: pngBytesAtSize(MAX_IMAGE_ATTACHMENT_BYTES),
  }, noPendingAttachmentRefs);
  assert.equal(exact.byteLength, MAX_IMAGE_ATTACHMENT_BYTES);
  await assert.rejects(
    saveSessionAttachment(undefined, sessionId, {
      fileName: "over.png",
      bytes: pngBytesAtSize(MAX_IMAGE_ATTACHMENT_BYTES + 1),
    }, noPendingAttachmentRefs),
    (error: unknown) => error instanceof AttachmentTooLargeError,
  );
  await deleteSessionAttachments(undefined, sessionId);
});

test("session attachment classifies and stores owned PDF bytes without trusting claims", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-document-"));
  const source = pdfBytesAtSize(256);
  const expected = new Uint8Array(source);
  const saving = saveSessionAttachment(directory, "session-document", {
    fileName: "../folder/e\u0301vil\u202E\u0000.pdf",
    claimedMediaType: "image/png",
    bytes: source,
  }, noPendingAttachmentRefs);
  source.fill(0x4d);

  const stored = await saving;
  assert.equal(stored.kind, "document");
  assert.equal(stored.mediaType, "application/pdf");
  assert.equal(stored.fileName, "évil.pdf");
  assert.deepEqual(
    await readSessionAttachmentBytes(directory, "session-document", stored.id),
    expected,
  );
});

test("session attachment derives and revalidates canonical Office package media types", async () => {
  const sessionId = `memory-office-classification-${Date.now()}`;
  const bytes = packageBytes("docx", {
    "word/document.xml":
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body/></w:document>`,
  });
  const stored = await saveSessionAttachment(undefined, sessionId, {
    fileName: "renamed.pdf",
    claimedMediaType: "application/pdf",
    bytes,
  }, noPendingAttachmentRefs);

  assert.equal(stored.kind, "document");
  assert.equal(
    stored.mediaType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.deepEqual(
    await readSessionAttachmentBytes(undefined, sessionId, stored.id),
    bytes,
  );
  await deleteSessionAttachments(undefined, sessionId);
});

test("document attachment accepts exactly twenty MiB and preserves typed overflow errors", async () => {
  const sessionId = `memory-document-boundary-${Date.now()}`;
  const exact = await saveSessionAttachment(undefined, sessionId, {
    fileName: "exact.pdf",
    bytes: pdfBytesAtSize(MAX_DOCUMENT_ATTACHMENT_BYTES),
  }, noPendingAttachmentRefs);
  assert.equal(exact.byteLength, MAX_DOCUMENT_ATTACHMENT_BYTES);

  await assert.rejects(
    saveSessionAttachment(undefined, sessionId, {
      fileName: "over.pdf",
      bytes: pdfBytesAtSize(MAX_DOCUMENT_ATTACHMENT_BYTES + 1),
    }, noPendingAttachmentRefs),
    (error: unknown) =>
      error instanceof AttachmentProcessingError && error.code === "archive_limit",
  );
  await deleteSessionAttachments(undefined, sessionId);
});

test("attachment save rejects the absolute limit before copying caller bytes", async () => {
  const backing = new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1);
  let copyPathTouched = false;
  const oversized = new Proxy(backing, {
    get(target, property) {
      if (property === "byteLength") return target.byteLength;
      copyPathTouched = true;
      throw new Error(`Copy path read ${String(property)}.`);
    },
  });

  await assert.rejects(
    saveSessionAttachment(undefined, `memory-precopy-limit-${Date.now()}`, {
      fileName: "oversized.bin",
      bytes: oversized,
    }, noPendingAttachmentRefs),
    (error: unknown) =>
      error instanceof AttachmentProcessingError && error.code === "archive_limit",
  );
  assert.equal(copyPathTouched, false);
});

test("pending attachment quotas are validated atomically from the pre-save snapshot", async () => {
  const exactSession = `memory-pending-exact-${Date.now()}`;
  const threeFiveMiBImages = [0, 1, 2].map((index) =>
    pendingImageRef(`attachment-pending-${index}`, MAX_IMAGE_ATTACHMENT_BYTES)
  );
  const exactDocument = await saveSessionAttachment(undefined, exactSession, {
    fileName: "exact.pdf",
    bytes: pdfBytesAtSize(5 * 1024 * 1024),
  }, { preSavePendingAttachmentRefs: threeFiveMiBImages });
  assert.equal(
    threeFiveMiBImages.reduce((total, ref) => total + ref.byteLength, 0) +
      exactDocument.byteLength,
    MAX_PENDING_SESSION_ATTACHMENT_BYTES,
  );

  await assert.rejects(
    saveSessionAttachment(undefined, `memory-pending-over-${Date.now()}`, {
      fileName: "over.pdf",
      bytes: pdfBytesAtSize(5 * 1024 * 1024 + 1),
    }, { preSavePendingAttachmentRefs: threeFiveMiBImages }),
    (error: unknown) => error instanceof AttachmentPendingQuotaError,
  );

  const imageSubtotal = [0, 1, 2].map((index) =>
    pendingImageRef(`attachment-image-subtotal-${index}`, MAX_IMAGE_ATTACHMENT_BYTES)
  );
  await saveSessionAttachment(undefined, `memory-image-subtotal-${Date.now()}`, {
    fileName: "exact.png",
    bytes: pngBytesAtSize(1024 * 1024),
  }, { preSavePendingAttachmentRefs: imageSubtotal });
  assert.equal(
    imageSubtotal.reduce((total, ref) => total + ref.byteLength, 0) + 1024 * 1024,
    MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES,
  );
  await assert.rejects(
    saveSessionAttachment(undefined, `memory-image-subtotal-over-${Date.now()}`, {
      fileName: "over.png",
      bytes: pngBytesAtSize(1024 * 1024 + 1),
    }, { preSavePendingAttachmentRefs: imageSubtotal }),
    (error: unknown) => error instanceof AttachmentPendingQuotaError,
  );

  await assert.rejects(
    saveSessionAttachment(undefined, `memory-count-over-${Date.now()}`, {
      fileName: "fifth.png",
      bytes: pngBytes,
    }, {
      preSavePendingAttachmentRefs: Array.from({ length: 4 }, (_, index) =>
        pendingImageRef(`attachment-count-${index}`, 1)
      ),
    }),
    (error: unknown) => error instanceof AttachmentPendingQuotaError,
  );

  const ownedPending = [pendingImageRef("attachment-owned-pending", 1)];
  const ownedPendingSave = saveSessionAttachment(
    undefined,
    `memory-owned-pending-${Date.now()}`,
    { fileName: "owned.pdf", bytes: pdfBytesAtSize(1024 * 1024) },
    { preSavePendingAttachmentRefs: ownedPending },
  );
  ownedPending[0]!.byteLength = MAX_PENDING_SESSION_ATTACHMENT_BYTES;
  assert.equal((await ownedPendingSave).kind, "document");
});

test("new attachment ordinals preserve upload order under an identical clock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-order-"));
  const now = () => new Date("2026-08-10T00:00:00.000Z");
  const first = await saveSessionAttachment(directory, "session-order", {
    fileName: "first.png",
    bytes: pngBytes,
  }, {
    createId: () => "attachment-z",
    now,
    preSavePendingAttachmentRefs: [],
  });
  const second = await saveSessionAttachment(directory, "session-order", {
    fileName: "second.png",
    bytes: pngBytes,
  }, {
    createId: () => "attachment-a",
    now,
    preSavePendingAttachmentRefs: [],
  });

  assert.equal(first.ordinal, 1);
  assert.equal(second.ordinal, 2);
  assert.deepEqual(
    (await listSessionAttachments(directory, "session-order")).map((item) => item.id),
    [first.id, second.id],
  );
});

test("legacy metadata without ordinals remains readable and sorts before new uploads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-legacy-order-"));
  const sessionId = "session-legacy-order";
  const legacy = await saveSessionAttachment(directory, sessionId, {
    fileName: "legacy.png",
    bytes: pngBytes,
  }, {
    createId: () => "attachment-legacy",
    preSavePendingAttachmentRefs: [],
  });
  const metadataPath = path.join(
    directory,
    "live-smith-attachments",
    sessionId,
    `${legacy.id}.json`,
  );
  const legacyMetadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as
    Record<string, unknown>;
  delete legacyMetadata.ordinal;
  legacyMetadata.fileName = `e\u0301-${"界".repeat(70)}\u202E.png`;
  await fs.writeFile(metadataPath, JSON.stringify(legacyMetadata));

  const current = await saveSessionAttachment(directory, sessionId, {
    fileName: "current.png",
    bytes: pngBytes,
  }, {
    createId: () => "attachment-current",
    preSavePendingAttachmentRefs: [],
  });
  assert.equal(current.ordinal, 2);
  assert.deepEqual(
    (await listSessionAttachments(directory, sessionId)).map((item) => item.id),
    [legacy.id, current.id],
  );
  assert.equal(
    (await listSessionAttachments(directory, sessionId))[0]?.fileName,
    legacyMetadata.fileName,
  );
});

test("ordinal metadata rejects filenames that only the legacy schema permits", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-new-name-"));
  const sessionId = "session-new-name";
  const stored = await saveSessionAttachment(directory, sessionId, {
    fileName: "current.png",
    bytes: pngBytes,
  }, noPendingAttachmentRefs);
  const metadataPath = path.join(
    directory,
    "live-smith-attachments",
    sessionId,
    `${stored.id}.json`,
  );
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as
    Record<string, unknown>;
  metadata.fileName = "e\u0301.png";
  await fs.writeFile(metadataPath, JSON.stringify(metadata));

  await assert.rejects(
    listSessionAttachments(directory, sessionId),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("attachment save cancellation propagates without writing candidate data", async () => {
  const sessionId = `memory-cancel-save-${Date.now()}`;
  const controller = createHostAbortController();
  const cancelled = new Error("cancelled attachment save");
  const saving = saveSessionAttachment(undefined, sessionId, {
    fileName: "cancelled.pdf",
    bytes: pdfBytesAtSize(MAX_DOCUMENT_ATTACHMENT_BYTES),
    signal: controller.signal,
  }, noPendingAttachmentRefs);
  setImmediate(() => controller.abort(cancelled));
  await assert.rejects(saving, (error: unknown) => error === cancelled);
  assert.deepEqual(await listSessionAttachments(undefined, sessionId), []);
});

test("attachment save rechecks cancellation after waiting for the storage transaction", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-lock-cancel-"));
  const sessionId = "session-lock-cancel";
  let releaseBlock = (): void => undefined;
  let markEntered = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBlock = resolve;
  });
  const blocker = withStorageTransaction(directory, async () => {
    markEntered();
    await blocked;
  });
  await entered;

  const controller = createHostAbortController();
  const cancelled = new Error("cancelled while waiting for storage");
  const saving = saveSessionAttachment(directory, sessionId, {
    fileName: "cancelled.png",
    bytes: pngBytes,
    signal: controller.signal,
  }, noPendingAttachmentRefs);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  releaseBlock();

  await assert.rejects(saving, (error: unknown) => error === cancelled);
  await blocker;
  assert.deepEqual(await listSessionAttachments(directory, sessionId), []);
});

test("document reads reject metadata media-type forgery and blob corruption", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-document-corrupt-"));
  const stored = await saveSessionAttachment(directory, "session-document-corrupt", {
    fileName: "report.pdf",
    bytes: pdfBytesAtSize(256),
  }, noPendingAttachmentRefs);
  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-document-corrupt",
  );
  const metadataPath = path.join(sessionDirectory, `${stored.id}.json`);
  const forged = { ...stored, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  await fs.writeFile(metadataPath, JSON.stringify(forged));
  await assert.rejects(
    readSessionAttachmentBytes(directory, "session-document-corrupt", stored.id),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("pending attachment listing skips safely named consumed corruption but fails closed otherwise", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-pending-corrupt-"));
  const sessionId = "session-pending-corrupt";
  const consumed = await saveSessionAttachment(directory, sessionId, {
    fileName: "consumed.png",
    bytes: pngBytes,
  }, { preSavePendingAttachmentRefs: [] });
  const pending = await saveSessionAttachment(directory, sessionId, {
    fileName: "pending.png",
    bytes: jpegBytes,
  }, { preSavePendingAttachmentRefs: [] });
  const metadataPath = path.join(
    directory,
    "live-smith-attachments",
    sessionId,
    `${consumed.id}.json`,
  );
  await fs.writeFile(metadataPath, "{corrupt consumed metadata");

  assert.deepEqual(
    await listPendingSessionAttachments(directory, sessionId, [consumed.id]),
    [pending],
  );
  await assert.rejects(
    listPendingSessionAttachments(directory, sessionId, []),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
  await assert.rejects(
    listSessionAttachments(directory, sessionId),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("exact attachment reads reject Session refs that do not match stored metadata", async () => {
  const sessionId = `memory-exact-ref-${Date.now()}`;
  const stored = await saveSessionAttachment(undefined, sessionId, {
    fileName: "exact.png",
    bytes: pngBytes,
  }, { preSavePendingAttachmentRefs: [] });

  await assert.rejects(
    readSessionAttachmentBytes(undefined, sessionId, stored.id, {
      expectedRef: { ...stored, fileName: "forged.png" },
    }),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
});

test("blob size corruption is rejected from handle stat before reading content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-blob-stat-"));
  const sessionId = "session-blob-stat";
  const stored = await saveSessionAttachment(directory, sessionId, {
    fileName: "report.pdf",
    bytes: pdfBytesAtSize(256),
  }, noPendingAttachmentRefs);
  const blobPath = path.join(
    directory,
    "live-smith-attachments",
    sessionId,
    `${stored.id}.bin`,
  );
  await fs.truncate(blobPath, MAX_DOCUMENT_ATTACHMENT_BYTES + 1);
  let readCalled = false;

  await assert.rejects(
    readSessionAttachmentBytes(directory, sessionId, stored.id, {
      readFile: async () => {
        readCalled = true;
        return new Uint8Array();
      },
    }),
    (error: unknown) => error instanceof AttachmentStorageCorruptionError,
  );
  assert.equal(readCalled, false);
});

test("attachment filenames enforce an NFC UTF-8 byte limit", async () => {
  const sessionId = `memory-name-limit-${Date.now()}`;
  const stored = await saveSessionAttachment(undefined, sessionId, {
    fileName: `${"界".repeat(80)}.pdf`,
    bytes: pdfBytesAtSize(256),
  }, noPendingAttachmentRefs);
  assert.ok(Buffer.byteLength(stored.fileName, "utf8") <= 160);
  assert.equal(stored.fileName, stored.fileName.normalize("NFC"));

  const fallback = await saveSessionAttachment(undefined, sessionId, {
    fileName: "../\u0000\u202E",
    bytes: pdfBytesAtSize(256),
  }, noPendingAttachmentRefs);
  assert.equal(fallback.fileName, "document.pdf");
  await deleteSessionAttachments(undefined, sessionId);
});

test("session attachment APIs reject traversal-shaped storage IDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-"));
  await assert.rejects(
    saveSessionAttachment(directory, "../outside", {
      fileName: "image.png",
      bytes: pngBytes,
    }, noPendingAttachmentRefs),
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
  }, noPendingAttachmentRefs);
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
    }, noPendingAttachmentRefs),
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
  }, noPendingAttachmentRefs);
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
  }, noPendingAttachmentRefs);
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
  }, noPendingAttachmentRefs);
  const first = await readSessionAttachmentBytes(undefined, sessionId, stored.id);
  first[0] = 0;
  const second = await readSessionAttachmentBytes(undefined, sessionId, stored.id);
  assert.equal(second[0], 0x89);

  await deleteSessionAttachment(undefined, sessionId, stored.id);
  assert.deepEqual(await listSessionAttachments(undefined, sessionId), []);

  await saveSessionAttachment(undefined, sessionId, {
    fileName: "image.jpg",
    bytes: jpegBytes,
  }, noPendingAttachmentRefs);
  await deleteSessionAttachments(undefined, sessionId);
  assert.deepEqual(await listSessionAttachments(undefined, sessionId), []);
});

test("attachment ID collisions and orphan blobs are never overwritten", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-attachment-collision-"));
  const first = await saveSessionAttachment(directory, "session-collision", {
    fileName: "first.png",
    bytes: pngBytes,
  }, {
    createId: () => "attachment-collision",
    preSavePendingAttachmentRefs: [],
  });
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
  }, {
    createId: () => candidates.shift() ?? "attachment-fallback",
    preSavePendingAttachmentRefs: [],
  });

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
  }, noPendingAttachmentRefs);
  const sessionDirectory = path.join(
    directory,
    "live-smith-attachments",
    "session-delete-retry",
  );
  await fs.unlink(path.join(sessionDirectory, `${stored.id}.bin`));

  await deleteSessionAttachment(directory, "session-delete-retry", stored.id);

  assert.deepEqual(await fs.readdir(sessionDirectory), []);
});
