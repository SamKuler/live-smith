import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioClip,
  AudioTrack,
  ClipSlot,
  CuePoint,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  RackDevice,
  Sample,
  Scene,
  Simpler,
  TakeLane,
  WarpMode,
} from "@ableton-extensions/sdk";

import {
  AgentPlanExecutionError,
  executeAgentPlan,
} from "./executor.js";

test("a bound trackRef survives rename before clip and device actions", async () => {
  const inserted: string[] = [];
  let clipCreates = 0;
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { configurable: true, enumerable: true, value: { id: "track-1" } },
    name: { configurable: true, enumerable: true, value: "1-MIDI", writable: true },
    devices: { configurable: true, enumerable: true, value: [] },
    arrangementClips: { configurable: true, enumerable: true, value: [] },
    createMidiClip: { configurable: true, enumerable: true, value: async () => {
      clipCreates += 1;
      return { name: "Clip", notes: [] };
    } },
    insertDevice: { configurable: true, enumerable: true, value: async (name: string) => {
      inserted.push(name);
      return { name };
    } },
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Build Dream Pads",
      targets: { pads: { trackName: "1-MIDI" } },
      actions: [
        { type: "rename_track", trackRef: "pads", newName: "Dream Pads" },
        { type: "rename_track", trackRef: "pads", newName: "Final Dream Pads" },
        {
          type: "create_midi_clip",
          trackRef: "pads",
          startBeat: 0,
          durationBeats: 16,
          notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 88 }],
        },
        { type: "insert_device", trackRef: "pads", deviceName: "Auto Filter" },
      ],
    },
    {},
    undefined,
    { tracks: new Map([["pads", track]]), actionTracks: new Map() },
  );

  assert.equal(track.name, "Final Dream Pads");
  assert.equal(clipCreates, 1);
  assert.deepEqual(inserted, ["Auto Filter"]);
  assert.equal(results.length, 4);
});

test("a creator ref binds the returned MIDI track for later actions", async () => {
  let clipCreates = 0;
  const inserted: string[] = [];
  const createdTrack = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { configurable: true, enumerable: true, value: { id: "created-track" } },
    name: { configurable: true, enumerable: true, value: "MIDI 2", writable: true },
    devices: { configurable: true, enumerable: true, value: [] },
    arrangementClips: { configurable: true, enumerable: true, value: [] },
    createMidiClip: { configurable: true, enumerable: true, value: async () => {
      clipCreates += 1;
      return { name: "Clip", notes: [] };
    } },
    insertDevice: { configurable: true, enumerable: true, value: async (name: string) => {
      inserted.push(name);
      return { name };
    } },
  });

  await executeAgentPlan(
    {
      application: {
        song: {
          tracks: [],
          createMidiTrack: async () => createdTrack,
        },
      },
    } as never,
    {
      message: "Create the full track",
      actions: [
        { type: "create_midi_track", ref: "instrument", name: "AI Instrument" },
        {
          type: "create_midi_clip",
          trackRef: "instrument",
          startBeat: 0,
          durationBeats: 256,
          notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 100 }],
        },
        { type: "insert_device", trackRef: "instrument", deviceName: "Auto Filter" },
      ],
    },
    {},
  );

  assert.equal(createdTrack.name, "AI Instrument");
  assert.equal(clipCreates, 1);
  assert.deepEqual(inserted, ["Auto Filter"]);
});

test("replace_midi_clip_segment removes only overlapping notes and keeps deterministic order", async () => {
  const clip = Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { enumerable: true, value: { id: "clip-1" } },
    name: { enumerable: true, value: "Full arrangement" },
    startTime: { enumerable: true, value: 0 },
    duration: { enumerable: true, value: 8 },
    notes: {
      enumerable: true,
      writable: true,
      value: [
        { pitch: 48, startTime: 0, duration: 1, velocity: 90 },
        { pitch: 50, startTime: 1.5, duration: 1, velocity: 90 },
        { pitch: 52, startTime: 2.5, duration: 0.5, velocity: 90 },
        { pitch: 55, startTime: 4, duration: 1, velocity: 90 },
      ],
    },
  });
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    devices: { enumerable: true, value: [] },
    arrangementClips: { enumerable: true, value: [clip] },
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Write bars 1-2",
      actions: [{
        type: "replace_midi_clip_segment",
        trackName: "Lead",
        clipName: "Full arrangement",
        startBeat: 0,
        segmentStartTime: 2,
        segmentDurationBeats: 2,
        notes: [
          { pitch: 67, startTime: 3.5, duration: 0.5, velocity: 100 },
          { pitch: 60, startTime: 2, duration: 0.5, velocity: 100 },
        ],
      }],
    },
    {},
  );

  assert.deepEqual(clip.notes, [
    { pitch: 48, startTime: 0, duration: 1, velocity: 90 },
    { pitch: 60, startTime: 2, duration: 0.5, velocity: 100 },
    { pitch: 67, startTime: 3.5, duration: 0.5, velocity: 100 },
    { pitch: 55, startTime: 4, duration: 1, velocity: 90 },
  ]);
  assert.match(results[0] ?? "", /removed 2 notes.*added 2.*final 4/i);
});

