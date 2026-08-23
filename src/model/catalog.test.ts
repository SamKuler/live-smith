import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDiscoveredModelCatalog,
  MAX_DISCOVERED_MODEL_COUNT,
  MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS,
  MAX_DISCOVERED_MODEL_ID_CODE_POINTS,
  MAX_DISCOVERED_MODEL_OUTPUT_TOKENS,
} from "./catalog.js";

const validModel = {
  id: "model-a",
  displayName: "Model A",
  capabilities: {
    maxOutputTokens: 32_000,
    reasoning: {
      efforts: ["low", "high"],
    },
  },
};

test("model catalog decoder returns one detached canonical catalog", () => {
  const input = [validModel];
  const decoded = decodeDiscoveredModelCatalog(input);

  assert.deepEqual(decoded, input);
  assert.notEqual(decoded, input);
  assert.notEqual(decoded?.[0], input[0]);
});

test("model catalog decoder rejects ambiguous or unusable model metadata", () => {
  const invalidCatalogs = [
    [{ ...validModel, id: "" }],
    [{ ...validModel, id: " " }],
    [{ ...validModel, id: " model-a" }],
    [{ ...validModel, id: "x".repeat(MAX_DISCOVERED_MODEL_ID_CODE_POINTS + 1) }],
    [{ ...validModel, displayName: " Model A" }],
    [{
      ...validModel,
      displayName: "x".repeat(MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS + 1),
    }],
    [validModel, { ...validModel, displayName: "Duplicate" }],
    [validModel, { ...validModel, id: " model-a" }],
    [{
      ...validModel,
      capabilities: { maxOutputTokens: 1.5 },
    }],
    [{
      ...validModel,
      capabilities: { maxOutputTokens: MAX_DISCOVERED_MODEL_OUTPUT_TOKENS + 1 },
    }],
    [{
      ...validModel,
      capabilities: { reasoning: { efforts: ["high", "high"] } },
    }],
  ];

  for (const catalog of invalidCatalogs) {
    assert.equal(decodeDiscoveredModelCatalog(catalog), undefined);
  }

  assert.equal(
    decodeDiscoveredModelCatalog(Array.from(
      { length: MAX_DISCOVERED_MODEL_COUNT + 1 },
      (_, index) => ({ ...validModel, id: `model-${index}` }),
    )),
    undefined,
  );
});
