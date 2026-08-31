import assert from "node:assert/strict";
import test from "node:test";
import {
  AudioClip,
  AudioTrack,
  ClipSlot,
  MidiClip,
  MidiTrack,
  RackDevice,
  Simpler,
  TakeLane,
  Track,
  WarpMode,
} from "@ableton-extensions/sdk";

import {
  audioFileLabel,
  clipSlotSelectionInteractionContext,
  interactionContextForScope,
  objectInteractionContext,
} from "./context.js";

test("audioFileLabel removes Unix and Windows directory paths", () => {
  assert.equal(audioFileLabel("/Users/alice/Samples/Kick.wav"), "Kick.wav");
  assert.equal(audioFileLabel("C:\\Users\\alice\\Samples\\Snare.wav"), "Snare.wav");
  assert.equal(audioFileLabel(undefined), "unknown");
});

test("Clip Slot selections report each owning track and exact zero-based slotIndex", () => {
  const bass = fakeMidiTrackWithSlots(10n, "Bass", 6);
  const lead = fakeMidiTrackWithSlots(20n, "Lead", 4);
  const slotsById = new Map(
    [...bass.slots, ...lead.slots].map((slot) => [slot.handle.id, slot]),
  );
  const context = {
    getObjectFromHandle: (handle: { id: bigint }) => slotsById.get(handle.id),
  } as never;

  const interaction = clipSlotSelectionInteractionContext(context, {
    selected_clip_slots: [bass.slots[5]!.handle, lead.slots[2]!.handle],
  });

  assert.match(
    interaction.summary,
    /Selected slot 1: MIDI track "Bass", slotIndex=5: empty/,
  );
  assert.match(
    interaction.summary,
    /Selected slot 2: MIDI track "Lead", slotIndex=2: empty/,
  );
});

test("interactionContextForScope refreshes a saved Track session from current Live state", () => {
  const group = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 7n } },
    name: { enumerable: true, value: "Music" },
  }) as MidiTrack<"1.0.0">;
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 42n } },
    name: { configurable: true, enumerable: true, value: "Lead", writable: true },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: true },
    arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: group },
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
  assert.match(
    first?.summary ?? "",
    /mute=false, solo=false, mutedViaSolo=true, armed=false, groupTrack="Music"/,
  );

  track.name = "Lead renamed in Live";
  const refreshed = interactionContextForScope(context, {
    kind: "track",
    identity: "42",
    label: "Lead",
  });
  assert.match(refreshed?.summary ?? "", /Lead renamed in Live/);
});

test("selected Audio Clip context includes source markers and readable Warp mode", () => {
  const track = Object.defineProperties(Object.create(AudioTrack.prototype), {
    handle: { enumerable: true, value: { id: 50n } },
    name: { enumerable: true, value: "Audio" },
  }) as AudioTrack<"1.0.0">;
  const clip = Object.defineProperties(Object.create(AudioClip.prototype), {
    handle: { enumerable: true, value: { id: 51n } },
    parent: { enumerable: true, value: track },
    name: { enumerable: true, value: "Warped" },
    startTime: { enumerable: true, value: 16 },
    endTime: { enumerable: true, value: 24 },
    duration: { enumerable: true, value: 8 },
    startMarker: { enumerable: true, value: 1.5 },
    endMarker: { enumerable: true, value: 9.5 },
    looping: { enumerable: true, value: true },
    loopStart: { enumerable: true, value: 2 },
    loopEnd: { enumerable: true, value: 6 },
    muted: { enumerable: true, value: false },
    color: { enumerable: true, value: 7 },
    filePath: { enumerable: true, value: "/private/audio.wav" },
    warping: { enumerable: true, value: true },
    warpMode: { enumerable: true, value: WarpMode.ComplexPro },
    warpMarkers: { enumerable: true, value: [{ sampleTime: 0, beatTime: 0 }] },
  }) as AudioClip<"1.0.0">;
  const context = { getObjectFromHandle: () => clip } as never;

  const result = objectInteractionContext(context, clip.handle);

  assert.match(result.summary, /Clip location: Arrangement View\./);
  assert.match(result.summary, /startMarker=1\.5, endMarker=9\.5/);
  assert.match(result.summary, /warping=true, warpMode=complex_pro, warpMarkers=1/);
});

