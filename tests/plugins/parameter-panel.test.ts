import assert from "node:assert/strict";
import test from "node:test";
import { pluginParameterPanel, validatePluginParameters } from "../../src/plugins/parameter-panel.js";

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    bars: { type: "integer", title: "Bars", minimum: 1, maximum: 8, default: 4 },
    density: { type: "number", minimum: 0, maximum: 1, multipleOf: 0.1 },
    style: { type: "string", enum: ["steady", "varied"], default: "steady" },
    keepDrums: { type: "boolean", default: true },
    notes: { type: "string", minLength: 2, maxLength: 8 },
  },
  required: ["bars", "style", "keepDrums"],
};

test("parameter forms preserve typed constraints, defaults, optional omission, and source identity", () => {
  const panel = pluginParameterPanel("generate", schema, { packageDigest: "one" })!;
  assert.equal(panel.fields[0]!.title, "Bars");
  assert.equal(panel.fields[0]!.default, 4);
  assert.equal(panel.fields[1]!.required, false);
  assert.deepEqual(validatePluginParameters(panel, { bars: 4, style: "varied", keepDrums: false }), {
    bars: 4, style: "varied", keepDrums: false,
  });
  assert.doesNotThrow(() => validatePluginParameters(panel, { bars: 4, style: "steady", keepDrums: true, density: 0.3, notes: "🎹🎵" }));
  assert.equal(pluginParameterPanel("generate", schema, { packageDigest: "one" })!.signature, panel.signature);
  assert.notEqual(pluginParameterPanel("generate", schema, { packageDigest: "two" })!.signature, panel.signature);
  assert.notEqual(pluginParameterPanel("generate", { ...schema, required: [] }, { packageDigest: "one" })!.signature, panel.signature);
});

test("parameter validation rejects incorrect scalar types, missing values, constraints, and undeclared fields", () => {
  const panel = pluginParameterPanel("generate", schema, {})!;
  const valid = { bars: 4, style: "steady", keepDrums: true };
  for (const invalid of [
    {}, [], { ...valid, bars: "4" }, { ...valid, bars: 2.5 }, { ...valid, bars: 9 },
    { ...valid, density: 0.35 }, { ...valid, density: -0.1 }, { ...valid, density: Infinity },
    { ...valid, style: "invented" }, { ...valid, keepDrums: "true" },
    { ...valid, notes: "🎹" }, { ...valid, notes: "0123456789" },
    { ...valid, injected: true },
  ]) assert.throws(() => validatePluginParameters(panel, invalid), JSON.stringify(invalid));
});

test("unsupported schemas stay out of the form instead of losing constraints", () => {
  for (const unsupported of [
    { ...schema, allOf: [{}] },
    { ...schema, properties: { data: { type: "array", items: { type: "number" } } } },
    { type: "object", properties: { text: { type: "string", pattern: "^[A-Z]+$" } } },
    { type: "object", properties: { value: { anyOf: [{ type: "number" }, { type: "null" }] } } },
    { type: "object", properties: { value: { type: ["string"] } } },
    { type: "object", properties: { value: { type: "number", minimum: 2, default: 1 } } },
    { type: "object", properties: { value: { type: "integer", enum: [1, "2"] } } },
    { type: "object", properties: { value: { type: "boolean", maximum: 1 } } },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", properties: {}, additionalProperties: { type: "string" } },
  ]) assert.equal(pluginParameterPanel("test", unsupported, {}), undefined);
  assert.deepEqual(pluginParameterPanel("empty", { type: "object", properties: {} }, {})!.fields, []);
});

test("exclusive numeric limits, numeric enums, and property names are preserved", () => {
  const panel = pluginParameterPanel("test", { type: "object", properties: {
    choice: { type: "integer", enum: [1, 2] },
    amount: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    ["__proto__"]: { type: "string" },
  } }, {})!;
  assert.doesNotThrow(() => validatePluginParameters(panel, JSON.parse('{"choice":2,"amount":0.5,"__proto__":"safe"}')));
  assert.throws(() => validatePluginParameters(panel, { amount: 0 }));
  assert.throws(() => validatePluginParameters(panel, { amount: 1 }));
});
