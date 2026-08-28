import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioClip,
  AudioTrack,
  Chain,
  ClipSlot,
  CuePoint,
  Device,
  DeviceParameter,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  RackDevice,
  Sample,
  Simpler,
  TakeLane,
  Track,
} from "@ableton-extensions/sdk";

import { validateAgentPlan } from "../agent/actions.js";
import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
  liveActionIdentityKeys,
} from "./action-bindings.js";
import { requiredEditScopesForPlan } from "./action-permissions.js";
import { AgentPlanExecutionError, executeAgentPlanWithProgress } from "./executor.js";

test("parsed Clip edits bind the selected track when optional target fields are omitted", async () => {
  for (const [clipPrototype, trackPrototype, scope] of [
    [MidiClip.prototype, MidiTrack.prototype, "midi"],
    [AudioClip.prototype, AudioTrack.prototype, "audio"],
  ] as const) {
    const clip = sdkObject(clipPrototype, {
      handle: { id: "selected-clip" }, name: "Phrase", startTime: 0, duration: 4,
    });
    const track = sdkObject(trackPrototype, {
      handle: { id: "selected-track" }, name: "Lead", arrangementClips: [clip],
    });
    const context = { application: { song: { tracks: [track] } } } as never;
    const plan = validateAgentPlan({
      message: "Rename the selected track's Clip",
      actions: [{ type: "set_clip_properties", startBeat: 0, newName: "Updated Phrase" }],
    });
    const bindings = bindAgentPlanTargets(context, plan, { track });

    assert.equal(bindings.actionTracks.get(0), track);
    assert.equal(bindings.actionObjects.get(0)?.clip, clip);
    assert.deepEqual(requiredEditScopesForPlan(context, plan, bindings), [scope]);
    const outcome = await executeAgentPlanWithProgress(context, plan, { track }, undefined, bindings);
    assert.equal(outcome.mutationCount, 1);
    assert.equal(clip.name, "Updated Phrase");
  }
});

test("an implicit track target must fail binding when no track is selected", () => {
  const plan = validateAgentPlan({
    message: "Edit the current Clip",
    actions: [{ type: "set_clip_properties", startBeat: 0, muted: true }],
  });
  assert.throws(() => bindAgentPlanTargets(
    { application: { song: { tracks: [] } } } as never, plan,
  ), /No target track is available/);
});

test("Session slot replacement invalidates later pre-bound sample sources", () => {
  const oldClip = sdkObject(AudioClip.prototype, {
    handle: { id: "old-clip" },
    name: "Old",
    filePath: "/project/old.wav",
  });
  const slot = sdkObject(ClipSlot.prototype, {
    handle: { id: "slot-1" },
    clip: oldClip,
  });
  const track = sdkObject(AudioTrack.prototype, {
    handle: { id: "track-1" },
    name: "Audio",
    devices: [],
    clipSlots: [slot],
  });
  const selected = sdkObject(Sample.prototype, {
    handle: { id: "selected-sample" },
    filePath: "/project/new.wav",
  });
  const plan = validateAgentPlan({
    message: "Replace then reuse old content",
    actions: [
      {
        type: "create_session_audio_clip",
        trackName: "Audio",
        slotIndex: 0,
        source: { kind: "selected" },
      },
      {
        type: "create_arrangement_audio_clip",
        trackName: "Audio",
        startBeat: 0,
        source: {
          kind: "session_audio_clip",
          trackName: "Audio",
          slotIndex: 0,
          clipName: "Old",
        },
      },
    ],
  });

  assert.throws(
    () => bindAgentPlanTargets(
      { application: { song: { tracks: [track] } } } as never,
      plan,
      { object: selected },
    ),
    /action 2 depends on Live sample source.*invalidated by action 1/i,
  );
});

test("Session slot guards allow later consumers when creation reuses the same Clip", () => {
  const midiClip = sdkObject(MidiClip.prototype, {
    handle: { id: "midi-clip" },
    name: "Loop",
    duration: 4,
    notes: [],
  });
  const midiSlot = sdkObject(ClipSlot.prototype, {
    handle: { id: "midi-slot" },
    clip: midiClip,
  });
  const midiTrack = sdkObject(MidiTrack.prototype, {
    handle: { id: "midi-track" },
    name: "Lead",
    devices: [],
    clipSlots: [midiSlot],
  });
  const midiPlan = validateAgentPlan({
    message: "Update and color the reusable MIDI Clip",
    actions: [
      {
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 4,
        notes: [],
      },
      {
        type: "set_clip_properties",
        trackName: "Lead",
        slotIndex: 0,
        clipName: "Loop",
        color: 1,
      },
    ],
  });
  const midiBindings = bindAgentPlanTargets(
    { application: { song: { tracks: [midiTrack] } } } as never,
    midiPlan,
    { track: midiTrack },
  );
  assert.equal(midiBindings.actionObjects.get(1)?.clip, midiClip);

  const audioClip = sdkObject(AudioClip.prototype, {
    handle: { id: "audio-clip" },
    name: "Audio Loop",
    filePath: "/project/source.wav",
    warping: false,
  });
  const audioSlot = sdkObject(ClipSlot.prototype, {
    handle: { id: "audio-slot" },
    clip: audioClip,
  });
  const audioTrack = sdkObject(AudioTrack.prototype, {
    handle: { id: "audio-track" },
    name: "Audio",
    devices: [],
    clipSlots: [audioSlot],
  });
  const source = sdkObject(Sample.prototype, {
    handle: { id: "audio-source" },
    filePath: "/project/source.wav",
  });
  const audioPlan = validateAgentPlan({
    message: "Reuse and color the same Audio Clip",
    actions: [
      {
        type: "create_session_audio_clip",
        trackName: "Audio",
        slotIndex: 0,
        source: { kind: "selected" },
        isWarped: false,
      },
      {
        type: "set_clip_properties",
        trackName: "Audio",
        slotIndex: 0,
        clipName: "Audio Loop",
        color: 2,
      },
    ],
  });
  const audioBindings = bindAgentPlanTargets(
    { application: { song: { tracks: [audioTrack] } } } as never,
    audioPlan,
    { object: source },
  );
  assert.equal(audioBindings.actionObjects.get(1)?.clip, audioClip);
});

