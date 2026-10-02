import assert from "node:assert/strict";
import test from "node:test";
import { projectMidiClipNotes } from "../../src/live/midi-clip-timing.js";
import { createHostAbortController } from "../../src/runtime/host.js";
const timing = { duration: 8, startMarker: 0, endMarker: 8, looping: false, loopStart: 0, loopEnd: 4, muted: false };
const note = { pitch: 60, startTime: 0, duration: 1, velocity: 100 };

test("MIDI markers normalize note time and clip both boundaries without extending the Clip span", () => {
  const result = projectMidiClipNotes([{ ...note, startTime: 3, duration: 2 }, { ...note, startTime: 7, duration: 3 },
    { ...note, startTime: 9 }, { ...note, startTime: 5, muted: true }], { ...timing, startMarker: 4, duration: 4 }, 4096);
  assert.deepEqual(result.map(({ startTime, duration }) => [startTime, duration]), [[0, 1], [3, 1]]);
  assert.deepEqual(projectMidiClipNotes([note], { ...timing, muted: true }, 4096), []);
});

test("loop expansion retains a pickup, repeats the loop, crops the last pass and bounds expanded notes", () => {
  const result = projectMidiClipNotes([note, { ...note, pitch: 64, startTime: 3, duration: 2 }], { ...timing, looping: true, duration: 9 }, 4096);
  assert.deepEqual(result.map(({ pitch, startTime, duration }) => [pitch, startTime, duration]), [[60, 0, 1], [64, 3, 1], [60, 4, 1], [64, 7, 1], [60, 8, 1]]);
  const pickup = projectMidiClipNotes([{ ...note, startTime: 1 }, { ...note, pitch: 64, startTime: 3 }],
    { ...timing, startMarker: 1, loopStart: 2, loopEnd: 4, looping: true, duration: 6 }, 4096);
  assert.deepEqual(pickup.map(({ pitch, startTime }) => [pitch, startTime]), [[60, 0], [64, 2], [64, 4]]);
  assert.throws(() => projectMidiClipNotes([note], { ...timing, looping: true, duration: 100_000, loopEnd: 0.25 }, 4096), /4096-note/);
  assert.deepEqual(projectMidiClipNotes([{ ...note, startTime: 6 }], { ...timing, looping: true, duration: 100_000, loopEnd: 0.25 }, 4096), []);
  const controller = createHostAbortController(); controller.abort(new Error("Cancelled"));
  assert.throws(() => projectMidiClipNotes([note], timing, 4096, controller.signal), /Cancelled/);
});
