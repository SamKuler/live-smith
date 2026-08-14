import {
  AudioClip,
  AudioTrack,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  RackDevice,
  Simpler,
  WarpMode,
  type Clip,
  type ClipSlot,
  type Track,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import {
  summarizeAgentAction,
  type AgentAction,
  type AgentPlan,
} from "../agent/actions.js";
import { throwIfAborted } from "../runtime/host.js";
import { findExactParameterMatch } from "./parameter-match.js";
import {
  devicePathLabel,
  resolveDevicePath,
  resolveDeviceTarget,
} from "./device-tree.js";
import {
  findReusableMidiClip,
  resolveArrangementClip,
  resolveClipLocator,
  resolveCuePoint,
  resolveMidiTrack,
  resolveScene,
  resolveSessionClip,
  resolveTakeLane,
  resolveTrackMixerParameter,
  resolveTrack,
} from "./resolve.js";
import { resolveSampleSource } from "./sample-source.js";
import type { LiveTarget } from "./target.js";
import { transformMidiNotes, type MidiTransform } from "./midi-transform.js";
import {
  bindAgentPlanTargets,
  liveActionIdentityKeys,
  requireBoundTrack,
  type AgentPlanBindings,
  type BoundActionObjects,
} from "./action-bindings.js";

type Api = ExtensionContext<"1.0.0">;

export interface AgentPlanExecutionOutcome {
  results: string[];
  mutationCount: number;
}

interface NoMutationActionOutcome {
  result: string;
  mutated: false;
}

export async function executeAgentPlan(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget,
  signal?: AbortSignal,
  initialBindings?: AgentPlanBindings,
): Promise<string[]> {
  return (await executeAgentPlanWithProgress(
    context,
    plan,
    target,
    signal,
    initialBindings,
  )).results;
}

export async function executeAgentPlanWithProgress(
  context: Api,
  plan: AgentPlan,
  target: LiveTarget,
  signal?: AbortSignal,
  initialBindings?: AgentPlanBindings,
): Promise<AgentPlanExecutionOutcome> {
  const bindings = initialBindings ?? bindAgentPlanTargets(context, plan, target);
  const results: string[] = [];
  let mutationCount = 0;
  const completedActionKeys: string[][] = [];
  const tracks = new Map(bindings.tracks);

  for (const [actionIndex, action] of plan.actions.entries()) {
    let identityTrack = trackForActionIdentity(
      context,
      action,
      actionIndex,
      target,
      tracks,
      bindings.actionTracks,
    );
    try {
      throwIfAborted(signal);
      const result = await executeAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        bindings.actionTracks,
        bindings.actionObjects,
      );
      results.push(typeof result === "string" ? result : result.result);
      if (typeof result === "string" ? true : result.mutated) mutationCount += 1;
      identityTrack ??= trackForActionIdentity(
        context,
        action,
        actionIndex,
        target,
        tracks,
        bindings.actionTracks,
      );
      completedActionKeys.push(liveActionIdentityKeys(action, identityTrack));
    } catch (error) {
      if (error instanceof AgentPlanExecutionError) {
        identityTrack ??= trackForActionIdentity(
          context,
          action,
          actionIndex,
          target,
          tracks,
          bindings.actionTracks,
        );
        const currentActionKeys = error.completedActionKeys.length
          ? error.completedActionKeys
          : error.completedResults.length
            ? [liveActionIdentityKeys(action, identityTrack)]
            : [];
        throw new AgentPlanExecutionError(
          [...results, ...error.completedResults],
          error.cause,
          error.failedActionIndex ?? actionIndex,
          error.failedAction ?? action,
          error.failedTrackName ?? failedTrackName(
            action,
            actionIndex,
            target,
            tracks,
            bindings.actionTracks,
          ),
          [...completedActionKeys, ...currentActionKeys],
          mutationCount + error.completedMutationCount,
        );
      }
      throw new AgentPlanExecutionError(
        results,
        error,
        actionIndex,
        action,
        failedTrackName(
          action,
          actionIndex,
          target,
          tracks,
          bindings.actionTracks,
        ),
        completedActionKeys,
        mutationCount,
      );
    }
  }

  return { results, mutationCount };
}

export class AgentPlanExecutionError extends Error {
  constructor(
    readonly completedResults: string[],
    readonly cause: unknown,
    readonly failedActionIndex?: number,
    readonly failedAction?: AgentAction,
    readonly failedTrackName?: string,
    readonly completedActionKeys: readonly (readonly string[])[] = [],
    readonly completedMutationCount: number = completedResults.length,
  ) {
    super([
      completedResults.length
        ? `Plan failed after ${completedResults.length} completed action(s).`
        : "Plan failed before completing any actions.",
      ...completedResults.map((result) => `Completed: ${result}`),
      failedActionIndex !== undefined && failedAction
        ? `Failed action ${failedActionIndex + 1}: ${summarizeAgentAction(failedAction)}`
        : "",
      errorMessage(cause),
    ].filter(Boolean).join(" "));
  }
}