test("destructive actions reject later consumers of the same bound host object", () => {
  const parameter = sdkObject(DeviceParameter.prototype, {
    handle: { id: "parameter-1" },
    name: "Gain",
    min: 0,
    max: 1,
  });
  const devices: Device<"1.0.0">[] = [];
  const track = sdkObject(Track.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices,
  });
  const device = sdkObject(Device.prototype, {
    handle: { id: "device-1" },
    name: "Utility",
    parameters: [parameter],
    parent: track,
  });
  devices.push(device);
  const cue = sdkObject(CuePoint.prototype, {
    handle: { id: "cue-1" },
    name: "Drop",
    time: 32,
  });
  const context = {
    application: { song: { tracks: [track], cuePoints: [cue] } },
  } as never;

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Delete then edit one Device",
      actions: [
        {
          type: "delete_device",
          trackName: "Lead",
          deviceName: "Utility",
          deviceIndex: 0,
        },
        {
          type: "set_device_parameter",
          trackName: "Lead",
          deviceName: "Utility",
          deviceIndex: 0,
          parameterName: "Gain",
          value: 0.5,
        },
      ],
    })),
    /action 2 depends on.*Device.*invalidated by action 1/i,
  );

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Delete then rename one Cue Point",
      actions: [
        { type: "delete_cue_point", timeBeat: 32, cueName: "Drop" },
        {
          type: "rename_cue_point",
          timeBeat: 32,
          cueName: "Drop",
          newName: "Late Drop",
        },
      ],
    })),
    /action 2 depends on.*Cue Point.*invalidated by action 1/i,
  );

  const rackSample = sdkObject(Sample.prototype, {
    handle: { id: "rack-sample" },
    filePath: "/project/rack.wav",
  });
  const simpler = sdkObject(Simpler.prototype, {
    handle: { id: "simpler-1" },
    name: "Simpler",
    parameters: [],
    sample: rackSample,
  });
  const chain = sdkObject(Chain.prototype, {
    handle: { id: "chain-1" },
    devices: [simpler],
  });
  const rack = sdkObject(RackDevice.prototype, {
    handle: { id: "rack-1" },
    name: "Rack",
    parameters: [],
    chains: [chain],
  });
  const sourceTrack = sdkObject(MidiTrack.prototype, {
    handle: { id: "source-track" },
    name: "Source",
    devices: [rack],
  });
  const destinationTrack = sdkObject(AudioTrack.prototype, {
    handle: { id: "destination-track" },
    name: "Destination",
    devices: [],
  });
  assert.throws(
    () => bindAgentPlanTargets(
      {
        application: {
          song: { tracks: [sourceTrack, destinationTrack], cuePoints: [] },
        },
      } as never,
      validateAgentPlan({
        message: "Delete a Rack then reuse its nested sample",
        actions: [
          {
            type: "delete_device",
            trackName: "Source",
            deviceName: "Rack",
            devicePath: { deviceIndex: 0 },
          },
          {
            type: "create_arrangement_audio_clip",
            trackName: "Destination",
            startBeat: 0,
            source: {
              kind: "simpler",
              trackName: "Source",
              deviceName: "Simpler",
              devicePath: {
                deviceIndex: 0,
                nested: [{ chainIndex: 0, deviceIndex: 0 }],
              },
            },
          },
        ],
      }),
    ),
    /action 2 depends on Live sample source.*invalidated by action 1/i,
  );
});

test("Simpler sample replacement invalidates only consumers of the replaced Sample", () => {
  const oldSample = sdkObject(Sample.prototype, {
    handle: { id: "old-sample" },
    filePath: "/project/old.wav",
  });
  const replacement = sdkObject(Sample.prototype, {
    handle: { id: "replacement-sample" },
    filePath: "/project/new.wav",
  });
  const simpler = sdkObject(Simpler.prototype, {
    handle: { id: "simpler-1" },
    name: "Simpler",
    parameters: [],
    sample: oldSample,
  });
  const sourceTrack = sdkObject(MidiTrack.prototype, {
    handle: { id: "source-track" },
    name: "Source",
    devices: [simpler],
  });
  const destination = sdkObject(AudioTrack.prototype, {
    handle: { id: "destination-track" },
    name: "Destination",
    devices: [],
  });
  const context = {
    application: { song: { tracks: [sourceTrack, destination] } },
  } as never;
  const replaceAction = {
    type: "replace_simpler_sample" as const,
    trackName: "Source",
    simplerName: "Simpler",
    simplerPath: { deviceIndex: 0 },
    source: { kind: "selected" as const },
  };
  const consumeAction = {
    type: "create_arrangement_audio_clip" as const,
    trackName: "Destination",
    startBeat: 0,
    source: {
      kind: "simpler" as const,
      trackName: "Source",
      deviceName: "Simpler",
      devicePath: { deviceIndex: 0 },
    },
  };

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Replace then consume the old sample",
      actions: [replaceAction, consumeAction],
    }), { object: replacement }),
    /action 2 depends on Live sample source.*invalidated by action 1/i,
  );
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Keep then consume the same sample",
    actions: [replaceAction, consumeAction],
  }), { object: oldSample }));
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Replace the sample then edit the same device",
    actions: [replaceAction, {
      type: "set_device_parameter",
      trackName: "Source",
      deviceName: "Simpler",
      devicePath: { deviceIndex: 0 },
      parameterName: "Gain",
      value: 0.5,
    }],
  }), { object: replacement }));
});