test("replace_midi_clip_segment rechecks the current clip duration before mutation", async () => {
  const originalNotes = [
    { pitch: 48, startTime: 0, duration: 1, velocity: 90 },
  ];
  const clip = Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { enumerable: true, value: { id: "clip-1" } },
    name: { enumerable: true, value: "Full arrangement" },
    startTime: { enumerable: true, value: 0 },
    duration: { enumerable: true, value: 8 },
    notes: { enumerable: true, writable: true, value: originalNotes },
  });
  const track = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id: "track-1" } },
    name: { enumerable: true, value: "Lead" },
    devices: { enumerable: true, value: [] },
    arrangementClips: { enumerable: true, value: [clip] },
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Write outside the Clip",
        actions: [{
          type: "replace_midi_clip_segment",
          trackName: "Lead",
          clipName: "Full arrangement",
          startBeat: 0,
          segmentStartTime: 6,
          segmentDurationBeats: 4,
          notes: [],
        }],
      },
      {},
    ),
    /segment 6-10.*bounds 0-8/i,
  );
  assert.equal(clip.notes, originalNotes);
});

test("a creator ref reuses only its preflight-bound track handle", async () => {
  const insertedOnConfirmed: string[] = [];
  const insertedOnReplacement: string[] = [];
  const midiTrack = (id: string, inserted: string[]) => Object.defineProperties(
    Object.create(MidiTrack.prototype),
    {
      handle: { enumerable: true, value: { id } },
      name: { enumerable: true, value: "Lead", writable: true },
      devices: { enumerable: true, value: [] },
      insertDevice: {
        enumerable: true,
        value: async (name: string) => {
          inserted.push(name);
          return { name };
        },
      },
    },
  );
  const confirmedTrack = midiTrack("confirmed", insertedOnConfirmed);
  const replacement = midiTrack("replacement", insertedOnReplacement);

  await executeAgentPlan(
    {
      application: {
        song: {
          tracks: [replacement],
          createMidiTrack: async () => {
            throw new Error("must not create a replacement track");
          },
        },
      },
    } as never,
    {
      message: "Reuse the confirmed Lead track",
      actions: [
        { type: "create_midi_track", ref: "lead", name: "Lead" },
        { type: "insert_device", trackRef: "lead", deviceName: "Auto Filter" },
      ],
    },
    {},
    undefined,
    {
      tracks: new Map(),
      actionTracks: new Map([[0, confirmedTrack]]),
    },
  );

  assert.deepEqual(insertedOnConfirmed, ["Auto Filter"]);
  assert.deepEqual(insertedOnReplacement, []);
});

test("plain trackName execution consumes the preflight-bound handle", async () => {
  const confirmedTrack = { name: "Scratch", handle: { id: "confirmed" } };
  const replacement = { name: "Scratch", handle: { id: "replacement" } };
  let deleted: unknown;

  await executeAgentPlan(
    {
      application: {
        song: {
          tracks: [replacement],
          deleteTrack: async (track: unknown) => {
            deleted = track;
          },
        },
      },
    } as never,
    {
      message: "Delete Scratch",
      actions: [{ type: "delete_track", trackName: "Scratch" }],
    },
    {},
    undefined,
    {
      tracks: new Map(),
      actionTracks: new Map([[0, confirmedTrack as never]]),
    },
  );

  assert.equal(deleted, confirmedTrack);
  assert.notEqual(deleted, replacement);
});

