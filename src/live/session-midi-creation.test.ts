import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioClip,
  ClipSlot,
  MidiClip,
  MidiTrack,
  type Clip,
  type ExtensionContext,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import type { AgentAction, AgentPlan } from "../agent/actions.js";
import { preflightAgentPlan } from "../app/agent-request.js";
import { bindAgentPlanTargets } from "./action-bindings.js";
import {
  AgentPlanExecutionError,
  executeAgentPlanWithProgress,
} from "./executor.js";
import { captureLiveActionPreflightSnapshot } from "./preflight.js";

test("Session MIDI preflight preserves default replacement and requires an empty candidate slot", async () => {
  const host = sessionHost();
  const action = candidateAction();
  const empty = await captureLiveActionPreflightSnapshot(host.context, action, {});
  const existing = host.midiClip("existing", { notes: action.notes });
  Reflect.set(host.slot, "clip", existing);

  await assert.rejects(
    captureLiveActionPreflightSnapshot(host.context, action, {}),
    /Session slot 0.*must be empty/i,
  );
  const { requireEmpty: _requireEmpty, ...legacy } = action;
  const occupied = await captureLiveActionPreflightSnapshot(host.context, legacy, {});
  assert.notEqual(occupied, empty);
  assert.equal(
    await captureLiveActionPreflightSnapshot(host.context, { ...action, requireEmpty: false }, {}),
    occupied,
  );
  assert.deepEqual(host.writes, []);
  assert.equal(host.slot.clip, existing);
});

test("empty-slot preflight retains the slot handle even when both destinations are empty", async () => {
  const host = sessionHost();
  const before = await captureLiveActionPreflightSnapshot(host.context, candidateAction(), {});
  host.track.clipSlots[0] = host.makeSlot("replacement-slot");
  const after = await captureLiveActionPreflightSnapshot(host.context, candidateAction(), {});
  assert.notEqual(after, before);
  assert.deepEqual(host.writes, []);
});

test("the real preflight guard admits an unchanged empty bound destination", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  const guard = await candidateGuard(host, plan);
  const bindings = await guard();
  assert.equal(bindings.actionObjects.get(0)?.slot, host.slot);
  assert.equal(bindings.tracks.get("destination"), host.track);

  const result = await executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings);
  assert.equal(result.mutationCount, 1);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!, /Created Session MIDI clip.*slot 0.*Lead/i);
  assert.deepEqual(host.writes, ["slot-1:create:4", "slot-1-created:name", "slot-1-created:notes"]);
  assert.equal(host.slot.clip?.name, "Alternative");
  assert.deepEqual((host.slot.clip as MidiClip<"1.0.0">).notes, candidateAction().notes);
  assert.equal(host.source.name, "Original");
  assert.deepEqual(host.source.notes, [{ pitch: 48, startTime: 0, duration: 2, velocity: 90 }]);
});

test("filling the destination during confirmation makes the real guard reject without writes", async () => {
  const host = sessionHost();
  const guard = await candidateGuard(host);
  const occupant = host.midiClip("occupant", { notes: candidateAction().notes });
  Reflect.set(host.slot, "clip", occupant);

  await assert.rejects(guard, /Session slot 0.*must be empty/i);
  assert.equal(host.slot.clip, occupant);
  assert.deepEqual(host.writes, []);
});

test("replacing an empty destination while confirmation waits invalidates the bound slot", async () => {
  const host = sessionHost();
  const guard = await candidateGuard(host);
  host.track.clipSlots[0] = host.makeSlot("replacement-slot");

  await assert.rejects(guard, /Live object bound to action 1 changed/i);
  assert.deepEqual(host.writes, []);
});

test("complete-plan preflight rejects an occupied candidate destination before any earlier action runs", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  plan.actions.unshift({ type: "rename_track", trackRef: "destination", newName: "Renamed" });
  Reflect.set(host.slot, "clip", host.midiClip("occupant"));

  await assert.rejects(candidateGuard(host, plan), /Session slot 0.*must be empty/i);
  assert.equal(host.track.name, "Lead");
  assert.deepEqual(host.writes, []);
});

