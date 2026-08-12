import assert from "node:assert/strict";
import test from "node:test";

import {
  isModelHostedWebSearch,
  normalizeModelHostedWebSearch,
  safeModelWebSearchId,
} from "./web-search.js";

test("hosted Web Search normalization bounds provider data and unsafe URLs", () => {
  assert.deepEqual(normalizeModelHostedWebSearch({
    id: " search-1 ",
    status: "completed",
    action: "search",
    queries: [
      " current release ",
      "current release",
      "ws_call_id=call_00_internal",
      "popular chord progressions ws_call_id=call_00_suffix",
      "compare ws_call_id=call_00_middle pop harmony",
      "what does ws_call_id mean",
      "ws_call_idiom=music",
    ],
    sources: [
      { url: "https://example.test/release", title: "Release notes" },
      { url: "https://docs.example.test/manual" },
      { url: "javascript:alert(1)", title: "Unsafe" },
      { url: "https://user:secret@example.test/private", title: "Credentials" },
    ],
  }), {
    id: "search-1",
    status: "completed",
    action: "search",
    queries: [
      "current release",
      "popular chord progressions",
      "compare pop harmony",
      "what does ws_call_id mean",
      "ws_call_idiom=music",
    ],
    sources: [
      { url: "https://example.test/release", title: "Release notes" },
      { url: "https://docs.example.test/manual", title: "docs.example.test" },
    ],
  });
});

test("hosted Web Search persistence accepts only the exact normalized shape", () => {
  const search = {
    id: "search-1",
    status: "completed" as const,
    action: "search" as const,
    queries: [],
    sources: [{ url: "https://example.test/", title: "Example" }],
  };
  assert.equal(isModelHostedWebSearch(search), true);
  assert.equal(isModelHostedWebSearch({ ...search, internal: "opaque" }), false);
  assert.equal(isModelHostedWebSearch({
    ...search,
    sources: [{ url: "javascript:alert(1)", title: "Unsafe" }],
  }), false);
  assert.equal(isModelHostedWebSearch({
    ...search,
    status: "failed",
    queries: ["current release"],
    sources: [],
  }), true);
  assert.deepEqual(normalizeModelHostedWebSearch({
    ...search,
    status: "failed",
    queries: ["current release"],
  })?.sources, []);
  assert.equal(isModelHostedWebSearch({
    ...search,
    status: "failed",
    queries: ["current release"],
  }), false);
});

test("hosted Web Search removes only decorative separators adjacent to internal call IDs", () => {
  for (const separator of ["·", "•", "|", "—", "–"]) {
    assert.deepEqual(normalizeModelHostedWebSearch({
      id: `search-${separator.codePointAt(0)}`,
      status: "completed",
      action: "search",
      queries: [
        `popular songs ${separator} ws_call_id=call_00_deepseek`,
        `ws_call_id=call_00_prefix ${separator} current songs`,
        `compare ${separator} ordinary phrasing`,
        "what does ws_call_id mean",
      ],
      sources: [],
    })?.queries, [
      "popular songs",
      "current songs",
      `compare ${separator} ordinary phrasing`,
      "what does ws_call_id mean",
    ]);
  }
});

test("hosted Web Search IDs fail closed to a transport-owned fallback", () => {
  assert.equal(safeModelWebSearchId("provider:search_1", "fallback"), "provider:search_1");
  assert.equal(safeModelWebSearchId("../../private", "fallback"), "fallback");
  assert.equal(safeModelWebSearchId("", "fallback"), "fallback");
});
