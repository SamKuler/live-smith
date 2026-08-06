import assert from "node:assert/strict";
import test from "node:test";

import { MidiTrack } from "@ableton-extensions/sdk";

import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
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

test("a creator action binds and rechecks the exact reusable track handle", () => {
  const midiTrack = (id: string) => Object.defineProperties(
    Object.create(MidiTrack.prototype),
    {
      handle: { enumerable: true, value: { id } },
      name: { enumerable: true, value: "Lead" },
    },
  );
  const original = midiTrack("track-1");
  const plan = {
    message: "Reuse Lead",
    actions: [{ type: "create_midi_track", ref: "lead", name: "Lead" }],
  } as const;
  const before = bindAgentPlanTargets(
    { application: { song: { tracks: [original] } } } as never,
    plan as never,
  );
  assert.equal(before.actionTracks.get(0), original);
  assert.equal(before.tracks.get("lead"), original);

  const replacement = midiTrack("track-2");
  const after = bindAgentPlanTargets(
    { application: { song: { tracks: [replacement] } } } as never,
    plan as never,
  );
  assert.throws(
    () => assertSameExistingPlanTargets(before, after),
    /ref "lead" changed/i,
  );
});
