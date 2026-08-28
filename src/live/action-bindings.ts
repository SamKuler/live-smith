import {
  AudioClip,
  Device,
  MidiClip,
  MidiTrack,
  RackDevice,
  Simpler,
  type Chain,
  type Clip,
  type ClipSlot,
  type CuePoint,
  type DeviceParameter,
  type ExtensionContext,
  type Scene,
  type TakeLane,
  type Track,
} from "@ableton-extensions/sdk";

import {
  supportsNonRegularTrackAction,
  type AgentAction,
  type AgentPlan,
} from "../agent/actions.js";
import { agentActionJsonSchemas } from "../agent/action-schema.js";
import {
  resolveDevicePath,
  resolveDeviceTarget,
  resolveRackChainTarget,
  resolveRackDeviceTarget,
  type ResolvedDeviceTarget,
} from "./device-tree.js";
import {
  affectedTrackTree,
  findReusableMidiClip,
  resolveArrangementClip,
  resolveClipLocator,
  resolveCuePoint,
  resolveScene,
  resolveSessionClip,
  resolveTakeLane,
  resolveMidiTrack,
  resolveTrackSelector,
  resolveChainMixerParameter,
  resolveTrackMixerParameter,
  resolveTrack,
  songTrackEntryForTrack,
} from "./resolve.js";
import {
  resolveSampleSource,
  type RequestAudioSampleSources,
  type ResolvedSampleSource,
} from "./sample-source.js";
import { findTrackAncestor, type LiveTarget } from "./target.js";

type Api = ExtensionContext<"1.0.0">;

const trackTargetActionTypes = new Set(
  agentActionJsonSchemas().flatMap((schema) => {
    const properties = schema.properties as {
      type: { enum: AgentAction["type"][] };
      trackName?: unknown;
      trackRef?: unknown;
    };
    return "trackName" in properties || "trackRef" in properties
      ? properties.type.enum
      : [];
  }),
);

/** Host-object bindings created by preflight and consumed only by execution. */
export interface AgentPlanBindings {
  readonly tracks: ReadonlyMap<string, Track<"1.0.0">>;
  readonly actionTracks: ReadonlyMap<number, Track<"1.0.0">>;
  readonly actionObjects: ReadonlyMap<number, BoundActionObjects>;
}

/** Existing non-Track host objects resolved before a plan starts mutating Live. */
export interface BoundActionObjects {
  readonly scene?: Scene<"1.0.0">;
  readonly cuePoint?: CuePoint<"1.0.0">;
  readonly deviceTarget?: ResolvedDeviceTarget;
  readonly secondaryDeviceTarget?: ResolvedDeviceTarget;
  readonly chain?: Chain<"1.0.0">;
  readonly clip?: Clip<"1.0.0">;
  readonly slot?: ClipSlot<"1.0.0">;
  readonly takeLane?: TakeLane<"1.0.0">;
  readonly mixerParameter?: DeviceParameter<"1.0.0">;
  readonly sampleSource?: ResolvedSampleSource;
}

export type NonRegularTrackIdentity =
  | { role: "return" }
  | { role: "main" };

export function bindAgentPlanTargets(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget = {},
  requestAudioSources?: RequestAudioSampleSources,
): AgentPlanBindings {
  const tracks = new Map<string, Track<"1.0.0">>();
  for (const [ref, target] of Object.entries(plan.targets ?? {})) {
    tracks.set(ref, resolveTrackSelector(context, target, {}));
  }
  const actionTracks = new Map<number, Track<"1.0.0">>();
  plan.actions.forEach((action, index) => {
    if (!hasTrackTarget(action)) return;
    if (action.trackRef) {
      const track = tracks.get(action.trackRef);
      if (track) {
        assertActionTrackRole(context, action, track);
        actionTracks.set(index, track);
      }
      return;
    }
    const track = requiresMidiTrack(action)
      ? resolveMidiTrack(context, action.trackName, target)
      : resolveTrack(context, action.trackName, target);
    assertActionTrackRole(context, action, track);
    actionTracks.set(index, track);
  });
  const actionObjects = bindActionObjects(
    context,
    plan,
    target,
    tracks,
    actionTracks,
    requestAudioSources,
  );
  assertStructuralActionDependenciesAreStable(
    context,
    plan,
    target,
    tracks,
    actionTracks,
    actionObjects,
  );
  assertMainArrangementCreationRangesDoNotOverlap(
    plan,
    tracks,
    actionTracks,
    actionObjects,
  );
  assertDrumPadFillsAreDistinct(plan, actionObjects);
  assertRackChainCreationsAreDistinct(plan, actionObjects);
  assertTakeLaneCreationRangesDoNotOverlap(plan, actionObjects);
  return { tracks, actionTracks, actionObjects };
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
  if (before.actionObjects.size !== after.actionObjects.size) {
    throw new Error("The set of action-bound Live objects changed.");
  }
  for (const [index, previousObjects] of before.actionObjects) {
    const currentObjects = after.actionObjects.get(index);
    if (
      !currentObjects ||
      JSON.stringify(boundObjectIdentity(currentObjects)) !==
        JSON.stringify(boundObjectIdentity(previousObjects))
    ) {
      throw new Error(`Live object bound to action ${index + 1} changed.`);
    }
  }
}

