import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAgentPlan,
  requiresExplicitConfirmation,
  summarizeActionPlan,
} from "./actions.js";

test("validateAgentPlan rejects legacy text responses", () => {
  assert.throws(
    () => validateAgentPlan('{"message":"Create a track","actions":[]}'),
    /JSON object/,
  );
});

test("validateAgentPlan rejects empty action tool calls", () => {
  assert.throws(
    () => validateAgentPlan({ message: "Nothing to do", actions: [] }),
    /at least one action/,
  );
});

test("validateAgentPlan rejects unsafe or malformed note data", () => {
  assert.throws(
    () =>
      validateAgentPlan({
          message: "Bad notes",
          actions: [
            {
              type: "create_midi_clip",
              startBeat: 0,
              durationBeats: 4,
              notes: [{ pitch: 200, startTime: 0, duration: 1 }],
            },
          ],
        }),
    /pitch/,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Velocity must be intentional",
      actions: [{
        type: "create_midi_clip",
        startBeat: 0,
        durationBeats: 4,
        notes: [{ pitch: 60, startTime: 0, duration: 1 }],
      }],
    }),
    /velocity/i,
  );
});

test("summarizeActionPlan makes a confirmation-friendly summary", () => {
  const plan = validateAgentPlan({
    message: "Open the filter and add space.",
    actions: [
      { type: "insert_device", trackName: "Lead", deviceName: "Echo", index: 0 },
      {
        type: "set_device_parameter",
        trackName: "Lead",
        deviceName: "Auto Filter",
        deviceIndex: 1,
        parameterName: "Frequency",
        value: 0.72,
      },
    ],
  });

  assert.equal(
    summarizeActionPlan(plan),
    [
      "Open the filter and add space.",
      "",
      "Actions:",
      "1. Insert Live device \"Echo\" on track \"Lead\" at index 0.",
      "2. Set \"Frequency\" on \"Auto Filter\" at deviceIndex 1 in track \"Lead\" to 0.72.",
    ].join("\n"),
  );
});

test("insert_device summary says end when no index is provided", () => {
  const summary = summarizeActionPlan(validateAgentPlan({
    message: "Add delay",
    actions: [{ type: "insert_device", trackName: "Lead", deviceName: "Delay" }],
  }));

  assert.match(summary, /at end/i);
  assert.doesNotMatch(summary, /index 0/i);
});

test("validateAgentPlan rejects malformed booleans instead of coercing them", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Mute drums",
        actions: [
          { type: "set_track_mute", trackName: "Drums", mute: "yes" },
        ],
      }),
    /boolean mute/,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Finish the repair",
      resolvesPriorFailure: "yes",
      actions: [{ type: "set_tempo", tempo: 128 }],
    }),
    /resolvesPriorFailure must be a boolean/i,
  );
  assert.equal(
    validateAgentPlan({
      message: "Finish the repair",
      resolvesPriorFailure: true,
      actions: [{ type: "set_tempo", tempo: 128 }],
    }).resolvesPriorFailure,
    true,
  );
});

test("validateAgentPlan rejects malformed optional target fields", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Delete a clip",
        actions: [
          { type: "delete_clip", trackName: 123, clipName: "Draft" },
        ],
      }),
    /trackName must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Delete a clip",
        actions: [
          { type: "delete_clip", trackName: "Lead", startBeat: "0" },
        ],
      }),
    /number startBeat/,
  );
});

test("validateAgentPlan rejects properties outside the action schema", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Create a track",
        actions: [
          { type: "create_midi_track", name: "Bass", archived: true },
        ],
      }),
    /does not support property archived/,
  );
});

test("validateAgentPlan requires integer non-negative device indexes", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Insert a device",
        actions: [
          {
            type: "insert_device",
            trackName: "Lead",
            deviceName: "Auto Filter",
            index: 0.5,
          },
        ],
      }),
    /index must be an integer from 0/,
  );
});

test("validateAgentPlan rejects out-of-range tempo instead of silently clamping", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Set tempo",
        actions: [{ type: "set_tempo", tempo: 10 }],
      }),
    /tempo must be between 20 and 999/,
  );
});

