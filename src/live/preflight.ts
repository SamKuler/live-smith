import {
  AudioTrack,
  AudioClip,
  DrumRack,
  MidiClip,
  RackDevice,
  Simpler,
  type Chain,
  type Clip,
  type Device,
  type DeviceParameter,
  type ExtensionContext,
  type NoteDescription,
  type Track,
} from "@ableton-extensions/sdk";

import type { AgentAction } from "../agent/actions.js";
import {
  MAX_MIDI_PREVIEW_NOTES,
  MAX_PARAMETER_PREVIEW_VALUE_ITEMS,
  type AgentActionPreview,
  type MidiActionPreview,
  type ParameterActionPreview,
} from "../agent/action-preview.js";
import { calculateMidiNoteEdit, type MidiNoteEditAction } from "./midi-transform.js";
import {
  assertParameterValueInObservedRange,
  findExactParameterMatch,
} from "./parameter-match.js";
import {
  resolveDevicePath,
  resolveDeviceTarget,
  resolveRackChainTarget,
  resolveRackDeviceTarget,
} from "./device-tree.js";
import {
  affectedTrackTree,
  findReusableMidiClip,
  resolveArrangementClip,
  resolveClipLocator,
  resolveCuePoint,
  resolveMidiTrack,
  resolveScene,
  resolveSessionClip,
  resolveTakeLane,
  resolveChainMixerParameter,
  resolveTrackMixerParameter,
  resolveTrack,
} from "./resolve.js";
import {
  resolveSampleSource,
  type RequestAudioSampleSources,
} from "./sample-source.js";
import type { LiveTarget } from "./target.js";

type Api = ExtensionContext<"1.0.0">;

export interface LiveActionPreflightObservation {
  fingerprint: string;
  preview?: AgentActionPreview;
}

export async function captureLiveActionPreflightSnapshot(
  context: Api,
  action: AgentAction,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
): Promise<string> {
  return (await captureLiveActionPreflightObservation(
    context, action, target, requestAudioSources, false,
  )).fingerprint;
}

export async function captureLiveActionPreflightObservation(
  context: Api,
  action: AgentAction,
  target: LiveTarget,
  requestAudioSources?: RequestAudioSampleSources,
  includePreview = true,
): Promise<LiveActionPreflightObservation> {
  const observed = await observeActionPreflight(context, action, target, requestAudioSources, includePreview);
  return typeof observed === "string" ? { fingerprint: observed } : observed;
}