test("Drum Pad sample replacement invalidates only consumers of the replaced Sample", () => {
  const oldSample = sdkObject(Sample.prototype, {
    handle: { id: "pad-old-sample" },
    filePath: "/project/old-pad.wav",
  });
  const replacement = sdkObject(Sample.prototype, {
    handle: { id: "pad-replacement-sample" },
    filePath: "/project/new-pad.wav",
  });
  const simpler = sdkObject(Simpler.prototype, {
    handle: { id: "pad-simpler" },
    name: "Simpler",
    parameters: [],
    sample: oldSample,
  });
  const chain = sdkObject(DrumChain.prototype, {
    handle: { id: "pad-chain" },
    receivingNote: 36,
    devices: [simpler],
  });
  const rack = sdkObject(DrumRack.prototype, {
    handle: { id: "drum-rack" },
    name: "Drum Rack",
    parameters: [],
    chains: [chain],
  });
  const drums = sdkObject(MidiTrack.prototype, {
    handle: { id: "drums-track" },
    name: "Drums",
    devices: [rack],
  });
  const destination = sdkObject(AudioTrack.prototype, {
    handle: { id: "pad-destination" },
    name: "Destination",
    devices: [],
  });
  const context = {
    application: { song: { tracks: [drums, destination] } },
  } as never;
  const simplerPath = {
    deviceIndex: 0,
    nested: [{ chainIndex: 0, deviceIndex: 0 }],
  };
  const replaceAction = {
    type: "configure_drum_pad" as const,
    trackName: "Drums",
    rackName: "Drum Rack",
    rackPath: { deviceIndex: 0 },
    receivingNote: 36,
    mode: "replace_existing_simpler" as const,
    simplerPath,
    source: { kind: "selected" as const },
  };

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Replace then consume the old pad sample",
      actions: [replaceAction, {
        type: "create_arrangement_audio_clip",
        trackName: "Destination",
        startBeat: 0,
        source: {
          kind: "simpler",
          trackName: "Drums",
          deviceName: "Simpler",
          devicePath: simplerPath,
        },
      }],
    }), { object: replacement }),
    /action 2 depends on Live sample source.*invalidated by action 1/i,
  );
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Replace the pad sample then edit the same Simpler",
    actions: [replaceAction, {
      type: "set_device_parameter",
      trackName: "Drums",
      deviceName: "Simpler",
      devicePath: simplerPath,
      parameterName: "Gain",
      value: 0.5,
    }],
  }), { object: replacement }));
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Replace one pad sample twice in a deterministic sequence",
    actions: [replaceAction, replaceAction],
  }), { object: replacement }));

  const emptyRack = sdkObject(DrumRack.prototype, {
    handle: { id: "empty-drum-rack" },
    name: "Empty Drum Rack",
    parameters: [],
    chains: [],
  });
  const emptyDrums = sdkObject(MidiTrack.prototype, {
    handle: { id: "empty-drums-track" },
    name: "Empty Drums",
    devices: [emptyRack],
  });
  assert.throws(
    () => bindAgentPlanTargets(
      { application: { song: { tracks: [emptyDrums] } } } as never,
      validateAgentPlan({
        message: "Fill one pad twice",
        actions: [0, 1].map(() => ({
          type: "configure_drum_pad" as const,
          trackName: "Empty Drums",
          rackName: "Empty Drum Rack",
          rackPath: { deviceIndex: 0 },
          receivingNote: 36,
          mode: "fill_empty_pad" as const,
          source: { kind: "selected" as const },
        })),
      }),
      { object: replacement },
    ),
    /actions 1 and 2.*fill MIDI note 36.*same Drum Rack.*inspect/i,
  );
});

test("Arrangement range invalidation rejects only later consumers of affected Clips", () => {
  const affected = sdkObject(MidiClip.prototype, {
    handle: { id: "affected-clip" },
    name: "Affected",
    startTime: 0,
    duration: 4,
    notes: [],
  });
  const unaffected = sdkObject(MidiClip.prototype, {
    handle: { id: "unaffected-clip" },
    name: "Unaffected",
    startTime: 8,
    duration: 4,
    notes: [],
  });
  const track = sdkObject(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [],
    arrangementClips: [affected, unaffected],
  });
  const context = { application: { song: { tracks: [track] } } } as never;

  for (const firstAction of [
    {
      type: "delete_clip" as const,
      trackName: "Lead",
      startBeat: 0,
      clipName: "Affected",
    },
    {
      type: "clear_arrangement_range" as const,
      trackName: "Lead",
      startBeat: 0,
      endBeat: 4,
    },
  ]) {
    assert.throws(
      () => bindAgentPlanTargets(context, validateAgentPlan({
        message: "Destroy then edit the affected Clip",
        actions: [
          firstAction,
          {
            type: "set_clip_properties",
            trackName: "Lead",
            startBeat: 0,
            clipName: "Affected",
            muted: true,
          },
        ],
      })),
      /action 2 depends on.*Clip.*invalidated by action 1/i,
    );
  }

  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Clear one range then edit an unaffected Clip",
    actions: [
      {
        type: "clear_arrangement_range",
        trackName: "Lead",
        startBeat: 0,
        endBeat: 4,
      },
      {
        type: "set_clip_properties",
        trackName: "Lead",
        startBeat: 8,
        clipName: "Unaffected",
        muted: true,
      },
    ],
  })));
});