test("set_device_parameter rejects an out-of-range value without calling setValue", async () => {
  let setValueCalls = 0;
  const parameter = {
    name: "Frequency",
    min: 0,
    max: 1,
    setValue: async () => {
      setValueCalls += 1;
    },
  };
  const track = {
    name: "Lead",
    devices: [{ name: "Auto Filter", parameters: [parameter] }],
  };

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Set frequency",
        actions: [{
          type: "set_device_parameter",
          trackName: "Lead",
          deviceName: "Auto Filter",
          parameterName: "Frequency",
          value: 1.5,
        }],
      },
      {},
    ),
    /outside observed range 0-1/i,
  );
  assert.equal(setValueCalls, 0);
});

test("nested and third-party devices duplicate and delete through their owning chain", async () => {
  const duplicated: unknown[] = [];
  const deleted: unknown[] = [];
  const plugin = { handle: { id: "vst-1" }, name: "Serum", parameters: [] };
  const chain = sdkObject<DrumChain<"1.0.0">>(DrumChain.prototype, {
    handle: { id: "chain-1" },
    receivingNote: 36,
    devices: [plugin],
    duplicateDevice: async (device: unknown) => {
      duplicated.push(device);
      return { name: "Serum Copy" };
    },
    deleteDevice: async (device: unknown) => {
      deleted.push(device);
    },
  });
  const rack = sdkObject<DrumRack<"1.0.0">>(DrumRack.prototype, {
    handle: { id: "rack-1" },
    name: "Drum Rack",
    parameters: [],
    chains: [chain],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Drums",
    devices: [rack],
  });
  const devicePath = {
    deviceIndex: 0,
    nested: [{ chainIndex: 0, deviceIndex: 0 }],
  };

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Manage plug-in",
      actions: [
        {
          type: "duplicate_device",
          trackName: "Drums",
          deviceName: "Serum",
          devicePath,
        },
        {
          type: "delete_device",
          trackName: "Drums",
          deviceName: "Serum",
          devicePath,
        },
      ],
    },
    {},
  );

  assert.deepEqual(duplicated, [plugin]);
  assert.deepEqual(deleted, [plugin]);
  assert.match(results[0] ?? "", /Serum Copy/);
  assert.ok(rack instanceof RackDevice);
});

test("Simpler, mixer, and arm actions use observed Live objects without exposing sample paths", async () => {
  const sourcePath = "C:\\Users\\alice\\Secret Samples\\kick.wav";
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: sourcePath,
  });
  let replacedPath = "";
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: "simpler-1" },
    name: "Simpler",
    parameters: [],
    sample: null,
    replaceSample: async (filePath: string) => {
      replacedPath = filePath;
      return source;
    },
  });
  let mixerValue = -1;
  const volume = {
    name: "Track Volume",
    min: 0,
    max: 1,
    setValue: async (value: number) => {
      mixerValue = value;
    },
  };
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Drums",
    devices: [simpler],
    arm: false,
    mixer: { volume, panning: volume, sends: [] },
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Configure track",
      actions: [
        {
          type: "replace_simpler_sample",
          trackName: "Drums",
          simplerName: "Simpler",
          simplerPath: { deviceIndex: 0 },
          source: { kind: "selected" },
        },
        {
          type: "set_track_mixer_parameter",
          trackName: "Drums",
          parameter: "volume",
          value: 0.7,
        },
        { type: "set_track_arm", trackName: "Drums", arm: true },
      ],
    },
    { object: source },
  );

  assert.equal(replacedPath, sourcePath);
  assert.equal(mixerValue, 0.7);
  assert.equal(track.arm, true);
  assert.doesNotMatch(results.join("\n"), /Users|Secret Samples/);
  assert.match(results[0] ?? "", /kick\.wav/);
});

test("sample-loading host errors cannot expose observed filesystem paths", async () => {
  const privatePath = "/Users/alice/Secret Samples/kick.wav";
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-private" },
    filePath: privatePath,
  });
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: "simpler-private" },
    name: "Simpler",
    parameters: [],
    sample: null,
    replaceSample: async () => {
      throw new Error(`Cannot open ${privatePath} from /Users/alice/Secret Samples`);
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-private" },
    name: "Drums",
    devices: [simpler],
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Load the selected sample",
        actions: [{
          type: "replace_simpler_sample",
          trackName: "Drums",
          simplerName: "Simpler",
          simplerPath: { deviceIndex: 0 },
          source: { kind: "selected" },
        }],
      },
      { object: source },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.match(error.message, /could not load the observed audio sample/i);
      assert.doesNotMatch(error.message, /Users\/alice|Secret Samples|kick\.wav/);
      return true;
    },
  );
});

