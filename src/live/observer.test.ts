import assert from "node:assert/strict";
import test from "node:test";
import {
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  Simpler,
  TakeLane,
} from "@ableton-extensions/sdk";

import { observeLive } from "./observer.js";

test("inspect_midi_clip resolves an explicitly selected take-lane MIDI clip", async () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { enumerable: true, value: "Lead" },
    arrangementClips: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
  const takeLane = Object.defineProperties(Object.create(TakeLane.prototype), {
    handle: { enumerable: true, value: { id: 84n } },
    name: { enumerable: true, value: "Comp 1" },
    parent: { enumerable: true, value: track },
  }) as TakeLane<"1.0.0">;
  const clip = Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { enumerable: true, value: { id: 126n } },
    name: { enumerable: true, value: "Take phrase" },
    parent: { enumerable: true, value: takeLane },
    startTime: { enumerable: true, value: 8 },
    endTime: { enumerable: true, value: 24 },
    duration: { enumerable: true, value: 16 },
    looping: { enumerable: true, value: false },
    muted: { enumerable: true, value: false },
    notes: { enumerable: true, value: [] },
  }) as MidiClip<"1.0.0">;
  Object.defineProperty(takeLane, "clips", { enumerable: true, value: [clip] });
  Object.defineProperty(track, "takeLanes", { enumerable: true, value: [takeLane] });
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
  } as never;

  const result = await observeLive(
    context,
    {
      type: "inspect_midi_clip",
      trackName: "Lead",
      clipName: "Take phrase",
      startBeat: 8,
      noteOffset: 0,
      noteLimit: 128,
    },
    { track, clip },
  );

  assert.match(result, /MIDI clip "Take phrase"/);
  assert.match(result, /start=8, end=24, duration=16/);
});

test("inspect_device_tree reports Drum Rack pads, nested paths, and sample basenames", async () => {
  const sample = {
    handle: { id: "sample-1" },
    filePath: "/Users/alice/Secret Samples/Kick.wav",
  };
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: "simpler-1" } },
    name: { enumerable: true, value: "Kick Simpler" },
    parameters: { enumerable: true, value: [] },
    sample: { enumerable: true, value: sample },
  });
  const chain = Object.defineProperties(Object.create(DrumChain.prototype), {
    handle: { enumerable: true, value: { id: "chain-1" } },
    receivingNote: { enumerable: true, value: 36 },
    devices: { enumerable: true, value: [simpler] },
  });
  const rack = Object.defineProperties(Object.create(DrumRack.prototype), {
    handle: { enumerable: true, value: { id: "rack-1" } },
    name: { enumerable: true, value: "Drum Rack" },
    parameters: { enumerable: true, value: [] },
    chains: { enumerable: true, value: [chain] },
  });
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Drums" },
    devices: { enumerable: true, value: [rack] },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_device_tree", trackName: "Drums", deviceName: "Drum Rack" },
    { track, object: rack },
  );

  assert.match(result, /devicePath.*"deviceIndex":0/);
  assert.match(result, /receivingNote=36/);
  assert.match(result, /Kick\.wav/);
  assert.doesNotMatch(result, /Users\/alice|Secret Samples/);
});

test("inspect_mixer returns exact current values and ranges", async () => {
  const parameter = (name: string, value: number) => ({
    name,
    min: 0,
    max: 1,
    defaultValue: 0.5,
    isQuantized: false,
    valueItems: [],
    getValue: async () => value,
  });
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    mixer: {
      enumerable: true,
      value: {
        volume: parameter("Volume", 0.75),
        panning: parameter("Panning", 0.5),
        sends: [parameter("Send A", 0.2)],
      },
    },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_mixer", trackName: "Lead" },
    { track },
  );

  assert.match(result, /Volume.*current=0\.75/);
  assert.match(result, /Panning.*current=0\.5/);
  assert.match(result, /Send A.*current=0\.2/);
});

test("inspect_clip reports an empty Session slot as observable state", async () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    clipSlots: { enumerable: true, value: [{ clip: undefined }] },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_clip", trackName: "Lead", slotIndex: 0 },
    { track },
  );

  assert.equal(result, 'Session slotIndex 0 on track "Lead" is empty.');
});

test("inspect_track reports Session slot indexes in the same zero-based form used by tools", async () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [{ clip: undefined }, { clip: undefined }] },
    takeLanes: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_track", trackName: "Lead" },
    { track },
  );

  assert.match(result, /slot index 0: empty/);
  assert.match(result, /slot index 1: empty/);
  assert.doesNotMatch(result, /slot 2:/);
});