function trackForActionIdentity(
  context: Api,
  action: AgentAction,
  actionIndex: number,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): Track<"1.0.0"> | undefined {
  try {
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      return tracks.get(action.ref) ?? actionTracks.get(actionIndex);
    }
    if ("trackRef" in action && action.trackRef) {
      return tracks.get(action.trackRef);
    }
    if ("trackName" in action) {
      return actionTracks.get(actionIndex) ??
        resolveTrack(context, action.trackName, target, false);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function failedTrackName(
  action: AgentAction,
  actionIndex: number,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): string | undefined {
  try {
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      return tracks.get(action.ref)?.name;
    }
    if ("trackRef" in action && action.trackRef) {
      return tracks.get(action.trackRef)?.name;
    }
    if ("trackName" in action) {
      return actionTracks.get(actionIndex)?.name ?? action.trackName ?? target.track?.name;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function executeAction(
  context: Api,
  action: AgentAction,
  actionIndex: number,
  target: LiveTarget,
  tracks: Map<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
  actionObjects: ReadonlyMap<number, BoundActionObjects>,
): Promise<string | NoMutationActionOutcome> {
  const bound = actionObjects.get(actionIndex);
  switch (action.type) {
    case "create_midi_track": {
      const track = await context.application.song.createMidiTrack();
      if (action.ref) tracks.set(action.ref, track);
      const createdName = safeObjectName(track, "unnamed MIDI track");
      if (action.name) {
        try {
          track.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [`Created MIDI track "${createdName}" without applying requested name "${action.name}".`],
            error,
          );
        }
      }
      return `Created MIDI track "${safeObjectName(track, createdName)}".`;
    }
    case "create_audio_track": {
      const track = await context.application.song.createAudioTrack();
      if (action.ref) tracks.set(action.ref, track);
      const createdName = safeObjectName(track, "unnamed audio track");
      if (action.name) {
        try {
          track.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [`Created audio track "${createdName}" without applying requested name "${action.name}".`],
            error,
          );
        }
      }
      return `Created audio track "${safeObjectName(track, createdName)}".`;
    }
    case "create_scene": {
      const scene = await context.application.song.createScene(action.index ?? -1);
      const createdName = safeObjectName(scene, "unnamed scene");
      if (action.name) {
        try {
          scene.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [`Created scene "${createdName}" without applying requested name "${action.name}".`],
            error,
          );
        }
      }
      return `Created scene "${safeObjectName(scene, createdName)}".`;
    }
    case "rename_scene": {
      const scene = bound?.scene ?? resolveScene(
        context.application.song,
        action.sceneIndex,
        action.sceneName,
      );
      const oldName = scene.name;
      if (oldName === action.newName) {
        return noMutation(
          `Kept Session View Scene ${action.sceneIndex} named "${oldName}" because it already matches.`,
        );
      }
      scene.name = action.newName;
      return `Renamed Scene ${action.sceneIndex} from "${oldName}" to "${scene.name}".`;
    }
    case "duplicate_scene": {
      const scene = bound?.scene ?? resolveScene(
        context.application.song,
        action.sceneIndex,
        action.sceneName,
      );
      const duplicate = await context.application.song.duplicateScene(scene);
      return `Duplicated Scene ${action.sceneIndex} "${scene.name}" as "${duplicate.name}".`;
    }
    case "delete_scene": {
      const scene = bound?.scene ?? resolveScene(
        context.application.song,
        action.sceneIndex,
        action.sceneName,
      );
      const name = scene.name;
      await context.application.song.deleteScene(scene);
      return `Deleted Scene ${action.sceneIndex} "${name}".`;
    }
    case "create_cue_point": {
      const cuePoint = await context.application.song.createCuePoint(action.timeBeat);
      const createdName = safeObjectName(cuePoint, "unnamed Cue Point");
      if (action.name) {
        try {
          cuePoint.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [
              `Created Cue Point "${createdName}" at beat ${action.timeBeat} without applying requested name "${action.name}".`,
            ],
            error,
          );
        }
      }
      return `Created Cue Point "${safeObjectName(cuePoint, createdName)}" at beat ${action.timeBeat}.`;
    }
    case "rename_cue_point": {
      const cuePoint = bound?.cuePoint ?? resolveCuePoint(
        context.application.song,
        action.timeBeat,
        action.cueName,
      );
      const oldName = cuePoint.name;
      if (oldName === action.newName) {
        return noMutation(
          `Kept Cue Point "${oldName}" at beat ${action.timeBeat} because it already matches.`,
        );
      }
      cuePoint.name = action.newName;
      return `Renamed Cue Point "${oldName}" at beat ${action.timeBeat} to "${cuePoint.name}".`;
    }
    case "delete_cue_point": {
      const cuePoint = bound?.cuePoint ?? resolveCuePoint(
        context.application.song,
        action.timeBeat,
        action.cueName,
      );
      const name = cuePoint.name;
      await context.application.song.deleteCuePoint(cuePoint);
      return `Deleted Cue Point "${name}" at beat ${action.timeBeat}.`;
    }
    case "create_midi_clip": {
      const track = midiTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      if (action.name) {
        const existing = bound?.clip instanceof MidiClip
          ? bound.clip
          : findReusableMidiClip(
              track,
              action.name,
              action.startBeat,
              action.durationBeats,
            );
        if (existing) {
          if (midiNotesEqual(existing.notes, action.notes)) {
            return noMutation(
              `Kept existing MIDI clip "${existing.name}" on track "${track.name}" because its notes already match.`,
            );
          }
          existing.notes = action.notes;
          return `Updated existing MIDI clip "${existing.name}" on track "${track.name}" with ${action.notes.length} notes.`;
        }
      }
      const trackName = safeObjectName(track, "unnamed MIDI track");
      const clip = await track.createMidiClip(action.startBeat, action.durationBeats);
      const createdName = safeObjectName(clip, "unnamed MIDI clip");
      if (action.name) {
        try {
          clip.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [createdMidiClipResult(createdName, trackName, action.startBeat, action.durationBeats, `without applying requested name "${action.name}"`)],
            error,
          );
        }
      }
      const configuredName = safeObjectName(clip, createdName);
      try {
        clip.notes = action.notes;
      } catch (error) {
        throw new AgentPlanExecutionError(
          [createdMidiClipResult(configuredName, trackName, action.startBeat, action.durationBeats, "without applying requested notes")],
          error,
        );
      }
      return `Created MIDI clip "${configuredName}" on track "${trackName}" with ${action.notes.length} notes.`;
    }
    case "create_session_midi_clip": {
      const track = midiTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      const slot = bound?.slot ?? requireSessionSlot(track, action.slotIndex);
      return createSessionMidiClip(
        track,
        slot,
        action.slotIndex,
        action.durationBeats,
        action.notes,
        action.name,
      );
    }
    case "replace_midi_clip_segment": {
      const track = midiTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      const resolvedClip = bound?.clip ?? resolveArrangementClip(
        track,
        action.startBeat,
        action.clipName,
      );
      if (!(resolvedClip instanceof MidiClip)) {
        throw new Error(
          `Clip "${resolvedClip.name}" on track "${track.name}" is not a MIDI clip.`,
        );
      }
      const segmentEnd = action.segmentStartTime + action.segmentDurationBeats;
      const tolerance = 1e-7;
      if (segmentEnd > resolvedClip.duration + tolerance) {
        throw new Error(
          `Relative segment ${action.segmentStartTime}-${segmentEnd} exceeds MIDI clip "${resolvedClip.name}" bounds 0-${resolvedClip.duration}. Inspect the clip and use a segment inside its duration.`,
        );
      }
      const preserved = resolvedClip.notes.filter((note) => {
        const noteEnd = note.startTime + note.duration;
        return !(
          note.startTime < segmentEnd - tolerance &&
          noteEnd > action.segmentStartTime + tolerance
        );
      });
      const removedCount = resolvedClip.notes.length - preserved.length;
      const merged = [...preserved, ...action.notes].sort(compareMidiNotes);
      if (midiNotesEqual(resolvedClip.notes, merged)) {
        return noMutation(
          `Kept relative beats ${action.segmentStartTime}-${segmentEnd} in MIDI clip "${resolvedClip.name}" on track "${track.name}" because the resulting notes already match.`,
        );
      }
      resolvedClip.notes = merged;
      return `Replaced relative beats ${action.segmentStartTime}-${segmentEnd} in MIDI clip "${resolvedClip.name}" on track "${track.name}": removed ${removedCount} notes, added ${action.notes.length}, final ${merged.length} notes.`;
    }
    case "transpose_midi_notes":
    case "quantize_midi_notes":
    case "scale_midi_velocity":
    case "shift_midi_notes": {
      const track = midiTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      const currentClip = resolveClipLocator(track, action);
      if (bound?.clip && !sameHostObject(bound.clip, currentClip)) {
        throw new Error(
          `MIDI Clip at the requested locator changed earlier in this plan. Inspect the current Clip and apply the transform in a later stage.`,
        );
      }
      const clip = bound?.clip ?? currentClip;
      if (!(clip instanceof MidiClip)) {
        throw new Error(
          `Clip "${clip.name}" on track "${track.name}" is not a MIDI clip.`,
        );
      }
      const transformed = transformMidiNotes(
        clip.notes,
        clip.duration,
        midiTransformForAction(action),
      );
      if (transformedMidiNotesEqual(clip.notes, transformed)) {
        return noMutation(
          `Kept MIDI clip "${clip.name}" on track "${track.name}" because the transform produced no note changes.`,
        );
      }
      clip.notes = transformed;
      return `${midiTransformResult(action)} in MIDI clip "${clip.name}" on track "${track.name}" (${transformed.length} notes).`;
    }
    case "insert_device": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const index = action.index ?? track.devices.length;
      const device = await track.insertDevice(action.deviceName, index);
      return `Inserted "${device.name}" on track "${track.name}".`;
    }
    case "insert_chain_device": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
      );
      if (!(resolved.device instanceof RackDevice)) {
        throw new Error(`Device "${resolved.device.name}" is not a Rack device.`);
      }
      const chain = resolved.device.chains[action.chainIndex];
      if (!chain) {
        throw new Error(
          `Rack "${resolved.device.name}" has ${resolved.device.chains.length} chains; chain ${action.chainIndex} does not exist.`,
        );
      }
      const index = action.index ?? chain.devices.length;
      const device = await chain.insertDevice(action.deviceName, index);
      return `Inserted "${device.name}" in chain ${action.chainIndex} of Rack "${resolved.device.name}" on track "${track.name}".`;
    }
    case "set_device_parameter": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.deviceName,
        action.devicePath,
        action.deviceIndex,
      );
      const device = resolved.device;
      const parameter = findExactParameterMatch(action.parameterName, device.parameters);
      if (!parameter) {
        const available = device.parameters.map((item) => item.name).join(", ");
        throw new Error(
          `Could not find parameter "${action.parameterName}" on device "${device.name}". Available parameters: ${available}`,
        );
      }
      if (action.value < parameter.min || action.value > parameter.max) {
        throw new Error(
          `Value ${action.value} for parameter "${parameter.name}" on device "${device.name}" is outside observed range ${parameter.min}-${parameter.max}. Inspect the device again and use a value inside that range.`,
        );
      }
      if (sameNumericValue(await parameter.getValue(), action.value)) {
        return noMutation(
          `Kept "${parameter.name}" on "${device.name}" at ${devicePathLabel(resolved.path)} in track "${track.name}" at ${action.value} because it already matches.`,
        );
      }
      await parameter.setValue(action.value);
      return `Set "${parameter.name}" on "${device.name}" at ${devicePathLabel(resolved.path)} in track "${track.name}" to ${action.value}.`;
    }
    case "duplicate_device": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.deviceName,
        action.devicePath,
        action.deviceIndex,
      );
      const duplicate = await resolved.parent.duplicateDevice(resolved.device);
      return `Duplicated device "${resolved.device.name}" at ${devicePathLabel(resolved.path)} in track "${track.name}" as "${duplicate.name}".`;
    }
    case "delete_device": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.deviceName,
        action.devicePath,
        action.deviceIndex,
      );
      const name = resolved.device.name;
      await resolved.parent.deleteDevice(resolved.device);
      return `Deleted device "${name}" at ${devicePathLabel(resolved.path)} from track "${track.name}".`;
    }
    case "replace_simpler_sample": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.simplerName,
        action.simplerPath,
      );
      if (!(resolved.device instanceof Simpler)) {
        throw new Error(`Device "${resolved.device.name}" is not Simpler.`);
      }
      const source = bound?.sampleSource ?? resolveSampleSource(context, action.source, target);
      if (resolved.device.sample?.filePath === source.filePath) {
        return noMutation(
          `Reused sample "${source.label}" in Simpler "${resolved.device.name}" on track "${track.name}".`,
        );
      }
      try {
        await resolved.device.replaceSample(source.filePath);
      } catch (error) {
        throw sanitizeSampleError(error, source.filePath);
      }
      return `Loaded sample "${source.label}" into Simpler "${resolved.device.name}" on track "${track.name}".`;
    }
    case "configure_drum_pad": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const resolved = bound?.deviceTarget ?? resolveDeviceTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
      );
      if (!(resolved.device instanceof DrumRack)) {
        throw new Error(`Device "${resolved.device.name}" is not a Drum Rack.`);
      }
      const source = bound?.sampleSource ?? resolveSampleSource(context, action.source, target);
      return configureDrumPad(
        track,
        resolved.device,
        action.receivingNote,
        source.filePath,
        source.label,
        action.mode,
        action.simplerPath,
        bound?.secondaryDeviceTarget,
      );
    }
    case "create_arrangement_audio_clip": {
      const track = audioTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      const source = bound?.sampleSource ?? resolveSampleSource(context, action.source, target);
      let clip: AudioClip<"1.0.0">;
      try {
        clip = await track.createAudioClip({
          filePath: source.filePath,
          startTime: action.startBeat,
          ...(action.durationBeats === undefined
            ? {}
            : { duration: action.durationBeats }),
          ...(action.isWarped === undefined ? {} : { isWarped: action.isWarped }),
          ...(action.loopSettings === undefined
            ? {}
            : { loopSettings: action.loopSettings }),
        });
      } catch (error) {
        throw sanitizeSampleError(error, source.filePath);
      }
      const createdName = safeObjectName(clip, "unnamed audio clip");
      if (action.name) {
        try {
          clip.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [
              `Created arrangement audio clip "${createdName}" on track "${track.name}" at beat ${action.startBeat} without applying requested name "${action.name}".`,
            ],
            error,
          );
        }
      }
      return `Created arrangement audio clip "${safeObjectName(clip, createdName)}" from "${source.label}" on track "${track.name}" at beat ${action.startBeat}.`;
    }
    case "create_session_audio_clip": {
      const track = audioTrackForAction(
        context,
        action,
        actionIndex,
        target,
        tracks,
        actionTracks,
      );
      const slot = bound?.slot ?? requireSessionSlot(track, action.slotIndex);
      const source = bound?.sampleSource ?? resolveSampleSource(context, action.source, target);
      return createSessionAudioClip(
        track,
        slot,
        action.slotIndex,
        source.filePath,
        source.label,
        action.name,
        action.isWarped,
        action.loopSettings,
      );
    }
    case "set_tempo": {
      if (sameNumericValue(context.application.song.tempo, action.tempo)) {
        return noMutation(`Kept tempo at ${action.tempo} BPM because it already matches.`);
      }
      context.application.song.tempo = action.tempo;
      return `Set tempo to ${action.tempo} BPM.`;
    }
    case "rename_track": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const oldName = track.name;
      if (oldName === action.newName) {
        return noMutation(
          `Kept track "${oldName}" named "${action.newName}" because it already matches.`,
        );
      }
      track.name = action.newName;
      return `Renamed track "${oldName}" to "${track.name}".`;
    }
    case "delete_track": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const name = track.name;
      await context.application.song.deleteTrack(track);
      return `Deleted track "${name}".`;
    }
    case "duplicate_track": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const duplicatedTrack = await context.application.song.duplicateTrack(track);
      return `Duplicated track "${track.name}" → "${duplicatedTrack.name}".`;
    }
    case "set_track_mute": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      if (track.mute === action.mute) {
        return noMutation(
          `Kept track "${track.name}" ${action.mute ? "muted" : "unmuted"} because it already matches.`,
        );
      }
      track.mute = action.mute;
      return `${action.mute ? "Muted" : "Unmuted"} track "${track.name}".`;
    }
    case "set_track_solo": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      if (track.solo === action.solo) {
        return noMutation(
          `Kept track "${track.name}" ${action.solo ? "soloed" : "unsoloed"} because it already matches.`,
        );
      }
      track.solo = action.solo;
      return `${action.solo ? "Soloed" : "Unsoloed"} track "${track.name}".`;
    }
    case "set_track_arm": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      if (track.arm === action.arm) {
        return noMutation(
          `Kept track "${track.name}" ${action.arm ? "armed" : "disarmed"} because it already matches.`,
        );
      }
      track.arm = action.arm;
      return `${action.arm ? "Armed" : "Disarmed"} track "${track.name}".`;
    }
    case "set_track_mixer_parameter": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const parameter = bound?.mixerParameter ?? resolveTrackMixerParameter(
        track,
        action.parameter,
        action.sendIndex,
      );
      if (action.value < parameter.min || action.value > parameter.max) {
        throw new Error(
          `Value ${action.value} for mixer parameter "${parameter.name}" on track "${track.name}" is outside observed range ${parameter.min}-${parameter.max}. Inspect the mixer again and use a value inside that range.`,
        );
      }
      if (sameNumericValue(await parameter.getValue(), action.value)) {
        return noMutation(
          `Kept mixer parameter "${parameter.name}" on track "${track.name}" at ${action.value} because it already matches.`,
        );
      }
      await parameter.setValue(action.value);
      return `Set mixer parameter "${parameter.name}" on track "${track.name}" to ${action.value}.`;
    }
    case "create_take_lane": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const lane = await track.createTakeLane();
      const createdName = safeObjectName(lane, "unnamed Take Lane");
      if (action.name) {
        try {
          lane.name = action.name;
        } catch (error) {
          throw new AgentPlanExecutionError(
            [
              `Created Take Lane "${createdName}" on track "${track.name}" without applying requested name "${action.name}".`,
            ],
            error,
          );
        }
      }
      return `Created Take Lane "${safeObjectName(lane, createdName)}" on track "${track.name}".`;
    }
    case "rename_take_lane": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const lane = bound?.takeLane ?? resolveTakeLane(
        track,
        action.laneIndex,
        action.laneName,
      );
      const oldName = lane.name;
      if (oldName === action.newName) {
        return noMutation(
          `Kept Take Lane ${action.laneIndex} named "${oldName}" on track "${track.name}" because it already matches.`,
        );
      }
      lane.name = action.newName;
      return `Renamed Take Lane ${action.laneIndex} from "${oldName}" to "${lane.name}" on track "${track.name}".`;
    }
    case "set_clip_properties": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const clip = bound?.clip ?? resolveClipLocator(track, action);
      return setClipProperties(track, clip, action);
    }
    case "set_audio_clip_warp": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const clip = bound?.clip ?? resolveClipLocator(track, action);
      if (!(clip instanceof AudioClip)) {
        throw new Error(`Clip "${clip.name}" on track "${track.name}" is not an audio clip.`);
      }
      return setAudioClipWarp(track, clip, action);
    }
    case "clear_arrangement_range": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      if (!track.arrangementClips.some((clip) =>
        clip.startTime < action.endBeat &&
        clip.startTime + clip.duration > action.startBeat
      )) {
        return noMutation(
          `Kept arrangement beats ${action.startBeat}-${action.endBeat} clear on track "${track.name}" because no Clip overlaps that range.`,
        );
      }
      await track.clearClipsInRange(action.startBeat, action.endBeat);
      return `Cleared arrangement clips on track "${track.name}" from beat ${action.startBeat} to ${action.endBeat}; boundary-crossing clips were truncated.`;
    }
    case "delete_clip": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const clip = bound?.clip ?? resolveArrangementClip(
        track,
        action.startBeat,
        action.clipName,
      );
      const name = clip.name;
      await track.deleteClip(clip);
      return `Deleted clip "${name}" from track "${track.name}".`;
    }
    case "delete_session_clip": {
      const track = trackForAction(context, action, actionIndex, target, tracks, actionTracks);
      const clip = bound?.clip ?? resolveSessionClip(
        track,
        action.slotIndex,
        action.clipName,
      );
      const name = clip.name;
      const slot = bound?.slot ?? requireSessionSlot(track, action.slotIndex);
      if (bound?.clip && !sameHostObject(slot.clip, bound.clip)) {
        throw new Error(
          `Session slot ${action.slotIndex} changed earlier in this plan; refusing to delete a different Clip than the one confirmed.`,
        );
      }
      await slot.deleteClip();
      return `Deleted Session clip "${name}" from slot ${action.slotIndex} on track "${track.name}".`;
    }
  }
}

