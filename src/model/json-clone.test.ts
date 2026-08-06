import assert from "node:assert/strict";
import test from "node:test";

import { cloneJsonValue } from "./json-clone.js";

test("cloneJsonValue deeply clones JSON data without a host clone API", () => {
  const source = {
    text: "hello",
    enabled: true,
    nested: { count: 2, omitted: undefined },
    values: [1, undefined, { name: "Lead" }],
  };

  const cloned = cloneJsonValue(source);

  assert.deepEqual(cloned, source);
  assert.notEqual(cloned, source);
  assert.notEqual(cloned.nested, source.nested);
  assert.notEqual(cloned.values, source.values);
  assert.notEqual(cloned.values[2], source.values[2]);
  assert.equal("omitted" in cloned.nested, true);
  assert.equal(1 in cloned.values, true);
});

test("cloneJsonValue preserves repeated references without accepting cycles", () => {
  const shared = { value: 1 };
  const cloned = cloneJsonValue({ first: shared, second: shared });
  assert.equal(cloned.first, cloned.second);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => cloneJsonValue(cyclic), /cyclic/i);
});

test("cloneJsonValue rejects values outside the explicit JSON contract", () => {
  assert.throws(() => cloneJsonValue(Number.NaN), /finite number/i);
  assert.throws(() => cloneJsonValue(1n), /bigint/i);
  assert.throws(() => cloneJsonValue(Symbol("value")), /symbol/i);
  assert.throws(() => cloneJsonValue(() => undefined), /function/i);
  assert.throws(() => cloneJsonValue(new Date()), /plain object/i);
});
