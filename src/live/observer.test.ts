import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test from "node:test";
import {
  AudioClip,
  AudioTrack,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  Simpler,
  TakeLane,
} from "@ableton-extensions/sdk";

import { observeLive } from "./observer.js";

test("analyze_audio_clip renders the exact isolated Arrangement Clip pre-FX range", async () => {
  const directory = await fs.mkdtemp("/tmp/live-smith-observer-audio-");
  const rendered = `${directory}/render.wav`;
  await fs.writeFile(rendered, monoPcm16Wave([0, 0.5, -0.5, 0], 48_000));
  const clip = analysisAudioClip({
    handle: { id: "clip-1" },
    name: "Vocal",
    startTime: 16,
    endTime: 24,
    duration: 8,
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Vocals",
    arrangementClips: [clip],
  });
  const renderedRanges: unknown[] = [];

  try {
    const result = await observeLive(
      {
        application: { song: { tracks: [track] } },
        resources: {
          renderPreFxAudio: async (...args: unknown[]) => {
            renderedRanges.push(args);
            return rendered;
          },
        },
      } as never,
      {
        type: "analyze_audio_clip",
        trackName: "Vocals",
        clipName: "Vocal",
        startBeat: 16,
      },
      { track, clip },
    );

    assert.deepEqual(renderedRanges, [[track, 16, 24]]);
    assert.match(result, /Pre-FX Arrangement audio analysis/);
    assert.match(result, /samplePeak=.*rms=/s);
    assert.match(result, /not realtime listening or integrated LUFS/i);
    assert.doesNotMatch(result, /render\.wav|\/tmp\//);
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

function monoPcm16Wave(samples: number[], sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  });
  return buffer;
}

function sdkObject<T extends object>(
  prototype: object,
  properties: Record<string, unknown>,
): T {
  return Object.defineProperties(
    Object.create(prototype),
    Object.fromEntries(Object.entries(properties).map(([key, value]) => [
      key,
      { configurable: true, enumerable: true, writable: true, value },
    ])),
  ) as T;
}

function analysisAudioClip(properties: Record<string, unknown>): AudioClip<"1.0.0"> {
  const startTime = Number(properties.startTime ?? 0);
  const endTime = Number(properties.endTime ?? 8);
  return sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    startMarker: startTime,
    endMarker: endTime,
    looping: false,
    loopStart: startTime,
    loopEnd: endTime,
    muted: false,
    filePath: "/tmp/source.wav",
    warping: true,
    warpMode: "beats",
    warpMarkers: [],
    ...properties,
  });
}

test("analyze_audio_clip refuses overlapping Clips and redacts render failures", async () => {
  const clip = analysisAudioClip({
    handle: { id: "clip-1" },
    name: "Target",
    startTime: 0,
    endTime: 8,
    duration: 8,
  });
  const overlap = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-2" },
    name: "Overlap",
    startTime: 4,
    endTime: 12,
    duration: 8,
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    arrangementClips: [clip, overlap],
  });
  const context = {
    application: { song: { tracks: [track] } },
    resources: {
      renderPreFxAudio: async () => {
        throw new Error("/Users/alice/Secret/render.wav failed");
      },
    },
  } as never;

  await assert.rejects(
    observeLive(
      context,
      { type: "analyze_audio_clip", trackName: "Audio", clipName: "Target" },
      { track },
    ),
    /could not isolate.*1 other Clip/i,
  );
  Object.defineProperty(track, "arrangementClips", {
    configurable: true,
    value: [clip],
  });
  await assert.rejects(
    observeLive(
      context,
      { type: "analyze_audio_clip", trackName: "Audio", clipName: "Target" },
      { track },
    ),
    (error: unknown) => {
      assert.match(String(error), /Could not analyze pre-FX audio/);
      assert.doesNotMatch(String(error), /Users|Secret|render\.wav/);
      return true;
    },
  );
});