test("main Arrangement creation invalidates only Clips its create range can replace", () => {
  const midiAffected = sdkObject(MidiClip.prototype, {
    handle: { id: "midi-affected" },
    name: "Affected",
    startTime: 0,
    duration: 8,
    notes: [],
  });
  const midiUnaffected = sdkObject(MidiClip.prototype, {
    handle: { id: "midi-unaffected" },
    name: "Unaffected",
    startTime: 16,
    duration: 4,
    notes: [],
  });
  const midiTrack = sdkObject(MidiTrack.prototype, {
    handle: { id: "midi-track" },
    name: "Lead",
    devices: [],
    arrangementClips: [midiAffected, midiUnaffected],
    takeLanes: [],
  });
  const midiContext = {
    application: { song: { tracks: [midiTrack] } },
  } as never;

  assert.throws(
    () => bindAgentPlanTargets(midiContext, validateAgentPlan({
      message: "Replace one range then edit the removed Clip",
      actions: [
        {
          type: "create_midi_clip",
          trackName: "Lead",
          startBeat: 0,
          durationBeats: 4,
          notes: [],
        },
        {
          type: "set_clip_properties",
          trackName: "Lead",
          startBeat: 0,
          clipName: "Affected",
          muted: true,
        },
      ],
    })),
    /action 2 depends on Arrangement Clip.*invalidated by action 1/i,
  );
  assert.doesNotThrow(() => bindAgentPlanTargets(midiContext, validateAgentPlan({
    message: "Create one range then edit an unrelated Clip",
    actions: [
      {
        type: "create_midi_clip",
        trackName: "Lead",
        startBeat: 0,
        durationBeats: 4,
        notes: [],
      },
      {
        type: "set_clip_properties",
        trackName: "Lead",
        startBeat: 16,
        clipName: "Unaffected",
        muted: true,
      },
    ],
  })));
  assert.doesNotThrow(() => bindAgentPlanTargets(midiContext, validateAgentPlan({
    message: "Reuse and then edit the exact existing MIDI Clip",
    actions: [
      {
        type: "create_midi_clip",
        trackName: "Lead",
        startBeat: 0,
        durationBeats: 8,
        name: "Affected",
        notes: [],
      },
      {
        type: "set_clip_properties",
        trackName: "Lead",
        startBeat: 0,
        clipName: "Affected",
        muted: true,
      },
    ],
  })));

  const before = sdkObject(AudioClip.prototype, {
    handle: { id: "audio-before" },
    name: "Before",
    startTime: 0,
    duration: 4,
    filePath: "/project/before.wav",
  });
  const after = sdkObject(AudioClip.prototype, {
    handle: { id: "audio-after" },
    name: "After",
    startTime: 12,
    duration: 4,
    filePath: "/project/after.wav",
  });
  const audioTrack = sdkObject(AudioTrack.prototype, {
    handle: { id: "audio-track" },
    name: "Audio",
    devices: [],
    arrangementClips: [before, after],
    takeLanes: [],
  });
  const source = sdkObject(Sample.prototype, {
    handle: { id: "audio-source" },
    filePath: "/project/source.wav",
  });
  const audioContext = {
    application: { song: { tracks: [audioTrack] } },
  } as never;
  assert.throws(
    () => bindAgentPlanTargets(audioContext, validateAgentPlan({
      message: "Create natural-length audio then edit a potentially replaced Clip",
      actions: [
        {
          type: "create_arrangement_audio_clip",
          trackName: "Audio",
          source: { kind: "selected" },
          startBeat: 8,
        },
        {
          type: "set_clip_properties",
          trackName: "Audio",
          startBeat: 12,
          clipName: "After",
          muted: true,
        },
      ],
    }), { object: source }),
    /action 2 depends on Arrangement Clip.*invalidated by action 1/i,
  );
  assert.doesNotThrow(() => bindAgentPlanTargets(audioContext, validateAgentPlan({
    message: "Create natural-length audio after an unrelated earlier Clip",
    actions: [
      {
        type: "create_arrangement_audio_clip",
        trackName: "Audio",
        source: { kind: "selected" },
        startBeat: 8,
      },
      {
        type: "set_clip_properties",
        trackName: "Audio",
        startBeat: 0,
        clipName: "Before",
        muted: true,
      },
    ],
  }), { object: source }));
});

test("main Arrangement SDK creation ranges do not overlap within one plan", () => {
  const track = sdkObject(MidiTrack.prototype, {
    handle: { id: "main-midi-track" },
    name: "Lead",
    devices: [],
    arrangementClips: [],
    takeLanes: [],
  });
  const context = { application: { song: { tracks: [track] } } } as never;
  const create = (startBeat: number, durationBeats: number) => ({
    type: "create_midi_clip" as const,
    trackName: "Lead",
    startBeat,
    durationBeats,
    notes: [],
  });
  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Create overlapping main-lane Clips",
      actions: [create(0, 8), create(4, 8)],
    })),
    /actions 1 and 2.*overlapping Clips.*main Arrangement lane/i,
  );
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Create adjacent main-lane Clips",
    actions: [create(0, 8), create(8, 8)],
  })));

  const reusable = sdkObject(MidiClip.prototype, {
    handle: { id: "reusable-main-clip" },
    name: "Reusable",
    startTime: 0,
    duration: 8,
    notes: [],
  });
  track.arrangementClips.push(reusable);
  const reuse = {
    ...create(0, 8),
    name: "Reusable",
  };
  assert.doesNotThrow(() => bindAgentPlanTargets(context, validateAgentPlan({
    message: "Update the same reusable Clip twice without SDK creation",
    actions: [reuse, reuse],
  })));

  assert.throws(
    () => bindAgentPlanTargets(
      { application: { song: { tracks: [] } } } as never,
      validateAgentPlan({
        message: "Create a track then write overlapping ranges",
        actions: [
          { type: "create_midi_track", ref: "lead" },
          { ...create(0, 8), trackName: undefined, trackRef: "lead" },
          { ...create(4, 8), trackName: undefined, trackRef: "lead" },
        ],
      }),
    ),
    /actions 2 and 3.*overlapping Clips.*main Arrangement lane/i,
  );
});

