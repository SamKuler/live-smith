import assert from "node:assert/strict";
import test from "node:test";

import { mergeExtraBody } from "./request-body.js";

test("mergeExtraBody recursively overrides generation fields and replaces arrays", () => {
  const generated = {
    model: "model-a",
    reasoning: { effort: "medium", summary: "auto" },
    metadata: ["generated"],
  };
  const merged = mergeExtraBody(
    generated,
    {
      reasoning: { effort: "high" },
      metadata: ["custom"],
      thinking: { type: "enabled" },
    },
    ["model"],
  );
  assert.deepEqual(merged, {
    model: "model-a",
    reasoning: { effort: "high", summary: "auto" },
    metadata: ["custom"],
    thinking: { type: "enabled" },
  });
  assert.deepEqual(generated.reasoning, { effort: "medium", summary: "auto" });
});

test("mergeExtraBody rejects protected structural fields before mutation", () => {
  for (const field of ["input", "messages"] as const) {
    const generated = {
      [field]: [{ role: "user", content: "provider-neutral content" }],
      metadata: { owner: "Live Smith" },
    };
    const before = JSON.parse(JSON.stringify(generated)) as typeof generated;
    assert.throws(
      () => mergeExtraBody(generated, {
        [field]: [{ role: "user", content: "injected replacement" }],
      }),
      new RegExp(`protected field ${field}`),
    );
    assert.deepEqual(generated, before);
  }
});

test("mergeExtraBody preserves __proto__ as JSON data without changing prototypes", () => {
  const generated = {
    model: "model-a",
    metadata: { generated: true },
  };
  const extraBody = JSON.parse(
    '{"__proto__":{"root":true},"metadata":{"__proto__":{"nested":true}}}',
  ) as Record<string, unknown>;

  const merged = mergeExtraBody(generated, extraBody, ["model"]);
  const metadata = merged.metadata;

  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.ok(typeof metadata === "object" && metadata !== null);
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  assert.equal(Object.hasOwn(metadata, "__proto__"), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(merged)),
    JSON.parse(
      '{"model":"model-a","metadata":{"generated":true,"__proto__":{"nested":true}},"__proto__":{"root":true}}',
    ),
  );
});
