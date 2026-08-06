import assert from "node:assert/strict";
import test from "node:test";

import { findBestParameterMatch } from "./parameter-match.js";

test("findBestParameterMatch accepts model wording with extra on/off suffix", () => {
  const match = findBestParameterMatch("Oscillator B On", [
    { name: "Oscillator B" },
    { name: "Oscillator C" },
  ]);

  assert.equal(match?.name, "Oscillator B");
});

test("findBestParameterMatch accepts common oscillator abbreviations", () => {
  const match = findBestParameterMatch("Osc B On", [
    { name: "Oscillator A" },
    { name: "Oscillator B" },
  ]);

  assert.equal(match?.name, "Oscillator B");
});

test("findBestParameterMatch returns undefined when no safe match exists", () => {
  const match = findBestParameterMatch("Filter Frequency", [
    { name: "Oscillator B" },
    { name: "Transpose" },
  ]);

  assert.equal(match, undefined);
});
