import {
  agentActionExample,
  agentActionPromptExamples,
  parseAgentAction,
  type AgentAction,
} from "./action-schema.js";
import type { DevicePath } from "../live/device-tree.js";

export type { AgentAction } from "./action-schema.js";

export type AgentPlanTarget =
  | { trackName: string; trackRole?: never; trackIndex?: never }
  | { trackRole: "return"; trackIndex: number; trackName?: string }
  | { trackRole: "main"; trackName?: string; trackIndex?: never };

export interface AgentPlan {
  message: string;
  targets?: Record<string, AgentPlanTarget>;
  resolvesPriorFailure?: boolean;
  actions: AgentAction[];
}

const NON_REGULAR_TRACK_ACTION_TYPES = new Set<AgentAction["type"]>([
  "insert_device",
  "insert_chain_device",
  "create_rack_chain",
  "set_device_parameter",
  "duplicate_device",
  "delete_device",
  "set_track_mixer_parameter",
  "set_chain_mixer_parameter",
]);

export function supportsNonRegularTrackAction(action: AgentAction): boolean {
  return NON_REGULAR_TRACK_ACTION_TYPES.has(action.type);
}

export interface ObservationItemPage {
  itemOffset?: number;
  itemLimit?: number;
}

export interface ObservationParameterPage {
  parameterOffset?: number;
  parameterLimit?: number;
  valueItemOffset?: number;
  valueItemLimit?: number;
}

export interface ObservationTrackSelector {
  trackName?: string;
  trackRole?: "return" | "main";
  trackIndex?: number;
}

type MidiTransformAction = Extract<AgentAction, {
  type:
    | "transpose_midi_notes"
    | "quantize_midi_notes"
    | "scale_midi_velocity"
    | "shift_midi_notes";
}>;

const referencePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function requiresExplicitConfirmation(plan: AgentPlan): boolean {
  return plan.actions.some(
    (action) =>
      action.type === "delete_track" ||
      action.type === "delete_device" ||
      action.type === "delete_scene" ||
      action.type === "delete_cue_point" ||
      action.type === "delete_clip" ||
      action.type === "delete_session_clip" ||
      action.type === "clear_arrangement_range" ||
      action.type === "create_midi_clip" ||
      action.type === "create_session_midi_clip" ||
      action.type === "replace_midi_clip_segment" ||
      action.type === "transpose_midi_notes" ||
      action.type === "quantize_midi_notes" ||
      action.type === "scale_midi_velocity" ||
      action.type === "shift_midi_notes" ||
      action.type === "create_arrangement_audio_clip" ||
      action.type === "create_session_audio_clip" ||
      action.type === "replace_simpler_sample" ||
      (action.type === "configure_drum_pad" &&
        action.mode === "replace_existing_simpler"),
  );
}

export type AgentObservationRequest =
  | { type: "inspect_live_set" }
  | ({ type: "inspect_current_object" } & ObservationItemPage & ObservationParameterPage)
  | ({ type: "inspect_track" } & ObservationTrackSelector & ObservationItemPage & ObservationParameterPage)
  | ({
      type: "inspect_device";
      deviceName: string;
      deviceIndex?: number;
    } & ObservationTrackSelector & ObservationParameterPage)
  | ({
      type: "inspect_device_tree";
      deviceName?: string;
      devicePath?: DevicePath;
    } & ObservationTrackSelector & ObservationItemPage & ObservationParameterPage)
  | ({
      type: "inspect_rack_chain";
      rackName: string;
      rackPath?: DevicePath;
      chainIndex: number;
    } & ObservationTrackSelector & ObservationItemPage)
  | ({ type: "inspect_mixer" } & ObservationTrackSelector)
  | ({
      type: "inspect_take_lane";
      trackName?: string;
      laneIndex: number;
      laneName?: string;
    } & ObservationItemPage)
  | ({
      type: "inspect_clip";
      trackName?: string;
      clipName?: string;
      startBeat?: number;
      slotIndex?: number;
    } & ObservationItemPage)
  | {
      type: "inspect_midi_clip";
      trackName?: string;
      clipName?: string;
      startBeat?: number;
      slotIndex?: number;
      noteOffset?: number;
      noteLimit?: number;
    }
  | {
      type: "analyze_audio_clip";
      trackName?: string;
      clipName?: string;
      startBeat?: number;
    }
  | {
      type: "read_arrangement_audio";
      trackName?: string;
      clipName?: string;
      clipStartBeat?: number;
      startBeat: number;
      endBeat: number;
    }
  | ({ type: "inspect_song_info" } & ObservationItemPage);

