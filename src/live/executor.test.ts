import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioClip,
  AudioTrack,
  ClipSlot,
  CuePoint,
  Device,
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

import { validateAgentPlan } from "../agent/actions.js";
import {
  AgentPlanExecutionError,
  executeAgentPlan,
  executeAgentPlanWithProgress,
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
    {
      tracks: new Map([["pads", track]]),
      actionTracks: new Map(),
      actionObjects: new Map(),
    },
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

test("a creator ref always creates a new track even when the name already exists", async () => {
  const insertedOnExisting: string[] = [];
  const insertedOnCreated: string[] = [];
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
  const existingTrack = midiTrack("existing", insertedOnExisting);
  const createdTrack = midiTrack("created", insertedOnCreated);

  await executeAgentPlan(
    {
      application: {
        song: {
          tracks: [existingTrack],
          createMidiTrack: async () => createdTrack,
        },
      },
    } as never,
    {
      message: "Create another Lead track",
      actions: [
        { type: "create_midi_track", ref: "lead", name: "Lead" },
        { type: "insert_device", trackRef: "lead", deviceName: "Auto Filter" },
      ],
    },
    {},
  );

  assert.deepEqual(insertedOnExisting, []);
  assert.deepEqual(insertedOnCreated, ["Auto Filter"]);
});

test("insert_device inserts another instance instead of reusing the device at that index", async () => {
  const existingDevice = { name: "Auto Filter", parameters: [] };
  const insertions: Array<{ name: string; index: number }> = [];
  const track = {
    name: "Lead",
    handle: { id: "track-1" },
    devices: [existingDevice],
    insertDevice: async (name: string, index: number) => {
      insertions.push({ name, index });
      return { name };
    },
  };

  const result = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Layer another filter",
      actions: [{
        type: "insert_device",
        trackName: "Lead",
        deviceName: "Auto Filter",
        index: 0,
      }],
    },
    {},
  );

  assert.deepEqual(insertions, [{ name: "Auto Filter", index: 0 }]);
  assert.match(result[0] ?? "", /Inserted "Auto Filter"/);
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
      actionObjects: new Map(),
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
    getValue: async () => mixerValue,
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

test("model action JSON cannot promote attachment IDs or filesystem paths into sample sources", () => {
  for (const source of [
    { kind: "path", path: "/Users/alice/Secret Samples/kick.wav" },
    { kind: "attachment", attachmentId: "attachment-private-source" },
  ]) {
    assert.throws(
      () => validateAgentPlan({
        message: "Load an untrusted source",
        actions: [{
          type: "replace_simpler_sample",
          trackName: "Drums",
          simplerName: "Simpler",
          simplerPath: { deviceIndex: 0 },
          source,
        }],
      }),
      /invalid action|source/i,
    );
  }
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
      assert.match(error.message, /could not complete the requested audio-sample operation/i);
      assert.doesNotMatch(error.message, /Users\/alice|Secret Samples|kick\.wav/);
      return true;
    },
  );
});

test("executeAgentPlanWithProgress reports an already-matching sample as no mutation", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/samples/kick.wav",
  });
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: "simpler-1" },
    name: "Simpler",
    parameters: [],
    sample: source,
    replaceSample: async () => assert.fail("matching sample must not be replaced"),
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Drums",
    devices: [simpler],
  });

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Keep the sample",
      actions: [{
        type: "replace_simpler_sample",
        trackName: "Drums",
        simplerName: "Simpler",
        simplerPath: { deviceIndex: 0 },
        source: { kind: "selected" },
      }],
    },
    { object: source },
  );

  assert.equal(outcome.mutationCount, 0);
  assert.match(outcome.results[0] ?? "", /Reused sample/i);
});

test("configure_drum_pad replaces only the explicitly targeted existing Simpler", async () => {
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
        mode: "replace_existing_simpler",
        simplerPath: {
          deviceIndex: 0,
          nested: [{ chainIndex: 0, deviceIndex: 0 }],
        },
        source: { kind: "selected" },
      }],
    },
    { object: source },
  );

  assert.equal(replacements, 1);
  assert.match(results[0] ?? "", /pad 38.*snare\.wav/i);
});