function midiTransformForAction(
  action: Extract<AgentAction, {
    type:
      | "transpose_midi_notes"
      | "quantize_midi_notes"
      | "scale_midi_velocity"
      | "shift_midi_notes";
  }>,
): MidiTransform {
  switch (action.type) {
    case "transpose_midi_notes":
      return { type: "transpose", semitones: action.semitones };
    case "quantize_midi_notes":
      return {
        type: "quantize",
        gridBeats: action.gridBeats,
        strength: action.strength,
      };
    case "scale_midi_velocity":
      return { type: "scale_velocity", factor: action.factor };
    case "shift_midi_notes":
      return { type: "shift", offsetBeats: action.offsetBeats };
  }
}

function midiTransformResult(
  action: Extract<AgentAction, {
    type:
      | "transpose_midi_notes"
      | "quantize_midi_notes"
      | "scale_midi_velocity"
      | "shift_midi_notes";
  }>,
): string {
  switch (action.type) {
    case "transpose_midi_notes":
      return `Transposed every note by ${action.semitones} semitones`;
    case "quantize_midi_notes":
      return `Quantized every note start to a ${action.gridBeats}-beat grid at ${action.strength} strength`;
    case "scale_midi_velocity":
      return `Scaled every note velocity by ${action.factor}`;
    case "shift_midi_notes":
      return `Shifted every note by ${action.offsetBeats} beats`;
  }
}