test("candidate execution rejects every occupied slot before reuse, rename, note write, or deletion", async () => {
  for (const variant of ["matching", "different-notes", "different-name", "different-duration", "audio"] as const) {
    const host = sessionHost();
    const occupant = variant === "audio"
      ? sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, { name: "Audio", handle: { id: "audio" } })
      : host.midiClip("occupant", {
        name: variant === "different-name" ? "Unrelated" : "Alternative",
        duration: variant === "different-duration" ? 8 : 4,
        notes: variant === "different-notes" ? [] : candidateAction().notes,
      });
    Reflect.set(host.slot, "clip", occupant);

    await assert.rejects(
      executeAgentPlanWithProgress(host.context, candidatePlan(), {}),
      noWriteFailure(/Session slot 0.*must be empty/i),
    );
    assert.equal(host.slot.clip, occupant, variant);
    assert.deepEqual(host.writes, [], variant);
  }
});

test("candidate execution rechecks occupancy after the guard has returned", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  const guard = await candidateGuard(host, plan);
  const bindings = await guard();
  const occupant = host.midiClip("late-occupant", { notes: candidateAction().notes });
  Reflect.set(host.slot, "clip", occupant);

  await assert.rejects(
    executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings),
    noWriteFailure(/Session slot 0.*must be empty/i),
  );
  assert.equal(host.slot.clip, occupant);
  assert.deepEqual(host.writes, []);
});

test("a slot filled between actions stops the candidate write and preserves completed action accounting", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  plan.actions.unshift({ type: "rename_track", trackRef: "destination", newName: "Renamed" });
  const guard = await candidateGuard(host, plan);
  const bindings = await guard();
  const occupant = host.midiClip("late-occupant", { notes: candidateAction().notes });

  await assert.rejects(
    executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings, (index) => {
      if (index === 1) Reflect.set(host.slot, "clip", occupant);
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentPlanExecutionError);
      assert.equal(error.failedActionIndex, 1);
      assert.equal(error.completedMutationCount, 1);
      assert.equal(error.completedActionCount, 1);
      assert.equal(error.completedActionKeys.length, 1);
      assert.equal(error.completedResults.length, 1);
      assert.match(error.message, /Session slot 0.*must be empty/i);
      return true;
    },
  );
  assert.equal(host.track.name, "Renamed");
  assert.equal(host.slot.clip, occupant);
  assert.deepEqual(host.writes, []);
});

test("candidate execution rejects moved, removed, or replaced bound slots without selecting a new destination", async () => {
  for (const change of ["moved", "removed", "empty-replacement", "occupied-replacement"] as const) {
    const host = sessionHost();
    const plan = candidatePlan();
    const bindings = bindAgentPlanTargets(host.context, plan);
    const replacement = host.makeSlot("replacement-slot");
    if (change === "occupied-replacement") {
      Reflect.set(replacement, "clip", host.midiClip("replacement-clip"));
    }
    host.track.clipSlots.splice(0, 1, ...(change === "removed" ? [] : [replacement]));
    if (change === "moved") host.track.clipSlots.push(host.slot);

    await assert.rejects(
      executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings),
      noWriteFailure(/Session slot 0.*changed|Could not find Session slot 0/i),
    );
    assert.equal(host.slot.clip, null);
    assert.deepEqual(host.writes, [], change);
  }
});

test("candidate execution reads current occupancy from a refreshed wrapper for the bound slot handle", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  const bindings = bindAgentPlanTargets(host.context, plan);
  const refreshed = host.makeSlot("slot-1");
  const occupant = host.midiClip("late-occupant");
  Reflect.set(refreshed, "clip", occupant);
  host.track.clipSlots[0] = refreshed;

  await assert.rejects(
    executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings),
    noWriteFailure(/Session slot 0.*must be empty/i),
  );
  assert.equal(refreshed.clip, occupant);
  assert.deepEqual(host.writes, []);
});