test("configure_drum_pad reuses the matching pad and its Simpler", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/samples/snare.wav",
  });
  let replacements = 0;
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: "simpler-1" },
    name: "Simpler",
    parameters: [],
    sample: null,
    replaceSample: async () => {
      replacements += 1;
      return source;
    },
  });
  const chain = sdkObject<DrumChain<"1.0.0">>(DrumChain.prototype, {
    handle: { id: "chain-1" },
    receivingNote: 38,
    devices: [simpler],
    insertDevice: async () => {
      throw new Error("must reuse Simpler");
    },
  });
  const rack = sdkObject<DrumRack<"1.0.0">>(DrumRack.prototype, {
    handle: { id: "rack-1" },
    name: "Drum Rack",
    parameters: [],
    chains: [chain],
    insertChain: async () => {
      throw new Error("must reuse chain");
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Drums",
    devices: [rack],
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Configure snare",
      actions: [{
        type: "configure_drum_pad",
        trackName: "Drums",
        rackName: "Drum Rack",
        rackPath: { deviceIndex: 0 },
        receivingNote: 38,
        source: { kind: "selected" },
      }],
    },
    { object: source },
  );

  assert.equal(replacements, 1);
  assert.match(results[0] ?? "", /pad 38.*snare\.wav/i);
});

test("configure_drum_pad reports granular host mutations before a later failure", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/samples/kick.wav",
  });
  const chain = sdkObject<DrumChain<"1.0.0">>(DrumChain.prototype, {
    handle: { id: "chain-1" },
    receivingNote: 0,
    devices: [],
    insertDevice: async () => ({ name: "Unexpected Device" }),
  });
  const rack = sdkObject<DrumRack<"1.0.0">>(DrumRack.prototype, {
    handle: { id: "rack-1" },
    name: "Drum Rack",
    parameters: [],
    chains: [],
    insertChain: async () => chain,
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Drums",
    devices: [rack],
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Configure kick",
        actions: [{
          type: "configure_drum_pad",
          trackName: "Drums",
          rackName: "Drum Rack",
          rackPath: { deviceIndex: 0 },
          receivingNote: 36,
          source: { kind: "selected" },
        }],
      },
      { object: source },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.completedResults.length, 3);
      assert.ok(
        error.completedActionKeys.flat().every((key) =>
          key.startsWith("live-action-step:drum-pad:"),
        ),
      );
      assert.match(error.message, /not Simpler/i);
      return true;
    },
  );
});

test("Session MIDI creation explicitly replaces an occupied slot and configures notes", async () => {
  const oldClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    name: "Old Audio",
  });
  const created = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    name: "Untitled",
    duration: 8,
    notes: [],
  });
  let deletes = 0;
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    clip: oldClip,
    deleteClip: async () => {
      deletes += 1;
      Reflect.set(slot, "clip", null);
    },
    createMidiClip: async () => created,
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    clipSlots: [slot],
  });
  const notes = [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }];

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Create Session loop",
      actions: [{
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 8,
        name: "Lead Loop",
        notes,
      }],
    },
    {},
  );

  assert.equal(deletes, 1);
  assert.equal(created.name, "Lead Loop");
  assert.deepEqual(created.notes, notes);
  assert.match(results[0] ?? "", /Session MIDI clip.*slot 0/i);
});