async function observeActionPreflight(
  context: Api,
  action: AgentAction,
  target: LiveTarget,
  requestAudioSources: RequestAudioSampleSources | undefined,
  includePreview: boolean,
): Promise<string | LiveActionPreflightObservation> {
  const song = context.application.song;
  const songIdentity = requireHandleIdentity(song, "Live Set");

  switch (action.type) {
    case "create_midi_track": {
      return fingerprint(action.type, {
        song: songIdentity,
      });
    }
    case "create_audio_track": {
      return fingerprint(action.type, {
        song: songIdentity,
      });
    }
    case "create_scene":
      return fingerprint(action.type, {
        song: songIdentity,
        scenes: song.scenes.map((scene) => ({
          id: requireHandleIdentity(scene, "scene"),
          name: scene.name,
        })),
      });
    case "rename_scene": {
      const scene = resolveScene(song, action.sceneIndex, action.sceneName);
      return fingerprint(action.type, {
        song: songIdentity,
        scene: sceneIdentity(scene),
      });
    }
    case "duplicate_scene":
    case "delete_scene": {
      const scene = resolveScene(song, action.sceneIndex, action.sceneName);
      return fingerprint(action.type, {
        song: songIdentity,
        scene: sceneIdentity(scene),
        clipSlots: song.tracks.map((track) => {
          const slot = track.clipSlots[action.sceneIndex];
          if (!slot) {
            throw new Error(
              `Could not find Session slot ${action.sceneIndex} on track "${track.name}".`,
            );
          }
          return {
            track: trackIdentity(track),
            id: requireHandleIdentity(slot, "clip slot"),
            clip: slot.clip ? clipContentIdentity(slot.clip) : null,
          };
        }),
      });
    }
    case "create_cue_point":
      return fingerprint(action.type, {
        song: songIdentity,
        cuePoints: song.cuePoints.map(cuePointIdentity),
      });
    case "rename_cue_point":
    case "delete_cue_point": {
      const cuePoint = resolveCuePoint(song, action.timeBeat, action.cueName);
      return fingerprint(action.type, {
        song: songIdentity,
        cuePoint: cuePointIdentity(cuePoint),
      });
    }
    case "create_midi_clip": {
      const track = resolveMidiTrack(context, action.trackName, target);
      const lane = action.laneIndex === undefined
        ? undefined
        : resolveTakeLane(track, action.laneIndex, action.laneName);
      const clips = lane?.clips ?? track.arrangementClips;
      const matchingClip = action.name
        ? findReusableMidiClip(
            clips,
            action.name,
            action.startBeat,
            action.durationBeats,
          )
        : undefined;
      if (lane) {
        assertTakeLaneRangeAvailable(
          lane,
          clips,
          action.startBeat,
          action.durationBeats,
          matchingClip,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        ...(lane ? { takeLane: takeLaneTargetIdentity(lane) } : {}),
        matchingClip: matchingClip
          ? clipContentIdentity(matchingClip)
          : null,
      });
    }
    case "create_session_midi_clip": {
      const track = resolveMidiTrack(context, action.trackName, target);
      const slot = track.clipSlots[action.slotIndex];
      if (!slot) {
        throw new Error(
          `Could not find Session slot ${action.slotIndex} on track "${track.name}".`,
        );
      }
      const clip = slot.clip;
      if (action.requireEmpty && clip) {
        throw new Error(
          `Session slot ${action.slotIndex} on track "${track.name}" must be empty (requireEmpty: true). Inspect the current Session slots and choose an empty destination.`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        slot: {
          id: requireHandleIdentity(slot, "clip slot"),
          clip: clip ? clipContentIdentity(clip) : null,
        },
      });
    }
    case "replace_midi_clip_segment": {
      const track = resolveMidiTrack(context, action.trackName, target);
      const clip = resolveArrangementClip(track, action.startBeat, action.clipName);
      if (!(clip instanceof MidiClip)) {
        throw new Error(
          `Clip "${clip.name}" on track "${track.name}" is not a MIDI clip.`,
        );
      }
      const state = {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      };
      return midiPreflightObservation(action, state, includePreview);
    }
    case "transpose_midi_notes":
    case "quantize_midi_notes":
    case "scale_midi_velocity":
    case "shift_midi_notes": {
      const track = resolveMidiTrack(context, action.trackName, target);
      const clip = resolveClipLocator(track, action);
      if (!(clip instanceof MidiClip)) {
        throw new Error(
          `Clip "${clip.name}" on track "${track.name}" is not a MIDI clip.`,
        );
      }
      const state = {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      };
      return midiPreflightObservation(action, state, includePreview);
    }
    case "insert_device": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        devices: track.devices.map((device) => ({
          id: requireHandleIdentity(device, "device"),
          name: device.name,
        })),
      });
    }
    case "insert_chain_device": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveRackChainTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
        action.chainIndex,
      );
      const devices = resolved.chain.devices;
      if (action.index !== undefined && action.index > devices.length) {
        throw new Error(
          `Chain ${action.chainIndex} in Rack "${resolved.rackTarget.device.name}" has ${devices.length} devices; insertion index ${action.index} is out of range.`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        rackPath: resolved.rackTarget.path,
        rack: deviceTargetIdentity(resolved.rackTarget.device),
        chain: chainDeviceStructureIdentity(resolved.chain),
      });
    }
    case "create_rack_chain": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveRackDeviceTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
      );
      if (resolved.device instanceof DrumRack) {
        throw new Error(
          `Rack "${resolved.device.name}" is a Drum Rack. Use configure_drum_pad so the receiving note and partial completion are explicit.`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        rackPath: resolved.path,
        rack: deviceTargetIdentity(resolved.device),
      });
    }
    case "set_device_parameter": {
      const track = resolveTrack(context, action.trackName, target);
      const { device, path } = resolveDeviceTarget(
        track,
        target,
        action.deviceName,
        action.devicePath,
        action.deviceIndex,
      );
      const parameter = findExactParameterMatch(action.parameterName, device.parameters);
      if (!parameter) {
        throw new Error(
          `Could not verify parameter "${action.parameterName}" on device "${device.name}".`,
        );
      }
      if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) {
        throw new Error(
          `Could not verify the range for parameter "${parameter.name}" on device "${device.name}".`,
        );
      }
      assertParameterValueInObservedRange(
        action.value,
        parameter,
        `on device "${device.name}"`,
      );
      const currentValue = await parameter.getValue();
      if (!Number.isFinite(currentValue)) {
        throw new Error(
          `Could not verify the current value for parameter "${parameter.name}" on device "${device.name}".`,
        );
      }
      const state = {
        song: songIdentity,
        track: trackIdentity(track),
        device: {
          id: requireHandleIdentity(device, "device"),
          name: device.name,
          path,
        },
        parameter: parameterWriteObservation(parameter, currentValue),
      };
      return parameterPreflightObservation(action, state, `Device "${state.device.name}" on track "${state.track.name}"`, includePreview);
    }
    case "duplicate_device":
    case "delete_device": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveDeviceTarget(
        track,
        target,
        action.deviceName,
        action.devicePath,
        action.deviceIndex,
      );
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        path: resolved.path,
        parent: deviceContainerIdentity(resolved.parent),
        device: await deviceContentIdentity(resolved.device),
      });
    }
    case "replace_simpler_sample": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveDeviceTarget(
        track,
        target,
        action.simplerName,
        action.simplerPath,
      );
      if (!(resolved.device instanceof Simpler)) {
        throw new Error(`Device "${resolved.device.name}" is not Simpler.`);
      }
      const source = resolveSampleSource(
        context,
        action.source,
        target,
        requestAudioSources,
      );
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        path: resolved.path,
        simpler: await deviceContentIdentity(resolved.device),
        source: sampleSourceIdentity(source),
      });
    }
    case "configure_drum_pad": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveDeviceTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
      );
      if (!(resolved.device instanceof DrumRack)) {
        throw new Error(`Device "${resolved.device.name}" is not a Drum Rack.`);
      }
      const chains = resolved.device.chains;
      const matchingChains = chains.filter(
        (chain) => chain.receivingNote === action.receivingNote,
      );
      if (matchingChains.length > 1) {
        throw new Error(
          `Drum Rack "${resolved.device.name}" has ${matchingChains.length} chains receiving MIDI note ${action.receivingNote}; resolve the duplicate pads in Live first.`,
        );
      }
      const targetChain = matchingChains[0];
      let targetSimpler: ReturnType<typeof resolveDevicePath> | undefined;
      if (action.mode === "replace_existing_simpler") {
        if (!targetChain) {
          throw new Error(
            `Drum Rack "${resolved.device.name}" has no pad receiving MIDI note ${action.receivingNote}. Use mode fill_empty_pad to create it.`,
          );
        }
        const simpler = resolveDevicePath(track, action.simplerPath!);
        if (!(simpler.device instanceof Simpler)) {
          throw new Error(
            `${JSON.stringify(action.simplerPath)} is "${simpler.device.name}", not Simpler.`,
          );
        }
        if (simpler.parent !== targetChain) {
          throw new Error(
            `The Simpler at ${JSON.stringify(action.simplerPath)} is not directly on Drum Rack pad ${action.receivingNote}.`,
          );
        }
        targetSimpler = simpler;
      }
      const source = resolveSampleSource(
        context,
        action.source,
        target,
        requestAudioSources,
      );
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        path: resolved.path,
        rack: {
          ...deviceTargetIdentity(resolved.device),
          chains: chains.map(chainTargetIdentity),
          targetChain: targetChain
            ? chainDeviceStructureIdentity(targetChain)
            : null,
        },
        ...(targetSimpler
          ? {
              simplerPath: targetSimpler.path,
              simpler: await deviceContentIdentity(targetSimpler.device),
            }
          : {}),
        source: sampleSourceIdentity(source),
      });
    }
    case "create_arrangement_audio_clip": {
      const track = resolveTrack(context, action.trackName, target);
      if (!(track instanceof AudioTrack)) {
        throw new Error(`Track "${track.name}" is not an audio track.`);
      }
      const source = resolveSampleSource(
        context,
        action.source,
        target,
        requestAudioSources,
      );
      const lane = action.laneIndex === undefined
        ? undefined
        : resolveTakeLane(track, action.laneIndex, action.laneName);
      if (lane) {
        if (action.durationBeats === undefined) {
          throw new Error("Take Lane audio creation requires durationBeats.");
        }
        assertTakeLaneRangeAvailable(
          lane,
          lane.clips,
          action.startBeat,
          action.durationBeats,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        ...(lane
          ? { takeLane: takeLaneTargetIdentity(lane) }
          : { arrangementClips: track.arrangementClips.map(clipContentIdentity) }),
        source: sampleSourceIdentity(source),
      });
    }
    case "create_session_audio_clip": {
      const track = resolveTrack(context, action.trackName, target);
      if (!(track instanceof AudioTrack)) {
        throw new Error(`Track "${track.name}" is not an audio track.`);
      }
      const slot = track.clipSlots[action.slotIndex];
      if (!slot) {
        throw new Error(
          `Could not find Session slot ${action.slotIndex} on track "${track.name}".`,
        );
      }
      const source = resolveSampleSource(
        context,
        action.source,
        target,
        requestAudioSources,
      );
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        slot: {
          id: requireHandleIdentity(slot, "clip slot"),
          clip: slot.clip ? clipContentIdentity(slot.clip) : null,
        },
        source: sampleSourceIdentity(source),
      });
    }
    case "set_tempo":
      if (!Number.isFinite(song.tempo)) {
        throw new Error("Could not verify the current Live Set tempo.");
      }
      return fingerprint(action.type, {
        song: songIdentity,
        currentTempo: song.tempo,
      });
    case "rename_track": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
      });
    }
    case "set_track_mute": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        currentMute: track.mute,
      });
    }
    case "set_track_solo": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        currentSolo: track.solo,
      });
    }
    case "set_track_arm": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        currentArm: track.arm,
      });
    }
    case "set_track_mixer_parameter": {
      const track = resolveTrack(context, action.trackName, target);
      const parameter = resolveTrackMixerParameter(
        track,
        action.parameter,
        action.sendIndex,
      );
      assertParameterValueInObservedRange(
        action.value,
        parameter,
        `on track "${track.name}"`,
      );
      const currentValue = await verifiedParameterValue(parameter, "track mixer");
      const state = {
        song: songIdentity,
        track: trackIdentity(track),
        parameter: parameterWriteObservation(parameter, currentValue),
      };
      return parameterPreflightObservation(action, state, `Mixer on track "${state.track.name}"`, includePreview);
    }
    case "set_chain_mixer_parameter": {
      const track = resolveTrack(context, action.trackName, target);
      const resolved = resolveRackChainTarget(
        track,
        target,
        action.rackName,
        action.rackPath,
        action.chainIndex,
      );
      const parameter = resolveChainMixerParameter(
        resolved.chain,
        action.parameter,
        action.sendIndex,
      );
      assertParameterValueInObservedRange(
        action.value,
        parameter,
        `in Chain ${action.chainIndex} of Rack "${resolved.rackTarget.device.name}"`,
      );
      const currentValue = await verifiedParameterValue(parameter, "Rack Chain mixer");
      const rack = { id: requireHandleIdentity(resolved.rackTarget.device, "Rack device"), name: resolved.rackTarget.device.name };
      const state = {
        song: songIdentity,
        track: trackIdentity(track),
        rackPath: resolved.rackTarget.path,
        rack,
        chain: chainTargetIdentity(resolved.chain),
        parameter: parameterWriteObservation(parameter, currentValue),
      };
      return parameterPreflightObservation(action, state, `Chain ${action.chainIndex} mixer in Rack "${rack.name}" on track "${state.track.name}"`, includePreview);
    }
    case "create_take_lane": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        takeLanes: track.takeLanes.map(takeLaneIdentity),
      });
    }
    case "rename_take_lane": {
      const track = resolveTrack(context, action.trackName, target);
      const lane = resolveTakeLane(track, action.laneIndex, action.laneName);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        takeLane: takeLaneIdentity(lane),
      });
    }
    case "set_clip_properties": {
      const track = resolveTrack(context, action.trackName, target);
      const clip = resolveClipLocator(track, action);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      });
    }
    case "set_audio_clip_warp": {
      const track = resolveTrack(context, action.trackName, target);
      const clip = resolveClipLocator(track, action);
      if (!(clip instanceof AudioClip)) {
        throw new Error(`Clip "${clip.name}" on track "${track.name}" is not an audio clip.`);
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      });
    }
    case "clear_arrangement_range": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        arrangementClips: track.arrangementClips.map(clipContentIdentity),
      });
    }
    case "delete_track":
    case "duplicate_track": {
      const track = resolveTrack(context, action.trackName, target);
      return fingerprint(action.type, {
        song: songIdentity,
        trackTree: await Promise.all(
          affectedTrackTree(context, track).map(trackContentIdentity),
        ),
      });
    }
    case "delete_clip": {
      const track = resolveTrack(context, action.trackName, target);
      const clip = resolveArrangementClip(track, action.startBeat, action.clipName);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      });
    }
    case "delete_session_clip": {
      const track = resolveTrack(context, action.trackName, target);
      const clip = resolveSessionClip(track, action.slotIndex, action.clipName);
      const slot = track.clipSlots[action.slotIndex]!;
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        slot: {
          id: requireHandleIdentity(slot, "clip slot"),
          clip: clipContentIdentity(clip),
        },
      });
    }
  }
}

