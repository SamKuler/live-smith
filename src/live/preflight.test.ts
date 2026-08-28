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
} from "@ableton-extensions/sdk";

import { captureLiveActionPreflightSnapshot } from "./preflight.js";

test("create_midi_clip snapshot binds a matching replacement clip by handle identity", async () => {
  const firstClip = midiClip(101n);
  const clips = [firstClip];
  const track = midiTrack(11n, clips);
  const context = liveContext(track);
  const action = {
    type: "create_midi_clip" as const,
    trackName: "Bass",
    name: "Phrase",
    startBeat: 0,
    durationBeats: 4,
    notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  clips[0] = midiClip(202n);
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("create_midi_clip snapshot detects notes edited while confirmation is open", async () => {
  const clip = midiClip(101n);
  const track = midiTrack(11n, [clip]);
  const context = liveContext(track);
  const action = {
    type: "create_midi_clip" as const,
    trackName: "Bass",
    name: "Phrase",
    startBeat: 0,
    durationBeats: 4,
    notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  clip.notes = [{ pitch: 48, startTime: 0, duration: 2, velocity: 90 }];
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("Take Lane MIDI preflight fingerprints an exact reuse and rejects other overlaps", async () => {
  const reusable = midiClip(101n);
  const unrelated = midiClip(102n);
  Object.defineProperties(unrelated, {
    name: { configurable: true, value: "Later" },
    startTime: { configurable: true, value: 16 },
    duration: { configurable: true, value: 4 },
  });
  const lane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: 301n },
    name: "Take 1",
    clips: [reusable, unrelated],
  });
  const track = midiTrack(11n, []);
  Object.defineProperty(track, "takeLanes", {
    configurable: true,
    value: [lane],
  });
  const context = liveContext(track);
  const action = {
    type: "create_midi_clip" as const,
    trackName: "Bass",
    laneIndex: 0,
    laneName: "Take 1",
    name: "Phrase",
    startBeat: 0,
    durationBeats: 4,
    notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  unrelated.notes = [{ pitch: 72, startTime: 0, duration: 1, velocity: 80 }];
  const outsideRange = await captureLiveActionPreflightSnapshot(context, action, {});
  assert.equal(outsideRange, before);
  reusable.notes = [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }];
  const after = await captureLiveActionPreflightSnapshot(context, action, {});
  assert.notEqual(after, before);

  const overlap = midiClip(103n);
  Object.defineProperties(overlap, {
    name: { configurable: true, value: "Other" },
    startTime: { configurable: true, value: 8 },
    duration: { configurable: true, value: 4 },
  });
  lane.clips.push(overlap);
  await assert.rejects(
    captureLiveActionPreflightSnapshot(
      context,
      { ...action, name: "New", startBeat: 10, durationBeats: 2 },
      {},
    ),
    /Take Lane "Take 1" is not empty.*Other.*8-12/i,
  );
});

test("replace_midi_clip_segment snapshot detects clip edits while confirmation is open", async () => {
  const clip = midiClip(101n);
  const track = midiTrack(11n, [clip]);
  const context = liveContext(track);
  const action = {
    type: "replace_midi_clip_segment" as const,
    trackName: "Bass",
    clipName: "Phrase",
    startBeat: 0,
    segmentStartTime: 0,
    segmentDurationBeats: 2,
    notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  clip.notes = [{ pitch: 48, startTime: 0, duration: 2, velocity: 90 }];
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("whole-Clip MIDI transform snapshot detects note drift", async () => {
  const clip = midiClip(101n);
  clip.notes = [{ pitch: 60, startTime: 0, duration: 1, velocity: 90 }];
  const track = midiTrack(11n, [clip]);
  const context = liveContext(track);
  const action = {
    type: "transpose_midi_notes" as const,
    trackName: "Bass",
    clipName: "Phrase",
    startBeat: 0,
    semitones: 12,
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  clip.notes = [{ pitch: 61, startTime: 0, duration: 1, velocity: 90 }];
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("MIDI clip snapshots ignore opaque bigint note metadata while tracking musical fields", async () => {
  const clip = midiClip(101n);
  const note = {
    pitch: 48,
    startTime: 0,
    duration: 2,
    velocity: 90,
    hostIdentity: 9001n,
  };
  clip.notes = [note as never];
  const track = midiTrack(11n, [clip]);
  const context = liveContext(track);
  const action = {
    type: "replace_midi_clip_segment" as const,
    trackName: "Bass",
    clipName: "Phrase",
    startBeat: 0,
    segmentStartTime: 0,
    segmentDurationBeats: 2,
    notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
  };

  const original = await captureLiveActionPreflightSnapshot(context, action, {});
  note.hostIdentity = 9002n;
  const metadataChanged = await captureLiveActionPreflightSnapshot(context, action, {});
  note.pitch = 49;
  const pitchChanged = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.equal(metadataChanged, original);
  assert.notEqual(pitchChanged, original);
});

test("delete_clip snapshot binds the resolved clip by handle identity", async () => {
  const clips = [midiClip(101n)];
  const track = midiTrack(11n, clips);
  const context = liveContext(track);
  const action = {
    type: "delete_clip" as const,
    trackName: "Bass",
    clipName: "Phrase",
    startBeat: 0,
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  clips[0] = midiClip(202n);
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("set_device_parameter snapshot binds device, parameter, range, and value", async () => {
  let value = 0.25;
  const parameter = {
    handle: { id: 301n },
    name: "Frequency",
    min: 0,
    max: 1,
    getValue: async () => value,
  };
  const device = {
    handle: { id: 201n },
    name: "Auto Filter",
    parameters: [parameter],
  };
  const track = midiTrack(11n, [], [device]);
  const context = liveContext(track);
  const action = {
    type: "set_device_parameter" as const,
    trackName: "Bass",
    deviceName: "Auto Filter",
    parameterName: "Frequency",
    value: 0.5,
  };

  const original = await captureLiveActionPreflightSnapshot(context, action, {});
  parameter.max = 2;
  const changedRange = await captureLiveActionPreflightSnapshot(context, action, {});
  parameter.max = 1;
  parameter.handle.id = 302n;
  const changedIdentity = await captureLiveActionPreflightSnapshot(context, action, {});
  parameter.handle.id = 301n;
  value = 0.75;
  const changedValue = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(changedRange, original);
  assert.notEqual(changedIdentity, original);
  assert.notEqual(changedValue, original);
});

test("tempo, mute, and solo snapshots include the value another Session can overwrite", async () => {
  const track = midiTrack(11n, []);
  const context = liveContext(track);
  const song = (context as unknown as {
    application: { song: { tempo: number } };
  }).application.song;

  const tempoBefore = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_tempo", tempo: 128 },
    {},
  );
  song.tempo = 132;
  const tempoAfter = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_tempo", tempo: 128 },
    {},
  );

  const muteBefore = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_track_mute", trackName: "Bass", mute: true },
    {},
  );
  track.mute = true;
  const muteAfter = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_track_mute", trackName: "Bass", mute: true },
    {},
  );

  const soloBefore = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_track_solo", trackName: "Bass", solo: true },
    {},
  );
  track.solo = true;
  const soloAfter = await captureLiveActionPreflightSnapshot(
    context,
    { type: "set_track_solo", trackName: "Bass", solo: true },
    {},
  );

  assert.notEqual(tempoAfter, tempoBefore);
  assert.notEqual(muteAfter, muteBefore);
  assert.notEqual(soloAfter, soloBefore);
});

test("nested device and Rack snapshots bind structural handles", async () => {
  let value = 0.25;
  const parameter = {
    handle: { id: 303n },
    name: "Gain",
    min: 0,
    max: 1,
    getValue: async () => value,
  };
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: 302n },
    name: "Kick Simpler",
    parameters: [parameter],
    sample: null,
  });
  const chain = sdkObject<DrumChain<"1.0.0">>(DrumChain.prototype, {
    handle: { id: 301n },
    receivingNote: 36,
    devices: [simpler],
  });
  const rack = sdkObject<DrumRack<"1.0.0">>(DrumRack.prototype, {
    handle: { id: 300n },
    name: "Drum Rack",
    parameters: [],
    chains: [chain],
  });
  const track = midiTrack(11n, [], [rack]);
  const context = liveContext(track);
  const action = {
    type: "set_device_parameter" as const,
    trackName: "Bass",
    deviceName: "Kick Simpler",
    devicePath: {
      deviceIndex: 0,
      nested: [{ chainIndex: 0, deviceIndex: 0 }],
    },
    parameterName: "Gain",
    value: 0.5,
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  value = 0.75;
  const afterValue = await captureLiveActionPreflightSnapshot(context, action, {});
  parameter.handle.id = 304n;
  const afterHandle = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(afterValue, before);
  assert.notEqual(afterHandle, afterValue);
  assert.ok(rack instanceof RackDevice);
});

test("Drum Pad replacement snapshot detects an existing Simpler sample change", async () => {
  const oldSample = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: 401n },
    filePath: "/private/samples/old.wav",
  });
  const newSample = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: 402n },
    filePath: "/private/samples/new.wav",
  });
  const source = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: 403n },
    filePath: "/private/samples/replacement.wav",
  });
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: 404n },
    name: "Simpler",
    parameters: [],
    sample: oldSample,
  });
  const chain = sdkObject<DrumChain<"1.0.0">>(DrumChain.prototype, {
    handle: { id: 405n },
    receivingNote: 36,
    devices: [simpler],
  });
  const rack = sdkObject<DrumRack<"1.0.0">>(DrumRack.prototype, {
    handle: { id: 406n },
    name: "Drum Rack",
    parameters: [],
    chains: [chain],
  });
  const track = midiTrack(11n, [], [rack]);
  const action = {
    type: "configure_drum_pad" as const,
    trackName: "Bass",
    rackName: "Drum Rack",
    rackPath: { deviceIndex: 0 },
    receivingNote: 36,
    mode: "replace_existing_simpler" as const,
    simplerPath: {
      deviceIndex: 0,
      nested: [{ chainIndex: 0, deviceIndex: 0 }],
    },
    source: { kind: "selected" as const },
  };

  const before = await captureLiveActionPreflightSnapshot(
    liveContext(track), action, { object: source },
  );
  Reflect.set(simpler, "sample", newSample);
  const after = await captureLiveActionPreflightSnapshot(
    liveContext(track), action, { object: source },
  );

  assert.notEqual(after, before);
});