test("delete actions always require explicit confirmation", () => {
  assert.equal(
    requiresExplicitConfirmation({
      message: "Delete a track",
      actions: [{ type: "delete_track", trackName: "Scratch" }],
    }),
    true,
  );
  assert.equal(
    requiresExplicitConfirmation({
      message: "Rename a track",
      actions: [
        { type: "rename_track", trackName: "Track 1", newName: "Bass" },
      ],
    }),
    false,
  );
});

test("create_midi_clip requires explicit confirmation because it may replace notes", () => {
  assert.equal(
    requiresExplicitConfirmation({
      message: "Write the bass phrase",
      actions: [{
        type: "create_midi_clip",
        name: "Bass phrase",
        trackName: "Bass",
        startBeat: 0,
        durationBeats: 4,
        notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
      }],
    }),
    true,
  );
});

test("whole-Clip MIDI transforms validate exact locations and always confirm", () => {
  const plan = validateAgentPlan({
    message: "Tighten and transpose the loop",
    actions: [
      {
        type: "quantize_midi_notes",
        trackName: "Lead",
        clipName: "Lead Loop",
        slotIndex: 1,
        gridBeats: 0.25,
        strength: 0.8,
      },
      {
        type: "transpose_midi_notes",
        trackName: "Lead",
        clipName: "Verse",
        startBeat: 16,
        semitones: -12,
      },
    ],
  });

  assert.equal(requiresExplicitConfirmation(plan), true);
  assert.match(summarizeActionPlan(plan), /every note start.*0\.25-beat grid.*0\.8/i);
  assert.match(summarizeActionPlan(plan), /every note.*Verse.*-12 semitones/i);
  assert.throws(
    () => validateAgentPlan({
      message: "Ambiguous",
      actions: [{
        type: "shift_midi_notes",
        trackName: "Lead",
        startBeat: 0,
        slotIndex: 0,
        offsetBeats: 0.25,
      }],
    }),
    /exactly one of startBeat or slotIndex/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Invalid velocity scale",
      actions: [{
        type: "scale_midi_velocity",
        trackName: "Lead",
        slotIndex: 0,
        factor: 0,
      }],
    }),
    /factor must be between 0\.01 and 16/i,
  );
});

test("create_midi_clip accepts a 64-bar MIDI arrangement", () => {
  const notes = Array.from({ length: 256 }, (_, index) => ({
    pitch: 36 + (index % 12),
    startTime: index,
    duration: 0.75,
    velocity: 96,
  }));
  const plan = validateAgentPlan({
    message: "Write a 64-bar arrangement",
    actions: [{
      type: "create_midi_clip",
      name: "Full arrangement",
      trackName: "Bass",
      startBeat: 0,
      durationBeats: 256,
      notes,
    }],
  });

  assert.equal(plan.actions[0]?.type, "create_midi_clip");
  assert.equal(
    plan.actions[0]?.type === "create_midi_clip"
      ? plan.actions[0].notes.length
      : 0,
    256,
  );
});

test("create_midi_clip can create an empty long Clip for segmented writing", () => {
  const plan = validateAgentPlan({
    message: "Create the 64-bar Clip shell",
    actions: [{
      type: "create_midi_clip",
      trackName: "Bass",
      name: "Full arrangement",
      startBeat: 0,
      durationBeats: 256,
      notes: [],
    }],
  });

  assert.equal(plan.actions[0]?.type, "create_midi_clip");
  assert.equal(
    plan.actions[0]?.type === "create_midi_clip" ? plan.actions[0].notes.length : -1,
    0,
  );
});

test("MIDI actions reject oversized and out-of-bound note payloads", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Too many notes",
      actions: [{
        type: "create_midi_clip",
        trackName: "Bass",
        startBeat: 0,
        durationBeats: 256,
        notes: Array.from({ length: 4097 }, () => ({
          pitch: 36,
          startTime: 0,
          duration: 1,
        })),
      }],
    }),
    /at most 4096 notes/i,
  );
  for (const note of [
    { pitch: 36, startTime: -0.25, duration: 1, velocity: 100 },
    { pitch: 36, startTime: 3.5, duration: 1, velocity: 100 },
  ]) {
    assert.throws(
      () => validateAgentPlan({
        message: "Out of bounds",
        actions: [{
          type: "create_midi_clip",
          trackName: "Bass",
          startBeat: 0,
          durationBeats: 4,
          notes: [note],
        }],
      }),
      /inside.*Clip|Clip.*bounds/i,
    );
  }
});