test("candidate execution follows a planned trackRef through a rename instead of guessing by name", async () => {
  const host = sessionHost();
  const plan = candidatePlan();
  plan.actions.unshift({ type: "rename_track", trackRef: "destination", newName: "Renamed" });
  const other = sessionHost();
  other.track.name = "Other";
  Object.defineProperty(other.track, "handle", { value: { id: "other-track" } });
  host.context.application.song.tracks.push(other.track);

  const bindings = bindAgentPlanTargets(host.context, plan);
  other.track.name = "Lead";
  const result = await executeAgentPlanWithProgress(host.context, plan, {}, undefined, bindings);
  assert.equal(result.mutationCount, 2);
  assert.equal(host.track.name, "Renamed");
  assert.equal(host.slot.clip?.name, "Alternative");
  assert.equal(other.slot.clip, null);
  assert.deepEqual(other.writes, []);
});

test("omitted and false requireEmpty preserve replacement, update, and idempotent reuse", async () => {
  for (const requireEmpty of [undefined, false]) {
    for (const duration of [4, 8]) {
      const host = sessionHost();
      const occupant = host.midiClip("occupant", { name: "Old", duration });
      Reflect.set(host.slot, "clip", occupant);
      const { requireEmpty: _requireEmpty, ...action } = candidateAction();
      const plan: AgentPlan = {
        message: "Create or replace",
        actions: [{ ...action, ...(requireEmpty === undefined ? {} : { requireEmpty }) }],
      };

      const result = await executeAgentPlanWithProgress(host.context, plan, {});
      assert.equal(result.mutationCount, 1);
      assert.equal(host.slot.clip?.name, "Alternative");
      assert.deepEqual((host.slot.clip as MidiClip<"1.0.0">).notes, action.notes);
      assert.deepEqual(host.writes, duration === 4
        ? ["occupant:name", "occupant:notes"]
        : ["slot-1:delete", "slot-1:create:4", "slot-1-created:name", "slot-1-created:notes"]);
      host.writes.length = 0;
      const repeated = await executeAgentPlanWithProgress(host.context, plan, {});
      assert.equal(repeated.mutationCount, 0);
      assert.deepEqual(host.writes, []);
    }
  }
});

test("failed candidate creation before the SDK returns records no completed mutation", async () => {
  const host = sessionHost();
  Reflect.set(host.slot, "createMidiClip", async () => { throw new Error("Creation rejected"); });

  await assert.rejects(
    executeAgentPlanWithProgress(host.context, candidatePlan(), {}),
    noWriteFailure(/Creation rejected/),
  );
  assert.equal(host.slot.clip, null);
  assert.deepEqual(host.writes, []);
});

test("candidate partial outcomes retain creation and configuration steps without marking the action complete", async () => {
  for (const failure of ["name", "notes"] as const) {
    const host = sessionHost({ failCreatedWrite: failure });
    const plan = candidatePlan();

    await assert.rejects(
      executeAgentPlanWithProgress(host.context, plan, {}),
      (error: unknown) => {
        assert.ok(error instanceof AgentPlanExecutionError);
        assert.equal(error.failedActionIndex, 0);
        assert.equal(error.failedAction, plan.actions[0]);
        assert.equal(error.completedActionCount, 0);
        assert.equal(error.completedMutationCount, failure === "name" ? 1 : 2);
        assert.equal(error.completedResults.length, failure === "name" ? 1 : 2);
        assert.match(error.completedResults[0]!, /Created Session MIDI clip.*slot 0.*Lead/);
        assert.ok(error.completedActionKeys.flat().every((key) => key.startsWith("live-action-step:clip:")));
        assert.match(error.message, new RegExp(`Created ${failure} write rejected`));
        return true;
      },
    );
    const created = host.slot.clip as MidiClip<"1.0.0">;
    assert.ok(created instanceof MidiClip);
    assert.equal(created.name, failure === "name" ? "Untitled" : "Alternative");
    assert.deepEqual(created.notes, []);
    const writesBeforeRetry = [...host.writes];
    await assert.rejects(
      executeAgentPlanWithProgress(host.context, plan, {}),
      noWriteFailure(/Session slot 0.*must be empty/i),
    );
    assert.deepEqual(host.writes, writesBeforeRetry);
    assert.equal(host.slot.clip, created);
  }
});