test("configure_drum_pad refuses to fill a pad that already contains devices", async () => {
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

  await assert.rejects(executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Fill only an empty pad",
      actions: [{
        type: "configure_drum_pad",
        trackName: "Drums",
        rackName: "Drum Rack",
        rackPath: { deviceIndex: 0 },
        receivingNote: 38,
        mode: "fill_empty_pad",
        source: { kind: "selected" },
      }],
    },
    { object: source },
  ), /pad 38.*not empty.*replace_existing_simpler/i);
  assert.equal(replacements, 0);
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
          mode: "fill_empty_pad",
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

test("Session MIDI creation updates changes to note expression fields", async () => {
  let noteWrites = 0;
  let currentNotes = [{
    pitch: 60,
    startTime: 0,
    duration: 1,
    velocity: 96,
    probability: 0.5,
  }];
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    name: "Lead Loop",
    duration: 8,
  });
  Object.defineProperty(clip, "notes", {
    enumerable: true,
    get: () => currentNotes,
    set: (notes) => {
      noteWrites += 1;
      currentNotes = notes;
    },
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, { clip });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    clipSlots: [slot],
  });
  const requestedNotes = [{
    pitch: 60,
    startTime: 0,
    duration: 1,
    velocity: 96,
    probability: 0.8,
  }];

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Raise note probability",
      actions: [{
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 8,
        name: "Lead Loop",
        notes: requestedNotes,
      }],
    },
    {},
  );

  assert.equal(noteWrites, 1);
  assert.deepEqual(currentNotes, requestedNotes);
  assert.equal(outcome.mutationCount, 1);
});

test("Session MIDI creation treats reordered expressive duplicates as matching", async () => {
  const notes = [
    { pitch: 60, startTime: 0, duration: 1, velocity: 96, probability: 0.25 },
    { pitch: 60, startTime: 0, duration: 1, velocity: 96, probability: 0.75 },
  ];
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    name: "Lead Loop",
    duration: 8,
    notes,
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, { clip });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    clipSlots: [slot],
  });

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Keep the same expressive notes",
      actions: [{
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 8,
        name: "Lead Loop",
        notes: [...notes].reverse(),
      }],
    },
    {},
  );

  assert.equal(outcome.mutationCount, 0);
  assert.equal(clip.notes, notes);
});

test("delete_session_clip refuses to delete a replacement created earlier in the plan", async () => {
  const original = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-original" },
    name: "Original",
    duration: 8,
    notes: [],
  });
  const replacement = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-replacement" },
    name: "Replacement",
    duration: 4,
    notes: [],
  });
  let deletes = 0;
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    handle: { id: "slot-1" },
    clip: original,
    deleteClip: async () => {
      deletes += 1;
      (slot as unknown as { clip: MidiClip<"1.0.0"> | null }).clip = null;
    },
    createMidiClip: async () => {
      (slot as unknown as { clip: MidiClip<"1.0.0"> | null }).clip = replacement;
      return replacement;
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    clipSlots: [slot],
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Replace, then delete the original",
        actions: [
          {
            type: "create_session_midi_clip",
            trackName: "Lead",
            slotIndex: 0,
            durationBeats: 4,
            name: "Replacement",
            notes: [],
          },
          {
            type: "delete_session_clip",
            trackName: "Lead",
            slotIndex: 0,
            clipName: "Original",
          },
        ],
      },
      {},
    ),
    /Session slot 0 changed earlier in this plan/i,
  );

  assert.equal(deletes, 1);
  assert.equal(slot.clip, replacement);
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