test("analyze_audio_clip rejects target state drift during rendering", async () => {
  const directory = await fs.mkdtemp("/tmp/live-smith-observer-audio-");
  const rendered = `${directory}/render.wav`;
  await fs.writeFile(rendered, monoPcm16Wave([0, 0.5, -0.5, 0], 48_000));
  const clip = analysisAudioClip({
    handle: { id: "clip-1" },
    name: "Target",
    startTime: 0,
    endTime: 8,
    duration: 8,
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    arrangementClips: [clip],
  });

  try {
    await assert.rejects(
      observeLive(
        {
          application: { song: { tracks: [track] } },
          resources: {
            renderPreFxAudio: async () => {
              Reflect.set(clip, "startTime", 16);
              Reflect.set(clip, "endTime", 24);
              return rendered;
            },
          },
        } as never,
        { type: "analyze_audio_clip", trackName: "Audio", startBeat: 0 },
        { track, clip },
      ),
      (error: unknown) => {
        assert.match(String(error), /Live state changed during audio analysis/i);
        assert.doesNotMatch(String(error), /render\.wav|\/tmp\//);
        return true;
      },
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("analyze_audio_clip rejects a new overlap introduced during rendering", async () => {
  const directory = await fs.mkdtemp("/tmp/live-smith-observer-audio-");
  const rendered = `${directory}/render.wav`;
  await fs.writeFile(rendered, monoPcm16Wave([0, 0.5, -0.5, 0], 48_000));
  const clip = analysisAudioClip({
    handle: { id: "clip-1" },
    name: "Target",
    startTime: 0,
    endTime: 8,
    duration: 8,
  });
  const overlap = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-2" },
    name: "Late overlap",
    startTime: 4,
    endTime: 12,
    duration: 8,
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    arrangementClips: [clip],
  });

  try {
    await assert.rejects(
      observeLive(
        {
          application: { song: { tracks: [track] } },
          resources: {
            renderPreFxAudio: async () => {
              Reflect.set(track, "arrangementClips", [clip, overlap]);
              return rendered;
            },
          },
        } as never,
        { type: "analyze_audio_clip", trackName: "Audio", startBeat: 0 },
        { track, clip },
      ),
      /Live state changed during audio analysis/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

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
      noteOffset: 0,
      noteLimit: 128,
    },
    { track, clip },
  );

  assert.match(result, /MIDI clip "Take phrase"/);
  assert.match(result, /start=8, end=24, duration=16/);
});

test("inspect_midi_clip resolves an exact Session slot without same-name ambiguity", async () => {
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "Loop",
    startTime: 0,
    endTime: 4,
    duration: 4,
    looping: true,
    muted: false,
    notes: [],
  });
  const other = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-2" },
    name: "Loop",
    startTime: 0,
    endTime: 4,
    duration: 4,
    looping: true,
    muted: false,
    notes: [],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [other],
    takeLanes: [],
    clipSlots: [{ clip }, { clip: other }],
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    {
      type: "inspect_midi_clip",
      trackName: "Lead",
      clipName: "Loop",
      slotIndex: 0,
    },
    { track },
  );

  assert.match(result, /MIDI clip "Loop"/);
});

test("inspect_midi_clip startBeat resolves Arrangement without same-name Session ambiguity", async () => {
  const arrangement = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "arrangement-clip" },
    name: "Loop",
    startTime: 0,
    endTime: 4,
    duration: 4,
    looping: true,
    muted: false,
    notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
  });
  const session = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "session-clip" },
    name: "Loop",
    startTime: 0,
    endTime: 4,
    duration: 4,
    looping: true,
    muted: false,
    notes: [{ pitch: 72, startTime: 0, duration: 1, velocity: 100 }],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [arrangement],
    takeLanes: [],
    clipSlots: [{ clip: session }],
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    {
      type: "inspect_midi_clip",
      trackName: "Lead",
      clipName: "Loop",
      startBeat: 0,
    },
    { track },
  );

  assert.match(result, /pitch=60/);
  assert.doesNotMatch(result, /pitch=72/);
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