export function observationRequestForAction(
  action: AgentAction,
  trackOverride?: string | ObservationTrackSelector,
): AgentObservationRequest {
  const selectorOverride = typeof trackOverride === "string"
    ? { trackName: trackOverride }
    : trackOverride;
  const trackName = selectorOverride?.trackName ?? (
    "trackName" in action ? action.trackName : undefined
  );
  const optionalTrackName = trackName ? { trackName } : {};
  const optionalRoleTrack = selectorOverride?.trackRole
    ? {
        ...optionalTrackName,
        trackRole: selectorOverride.trackRole,
        ...(selectorOverride.trackIndex === undefined
          ? {}
          : { trackIndex: selectorOverride.trackIndex }),
      }
    : optionalTrackName;

  switch (action.type) {
    case "create_midi_track":
    case "create_audio_track":
      return trackName
        ? { type: "inspect_track", trackName }
        : { type: "inspect_live_set" };
    case "create_scene":
      return action.index !== undefined && action.index >= 0
        ? {
            type: "inspect_song_info",
            itemOffset: action.index,
            itemLimit: 1,
          }
        : { type: "inspect_song_info" };
    case "rename_scene":
    case "duplicate_scene":
    case "delete_scene":
      return {
        type: "inspect_song_info",
        itemOffset: action.sceneIndex,
        itemLimit: 1,
      };
    case "create_cue_point":
    case "rename_cue_point":
    case "delete_cue_point":
    case "set_tempo":
      return { type: "inspect_song_info" };
    case "clear_arrangement_range":
    case "rename_track":
    case "delete_track":
    case "duplicate_track":
    case "set_track_mute":
    case "set_track_solo":
    case "set_track_arm":
    case "create_take_lane":
    case "delete_clip":
      return { type: "inspect_track", ...optionalTrackName };
    case "create_midi_clip":
    case "create_arrangement_audio_clip":
    case "rename_take_lane":
      return action.laneIndex === undefined
        ? { type: "inspect_track", ...optionalTrackName }
        : {
            type: "inspect_take_lane",
            ...optionalTrackName,
            laneIndex: action.laneIndex,
            ...(action.laneName ? { laneName: action.laneName } : {}),
          };
    case "insert_device":
      return {
        type: "inspect_track",
        ...optionalRoleTrack,
        ...(action.index === undefined
          ? {}
          : { itemOffset: action.index, itemLimit: 1 }),
      };
    case "create_session_midi_clip":
    case "create_session_audio_clip":
    case "delete_session_clip":
      return {
        type: "inspect_clip",
        ...optionalTrackName,
        ...(action.type === "delete_session_clip" && action.clipName
          ? { clipName: action.clipName }
          : {}),
        slotIndex: action.slotIndex,
      };
    case "replace_midi_clip_segment":
      return {
        type: "inspect_midi_clip",
        ...optionalTrackName,
        clipName: action.clipName,
        startBeat: action.startBeat,
      };
    case "transpose_midi_notes":
    case "quantize_midi_notes":
    case "scale_midi_velocity":
    case "shift_midi_notes":
      return {
        type: "inspect_midi_clip",
        ...optionalTrackName,
        ...(action.clipName ? { clipName: action.clipName } : {}),
        ...(action.startBeat === undefined ? {} : { startBeat: action.startBeat }),
        ...(action.slotIndex === undefined ? {} : { slotIndex: action.slotIndex }),
      };
    case "set_device_parameter":
      return action.devicePath
        ? {
            type: "inspect_device_tree",
            ...optionalRoleTrack,
            deviceName: action.deviceName,
            devicePath: action.devicePath,
          }
        : {
            type: "inspect_device",
            ...optionalRoleTrack,
            deviceName: action.deviceName,
            ...(action.deviceIndex === undefined
              ? {}
              : { deviceIndex: action.deviceIndex }),
          };
    case "duplicate_device":
    case "delete_device":
      return !action.devicePath && action.deviceIndex !== undefined
        ? {
            type: "inspect_device",
            ...optionalRoleTrack,
            deviceName: action.deviceName,
            deviceIndex: action.deviceIndex,
          }
        : {
            type: "inspect_device_tree",
            ...optionalRoleTrack,
            deviceName: action.deviceName,
            ...(action.devicePath ? { devicePath: action.devicePath } : {}),
          };
    case "insert_chain_device":
      return {
        type: "inspect_rack_chain",
        ...optionalRoleTrack,
        rackName: action.rackName,
        ...(action.rackPath ? { rackPath: action.rackPath } : {}),
        chainIndex: action.chainIndex,
        ...(action.index === undefined
          ? {}
          : { itemOffset: action.index, itemLimit: 1 }),
      };
    case "create_rack_chain":
      return {
        type: "inspect_device_tree",
        ...optionalRoleTrack,
        deviceName: action.rackName,
        ...(action.rackPath ? { devicePath: action.rackPath } : {}),
      };
    case "replace_simpler_sample":
      return {
        type: "inspect_device_tree",
        ...optionalTrackName,
        deviceName: action.simplerName,
        ...(action.simplerPath ? { devicePath: action.simplerPath } : {}),
      };
    case "configure_drum_pad":
      return {
        type: "inspect_device_tree",
        ...optionalTrackName,
        deviceName: action.rackName,
        ...(action.rackPath ? { devicePath: action.rackPath } : {}),
      };
    case "set_track_mixer_parameter":
      return { type: "inspect_mixer", ...optionalRoleTrack };
    case "set_chain_mixer_parameter":
      return {
        type: "inspect_rack_chain",
        ...optionalRoleTrack,
        rackName: action.rackName,
        ...(action.rackPath ? { rackPath: action.rackPath } : {}),
        chainIndex: action.chainIndex,
      };
    case "set_clip_properties":
    case "set_audio_clip_warp":
      return {
        type: "inspect_clip",
        ...optionalTrackName,
        ...(action.clipName ? { clipName: action.clipName } : {}),
        ...(action.startBeat === undefined ? {} : { startBeat: action.startBeat }),
        ...(action.slotIndex === undefined ? {} : { slotIndex: action.slotIndex }),
      };
    default:
      return assertNever(action);
  }
}

export function validateAgentPlan(response: unknown): AgentPlan {
  if (!isRecord(response)) {
    throw new Error("Action plan must be a JSON object.");
  }
  const message = requiredPlanMessage(response.message);
  if (!Array.isArray(response.actions)) {
    throw new Error("Action plan requires an actions array.");
  }
  if (!response.actions.length) {
    throw new Error("Action plan requires at least one action.");
  }

  for (const key of Object.keys(response)) {
    if (
      key !== "message" &&
      key !== "targets" &&
      key !== "resolvesPriorFailure" &&
      key !== "actions"
    ) {
      throw new Error(`Action plan does not support property ${key}.`);
    }
  }
  if (
    response.resolvesPriorFailure !== undefined &&
    typeof response.resolvesPriorFailure !== "boolean"
  ) {
    throw new Error("resolvesPriorFailure must be a boolean when provided.");
  }

  const targets = parsePlanTargets(response.targets);
  const actions = response.actions.map((action, index) => {
    try {
      return parseAgentAction(action);
    } catch (error) {
      const actionType = isRecord(action) && typeof action.type === "string"
        ? action.type
        : undefined;
      throw contextualActionValidationError(
        index,
        actionType,
        error,
      );
    }
  });
  actions.forEach((action, index) => {
    try {
      validateMidiActionTiming(action);
      validateActionLocators(action);
    } catch (error) {
      throw contextualActionValidationError(index, action.type, error);
    }
  });
  try {
    validateTrackReferenceGraph(targets, actions);
    validateMidiSegmentRanges(actions);
    validateSceneIndexStability(actions);
  } catch (error) {
    throw contextualizeIndexedPlanError(error, actions);
  }

  return {
    message,
    ...(Object.keys(targets).length ? { targets } : {}),
    ...(response.resolvesPriorFailure === true
      ? { resolvesPriorFailure: true }
      : {}),
    actions,
  };
}

export function summarizeActionPlan(plan: AgentPlan): string {
  if (!plan.actions.length) return plan.message;

  return [
    plan.message,
    ...(plan.resolvesPriorFailure
      ? ["", "Recovery: resolve the prior unfinished Live operation after this plan succeeds."]
      : []),
    "",
    "Actions:",
    ...plan.actions.map((action, index) => `${index + 1}. ${summarizeAgentAction(action)}`),
  ].join("\n");
}