test("replace_midi_clip_segment validates relative timing and always confirms", () => {
  const plan = validateAgentPlan({
    message: "Write bars 17-32",
    actions: [{
      type: "replace_midi_clip_segment",
      trackName: "Bass",
      clipName: "Full arrangement",
      startBeat: 0,
      segmentStartTime: 64,
      segmentDurationBeats: 64,
      notes: [
        { pitch: 36, startTime: 64, duration: 1, velocity: 100 },
        { pitch: 38, startTime: 127, duration: 1, velocity: 100 },
      ],
    }],
  });

  assert.equal(plan.actions[0]?.type, "replace_midi_clip_segment");
  assert.equal(requiresExplicitConfirmation(plan), true);
  assert.match(summarizeActionPlan(plan), /relative beats 64-128.*2 notes/i);

  assert.throws(
    () => validateAgentPlan({
      message: "Outside segment",
      actions: [{
        type: "replace_midi_clip_segment",
        trackName: "Bass",
        clipName: "Full arrangement",
        startBeat: 0,
        segmentStartTime: 64,
        segmentDurationBeats: 64,
        notes: [{ pitch: 36, startTime: 63.5, duration: 1, velocity: 100 }],
      }],
    }),
    /inside.*segment|segment.*bounds/i,
  );
});

test("one plan rejects overlapping replacements of the same MIDI clip", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Write two segments",
      actions: [
        {
          type: "replace_midi_clip_segment",
          trackName: "Bass",
          clipName: "Full arrangement",
          startBeat: 0,
          segmentStartTime: 0,
          segmentDurationBeats: 16,
          notes: [],
        },
        {
          type: "replace_midi_clip_segment",
          trackName: "Bass",
          clipName: "Full arrangement",
          startBeat: 0,
          segmentStartTime: 8,
          segmentDurationBeats: 16,
          notes: [],
        },
      ],
    }),
    /actions 1 and 2.*overlapping.*MIDI clip/i,
  );

  assert.doesNotThrow(() => validateAgentPlan({
    message: "Write adjacent segments",
    actions: [
      {
        type: "replace_midi_clip_segment",
        trackName: "Bass",
        clipName: "Full arrangement",
        startBeat: 0,
        segmentStartTime: 0,
        segmentDurationBeats: 16,
        notes: [],
      },
      {
        type: "replace_midi_clip_segment",
        trackName: "Bass",
        clipName: "Full arrangement",
        startBeat: 0,
        segmentStartTime: 16,
        segmentDurationBeats: 16,
        notes: [],
      },
    ],
  }));
});

test("invalid actions identify their position and type for model repair", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Name Session scenes",
      actions: [
        { type: "set_tempo", tempo: 150 },
        { type: "rename_scene", sceneIndex: 0, sceneName: "Intro" },
      ],
    }),
    /Action 2 \(rename_scene\).*newName.*Valid rename_scene example.*"newName":"Verse"/i,
  );
});

test("post-schema action validation keeps the same repair context", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Edit a Session Clip",
      actions: [{
        type: "set_clip_properties",
        trackName: "Lead",
        slotIndex: 0,
      }],
    }),
    /Action 1 \(set_clip_properties\).*at least one property change.*Valid set_clip_properties example/i,
  );
});

test("create_midi_clip summaries disclose create-or-replace behavior", () => {
  const summary = summarizeActionPlan({
    message: "Write the bass phrase",
    actions: [{
      type: "create_midi_clip",
      name: "Bass phrase",
      trackName: "Bass",
      startBeat: 0,
      durationBeats: 4,
      notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
    }],
  });

  assert.match(summary, /create or replace MIDI clip/i);
});

test("delete_clip requires an arrangement start beat", () => {
  assert.throws(
    () =>
      validateAgentPlan({
        message: "Delete selected clip",
        actions: [{ type: "delete_clip", trackName: "Lead" }],
      }),
    /number startBeat/,
  );
});

