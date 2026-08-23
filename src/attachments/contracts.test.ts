import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  attachmentQuotaIsWithinLimits,
  attachmentRequestQuotaIsWithinLimits,
  MAX_ATTACHMENT_FILE_NAME_BYTES,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
  MAX_PENDING_AUDIO_ATTACHMENT_COUNT,
  MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
  MAX_REQUEST_AUDIO_ATTACHMENT_BYTES,
  MAX_REQUEST_AUDIO_ATTACHMENT_COUNT,
  MAX_REQUEST_BINARY_ATTACHMENT_BYTES,
  MAX_REQUEST_BINARY_ATTACHMENT_COUNT,
  MAX_REQUEST_DOCUMENT_ATTACHMENT_BYTES,
  MAX_REQUEST_IMAGE_ATTACHMENT_BYTES,
  safeAttachmentDisplayFileName,
} from "./contracts.js";

test("attachment byte, duration, count, and subtotal limits are explicit", () => {
  assert.equal(MAX_IMAGE_ATTACHMENT_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_DOCUMENT_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_AUDIO_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_AUDIO_DURATION_SECONDS, 120);
  assert.equal(MAX_PENDING_ATTACHMENT_COUNT, 4);
  assert.equal(MAX_PENDING_ATTACHMENT_BYTES, 30 * 1024 * 1024);
  assert.equal(MAX_PENDING_IMAGE_ATTACHMENT_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_PENDING_AUDIO_ATTACHMENT_BYTES, 30 * 1024 * 1024);
  assert.equal(MAX_PENDING_AUDIO_ATTACHMENT_COUNT, 2);
  assert.equal(MAX_REQUEST_BINARY_ATTACHMENT_BYTES, 30 * 1024 * 1024);
  assert.equal(MAX_REQUEST_BINARY_ATTACHMENT_COUNT, 4);
  assert.equal(MAX_REQUEST_IMAGE_ATTACHMENT_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_REQUEST_DOCUMENT_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_REQUEST_AUDIO_ATTACHMENT_BYTES, 30 * 1024 * 1024);
  assert.equal(MAX_REQUEST_AUDIO_ATTACHMENT_COUNT, 2);
});

test("attachment quota accepts exact mixed and audio boundaries", () => {
  assert.equal(attachmentQuotaIsWithinLimits([
    { kind: "image", byteLength: MAX_IMAGE_ATTACHMENT_BYTES },
    { kind: "document", byteLength: 5 * 1024 * 1024 },
    { kind: "audio", byteLength: MAX_AUDIO_ATTACHMENT_BYTES },
  ]), true);
  assert.equal(attachmentQuotaIsWithinLimits([
    { kind: "audio", byteLength: 15 * 1024 * 1024 },
    { kind: "audio", byteLength: 15 * 1024 * 1024 },
  ]), true);
});

test("attachment quota rejects every one-over and malformed audio case", () => {
  const rejected = [
    [{ kind: "audio" as const, byteLength: MAX_AUDIO_ATTACHMENT_BYTES + 1 }],
    [
      { kind: "audio" as const, byteLength: 10 * 1024 * 1024 },
      { kind: "audio" as const, byteLength: 10 * 1024 * 1024 },
      { kind: "audio" as const, byteLength: 1 },
    ],
    [
      { kind: "image" as const, byteLength: MAX_IMAGE_ATTACHMENT_BYTES },
      { kind: "document" as const, byteLength: 5 * 1024 * 1024 },
      { kind: "audio" as const, byteLength: MAX_AUDIO_ATTACHMENT_BYTES },
      { kind: "audio" as const, byteLength: 1 },
    ],
    [{ kind: "audio" as const, byteLength: 0 }],
    [{ kind: "audio" as const, byteLength: 1.5 }],
    [{ kind: "unknown", byteLength: 1 } as never],
  ];
  for (const items of rejected) {
    assert.equal(attachmentQuotaIsWithinLimits(items), false);
  }
});

test("model request quota uses its separately named policy boundary", () => {
  const exact = [
    { kind: "image" as const, byteLength: 5 * 1024 * 1024 },
    { kind: "document" as const, byteLength: 15 * 1024 * 1024 },
    { kind: "audio" as const, byteLength: 10 * 1024 * 1024 },
  ];
  assert.equal(attachmentRequestQuotaIsWithinLimits(exact), true);
  assert.equal(attachmentRequestQuotaIsWithinLimits([
    ...exact.slice(0, 2),
    { kind: "audio", byteLength: 10 * 1024 * 1024 + 1 },
  ]), false);
  assert.equal(attachmentRequestQuotaIsWithinLimits([
    { kind: "audio", byteLength: 1 },
    { kind: "audio", byteLength: 1 },
    { kind: "audio", byteLength: 1 },
  ]), false);
});

test("attachment display names remove legacy paths, controls, and unsafe emptiness", () => {
  assert.equal(
    safeAttachmentDisplayFileName(
      "/Users/alice/Clients/\u202e\u0000secret\u0007 project.wav",
    ),
    "secret project.wav",
  );
  assert.equal(safeAttachmentDisplayFileName("../\u202e\u0000"), "attachment");

  const bounded = safeAttachmentDisplayFileName(`${"界".repeat(100)}.wav`);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MAX_ATTACHMENT_FILE_NAME_BYTES);
});