export function actionSystemPrompt(): string {
  return [
    "You are Live Smith, running inside Ableton Live with tools.",
    "Use inspect_current_object first when the Session was opened from a specific Live object. Use inspect_live_set, inspect_song_info, inspect_track, inspect_take_lane, inspect_device_tree, inspect_rack_chain, inspect_device, inspect_mixer, inspect_clip, inspect_midi_clip, and analyze_audio_clip to inspect the exact current Live state needed by the next edit.",
    "Observation collections and device parameters are paged. When a result reports nextOffset, call the same inspection again with the corresponding itemOffset, parameterOffset, or valueItemOffset until the exact target is visible. Never infer an omitted item.",
    "The Extensions SDK cannot list or search every built-in device available in the current Live edition. Device insertion validates an exact name only when Live executes it, and the beta SDK does not expose the rejection cause. If insertion fails, preserve the failure as cause-unknown, inspect the current device chain, and decide from observed state whether to adjust placement, retry after a state repair, choose another exact name, or explain that no safe repair is known.",
    "Use inspect_midi_clip before analyzing or rewriting MIDI harmony, melody, voicing, or chord correctness unless the exact notes are already in context. For long clips, follow noteOffset pagination until every note has been inspected.",
    "If a user asks you to modify a device and you do not have the exact exposed parameter names in the current context, call inspect_device for a top-level device or inspect_device_tree for a nested Rack device first. Use inspect_rack_chain for an existing Rack Chain and its Volume, Panning, and Sends. Preserve and reuse the observed devicePath; do not guess Rack or chain indexes.",
    "For newly inserted devices, first call apply_live_actions to create the track/device chain, then inspect the inserted devices, then call apply_live_actions again to set exact observed parameters. This staged workflow and a single complete confirmed plan are both supported; choose based on whether later steps require newly observed state.",
    "Within one apply_live_actions call, use targets plus trackRef for existing tracks that may be renamed. Track-creating actions may declare ref for later actions in the same call. Never target a later action by a name created by an earlier rename.",
    'Return and Main tracks use explicit plan targets plus trackRef: {"trackRole":"return","trackIndex":0,"trackName":"A-Reverb"} or {"trackRole":"main","trackName":"Main"}. The name is an optional stale-state guard. These targets support device-chain actions and Track or Rack Chain mixer parameters; never use them for Clips, Take Lanes, Arm, mute/solo, rename, duplicate, or delete Track actions.',
    'Example for rename then edit in one call: {"message":"Build pads","targets":{"pads":{"trackName":"1-MIDI"}},"actions":[{"type":"rename_track","trackRef":"pads","newName":"Dream Pads"},{"type":"insert_device","trackRef":"pads","deviceName":"Auto Filter"}]}.',
    "Use one apply_live_actions call when every note and device choice is already known and one confirmation is appropriate.",
    "For main Arrangement-lane MIDI, use one whole-Clip create_midi_clip action when the complete result is known and fits within 4096 notes. For larger or staged work, first create one named empty full-duration Clip in its own apply_live_actions call, then inspect that exact Clip and use replace_midi_clip_segment for non-overlapping relative-time ranges in later calls.",
    "To create a Clip in an existing Take Lane, add its observed 0-based laneIndex and optional current laneName guard to create_midi_clip or create_arrangement_audio_clip. Take Lane MIDI supports only one whole-Clip creation or exact named update of at most 4096 notes; segmented replacement and MIDI transforms remain limited to main Arrangement and Session Clips. Take Lane audio creation also requires durationBeats. The requested range must not overlap an existing Clip in that lane. Create a new Take Lane, inspect it, and write its Clip in a later staged apply call.",
    "replace_midi_clip_segment replaces every existing note that overlaps its range; it does not append. Each staged apply_live_actions call gets a separate confirmation and remains in the same Session. Never recreate the empty Clip or repeat a completed segment.",
    "Use transpose_midi_notes, quantize_midi_notes, scale_midi_velocity, or shift_midi_notes for deterministic whole-Clip edits of main Arrangement or Session Clips instead of regenerating unchanged notes. Each transform fails without mutation if any resulting pitch or note interval would leave the valid MIDI or Clip bounds.",
    "Use staged apply/inspect/apply calls when later edits require newly observed Live state; all stages stay in the same Session.",
    "When a track contains multiple top-level devices with the same name, use the 0-based deviceIndex shown by inspect_track. For Rack devices, use the complete devicePath shown by inspect_device_tree.",
    "create_rack_chain appends one empty Chain to an existing non-Drum Rack. Use at most one such creation per Rack target in an apply_live_actions call, then inspect the returned Chain index with inspect_rack_chain before inserting devices or changing its mixer in a later staged call. The SDK does not expose Chain names, deletion, duplication, or reordering. Drum Rack pad creation remains configure_drum_pad so receiving-note uniqueness and partial completion stay explicit.",
    "A Drum Rack or Simpler inserted by exact device name is empty unless its sample content is configured. configure_drum_pad with mode fill_empty_pad only fills a new or device-empty pad. Replacing an occupied pad requires mode replace_existing_simpler plus the exact observed simplerPath and explicit confirmation. Use SampleSource values that refer to the selected Live object, an observed arrangement/session audio Clip, or an observed Simpler. Never request, infer, or emit a filesystem path.",
    "Arrangement and Session are different locations. Use startBeat for Arrangement Clips and slotIndex for Session Clips, inspect the exact location before editing, and disclose replacement or deletion behavior in the plan.",
    "Scenes are Session View rows even when Live currently shows Arrangement. Only create, rename, duplicate, or delete Scenes when the user requested Session View structure or the observed workflow requires it; use Cue Points for Arrangement song-section markers. For rename_scene, sceneIndex identifies the target and newName is the desired name. sceneName is only an optional exact observed current-name guard; omit sceneName when it is unknown or blank.",
    "The SDK cannot browse preset packs, search the Live Browser, or insert a VST by plug-in identifier. Existing VST devices can still be inspected, have exposed parameters edited, and be duplicated or deleted through the generic device tools. Never claim that an unavailable preset, browser result, or VST was loaded.",
    "For large device edits, split work into smaller tool calls instead of putting every device parameter into one huge call.",
    "Every factual premise that affects a Live mutation must be supported by evidence available in the current request context or obtained through a tool. If the required evidence is missing, use an available tool to obtain it; otherwise ask the user. Model memory is not evidence.",
    "If a tool result reports completed or reused actions after a failure, do not repeat those actions. Inspect the track and continue only with missing steps.",
    "While repairing an unfinished Apply, successful intermediate apply_live_actions calls remain part of the same recovery operation and their completed actions also become replay-protected. Set resolvesPriorFailure to true only on the final repair Apply that completes or safely replaces every missing step. Omit it while more repair work remains. Do not use it when no prior Live failure is active.",
    "Never guess parameter names. Use the exact names from observations, for example Auto Filter uses Env Amount / Env Attack / Env Release rather than Envelope.",
    "To modify Live, call apply_live_actions. The user will confirm before the extension executes those actions.",
    "After a tool result comes back, continue the loop: inspect more, apply actions, or provide a final concise answer.",
    "Use inspect_song_info to check tempo, scale, Session View Scene layout, and Arrangement Cue Points before making song-level changes.",
    "Allowed apply_live_actions action types:",
    ...agentActionPromptExamples(),
    "Notes use MIDI pitch 0-127, startTime/duration in beats, velocity 1-127.",
    "Parameter values must be normalized/internal values within the parameter min/max range shown in context.",
    "Do not output unsupported actions, realtime audio/MIDI routing, Live Browser or preset search, direct third-party plugin loading, or filesystem paths.",
  ].join("\n");
}

