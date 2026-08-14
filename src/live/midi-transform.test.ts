import assert from "node:assert/strict";
import test from "node:test";

import { transformMidiNotes } from "./midi-transform.js";

const notes = [{
  pitch: 60,
  startTime: 0.3,
  duration: 0.5,
  velocity: 80,
  muted: true,
  probability: 0.75,
}];

test("transpose preserves timing and optional note metadata without mutating input", () => {
  const result = transformMidiNotes(notes, 4, {
    type: "transpose",
    semitones: 7,
  });

  assert.deepEqual(result, [{ ...notes[0], pitch: 67 }]);
  assert.deepEqual(notes[0], {
    pitch: 60,
    startTime: 0.3,
    duration: 0.5,
    velocity: 80,
    muted: true,
    probability: 0.75,
  });
  assert.notEqual(result[0], notes[0]);
});

test("quantize moves starts toward the nearest grid by the requested strength", () => {
  assert.deepEqual(
    transformMidiNotes(notes, 4, {
      type: "quantize",
      gridBeats: 0.25,
      strength: 0.5,
    }),
    [{ ...notes[0], startTime: 0.275 }],
  );
});

test("quantize zero strength is exact even when the grid quotient would overflow", () => {
  const result = transformMidiNotes(notes, 4, {
    type: "quantize",
    gridBeats: Number.MIN_VALUE,
    strength: 0,
  });

  assert.deepEqual(result, notes);
  assert.ok(Number.isFinite(result[0]!.startTime));
});

test("quantize rejects a grid whose intermediate position is not finite", () => {
  assert.throws(
    () => transformMidiNotes(notes, 4, {
      type: "quantize",
      gridBeats: Number.MIN_VALUE,
      strength: 1,
    }),
    /quantize.*finite/i,
  );
});

test("quantize rejects a grid index beyond exact integer representation", () => {
  assert.throws(
    () => transformMidiNotes(notes, 4, {
      type: "quantize",
      gridBeats: 1e-20,
      strength: 1,
    }),
    /quantize.*represented safely/i,
  );
});

test("velocity scaling rounds and clamps into the MIDI velocity range", () => {
  assert.equal(
    transformMidiNotes(notes, 4, { type: "scale_velocity", factor: 2 })[0]?.velocity,
    127,
  );
  assert.equal(
    transformMidiNotes(notes, 4, { type: "scale_velocity", factor: 0.01 })[0]?.velocity,
    1,
  );
  assert.equal(
    transformMidiNotes([{
      pitch: 60,
      startTime: 0,
      duration: 1,
    }], 4, { type: "scale_velocity", factor: 0.5 })[0]?.velocity,
    50,
  );
});

test("non-velocity transforms preserve SDK notes with implicit default velocity", () => {
  const note = { pitch: 60, startTime: 0, duration: 1 };

  assert.deepEqual(
    transformMidiNotes([note], 4, { type: "transpose", semitones: 2 }),
    [{ ...note, pitch: 62 }],
  );
  assert.deepEqual(
    transformMidiNotes([note], 4, { type: "scale_velocity", factor: 1 }),
    [note],
  );
});

test("beat shifting moves every note by the exact offset", () => {
  assert.equal(
    transformMidiNotes(notes, 4, { type: "shift", offsetBeats: 1.25 })[0]?.startTime,
    1.55,
  );
});

test("transforms reject pitch and timing output outside the Clip", () => {
  assert.throws(
    () => transformMidiNotes(notes, 4, { type: "transpose", semitones: 80 }),
    /pitch.*outside/i,
  );
  assert.throws(
    () => transformMidiNotes(notes, 4, { type: "shift", offsetBeats: -0.5 }),
    /outside.*Clip/i,
  );
  assert.throws(
    () => transformMidiNotes([{
      pitch: 60,
      startTime: 0,
      duration: 0.5,
      velocity: 80,
    }], 4, { type: "shift", offsetBeats: -0.00000005 }),
    /outside.*Clip/i,
  );
  assert.throws(
    () => transformMidiNotes([{
      pitch: 60,
      startTime: 0.6,
      duration: 0.2,
      velocity: 80,
    }], 0.8, {
      type: "quantize",
      gridBeats: 1,
      strength: 1,
    }),
    /outside.*Clip/i,
  );
});

test("Clip-end validation accepts only machine-precision representation noise", () => {
  assert.doesNotThrow(() => transformMidiNotes([{
    pitch: 60,
    startTime: 0.1,
    duration: 0.2,
    velocity: 80,
  }], 0.3, { type: "transpose", semitones: 0 }));
  assert.throws(() => transformMidiNotes([{
    pitch: 60,
    startTime: 0.1,
    duration: 0.20000005,
    velocity: 80,
  }], 0.3, { type: "transpose", semitones: 0 }), /outside.*Clip/i);
});

test("transform inputs must be finite and within their public bounds", () => {
  assert.throws(
    () => transformMidiNotes(notes, 4, { type: "quantize", gridBeats: 0, strength: 1 }),
    /gridBeats/i,
  );
  assert.throws(
    () => transformMidiNotes(notes, 4, { type: "quantize", gridBeats: 0.25, strength: 2 }),
    /strength/i,
  );
  assert.throws(
    () => transformMidiNotes(notes, 4, { type: "scale_velocity", factor: 0 }),
    /factor/i,
  );
});