test("selected Session Clip context identifies Session View", () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: 60n } },
    name: { enumerable: true, value: "Drums" },
  }) as MidiTrack<"1.0.0">;
  const slot = Object.defineProperties(Object.create(ClipSlot.prototype), {
    handle: { enumerable: true, value: { id: 61n } },
    parent: { enumerable: true, value: track },
  }) as ClipSlot<"1.0.0">;
  const clip = Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { enumerable: true, value: { id: 62n } },
    parent: { enumerable: true, value: slot },
    name: { enumerable: true, value: "Session beat" },
    startTime: { enumerable: true, value: 0 },
    endTime: { enumerable: true, value: 4 },
    duration: { enumerable: true, value: 4 },
    startMarker: { enumerable: true, value: 0 },
    endMarker: { enumerable: true, value: 4 },
    looping: { enumerable: true, value: true },
    muted: { enumerable: true, value: false },
    color: { enumerable: true, value: 1 },
    notes: { enumerable: true, value: [] },
  }) as MidiClip<"1.0.0">;
  Object.defineProperty(slot, "clip", { enumerable: true, value: clip });
  const context = { getObjectFromHandle: () => clip } as never;

  const result = objectInteractionContext(context, clip.handle);

  assert.match(result.summary, /Clip location: Session View\./);
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
    startMarker: { enumerable: true, value: 0 },
    endMarker: { enumerable: true, value: 16 },
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
  assert.match(
    resolved?.summary ?? "",
    /Clip location: Arrangement View \(Take Lane\)\./,
  );
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

test("interactionContextForScope restores a device Session on Return and Main tracks", () => {
  for (const role of ["return", "main"] as const) {
    const track = Object.defineProperties(Object.create(Track.prototype), {
      handle: { enumerable: true, value: { id: role === "return" ? 70n : 80n } },
      name: { enumerable: true, value: role === "return" ? "A-Reverb" : "Main" },
    }) as Track<"1.0.0">;
    const simpler = Object.defineProperties(Object.create(Simpler.prototype), {
      handle: { enumerable: true, value: { id: role === "return" ? 71n : 81n } },
      name: { enumerable: true, value: `${role} Simpler` },
      sample: { enumerable: true, value: null },
      parent: { enumerable: true, value: track },
    }) as Simpler<"1.0.0">;
    Object.defineProperty(track, "devices", { enumerable: true, value: [simpler] });
    const mainTrack = role === "main"
      ? track
      : Object.defineProperties(Object.create(Track.prototype), {
          handle: { enumerable: true, value: { id: 80n } },
          name: { enumerable: true, value: "Main" },
          devices: { enumerable: true, value: [] },
        }) as Track<"1.0.0">;
    const context = {
      application: {
        song: {
          tracks: [],
          returnTracks: role === "return" ? [track] : [],
          mainTrack,
          scenes: [],
        },
      },
    } as never;

    const resolved = interactionContextForScope(context, {
      kind: "object",
      identity: simpler.handle.id.toString(),
      label: simpler.name,
    });

    assert.equal(resolved?.target.track, track);
    assert.equal(resolved?.target.object, simpler);
  }
});

function fakeMidiTrackWithSlots(
  id: bigint,
  name: string,
  slotCount: number,
): { track: MidiTrack<"1.0.0">; slots: ClipSlot<"1.0.0">[] } {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: name },
  }) as MidiTrack<"1.0.0">;
  const slots = Array.from({ length: slotCount }, (_, index) =>
    Object.defineProperties(Object.create(ClipSlot.prototype), {
      handle: { enumerable: true, value: { id: id * 100n + BigInt(index) } },
      clip: { enumerable: true, value: null },
      parent: { enumerable: true, value: track },
    }) as ClipSlot<"1.0.0">
  );
  Object.defineProperty(track, "clipSlots", { enumerable: true, value: slots });
  return { track, slots };
}
