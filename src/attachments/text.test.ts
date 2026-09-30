import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";

import { MAX_DOCUMENT_TEXT_CHARACTERS } from "./document-text.js";
import { processingError } from "./ooxml-test-helpers.js";
import { inspectTextAttachment } from "./text.js";

test("text extraction preserves Unicode, code, markup and original line endings as data", async () => {
  const text = `# Analysis\r\n<script>alert("not executed")</script>\nconst x = "音乐 🎵";\n\t1,2,3\n`;
  assert.deepEqual(await inspectTextAttachment(Buffer.from(text)), { text, truncated: false });
  assert.equal((await inspectTextAttachment(Buffer.from("\ufeffhello"))).text, "hello");
});

test("text extraction supports UTF-16 BOMs and reliable BOM-less byte order", async () => {
  const text = "Title\n音乐 🎵\tvalue";
  const littleEndian = Buffer.from(text, "utf16le");
  const bigEndian = Buffer.from(littleEndian).swap16();
  for (const bytes of [
    Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]),
    littleEndian,
    bigEndian,
  ]) assert.equal((await inspectTextAttachment(bytes)).text, text);
});

test("text extraction rejects binary, malformed encodings, NULs and controls", async () => {
  for (const bytes of [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xc3]),
    Buffer.from("text\0payload"), Buffer.from("text\u0001payload"),
    Buffer.from("text\u007fpayload"), Buffer.from("text\u0085payload"),
    Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0xff, 0xfe, 0, 0xd8]),
    Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]),
    Buffer.from([0xef, 0xbb, 0xbf]), new Uint8Array(),
  ]) await assert.rejects(inspectTextAttachment(bytes), processingError("invalid_document"));
});

test("text extraction bounds code points and validates beyond its retained prefix", async () => {
  const exact = "🎵".repeat(MAX_DOCUMENT_TEXT_CHARACTERS);
  assert.deepEqual(await inspectTextAttachment(Buffer.from(exact)), { text: exact, truncated: false });
  const over = await inspectTextAttachment(Buffer.from(`${exact}尾`));
  assert.equal([...over.text].length, MAX_DOCUMENT_TEXT_CHARACTERS);
  assert.equal(over.truncated, true);
  assert.equal(over.text.endsWith("🎵"), true);
  await assert.rejects(inspectTextAttachment(Buffer.from(`${exact}\u0000`)), processingError("invalid_document"));
});

test("text extraction preserves cancellation before and during inspection", async () => {
  const before = new AbortController();
  before.abort(new Error("cancel text before"));
  await assert.rejects(inspectTextAttachment(Buffer.from("abc"), before.signal), /cancel text before/);
  const during = new AbortController();
  const pending = inspectTextAttachment(Buffer.from("x".repeat(2_000_000)), during.signal);
  await yieldImmediate();
  during.abort(new Error("cancel text during"));
  await assert.rejects(pending, /cancel text during/);
});