test("one plan can rename an existing target and keep using its stable trackRef", () => {
  const plan = validateAgentPlan({
    message: "Build Dream Sequence",
    targets: { pads: { trackName: "1-MIDI" } },
    actions: [
      { type: "rename_track", trackRef: "pads", newName: "Dream Pads" },
      {
        type: "create_midi_clip",
        trackRef: "pads",
        startBeat: 0,
        durationBeats: 16,
        notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 88 }],
      },
      { type: "insert_device", trackRef: "pads", deviceName: "Auto Filter" },
    ],
  });

  assert.deepEqual(plan.targets, { pads: { trackName: "1-MIDI" } });
  assert.match(summarizeActionPlan(plan), /track ref "pads"/i);
});

test("one plan can bind a created MIDI track for later clip and device actions", () => {
  const plan = validateAgentPlan({
    message: "Create a complete instrument track",
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
  });

  assert.equal(plan.actions[0]?.type, "create_midi_track");
});

test("track references reject missing, forward, duplicate, and incompatible declarations", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Missing ref",
      actions: [{ type: "rename_track", trackRef: "missing", newName: "Lead" }],
    }),
    /action 1.*missing.*trackRef/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Forward ref",
      actions: [
        { type: "insert_device", trackRef: "later", deviceName: "Auto Filter" },
        { type: "create_midi_track", ref: "later", name: "Later" },
      ],
    }),
    /action 1.*forward.*later/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Duplicate ref",
      targets: { track: { trackName: "1-MIDI" } },
      actions: [{ type: "create_midi_track", ref: "track", name: "Other" }],
    }),
    /action 1.*duplicate.*track/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Wrong type",
      actions: [
        { type: "create_audio_track", ref: "audio", name: "Audio" },
        {
          type: "create_midi_clip",
          trackRef: "audio",
          startBeat: 0,
          durationBeats: 4,
          notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 90 }],
        },
      ],
    }),
    /action 2.*audio.*MIDI/i,
  );
});

test("a track action cannot mix a mutable name with a stable ref", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Ambiguous target",
      targets: { lead: { trackName: "Lead" } },
      actions: [{
        type: "rename_track",
        trackName: "Lead",
        trackRef: "lead",
        newName: "New Lead",
      }],
    }),
    /action 1.*either trackName or trackRef/i,
  );
});

test("the old rename-then-new-name payload explains how to express the dependency", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Build Dream Pads",
      actions: [
        { type: "rename_track", trackName: "1-MIDI", newName: "Dream Pads" },
        {
          type: "create_midi_clip",
          trackName: "Dream Pads",
          startBeat: 0,
          durationBeats: 16,
          notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 88 }],
        },
      ],
    }),
    /action 2.*Dream Pads.*targets.*trackRef.*staged/i,
  );
});

test("parameters on a newly created track require a staged observation", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Create and configure",
      actions: [
        { type: "create_midi_track", ref: "lead", name: "Lead" },
        { type: "insert_device", trackRef: "lead", deviceName: "Auto Filter" },
        {
          type: "set_device_parameter",
          trackRef: "lead",
          deviceName: "Auto Filter",
          parameterName: "Frequency",
          value: 0.5,
        },
      ],
    }),
    /action 3.*newly created.*inspect.*staged/i,
  );
});

test("a deleted trackRef cannot be used by later actions", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Invalid lifetime",
      targets: { scratch: { trackName: "Scratch" } },
      actions: [
        { type: "delete_track", trackRef: "scratch" },
        { type: "insert_device", trackRef: "scratch", deviceName: "Auto Filter" },
      ],
    }),
    /action 2.*scratch.*after.*deleted/i,
  );
});

test("a deleted trackRef cannot be redeclared later in the same plan", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Do not recycle ref identity",
      targets: { lead: { trackName: "Lead" } },
      actions: [
        { type: "delete_track", trackRef: "lead" },
        { type: "create_midi_track", ref: "lead", name: "Lead" },
      ],
    }),
    /action 2.*duplicate.*lead/i,
  );
});

test("device actions accept nested paths and safe observed sample sources", () => {
  const plan = validateAgentPlan({
    message: "Build the kick pad",
    actions: [
      {
        type: "configure_drum_pad",
        trackName: "Drums",
        rackName: "Drum Rack",
        rackPath: { deviceIndex: 0 },
        receivingNote: 36,
        mode: "fill_empty_pad",
        source: {
          kind: "arrangement_audio_clip",
          trackName: "Samples",
          clipName: "Kick",
          startBeat: 0,
        },
      },
      {
        type: "set_device_parameter",
        trackName: "Drums",
        deviceName: "Kick Simpler",
        devicePath: {
          deviceIndex: 0,
          nested: [{ chainIndex: 0, deviceIndex: 0 }],
        },
        parameterName: "Gain",
        value: 0.75,
      },
    ],
  });

  assert.equal(plan.actions[0]?.type, "configure_drum_pad");
  assert.match(summarizeActionPlan(plan), /MIDI note 36/i);
});

