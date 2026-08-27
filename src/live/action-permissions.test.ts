import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioClip,
  AudioTrack,
  Clip,
  ClipSlot,
  Device,
  MidiClip,
  MidiTrack,
  RackDevice,
  Scene,
  Simpler,
  TakeLane,
  Track,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import { agentActionExample, parseAgentAction } from "../agent/action-schema.js";
import type { AgentAction, AgentPlan } from "../agent/actions.js";
import { assertEditScopesAllow, type EditScope } from "../agent/edit-scopes.js";
import type { AgentPlanBindings, BoundActionObjects } from "./action-bindings.js";
import {
  requiredEditScopesForAction,
  requiredEditScopesForPlan,
} from "./action-permissions.js";

const fixedScopes: Record<EditScope, AgentAction["type"][]> = {
  midi: [
    "create_midi_clip", "create_session_midi_clip", "replace_midi_clip_segment",
    "transpose_midi_notes", "quantize_midi_notes", "scale_midi_velocity", "shift_midi_notes",
  ],
  audio: ["create_arrangement_audio_clip", "create_session_audio_clip", "set_audio_clip_warp"],
  devices: [
    "insert_device", "insert_chain_device", "set_device_parameter", "duplicate_device",
    "delete_device", "replace_simpler_sample", "configure_drum_pad",
  ],
  mixer: ["set_track_mute", "set_track_solo", "set_track_arm", "set_track_mixer_parameter"],
  structure: [
    "create_midi_track", "create_audio_track", "rename_track", "create_scene", "rename_scene",
    "create_cue_point", "rename_cue_point", "delete_cue_point", "create_take_lane",
    "rename_take_lane", "set_tempo",
  ],
};

