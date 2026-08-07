import assert from "node:assert/strict";
import test from "node:test";

import { MidiTrack } from "@ableton-extensions/sdk";

import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
  liveActionIdentityKeys,
} from "./action-bindings.js";

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