test("inspect_device pages exact parameters and indexed value items", async () => {
  const parameters = Array.from({ length: 21 }, (_, parameterIndex) => ({
    name: `Parameter ${parameterIndex}`,
    min: 0,
    max: 20,
    defaultValue: 0,
    isQuantized: true,
    valueItems: Array.from({ length: 15 }, (_, itemIndex) => ({
      name: `Item ${itemIndex}`,
    })),
    getValue: async () => parameterIndex,
  }));
  const device = Object.defineProperties(Object.create(Simpler.prototype), {
    handle: { enumerable: true, value: { id: "simpler-1" } },
    name: { enumerable: true, value: "Paged Device" },
    parameters: { enumerable: true, value: parameters },
    sample: { enumerable: true, value: null },
  });
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    devices: { enumerable: true, value: [device] },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    {
      type: "inspect_device",
      trackName: "Lead",
      deviceName: "Paged Device",
      parameterOffset: 18,
      parameterLimit: 2,
      valueItemOffset: 12,
      valueItemLimit: 2,
    },
    { track },
  );

  assert.match(result, /parameters page: offset=18, shown=2, total=21, nextOffset=20/);
  assert.match(result, /\[18\] Parameter 18/);
  assert.match(result, /\[19\] Parameter 19/);
  assert.doesNotMatch(result, /Parameter 17|Parameter 20/);
  assert.match(result, /items\(offset=12, total=15, nextOffset=14\)=\[12\] Item 12, \[13\] Item 13/);

  const pastEnd = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    {
      type: "inspect_device",
      trackName: "Lead",
      deviceName: "Paged Device",
      parameterOffset: 999,
    },
    { track },
  );
  assert.match(
    pastEnd,
    /parameters page: offset=21, shown=0, total=21, nextOffset=none, range=empty/,
  );
});

test("inspect_device_tree pages devices without losing absolute paths", async () => {
  const devices = Array.from({ length: 3 }, (_, index) =>
    Object.defineProperties(Object.create(Simpler.prototype), {
      handle: { enumerable: true, value: { id: `simpler-${index}` } },
      name: { enumerable: true, value: `Simpler ${index}` },
      parameters: { enumerable: true, value: [] },
      sample: { enumerable: true, value: null },
    })
  );
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    devices: { enumerable: true, value: devices },
  });

  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_device_tree", trackName: "Lead", itemOffset: 1, itemLimit: 1 },
    { track },
  );

  assert.match(result, /devices page: offset=1, shown=1, total=3, nextOffset=2/);
  assert.match(result, /"deviceIndex":1.*Simpler 1/);
  assert.doesNotMatch(result, /Simpler 0|Simpler 2/);
});

test("inspect_song_info and inspect_track expose continuation offsets", async () => {
  const scenes = Array.from({ length: 3 }, (_, index) => ({
    name: `Scene ${index}`,
    tempo: 120 + index,
  }));
  const cuePoints = Array.from({ length: 3 }, (_, index) => ({
    name: `Cue ${index}`,
    time: index * 8,
  }));
  const songResult = await observeLive(
    {
      application: {
        song: {
          tempo: 120,
          gridQuantization: 6,
          gridIsTriplet: false,
          scaleMode: false,
          scaleName: "Major",
          rootNote: 0,
          tracks: [],
          scenes,
          cuePoints,
        },
      },
    } as never,
    { type: "inspect_song_info", itemOffset: 1, itemLimit: 1 },
    {},
  );
  assert.match(songResult, /scenes page: offset=1, shown=1, total=3, nextOffset=2/);
  assert.match(songResult, /Scene index 1: "Scene 1"/);
  assert.match(songResult, /Cue Points page: offset=1, shown=1, total=3, nextOffset=2/);
  assert.match(songResult, /Cue Point beat 8: "Cue 1"/);

  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [{}, {}, {}].map(() => ({ clip: undefined })) },
    takeLanes: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  });
  const trackResult = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_track", trackName: "Lead", itemOffset: 1, itemLimit: 1 },
    { track },
  );
  assert.match(trackResult, /clip slots page: offset=1, shown=1, total=3, nextOffset=2/);
  assert.match(trackResult, /slot index 1: empty/);
  assert.doesNotMatch(trackResult, /slot index 0|slot index 2/);
});

test("inspect_track distinguishes unavailable Take Lanes from an empty collection", async () => {
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    arrangementClips: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, get: () => { throw new Error("unavailable"); } },
    devices: { enumerable: true, value: [] },
  });
  const result = await observeLive(
    { application: { song: { tracks: [track] } } } as never,
    { type: "inspect_track", trackName: "Lead" },
    { track },
  );
  assert.match(result, /take lanes=unavailable/i);
  assert.doesNotMatch(result, /take lanes=0/);
});
