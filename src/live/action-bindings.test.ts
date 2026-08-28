import assert from "node:assert/strict";
import test from "node:test";

import { AudioClip, AudioTrack, MidiClip, MidiTrack, Track } from "@ableton-extensions/sdk";

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

function sdkObject<T extends object>(prototype: T, properties: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key, { configurable: true, enumerable: true, writable: true, value },
    ]),
  ));
}