export function boundTrackForAction(
  action: AgentAction,
  actionIndex: number,
  bindings: AgentPlanBindings,
): Track<"1.0.0"> | undefined {
  return boundTrackFromMaps(
    action,
    actionIndex,
    bindings.tracks,
    bindings.actionTracks,
  );
}

function boundTrackFromMaps(
  action: AgentAction,
  actionIndex: number,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): Track<"1.0.0"> | undefined {
  if ("trackRef" in action && action.trackRef) {
    return tracks.get(action.trackRef);
  }
  return actionTracks.get(actionIndex);
}

export function liveActionIdentityKeys(
  action: AgentAction,
  track?: Track<"1.0.0">,
  trackAliases: readonly string[] = [],
  nonRegularTrack?: NonRegularTrackIdentity,
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
  if (action.type === "create_midi_track" || action.type === "create_audio_track") {
    targets.add("song-or-creator");
  }
  const handleId = (track as { handle?: { id?: unknown } } | undefined)?.handle?.id;
  if (nonRegularTrack) {
    if (!track || handleId === undefined || handleId === null) {
      throw new Error(
        `Could not identify the ${nonRegularTrack.role === "return" ? "Return" : "Main"} track for replay protection.`,
      );
    }
    targets.add(`track-role:${nonRegularTrack.role}:handle:${String(handleId)}`);
    if (nonRegularTrack.role === "main") {
      targets.add("track-role:main");
    } else {
      targets.add(
        `track-role:return:name:${normalizeIdentityText(track.name)}`,
      );
    }
  } else {
    if (handleId !== undefined && handleId !== null) {
      targets.add(`track-handle:${String(handleId)}`);
    }
    if (track?.name) targets.add(`track-name:${normalizeIdentityText(track.name)}`);
    for (const alias of trackAliases) {
      if (alias) targets.add(`track-name:${normalizeIdentityText(alias)}`);
    }
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
  return hostObjectHandleId(track, `Live track "${track.name}"`);
}

function hostObjectHandleId(
  value: { handle?: { id?: unknown } },
  label: string,
): string {
  const id = value.handle?.id;
  if (id === undefined || id === null) {
    throw new Error(`Could not verify ${label} handle identity.`);
  }
  return String(id);
}

function hasTrackTarget(
  action: AgentAction,
): action is AgentAction & { trackName?: string; trackRef?: string } {
  return trackTargetActionTypes.has(action.type);
}

function requiresMidiTrack(action: AgentAction): boolean {
  return action.type === "create_midi_clip" ||
    action.type === "create_session_midi_clip" ||
    action.type === "replace_midi_clip_segment" ||
    action.type === "transpose_midi_notes" ||
    action.type === "quantize_midi_notes" ||
    action.type === "scale_midi_velocity" ||
    action.type === "shift_midi_notes";
}

function assertActionTrackRole(
  context: Api,
  action: AgentAction,
  track: Track<"1.0.0">,
): void {
  const entry = songTrackEntryForTrack(context.application.song, track);
  if (!entry) {
    throw new Error(`Could not verify the role of track "${track.name}".`);
  }
  if (entry.role === "regular") return;
  const role = entry.role === "return"
    ? `Return track index ${entry.index}`
    : "Main track";
  if (!("trackRef" in action) || !action.trackRef) {
    throw new Error(
      `${role} "${track.name}" requires an explicit role target in plan.targets and trackRef on the action.`,
    );
  }
  if (supportsNonRegularTrackAction(action)) return;
  throw new Error(
    `${role} "${track.name}" does not support action ${action.type}. Return and Main tracks support only device-chain actions and Track or Rack Chain mixer parameters.`,
  );
}

function bindActionObjects(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
  requestAudioSources: RequestAudioSampleSources | undefined,
): ReadonlyMap<number, BoundActionObjects> {
  const result = new Map<number, BoundActionObjects>();
  plan.actions.forEach((action, index) => {
    const binding: WritableBoundActionObjects = {};
    if (hasSampleSource(action)) {
      binding.sampleSource = resolveSampleSource(
        context,
        action.source,
        target,
        requestAudioSources,
      );
    }

    const track = boundTrackFromMaps(action, index, tracks, actionTracks);
    switch (action.type) {
      case "rename_scene":
      case "duplicate_scene":
      case "delete_scene":
        binding.scene = resolveScene(
          context.application.song,
          action.sceneIndex,
          action.sceneName,
        );
        break;
      case "rename_cue_point":
      case "delete_cue_point":
        binding.cuePoint = resolveCuePoint(
          context.application.song,
          action.timeBeat,
          action.cueName,
        );
        break;
      case "create_midi_clip":
        if (track instanceof MidiTrack) {
          const lane = action.laneIndex === undefined
            ? undefined
            : resolveTakeLane(track, action.laneIndex, action.laneName);
          if (lane) binding.takeLane = lane;
          if (action.name) {
            const clip = findReusableMidiClip(
              lane?.clips ?? track.arrangementClips,
              action.name,
              action.startBeat,
              action.durationBeats,
            );
            if (clip) binding.clip = clip;
          }
        }
        break;
      case "create_arrangement_audio_clip":
        if (track && action.laneIndex !== undefined) {
          binding.takeLane = resolveTakeLane(
            track,
            action.laneIndex,
            action.laneName,
          );
        }
        break;
      case "create_session_midi_clip":
      case "create_session_audio_clip":
        if (track) binding.slot = sessionSlot(track, action.slotIndex);
        break;
      case "replace_midi_clip_segment":
        if (track) {
          binding.clip = resolveArrangementClip(
            track,
            action.startBeat,
            action.clipName,
          );
        }
        break;
      case "transpose_midi_notes":
      case "quantize_midi_notes":
      case "scale_midi_velocity":
      case "shift_midi_notes":
        if (track) binding.clip = resolveClipLocator(track, action);
        break;
      case "insert_chain_device":
        if (track) {
          const resolved = resolveRackChainTarget(
            track,
            target,
            action.rackName,
            action.rackPath,
            action.chainIndex,
          );
          binding.deviceTarget = resolved.rackTarget;
          binding.chain = resolved.chain;
        }
        break;
      case "create_rack_chain":
        if (track) {
          binding.deviceTarget = resolveRackDeviceTarget(
            track,
            target,
            action.rackName,
            action.rackPath,
          );
        }
        break;
      case "set_device_parameter":
      case "duplicate_device":
      case "delete_device":
        if (track) {
          binding.deviceTarget = resolveDeviceTarget(
            track,
            target,
            action.deviceName,
            action.devicePath,
            action.deviceIndex,
          );
        }
        break;
      case "replace_simpler_sample":
        if (track) {
          binding.deviceTarget = resolveDeviceTarget(
            track,
            target,
            action.simplerName,
            action.simplerPath,
          );
        }
        break;
      case "configure_drum_pad":
        if (track) {
          binding.deviceTarget = resolveDeviceTarget(
            track,
            target,
            action.rackName,
            action.rackPath,
          );
          if (action.simplerPath) {
            binding.secondaryDeviceTarget = resolveDevicePath(
              track,
              action.simplerPath,
            );
          }
        }
        break;
      case "set_track_mixer_parameter":
        if (track) {
          binding.mixerParameter = resolveTrackMixerParameter(
            track,
            action.parameter,
            action.sendIndex,
          );
        }
        break;
      case "set_chain_mixer_parameter":
        if (track) {
          const resolved = resolveRackChainTarget(
            track,
            target,
            action.rackName,
            action.rackPath,
            action.chainIndex,
          );
          binding.deviceTarget = resolved.rackTarget;
          binding.chain = resolved.chain;
          binding.mixerParameter = resolveChainMixerParameter(
            resolved.chain,
            action.parameter,
            action.sendIndex,
          );
        }
        break;
      case "rename_take_lane":
        if (track) {
          binding.takeLane = resolveTakeLane(
            track,
            action.laneIndex,
            action.laneName,
          );
        }
        break;
      case "set_clip_properties":
      case "set_audio_clip_warp":
        if (track) binding.clip = resolveClipLocator(track, action);
        break;
      case "delete_clip":
        if (track) {
          binding.clip = resolveArrangementClip(
            track,
            action.startBeat,
            action.clipName,
          );
        }
        break;
      case "delete_session_clip":
        if (track) {
          binding.slot = sessionSlot(track, action.slotIndex);
          binding.clip = resolveSessionClip(
            track,
            action.slotIndex,
            action.clipName,
          );
        }
        break;
    }

    if (Object.values(binding).some((value) => value !== undefined)) {
      result.set(index, binding);
    }
  });
  return result;
}

function assertTakeLaneCreationRangesDoNotOverlap(
  plan: AgentPlan,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): void {
  const ranges = new Map<
    string,
    Array<{ actionNumber: number; start: number; end: number }>
  >();
  const tolerance = 1e-7;
  plan.actions.forEach((action, index) => {
    if (
      (action.type !== "create_midi_clip" &&
        action.type !== "create_arrangement_audio_clip") ||
      action.laneIndex === undefined
    ) return;
    if (action.durationBeats === undefined) {
      throw new Error("Take Lane Clip creation requires a known duration.");
    }
    const lane = actionObjects.get(index)?.takeLane;
    if (!lane) throw new Error(`Could not bind Take Lane for action ${index + 1}.`);
    const key = hostObjectHandleId(lane, "Take Lane");
    const start = action.startBeat;
    const end = start + action.durationBeats;
    const previous = ranges.get(key) ?? [];
    const overlap = previous.find(
      (range) => start < range.end - tolerance && range.start < end - tolerance,
    );
    if (overlap) {
      throw new Error(
        `Actions ${overlap.actionNumber} and ${index + 1} create overlapping Clip ranges in the same Take Lane. Use non-overlapping ranges or separate confirmed stages.`,
      );
    }
    previous.push({ actionNumber: index + 1, start, end });
    ranges.set(key, previous);
  });
}

function assertRackChainCreationsAreDistinct(
  plan: AgentPlan,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): void {
  const seen = new Map<string, number>();
  plan.actions.forEach((action, index) => {
    if (action.type !== "create_rack_chain") return;
    const rack = actionObjects.get(index)?.deviceTarget?.device;
    if (!rack) throw new Error(`Could not bind the Rack for action ${index + 1}.`);
    const key = hostObjectHandleId(rack, "Rack device");
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `Actions ${prior + 1} and ${index + 1} create a Chain in the same Rack. Use one create_rack_chain per confirmed stage so partial recovery can identify it unambiguously.`,
      );
    }
    seen.set(key, index);
  });
}