test("Simpler sample and mixer snapshots include source, target, range, and current value", async () => {
  const sourceClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: 501n },
    name: "Kick",
    startTime: 0,
    duration: 4,
    filePath: "/private/samples/kick.wav",
  });
  const oldSample = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: 401n },
    filePath: "/private/samples/old.wav",
  });
  const simpler = sdkObject<Simpler<"1.0.0">>(Simpler.prototype, {
    handle: { id: 402n },
    name: "Simpler",
    parameters: [],
    sample: oldSample,
  });
  let mixerValue = 0.5;
  const volume = {
    handle: { id: 601n },
    name: "Track Volume",
    min: 0,
    max: 1,
    getValue: async () => mixerValue,
  };
  const targetTrack = midiTrack(11n, [], [simpler]);
  Object.defineProperty(targetTrack, "mixer", {
    configurable: true,
    value: { volume, panning: volume, sends: [] },
  });
  const sourceTrack = Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { value: { id: 12n } },
    name: { value: "Samples" },
    arrangementClips: { value: [sourceClip] },
    clipSlots: { value: [] },
    devices: { value: [] },
  }) as MidiTrack<"1.0.0">;
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tempo: 120,
        tracks: [targetTrack, sourceTrack],
        scenes: [],
      },
    },
  } as never;

  const sampleBefore = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "replace_simpler_sample",
      trackName: "Bass",
      simplerName: "Simpler",
      simplerPath: { deviceIndex: 0 },
      source: {
        kind: "arrangement_audio_clip",
        trackName: "Samples",
        clipName: "Kick",
        startBeat: 0,
      },
    },
    {},
  );
  const newTargetSample = sdkObject<Sample<"1.0.0">>(Sample.prototype, {
    handle: { id: 403n },
    filePath: "/private/samples/new-target.wav",
  });
  Reflect.set(simpler, "sample", newTargetSample);
  const targetSampleAfter = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "replace_simpler_sample",
      trackName: "Bass",
      simplerName: "Simpler",
      simplerPath: { deviceIndex: 0 },
      source: {
        kind: "arrangement_audio_clip",
        trackName: "Samples",
        clipName: "Kick",
        startBeat: 0,
      },
    },
    {},
  );
  sourceClip.handle.id = 502n;
  const sampleAfter = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "replace_simpler_sample",
      trackName: "Bass",
      simplerName: "Simpler",
      simplerPath: { deviceIndex: 0 },
      source: {
        kind: "arrangement_audio_clip",
        trackName: "Samples",
        clipName: "Kick",
        startBeat: 0,
      },
    },
    {},
  );
  const mixerBefore = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "set_track_mixer_parameter",
      trackName: "Bass",
      parameter: "volume",
      value: 0.8,
    },
    {},
  );
  mixerValue = 0.75;
  const mixerAfter = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "set_track_mixer_parameter",
      trackName: "Bass",
      parameter: "volume",
      value: 0.8,
    },
    {},
  );

  assert.notEqual(targetSampleAfter, sampleBefore);
  assert.notEqual(sampleAfter, sampleBefore);
  assert.notEqual(sampleAfter, targetSampleAfter);
  assert.notEqual(mixerAfter, mixerBefore);
});