test("same-source Session audio applies requested Warp and loop settings", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/private/audio/loop.wav",
  });
  const existing = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-1" },
    name: "Old Loop",
    filePath: "/private/audio/loop.wav",
    warping: false,
    looping: false,
    startMarker: 0,
    endMarker: 8,
    loopStart: 0,
    loopEnd: 8,
  });
  const created = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-2" },
    name: "New Audio",
    filePath: "/private/audio/loop.wav",
    warping: true,
    looping: true,
    startMarker: 1,
    endMarker: 7,
    loopStart: 2,
    loopEnd: 6,
  });
  const createArgs: unknown[] = [];
  let deletes = 0;
  let creates = 0;
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    clip: existing,
    deleteClip: async () => { deletes += 1; },
    createAudioClip: async (args: unknown) => {
      creates += 1;
      createArgs.push(args);
      return created;
    },
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    arrangementClips: [],
    clipSlots: [slot],
  });

  const results = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Update the existing loop",
      actions: [{
        type: "create_session_audio_clip",
        trackName: "Audio",
        source: { kind: "selected" },
        slotIndex: 0,
        name: "Warped Loop",
        isWarped: true,
        loopSettings: {
          looping: true,
          startMarker: 1,
          endMarker: 7,
          loopStart: 2,
          loopEnd: 6,
        },
      }],
    },
    { object: source },
  );

  assert.equal(deletes, 1);
  assert.equal(creates, 1);
  assert.deepEqual(createArgs, [{
    filePath: "/private/audio/loop.wav",
    isWarped: true,
    loopSettings: {
      looping: true,
      startMarker: 1,
      endMarker: 7,
      loopStart: 2,
      loopEnd: 6,
    },
  }]);
  assert.equal(created.name, "Warped Loop");
  assert.match(results[0] ?? "", /Created Session audio clip/i);
});

test("a Warp-only Session audio mismatch deletes and recreates the slot Clip", async () => {
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/private/audio/loop.wav",
  });
  const existing = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-1" },
    name: "Old Loop",
    filePath: "/private/audio/loop.wav",
    warping: false,
    looping: false,
    startMarker: 0,
    endMarker: 8,
    loopStart: 0,
    loopEnd: 8,
  });
  const created = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-2" },
    name: "New Loop",
    filePath: "/private/audio/loop.wav",
    warping: true,
  });
  let deletes = 0;
  const createArgs: unknown[] = [];
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    clip: existing,
    deleteClip: async () => { deletes += 1; },
    createAudioClip: async (args: unknown) => {
      createArgs.push(args);
      return created;
    },
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    arrangementClips: [],
    clipSlots: [slot],
  });

  await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Enable Warp",
      actions: [{
        type: "create_session_audio_clip",
        trackName: "Audio",
        source: { kind: "selected" },
        slotIndex: 0,
        isWarped: true,
      }],
    },
    { object: source },
  );

  assert.equal(deletes, 1);
  assert.deepEqual(createArgs, [{
    filePath: "/private/audio/loop.wav",
    isWarped: true,
  }]);
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
  const arrangementClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    name: "Range Clip",
    startTime: 8,
    duration: 4,
  });
  const cleared: Array<[number, number]> = [];
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    arrangementClips: [arrangementClip],
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
          clipName: "Vocal",
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
          clipName: "Vocal",
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
        { type: "delete_cue_point", timeBeat: 16, cueName: "Old Drop" },
        { type: "delete_scene", sceneIndex: 0, sceneName: "Verse" },
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

test("structural Scene actions keep the originally confirmed Scene handles", async () => {
  const scenes = ["A", "B", "C"].map((name, index) =>
    sdkObject<Scene<"1.0.0">>(Scene.prototype, {
      handle: { id: `scene-${index}` },
      name,
    })
  );
  const deleted: string[] = [];
  const song = {
    tracks: [],
    scenes,
    cuePoints: [],
    deleteScene: async (scene: Scene<"1.0.0">) => {
      deleted.push(scene.name);
      song.scenes.splice(song.scenes.indexOf(scene), 1);
    },
  };

  await executeAgentPlan(
    { application: { song } } as never,
    {
      message: "Delete A and B",
      actions: [
        { type: "delete_scene", sceneIndex: 0, sceneName: "A" },
        { type: "delete_scene", sceneIndex: 1, sceneName: "B" },
      ],
    },
    {},
  );

  assert.deepEqual(deleted, ["A", "B"]);
  assert.deepEqual(song.scenes.map((scene) => scene.name), ["C"]);
});

