import assert from "node:assert/strict";
import test from "node:test";

import { findExactParameterMatch } from "./parameter-match.js";

test("findExactParameterMatch accepts only case and spacing normalization", () => {
  const match = findExactParameterMatch("  oscillator   B ", [
    { name: "Oscillator B" },
    { name: "Oscillator C" },
  ]);

  assert.equal(match?.name, "Oscillator B");
});

test("findExactParameterMatch rejects aliases and partial names", () => {
  const match = findExactParameterMatch("Osc B On", [
    { name: "Oscillator A" },
    { name: "Oscillator B" },
  ]);

  assert.equal(match, undefined);
});

test("findExactParameterMatch rejects duplicate exact names as ambiguous", () => {
  assert.throws(() => findExactParameterMatch("Frequency", [
    { name: "Frequency" },
    { name: "frequency" },
  ]), /2 parameters named "Frequency"/i);
});

test("findExactParameterMatch does not choose a substring match", () => {
  const match = findExactParameterMatch("Frequency", [
    { name: "LFO Frequency" },
    { name: "Filter Frequency" },
  ]);

  assert.equal(match, undefined);
});