test("whole-track deletion rejects only later dependencies inside its affected tree", () => {
  const group = sdkObject(MidiTrack.prototype, {
    handle: { id: "group-track" },
    name: "Group",
    groupTrack: null,
    devices: [],
    clipSlots: [],
    arrangementClips: [],
    takeLanes: [],
  });
  const sourceClip = sdkObject(AudioClip.prototype, {
    handle: { id: "child-source" },
    name: "Source",
    startTime: 0,
    duration: 4,
    filePath: "/project/source.wav",
  });
  const child = sdkObject(AudioTrack.prototype, {
    handle: { id: "child-track" },
    name: "Child",
    groupTrack: group,
    devices: [],
    clipSlots: [],
    arrangementClips: [sourceClip],
    takeLanes: [],
  });
  const destination = sdkObject(AudioTrack.prototype, {
    handle: { id: "destination-track" },
    name: "Destination",
    groupTrack: null,
    devices: [],
    clipSlots: [],
    arrangementClips: [],
    takeLanes: [],
  });
  const context = {
    application: { song: { tracks: [group, child, destination] } },
  } as never;

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Delete the group, then edit its child",
      actions: [
        { type: "delete_track", trackName: "Group" },
        { type: "set_track_mute", trackName: "Child", mute: true },
      ],
    })),
    /action 2 depends on track "Child".*action 1/i,
  );

  assert.throws(
    () => bindAgentPlanTargets(context, validateAgentPlan({
      message: "Delete the group, then reuse audio from its child",
      actions: [
        { type: "delete_track", trackName: "Group" },
        {
          type: "create_arrangement_audio_clip",
          trackName: "Destination",
          startBeat: 0,
          source: {
            kind: "arrangement_audio_clip",
            trackName: "Child",
            startBeat: 0,
            clipName: "Source",
          },
        },
      ],
    })),
    /action 2 depends on track "Child".*action 1/i,
  );

  const allowed = bindAgentPlanTargets(context, validateAgentPlan({
    message: "Delete the group, then mute an unrelated track",
    actions: [
      { type: "delete_track", trackName: "Group" },
      { type: "set_track_mute", trackName: "Destination", mute: true },
    ],
  }));
  assert.equal(allowed.actionTracks.get(1), destination);
});

test("Set-level actions do not require a selected track", () => {
  const plan = validateAgentPlan({
    message: "Change Set structure",
    actions: [{ type: "set_tempo", tempo: 128 }, { type: "create_midi_track", ref: "new" }],
  });
  const bindings = bindAgentPlanTargets({ application: { song: { tracks: [] } } } as never, plan);
  assert.equal(bindings.actionTracks.size, 0);
});

test("existing plan targets bind by handle and reject replacement after confirmation", () => {
  const original = { name: "Lead", handle: { id: "track-1" } };
  const plan = {
    message: "Rename Lead",
    targets: { lead: { trackName: "Lead" } },
    actions: [{ type: "rename_track", trackRef: "lead", newName: "Dream Lead" }],
  } as const;
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [original] } } } as never,
    plan as never,
  );
  const unchanged = bindAgentPlanTargets(
    { application: { song: { tracks: [original] } } } as never,
    plan as never,
  );
  assert.doesNotThrow(() => assertSameExistingPlanTargets(before, unchanged));

  const replacement = { name: "Lead", handle: { id: "track-2" } };
  const after = bindAgentPlanTargets(
    { application: { song: { tracks: [replacement] } } } as never,
    plan as never,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /ref "lead" changed/i,
  );
});

test("Return and Main targets bind by role and reject unsupported actions", async () => {
  const inserted: string[] = [];
  let returnVolume = 0.5;
  const volume = {
    name: "Volume",
    min: 0,
    max: 1,
    getValue: async () => returnVolume,
    setValue: async (value: number) => {
      returnVolume = value;
    },
  };
  const returnTrack = sdkObject(Track.prototype, {
    handle: { id: "return-a" },
    name: "A-Reverb",
    devices: [],
    mixer: { volume, panning: volume, sends: [] },
    insertDevice: async (name: string) => {
      inserted.push(`return:${name}`);
      return { name };
    },
  });
  const mainTrack = sdkObject(Track.prototype, {
    handle: { id: "main" },
    name: "Main",
    devices: [],
    insertDevice: async (name: string) => {
      inserted.push(`main:${name}`);
      return { name };
    },
  });
  const context = {
    application: {
      song: { tracks: [], returnTracks: [returnTrack], mainTrack },
    },
  } as never;
  const allowed = validateAgentPlan({
    message: "Add bus devices",
    targets: {
      reverb: { trackRole: "return", trackIndex: 0, trackName: "A-Reverb" },
      main: { trackRole: "main" },
    },
    actions: [
      { type: "insert_device", trackRef: "reverb", deviceName: "Utility" },
      { type: "insert_device", trackRef: "main", deviceName: "Limiter" },
      {
        type: "set_track_mixer_parameter",
        trackRef: "reverb",
        parameter: "volume",
        value: 0.7,
      },
    ],
  });

  const bindings = bindAgentPlanTargets(context, allowed);
  assert.equal(bindings.actionTracks.get(0), returnTrack);
  assert.equal(bindings.actionTracks.get(1), mainTrack);
  assert.equal(bindings.actionTracks.get(2), returnTrack);
  assert.deepEqual(requiredEditScopesForPlan(context, allowed, bindings), [
    "devices",
    "mixer",
  ]);
  const outcome = await executeAgentPlanWithProgress(
    context,
    allowed,
    {},
    undefined,
    bindings,
  );
  assert.equal(outcome.mutationCount, 3);
  assert.deepEqual(inserted, ["return:Utility", "main:Limiter"]);
  assert.equal(returnVolume, 0.7);

  const implicit = validateAgentPlan({
    message: "Insert on selected Main",
    actions: [{ type: "insert_device", deviceName: "Utility" }],
  });
  assert.throws(
    () => bindAgentPlanTargets(context, implicit, { track: mainTrack }),
    /Main track.*requires an explicit role target.*trackRef/i,
  );

  assert.throws(
    () => bindAgentPlanTargets(context, {
      message: "Arm Main",
      targets: { main: { trackRole: "main" } },
      actions: [{ type: "set_track_arm", trackRef: "main", arm: true }],
    } as never),
    /Main track.*does not support action set_track_arm/i,
  );
});

