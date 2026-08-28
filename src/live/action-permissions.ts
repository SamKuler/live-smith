import {
  AudioClip,
  DrumRack,
  MidiClip,
  RackDevice,
  type Clip,
  type ExtensionContext,
  type Scene,
  type Track,
} from "@ableton-extensions/sdk";

import type { AgentAction, AgentPlan } from "../agent/actions.js";
import { EDIT_SCOPES, type EditScope } from "../agent/edit-scopes.js";
import {
  boundTrackForAction,
  type AgentPlanBindings,
} from "./action-bindings.js";
import { affectedTrackTree } from "./resolve.js";

type Api = ExtensionContext<"1.0.0">;

export function requiredEditScopesForPlan(
  context: Api,
  plan: AgentPlan,
  bindings: AgentPlanBindings,
): EditScope[] {
  const required = new Set<EditScope>();
  plan.actions.forEach((action, index) => {
    for (const scope of requiredEditScopesForAction(context, action, index, bindings)) {
      required.add(scope);
    }
  });
  return EDIT_SCOPES.filter((scope) => required.has(scope));
}

/** Re-read bound host objects when authorizing the action immediately before execution. */
export function requiredEditScopesForAction(
  context: Api,
  action: AgentAction,
  actionIndex: number,
  bindings: AgentPlanBindings,
): EditScope[] {
  switch (action.type) {
    case "create_midi_clip":
    case "replace_midi_clip_segment":
    case "transpose_midi_notes":
    case "quantize_midi_notes":
    case "scale_midi_velocity":
    case "shift_midi_notes":
      return ["midi"];
    case "create_arrangement_audio_clip":
    case "set_audio_clip_warp":
      return ["audio"];
    case "create_session_midi_clip":
    case "create_session_audio_clip": {
      const required = new Set<EditScope>([
        action.type === "create_session_midi_clip" ? "midi" : "audio",
      ]);
      const slot = bindings.actionObjects.get(actionIndex)?.slot;
      // Replacing a slot also deletes its previous Clip; a creator-ref has no slot yet.
      if (slot && slot.clip !== null) required.add(clipScope(slot.clip));
      return EDIT_SCOPES.filter((scope) => required.has(scope));
    }
    case "insert_device":
    case "insert_chain_device":
    case "set_device_parameter":
    case "replace_simpler_sample":
      return ["devices"];
    case "create_rack_chain":
      return ["devices", "mixer"];
    case "duplicate_device":
    case "delete_device": {
      const device = bindings.actionObjects.get(actionIndex)?.deviceTarget?.device;
      if (!device) throw unidentifiedTarget("Device");
      return device instanceof RackDevice && device.chains.length
        ? ["devices", "mixer"]
        : ["devices"];
    }
    case "configure_drum_pad": {
      const rack = bindings.actionObjects.get(actionIndex)?.deviceTarget?.device;
      if (!(rack instanceof DrumRack)) throw unidentifiedTarget("Drum Rack");
      const createsChain = action.mode === "fill_empty_pad" &&
        !rack.chains.some((chain) => chain.receivingNote === action.receivingNote);
      return createsChain ? ["devices", "mixer"] : ["devices"];
    }
    case "set_track_mute":
    case "set_track_solo":
    case "set_track_arm":
    case "set_track_mixer_parameter":
    case "set_chain_mixer_parameter":
      return ["mixer"];
    case "create_midi_track":
    case "create_audio_track":
    case "rename_track":
    case "create_scene":
    case "rename_scene":
    case "create_cue_point":
    case "rename_cue_point":
    case "delete_cue_point":
    case "create_take_lane":
    case "rename_take_lane":
    case "set_tempo":
      return ["structure"];
    case "set_clip_properties":
    case "delete_clip":
    case "delete_session_clip":
      return [clipScope(bindings.actionObjects.get(actionIndex)?.clip)];
    case "delete_track":
    case "duplicate_track": {
      const track = requireActionTrack(action, actionIndex, bindings);
      // A whole-track operation also copies/deletes its mixer state.
      const required = new Set<EditScope>(["structure", "mixer"]);
      for (const affected of affectedTrackTree(context, track)) {
        addClipScopes(required, affected.arrangementClips);
        for (const slot of affected.clipSlots) {
          if (slot.clip !== null) required.add(clipScope(slot.clip));
        }
        for (const lane of affected.takeLanes) addClipScopes(required, lane.clips);
        if (affected.devices.length) required.add("devices");
      }
      return EDIT_SCOPES.filter((scope) => required.has(scope));
    }
    case "delete_scene":
    case "duplicate_scene": {
      const scene = bindings.actionObjects.get(actionIndex)?.scene;
      if (!scene) throw unidentifiedTarget("Scene");
      const row = sceneRow(context, scene);
      const required = new Set<EditScope>(["structure"]);
      for (const track of context.application.song.tracks) {
        const slot = track.clipSlots[row];
        if (!slot) throw unidentifiedTarget("Scene Clip Slot");
        if (slot.clip !== null) required.add(clipScope(slot.clip));
      }
      return EDIT_SCOPES.filter((scope) => required.has(scope));
    }
    case "clear_arrangement_range": {
      const track = requireActionTrack(action, actionIndex, bindings);
      const required = new Set<EditScope>();
      for (const clip of track.arrangementClips) {
        // Match the executor's overlap test, including boundary truncations.
        if (clip.startTime < action.endBeat &&
          clip.startTime + clip.duration > action.startBeat) {
          required.add(clipScope(clip));
        }
      }
      return EDIT_SCOPES.filter((scope) => required.has(scope));
    }
    default:
      return unclassifiedAction(action);
  }
}

function clipScope(clip: Clip<"1.0.0"> | undefined): EditScope {
  if (clip instanceof MidiClip) return "midi";
  if (clip instanceof AudioClip) return "audio";
  throw unidentifiedTarget("MIDI or Audio Clip");
}

function addClipScopes(required: Set<EditScope>, clips: readonly Clip<"1.0.0">[]): void {
  for (const clip of clips) required.add(clipScope(clip));
}

function requireActionTrack(
  action: AgentAction,
  actionIndex: number,
  bindings: AgentPlanBindings,
): Track<"1.0.0"> {
  const track = boundTrackForAction(action, actionIndex, bindings);
  if (!track) throw unidentifiedTarget("Track");
  return track;
}

function sceneRow(context: Api, scene: Scene<"1.0.0">): number {
  const id = handleId(scene);
  const row = context.application.song.scenes.findIndex((current) => handleId(current) === id);
  if (row < 0) throw unidentifiedTarget("current Scene");
  return row;
}

function handleId(value: { handle: { id: unknown } }): string {
  const id = value.handle?.id;
  if (id === undefined || id === null) throw unidentifiedTarget("Live object handle");
  return String(id);
}

function unidentifiedTarget(label: string): Error {
  return new Error(
    `Cannot determine the edit scope of the bound ${label}. Inspect the current target and use a staged Apply before editing it.`,
  );
}

function unclassifiedAction(_action: never): never {
  throw new Error("No edit-scope classification exists for this Live action.");
}