async function createSessionMidiClip(
  track: MidiTrack<"1.0.0">,
  slot: ClipSlot<"1.0.0">,
  slotIndex: number,
  durationBeats: number,
  notes: Extract<AgentAction, { type: "create_session_midi_clip" }>["notes"],
  name?: string,
): Promise<string | NoMutationActionOutcome> {
  const completedResults: string[] = [];
  const completedKeys: string[][] = [];
  try {
    let clip = slot.clip;
    if (clip instanceof MidiClip && Math.abs(clip.duration - durationBeats) < 0.0001) {
      let changed = false;
      if (name && clip.name !== name) {
        clip.name = name;
        changed = true;
        completedResults.push(`Renamed Session MIDI clip in slot ${slotIndex} to "${name}".`);
        completedKeys.push([clipStepKey(track, slotIndex, "rename")]);
      }
      if (!midiNotesEqual(clip.notes, notes)) {
        clip.notes = notes;
        changed = true;
      }
      if (!changed) {
        return noMutation(
          `Kept Session MIDI clip "${clip.name}" in slot ${slotIndex} on track "${track.name}" because its requested name, duration, and notes already match.`,
        );
      }
      return `Updated Session MIDI clip "${clip.name}" in slot ${slotIndex} on track "${track.name}" with ${notes.length} notes.`;
    }
    if (clip) {
      const deletedName = clip.name;
      await slot.deleteClip();
      completedResults.push(
        `Deleted existing Session clip "${deletedName}" from slot ${slotIndex} on track "${track.name}".`,
      );
      completedKeys.push([clipStepKey(track, slotIndex, "delete-existing")]);
    }
    const created = await slot.createMidiClip(durationBeats);
    completedResults.push(
      `Created Session MIDI clip in slot ${slotIndex} on track "${track.name}".`,
    );
    completedKeys.push([clipStepKey(track, slotIndex, "create-midi")]);
    if (name) created.name = name;
    created.notes = notes;
    return `Created Session MIDI clip "${created.name}" in slot ${slotIndex} on track "${track.name}" with ${notes.length} notes.`;
  } catch (error) {
    if (!completedResults.length) throw error;
    throw new AgentPlanExecutionError(
      completedResults,
      error,
      undefined,
      undefined,
      undefined,
      completedKeys,
    );
  }
}