test("audio clip creation consumes an observed source internally for Arrangement and Session", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/private/audio/loop.wav",
  });
  const arrangementArgs: unknown[] = [];
  const sessionArgs: unknown[] = [];
  const arrangementClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    name: "Audio",
  });
  const sessionClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    name: "Session Audio",
    filePath: "/private/audio/loop.wav",
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    clip: null,
    createAudioClip: async (args: unknown) => {
      sessionArgs.push(args);
      return sessionClip;
    },
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    arrangementClips: [],
    clipSlots: [slot],
    createAudioClip: async (args: unknown) => {
      arrangementArgs.push(args);
      return arrangementClip;
    },
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Place audio",
      actions: [
        {
          type: "create_arrangement_audio_clip",
          trackName: "Audio",
          source: { kind: "selected" },
          startBeat: 16,
          durationBeats: 8,
          name: "Arrangement Loop",
          isWarped: true,
        },
        {
          type: "create_session_audio_clip",
          trackName: "Audio",
          source: { kind: "selected" },
          slotIndex: 0,
          name: "Session Loop",
          isWarped: true,
        },
      ],
    },
    { object: source },
  );

  assert.deepEqual(arrangementArgs, [{
    filePath: "/private/audio/loop.wav",
    startTime: 16,
    duration: 8,
    isWarped: true,
  }]);
  assert.deepEqual(sessionArgs, [{
    filePath: "/private/audio/loop.wav",
    isWarped: true,
  }]);
  assert.equal(arrangementClip.name, "Arrangement Loop");
  assert.equal(sessionClip.name, "Session Loop");
  assert.doesNotMatch(results.join("\n"), /private\/audio/);
});

test("clip property, Warp, range clear, and Session delete actions use exact clips", async () => {
  const clip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    name: "Vocal",
    startTime: 0,
    duration: 4,
    looping: false,
    muted: false,
    color: 0,
    warping: false,
    warpMode: WarpMode.Beats,
  });
  let sessionDeletes = 0;
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    clip,
    deleteClip: async () => {
      sessionDeletes += 1;
    },
  });
  const cleared: Array<[number, number]> = [];
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    arrangementClips: [],
    clipSlots: [slot],
    clearClipsInRange: async (start: number, end: number) => {
      cleared.push([start, end]);
    },
  });

  await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Edit audio clip",
      actions: [
        {
          type: "set_clip_properties",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Vocal",
          newName: "Vocal Edited",
          looping: true,
          muted: true,
          color: 1234,
        },
        {
          type: "set_audio_clip_warp",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Vocal Edited",
          warping: true,
          warpMode: "complex_pro",
        },
        {
          type: "clear_arrangement_range",
          trackName: "Audio",
          startBeat: 8,
          endBeat: 16,
        },
        {
          type: "delete_session_clip",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Vocal Edited",
        },
      ],
    },
    {},
  );

  assert.equal(clip.name, "Vocal Edited");
  assert.equal(clip.looping, true);
  assert.equal(clip.muted, true);
  assert.equal(clip.color, 1234);
  assert.equal(clip.warping, true);
  assert.equal(clip.warpMode, WarpMode.ComplexPro);
  assert.deepEqual(cleared, [[8, 16]]);
  assert.equal(sessionDeletes, 1);
});

test("Scene and Cue Point actions resolve exact indexes, beats, and expected names", async () => {
  const scene = sdkObject<Scene<"1.0.0">>(Scene.prototype, {
    handle: { id: "scene-1" },
    name: "Verse",
  });
  const cue = sdkObject<CuePoint<"1.0.0">>(CuePoint.prototype, {
    handle: { id: "cue-1" },
    name: "Old Drop",
    time: 16,
  });
  const createdCue = sdkObject<CuePoint<"1.0.0">>(CuePoint.prototype, {
    handle: { id: "cue-2" },
    name: "Locator",
    time: 32,
  });
  const duplicated: unknown[] = [];
  const deletedScenes: unknown[] = [];
  const deletedCues: unknown[] = [];
  const song = {
    tracks: [],
    scenes: [scene],
    cuePoints: [cue],
    duplicateScene: async (value: unknown) => {
      duplicated.push(value);
      return { name: "Drop Copy" };
    },
    deleteScene: async (value: unknown) => {
      deletedScenes.push(value);
    },
    createCuePoint: async () => {
      song.cuePoints.push(createdCue);
      return createdCue;
    },
    deleteCuePoint: async (value: unknown) => {
      deletedCues.push(value);
    },
  };

  await executeAgentPlan(
    { application: { song } } as never,
    {
      message: "Organize song",
      actions: [
        { type: "rename_scene", sceneIndex: 0, sceneName: "Verse", newName: "Drop" },
        { type: "duplicate_scene", sceneIndex: 0 },
        { type: "create_cue_point", timeBeat: 32, name: "Outro" },
        { type: "rename_cue_point", timeBeat: 16, cueName: "Old Drop", newName: "Drop" },
        { type: "delete_cue_point", timeBeat: 16, cueName: "Drop" },
        { type: "delete_scene", sceneIndex: 0, sceneName: "Drop" },
      ],
    },
    {},
  );

  assert.equal(scene.name, "Drop");
  assert.deepEqual(duplicated, [scene]);
  assert.equal(createdCue.name, "Outro");
  assert.equal(cue.name, "Drop");
  assert.deepEqual(deletedCues, [cue]);
  assert.deepEqual(deletedScenes, [scene]);
});