function sceneIdentity(
  scene: import("@ableton-extensions/sdk").Scene<"1.0.0">,
): object {
  return {
    id: requireHandleIdentity(scene, "scene"),
    name: scene.name,
    tempo: scene.tempo,
    signatureNumerator: scene.signatureNumerator,
    signatureDenominator: scene.signatureDenominator,
  };
}

function cuePointIdentity(
  cuePoint: import("@ableton-extensions/sdk").CuePoint<"1.0.0">,
): object {
  return {
    id: requireHandleIdentity(cuePoint, "Cue Point"),
    time: cuePoint.time,
    name: cuePoint.name,
  };
}

function takeLaneIdentity(
  lane: import("@ableton-extensions/sdk").TakeLane<"1.0.0">,
): object {
  return {
    id: requireHandleIdentity(lane, "Take Lane"),
    name: lane.name,
    clips: lane.clips.map(clipContentIdentity),
  };
}

function takeLaneTargetIdentity(
  lane: import("@ableton-extensions/sdk").TakeLane<"1.0.0">,
): object {
  return {
    id: requireHandleIdentity(lane, "Take Lane"),
    name: lane.name,
  };
}

function assertTakeLaneRangeAvailable(
  lane: import("@ableton-extensions/sdk").TakeLane<"1.0.0">,
  clips: readonly Clip<"1.0.0">[],
  startBeat: number,
  durationBeats: number,
  reusableClip?: import("@ableton-extensions/sdk").MidiClip<"1.0.0">,
): void {
  const endBeat = startBeat + durationBeats;
  const overlaps = clips.filter(
    (clip) =>
      clip !== reusableClip &&
      clip.startTime < endBeat &&
      clip.startTime + clip.duration > startBeat,
  );
  if (!overlaps.length) return;
  throw new Error(
    `Take Lane "${lane.name}" is not empty from beat ${startBeat} to ${endBeat}. Overlapping Clips: ${overlaps.map((clip) => `"${clip.name}"@${clip.startTime}-${clip.startTime + clip.duration}`).join(", ")}. Choose an empty range; Live Smith does not guess Take Lane overlap behavior.`,
  );
}