async function createSessionAudioClip(
  track: AudioTrack<"1.0.0">,
  slot: ClipSlot<"1.0.0">,
  slotIndex: number,
  filePath: string,
  sampleLabel: string,
  name?: string,
  isWarped?: boolean,
  loopSettings?: import("../agent/action-schema.js").ClipLoopSettingsInput,
): Promise<string | NoMutationActionOutcome> {
  const completedResults: string[] = [];
  const completedKeys: string[][] = [];
  try {
    const existing = slot.clip;
    if (
      existing instanceof AudioClip &&
      existing.filePath === filePath &&
      sessionAudioSettingsMatch(existing, isWarped, loopSettings)
    ) {
      if (name && existing.name !== name) {
        existing.name = name;
        completedResults.push(
          `Renamed Session audio clip in slot ${slotIndex} to "${name}".`,
        );
        completedKeys.push([clipStepKey(track, slotIndex, "rename")]);
      }
      return completedResults.length
        ? `Updated Session audio clip "${existing.name}" in slot ${slotIndex} on track "${track.name}" from "${sampleLabel}".`
        : noMutation(
            `Reused Session audio clip "${existing.name}" in slot ${slotIndex} on track "${track.name}" from "${sampleLabel}" because all requested settings already match.`,
          );
    }
    if (existing) {
      const deletedName = existing.name;
      await slot.deleteClip();
      completedResults.push(
        `Deleted existing Session clip "${deletedName}" from slot ${slotIndex} on track "${track.name}".`,
      );
      completedKeys.push([clipStepKey(track, slotIndex, "delete-existing")]);
    }
    let clip: AudioClip<"1.0.0">;
    try {
      clip = await slot.createAudioClip({
        filePath,
        ...(isWarped === undefined ? {} : { isWarped }),
        ...(loopSettings === undefined ? {} : { loopSettings }),
      });
    } catch (error) {
      throw sanitizeSampleError(error, filePath);
    }
    completedResults.push(
      `Created Session audio clip in slot ${slotIndex} on track "${track.name}".`,
    );
    completedKeys.push([clipStepKey(track, slotIndex, "create-audio")]);
    if (name) clip.name = name;
    return `Created Session audio clip "${clip.name}" in slot ${slotIndex} on track "${track.name}" from "${sampleLabel}".`;
  } catch (error) {
    if (!completedResults.length) throw error;
    throw new AgentPlanExecutionError(
      completedResults,
      error,
      undefined,
      undefined,
      undefined,
      completedKeys,
    );
  }
}