function assertDrumPadFillsAreDistinct(
  plan: AgentPlan,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): void {
  const seen = new Map<string, number>();
  plan.actions.forEach((action, index) => {
    if (
      action.type !== "configure_drum_pad" ||
      action.mode !== "fill_empty_pad"
    ) return;
    const rack = actionObjects.get(index)?.deviceTarget?.device;
    if (!rack) throw new Error(`Could not bind the Drum Rack for action ${index + 1}.`);
    const key = JSON.stringify([
      hostObjectHandleId(rack, "Drum Rack"),
      action.receivingNote,
    ]);
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `Actions ${prior + 1} and ${index + 1} both fill MIDI note ${action.receivingNote} in the same Drum Rack. Use one fill_empty_pad action for that pad, then inspect it before further changes.`,
      );
    }
    seen.set(key, index);
  });
}

function assertMainArrangementCreationRangesDoNotOverlap(
  plan: AgentPlan,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): void {
  const candidates = plan.actions.filter((action) =>
    (action.type === "create_midi_clip" ||
      action.type === "create_arrangement_audio_clip") &&
    action.laneIndex === undefined
  );
  if (candidates.length < 2) return;
  const ranges = new Map<
    string,
    Array<{ actionNumber: number; start: number; end: number; creates: boolean }>
  >();
  const tolerance = 1e-7;
  plan.actions.forEach((action, index) => {
    if (
      (action.type !== "create_midi_clip" &&
        action.type !== "create_arrangement_audio_clip") ||
      action.laneIndex !== undefined
    ) return;
    const track = boundTrackFromMaps(action, index, tracks, actionTracks);
    const key = track
      ? `track:${hostObjectHandleId(track, "Track")}`
      : action.trackRef
        ? `creator-ref:${action.trackRef}`
        : undefined;
    if (!key) return;
    const current = {
      actionNumber: index + 1,
      start: action.startBeat,
      end: action.durationBeats === undefined
        ? Number.POSITIVE_INFINITY
        : action.startBeat + action.durationBeats,
      creates: action.type === "create_arrangement_audio_clip" ||
        actionObjects.get(index)?.clip === undefined,
    };
    const previous = ranges.get(key) ?? [];
    const overlap = previous.find((range) =>
      current.start < range.end - tolerance &&
      range.start < current.end - tolerance &&
      (current.creates || range.creates)
    );
    if (overlap) {
      throw new Error(
        `Actions ${overlap.actionNumber} and ${current.actionNumber} create overlapping Clips in the same main Arrangement lane. Use non-overlapping ranges or separate confirmed stages.`,
      );
    }
    previous.push(current);
    ranges.set(key, previous);
  });
}