test("structural Device actions keep the originally confirmed Device handles", async () => {
  const devices = [0, 1, 2].map((index) =>
    sdkObject<Device<"1.0.0">>(Device.prototype, {
      handle: { id: `device-${index}` },
      name: "Utility",
      parameters: [],
    })
  );
  const deleted: string[] = [];
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices,
    deleteDevice: async (device: Device<"1.0.0">) => {
      deleted.push(String(device.handle.id));
      track.devices.splice(track.devices.indexOf(device), 1);
    },
  });

  await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Delete the first two Utilities",
      actions: [
        { type: "delete_device", trackName: "Lead", deviceName: "Utility", deviceIndex: 0 },
        { type: "delete_device", trackName: "Lead", deviceName: "Utility", deviceIndex: 1 },
      ],
    },
    {},
  );

  assert.deepEqual(deleted, ["device-0", "device-1"]);
  assert.deepEqual(track.devices.map((device) => device.handle.id), ["device-2"]);
});

test("already-matching scalar writes do not count as Live mutations", async () => {
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    mute: false,
    solo: true,
    arm: false,
  });
  const song = { tracks: [track], tempo: 120 };

  const outcome = await executeAgentPlanWithProgress(
    { application: { song } } as never,
    {
      message: "Keep current values",
      actions: [
        { type: "set_tempo", tempo: 120 },
        { type: "rename_track", trackName: "Lead", newName: "Lead" },
        { type: "set_track_mute", trackName: "Lead", mute: false },
        { type: "set_track_solo", trackName: "Lead", solo: true },
        { type: "set_track_arm", trackName: "Lead", arm: false },
      ],
    },
    {},
  );

  assert.equal(outcome.mutationCount, 0);
  assert.equal(outcome.results.length, 5);
});

test("executeAgentPlanWithProgress checks its guard between atomic actions", async () => {
  const song = { tracks: [], tempo: 120 };
  const boundaryIndexes: number[] = [];

  await assert.rejects(
    executeAgentPlanWithProgress(
      { application: { song } } as never,
      {
        message: "Change tempo twice",
        actions: [
          { type: "set_tempo", tempo: 121 },
          { type: "set_tempo", tempo: 122 },
        ],
      },
      {},
      undefined,
      undefined,
      (actionIndex) => {
        boundaryIndexes.push(actionIndex);
        if (actionIndex === 1) {
          throw new Error("Newer user guidance superseded the remaining plan.");
        }
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.failedActionIndex, 1);
      assert.equal(error.completedResults.length, 1);
      assert.equal(error.completedMutationCount, 1);
      assert.match(error.message, /newer user guidance/i);
      return true;
    },
  );

  assert.deepEqual(boundaryIndexes, [0, 1]);
  assert.equal(song.tempo, 121);
});

test("already-matching parameter and Clip writes do not invoke SDK setters", async () => {
  let parameterWrites = 0;
  const parameter = {
    handle: { id: "parameter-1" },
    name: "Gain",
    min: 0,
    max: 1,
    getValue: async () => 0.5,
    setValue: async () => {
      parameterWrites += 1;
    },
  };
  const device = sdkObject<Device<"1.0.0">>(Device.prototype, {
    handle: { id: "device-1" },
    name: "Utility",
    parameters: [parameter],
  });
  const clip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip-1" },
    name: "Vocal",
    looping: false,
    muted: false,
    color: 0,
    warping: false,
    warpMode: WarpMode.Beats,
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    handle: { id: "slot-1" },
    clip,
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [device],
    clipSlots: [slot],
    mixer: { volume: parameter, panning: parameter, sends: [] },
  });

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Keep exact settings",
      actions: [
        {
          type: "set_device_parameter",
          trackName: "Audio",
          deviceName: "Utility",
          deviceIndex: 0,
          parameterName: "Gain",
          value: 0.5,
        },
        {
          type: "set_track_mixer_parameter",
          trackName: "Audio",
          parameter: "volume",
          value: 0.5,
        },
        {
          type: "set_clip_properties",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Vocal",
          looping: false,
          muted: false,
          color: 0,
        },
        {
          type: "set_audio_clip_warp",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Vocal",
          warping: false,
          warpMode: "beats",
        },
      ],
    },
    {},
  );

  assert.equal(outcome.mutationCount, 0);
  assert.equal(parameterWrites, 0);
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

