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
  assert.throws(
    () => mergeExtraBody({ input: ["safe"] }, { input: ["unsafe"] }),
    /protected field input/,
  );
});