interface BoundObjectDependency {
  readonly object: { handle?: { id?: unknown } };
  readonly label: string;
}

function assertStructuralActionDependenciesAreStable(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): void {
  const invalidated = new Map<string, number>();

  plan.actions.forEach((action, index) => {
    const actionTrack = boundTrackFromMaps(action, index, tracks, actionTracks);
    const binding = actionObjects.get(index);
    if (invalidated.size > 0) {
      const dependencies = boundObjectDependencies(
        context,
        action,
        actionTrack,
        binding,
        target,
      );
      for (const dependency of dependencies) {
        const id = hostObjectHandleId(dependency.object, dependency.label);
        const priorActionNumber = invalidated.get(id);
        if (priorActionNumber === undefined) continue;
        throw new Error(
          `Action ${index + 1} depends on ${dependency.label}, which was invalidated by action ${priorActionNumber}. Inspect the resulting Live object and use a separate confirmed stage.`,
        );
      }
    }

    if (index === plan.actions.length - 1) return;
    for (const object of structurallyInvalidatedObjects(
      context,
      action,
      actionTrack,
      binding,
    )) {
      const id = hostObjectHandleId(object, "structurally affected Live object");
      if (!invalidated.has(id)) {
        invalidated.set(id, index + 1);
      }
    }
  });
}