async function verifiedParameterValue(
  parameter: DeviceParameter<"1.0.0">,
  label: string,
): Promise<number> {
  if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) {
    throw new Error(`Could not verify the range for ${label} parameter "${parameter.name}".`);
  }
  const currentValue = await parameter.getValue();
  if (!Number.isFinite(currentValue)) {
    throw new Error(`Could not verify the current value for ${label} parameter "${parameter.name}".`);
  }
  return currentValue;
}

interface ParameterObservation {
  id: string;
  name: string;
  min: number;
  max: number;
  currentValue: number;
  isQuantized?: boolean;
  valueItems?: { name: string; shortName: string }[];
}

function parameterIdentity(
  parameter: DeviceParameter<"1.0.0">,
  currentValue: number,
): ParameterObservation {
  return {
    id: requireHandleIdentity(parameter, "device parameter"),
    name: parameter.name,
    min: parameter.min,
    max: parameter.max,
    currentValue,
  };
}

function parameterWriteObservation(
  parameter: DeviceParameter<"1.0.0">,
  currentValue: number,
): ParameterObservation {
  const observed = parameterIdentity(parameter, currentValue);
  try {
    const isQuantized = parameter.isQuantized;
    const valueItems = parameter.valueItems;
    if (typeof isQuantized === "boolean" && Array.isArray(valueItems) &&
        valueItems.length <= MAX_PARAMETER_PREVIEW_VALUE_ITEMS &&
        valueItems.every((item) => item && typeof item.name === "string" && typeof item.shortName === "string")) {
      observed.isQuantized = isQuantized;
      observed.valueItems = valueItems.map(({ name, shortName }) => ({ name, shortName }));
    }
  } catch {
    // Optional label metadata cannot prevent a validated numeric write.
  }
  return observed;
}