test("Session slot and audio Warp snapshots bind occupied clips and writable properties", async () => {
  const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
    handle: { id: 701n },
    clip: null,
  });
  const midi = midiTrack(11n, []);
  Object.defineProperty(midi, "clipSlots", {
    configurable: true,
    value: [slot],
  });
  const midiContext = liveContext(midi);
  const empty = await captureLiveActionPreflightSnapshot(
    midiContext,
    {
      type: "create_session_midi_clip",
      trackName: "Bass",
      slotIndex: 0,
      durationBeats: 4,
      notes: [],
    },
    {},
  );
  Reflect.set(slot, "clip", midiClip(702n));
  const occupied = await captureLiveActionPreflightSnapshot(
    midiContext,
    {
      type: "create_session_midi_clip",
      trackName: "Bass",
      slotIndex: 0,
      durationBeats: 4,
      notes: [],
    },
    {},
  );

  const audioClip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: 801n },
    name: "Vocal",
    startTime: 0,
    duration: 4,
    startMarker: 0,
    endMarker: 4,
    looping: false,
    loopStart: 0,
    loopEnd: 4,
    color: 0,
    muted: false,
    filePath: "/private/audio/vocal.wav",
    warping: true,
    warpMode: 4,
    warpMarkers: [],
  });
  const audioTrack = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: 80n },
    name: "Audio",
    devices: [],
    clipSlots: [],
    arrangementClips: [audioClip],
  });
  const audioContext = {
    application: {
      song: {
        handle: { id: 1n },
        tracks: [audioTrack],
        scenes: [],
      },
    },
  } as never;
  const warpBefore = await captureLiveActionPreflightSnapshot(
    audioContext,
    {
      type: "set_audio_clip_warp",
      trackName: "Audio",
      clipName: "Vocal",
      startBeat: 0,
      warpMode: "complex_pro",
    },
    {},
  );
  audioClip.warping = false;
  const warpAfter = await captureLiveActionPreflightSnapshot(
    audioContext,
    {
      type: "set_audio_clip_warp",
      trackName: "Audio",
      clipName: "Vocal",
      startBeat: 0,
      warpMode: "complex_pro",
    },
    {},
  );

  assert.notEqual(occupied, empty);
  assert.notEqual(warpAfter, warpBefore);
});