test("Take Lane creation and rename use exact lane identities", async () => {
  const existingLane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: "lane-1" },
    name: "Take 1",
    clips: [],
  });
  const createdLane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: "lane-2" },
    name: "Take 2",
    clips: [],
  });
  let creates = 0;
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Vocals",
    devices: [],
    takeLanes: [existingLane],
    createTakeLane: async () => {
      creates += 1;
      return createdLane;
    },
  });

  await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Organize takes",
      actions: [
        {
          type: "rename_take_lane",
          trackName: "Vocals",
          laneIndex: 0,
          laneName: "Take 1",
          newName: "Main Take",
        },
        { type: "create_take_lane", trackName: "Vocals", name: "Alternate" },
      ],
    },
    {},
  );

  assert.equal(existingLane.name, "Main Take");
  assert.equal(createdLane.name, "Alternate");
  assert.equal(creates, 1);
});

test("AgentPlanExecutionError includes completed action results", () => {
  const error = new AgentPlanExecutionError(
    ['Inserted "Operator" on track "Future Bass".'],
    new Error("Could not find parameter"),
  );

  assert.match(error.message, /Plan failed after 1 completed action/);
  assert.match(error.message, /Completed: Inserted "Operator"/);
  assert.match(error.message, /Could not find parameter/);
});

test("AgentPlanExecutionError identifies the exact failed plan action", async () => {
  const track = {
    name: "Lead",
    devices: [],
    insertDevice: async () => {
      throw new Error("Failed to insert device");
    },
  };

  await assert.rejects(
    executeAgentPlan(
      {
        application: {
          song: {
            tempo: 120,
            tracks: [track],
          },
        },
      } as never,
      {
        message: "Build the lead",
        actions: [
          { type: "set_tempo", tempo: 128 },
          {
            type: "insert_device",
            trackName: "Lead",
            deviceName: "Ping Pong Delay",
            index: 2,
          },
        ],
      },
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.deepEqual(error.completedResults, ["Set tempo to 128 BPM."]);
      assert.equal(
        (error as AgentPlanExecutionError & { failedActionIndex?: number })
          .failedActionIndex,
        1,
      );
      assert.equal(error.failedTrackName, "Lead");
      assert.match(
        error.message,
        /Failed action 2: Insert Live device "Ping Pong Delay" on track "Lead" at index 2/i,
      );
      assert.match(error.message, /Failed to insert device/);
      return true;
    },
  );
});

test("executeAgentPlan stops between actions when aborted", async () => {
  const controller = new AbortController();
  let created = 0;
  const context = {
    application: {
      song: {
        createScene: async () => {
          created += 1;
          controller.abort(new Error("Stopped by user"));
          return { name: `Scene ${created}` };
        },
      },
    },
  } as never;

  await assert.rejects(
    executeAgentPlan(
      context,
      {
        message: "Create scenes",
        actions: [
          { type: "create_scene", name: "One" },
          { type: "create_scene", name: "Two" },
        ],
      },
      {},
      controller.signal,
    ),
    /Stopped by user/,
  );
  assert.equal(created, 1);
});

test("create_midi_clip never creates an undeclared missing track", async () => {
  let createdTracks = 0;
  const context = {
    application: {
      song: {
        tracks: [],
        createMidiTrack: async () => {
          createdTracks += 1;
          return {};
        },
      },
    },
  } as never;

  await assert.rejects(
    executeAgentPlan(
      context,
      {
        message: "Create clip",
        actions: [
          {
            type: "create_midi_clip",
            trackName: "Missing",
            startBeat: 0,
            durationBeats: 4,
            notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
          },
        ],
      },
      {},
    ),
    /Add create_midi_track before create_midi_clip/,
  );
  assert.equal(createdTracks, 0);
});