function sessionAudioSettingsMatch(
  clip: AudioClip<"1.0.0">,
  isWarped: boolean | undefined,
  settings: import("../agent/action-schema.js").ClipLoopSettingsInput | undefined,
): boolean {
  if (isWarped !== undefined && clip.warping !== isWarped) return false;
  if (!settings) return true;
  return (
    clip.looping === settings.looping &&
    clip.startMarker === settings.startMarker &&
    clip.endMarker === settings.endMarker &&
    clip.loopStart === settings.loopStart &&
    clip.loopEnd === settings.loopEnd
  );
}

function setClipProperties(
  track: Track<"1.0.0">,
  clip: Clip<"1.0.0">,
  action: Extract<AgentAction, { type: "set_clip_properties" }>,
): string | NoMutationActionOutcome {
  const completedResults: string[] = [];
  const completedKeys: string[][] = [];
  const location = action.slotIndex === undefined
    ? `arrangement beat ${action.startBeat}`
    : `Session slot ${action.slotIndex}`;
  try {
    if (action.newName !== undefined && clip.name !== action.newName) {
      clip.name = action.newName;
      completedResults.push(`Renamed clip at ${location} to "${action.newName}".`);
      completedKeys.push([clipStepKey(track, location, "rename")]);
    }
    if (action.looping !== undefined && clip.looping !== action.looping) {
      clip.looping = action.looping;
      completedResults.push(`Set looping ${action.looping ? "on" : "off"} for clip "${clip.name}".`);
      completedKeys.push([clipStepKey(track, location, "looping")]);
    }
    if (action.muted !== undefined && clip.muted !== action.muted) {
      clip.muted = action.muted;
      completedResults.push(`${action.muted ? "Muted" : "Unmuted"} clip "${clip.name}".`);
      completedKeys.push([clipStepKey(track, location, "muted")]);
    }
    if (action.color !== undefined && clip.color !== action.color) {
      clip.color = action.color;
      completedResults.push(`Set color ${action.color} for clip "${clip.name}".`);
      completedKeys.push([clipStepKey(track, location, "color")]);
    }
  } catch (error) {
    if (!completedResults.length) throw error;
    throw new AgentPlanExecutionError(
      completedResults,
      error,
      undefined,
      undefined,
      undefined,
      completedKeys,
    );
  }
  if (!completedResults.length) {
    return noMutation(
      `Kept clip "${clip.name}" at ${location} on track "${track.name}" because all requested properties already match.`,
    );
  }
  return `Updated clip "${clip.name}" at ${location} on track "${track.name}".`;
}