function boundObjectDependencies(
  context: Api,
  action: AgentAction,
  actionTrack: Track<"1.0.0"> | undefined,
  binding: BoundActionObjects | undefined,
  target: LiveTarget,
): BoundObjectDependency[] {
  const result: BoundObjectDependency[] = [];
  const add = (
    object: { handle?: { id?: unknown } } | null | undefined,
    label: string,
  ) => {
    if (object) result.push({ object, label });
  };
  add(actionTrack, actionTrack ? `Track "${actionTrack.name}"` : "Track");
  add(binding?.scene, "Scene");
  add(binding?.cuePoint, "Cue Point");
  add(binding?.deviceTarget?.device, binding?.deviceTarget
    ? `Device "${binding.deviceTarget.device.name}"`
    : "Device");
  add(binding?.secondaryDeviceTarget?.device, binding?.secondaryDeviceTarget
    ? `Device "${binding.secondaryDeviceTarget.device.name}"`
    : "Device");
  add(binding?.chain, "Rack Chain");
  const sessionClip = "slotIndex" in action && action.slotIndex !== undefined;
  add(binding?.clip, sessionClip ? "Session Clip" : "Arrangement Clip");
  add(binding?.slot, "Session slot content");
  add(binding?.takeLane, "Take Lane");
  add(binding?.mixerParameter, "mixer parameter");
  if (binding?.sampleSource?.kind === "live") {
    add(binding.sampleSource.object, "Live sample source");
    const sourceTrack = liveSampleSourceTrack(context, action, binding, target);
    add(sourceTrack, sourceTrack ? `Track "${sourceTrack.name}"` : "Track");
  }
  return result;
}