test("MIDI and audio Clip creation use the exact existing Take Lane", async () => {
  let trackMidiCreates = 0;
  let laneMidiCreates = 0;
  const createdMidi = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "midi-clip" },
    name: "Untitled",
    startTime: 8,
    duration: 4,
    notes: [],
  });
  const midiLane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: "midi-lane" },
    name: "Alternate MIDI",
    clips: [],
    createMidiClip: async (startBeat: number, durationBeats: number) => {
      laneMidiCreates += 1;
      assert.equal(startBeat, 8);
      assert.equal(durationBeats, 4);
      return createdMidi;
    },
  });
  const midiTrack = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "midi-track" },
    name: "Lead",
    arrangementClips: [],
    takeLanes: [midiLane],
    createMidiClip: async () => {
      trackMidiCreates += 1;
      return createdMidi;
    },
  });

  let trackAudioCreates = 0;
  let laneAudioArgs: unknown;
  const createdAudio = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "audio-clip" },
    name: "Untitled",
  });
  const audioLane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: "audio-lane" },
    name: "Double",
    clips: [],
    createAudioClip: async (args: unknown) => {
      laneAudioArgs = args;
      return createdAudio;
    },
  });
  const audioTrack = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "audio-track" },
    name: "Vocals",
    arrangementClips: [],
    takeLanes: [audioLane],
    createAudioClip: async () => {
      trackAudioCreates += 1;
      return createdAudio;
    },
  });
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: "sample" },
    filePath: "/private/voice.wav",
  });

  const result = await executeAgentPlan(
    { application: { song: { tracks: [midiTrack, audioTrack] } } } as never,
    {
      message: "Write alternate takes",
      actions: [
        {
          type: "create_midi_clip",
          trackName: "Lead",
          laneIndex: 0,
          laneName: "Alternate MIDI",
          startBeat: 8,
          durationBeats: 4,
          name: "Lead alternate",
          notes: [{
            pitch: 64,
            startTime: 0,
            duration: 1,
            velocity: 96,
            probability: 0.75,
          }],
        },
        {
          type: "create_arrangement_audio_clip",
          trackName: "Vocals",
          laneIndex: 0,
          laneName: "Double",
          source: { kind: "selected" },
          startBeat: 16,
          durationBeats: 8,
          name: "Vocal double",
          isWarped: true,
          loopSettings: {
            looping: false,
            startMarker: 0,
            endMarker: 8,
            loopStart: 0,
            loopEnd: 8,
          },
        },
      ],
    },
    { object: source },
  );

  assert.equal(laneMidiCreates, 1);
  assert.equal(trackMidiCreates, 0);
  assert.equal(createdMidi.name, "Lead alternate");
  assert.deepEqual(createdMidi.notes, [{
    pitch: 64,
    startTime: 0,
    duration: 1,
    velocity: 96,
    probability: 0.75,
  }]);
  assert.equal(trackAudioCreates, 0);
  assert.deepEqual(laneAudioArgs, {
    filePath: "/private/voice.wav",
    startTime: 16,
    duration: 8,
    isWarped: true,
    loopSettings: {
      looping: false,
      startMarker: 0,
      endMarker: 8,
      loopStart: 0,
      loopEnd: 8,
    },
  });
  assert.equal(createdAudio.name, "Vocal double");
  assert.match(result.join("\n"), /Take Lane 0 "Alternate MIDI"/);
  assert.match(result.join("\n"), /Take Lane 0 "Double"/);

  midiLane.clips.push(createdMidi);
  await executeAgentPlan(
    { application: { song: { tracks: [midiTrack, audioTrack] } } } as never,
    {
      message: "Update the exact named take",
      actions: [{
        type: "create_midi_clip",
        trackName: "Lead",
        laneIndex: 0,
        laneName: "Alternate MIDI",
        startBeat: 8,
        durationBeats: 4,
        name: "Lead alternate",
        notes: [{ pitch: 67, startTime: 0, duration: 2, velocity: 88 }],
      }],
    },
    {},
  );
  assert.equal(laneMidiCreates, 1);
  assert.deepEqual(createdMidi.notes, [
    { pitch: 67, startTime: 0, duration: 2, velocity: 88 },
  ]);
});