test("Scene, Cue Point, and Take Lane snapshots bind exact host identities", async () => {
  const scene = sdkObject<Scene<"1.0.0">>(Scene.prototype, {
    handle: { id: 901n },
    name: "Verse",
    tempo: 0,
    signatureNumerator: 4,
    signatureDenominator: 4,
  });
  const cue = sdkObject<CuePoint<"1.0.0">>(CuePoint.prototype, {
    handle: { id: 902n },
    name: "Drop",
    time: 16,
  });
  const lane = sdkObject<TakeLane<"1.0.0">>(TakeLane.prototype, {
    handle: { id: 903n },
    name: "Take 1",
    clips: [],
  });
  const track = midiTrack(11n, []);
  Object.defineProperty(track, "takeLanes", {
    configurable: true,
    value: [lane],
  });
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tempo: 120,
        tracks: [track],
        scenes: [scene],
        cuePoints: [cue],
      },
    },
  } as never;

  const sceneBefore = await captureLiveActionPreflightSnapshot(
    context,
    { type: "rename_scene", sceneIndex: 0, sceneName: "Verse", newName: "Drop" },
    {},
  );
  scene.handle.id = 904n;
  const sceneAfter = await captureLiveActionPreflightSnapshot(
    context,
    { type: "rename_scene", sceneIndex: 0, sceneName: "Verse", newName: "Drop" },
    {},
  );
  const cueBefore = await captureLiveActionPreflightSnapshot(
    context,
    { type: "rename_cue_point", timeBeat: 16, cueName: "Drop", newName: "Drop 1" },
    {},
  );
  cue.handle.id = 905n;
  const cueAfter = await captureLiveActionPreflightSnapshot(
    context,
    { type: "rename_cue_point", timeBeat: 16, cueName: "Drop", newName: "Drop 1" },
    {},
  );
  const laneBefore = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "rename_take_lane",
      trackName: "Bass",
      laneIndex: 0,
      laneName: "Take 1",
      newName: "Main",
    },
    {},
  );
  lane.handle.id = 906n;
  const laneAfter = await captureLiveActionPreflightSnapshot(
    context,
    {
      type: "rename_take_lane",
      trackName: "Bass",
      laneIndex: 0,
      laneName: "Take 1",
      newName: "Main",
    },
    {},
  );

  assert.notEqual(sceneAfter, sceneBefore);
  assert.notEqual(cueAfter, cueBefore);
  assert.notEqual(laneAfter, laneBefore);
});

