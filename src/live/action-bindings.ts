import {
  AudioTrack,
  MidiTrack,
  type ExtensionContext,
  type Track,
} from "@ableton-extensions/sdk";

import type { AgentAction, AgentPlan } from "../agent/actions.js";
import { equalsLoose, resolveTrack } from "./resolve.js";
import type { LiveTarget } from "./target.js";

type Api = ExtensionContext<"1.0.0">;

/** Host-object bindings created by preflight and consumed only by execution. */
export interface AgentPlanBindings {
  readonly tracks: ReadonlyMap<string, Track<"1.0.0">>;
  readonly actionTracks: ReadonlyMap<number, Track<"1.0.0">>;
}

export function bindAgentPlanTargets(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget = {},
): AgentPlanBindings {
  const tracks = new Map<string, Track<"1.0.0">>();
  for (const [ref, target] of Object.entries(plan.targets ?? {})) {
    tracks.set(ref, resolveTrack(context, target.trackName, {}));
  }
  const actionTracks = new Map<number, Track<"1.0.0">>();
  plan.actions.forEach((action, index) => {
    const reusableTrack = reusableTrackForCreator(context, action);
    if (reusableTrack) {
      actionTracks.set(index, reusableTrack);
      if (
        (action.type === "create_midi_track" || action.type === "create_audio_track") &&
        action.ref
      ) {
        tracks.set(action.ref, reusableTrack);
      }
      return;
    }
    if (!hasTrackTarget(action)) return;
    if (action.trackRef) {
      const track = tracks.get(action.trackRef);
      if (track) actionTracks.set(index, track);
      return;
    }
    actionTracks.set(index, resolveTrack(context, action.trackName, target));
  });
  return { tracks, actionTracks };
}

function reusableTrackForCreator(
  context: Api,
  action: AgentAction,
): Track<"1.0.0"> | undefined {
  if (action.type === "create_midi_track") {
    const name = action.name;
    if (!name) return undefined;
    return context.application.song.tracks.find(
      (track) => track instanceof MidiTrack && equalsLoose(track.name, name),
    );
  }
  if (action.type === "create_audio_track") {
    const name = action.name;
    if (!name) return undefined;
    return context.application.song.tracks.find(
      (track) => track instanceof AudioTrack && equalsLoose(track.name, name),
    );
  }
  return undefined;
}

export function assertSameExistingPlanTargets(
  before: AgentPlanBindings,
  after: AgentPlanBindings,
): void {
  if (before.tracks.size !== after.tracks.size) {
    throw new Error("The set of bound Live tracks changed.");
  }
  for (const [ref, previousTrack] of before.tracks) {
    const currentTrack = after.tracks.get(ref);
    if (!currentTrack || trackHandleId(currentTrack) !== trackHandleId(previousTrack)) {
      throw new Error(`Live track bound to ref "${ref}" changed.`);
    }
  }
  if (before.actionTracks.size !== after.actionTracks.size) {
    throw new Error("The set of action-bound Live tracks changed.");
  }
  for (const [index, previousTrack] of before.actionTracks) {
    const currentTrack = after.actionTracks.get(index);
    if (!currentTrack || trackHandleId(currentTrack) !== trackHandleId(previousTrack)) {
      throw new Error(`Live track bound to action ${index + 1} changed.`);
    }
  }
}

export function boundTrackForAction(
  action: AgentAction,
  actionIndex: number,
  bindings: AgentPlanBindings,
): Track<"1.0.0"> | undefined {
  if ("trackRef" in action && action.trackRef) {
    return bindings.tracks.get(action.trackRef);
  }
  return bindings.actionTracks.get(actionIndex);
}

export function liveActionIdentityKeys(
  action: AgentAction,
  track?: Track<"1.0.0">,
  trackAliases: readonly string[] = [],
): string[] {
  const payload = { ...action } as Record<string, unknown>;
  delete payload.trackName;
  delete payload.trackRef;
  delete payload.ref;
  for (const field of [
    "deviceName",
    "rackName",
    "simplerName",
    "sceneName",
    "cueName",
    "laneName",
    "parameterName",
    "clipName",
    "name",
    "newName",
  ] as const) {
    if (typeof payload[field] === "string") {
      payload[field] = normalizeIdentityText(payload[field] as string);
    }
  }

  const targets = new Set<string>();
  const handleId = (track as { handle?: { id?: unknown } } | undefined)?.handle?.id;
  if (handleId !== undefined && handleId !== null) {
    targets.add(`track-handle:${String(handleId)}`);
  }
  if (track?.name) targets.add(`track-name:${normalizeIdentityText(track.name)}`);
  for (const alias of trackAliases) {
    if (alias) targets.add(`track-name:${normalizeIdentityText(alias)}`);
  }
  if (!targets.size) targets.add("song-or-creator");

  const serializedPayload = JSON.stringify(payload);
  return [...targets].map((target) => `live-action:${target}:${serializedPayload}`);
}

function normalizeIdentityText(value: string): string {
  return value.trim().toLowerCase();
}

export function requireBoundTrack(
  ref: string,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
): Track<"1.0.0"> {
  const track = tracks.get(ref);
  if (!track) {
    throw new Error(
      `Track ref "${ref}" is not bound. Use a targets entry or create the track earlier in this plan.`,
    );
  }
  return track;
}

function trackHandleId(track: Track<"1.0.0">): string {
  const id = (track as { handle?: { id?: unknown } }).handle?.id;
  if (id === undefined || id === null) {
    throw new Error(`Could not verify Live track "${track.name}" handle identity.`);
  }
  return String(id);
}

function hasTrackTarget(
  action: AgentAction,
): action is AgentAction & { trackName?: string; trackRef?: string } {
  return "trackName" in action || "trackRef" in action;
}