test("Drum Pad configuration makes replacement policy explicit", () => {
  const fill = validateAgentPlan({
    message: "Fill an empty kick pad",
    actions: [{
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 0 },
      receivingNote: 36,
      mode: "fill_empty_pad",
      source: { kind: "selected" },
    }],
  });
  assert.equal(requiresExplicitConfirmation(fill), false);
  assert.match(summarizeActionPlan(fill), /fill empty.*MIDI note 36/i);

  const replace = validateAgentPlan({
    message: "Replace the kick sample",
    actions: [{
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      rackPath: { deviceIndex: 0 },
      receivingNote: 36,
      mode: "replace_existing_simpler",
      simplerPath: {
        deviceIndex: 0,
        nested: [{ chainIndex: 0, deviceIndex: 0 }],
      },
      source: { kind: "selected" },
    }],
  });
  assert.equal(requiresExplicitConfirmation(replace), true);
  assert.match(summarizeActionPlan(replace), /replace.*Simpler.*devicePath/i);

  assert.throws(() => validateAgentPlan({
    message: "Ambiguous replacement",
    actions: [{
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      receivingNote: 36,
      mode: "replace_existing_simpler",
      source: { kind: "selected" },
    }],
  }), /requires simplerPath/i);

  assert.throws(() => validateAgentPlan({
    message: "Do not mix policies",
    actions: [{
      type: "configure_drum_pad",
      trackName: "Drums",
      rackName: "Drum Rack",
      receivingNote: 36,
      mode: "fill_empty_pad",
      simplerPath: { deviceIndex: 0 },
      source: { kind: "selected" },
    }],
  }), /simplerPath.*only.*replace_existing_simpler/i);
});

test("device paths reject malformed segments and legacy index conflicts", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Bad path",
      actions: [{
        type: "delete_device",
        trackName: "Lead",
        deviceName: "Rack",
        devicePath: {
          deviceIndex: 0,
          nested: [{ chainIndex: -1, deviceIndex: 0 }],
        },
      }],
    }),
    /chainIndex/,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Conflicting locator",
      actions: [{
        type: "duplicate_device",
        trackName: "Lead",
        deviceName: "Serum",
        deviceIndex: 1,
        devicePath: { deviceIndex: 1 },
      }],
    }),
    /either devicePath or deviceIndex/i,
  );
});

test("sample sources never accept model-provided filesystem paths", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Unsafe sample",
      actions: [{
        type: "replace_simpler_sample",
        trackName: "Bass",
        simplerName: "Simpler",
        source: { kind: "selected", filePath: "/tmp/kick.wav" },
      }],
    }),
    /does not support property filePath/i,
  );
});

test("mixer actions validate Send selection and device deletion confirms", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Bad Send",
      actions: [{
        type: "set_track_mixer_parameter",
        trackName: "Lead",
        parameter: "send",
        value: 0.5,
      }],
    }),
    /sendIndex/i,
  );
  const deletion = validateAgentPlan({
    message: "Remove old synth",
    actions: [{
      type: "delete_device",
      trackName: "Lead",
      deviceName: "Old Synth",
      devicePath: { deviceIndex: 0 },
    }],
  });
  assert.equal(requiresExplicitConfirmation(deletion), true);
});

test("Session, audio, and clip actions validate exact locations and safe sources", () => {
  const plan = validateAgentPlan({
    message: "Build clips",
    actions: [
      {
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 8,
        name: "Lead Loop",
        notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
      },
      {
        type: "create_arrangement_audio_clip",
        trackName: "Audio",
        source: { kind: "selected" },
        startBeat: 0,
        durationBeats: 8,
        isWarped: true,
        loopSettings: {
          looping: true,
          startMarker: 0,
          endMarker: 4,
          loopStart: 0,
          loopEnd: 4,
        },
      },
      {
        type: "set_clip_properties",
        trackName: "Lead",
        slotIndex: 0,
        newName: "Lead Loop v2",
        looping: true,
      },
      {
        type: "set_audio_clip_warp",
        trackName: "Audio",
        startBeat: 0,
        warping: true,
        warpMode: "complex_pro",
      },
    ],
  });

  assert.equal(plan.actions.length, 4);
  assert.match(summarizeActionPlan(plan), /Session MIDI clip.*slot 0/i);
  assert.equal(requiresExplicitConfirmation(plan), true);
});