test("whole-Scene snapshots detect content and identity drift across the target row", async (t) => {
  const changes: [string, (fixture: ReturnType<typeof sceneFixture>) => void][] = [
    ["MIDI Clip replacement", ({ slots }) => {
      Reflect.set(slots[0]!, "clip", midiClip(202n));
    }],
    ["MIDI note edits", ({ midi }) => {
      midi.notes = [{ pitch: 60, startTime: 0, duration: 1, velocity: 90 }];
    }],
    ["Audio Clip source edits", ({ audio }) => {
      Reflect.set(audio, "filePath", "/private/audio/replacement.wav");
    }],
    ["Audio Clip Warp edits", ({ audio }) => {
      Reflect.set(audio, "warpMarkers", [{ sampleTime: 1, beatTime: 2 }]);
    }],
    ["occupied slot cleared", ({ slots }) => { Reflect.set(slots[1]!, "clip", null); }],
    ["empty slot filled", ({ slots }) => { Reflect.set(slots[2]!, "clip", midiClip(203n)); }],
    ["slot identity changed", ({ slots }) => { slots[0]!.handle.id = 204n; }],
    ["track identity changed", ({ tracks }) => { tracks[0]!.handle.id = 14n; }],
    ["track removed", ({ tracks }) => { tracks.pop(); }],
  ];
  for (const type of ["delete_scene", "duplicate_scene"] as const) {
    for (const [label, change] of changes) {
      await t.test(`${type}: ${label}`, async () => {
        const fixture = sceneFixture();
        const action = { type, sceneIndex: 1, sceneName: "Verse" };
        const before = await captureLiveActionPreflightSnapshot(fixture.context, action, {});
        change(fixture);
        const after = await captureLiveActionPreflightSnapshot(fixture.context, action, {});
        assert.notEqual(after, before);
      });
    }
  }
});

test("Scene snapshots ignore Clip changes outside the action's affected contents", async () => {
  for (const type of ["delete_scene", "duplicate_scene", "rename_scene"] as const) {
    const fixture = sceneFixture();
    const action = { type, sceneIndex: 1, sceneName: "Verse", newName: "Drop" };
    const before = await captureLiveActionPreflightSnapshot(fixture.context, action, {});
    fixture.otherRowClip.notes = [{ pitch: 72, startTime: 0, duration: 1, velocity: 90 }];
    if (type === "rename_scene") Reflect.set(fixture.slots[0]!, "clip", midiClip(202n));
    const after = await captureLiveActionPreflightSnapshot(fixture.context, action, {});
    assert.equal(after, before);
  }
});

test("whole-Scene snapshots fail closed when a target row slot cannot be verified", async () => {
  for (const type of ["delete_scene", "duplicate_scene"] as const) {
    const fixture = sceneFixture();
    fixture.tracks[2]!.clipSlots.pop();
    await assert.rejects(
      captureLiveActionPreflightSnapshot(fixture.context, { type, sceneIndex: 1 }, {}),
      /Could not find Session slot 1/,
    );
  }
});

test("rename_scene snapshots deterministically encode bigint values returned by the host", async () => {
  const scene = sdkObject<Scene<"1.0.0">>(Scene.prototype, {
    handle: { id: 910n },
    name: "Intro",
    tempo: 120n,
    signatureNumerator: 4n,
    signatureDenominator: 4n,
  });
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tracks: [],
        scenes: [scene],
        cuePoints: [],
      },
    },
  } as never;
  const action = {
    type: "rename_scene" as const,
    sceneIndex: 0,
    newName: "Verse",
  };

  const before = await captureLiveActionPreflightSnapshot(context, action, {});
  Reflect.set(scene, "signatureNumerator", 3n);
  const after = await captureLiveActionPreflightSnapshot(context, action, {});

  assert.notEqual(after, before);
});