export function summarizeAgentAction(action: AgentAction): string {
  switch (action.type) {
    case "create_midi_track":
      return `Create MIDI track${action.name ? ` "${action.name}"` : ""}${action.ref ? ` as track ref "${action.ref}"` : ""}.`;
    case "create_audio_track":
      return `Create audio track${action.name ? ` "${action.name}"` : ""}${action.ref ? ` as track ref "${action.ref}"` : ""}.`;
    case "create_scene":
      return `Create Session View Scene${action.name ? ` "${action.name}"` : ""}${action.index !== undefined ? ` at index ${action.index}` : ""}.`;
    case "rename_scene":
      return `Rename Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""} to "${action.newName}".`;
    case "duplicate_scene":
      return `Duplicate Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}.`;
    case "delete_scene":
      return `Delete Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}.`;
    case "create_cue_point":
      return `Create Arrangement Cue Point${action.name ? ` "${action.name}"` : ""} at beat ${action.timeBeat}.`;
    case "rename_cue_point":
      return `Rename Arrangement Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat} to "${action.newName}".`;
    case "delete_cue_point":
      return `Delete Arrangement Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat}.`;
    case "create_midi_clip":
      return action.laneIndex === undefined
        ? `Create or replace MIDI clip${action.name ? ` "${action.name}"` : ""} on ${targetTrack(action)} from beat ${action.startBeat} for ${action.durationBeats} beats with ${action.notes.length} notes.`
        : `${action.name ? "Create or update exact" : "Create"} MIDI clip${action.name ? ` "${action.name}"` : ""} in Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""} on ${targetTrack(action)} from beat ${action.startBeat} for ${action.durationBeats} beats with ${action.notes.length} notes; creating requires an empty lane range.`;
    case "create_session_midi_clip":
      return `Create or replace Session MIDI clip${action.name ? ` "${action.name}"` : ""} in slot ${action.slotIndex} on ${targetTrack(action)} for ${action.durationBeats} beats with ${action.notes.length} notes.`;
    case "replace_midi_clip_segment":
      return `Replace notes in MIDI clip "${action.clipName}" on ${targetTrack(action)} at arrangement beat ${action.startBeat}, relative beats ${action.segmentStartTime}-${action.segmentStartTime + action.segmentDurationBeats}, with ${action.notes.length} notes.`;
    case "transpose_midi_notes":
      return `Transpose every note in ${clipLocatorText(action)} on ${targetTrack(action)} by ${action.semitones} semitones.`;
    case "quantize_midi_notes":
      return `Quantize every note start in ${clipLocatorText(action)} on ${targetTrack(action)} to a ${action.gridBeats}-beat grid at ${action.strength} strength.`;
    case "scale_midi_velocity":
      return `Scale every note velocity in ${clipLocatorText(action)} on ${targetTrack(action)} by ${action.factor}, rounded and clamped to 1-127.`;
    case "shift_midi_notes":
      return `Shift every note in ${clipLocatorText(action)} on ${targetTrack(action)} by ${action.offsetBeats} beats.`;
    case "insert_device":
      return `Insert Live device "${action.deviceName}" on ${targetTrack(action)} ${action.index === undefined ? "at end" : `at index ${action.index}`}.`;
    case "insert_chain_device":
      return `Insert Live device "${action.deviceName}" in chain ${action.chainIndex} of Rack "${action.rackName}"${action.rackPath ? ` at ${devicePathText(action.rackPath)}` : ""} on ${targetTrack(action)} ${action.index === undefined ? "at end" : `at index ${action.index}`}.`;
    case "create_rack_chain":
      return `Append one empty Chain to non-Drum Rack "${action.rackName}"${action.rackPath ? ` at ${devicePathText(action.rackPath)}` : ""} on ${targetTrack(action)}.`;
    case "set_device_parameter":
      return `Set "${action.parameterName}" on "${action.deviceName}"${deviceLocatorText(action.devicePath, action.deviceIndex)} in ${targetTrack(action)} to ${action.value}.`;
    case "duplicate_device":
      return `Duplicate device "${action.deviceName}"${deviceLocatorText(action.devicePath, action.deviceIndex)} in ${targetTrack(action)}.`;
    case "delete_device":
      return `Delete device "${action.deviceName}"${deviceLocatorText(action.devicePath, action.deviceIndex)} from ${targetTrack(action)}.`;
    case "replace_simpler_sample":
      return `Replace the sample in Simpler "${action.simplerName}"${action.simplerPath ? ` at ${devicePathText(action.simplerPath)}` : ""} on ${targetTrack(action)} using ${sampleSourceText(action.source)}.`;
    case "configure_drum_pad":
      return action.mode === "fill_empty_pad"
        ? `Fill empty MIDI note ${action.receivingNote} in Drum Rack "${action.rackName}"${action.rackPath ? ` at ${devicePathText(action.rackPath)}` : ""} on ${targetTrack(action)} using ${sampleSourceText(action.source)}.`
        : `Replace the sample in Simpler at ${devicePathText(action.simplerPath!)} on MIDI note ${action.receivingNote} in Drum Rack "${action.rackName}"${action.rackPath ? ` at ${devicePathText(action.rackPath)}` : ""} on ${targetTrack(action)} using ${sampleSourceText(action.source)}.`;
    case "create_arrangement_audio_clip":
      return `Create ${action.laneIndex === undefined ? "arrangement" : `Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""}`} audio clip${action.name ? ` "${action.name}"` : ""} on ${targetTrack(action)} at beat ${action.startBeat}${action.durationBeats ? ` for ${action.durationBeats} beats` : " at its natural duration"} using ${sampleSourceText(action.source)}${audioSettingsText(action)}${action.laneIndex === undefined ? "" : "; the lane range must be empty"}.`;
    case "create_session_audio_clip":
      return `Create or replace Session audio clip${action.name ? ` "${action.name}"` : ""} in slot ${action.slotIndex} on ${targetTrack(action)} using ${sampleSourceText(action.source)}${audioSettingsText(action)}. If the source, Warp state, or loop settings differ, delete the existing slot Clip before recreating it.`;
    case "set_tempo":
      return `Set tempo to ${action.tempo} BPM.`;
    case "rename_track":
      return `Rename ${targetTrack(action)} to "${action.newName}".`;
    case "delete_track":
      return `Delete ${targetTrack(action)}.`;
    case "duplicate_track":
      return `Duplicate ${targetTrack(action)}.`;
    case "set_track_mute":
      return `${action.mute ? "Mute" : "Unmute"} ${targetTrack(action)}.`;
    case "set_track_solo":
      return `${action.solo ? "Solo" : "Unsolo"} ${targetTrack(action)}.`;
    case "set_track_arm":
      return `${action.arm ? "Arm" : "Disarm"} ${targetTrack(action)}.`;
    case "set_track_mixer_parameter":
      return `Set ${action.parameter === "send" ? `send ${action.sendIndex}` : action.parameter} on ${targetTrack(action)} to ${action.value}.`;
    case "set_chain_mixer_parameter":
      return `Set ${action.parameter === "send" ? `send ${action.sendIndex}` : action.parameter} on Chain ${action.chainIndex} of Rack "${action.rackName}"${action.rackPath ? ` at ${devicePathText(action.rackPath)}` : ""} on ${targetTrack(action)} to ${action.value}.`;
    case "create_take_lane":
      return `Create Take Lane${action.name ? ` "${action.name}"` : ""} on ${targetTrack(action)}.`;
    case "rename_take_lane":
      return `Rename Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""} on ${targetTrack(action)} to "${action.newName}".`;
    case "set_clip_properties":
      return `Set properties on ${clipLocatorText(action)} on ${targetTrack(action)}${clipPropertyText(action)}.`;
    case "set_audio_clip_warp":
      return `Set audio Warp on ${clipLocatorText(action)} on ${targetTrack(action)}${action.warping === undefined ? "" : `, warping ${action.warping ? "on" : "off"}`}${action.warpMode ? `, mode ${action.warpMode}` : ""}.`;
    case "clear_arrangement_range":
      return `Clear arrangement clips on ${targetTrack(action)} from beat ${action.startBeat} to ${action.endBeat}; clips crossing a boundary will be truncated.`;
    case "delete_clip":
      return `Delete arrangement clip${action.clipName ? ` "${action.clipName}"` : ""} on ${targetTrack(action)} at beat ${action.startBeat}.`;
    case "delete_session_clip":
      return `Delete Session clip${action.clipName ? ` "${action.clipName}"` : ""} in slot ${action.slotIndex} on ${targetTrack(action)}.`;
    default:
      return assertNever(action);
  }
}

function requiredPlanMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Action plan requires string message.");
  }
  return value.trim();
}

function targetTrack(action: { trackName?: string; trackRef?: string }): string {
  if (action.trackRef) return `track ref "${action.trackRef}"`;
  return action.trackName ? `track "${action.trackName}"` : "the target track";
}

function deviceLocatorText(path?: DevicePath, legacyIndex?: number): string {
  if (path) return ` at ${devicePathText(path)}`;
  return legacyIndex === undefined ? "" : ` at deviceIndex ${legacyIndex}`;
}

function devicePathText(path: DevicePath): string {
  return `devicePath ${JSON.stringify(path)}`;
}

function sampleSourceText(source: import("./action-schema.js").SampleSource): string {
  switch (source.kind) {
    case "selected":
      return "the selected Live sample source";
    case "arrangement_audio_clip":
      return `arrangement audio clip${source.clipName ? ` "${source.clipName}"` : ""} on track "${source.trackName}" at beat ${source.startBeat}`;
    case "session_audio_clip":
      return `Session audio clip${source.clipName ? ` "${source.clipName}"` : ""} on track "${source.trackName}" in slot ${source.slotIndex}`;
    case "simpler":
      return `the sample in Simpler "${source.deviceName}"${deviceLocatorText(source.devicePath, source.deviceIndex)} on track "${source.trackName}"`;
  }
}

function audioSettingsText(action: {
  isWarped?: boolean;
  loopSettings?: import("./action-schema.js").ClipLoopSettingsInput;
}): string {
  return [
    action.isWarped === undefined ? "" : `, warped ${action.isWarped}`,
    action.loopSettings
      ? `, loop ${action.loopSettings.loopStart}-${action.loopSettings.loopEnd}, markers ${action.loopSettings.startMarker}-${action.loopSettings.endMarker}, looping ${action.loopSettings.looping}`
      : "",
  ].join("");
}

function clipLocatorText(action: {
  clipName?: string;
  startBeat?: number;
  slotIndex?: number;
}): string {
  const name = action.clipName ? `clip "${action.clipName}"` : "the clip";
  return action.slotIndex === undefined
    ? `${name} at arrangement beat ${action.startBeat}`
    : `${name} in Session slot ${action.slotIndex}`;
}

function clipPropertyText(action: Extract<AgentAction, { type: "set_clip_properties" }>): string {
  return [
    action.newName ? `, rename to "${action.newName}"` : "",
    action.looping === undefined ? "" : `, looping ${action.looping ? "on" : "off"}`,
    action.muted === undefined ? "" : `, muted ${action.muted ? "on" : "off"}`,
    action.color === undefined ? "" : `, color ${action.color}`,
  ].join("");
}