test("sample action summaries disclose exact observed source locators", () => {
  const plan = validateAgentPlan({
    message: "Reuse two observed sources",
    actions: [
      {
        type: "replace_simpler_sample",
        trackName: "Drums",
        simplerName: "Target",
        source: {
          kind: "arrangement_audio_clip",
          trackName: "Audio",
          clipName: "Kick Source",
          startBeat: 64,
        },
      },
      {
        type: "replace_simpler_sample",
        trackName: "Drums",
        simplerName: "Target 2",
        source: {
          kind: "simpler",
          trackName: "Sources",
          deviceName: "Source Simpler",
          devicePath: {
            deviceIndex: 2,
            nested: [{ chainIndex: 0, deviceIndex: 1 }],
          },
        },
      },
    ],
  });

  const summary = summarizeActionPlan(plan);
  assert.match(summary, /Kick Source.*Audio.*beat 64/i);
  assert.match(summary, /Source Simpler.*devicePath.*deviceIndex.*2.*chainIndex.*0/i);
});

test("clip actions reject ambiguous locations, no-op edits, and invalid ranges", () => {
  for (const action of [
    {
      type: "set_clip_properties",
      trackName: "Lead",
      startBeat: 0,
      slotIndex: 0,
      muted: true,
    },
    {
      type: "set_audio_clip_warp",
      trackName: "Audio",
      warping: true,
    },
  ]) {
    assert.throws(
      () => validateAgentPlan({ message: "Bad locator", actions: [action] }),
      /exactly one of startBeat or slotIndex/i,
    );
  }
  assert.throws(
    () => validateAgentPlan({
      message: "No changes",
      actions: [{ type: "set_clip_properties", trackName: "Lead", slotIndex: 0 }],
    }),
    /at least one property/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Bad range",
      actions: [{
        type: "clear_arrangement_range",
        trackName: "Lead",
        startBeat: 8,
        endBeat: 4,
      }],
    }),
    /endBeat greater/i,
  );
});

test("audio creation validates the SDK loop contract", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Missing warp choice",
      actions: [{
        type: "create_session_audio_clip",
        trackName: "Audio",
        slotIndex: 0,
        source: { kind: "selected" },
        loopSettings: {
          looping: true,
          startMarker: 0,
          endMarker: 4,
          loopStart: 0,
          loopEnd: 4,
        },
      }],
    }),
    /loopSettings require isWarped/i,
  );
  assert.throws(
    () => validateAgentPlan({
      message: "Unwarped loop",
      actions: [{
        type: "create_session_audio_clip",
        trackName: "Audio",
        slotIndex: 0,
        source: { kind: "selected" },
        isWarped: false,
        loopSettings: {
          looping: true,
          startMarker: 0,
          endMarker: 4,
          loopStart: 0,
          loopEnd: 4,
        },
      }],
    }),
    /Unwarped audio/i,
  );

  const replacement = validateAgentPlan({
    message: "Replace the Session loop if needed",
    actions: [{
      type: "create_session_audio_clip",
      trackName: "Audio",
      slotIndex: 0,
      source: { kind: "selected" },
      isWarped: true,
    }],
  });
  assert.match(
    summarizeActionPlan(replacement),
    /create or replace.*source, Warp state, or loop settings differ.*delete.*recreat/is,
  );
});

test("new clip edits on a newly created track require staging only when observation is needed", () => {
  const creation = validateAgentPlan({
    message: "Create Session loop",
    actions: [
      { type: "create_midi_track", ref: "lead", name: "Lead" },
      {
        type: "create_session_midi_clip",
        trackRef: "lead",
        slotIndex: 0,
        durationBeats: 4,
        notes: [],
      },
    ],
  });
  assert.equal(creation.actions.length, 2);

  assert.throws(
    () => validateAgentPlan({
      message: "Edit before observation",
      actions: [
        { type: "create_midi_track", ref: "lead", name: "Lead" },
        {
          type: "set_clip_properties",
          trackRef: "lead",
          slotIndex: 0,
          muted: true,
        },
      ],
    }),
    /newly created.*inspect.*staged/i,
  );
});