function liveSampleSourceTrack(
  context: Api,
  action: AgentAction,
  binding: BoundActionObjects,
  target: LiveTarget,
): Track<"1.0.0"> | undefined {
  const source = binding.sampleSource;
  if (source?.kind !== "live") return undefined;
  try {
    const ancestor = findTrackAncestor(source.object);
    if (ancestor) return ancestor;
  } catch {
    // Exact named and invocation targets remain available as fallbacks.
  }
  if (hasSampleSource(action) && "trackName" in action.source) {
    return resolveTrack(context, action.source.trackName, {});
  }
  return target.track;
}

function structurallyInvalidatedObjects(
  context: Api,
  action: AgentAction,
  actionTrack: Track<"1.0.0"> | undefined,
  binding: BoundActionObjects | undefined,
): Array<{ handle?: { id?: unknown } }> {
  switch (action.type) {
    case "delete_track":
      return actionTrack
        ? affectedTrackTree(context, actionTrack)
        : [];
    case "delete_device":
      return binding?.deviceTarget?.device
        ? deviceObjectTree(binding.deviceTarget.device)
        : [];
    case "replace_simpler_sample":
      return replacedSimplerSample(
        binding?.deviceTarget?.device,
        binding?.sampleSource,
      );
    case "configure_drum_pad":
      return action.mode === "replace_existing_simpler"
        ? replacedSimplerSample(
            binding?.secondaryDeviceTarget?.device,
            binding?.sampleSource,
          )
        : [];
    case "delete_cue_point":
      return binding?.cuePoint ? [binding.cuePoint] : [];
    case "delete_clip":
      return binding?.clip ? [binding.clip] : [];
    case "create_midi_clip":
    case "create_arrangement_audio_clip":
      return arrangementCreationInvalidatedClips(action, actionTrack, binding);
    case "clear_arrangement_range":
      return actionTrack?.arrangementClips.filter((clip) =>
        clip.startTime < action.endBeat &&
        clip.startTime + clip.duration > action.startBeat
      ) ?? [];
    case "delete_session_clip":
    case "create_session_midi_clip":
    case "create_session_audio_clip": {
      if (!boundActionReplacesSessionSlotClip(action, binding) || !binding?.slot) {
        return [];
      }
      return [binding.slot, ...(binding.slot.clip ? [binding.slot.clip] : [])];
    }
    default:
      return [];
  }
}

function arrangementCreationInvalidatedClips(
  action: Extract<
    AgentAction,
    { type: "create_midi_clip" | "create_arrangement_audio_clip" }
  >,
  track: Track<"1.0.0"> | undefined,
  binding: BoundActionObjects | undefined,
): Clip<"1.0.0">[] {
  if (!track || action.laneIndex !== undefined) return [];
  if (action.type === "create_midi_clip" && binding?.clip) return [];
  const end = action.durationBeats === undefined
    ? Number.POSITIVE_INFINITY
    : action.startBeat + action.durationBeats;
  return track.arrangementClips.filter((clip) =>
    clip.startTime < end &&
    clip.startTime + clip.duration > action.startBeat
  );
}

function replacedSimplerSample(
  device: Device<"1.0.0"> | undefined,
  source: ResolvedSampleSource | undefined,
): Array<{ handle?: { id?: unknown } }> {
  if (!(device instanceof Simpler) || !source) return [];
  const sample = device.sample;
  if (!sample) return [];
  if (source.kind === "live" && sample.filePath === source.filePath) {
    return [];
  }
  return [sample];
}

function deviceObjectTree(device: Device<"1.0.0">): Array<{ handle?: { id?: unknown } }> {
  return [
    device,
    ...(device instanceof Simpler && device.sample ? [device.sample] : []),
    ...(device instanceof RackDevice
      ? device.chains.flatMap((chain) => chain.devices.flatMap(deviceObjectTree))
      : []),
  ];
}

