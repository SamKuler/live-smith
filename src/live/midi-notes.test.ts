import assert from "node:assert/strict";
import test from "node:test";

import { midiNoteName, summarizeMidiNotes } from "./midi-notes.js";

test("midiNoteName converts MIDI pitch numbers to note names", () => {
  assert.equal(midiNoteName(60), "C4");
  assert.equal(midiNoteName(69), "A4");
  assert.equal(midiNoteName(74), "D5");
});

test("summarizeMidiNotes includes pitch names and timing", () => {
  const summary = summarizeMidiNotes([
    { pitch: 69, startTime: 48, duration: 4, velocity: 90 },
    { pitch: 60, startTime: 48, duration: 4, velocity: 90 },
  ]);

  assert.match(summary, /notes=2/);
  assert.match(summary, /pitch=60, name=C4, start=48/);
  assert.match(summary, /pitch=69, name=A4, start=48/);
});

test("summarizeMidiNotes paginates long clips without losing absolute note indexes", () => {
  const notes = Array.from({ length: 300 }, (_, index) => ({
    pitch: 60 + (index % 12),
    startTime: index,
    duration: 1,
    velocity: 100,
  }));
  const summary = summarizeMidiNotes(notes, { offset: 128, limit: 128 });

  assert.match(summary, /notes=300/);
  assert.match(summary, /129\. pitch=/);
  assert.match(summary, /256\. pitch=/);
  assert.match(summary, /128 earlier notes omitted/);
  assert.match(summary, /44 later notes omitted; continue with noteOffset=256/);
});