test("Return target handle changes are rejected after confirmation", () => {
  const original = { handle: { id: "return-1" }, name: "A", devices: [] };
  const replacement = { handle: { id: "return-2" }, name: "A", devices: [] };
  const mainTrack = { handle: { id: "main" }, name: "Main", devices: [] };
  const plan = validateAgentPlan({
    message: "Insert on Return A",
    targets: { bus: { trackRole: "return", trackIndex: 0 } },
    actions: [{ type: "insert_device", trackRef: "bus", deviceName: "Utility" }],
  });
  const before = bindAgentPlanTargets({
    application: { song: { tracks: [], returnTracks: [original], mainTrack } },
  } as never, plan);
  const after = bindAgentPlanTargets({
    application: { song: { tracks: [], returnTracks: [replacement], mainTrack } },
  } as never, plan);

  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /ref "bus" changed/i,
  );
});

test("a failed Return action reports its exact recovery locator", async () => {
  const returnTrack = sdkObject(Track.prototype, {
    handle: { id: "return-b" },
    name: "B-Reverb",
    devices: [],
    insertDevice: async () => {
      returnTrack.name = "Renamed Return";
      throw new Error("Host rejected device");
    },
  });
  const mainTrack = sdkObject(Track.prototype, {
    handle: { id: "main" },
    name: "Main",
    devices: [],
  });
  const context = {
    application: {
      song: { tracks: [], returnTracks: [returnTrack], mainTrack },
    },
  } as never;
  const plan = validateAgentPlan({
    message: "Insert on Return B",
    targets: {
      bus: { trackRole: "return", trackIndex: 0, trackName: "B-Reverb" },
    },
    actions: [{ type: "insert_device", trackRef: "bus", deviceName: "Utility" }],
  });
  const bindings = bindAgentPlanTargets(context, plan);

  await assert.rejects(
    executeAgentPlanWithProgress(context, plan, {}, undefined, bindings),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.deepEqual(error.failedTrackSelector, {
        trackRole: "return",
        trackIndex: 0,
        trackName: "Renamed Return",
      });
      return true;
    },
  );
});

test("a removed Return target does not fall back to a same-name regular track", async () => {
  const regular = { handle: { id: "regular" }, name: "Shared", devices: [] };
  const returnTracks: Track<"1.0.0">[] = [];
  const returnTrack = sdkObject(Track.prototype, {
    handle: { id: "return" },
    name: "Shared",
    devices: [],
    insertDevice: async () => {
      returnTracks.length = 0;
      throw new Error("Return disappeared");
    },
  });
  returnTracks.push(returnTrack);
  const mainTrack = sdkObject(Track.prototype, {
    handle: { id: "main" }, name: "Main", devices: [],
  });
  const context = {
    application: { song: { tracks: [regular], returnTracks, mainTrack } },
  } as never;
  const plan = validateAgentPlan({
    message: "Insert on Return",
    targets: { bus: { trackRole: "return", trackIndex: 0 } },
    actions: [{ type: "insert_device", trackRef: "bus", deviceName: "Utility" }],
  });
  const bindings = bindAgentPlanTargets(context, plan);

  await assert.rejects(
    executeAgentPlanWithProgress(context, plan, {}, undefined, bindings),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.failedTrackSelector, null);
      return true;
    },
  );
});

test("plain trackName actions are also rebound and compared by handle", () => {
  const original = { name: "Scratch", handle: { id: "track-1" } };
  const plan = {
    message: "Delete Scratch",
    actions: [{ type: "delete_track", trackName: "Scratch" }],
  } as const;
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [original] } } } as never,
    plan as never,
  );
  assert.equal(before.actionTracks.get(0), original);

  const replacement = { name: "Scratch", handle: { id: "track-2" } };
  const after = bindAgentPlanTargets(
    { application: { song: { tracks: [replacement] } } } as never,
    plan as never,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /action 1 changed/i,
  );
});

test("a creator action never binds an existing same-name track", () => {
  const original = Object.defineProperties(Object.create(MidiTrack.prototype), {
    name: { enumerable: true, value: "Lead" },
    handle: { enumerable: true, value: { id: "track-1" } },
  });
  const plan = {
    message: "Create another Lead",
    actions: [{ type: "create_midi_track", ref: "lead", name: "Lead" }],
  } as const;
  const bindings = bindAgentPlanTargets(
    { application: { song: { tracks: [original] } } } as never,
    plan as never,
  );

  assert.equal(bindings.actionTracks.has(0), false);
  assert.equal(bindings.tracks.has("lead"), false);
});

