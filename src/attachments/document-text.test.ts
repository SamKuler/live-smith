import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedDocumentTextBuilder,
  MAX_DOCUMENT_TEXT_CHARACTERS,
  MAX_REQUEST_DOCUMENT_TEXT_CHARACTERS,
} from "./document-text.js";

test("document text budgets expose the per-file and per-request limits", () => {
  assert.equal(MAX_DOCUMENT_TEXT_CHARACTERS, 100_000);
  assert.equal(MAX_REQUEST_DOCUMENT_TEXT_CHARACTERS, 200_000);
});

test("bounded document text appends content and line separators", () => {
  const builder = new BoundedDocumentTextBuilder(20);
  assert.equal(builder.appendLine("first"), true);
  assert.equal(builder.append("second"), true);
  assert.equal(builder.characterCount, 12);
  assert.deepEqual(builder.finish(), {
    text: "first\nsecond",
    truncated: false,
  });
});

test("bounded document text counts code points without splitting a surrogate pair", () => {
  const builder = new BoundedDocumentTextBuilder(3);
  assert.equal(builder.append("A🎵BC"), false);
  assert.equal(builder.characterCount, 3);
  assert.equal(builder.append("ignored"), false);
  assert.deepEqual(builder.finish(), {
    text: "A🎵B",
    truncated: true,
  });
});

test("bounded document text marks a missing line separator as truncation", () => {
  const builder = new BoundedDocumentTextBuilder(3);
  assert.equal(builder.appendLine("abc"), false);
  assert.deepEqual(builder.finish(), {
    text: "abc",
    truncated: true,
  });
});

test("bounded document text rejects invalid limits", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new BoundedDocumentTextBuilder(value),
      /positive safe integer/,
    );
  }
});