test("Scene, Cue Point, and Take Lane actions use stable indexes and expected names", () => {
  const plan = validateAgentPlan({
    message: "Organize the song",
    actions: [
      { type: "rename_scene", sceneIndex: 0, sceneName: "Intro", newName: "Verse" },
      { type: "duplicate_scene", sceneIndex: 0 },
      { type: "create_cue_point", timeBeat: 16, name: "Drop" },
      { type: "rename_cue_point", timeBeat: 16, cueName: "Drop", newName: "Drop 1" },
      { type: "create_take_lane", trackName: "Vocals", name: "Take 3" },
      {
        type: "rename_take_lane",
        trackName: "Vocals",
        laneIndex: 0,
        laneName: "Take 1",
        newName: "Main Take",
      },
    ],
  });

  assert.equal(plan.actions.length, 6);
  assert.match(summarizeActionPlan(plan), /Scene 0.*Intro.*Verse/i);
  assert.match(summarizeActionPlan(plan), /Cue Point.*beat 16/i);
  assert.match(summarizeActionPlan(plan), /Take Lane 0.*Main Take/i);
});

test("structural Scene edits require a staged call before later index-based work", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Insert a Scene, then write its clip",
      actions: [
        { type: "create_scene", index: 0, name: "Intro" },
        {
          type: "create_session_midi_clip",
          trackName: "Lead",
          slotIndex: 0,
          durationBeats: 4,
          notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
        },
      ],
    }),
    /Actions 1 and 2.*Scene.*slot.*staged apply/i,
  );

  assert.throws(
    () => validateAgentPlan({
      message: "Duplicate then rename the resulting row",
      actions: [
        { type: "duplicate_scene", sceneIndex: 1, sceneName: "Verse" },
        { type: "rename_scene", sceneIndex: 2, newName: "Verse B" },
      ],
    }),
    /Actions 1 and 2.*Scene.*index.*staged apply/i,
  );

  assert.throws(
    () => validateAgentPlan({
      message: "Delete a row, then reuse a Session source",
      actions: [
        { type: "delete_scene", sceneIndex: 0, sceneName: "Scratch" },
        {
          type: "replace_simpler_sample",
          trackName: "Drums",
          simplerName: "Simpler",
          source: {
            kind: "session_audio_clip",
            trackName: "Samples",
            slotIndex: 0,
          },
        },
      ],
    }),
    /Actions 1 and 2.*Session source.*staged apply/i,
  );
});

test("structural Scene edits can follow already-resolved Session work", () => {
  assert.doesNotThrow(() => validateAgentPlan({
    message: "Write the existing slot, then append a Scene",
    actions: [
      {
        type: "create_session_midi_clip",
        trackName: "Lead",
        slotIndex: 0,
        durationBeats: 4,
        notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96 }],
      },
      { type: "create_scene", name: "Outro" },
    ],
  }));
});

test("a duplicated track selector explains which redundant field to remove", () => {
  assert.throws(
    () => validateAgentPlan({
      message: "Rename the chords track",
      targets: { chords: { trackName: "1-MIDI" } },
      actions: [{
        type: "rename_track",
        trackRef: "chords",
        trackName: "1-MIDI",
        newName: "Chords",
      }],
    }),
    /Action 1 \(rename_track\).*trackRef "chords".*remove trackName.*Valid rename_track example/i,
  );
});

test("destructive Scene and Cue Point actions always require explicit confirmation", () => {
  const plan = validateAgentPlan({
    message: "Remove drafts",
    actions: [
      { type: "delete_scene", sceneIndex: 1, sceneName: "Draft" },
      { type: "delete_cue_point", timeBeat: 32, cueName: "Old Drop" },
    ],
  });
  assert.equal(requiresExplicitConfirmation(plan), true);

  assert.throws(
    () => validateAgentPlan({
      message: "Bad Cue",
      actions: [{ type: "create_cue_point", timeBeat: -1, name: "Before Start" }],
    }),
    /must not be negative/i,
  );
});
