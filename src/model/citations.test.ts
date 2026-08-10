import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MODEL_CITATION_COUNT,
  normalizeModelCitations,
} from "./citations.js";

test("citation normalization accepts bounded HTTP sources and de-duplicates URLs", () => {
  assert.deepEqual(normalizeModelCitations([
    { url: "https://example.test/source", title: " Source title " },
    { url: "https://example.test/source", title: "Duplicate" },
    { url: "http://example.test/other", title: "Other" },
    { url: "https://untitled.example.test/source", title: null },
  ]), [
    { url: "https://example.test/source", title: "Source title" },
    { url: "http://example.test/other", title: "Other" },
    {
      url: "https://untitled.example.test/source",
      title: "untitled.example.test",
    },
  ]);
});

test("citation normalization rejects unsafe, credential-bearing, and unbounded values", () => {
  assert.deepEqual(normalizeModelCitations([
    { url: "javascript:alert(1)", title: "Unsafe" },
    { url: "https://user:secret@example.test/", title: "Credentials" },
    { url: `https://example.test/${"x".repeat(3_000)}`, title: "Long URL" },
    { url: "https://example.test/empty", title: " " },
    { url: "https://example.test/control", title: "bad\nname" },
    { url: "https://example.test/long", title: "x".repeat(257) },
  ]), []);
});

test("citation normalization caps the number of sources", () => {
  const citations = normalizeModelCitations(Array.from(
    { length: MAX_MODEL_CITATION_COUNT + 5 },
    (_, index) => ({
      url: `https://example.test/${index}`,
      title: `Source ${index}`,
    }),
  ));
  assert.equal(citations.length, MAX_MODEL_CITATION_COUNT);
});