function setAudioClipWarp(
  track: Track<"1.0.0">,
  clip: AudioClip<"1.0.0">,
  action: Extract<AgentAction, { type: "set_audio_clip_warp" }>,
): string | NoMutationActionOutcome {
  const completedResults: string[] = [];
  const completedKeys: string[][] = [];
  try {
    if (action.warping !== undefined && clip.warping !== action.warping) {
      clip.warping = action.warping;
      completedResults.push(`Set warping ${action.warping ? "on" : "off"} for audio clip "${clip.name}".`);
      completedKeys.push([clipStepKey(track, clip.name, "warping")]);
    }
    const requestedWarpMode = action.warpMode === undefined
      ? undefined
      : warpMode(action.warpMode);
    if (requestedWarpMode !== undefined && clip.warpMode !== requestedWarpMode) {
      clip.warpMode = requestedWarpMode;
      completedResults.push(`Set Warp mode ${action.warpMode} for audio clip "${clip.name}".`);
      completedKeys.push([clipStepKey(track, clip.name, "warp-mode")]);
    }
  } catch (error) {
    if (!completedResults.length) throw error;
    throw new AgentPlanExecutionError(
      completedResults,
      error,
      undefined,
      undefined,
      undefined,
      completedKeys,
    );
  }
  if (!completedResults.length) {
    return noMutation(
      `Kept Warp settings for audio clip "${clip.name}" on track "${track.name}" because they already match.`,
    );
  }
  return `Updated Warp settings for audio clip "${clip.name}" on track "${track.name}".`;
}

function warpMode(value: Extract<AgentAction, { type: "set_audio_clip_warp" }>["warpMode"]): WarpMode {
  switch (value) {
    case "beats": return WarpMode.Beats;
    case "tones": return WarpMode.Tones;
    case "texture": return WarpMode.Texture;
    case "repitch": return WarpMode.Repitch;
    case "complex": return WarpMode.Complex;
    case "complex_pro": return WarpMode.ComplexPro;
    case undefined:
      throw new Error("Warp mode is required.");
  }
}

function clipStepKey(
  track: Track<"1.0.0">,
  location: number | string,
  step: string,
): string {
  return `live-action-step:clip:${objectHandleKey(track, track.name)}:${location}:${step}`;
}