function candidateAction(): Extract<AgentAction, { type: "create_session_midi_clip" }> {
  return {
    type: "create_session_midi_clip",
    trackName: "Lead",
    slotIndex: 0,
    durationBeats: 4,
    name: "Alternative",
    requireEmpty: true,
    notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 96, probability: 0.5 }],
  };
}

function candidatePlan(): AgentPlan {
  const { trackName: _trackName, ...action } = candidateAction();
  return {
    message: "Write a candidate into the observed empty slot",
    targets: { destination: { trackName: "Lead" } },
    actions: [{ ...action, trackRef: "destination" }],
  };
}

async function candidateGuard(host: ReturnType<typeof sessionHost>, plan = candidatePlan()) {
  return preflightAgentPlan(
    host.context,
    { target: {} } as never,
    plan,
    new AbortController().signal,
    async () => "Observed Session slot",
  );
}

function noWriteFailure(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AgentPlanExecutionError);
    assert.match(error.message, pattern);
    assert.equal(error.completedMutationCount, 0);
    assert.equal(error.completedActionCount, 0);
    assert.deepEqual(error.completedResults, []);
    assert.deepEqual(error.completedActionKeys, []);
    return true;
  };
}

function sessionHost(options: { failCreatedWrite?: "name" | "notes" } = {}) {
  const writes: string[] = [];
  function midiClip(id: string, values: { name?: string; duration?: number; notes?: NoteDescription[] } = {}) {
    let name = values.name ?? "Alternative";
    let notes = values.notes ?? [];
    const clip = sdkObject<MidiClip<"1.0.0">>(MidiClip.prototype, {
      handle: { id }, startTime: 0, duration: values.duration ?? 4,
      startMarker: 0, endMarker: 4, looping: false, loopStart: 0, loopEnd: 4,
      color: 0, muted: false,
    });
    Object.defineProperties(clip, {
      name: {
        get: () => name,
        set: (value: string) => {
          if (id.endsWith("-created") && options.failCreatedWrite === "name") {
            throw new Error("Created name write rejected");
          }
          writes.push(`${id}:name`);
          name = value;
        },
      },
      notes: {
        get: () => notes,
        set: (value: NoteDescription[]) => {
          if (id.endsWith("-created") && options.failCreatedWrite === "notes") {
            throw new Error("Created notes write rejected");
          }
          writes.push(`${id}:notes`);
          notes = value;
        },
      },
    });
    return clip;
  }
  function makeSlot(id: string) {
    let clip: Clip<"1.0.0"> | null = null;
    const slot = sdkObject<ClipSlot<"1.0.0">>(ClipSlot.prototype, {
      handle: { id },
      deleteClip: async () => { writes.push(`${id}:delete`); clip = null; },
      createMidiClip: async (duration: number) => {
        writes.push(`${id}:create:${duration}`);
        clip = midiClip(`${id}-created`, { name: "Untitled", duration });
        return clip;
      },
    });
    Object.defineProperty(slot, "clip", {
      get: () => clip,
      set: (value: Clip<"1.0.0"> | null) => { clip = value; },
    });
    return slot;
  }
  const slot = makeSlot("slot-1");
  const source = midiClip("source", {
    name: "Original",
    notes: [{ pitch: 48, startTime: 0, duration: 2, velocity: 90 }],
  });
  const track = sdkObject<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    handle: { id: "track-1" }, name: "Lead", devices: [],
    clipSlots: [slot], arrangementClips: [source], takeLanes: [],
  });
  const context = {
    application: { song: { handle: { id: "song-1" }, tracks: [track] } },
  } as unknown as ExtensionContext<"1.0.0">;
  return { context, track, slot, source, writes, makeSlot, midiClip };
}

function sdkObject<Value>(prototype: object, values: Record<string, unknown>): Value {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, {
      configurable: true, enumerable: true, writable: true, value,
    }]),
  )) as Value;
}