test("track creator identity is stable across aliases and post-create handles", () => {
  const before = liveActionIdentityKeys({
    type: "create_midi_track",
    name: "Lead",
    ref: "lead",
  });
  const created = Object.defineProperties(Object.create(MidiTrack.prototype), {
    name: { enumerable: true, value: "Lead" },
    handle: { enumerable: true, value: { id: "created-track" } },
  });
  const after = liveActionIdentityKeys({
    type: "create_midi_track",
    name: "Lead",
    ref: "replacement",
  }, created);

  assert.ok(before.some((key) => after.includes(key)));
  assert.ok(before.some((key) => key.includes("song-or-creator")));
});

test("non-regular action identity survives handle-changing Return moves", () => {
  const action = {
    type: "insert_device" as const,
    trackRef: "target",
    deviceName: "Utility",
  };
  const first = { name: "Shared", handle: { id: "return-1" } } as never;
  const second = { name: "Different", handle: { id: "return-2" } } as never;
  const duplicateName = { name: "Shared", handle: { id: "return-duplicate" } } as never;
  const movedFirst = { name: "Shared", handle: { id: "return-3" } } as never;
  const main = { name: "Shared", handle: { id: "main" } } as never;
  const keys = [
    liveActionIdentityKeys(action, first, [], { role: "return" }),
    liveActionIdentityKeys(action, second, [], { role: "return" }),
    liveActionIdentityKeys(action, main, [], { role: "main" }),
  ];

  assert.equal(keys[0]?.some((key) => keys[1]?.includes(key)), false);
  assert.equal(keys[0]?.some((key) => keys[2]?.includes(key)), false);
  assert.ok(keys.flat().every((key) => !key.includes("track-name:shared")));
  assert.ok(
    liveActionIdentityKeys(action, first, [], { role: "return" })
      .some((key) =>
        liveActionIdentityKeys(action, movedFirst, [], {
          role: "return",
        }).includes(key)
      ),
  );
  assert.ok(
    liveActionIdentityKeys(action, first, [], { role: "return" })
      .some((key) =>
        liveActionIdentityKeys(action, duplicateName, [], { role: "return" })
          .includes(key)
      ),
  );
});

test("Scene bindings reject an indexed object replacement after confirmation", () => {
  const original = { name: "Verse", handle: { id: "scene-1" } };
  const plan = {
    message: "Delete Verse",
    actions: [{ type: "delete_scene", sceneIndex: 0, sceneName: "Verse" }],
  } as const;
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [], scenes: [original] } } } as never,
    plan as never,
  );
  assert.equal(before.actionObjects.get(0)?.scene, original);

  const replacement = { name: "Verse", handle: { id: "scene-2" } };
  const after = bindAgentPlanTargets(
    { application: { song: { tracks: [], scenes: [replacement] } } } as never,
    plan as never,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /object bound to action 1 changed/i,
  );
});

test("Device bindings reject an indexed object replacement after confirmation", () => {
  const originalDevice = {
    name: "Utility",
    handle: { id: "device-1" },
  };
  const track = {
    name: "Lead",
    handle: { id: "track-1" },
    devices: [originalDevice],
  };
  const plan = {
    message: "Delete Utility",
    actions: [{
      type: "delete_device",
      trackName: "Lead",
      deviceName: "Utility",
      deviceIndex: 0,
    }],
  } as const;
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [track] } } } as never,
    plan as never,
  );
  assert.equal(before.actionObjects.get(0)?.deviceTarget?.device, originalDevice);

  const replacementDevice = {
    name: "Utility",
    handle: { id: "device-2" },
  };
  const after = bindAgentPlanTargets(
    {
      application: {
        song: { tracks: [{ ...track, devices: [replacementDevice] }] },
      },
    } as never,
    plan as never,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /object bound to action 1 changed/i,
  );
});