test("a named Take Lane MIDI Clip can resume after its initial note write fails", async () => {
  const clips: MidiClip<"1.0.0">[] = [];
  let creates = 0;
  let noteWrites = 0;
  let savedNotes: unknown[] = [];
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "created-clip" },
    name: "Untitled",
    startTime: 0,
    duration: 4,
  });
  Object.defineProperty(clip, "notes", {
    configurable: true,
    get: () => savedNotes,
    set: (notes: unknown[]) => {
      noteWrites += 1;
      if (noteWrites === 1) throw new Error("Transient note write failure");
      savedNotes = notes;
    },
  });
  const lane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: "lane-1" },
    name: "Alternate",
    clips,
    createMidiClip: async () => {
      creates += 1;
      clips.push(clip);
      return clip;
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [],
    takeLanes: [lane],
  });
  const context = { application: { song: { tracks: [track] } } } as never;
  const plan = {
    message: "Write the alternate phrase",
    actions: [{
      type: "create_midi_clip" as const,
      trackName: "Lead",
      laneIndex: 0,
      laneName: "Alternate",
      startBeat: 0,
      durationBeats: 4,
      name: "Alternate phrase",
      notes: [{ pitch: 64, startTime: 0, duration: 1, velocity: 96 }],
    }],
  };

  await assert.rejects(
    executeAgentPlan(context, plan, {}),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.completedMutationCount, 2);
      assert.equal(error.completedActionKeys.length, 1);
      assert.deepEqual(error.completedActionKeys, [[
        "live-action-step:retryable-named-midi-create",
      ]]);
      return true;
    },
  );

  await executeAgentPlan(context, plan, {});
  assert.equal(creates, 1);
  assert.equal(noteWrites, 2);
  assert.deepEqual(savedNotes, plan.actions[0]?.notes);
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
        if (scenario.name === "create_midi_clip") {
          assert.ok(error.completedActionKeys.length > 0);
          assert.ok(error.completedActionKeys.flat().every(
            (key) => key.startsWith("live-action:") && !key.includes("action-step"),
          ));
        }
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

test("whole-Clip MIDI transforms edit exact Arrangement and Session clips", async () => {
  const arrangement = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "arrangement-clip" },
    name: "Verse",
    startTime: 8,
    duration: 4,
    notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 80 }],
  });
  const session = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "session-clip" },
    name: "Loop",
    startTime: 0,
    duration: 4,
    notes: [{ pitch: 64, startTime: 0.3, duration: 0.5, velocity: 100 }],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [arrangement],
    clipSlots: [{ handle: { id: "slot-1" }, clip: session }],
  });

  const result = await executeAgentPlan(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Transform both clips",
      actions: [
        {
          type: "transpose_midi_notes",
          trackName: "Lead",
          clipName: "Verse",
          startBeat: 8,
          semitones: 7,
        },
        {
          type: "quantize_midi_notes",
          trackName: "Lead",
          clipName: "Loop",
          slotIndex: 0,
          gridBeats: 0.25,
          strength: 1,
        },
      ],
    },
    {},
  );

  assert.equal(arrangement.notes[0]?.pitch, 67);
  assert.equal(session.notes[0]?.startTime, 0.25);
  assert.match(result[0] ?? "", /Transposed every note by 7 semitones/);
  assert.match(result[1] ?? "", /Quantized every note start/);
});