function boundActionReplacesSessionSlotClip(
  action: AgentAction,
  binding: BoundActionObjects | undefined,
): boolean {
  if (action.type === "delete_session_clip") return true;
  if (action.type === "create_session_midi_clip") {
    return !sessionMidiClipCanBeReused(
      binding?.slot?.clip,
      action.durationBeats,
    );
  }
  if (action.type === "create_session_audio_clip") {
    const source = binding?.sampleSource;
    return source?.kind !== "live" || !sessionAudioClipCanBeReused(
      binding?.slot?.clip,
      source.filePath,
      action.isWarped,
      action.loopSettings,
    );
  }
  return false;
}

export function sessionMidiClipCanBeReused(
  clip: Clip<"1.0.0"> | null | undefined,
  durationBeats: number,
): clip is MidiClip<"1.0.0"> {
  return clip instanceof MidiClip && Math.abs(clip.duration - durationBeats) < 0.0001;
}

export function sessionAudioClipCanBeReused(
  clip: Clip<"1.0.0"> | null | undefined,
  filePath: string,
  isWarped: boolean | undefined,
  settings: Extract<
    AgentAction,
    { type: "create_session_audio_clip" }
  >["loopSettings"],
): clip is AudioClip<"1.0.0"> {
  if (!(clip instanceof AudioClip) || clip.filePath !== filePath) return false;
  if (isWarped !== undefined && clip.warping !== isWarped) return false;
  if (!settings) return true;
  return clip.looping === settings.looping &&
    clip.startMarker === settings.startMarker &&
    clip.endMarker === settings.endMarker &&
    clip.loopStart === settings.loopStart &&
    clip.loopEnd === settings.loopEnd;
}

type WritableBoundActionObjects = {
  -readonly [Key in keyof BoundActionObjects]?: BoundActionObjects[Key];
};

function sessionSlot(
  track: Track<"1.0.0">,
  slotIndex: number,
): ClipSlot<"1.0.0"> {
  const slot = track.clipSlots[slotIndex];
  if (!slot) {
    throw new Error(
      `Could not find Session slot ${slotIndex} on track "${track.name}".`,
    );
  }
  return slot;
}

function hasSampleSource(
  action: AgentAction,
): action is AgentAction & { source: import("../agent/action-schema.js").SampleSource } {
  return "source" in action;
}

function boundObjectIdentity(binding: BoundActionObjects): Record<string, unknown> {
  return {
    ...(binding.scene
      ? { scene: hostObjectHandleId(binding.scene, "Scene") }
      : {}),
    ...(binding.cuePoint
      ? { cuePoint: hostObjectHandleId(binding.cuePoint, "Cue Point") }
      : {}),
    ...(binding.deviceTarget
      ? { deviceTarget: deviceTargetIdentity(binding.deviceTarget) }
      : {}),
    ...(binding.secondaryDeviceTarget
      ? { secondaryDeviceTarget: deviceTargetIdentity(binding.secondaryDeviceTarget) }
      : {}),
    ...(binding.chain
      ? { chain: hostObjectHandleId(binding.chain, "Rack Chain") }
      : {}),
    ...(binding.clip
      ? { clip: hostObjectHandleId(binding.clip, "Clip") }
      : {}),
    ...(binding.slot
      ? { slot: hostObjectHandleId(binding.slot, "Clip slot") }
      : {}),
    ...(binding.takeLane
      ? { takeLane: hostObjectHandleId(binding.takeLane, "Take Lane") }
      : {}),
    ...(binding.mixerParameter
      ? {
          mixerParameter: hostObjectHandleId(
            binding.mixerParameter,
            "mixer parameter",
          ),
        }
      : {}),
    ...(binding.sampleSource
      ? {
          sampleSource: binding.sampleSource.identity,
        }
      : {}),
  };
}

function deviceTargetIdentity(target: ResolvedDeviceTarget): Record<string, unknown> {
  return {
    device: hostObjectHandleId(target.device, "Device"),
    parent: hostObjectHandleId(target.parent, "Device parent"),
    path: target.path,
  };
}