test("Rack Chain actions bind the exact Chain and mixer parameter handles", () => {
  const mixerParameter = sdkObject(Object.prototype, {
    handle: { id: "volume-1" },
    name: "Volume",
    min: 0,
    max: 1,
  });
  const chain = sdkObject<Chain<"1.0.0">>(Chain.prototype, {
    handle: { id: "chain-1" },
    devices: [],
    mixer: { volume: mixerParameter, panning: mixerParameter, sends: [] },
  });
  const rack = sdkObject<RackDevice<"1.0.0">>(RackDevice.prototype, {
    handle: { id: "rack-1" },
    name: "Instrument Rack",
    chains: [chain],
  });
  const track = sdkObject<Track<"1.0.0">>(Track.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    devices: [rack],
  });
  const plan = validateAgentPlan({
    message: "Edit the existing Chain",
    targets: {
      bus: { trackRole: "return", trackIndex: 0, trackName: "Lead" },
    },
    actions: [
      {
        type: "insert_chain_device",
        trackRef: "bus",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
        chainIndex: 0,
        deviceName: "Utility",
      },
      {
        type: "set_chain_mixer_parameter",
        trackRef: "bus",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
        chainIndex: 0,
        parameter: "volume",
        value: 0.5,
      },
    ],
  });
  const context = {
    application: { song: { tracks: [], returnTracks: [track] } },
  } as never;
  const before = bindAgentPlanTargets(context, plan);

  assert.equal(before.actionObjects.get(0)?.chain, chain);
  assert.equal(before.actionObjects.get(1)?.chain, chain);
  assert.equal(before.actionObjects.get(1)?.mixerParameter, mixerParameter);

  const replacement = sdkObject<Chain<"1.0.0">>(Chain.prototype, {
    handle: { id: "chain-2" },
    devices: [],
    mixer: { volume: mixerParameter, panning: mixerParameter, sends: [] },
  });
  Reflect.set(rack, "chains", [replacement]);
  const after = bindAgentPlanTargets(context, plan);
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /object bound to action 1 changed/i,
  );

  Reflect.set(rack, "chains", [chain]);
  const replacementParameter = sdkObject(Object.prototype, {
    handle: { id: "volume-2" },
    name: "Volume",
    min: 0,
    max: 1,
  });
  Reflect.set(chain, "mixer", {
    volume: replacementParameter,
    panning: mixerParameter,
    sends: [],
  });
  const parameterAfter = bindAgentPlanTargets(context, plan);
  assert.throws(
    () => assertSameExistingPlanTargets(before, parameterAfter),
    /object bound to action 2 changed/i,
  );

  const duplicateCreation = validateAgentPlan({
    message: "Do not create two indistinguishable Chains",
    actions: [
      {
        type: "create_rack_chain",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
      },
      {
        type: "create_rack_chain",
        trackName: "Lead",
        rackName: "Instrument Rack",
        rackPath: { deviceIndex: 0 },
      },
    ],
  });
  assert.throws(
    () => bindAgentPlanTargets(
      { application: { song: { tracks: [track] } } } as never,
      duplicateCreation,
      { track },
    ),
    /same Rack.*one create_rack_chain per confirmed stage/i,
  );
});

test("Take Lane Clip actions bind the lane and reject lane drift or overlapping writes", () => {
  const clip = sdkObject(MidiClip.prototype, {
    handle: { id: "clip-1" },
    name: "Alternate",
    startTime: 8,
    duration: 4,
    notes: [],
  });
  const lane = sdkObject(TakeLane.prototype, {
    handle: { id: "lane-1" },
    name: "Take 1",
    clips: [clip],
  });
  const track = sdkObject(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [],
    takeLanes: [lane],
  });
  const plan = validateAgentPlan({
    message: "Update the alternate take",
    actions: [{
      type: "create_midi_clip",
      trackName: "Lead",
      laneIndex: 0,
      laneName: "Take 1",
      startBeat: 8,
      durationBeats: 4,
      name: "Alternate",
      notes: [],
    }],
  });
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [track] } } } as never,
    plan,
  );

  assert.equal(before.actionObjects.get(0)?.takeLane, lane);
  assert.equal(before.actionObjects.get(0)?.clip, clip);
  assert.deepEqual(
    requiredEditScopesForPlan(
      { application: { song: { tracks: [track] } } } as never,
      plan,
      before,
    ),
    ["midi"],
  );

  const replacementLane = sdkObject(TakeLane.prototype, {
    handle: { id: "lane-2" },
    name: "Take 1",
    clips: [clip],
  });
  const replacementTrack = sdkObject(MidiTrack.prototype, {
    handle: { id: "track-1" },
    name: "Lead",
    arrangementClips: [],
    takeLanes: [replacementLane],
  });
  const after = bindAgentPlanTargets(
    { application: { song: { tracks: [replacementTrack] } } } as never,
    plan,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /object bound to action 1 changed/i,
  );

  const overlapping = validateAgentPlan({
    message: "Write conflicting takes",
    actions: [
      {
        type: "create_midi_clip",
        trackName: "Lead",
        laneIndex: 0,
        startBeat: 16,
        durationBeats: 4,
        notes: [],
      },
      {
        type: "create_midi_clip",
        trackName: "Lead",
        laneIndex: 0,
        startBeat: 18,
        durationBeats: 4,
        notes: [],
      },
    ],
  });
  assert.throws(
    () => bindAgentPlanTargets(
      { application: { song: { tracks: [track] } } } as never,
      overlapping,
    ),
    /Actions 1 and 2.*overlapping Clip ranges.*Take Lane/i,
  );

  const audioLane = sdkObject(TakeLane.prototype, {
    handle: { id: "audio-lane" },
    name: "Double",
    clips: [],
  });
  const audioTrack = sdkObject(AudioTrack.prototype, {
    handle: { id: "audio-track" },
    name: "Vocals",
    arrangementClips: [],
    takeLanes: [audioLane],
  });
  const sample = sdkObject(Sample.prototype, {
    handle: { id: "sample-1" },
    filePath: "/private/voice.wav",
  });
  const audioPlan = validateAgentPlan({
    message: "Write the double",
    actions: [{
      type: "create_arrangement_audio_clip",
      trackName: "Vocals",
      laneIndex: 0,
      laneName: "Double",
      source: { kind: "selected" },
      startBeat: 0,
      durationBeats: 4,
    }],
  });
  const audioBindings = bindAgentPlanTargets(
    { application: { song: { tracks: [audioTrack] } } } as never,
    audioPlan,
    { object: sample },
  );
  assert.equal(audioBindings.actionObjects.get(0)?.takeLane, audioLane);
  const boundSample = audioBindings.actionObjects.get(0)?.sampleSource;
  assert.equal(boundSample?.kind, "live");
  if (boundSample?.kind === "live") assert.equal(boundSample.object, sample);
  assert.deepEqual(
    requiredEditScopesForPlan(
      { application: { song: { tracks: [audioTrack] } } } as never,
      audioPlan,
      audioBindings,
    ),
    ["audio"],
  );
});

function sdkObject<T extends object>(prototype: T, properties: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key, { configurable: true, enumerable: true, writable: true, value },
    ]),
  ));
}