test("preflight snapshots fail closed when a target handle identity is unavailable", async () => {
  const track = midiTrack(11n, []);
  Reflect.deleteProperty(track, "handle");

  await assert.rejects(
    captureLiveActionPreflightSnapshot(
      liveContext(track),
      { type: "delete_track", trackName: "Bass" },
      {},
    ),
    /handle identity/i,
  );
});

test("a creator ref remains literal when same-name tracks already exist", async () => {
  const first = midiTrack(11n, []);
  const second = midiTrack(12n, []);
  const context = {
    application: {
      song: {
        handle: { id: 1n },
        tracks: [first, second],
        scenes: [],
      },
    },
  } as never;

  const snapshot = await captureLiveActionPreflightSnapshot(
    context,
    { type: "create_midi_track", ref: "bass", name: "Bass" },
    {},
  );
  assert.match(snapshot, /create_midi_track/);
});

function liveContext(track: MidiTrack<"1.0.0">) {
  return {
    application: {
      song: {
        handle: { id: 1n },
        tempo: 120,
        tracks: [track],
        scenes: [],
      },
    },
  } as never;
}

function sceneFixture() {
  const midi = midiClip(101n);
  const otherRowClip = midiClip(102n);
  const audio = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: 103n },
    name: "Vocal",
    startTime: 0,
    duration: 4,
    startMarker: 0,
    endMarker: 4,
    looping: false,
    loopStart: 0,
    loopEnd: 4,
    color: 0,
    muted: false,
    filePath: "/private/audio/vocal.wav",
    warping: true,
    warpMode: 4,
    warpMarkers: [],
  });
  const slots = [midi, audio, null].map((clip, index) =>
    sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
      handle: { id: BigInt(201 + index) }, clip,
    }),
  );
  const tracks = [
    midiTrack(11n, []),
    sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, { handle: { id: 12n }, name: "Audio" }),
    midiTrack(13n, []),
  ];
  tracks.forEach((track, index) => {
    Object.defineProperty(track, "clipSlots", {
      configurable: true,
      value: [sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
        handle: { id: BigInt(301 + index) }, clip: index === 0 ? otherRowClip : null,
      }), slots[index]],
    });
  });
  const scenes = ["Intro", "Verse"].map((name, index) =>
    sdkObject<Scene<"1.0.0">>(Scene.prototype, {
      handle: { id: BigInt(401 + index) }, name, tempo: 120,
      signatureNumerator: 4, signatureDenominator: 4,
    }),
  );
  const context = {
    application: { song: { handle: { id: 1n }, tracks, scenes } },
  } as never;
  return { context, tracks, slots, midi, audio, otherRowClip };
}

function midiTrack(
  id: bigint,
  arrangementClips: MidiClip<"1.0.0">[],
  devices: object[] = [],
): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { configurable: true, enumerable: true, value: { id } },
    name: { configurable: true, enumerable: true, value: "Bass" },
    arrangementClips: { configurable: true, enumerable: true, value: arrangementClips },
    clipSlots: { configurable: true, enumerable: true, value: [] },
    devices: { configurable: true, enumerable: true, value: devices },
    mute: { configurable: true, enumerable: true, value: false, writable: true },
    solo: { configurable: true, enumerable: true, value: false, writable: true },
    arm: { configurable: true, enumerable: true, value: false },
  }) as MidiTrack<"1.0.0">;
}

function midiClip(id: bigint): MidiClip<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiClip.prototype), {
    handle: { configurable: true, enumerable: true, value: { id } },
    name: { configurable: true, enumerable: true, value: "Phrase" },
    startTime: { configurable: true, enumerable: true, value: 0 },
    duration: { configurable: true, enumerable: true, value: 4 },
    startMarker: { configurable: true, enumerable: true, value: 0 },
    endMarker: { configurable: true, enumerable: true, value: 4 },
    looping: { configurable: true, enumerable: true, value: false, writable: true },
    loopStart: { configurable: true, enumerable: true, value: 0 },
    loopEnd: { configurable: true, enumerable: true, value: 4 },
    color: { configurable: true, enumerable: true, value: 0, writable: true },
    muted: { configurable: true, enumerable: true, value: false, writable: true },
    notes: { configurable: true, enumerable: true, value: [], writable: true },
  }) as MidiClip<"1.0.0">;
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