test("fixed action contracts require their category even for idempotent writes", () => {
  for (const [scope, types] of Object.entries(fixedScopes)) {
    for (const type of types) {
      const required = requiredEditScopesForAction(liveContext(), example(type), 0, bindings());
      assert.deepEqual(required, [scope], type);
      assert.doesNotThrow(() => assertEditScopesAllow(required, [scope as EditScope]));
      assert.throws(() => assertEditScopesAllow(required, []), /exceeds the Session's edit scope/);
    }
  }
});

test("generic Clip writes use actual MIDI or Audio instances rather than names", () => {
  for (const type of ["set_clip_properties", "delete_clip", "delete_session_clip"] as const) {
    for (const [clip, expected] of [
      [midiClip({ name: "Audio recording" }), "midi"],
      [audioClip({ name: "MIDI notes" }), "audio"],
    ] as const) {
      const required = requiredEditScopesForAction(
        liveContext(), example(type), 0, bindings(undefined, { clip }),
      );
      assert.deepEqual(required, [expected]);
      assert.throws(
        () => assertEditScopesAllow(required, [expected === "midi" ? "audio" : "midi"]),
        /exceeds the Session's edit scope/,
      );
    }
  }
});

test("missing or unrecognized Clip targets cannot be authorized", () => {
  for (const type of ["set_clip_properties", "delete_clip", "delete_session_clip"] as const) {
    for (const target of [bindings(), bindings(undefined, {
      clip: sdkObject(Clip.prototype, { name: "MidiClip", type: "midi" }),
    })]) {
      assert.throws(
        () => requiredEditScopesForAction(liveContext(), example(type), 0, target),
        /Cannot determine the edit scope/,
      );
    }
  }
});

test("sample sources are reads and do not grant or require their category as writes", () => {
  const sampleReplacement = example("replace_simpler_sample");
  assert.deepEqual(requiredEditScopesForAction(
    liveContext(), sampleReplacement, 0,
    bindings(undefined, { sampleSource: { object: audioClip() } as never }),
  ), ["devices"]);
  assert.deepEqual(requiredEditScopesForAction(
    liveContext(), example("create_arrangement_audio_clip"), 0,
    bindings(undefined, { sampleSource: { object: sdkObject(Simpler.prototype) } as never }),
  ), ["audio"]);
});

test("Session creation includes the content deleted from an occupied slot", () => {
  for (const [type, requestedScope, replaced] of [
    ["create_session_midi_clip", "midi", audioClip()],
    ["create_session_audio_clip", "audio", midiClip()],
  ] as const) {
    assert.deepEqual(requiredEditScopesForAction(
      liveContext(), example(type), 0, bindings(undefined, { slot: slot(replaced) }),
    ), ["midi", "audio"]);
    assert.deepEqual(requiredEditScopesForAction(
      liveContext(), example(type), 0, bindings(undefined, { slot: slot(null) }),
    ), [requestedScope]);
    assert.throws(() => requiredEditScopesForAction(
      liveContext(), example(type), 0,
      bindings(undefined, { slot: slot(sdkObject(Clip.prototype)) }),
    ), /Cannot determine the edit scope/);
  }
});

test("creator-ref plans retain fixed scopes without pretending the new track is observed", () => {
  const plan: AgentPlan = {
    message: "Create and fill a MIDI track",
    actions: [
      { type: "create_midi_track", name: "New", ref: "new" },
      { type: "insert_device", trackRef: "new", deviceName: "Any built-in device" },
      {
        type: "create_midi_clip", trackRef: "new", startBeat: 0,
        durationBeats: 4, notes: [],
      },
    ],
  };
  const required = requiredEditScopesForPlan(liveContext(), plan, bindings());
  assert.deepEqual(required, ["midi", "devices", "structure"]);
  assert.throws(() => assertEditScopesAllow(required, ["midi"]), /exceeds/);
});

test("a complete mixed plan combines categories in stable order", () => {
  const plan: AgentPlan = {
    message: "Mixed edits",
    actions: [
      example("set_tempo"), example("set_track_mute"), example("insert_device"),
      example("create_session_audio_clip"), example("create_midi_clip"), example("insert_device"),
    ],
  };
  assert.deepEqual(requiredEditScopesForPlan(liveContext(), plan, bindings()), [
    "midi", "audio", "devices", "mixer", "structure",
  ]);
});

test("track deletion and duplication account for Arrangement, Session, Take Lanes and devices", () => {
  const target = track({
    arrangementClips: [midiClip()],
    clipSlots: [slot(audioClip())],
    takeLanes: [sdkObject(TakeLane.prototype, { clips: [midiClip()] })],
    devices: [sdkObject(RackDevice.prototype, { chains: [] })],
  });
  for (const type of ["delete_track", "duplicate_track"] as const) {
    const required = requiredEditScopesForAction(
      liveContext([target]), example(type), 0, bindings(target),
    );
    assert.deepEqual(required, ["midi", "audio", "devices", "mixer", "structure"]);
    assert.throws(() => assertEditScopesAllow(required, ["structure", "mixer"]), /exceeds/);
  }
});

test("content found only in Take Lanes still requires its write scope", () => {
  const target = track({
    takeLanes: [sdkObject(TakeLane.prototype, { clips: [audioClip()] })],
  });
  assert.deepEqual(requiredEditScopesForAction(
    liveContext([target]), example("delete_track"), 0, bindings(target),
  ), ["audio", "mixer", "structure"]);
});

test("empty tracks carry structural and mixer state, not a category inferred from the track name", () => {
  const target = track({ name: "MIDI Audio Synth" }, MidiTrack.prototype);
  assert.deepEqual(requiredEditScopesForAction(
    liveContext([target]), example("duplicate_track"), 0, bindings(target),
  ), ["mixer", "structure"]);
});

test("group operations include nested descendants by handle but exclude unrelated tracks", () => {
  const group = track();
  const sameGroup = track({ handle: group.handle });
  const child = track({ groupTrack: sameGroup, arrangementClips: [midiClip()] });
  const nested = track({
    groupTrack: child,
    devices: [sdkObject(Device.prototype)],
    takeLanes: [sdkObject(TakeLane.prototype, { clips: [audioClip()] })],
  });
  const unrelated = track({ arrangementClips: [sdkObject(Clip.prototype)] });
  const context = liveContext([nested, unrelated, group, child]);
  for (const type of ["delete_track", "duplicate_track"] as const) {
    assert.deepEqual(requiredEditScopesForAction(context, example(type), 0, bindings(group)), [
      "midi", "audio", "devices", "mixer", "structure",
    ]);
    assert.deepEqual(requiredEditScopesForAction(context, example(type), 0, bindings(nested)), [
      "audio", "devices", "mixer", "structure",
    ]);
  }
});

test("existing trackRef bindings take precedence over name or action-index lookups", () => {
  const target = track({ arrangementClips: [audioClip()] });
  const other = track({ arrangementClips: [midiClip()] });
  const targets: AgentPlanBindings = {
    tracks: new Map([["target", target]]),
    actionTracks: new Map([[0, other]]),
    actionObjects: new Map(),
  };
  assert.deepEqual(requiredEditScopesForAction(liveContext([target, other]), {
    type: "delete_track", trackRef: "target",
  }, 0, targets), ["audio", "mixer", "structure"]);
});

test("unbound container operations fail closed, including unobserved creator refs", () => {
  for (const type of ["delete_track", "duplicate_track", "clear_arrangement_range"] as const) {
    assert.throws(() => requiredEditScopesForAction(liveContext(), {
      ...example(type), trackRef: "new",
    }, 0, bindings()), /Cannot determine the edit scope of the bound Track/);
  }
});

test("unrecognized content inside a track is not silently omitted", () => {
  const target = track({ clipSlots: [slot(sdkObject(Clip.prototype))] });
  assert.throws(() => requiredEditScopesForAction(
    liveContext([target]), example("delete_track"), 0, bindings(target),
  ), /Cannot determine the edit scope/);
});

test("Scene operations include only their current row resolved by bound handle", () => {
  const target = sdkObject(Scene.prototype);
  const currentTarget = sdkObject(Scene.prototype, { handle: target.handle });
  const otherScene = sdkObject(Scene.prototype);
  const targetTrack = track({
    clipSlots: [slot(audioClip()), slot(midiClip())],
    arrangementClips: [audioClip()],
    devices: [sdkObject(Device.prototype)],
  });
  const context = liveContext([targetTrack], [otherScene, currentTarget]);
  for (const type of ["delete_scene", "duplicate_scene"] as const) {
    const required = requiredEditScopesForAction(
      context, { ...example(type), sceneIndex: 0 } as AgentAction, 0,
      bindings(undefined, { scene: target }),
    );
    assert.deepEqual(required, ["midi", "structure"]);
    assert.throws(() => assertEditScopesAllow(required, ["structure"]), /exceeds/);
  }
});

test("a Scene row includes MIDI and audio clips across all regular tracks", () => {
  const scene = sdkObject(Scene.prototype);
  const tracks = [
    track({ clipSlots: [slot(midiClip())] }),
    track({ clipSlots: [slot(audioClip())] }, AudioTrack.prototype),
    track({ clipSlots: [slot(null)] }),
  ];
  assert.deepEqual(requiredEditScopesForAction(
    liveContext(tracks, [scene]), example("delete_scene"), 0,
    bindings(undefined, { scene }),
  ), ["midi", "audio", "structure"]);
});

test("empty Scene rows are structural writes only", () => {
  const scene = sdkObject(Scene.prototype);
  assert.deepEqual(requiredEditScopesForAction(
    liveContext([track({ clipSlots: [slot(null)] })], [scene]), example("duplicate_scene"),
    0, bindings(undefined, { scene }),
  ), ["structure"]);
});

test("missing, replaced or incomplete Scene targets fail closed", () => {
  const scene = sdkObject(Scene.prototype, { name: "Verse" });
  const replacement = sdkObject(Scene.prototype, { name: "Verse" });
  assert.throws(() => requiredEditScopesForAction(
    liveContext([], [scene]), example("delete_scene"), 0, bindings(),
  ), /bound Scene/);
  assert.throws(() => requiredEditScopesForAction(
    liveContext([], [replacement]), example("delete_scene"), 0, bindings(undefined, { scene }),
  ), /bound current Scene/);
  assert.throws(() => requiredEditScopesForAction(
    liveContext([track()], [scene]), example("delete_scene"), 0, bindings(undefined, { scene }),
  ), /bound Scene Clip Slot/);
});

test("range clearing counts overlapping content and boundary truncation only", () => {
  const target = track({
    arrangementClips: [
      midiClip({ startTime: 0, duration: 4 }),
      audioClip({ startTime: 6, duration: 8 }),
      midiClip({ startTime: 8, duration: 4 }),
    ],
    clipSlots: [slot(midiClip())],
    takeLanes: [sdkObject(TakeLane.prototype, { clips: [midiClip()] })],
  });
  assert.deepEqual(requiredEditScopesForAction(liveContext([target]), {
    type: "clear_arrangement_range", trackName: "MIDI", startBeat: 4, endBeat: 8,
  }, 0, bindings(target)), ["audio"]);
});

test("clearing an already empty range is a no-op allowed by read-only scopes", () => {
  const target = track({ arrangementClips: [midiClip({ startTime: 0, duration: 4 })] });
  const required = requiredEditScopesForAction(liveContext([target]), {
    type: "clear_arrangement_range", trackName: "MIDI", startBeat: 4, endBeat: 8,
  }, 0, bindings(target));
  assert.deepEqual(required, []);
  assert.doesNotThrow(() => assertEditScopesAllow(required, []));
});

test("unknown overlapping Clip kinds prevent range authorization", () => {
  const target = track({
    arrangementClips: [sdkObject(Clip.prototype, { startTime: 0, duration: 4 })],
  });
  assert.throws(() => requiredEditScopesForAction(liveContext([target]), {
    type: "clear_arrangement_range", trackName: "MIDI", startBeat: 2, endBeat: 3,
  }, 0, bindings(target)), /Cannot determine the edit scope/);
});

test("per-action authorization re-reads changing content without revisiting previous targets", () => {
  const clips: Clip<"1.0.0">[] = [midiClip()];
  const target = track({ arrangementClips: clips });
  const context = liveContext([target]);
  const targets: AgentPlanBindings = {
    tracks: new Map(), actionTracks: new Map([[1, target]]), actionObjects: new Map(),
  };
  assert.deepEqual(requiredEditScopesForAction(context, example("delete_track"), 1, targets), [
    "midi", "mixer", "structure",
  ]);
  clips[0] = audioClip();
  assert.deepEqual(requiredEditScopesForAction(context, example("delete_track"), 1, targets), [
    "audio", "mixer", "structure",
  ]);
});

test("unsupported actions have no permissive fallback", () => {
  assert.throws(() => requiredEditScopesForAction(
    liveContext(), { type: "future_write" } as never, 0, bindings(),
  ), /No edit-scope classification/);
});

function example<Type extends AgentAction["type"]>(type: Type): Extract<AgentAction, { type: Type }> {
  return parseAgentAction(JSON.parse(agentActionExample(type)!)) as Extract<AgentAction, { type: Type }>;
}

function bindings(
  target?: Track<"1.0.0">,
  objects?: BoundActionObjects,
): AgentPlanBindings {
  return {
    tracks: new Map(),
    actionTracks: new Map(target ? [[0, target]] : []),
    actionObjects: new Map(objects ? [[0, objects]] : []),
  };
}

function liveContext(
  tracks: Track<"1.0.0">[] = [],
  scenes: Scene<"1.0.0">[] = [],
): ExtensionContext<"1.0.0"> {
  return { application: { song: { tracks, scenes } } } as never;
}

function track(
  properties: Record<string, unknown> = {},
  prototype: Track<"1.0.0"> = Track.prototype,
): Track<"1.0.0"> {
  return sdkObject(prototype, {
    name: "Track", groupTrack: null, arrangementClips: [], clipSlots: [],
    takeLanes: [], devices: [], ...properties,
  });
}

function midiClip(properties: Record<string, unknown> = {}): MidiClip<"1.0.0"> {
  return sdkObject(MidiClip.prototype, {
    name: "Clip", startTime: 0, duration: 4, ...properties,
  });
}

function audioClip(properties: Record<string, unknown> = {}): AudioClip<"1.0.0"> {
  return sdkObject(AudioClip.prototype, {
    name: "Clip", startTime: 0, duration: 4, ...properties,
  });
}

function slot(clip: Clip<"1.0.0"> | null): ClipSlot<"1.0.0"> {
  return sdkObject(ClipSlot.prototype, { clip });
}

let nextHandle = 0;
function sdkObject<T extends object>(prototype: T, properties: Record<string, unknown> = {}): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries({ handle: { id: ++nextHandle }, ...properties }).map(([key, value]) => [
      key, { configurable: true, enumerable: true, writable: true, value },
    ]),
  ));
}