for (const scenario of compositeCreationFailureScenarios()) {
  test(`${scenario.name} reports host creation when follow-up configuration fails`, async () => {
    await assert.rejects(
      executeAgentPlan(
        scenario.context as never,
        { message: scenario.name, actions: [scenario.action] } as never,
        scenario.target as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentPlanExecutionError);
        assert.equal(error.completedResults.length, 1);
        assert.match(error.completedResults[0] ?? "", scenario.completedPattern);
        assert.match(error.message, scenario.failurePattern);
        return true;
      },
    );
    assert.equal(scenario.createCalls(), 1);
  });
}

test("partial creation reporting survives an unreadable host object name", async () => {
  const scene = Object.defineProperty({}, "name", {
    configurable: true,
    get: () => {
      throw new Error("Scene name read failed");
    },
    set: () => {
      throw new Error("Scene naming failed");
    },
  });

  await assert.rejects(
    executeAgentPlan(
      {
        application: {
          song: { createScene: async () => scene },
        },
      } as never,
      {
        message: "Create named scene",
        actions: [{ type: "create_scene", name: "Verse" }],
      },
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.deepEqual(error.completedResults, [
        'Created scene "unnamed scene" without applying requested name "Verse".',
      ]);
      assert.match(error.message, /Scene naming failed/);
      return true;
    },
  );
});

function compositeCreationFailureScenarios() {
  let midiTrackCreates = 0;
  let audioTrackCreates = 0;
  let sceneCreates = 0;
  let clipCreates = 0;
  const midiTrack = failingNameObject("MIDI 1", "MIDI track naming failed");
  const audioTrack = failingNameObject("Audio 1", "Audio track naming failed");
  const scene = failingNameObject("Scene 1", "Scene naming failed");
  const clip = {
    name: "Clip 1",
    set notes(_value: unknown) {
      throw new Error("Clip notes failed");
    },
  };
  const clipTrack = Object.defineProperties(Object.create(MidiTrack.prototype), {
    name: { configurable: true, enumerable: true, value: "Lead" },
    arrangementClips: { configurable: true, enumerable: true, value: [] },
    createMidiClip: {
      configurable: true,
      enumerable: true,
      value: async () => {
        clipCreates += 1;
        return clip;
      },
    },
  });

  return [
    {
      name: "create_midi_track",
      action: { type: "create_midi_track", name: "Bass" },
      context: {
        application: {
          song: {
            tracks: [],
            createMidiTrack: async () => {
              midiTrackCreates += 1;
              return midiTrack;
            },
          },
        },
      },
      target: {},
      createCalls: () => midiTrackCreates,
      completedPattern: /Created MIDI track "MIDI 1"/,
      failurePattern: /MIDI track naming failed/,
    },
    {
      name: "create_audio_track",
      action: { type: "create_audio_track", name: "Vocals" },
      context: {
        application: {
          song: {
            tracks: [],
            createAudioTrack: async () => {
              audioTrackCreates += 1;
              return audioTrack;
            },
          },
        },
      },
      target: {},
      createCalls: () => audioTrackCreates,
      completedPattern: /Created audio track "Audio 1"/,
      failurePattern: /Audio track naming failed/,
    },
    {
      name: "create_scene",
      action: { type: "create_scene", name: "Verse" },
      context: {
        application: {
          song: {
            createScene: async () => {
              sceneCreates += 1;
              return scene;
            },
          },
        },
      },
      target: {},
      createCalls: () => sceneCreates,
      completedPattern: /Created scene "Scene 1"/,
      failurePattern: /Scene naming failed/,
    },
    {
      name: "create_midi_clip",
      action: {
        type: "create_midi_clip",
        trackName: "Lead",
        startBeat: 0,
        durationBeats: 4,
        notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
      },
      context: { application: { song: { tracks: [clipTrack] } } },
      target: {},
      createCalls: () => clipCreates,
      completedPattern: /Created MIDI clip "Clip 1" on track "Lead"/,
      failurePattern: /Clip notes failed/,
    },
  ];
}

function failingNameObject(initialName: string, message: string): object {
  const name = initialName;
  return Object.defineProperty({}, "name", {
    configurable: true,
    enumerable: true,
    get: () => name,
    set: (_value: string) => {
      throw new Error(message);
    },
  });
}

function sdkObject<T extends object>(
  prototype: object,
  properties: Record<string, unknown>,
): T {
  return Object.defineProperties(
    Object.create(prototype),
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        { configurable: true, enumerable: true, writable: true, value },
      ]),
    ),
  ) as T;
}
