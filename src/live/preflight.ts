import {
  AudioTrack,
  AudioClip,
  DrumRack,
  MidiClip,
  MidiTrack,
  RackDevice,
  Simpler,
  type Chain,
  type Device,
  type DeviceParameter,
  type ExtensionContext,
  type Track,
} from "@ableton-extensions/sdk";

import type { AgentAction } from "../agent/actions.js";
import { findBestParameterMatch } from "./parameter-match.js";
import { resolveDeviceTarget } from "./device-tree.js";
import {
  equalsLoose,
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

type Api = ExtensionContext<"1.0.0">;

export async function captureLiveActionPreflightSnapshot(
  context: Api,
  action: AgentAction,
  target: LiveTarget,
): Promise<string> {
  const song = context.application.song;
  const songIdentity = requireHandleIdentity(song, "Live Set");

  switch (action.type) {
    case "create_midi_track": {
      const matches = action.name
        ? song.tracks.filter(
            (track) =>
              track instanceof MidiTrack && equalsLoose(track.name, action.name!),
          )
        : [];
      if (action.ref && matches.length > 1) {
        throw new Error(
          `Track ref "${action.ref}" is ambiguous because ${matches.length} MIDI tracks match "${action.name}".`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        matchingTracks: matches.map((track) => requireHandleIdentity(track, "MIDI track")),
      });
    }
    case "create_audio_track": {
      const matches = action.name
        ? song.tracks.filter(
            (track) =>
              track instanceof AudioTrack && equalsLoose(track.name, action.name!),
          )
        : [];
      if (action.ref && matches.length > 1) {
        throw new Error(
          `Track ref "${action.ref}" is ambiguous because ${matches.length} audio tracks match "${action.name}".`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        matchingTracks: matches.map((track) => requireHandleIdentity(track, "audio track")),
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
    case "rename_scene":
    case "duplicate_scene":
    case "delete_scene": {
      const scene = resolveScene(song, action.sceneIndex, action.sceneName);
      return fingerprint(action.type, {
        song: songIdentity,
        scene: sceneIdentity(scene),
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
      const matchingClip = action.name
        ? findReusableMidiClip(
            track,
            action.name,
            action.startBeat,
            action.durationBeats,
          )
        : undefined;
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
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
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        slot: {
          id: requireHandleIdentity(slot, "clip slot"),
          clip: slot.clip ? clipContentIdentity(slot.clip) : null,
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
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        clip: clipContentIdentity(clip),
      });
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
      const resolved = resolveDeviceTarget(
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
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        rackPath: resolved.path,
        rack: await deviceContentIdentity(resolved.device),
        chain: await chainContentIdentity(chain),
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
      const parameter = findBestParameterMatch(action.parameterName, device.parameters);
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
      const currentValue = await parameter.getValue();
      if (!Number.isFinite(currentValue)) {
        throw new Error(
          `Could not verify the current value for parameter "${parameter.name}" on device "${device.name}".`,
        );
      }
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        device: {
          id: requireHandleIdentity(device, "device"),
          name: device.name,
          path,
        },
        parameter: {
          id: requireHandleIdentity(parameter, "device parameter"),
          name: parameter.name,
          min: parameter.min,
          max: parameter.max,
          currentValue,
        },
      });
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
        parent: await deviceContainerIdentity(resolved.parent),
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
      const source = resolveSampleSource(context, action.source, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        path: resolved.path,
        simpler: await deviceContentIdentity(resolved.device),
        currentSample: resolved.device.sample
          ? {
              id: requireHandleIdentity(resolved.device.sample, "Simpler sample"),
              filePath: resolved.device.sample.filePath,
            }
          : null,
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
      const matchingChains = resolved.device.chains.filter(
        (chain) => chain.receivingNote === action.receivingNote,
      );
      if (matchingChains.length > 1) {
        throw new Error(
          `Drum Rack "${resolved.device.name}" has ${matchingChains.length} chains receiving MIDI note ${action.receivingNote}; resolve the duplicate pads in Live first.`,
        );
      }
      const source = resolveSampleSource(context, action.source, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        path: resolved.path,
        rack: await deviceContentIdentity(resolved.device),
        source: sampleSourceIdentity(source),
      });
    }
    case "create_arrangement_audio_clip": {
      const track = resolveTrack(context, action.trackName, target);
      if (!(track instanceof AudioTrack)) {
        throw new Error(`Track "${track.name}" is not an audio track.`);
      }
      const source = resolveSampleSource(context, action.source, target);
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        arrangementClips: track.arrangementClips.map(clipContentIdentity),
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
      const source = resolveSampleSource(context, action.source, target);
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
      const currentValue = await verifiedParameterValue(parameter, "track mixer");
      return fingerprint(action.type, {
        song: songIdentity,
        track: trackIdentity(track),
        parameter: parameterIdentity(parameter, currentValue),
      });
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
        track: trackContentIdentity(track),
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

function parameterIdentity(
  parameter: DeviceParameter<"1.0.0">,
  currentValue: number,
): object {
  return {
    id: requireHandleIdentity(parameter, "device parameter"),
    name: parameter.name,
    min: parameter.min,
    max: parameter.max,
    currentValue,
  };
}

async function deviceContainerIdentity(
  parent: Track<"1.0.0"> | Chain<"1.0.0">,
): Promise<object> {
  return "name" in parent
    ? {
        id: requireHandleIdentity(parent, "device container"),
        name: parent.name,
        devices: await Promise.all(parent.devices.map(deviceContentIdentity)),
      }
    : chainContentIdentity(parent);
}

async function chainContentIdentity(chain: Chain<"1.0.0">): Promise<object> {
  return {
    id: requireHandleIdentity(chain, "device chain"),
    ...("receivingNote" in chain
      ? { receivingNote: (chain as { receivingNote: number }).receivingNote }
      : {}),
    devices: await Promise.all(chain.devices.map(deviceContentIdentity)),
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
  };
}

function sampleSourceIdentity(
  source: ReturnType<typeof resolveSampleSource>,
): object {
  return {
    id: requireHandleIdentity(source.object, "sample source"),
    filePath: source.filePath,
  };
}

function trackIdentity(track: Track<"1.0.0">): object {
  return {
    id: requireHandleIdentity(track, "track"),
    name: track.name,
  };
}

function trackContentIdentity(track: Track<"1.0.0">): object {
  return {
    ...trackIdentity(track),
    devices: track.devices.map((device) => ({
      id: requireHandleIdentity(device, "device"),
      name: device.name,
    })),
    arrangementClips: track.arrangementClips.map(clipContentIdentity),
    clipSlots: track.clipSlots.map((slot) => ({
      id: requireHandleIdentity(slot, "clip slot"),
      clip: slot.clip ? clipContentIdentity(slot.clip) : null,
    })),
  };
}

function clipContentIdentity(clip: import("@ableton-extensions/sdk").Clip<"1.0.0">): object {
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
    ...(clip instanceof MidiClip ? { notes: clip.notes } : {}),
    ...(clip instanceof AudioClip
      ? {
          filePath: clip.filePath,
          warping: clip.warping,
          warpMode: clip.warpMode,
          warpMarkers: clip.warpMarkers,
        }
      : {}),
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
  return JSON.stringify({ type, state });
}