function validateActionLocators(action: AgentAction): void {
  if (
    (action.type === "create_midi_clip" ||
      action.type === "create_arrangement_audio_clip") &&
    action.laneName !== undefined &&
    action.laneIndex === undefined
  ) {
    throw new Error("laneName requires laneIndex.");
  }
  if (
    action.type === "create_arrangement_audio_clip" &&
    action.laneIndex !== undefined &&
    action.durationBeats === undefined
  ) {
    throw new Error("Take Lane audio creation requires durationBeats.");
  }
  if (
    (action.type === "set_device_parameter" ||
      action.type === "duplicate_device" ||
      action.type === "delete_device") &&
    action.devicePath !== undefined &&
    action.deviceIndex !== undefined
  ) {
    throw new Error("Use either devicePath or deviceIndex, not both.");
  }
  if (
    (action.type === "replace_simpler_sample" ||
      action.type === "configure_drum_pad") &&
    action.source.kind === "simpler" &&
    action.source.devicePath !== undefined &&
    action.source.deviceIndex !== undefined
  ) {
    throw new Error("A Simpler sample source must use either devicePath or deviceIndex, not both.");
  }
  if (action.type === "configure_drum_pad") {
    if (
      action.mode === "replace_existing_simpler" &&
      action.simplerPath === undefined
    ) {
      throw new Error(
        "configure_drum_pad mode replace_existing_simpler requires simplerPath from inspect_device_tree.",
      );
    }
    if (action.mode === "fill_empty_pad" && action.simplerPath !== undefined) {
      throw new Error(
        "configure_drum_pad simplerPath is only supported with mode replace_existing_simpler.",
      );
    }
  }
  if (
    action.type === "set_track_mixer_parameter" ||
    action.type === "set_chain_mixer_parameter"
  ) {
    if (action.parameter === "send" && action.sendIndex === undefined) {
      throw new Error(`${action.type} requires sendIndex when parameter is send.`);
    }
    if (action.parameter !== "send" && action.sendIndex !== undefined) {
      throw new Error("sendIndex is only supported when parameter is send.");
    }
  }
  if (action.type === "set_clip_properties" || action.type === "set_audio_clip_warp") {
    validateExclusiveClipLocator(action);
  }
  if (isMidiTransformAction(action)) validateExclusiveClipLocator(action);
  if (
    action.type === "set_clip_properties" &&
    action.newName === undefined &&
    action.looping === undefined &&
    action.muted === undefined &&
    action.color === undefined
  ) {
    throw new Error("set_clip_properties requires at least one property change.");
  }
  if (
    action.type === "set_audio_clip_warp" &&
    action.warping === undefined &&
    action.warpMode === undefined
  ) {
    throw new Error("set_audio_clip_warp requires warping or warpMode.");
  }
  if (
    action.type === "clear_arrangement_range" &&
    action.endBeat <= action.startBeat
  ) {
    throw new Error("clear_arrangement_range requires endBeat greater than startBeat.");
  }
  if (
    action.type === "create_arrangement_audio_clip" ||
    action.type === "create_session_audio_clip"
  ) {
    validateAudioCreationSettings(action.isWarped, action.loopSettings);
  }
}

function validateExclusiveClipLocator(action: {
  startBeat?: number;
  slotIndex?: number;
}): void {
  const count = Number(action.startBeat !== undefined) + Number(action.slotIndex !== undefined);
  if (count !== 1) {
    throw new Error("Clip actions require exactly one of startBeat or slotIndex.");
  }
}

function isMidiTransformAction(action: AgentAction): action is MidiTransformAction {
  return action.type === "transpose_midi_notes" ||
    action.type === "quantize_midi_notes" ||
    action.type === "scale_midi_velocity" ||
    action.type === "shift_midi_notes";
}

function validateAudioCreationSettings(
  isWarped: boolean | undefined,
  loopSettings: import("./action-schema.js").ClipLoopSettingsInput | undefined,
): void {
  if (!loopSettings) return;
  if (isWarped === undefined) {
    throw new Error("Audio clip loopSettings require isWarped to be specified.");
  }
  if (loopSettings.startMarker > loopSettings.endMarker) {
    throw new Error("loopSettings startMarker must not exceed endMarker.");
  }
  if (loopSettings.loopEnd - loopSettings.loopStart < 0.25) {
    throw new Error("loopSettings loop length must be at least 0.25 beats.");
  }
  if (
    !loopSettings.looping &&
    (loopSettings.loopStart !== loopSettings.startMarker ||
      loopSettings.loopEnd !== loopSettings.endMarker)
  ) {
    throw new Error(
      "Non-looping loopSettings require loopStart/startMarker and loopEnd/endMarker to match.",
    );
  }
  if (
    isWarped === false &&
    (loopSettings.looping ||
      loopSettings.startMarker < 0 ||
      loopSettings.endMarker < 0 ||
      loopSettings.loopStart < 0 ||
      loopSettings.loopEnd < 0)
  ) {
    throw new Error(
      "Unwarped audio requires non-negative, non-looping loopSettings.",
    );
  }
}

function validateMidiActionTiming(action: AgentAction): void {
  const tolerance = 1e-7;
  if (
    action.type === "create_midi_clip" ||
    action.type === "create_session_midi_clip"
  ) {
    for (const note of action.notes) {
      const end = note.startTime + note.duration;
      if (note.startTime < -tolerance || end > action.durationBeats + tolerance) {
        throw new Error(
          `MIDI note at ${note.startTime} with duration ${note.duration} must stay inside the Clip bounds 0-${action.durationBeats}.`,
        );
      }
    }
    return;
  }
  if (action.type !== "replace_midi_clip_segment") return;

  const segmentEnd = action.segmentStartTime + action.segmentDurationBeats;
  for (const note of action.notes) {
    const noteEnd = note.startTime + note.duration;
    if (
      note.startTime < action.segmentStartTime - tolerance ||
      noteEnd > segmentEnd + tolerance
    ) {
      throw new Error(
        `MIDI note at ${note.startTime} with duration ${note.duration} must stay inside the segment bounds ${action.segmentStartTime}-${segmentEnd}.`,
      );
    }
  }
}