function parameterPreflightObservation(
  action: Extract<AgentAction, { type: "set_device_parameter" | "set_track_mixer_parameter" | "set_chain_mixer_parameter" }>,
  state: { parameter: ParameterObservation },
  targetLabel: string,
  includePreview: boolean,
): LiveActionPreflightObservation {
  const result: LiveActionPreflightObservation = { fingerprint: fingerprint(action.type, state) };
  const parameter = state.parameter;
  if (!includePreview || ![parameter.currentValue, action.value, parameter.min, parameter.max].every(Number.isFinite) ||
      parameter.min > parameter.max || parameter.currentValue < parameter.min || parameter.currentValue > parameter.max ||
      action.value < parameter.min || action.value > parameter.max ||
      typeof parameter.name !== "string" || typeof targetLabel !== "string") return result;
  const preview: ParameterActionPreview = {
    kind: "parameter-value", actionIndex: 0, status: "proposed", targetLabel,
    parameterName: parameter.name, before: parameter.currentValue, after: action.value,
    minimum: parameter.min, maximum: parameter.max,
    ...(parameter.isQuantized === undefined ? {} : { isQuantized: parameter.isQuantized }),
    ...(parameter.valueItems === undefined ? {} : { valueItems: parameter.valueItems }),
  };
  result.preview = preview;
  return result;
}