test("whole-Clip MIDI transforms fail before mutation when output leaves bounds", async () => {
  const original = [{ pitch: 127, startTime: 0, duration: 1, velocity: 80 }];
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "High",
    startTime: 0,
    duration: 4,
    notes: original,
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [clip],
    clipSlots: [],
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Too high",
        actions: [{
          type: "transpose_midi_notes",
          trackName: "Lead",
          startBeat: 0,
          semitones: 1,
        }],
      },
      {},
    ),
    /pitch 128.*outside/i,
  );
  assert.deepEqual(clip.notes, original);
});

test("velocity factor one preserves an implicit SDK default as a no-op", async () => {
  const notes = [{ pitch: 60, startTime: 0, duration: 1 }];
  let noteWrites = 0;
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "Loop",
    startTime: 0,
    duration: 4,
  });
  Object.defineProperty(clip, "notes", {
    configurable: true,
    get: () => notes,
    set: () => {
      noteWrites += 1;
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [clip],
    clipSlots: [],
  });

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Keep default velocity",
      actions: [{
        type: "scale_midi_velocity",
        trackName: "Lead",
        startBeat: 0,
        factor: 1,
      }],
    },
    {},
  );

  assert.equal(outcome.mutationCount, 0);
  assert.equal(noteWrites, 0);
  assert.match(outcome.results[0] ?? "", /no note changes/i);
});

test("a transform refuses a Session Clip replaced earlier in the same plan", async () => {
  const detached = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-old" },
    name: "Loop",
    duration: 8,
    notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }],
  });
  const replacement = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-new" },
    name: "Untitled",
    duration: 4,
    notes: [],
  });
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    handle: { id: "slot-1" },
    clip: detached,
    deleteClip: async () => {
      (slot as unknown as { clip: MidiClip<"1.0.0"> | null }).clip = null;
    },
    createMidiClip: async () => {
      (slot as unknown as { clip: MidiClip<"1.0.0"> | null }).clip = replacement;
      return replacement;
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [],
    clipSlots: [slot],
  });

  await assert.rejects(
    executeAgentPlanWithProgress(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Replace then transpose",
        actions: [
          {
            type: "create_session_midi_clip",
            trackName: "Lead",
            slotIndex: 0,
            durationBeats: 4,
            name: "Loop",
            notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
          },
          {
            type: "transpose_midi_notes",
            trackName: "Lead",
            clipName: "Loop",
            slotIndex: 0,
            semitones: 12,
          },
        ],
      },
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.completedResults.length, 1);
      assert.match(error.message, /MIDI Clip.*changed earlier in this plan/i);
      return true;
    },
  );

  assert.equal(slot.clip, replacement);
  assert.equal(replacement.notes[0]?.pitch, 60);
  assert.equal(detached.notes[0]?.pitch, 48);
});

test("a transform refuses an Arrangement Clip replaced earlier in the same plan", async () => {
  const detached = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-old" },
    name: "Verse",
    startTime: 8,
    duration: 8,
    notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }],
  });
  const replacement = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-new" },
    name: "Untitled",
    startTime: 8,
    duration: 4,
    notes: [],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [detached],
    clipSlots: [],
    createMidiClip: async () => {
      (track as unknown as { arrangementClips: MidiClip<"1.0.0">[] })
        .arrangementClips = [replacement];
      return replacement;
    },
  });

  await assert.rejects(
    executeAgentPlanWithProgress(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Replace then transpose",
        actions: [
          {
            type: "create_midi_clip",
            trackName: "Lead",
            startBeat: 8,
            durationBeats: 4,
            name: "Verse",
            notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
          },
          {
            type: "transpose_midi_notes",
            trackName: "Lead",
            clipName: "Verse",
            startBeat: 8,
            semitones: 12,
          },
        ],
      },
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.completedResults.length, 1);
      assert.match(error.message, /MIDI Clip.*changed earlier in this plan/i);
      return true;
    },
  );

  assert.equal(track.arrangementClips[0], replacement);
  assert.equal(replacement.notes[0]?.pitch, 60);
  assert.equal(detached.notes[0]?.pitch, 48);
});