function validateMidiSegmentRanges(actions: AgentAction[]): void {
  const tolerance = 1e-7;
  const ranges = new Map<
    string,
    Array<{ actionNumber: number; start: number; end: number }>
  >();

  actions.forEach((action, index) => {
    if (action.type !== "replace_midi_clip_segment") return;
    const target = action.trackRef
      ? `ref:${action.trackRef.toLocaleLowerCase()}`
      : action.trackName
        ? `name:${action.trackName.toLocaleLowerCase()}`
        : "selected-track";
    const key = [
      target,
      action.clipName.toLocaleLowerCase(),
      String(action.startBeat),
    ].join("\u0000");
    const start = action.segmentStartTime;
    const end = start + action.segmentDurationBeats;
    const priorRanges = ranges.get(key) ?? [];
    for (const prior of priorRanges) {
      if (start < prior.end - tolerance && prior.start < end - tolerance) {
        throw new Error(
          `Actions ${prior.actionNumber} and ${index + 1} contain overlapping replacements for MIDI clip "${action.clipName}". Use non-overlapping ranges or separate confirmed stages.`,
        );
      }
    }
    priorRanges.push({ actionNumber: index + 1, start, end });
    ranges.set(key, priorRanges);
  });
}

function validateSceneIndexStability(actions: AgentAction[]): void {
  let structuralSceneActionIndex: number | undefined;
  actions.forEach((action, index) => {
    const dependency = sceneIndexDependency(action);
    if (
      structuralSceneActionIndex !== undefined &&
      dependency !== undefined
    ) {
      throw new Error(
        `Actions ${structuralSceneActionIndex + 1} and ${index + 1} combine a structural Scene edit with a later ${dependency}. Scene insertion, duplication, and deletion shift Session View indexes, while preflight must bind existing objects before confirmation. Use a staged apply call, inspect the resulting Session View, then address the later index.`,
      );
    }
    if (isStructuralSceneAction(action)) {
      structuralSceneActionIndex = index;
    }
  });
}

function isStructuralSceneAction(action: AgentAction): boolean {
  return action.type === "create_scene" ||
    action.type === "duplicate_scene" ||
    action.type === "delete_scene";
}

function sceneIndexDependency(action: AgentAction): string | undefined {
  if (
    action.type === "rename_scene" ||
    action.type === "duplicate_scene" ||
    action.type === "delete_scene"
  ) {
    return "Scene index target";
  }
  if (
    action.type === "create_session_midi_clip" ||
    (isMidiTransformAction(action) && action.slotIndex !== undefined) ||
    action.type === "create_session_audio_clip" ||
    action.type === "delete_session_clip" ||
    ((action.type === "set_clip_properties" ||
      action.type === "set_audio_clip_warp") && action.slotIndex !== undefined)
  ) {
    return "Session slot target";
  }
  if (
    "source" in action &&
    action.source.kind === "session_audio_clip"
  ) {
    return "Session source slot";
  }
  return undefined;
}

function parsePlanTargets(value: unknown): Record<string, AgentPlanTarget> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Action plan targets must be an object.");
  const targets: Record<string, AgentPlanTarget> = {};
  const targetKeys = new Set<string>();
  for (const [ref, rawTarget] of Object.entries(value)) {
    if (!referencePattern.test(ref)) {
      throw new Error(`Plan target ref "${ref}" is invalid.`);
    }
    if (!isRecord(rawTarget)) {
      throw new Error(`Plan target "${ref}" must be an object.`);
    }
    const target = parsePlanTarget(rawTarget, ref);
    const targetKey = target.trackRole === "return"
      ? `return:${target.trackIndex}`
      : target.trackRole === "main"
        ? "main"
        : `regular:${target.trackName.toLocaleLowerCase()}`;
    if (targetKeys.has(targetKey)) {
      throw new Error(
        `Plan targets are ambiguous: ${targetKey.replace(":", " ")} is declared more than once.`,
      );
    }
    targetKeys.add(targetKey);
    targets[ref] = target;
  }
  return targets;
}