function deviceTargetIdentity(device: Device<"1.0.0">): object {
  return {
    id: requireHandleIdentity(device, "Rack device"),
    name: device.name,
  };
}

function chainTargetIdentity(chain: Chain<"1.0.0">): object {
  return {
    id: requireHandleIdentity(chain, "Rack Chain"),
    ...("receivingNote" in chain
      ? { receivingNote: (chain as { receivingNote: number }).receivingNote }
      : {}),
  };
}

function chainDeviceStructureIdentity(chain: Chain<"1.0.0">): object {
  return {
    ...chainTargetIdentity(chain),
    devices: chain.devices.map((device) =>
      requireHandleIdentity(device, "Chain device")
    ),
  };
}

function deviceContainerIdentity(
  parent: Track<"1.0.0"> | Chain<"1.0.0">,
): object {
  return "name" in parent
    ? {
        id: requireHandleIdentity(parent, "device container"),
        name: parent.name,
        devices: parent.devices.map((device) =>
          requireHandleIdentity(device, "container device")
        ),
      }
    : chainDeviceStructureIdentity(parent);
}

async function chainContentIdentity(chain: Chain<"1.0.0">): Promise<object> {
  return {
    ...chainTargetIdentity(chain),
    mixer: await mixerContentIdentity(chain),
    devices: await Promise.all(chain.devices.map(deviceContentIdentity)),
  };
}