function requireSessionSlot(
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

async function configureDrumPad(
  track: Track<"1.0.0">,
  rack: DrumRack<"1.0.0">,
  receivingNote: number,
  filePath: string,
  sampleLabel: string,
  mode: Extract<AgentAction, { type: "configure_drum_pad" }>["mode"],
  simplerPath?: Extract<AgentAction, { type: "configure_drum_pad" }>["simplerPath"],
  boundSimpler?: import("./device-tree.js").ResolvedDeviceTarget,
): Promise<string | NoMutationActionOutcome> {
  const matches = rack.chains.filter((chain) => chain.receivingNote === receivingNote);
  if (matches.length > 1) {
    throw new Error(
      `Drum Rack "${rack.name}" has ${matches.length} chains receiving MIDI note ${receivingNote}; resolve the duplicate pads in Live first.`,
    );
  }

  let chain = matches[0];
  if (mode === "replace_existing_simpler") {
    if (!chain) {
      throw new Error(
        `Drum Rack "${rack.name}" has no pad receiving MIDI note ${receivingNote}. Use mode fill_empty_pad to create it.`,
      );
    }
    if (!simplerPath) {
      throw new Error("replace_existing_simpler requires an exact simplerPath.");
    }
    const resolved = boundSimpler ?? resolveDevicePath(track, simplerPath);
    if (!(resolved.device instanceof Simpler)) {
      throw new Error(
        `Device at ${devicePathLabel(simplerPath)} is "${resolved.device.name}", not Simpler.`,
      );
    }
    if (resolved.parent !== chain) {
      throw new Error(
        `Simpler at ${devicePathLabel(simplerPath)} is not directly on Drum Rack pad ${receivingNote}.`,
      );
    }
    if (resolved.device.sample?.filePath === filePath) {
      return noMutation(
        `Kept the existing sample "${sampleLabel}" on Drum Rack pad ${receivingNote} on track "${track.name}".`,
      );
    }
    try {
      await resolved.device.replaceSample(filePath);
    } catch (error) {
      throw sanitizeSampleError(error, filePath);
    }
    return `Replaced the sample in Simpler at ${devicePathLabel(simplerPath)} on Drum Rack pad ${receivingNote} on track "${track.name}" with "${sampleLabel}".`;
  }

  if (chain?.devices.length) {
    throw new Error(
      `Drum Rack pad ${receivingNote} is not empty; it contains ${chain.devices.map((device) => `"${device.name}"`).join(", ")}. Inspect the pad and use mode replace_existing_simpler with an exact simplerPath, or compose primitive device actions.`,
    );
  }

  const completedResults: string[] = [];
  const completedKeys: string[][] = [];
  try {
    if (!chain) {
      const inserted = await rack.insertChain(rack.chains.length);
      completedResults.push(
        `Inserted a new chain in Drum Rack "${rack.name}" on track "${track.name}".`,
      );
      completedKeys.push([
        drumPadStepKey(track, rack, receivingNote, "insert-chain"),
      ]);
      if (!(inserted instanceof DrumChain)) {
        throw new Error("The Drum Rack returned a chain that is not a DrumChain.");
      }
      chain = inserted;
      chain.receivingNote = receivingNote;
      completedResults.push(
        `Assigned MIDI note ${receivingNote} to the new Drum Rack chain.`,
      );
      completedKeys.push([
        drumPadStepKey(track, rack, receivingNote, "assign-note"),
      ]);
    }

    const inserted = await chain.insertDevice("Simpler", 0);
    completedResults.push(
      `Inserted Simpler on Drum Rack pad ${receivingNote}.`,
    );
    completedKeys.push([
      drumPadStepKey(track, rack, receivingNote, "insert-simpler"),
    ]);
    if (!(inserted instanceof Simpler)) {
      throw new Error("Live inserted a device that is not Simpler.");
    }

    try {
      await inserted.replaceSample(filePath);
    } catch (error) {
      throw sanitizeSampleError(error, filePath);
    }
    return `Filled empty Drum Rack pad ${receivingNote} on track "${track.name}" with sample "${sampleLabel}".`;
  } catch (error) {
    if (!completedResults.length) throw error;
    throw new AgentPlanExecutionError(
      completedResults,
      error,
      undefined,
      undefined,
      undefined,
      completedKeys,
    );
  }
}

function drumPadStepKey(
  track: Track<"1.0.0">,
  rack: DrumRack<"1.0.0">,
  receivingNote: number,
  step: string,
): string {
  return [
    "live-action-step:drum-pad",
    objectHandleKey(track, track.name),
    objectHandleKey(rack, rack.name),
    receivingNote,
    step,
  ].join(":");
}

function objectHandleKey(
  object: { handle?: { id?: unknown } },
  fallback: string,
): string {
  const id = object.handle?.id;
  return id === undefined || id === null ? fallback.trim().toLowerCase() : String(id);
}

function sameHostObject(
  left: { handle?: { id?: unknown } } | null | undefined,
  right: { handle?: { id?: unknown } },
): boolean {
  if (left === right) return true;
  const leftId = left?.handle?.id;
  const rightId = right.handle?.id;
  return leftId !== undefined && leftId !== null &&
    rightId !== undefined && rightId !== null &&
    String(leftId) === String(rightId);
}

function sanitizeSampleError(_error: unknown, _filePath: string): Error {
  return new Error(
    "Live could not complete the requested audio-sample operation; the beta SDK did not expose a safe cause.",
  );
}

function noMutation(result: string): NoMutationActionOutcome {
  return { result, mutated: false };
}

function sameNumericValue(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-7;
}

function trackForAction(
  context: Api,
  action: { trackName?: string; trackRef?: string },
  actionIndex: number,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): Track<"1.0.0"> {
  if (action.trackRef) return requireBoundTrack(action.trackRef, tracks);
  return actionTracks.get(actionIndex) ?? resolveTrack(context, action.trackName, target);
}

function midiTrackForAction(
  context: Api,
  action: { trackName?: string; trackRef?: string },
  actionIndex: number,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): MidiTrack<"1.0.0"> {
  const track = action.trackRef
    ? requireBoundTrack(action.trackRef, tracks)
    : actionTracks.get(actionIndex) ?? resolveMidiTrack(context, action.trackName, target);
  if (track instanceof MidiTrack) return track;
  throw new Error(
    `${action.trackRef ? `Track ref "${action.trackRef}"` : `Track "${track.name}"`} points to a non-MIDI track.`,
  );
}

function audioTrackForAction(
  context: Api,
  action: { trackName?: string; trackRef?: string },
  actionIndex: number,
  target: LiveTarget,
  tracks: ReadonlyMap<string, Track<"1.0.0">>,
  actionTracks: ReadonlyMap<number, Track<"1.0.0">>,
): AudioTrack<"1.0.0"> {
  const track = action.trackRef
    ? requireBoundTrack(action.trackRef, tracks)
    : actionTracks.get(actionIndex) ?? resolveTrack(context, action.trackName, target);
  if (track instanceof AudioTrack) return track;
  throw new Error(
    `${action.trackRef ? `Track ref "${action.trackRef}"` : `Track "${track.name}"`} points to a non-audio track.`,
  );
}

function createdMidiClipResult(
  clipName: string,
  trackName: string,
  startBeat: number,
  durationBeats: number,
  detail: string,
): string {
  return `Created MIDI clip "${clipName}" on track "${trackName}" at beat ${startBeat} for ${durationBeats} beats ${detail}.`;
}

function compareMidiNotes(
  left: { startTime: number; pitch: number; duration: number; velocity?: number },
  right: { startTime: number; pitch: number; duration: number; velocity?: number },
): number {
  return left.startTime - right.startTime ||
    left.pitch - right.pitch ||
    left.duration - right.duration ||
    (left.velocity ?? 0) - (right.velocity ?? 0);
}

function midiNotesEqual(
  left: readonly {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
  }[],
  right: readonly {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
  }[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareMidiNotes);
  const sortedRight = [...right].sort(compareMidiNotes);
  return sortedLeft.every((note, index) => {
    const candidate = sortedRight[index]!;
    return note.pitch === candidate.pitch &&
      sameNumericValue(note.startTime, candidate.startTime) &&
      sameNumericValue(note.duration, candidate.duration) &&
      (note.velocity === undefined
        ? candidate.velocity === undefined
        : candidate.velocity !== undefined &&
          sameNumericValue(note.velocity, candidate.velocity));
  });
}

function transformedMidiNotesEqual(
  current: readonly {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
  }[],
  transformed: readonly {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
  }[],
): boolean {
  return current.length === transformed.length && current.every((note, index) => {
    const candidate = transformed[index]!;
    return note.pitch === candidate.pitch &&
      note.startTime === candidate.startTime &&
      note.duration === candidate.duration &&
      note.velocity === candidate.velocity;
  });
}

function safeObjectName(value: { readonly name: string }, fallback: string): string {
  try {
    return value.name || fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