function parsePlanTarget(
  value: Record<string, unknown>,
  ref: string,
): AgentPlanTarget {
  const role = value.trackRole;
  if (role === undefined) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "trackName") {
      throw new Error(
        `Plan target "${ref}" for a regular track requires only trackName; trackIndex requires trackRole return.`,
      );
    }
    return { trackName: requiredPlanTargetName(value.trackName, ref) };
  }
  if (role !== "return" && role !== "main") {
    throw new Error(`Plan target "${ref}" trackRole must be return or main.`);
  }
  const allowed = role === "return"
    ? new Set(["trackRole", "trackIndex", "trackName"])
    : new Set(["trackRole", "trackName"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Plan target "${ref}" with trackRole ${role} does not support ${unknown}.`);
  }
  const trackName = value.trackName === undefined
    ? undefined
    : requiredPlanTargetName(value.trackName, ref);
  if (role === "main") {
    return { trackRole: "main", ...(trackName ? { trackName } : {}) };
  }
  if (
    typeof value.trackIndex !== "number" ||
    !Number.isSafeInteger(value.trackIndex) ||
    value.trackIndex < 0
  ) {
    throw new Error(
      `Plan target "${ref}" with trackRole return requires a non-negative integer trackIndex.`,
    );
  }
  return {
    trackRole: "return",
    trackIndex: value.trackIndex,
    ...(trackName ? { trackName } : {}),
  };
}

function validateTrackReferenceGraph(
  targets: Record<string, AgentPlanTarget>,
  actions: AgentAction[],
): void {
  type TrackKind = "existing" | "return" | "main" | "midi" | "audio";
  const declared = new Map<string, TrackKind>(
    Object.entries(targets).map(([ref, target]) => [
      ref,
      target.trackRole ?? "existing",
    ]),
  );
  const declaredRefs = new Set(Object.keys(targets));
  const futureRefs = new Set(
    actions.flatMap((action) =>
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
          action.ref
        ? [action.ref]
        : [],
    ),
  );
  const namesChangedEarlier = new Set<string>();
  const deletedRefs = new Set<string>();

  actions.forEach((action, index) => {
    const actionNumber = index + 1;
    if (hasTrackTarget(action)) {
      if (
        action.trackName &&
        namesChangedEarlier.has(action.trackName.toLocaleLowerCase())
      ) {
        throw new Error(
          `Action ${actionNumber} targets "${action.trackName}", a name created, renamed, or deleted by an earlier action. Declare the original track in targets and use trackRef, or use a staged apply call after observing the changed track.`,
        );
      }
      if (action.trackName && action.trackRef) {
        const repair = targets[action.trackRef]
          ? ` trackRef "${action.trackRef}" is declared in targets, so remove trackName from this action.`
          : " Remove one of the two target fields.";
        throw new Error(
          `Action ${actionNumber} must use either trackName or trackRef, not both.${repair}`,
        );
      }
      if (requiresNamedTrackTarget(action) && !action.trackName && !action.trackRef) {
        throw new Error(
          `Action ${actionNumber} requires either trackName or trackRef.`,
        );
      }
      if (action.trackRef) {
        const kind = declared.get(action.trackRef);
        if (!kind) {
          if (deletedRefs.has(action.trackRef)) {
            throw new Error(
              `Action ${actionNumber} uses trackRef "${action.trackRef}" after that track was deleted by an earlier action.`,
            );
          }
          if (futureRefs.has(action.trackRef)) {
            throw new Error(
              `Action ${actionNumber} uses forward trackRef "${action.trackRef}" before it is created.`,
            );
          }
          throw new Error(
            `Action ${actionNumber} uses missing trackRef "${action.trackRef}". Declare it in targets or on an earlier track creation action.`,
          );
        }
        if (
          (kind === "return" || kind === "main") &&
          !supportsNonRegularTrackAction(action)
        ) {
          throw new Error(
            `Action ${actionNumber} cannot use ${kind} trackRef "${action.trackRef}" for ${action.type}. Return and Main targets support only device-chain actions and Track or Rack Chain mixer parameters.`,
          );
        }
        if (
          (action.type === "create_midi_clip" ||
            action.type === "create_session_midi_clip" ||
            action.type === "replace_midi_clip_segment") &&
          kind === "audio"
        ) {
          throw new Error(
            `Action ${actionNumber} cannot use audio trackRef "${action.trackRef}" for a MIDI clip.`,
          );
        }
        if (
          (action.type === "create_arrangement_audio_clip" ||
            action.type === "create_session_audio_clip") &&
          kind === "midi"
        ) {
          throw new Error(
            `Action ${actionNumber} cannot use MIDI trackRef "${action.trackRef}" for an audio clip.`,
          );
        }
        if (
          requiresObservedExistingTrack(action) &&
          kind !== "existing" && kind !== "return" && kind !== "main"
        ) {
          throw new Error(
            `Action ${actionNumber} cannot perform this observed-state edit on newly created trackRef "${action.trackRef}" in the same call. Apply the creation, inspect the affected Live object, then use a staged apply call.`,
          );
        }
      }
    }

    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      if (declaredRefs.has(action.ref)) {
        throw new Error(
          `Action ${actionNumber} declares duplicate track ref "${action.ref}".`,
        );
      }
      declaredRefs.add(action.ref);
      declared.set(action.ref, action.type === "create_midi_track" ? "midi" : "audio");
      futureRefs.delete(action.ref);
    }
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.name
    ) {
      namesChangedEarlier.add(action.name.toLocaleLowerCase());
    }
    if (action.type === "rename_track") {
      if (action.trackName) {
        namesChangedEarlier.add(action.trackName.toLocaleLowerCase());
      }
      namesChangedEarlier.add(action.newName.toLocaleLowerCase());
    }
    if (action.type === "delete_track" && action.trackRef) {
      declared.delete(action.trackRef);
      deletedRefs.add(action.trackRef);
    }
    if (action.type === "delete_track" && action.trackName) {
      namesChangedEarlier.add(action.trackName.toLocaleLowerCase());
    }
  });
}

function validationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contextualActionValidationError(
  actionIndex: number,
  actionType: string | undefined,
  error: unknown,
): Error {
  const message = validationErrorMessage(error);
  const typeLabel = actionType ? ` (${actionType})` : "";
  const example = actionType ? agentActionExample(actionType) : undefined;
  const exampleSuffix = example && !message.includes(`Valid ${actionType} example:`)
    ? ` Valid ${actionType} example: ${example}.`
    : "";
  return new Error(
    `Action ${actionIndex + 1}${typeLabel} is invalid: ${message}${exampleSuffix}`,
    { cause: error },
  );
}

function contextualizeIndexedPlanError(
  error: unknown,
  actions: AgentAction[],
): Error {
  const message = validationErrorMessage(error);
  const single = /^Action (\d+) (.*)$/s.exec(message);
  if (single) {
    const actionIndex = Number(single[1]) - 1;
    const action = actions[actionIndex];
    if (action) {
      return contextualActionValidationError(
        actionIndex,
        action.type,
        new Error(single[2], { cause: error }),
      );
    }
  }

  const pair = /^Actions (\d+) and (\d+) (.*)$/s.exec(message);
  if (pair) {
    const firstIndex = Number(pair[1]) - 1;
    const secondIndex = Number(pair[2]) - 1;
    const first = actions[firstIndex];
    const second = actions[secondIndex];
    if (first && second) {
      return new Error(
        `Actions ${firstIndex + 1} and ${secondIndex + 1} (${first.type}, ${second.type}) are invalid: ${pair[3]}`,
        { cause: error },
      );
    }
  }

  return error instanceof Error ? error : new Error(message);
}

function hasTrackTarget(
  action: AgentAction,
): action is AgentAction & { trackName?: string; trackRef?: string } {
  return "trackName" in action || "trackRef" in action;
}

function requiresNamedTrackTarget(
  action: AgentAction & { trackName?: string; trackRef?: string },
): boolean {
  return (
    action.type === "rename_track" ||
    action.type === "delete_track" ||
    action.type === "duplicate_track"
  );
}

function requiresObservedExistingTrack(action: AgentAction): boolean {
  return (
    action.type === "set_device_parameter" ||
    action.type === "duplicate_device" ||
    action.type === "delete_device" ||
    action.type === "insert_chain_device" ||
    action.type === "create_rack_chain" ||
    action.type === "replace_simpler_sample" ||
    action.type === "configure_drum_pad" ||
    action.type === "set_track_mixer_parameter" ||
    action.type === "set_chain_mixer_parameter" ||
    action.type === "set_clip_properties" ||
    action.type === "set_audio_clip_warp" ||
    isMidiTransformAction(action) ||
    action.type === "delete_session_clip" ||
    action.type === "rename_take_lane" ||
    ((action.type === "create_midi_clip" ||
      action.type === "create_arrangement_audio_clip") &&
      action.laneIndex !== undefined)
  );
}

function requiredPlanTargetName(value: unknown, ref: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Plan target "${ref}" requires non-empty trackName.`);
  }
  return value.trim();
}

function assertNever(value: never): never {
  throw new Error(`Unsupported action: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