async function mixerContentIdentity(
  owner: Chain<"1.0.0"> | Track<"1.0.0">,
  label = "Rack Chain mixer",
): Promise<object> {
  const mixer = owner.mixer;
  const sends = mixer.sends;
  const parameters = [mixer.volume, mixer.panning, ...sends];
  return {
    id: requireHandleIdentity(mixer, label),
    parameters: await Promise.all(parameters.map(async (parameter) =>
      parameterIdentity(
        parameter,
        await verifiedParameterValue(parameter, label),
      )
    )),
  };
}

async function deviceContentIdentity(device: Device<"1.0.0">): Promise<object> {
  const parameters = await Promise.all(
    device.parameters.map(async (parameter) =>
      parameterIdentity(
        parameter,
        await verifiedParameterValue(parameter, `device "${device.name}"`),
      ),
    ),
  );
  return {
    id: requireHandleIdentity(device, "device"),
    name: device.name,
    parameters,
    ...(device instanceof RackDevice
      ? { chains: await Promise.all(device.chains.map(chainContentIdentity)) }
      : {}),
    ...(device instanceof Simpler
      ? {
          sample: device.sample
            ? {
                id: requireHandleIdentity(device.sample, "Simpler sample"),
                filePath: device.sample.filePath,
              }
            : null,
        }
      : {}),
  };
}

function sampleSourceIdentity(
  source: ReturnType<typeof resolveSampleSource>,
): object {
  return source.kind === "live"
    ? { id: source.identity, filePath: source.filePath }
    : { id: source.identity };
}

function trackIdentity(track: Track<"1.0.0">) {
  return {
    id: requireHandleIdentity(track, "track"),
    name: track.name,
  };
}

async function trackContentIdentity(track: Track<"1.0.0">): Promise<object> {
  const groupTrack = track.groupTrack;
  return {
    ...trackIdentity(track),
    groupTrack: groupTrack
      ? requireHandleIdentity(groupTrack, "group track")
      : null,
    mute: track.mute,
    solo: track.solo,
    arm: track.arm,
    mixer: await mixerContentIdentity(track, "track mixer"),
    devices: await Promise.all(track.devices.map(deviceContentIdentity)),
    arrangementClips: track.arrangementClips.map(clipContentIdentity),
    clipSlots: track.clipSlots.map((slot) => ({
      id: requireHandleIdentity(slot, "clip slot"),
      clip: slot.clip ? clipContentIdentity(slot.clip) : null,
    })),
    takeLanes: track.takeLanes.map(takeLaneIdentity),
  };
}

interface MidiClipObservation {
  name: string;
  duration: number;
  notes: NoteDescription[];
}