test("sequential transforms keep using the same unchanged Clip handle", async () => {
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "Verse",
    startTime: 8,
    duration: 4,
    notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [clip],
    clipSlots: [],
  });

  const outcome = await executeAgentPlanWithProgress(
    { application: { song: { tracks: [track] } } } as never,
    {
      message: "Transform twice",
      actions: [
        {
          type: "transpose_midi_notes",
          trackName: "Lead",
          startBeat: 8,
          semitones: 12,
        },
        {
          type: "scale_midi_velocity",
          trackName: "Lead",
          startBeat: 8,
          factor: 0.5,
        },
      ],
    },
    {},
  );

  assert.equal(outcome.mutationCount, 2);
  assert.deepEqual(clip.notes, [
    { pitch: 72, startTime: 0, duration: 1, velocity: 50 },
  ]);
});

test("timing transforms apply exact changes below the host round-trip tolerance", async () => {
  const scenarios = [
    {
      name: "tiny shift",
      startTime: 1,
      action: {
        type: "shift_midi_notes",
        trackName: "Lead",
        startBeat: 0,
        offsetBeats: 5e-8,
      },
      expectedStartTime: 1 + 5e-8,
    },
    {
      name: "near-grid quantize",
      startTime: 1.00000005,
      action: {
        type: "quantize_midi_notes",
        trackName: "Lead",
        startBeat: 0,
        gridBeats: 1,
        strength: 1,
      },
      expectedStartTime: 1,
    },
  ] as const;

  for (const scenario of scenarios) {
    const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
      handle: { id: `clip-${scenario.name}` },
      name: "Precise",
      startTime: 0,
      duration: 4,
      notes: [{
        pitch: 60,
        startTime: scenario.startTime,
        duration: 1,
        velocity: 100,
      }],
    });
    const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
      handle: { id: `track-${scenario.name}` },
      name: "Lead",
      devices: [],
      arrangementClips: [clip],
      clipSlots: [],
    });

    const outcome = await executeAgentPlanWithProgress(
      { application: { song: { tracks: [track] } } } as never,
      { message: scenario.name, actions: [scenario.action] },
      {},
    );

    assert.equal(outcome.mutationCount, 1, scenario.name);
    assert.equal(
      clip.notes[0]?.startTime,
      scenario.expectedStartTime,
      scenario.name,
    );
  }
});

test("non-finite quantization fails before assigning Clip notes", async () => {
  const notes = [{ pitch: 60, startTime: 0.3, duration: 1, velocity: 100 }];
  let noteWrites = 0;
  const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "Loop",
    startTime: 0,
    duration: 4,
  });
  Object.defineProperty(clip, "notes", {
    configurable: true,
    get: () => notes,
    set: () => {
      noteWrites += 1;
    },
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [clip],
    clipSlots: [],
  });

  await assert.rejects(
    executeAgentPlan(
      { application: { song: { tracks: [track] } } } as never,
      {
        message: "Unsafe quantize",
        actions: [{
          type: "quantize_midi_notes",
          trackName: "Lead",
          startBeat: 0,
          gridBeats: Number.MIN_VALUE,
          strength: 1,
        }],
      },
      {},
    ),
    /quantize.*finite/i,
  );
  assert.equal(noteWrites, 0);
  assert.deepEqual(notes, [{ pitch: 60, startTime: 0.3, duration: 1, velocity: 100 }]);
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
