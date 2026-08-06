import assert from "node:assert/strict";
import test from "node:test";
import {
  MidiClip,
  MidiTrack,
  RackDevice,
  Simpler,
  TakeLane,
} from "@ableton-extensions/sdk";

import {
  audioFileLabel,
  interactionContextForScope,
  objectInteractionContext,
} from "./context.js";

test("audioFileLabel removes Unix and Windows directory paths", () => {
  assert.equal(audioFileLabel("/Users/alice/Samples/Kick.wav"), "Kick.wav");
  assert.equal(audioFileLabel("C:\\Users\\alice\\Samples\\Snare.wav"), "Snare.wav");
  assert.equal(audioFileLabel(undefined), "unknown");
});

test("interactionContextForScope refreshes a saved Track session from current Live state", () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { configurable: true, enumerable: true, value: "Lead", writable: true },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
  } as never;

  const first = interactionContextForScope(context, {
    kind: "track",
    identity: "42",
    label: "Lead",
  });
  assert.equal(first?.target.track, track);
  assert.match(first?.summary ?? "", /MIDI track "Lead"/);

  track.name = "Lead renamed in Live";
  const refreshed = interactionContextForScope(context, {
    kind: "track",
    identity: "42",
    label: "Lead",
  });
  assert.match(refreshed?.summary ?? "", /Lead renamed in Live/);
});

test("interactionContextForScope resolves a Clip inside a Track take lane", () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { enumerable: true, value: "Lead" },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
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
    startTime: { enumerable: true, value: 0 },
    endTime: { enumerable: true, value: 16 },
    duration: { enumerable: true, value: 16 },
    looping: { enumerable: true, value: false },
    muted: { enumerable: true, value: false },
    color: { enumerable: true, value: 1 },
    notes: { enumerable: true, value: [] },
  }) as MidiClip<"1.0.0">;
  Object.defineProperty(takeLane, "clips", { enumerable: true, value: [clip] });
  Object.defineProperty(track, "takeLanes", { enumerable: true, value: [takeLane] });
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
  } as never;

  const resolved = interactionContextForScope(context, {
    kind: "clip",
    identity: "126",
    label: "Take phrase",
  });
  assert.equal(resolved?.target.track, track);
  assert.equal(resolved?.target.clip, clip);
  assert.match(resolved?.summary ?? "", /MIDI clip "Take phrase"/);
});

test("objectInteractionContext keeps a device conversation distinct from its Track", () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { enumerable: true, value: "Lead" },
  }) as MidiTrack<"1.0.0">;
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: 84n } },
    name: { enumerable: true, value: "Bass Simpler" },
    sample: { enumerable: true, value: null },
    parent: { enumerable: true, value: track },
  }) as Simpler<"1.0.0">;
  const context = {
    getObjectFromHandle: () => simpler,
  } as never;

  const resolved = objectInteractionContext(context, { id: 84n });
  assert.deepEqual(resolved.scope, {
    kind: "object",
    identity: "84",
    label: "Bass Simpler",
  });
  assert.equal(resolved.target.track, track);
  assert.equal(resolved.target.object, simpler);
});

test("interactionContextForScope resolves devices nested in any RackDevice", () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { enumerable: true, value: "Lead" },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
  const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: 126n } },
    name: { enumerable: true, value: "Nested Simpler" },
    sample: { enumerable: true, value: null },
    parent: { enumerable: true, value: track },
  }) as Simpler<"1.0.0">;
  const rack = Object.defineProperties(Object.create(RackDevice.prototype), {
    handle: { enumerable: true, value: { id: 84n } },
    name: { enumerable: true, value: "Instrument Rack" },
    chains: { enumerable: true, value: [{ devices: [simpler] }] },
    parent: { enumerable: true, value: track },
  }) as RackDevice<"1.0.0">;
  Object.defineProperty(track, "devices", { enumerable: true, value: [rack] });
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
  } as never;

  const resolved = interactionContextForScope(context, {
    kind: "object",
    identity: "126",
    label: "Nested Simpler",
  });
  assert.equal(resolved?.target.track, track);
  assert.equal(resolved?.target.object, simpler);
  assert.deepEqual(resolved?.scope, {
    kind: "object",
    identity: "126",
    label: "Nested Simpler",
  });
  assert.match(resolved?.summary ?? "", /Nested Simpler/);
});