function clipContentIdentity(clip: MidiClip<"1.0.0">): MidiClipObservation;
function clipContentIdentity(clip: Clip<"1.0.0">): object;
function clipContentIdentity(clip: Clip<"1.0.0">): object {
  return {
    id: requireHandleIdentity(clip, "clip"),
    name: clip.name,
    startTime: clip.startTime,
    duration: clip.duration,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    looping: clip.looping,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
    color: clip.color,
    muted: clip.muted,
    ...(clip instanceof MidiClip
      ? { notes: clip.notes.map(midiNoteIdentity) }
      : {}),
    ...(clip instanceof AudioClip
      ? {
          filePath: clip.filePath,
          warping: clip.warping,
          warpMode: clip.warpMode,
          warpMarkers: clip.warpMarkers.map(warpMarkerIdentity),
        }
      : {}),
  };
}

function midiNoteIdentity(
  note: NoteDescription,
): NoteDescription {
  return {
    pitch: note.pitch,
    startTime: note.startTime,
    duration: note.duration,
    ...(note.velocity === undefined ? {} : { velocity: note.velocity }),
    ...(note.muted === undefined ? {} : { muted: note.muted }),
    ...(note.probability === undefined ? {} : { probability: note.probability }),
    ...(note.velocityDeviation === undefined ? {} : { velocityDeviation: note.velocityDeviation }),
    ...(note.releaseVelocity === undefined ? {} : { releaseVelocity: note.releaseVelocity }),
  };
}

function midiPreflightObservation(
  action: MidiNoteEditAction,
  state: { track: { name: string }; clip: MidiClipObservation },
  includePreview: boolean,
): LiveActionPreflightObservation {
  const result: LiveActionPreflightObservation = { fingerprint: fingerprint(action.type, state) };
  if (!includePreview) return result;
  try {
    const clip = state.clip;
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 ||
        typeof clip.name !== "string" || typeof state.track.name !== "string") return result;
    const after = calculateMidiNoteEdit(clip, action).notes;
    if (![clip.notes, after].every((notes) => notes.every((note) => midiNoteFitsPreview(note, clip.duration)))) return result;
    result.preview = {
      kind: "midi-notes", actionIndex: 0, status: "proposed",
      targetLabel: `MIDI clip "${clip.name}" on track "${state.track.name}"`,
      range: { coordinate: "clip-beats", start: 0, end: clip.duration },
      before: midiPreviewSide(clip.notes), after: midiPreviewSide(after),
    };
  } catch {
    // Prediction is optional; the executor retains its own validation and errors.
  }
  return result;
}

function midiPreviewSide(notes: readonly NoteDescription[]): MidiActionPreview["before"] {
  const displayed = notes.slice(0, MAX_MIDI_PREVIEW_NOTES).map(midiNoteIdentity);
  return { notes: displayed, totalNoteCount: notes.length, omittedNoteCount: notes.length - displayed.length };
}

function midiNoteFitsPreview(note: NoteDescription, clipDuration: number): boolean {
  return Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
    Number.isFinite(note.startTime) && note.startTime >= 0 && note.startTime < clipDuration &&
    Number.isFinite(note.duration) && note.duration > 0 &&
    note.startTime + note.duration <= clipDuration + 1e-7 &&
    [note.velocity, note.probability, note.velocityDeviation, note.releaseVelocity]
      .every((value) => value === undefined || Number.isFinite(value)) &&
    [note.muted, note.selected].every((value) => value === undefined || typeof value === "boolean");
}

function warpMarkerIdentity(
  marker: import("@ableton-extensions/sdk").WarpMarker,
): object {
  return {
    sampleTime: marker.sampleTime,
    beatTime: marker.beatTime,
  };
}

function requireHandleIdentity(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Could not verify ${label} handle identity.`);
  }
  const id = (value as { handle?: { id?: unknown } }).handle?.id;
  if (
    (typeof id !== "bigint" && typeof id !== "number" && typeof id !== "string") ||
    String(id).length === 0
  ) {
    throw new Error(`Could not verify ${label} handle identity.`);
  }
  return String(id);
}

function fingerprint(type: AgentAction["type"], state: object): string {
  return JSON.stringify(
    { type, state },
    (_key, value: unknown) =>
      typeof value === "bigint"
        ? { $liveSmithBigInt: value.toString() }
        : value,
  );
}
