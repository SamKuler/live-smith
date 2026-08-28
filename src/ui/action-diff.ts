import type {
  AgentAction,
  AgentPlanTarget,
} from "../agent/actions.js";

export interface ActionDiffGroup {
  title: string;
  rows: string[];
}

interface TrackRefLabel {
  name?: string;
  role?: "return" | "main";
  index?: number;
}

export function actionDiffGroups(
  actions: AgentAction[],
  targets: Record<string, AgentPlanTarget> = {},
): ActionDiffGroup[] {
  const groups: ActionDiffGroup[] = [];
  const refLabels = new Map(
    Object.entries(targets).map(([ref, target]) => [ref, planTargetLabel(target)]),
  );

  for (const [index, action] of actions.entries()) {
    const diff = actionDiffRow(action, refLabels);
    const numberedRow = `${index + 1}. ${diff.row}`;
    const currentGroup = groups.at(-1);
    if (currentGroup?.title === diff.title) {
      currentGroup.rows.push(numberedRow);
    } else {
      groups.push({ title: diff.title, rows: [numberedRow] });
    }
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      refLabels.set(
        action.ref,
        { name: action.name ?? (action.type === "create_midi_track" ? "AI MIDI" : "AI Audio") },
      );
    }
    if (action.type === "rename_track" && action.trackRef) {
      refLabels.set(action.trackRef, {
        ...refLabels.get(action.trackRef),
        name: action.newName,
      });
    }
  }

  return groups;
}

function planTargetLabel(target: AgentPlanTarget): TrackRefLabel {
  if (target.trackRole === "return") {
    return {
      role: "return",
      index: target.trackIndex,
      ...(target.trackName ? { name: target.trackName } : {}),
    };
  }
  if (target.trackRole === "main") {
    return { role: "main", ...(target.trackName ? { name: target.trackName } : {}) };
  }
  return { name: target.trackName };
}

function actionDiffRow(
  action: AgentAction,
  refLabels: ReadonlyMap<string, TrackRefLabel>,
): { title: string; row: string } {
  switch (action.type) {
    case "create_midi_track":
      return { title: "Create", row: `+ MIDI track "${action.name ?? "AI MIDI"}"${action.ref ? ` (ref ${action.ref})` : ""}` };
    case "create_audio_track":
      return { title: "Create", row: `+ Audio track "${action.name ?? "AI Audio"}"${action.ref ? ` (ref ${action.ref})` : ""}` };
    case "create_scene":
      return {
        title: "Create",
        row: `+ Session View Scene "${action.name ?? "Scene"}"${action.index !== undefined ? ` at index ${action.index}` : ""}`,
      };
    case "create_cue_point":
      return {
        title: "Create",
        row: `+ Arrangement Cue Point "${action.name ?? "Cue Point"}" at beat ${action.timeBeat}`,
      };
    case "create_take_lane":
      return {
        title: "Create",
        row: `+ Take Lane "${action.name ?? "Take Lane"}" on ${trackLabel(action, refLabels)}`,
      };
    case "insert_device":
      return {
        title: "Insert Devices",
        row: `+ [${action.index ?? "end"}] ${action.deviceName} on ${trackLabel(action, refLabels)}`,
      };
    case "insert_chain_device":
      return {
        title: "Insert Devices",
        row: `+ [${action.index ?? "end"}] ${action.deviceName} in chain ${action.chainIndex} of ${action.rackName}${action.rackPath ? ` ${pathLabel(action.rackPath)}` : ""} on ${trackLabel(action, refLabels)}`,
      };
    case "create_rack_chain":
      return {
        title: "Rack & Samples",
        row: `+ Append empty Chain to ${action.rackName}${action.rackPath ? ` ${pathLabel(action.rackPath)}` : ""} on ${trackLabel(action, refLabels)}`,
      };
    case "set_device_parameter":
      return {
        title: "Set Parameters",
        row: `~ ${trackLabel(action, refLabels)}.${action.deviceName}${action.devicePath ? ` ${pathLabel(action.devicePath)}` : action.deviceIndex !== undefined ? `[${action.deviceIndex}]` : ""}.${action.parameterName} = ${action.value}`,
      };
    case "duplicate_device":
      return {
        title: "Insert Devices",
        row: `+ Duplicate ${action.deviceName}${action.devicePath ? ` ${pathLabel(action.devicePath)}` : action.deviceIndex !== undefined ? `[${action.deviceIndex}]` : ""} on ${trackLabel(action, refLabels)}`,
      };
    case "replace_simpler_sample":
      return {
        title: "Rack & Samples",
        row: `~ Replace sample in ${action.simplerName}${action.simplerPath ? ` ${pathLabel(action.simplerPath)}` : ""} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}`,
      };
    case "configure_drum_pad":
      return {
        title: "Rack & Samples",
        row: action.mode === "fill_empty_pad"
          ? `+ Fill empty Drum Rack ${action.rackName} pad ${action.receivingNote} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}`
          : `~ Replace sample in Simpler ${pathLabel(action.simplerPath!)} on Drum Rack ${action.rackName} pad ${action.receivingNote} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}`,
      };
    case "create_midi_clip":
      return {
        title: "Write MIDI",
        row: action.laneIndex === undefined
          ? `± Create or replace MIDI clip "${action.name ?? "Untitled"}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat} (${action.notes.length} notes, ${action.durationBeats} beats)`
          : `${action.name ? "± Create or update exact" : "+ Create"} MIDI clip "${action.name ?? "Untitled"}" in Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""} on ${trackLabel(action, refLabels)} at beat ${action.startBeat} (${action.notes.length} notes, ${action.durationBeats} beats; empty range required for creation)`,
      };
    case "create_session_midi_clip":
      return {
        title: "Write MIDI",
        row: `± Create or replace Session MIDI clip "${action.name ?? "Untitled"}" in slot ${action.slotIndex} on ${trackLabel(action, refLabels)} (${action.notes.length} notes, ${action.durationBeats} beats)`,
      };
    case "replace_midi_clip_segment":
      return {
        title: "Write MIDI",
        row: `± Replace MIDI clip "${action.clipName}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat}, relative beats ${action.segmentStartTime}-${action.segmentStartTime + action.segmentDurationBeats} (${action.notes.length} notes)`,
      };
    case "transpose_midi_notes":
      return {
        title: "Transform MIDI",
        row: `~ Transpose every note in ${clipLocation(action)} on ${trackLabel(action, refLabels)} by ${action.semitones} semitones`,
      };
    case "quantize_midi_notes":
      return {
        title: "Transform MIDI",
        row: `~ Quantize every note start in ${clipLocation(action)} on ${trackLabel(action, refLabels)} to ${action.gridBeats}-beat grid at ${action.strength} strength`,
      };
    case "scale_midi_velocity":
      return {
        title: "Transform MIDI",
        row: `~ Scale every note velocity in ${clipLocation(action)} on ${trackLabel(action, refLabels)} by ${action.factor}`,
      };
    case "shift_midi_notes":
      return {
        title: "Transform MIDI",
        row: `~ Shift every note in ${clipLocation(action)} on ${trackLabel(action, refLabels)} by ${action.offsetBeats} beats`,
      };
    case "create_arrangement_audio_clip":
      return {
        title: "Write Audio",
        row: `+ ${action.laneIndex === undefined ? "Arrangement" : `Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""}`} audio clip "${action.name ?? "Untitled"}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat}${action.durationBeats ? ` (${action.durationBeats} beats)` : " (natural duration)"} from ${sourceLabel(action.source)}${audioSettingsLabel(action)}${action.laneIndex === undefined ? "" : "; empty lane range required"}`,
      };
    case "create_session_audio_clip":
      return {
        title: "Write Audio",
        row: `± Create or replace Session audio clip "${action.name ?? "Untitled"}" in slot ${action.slotIndex} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}${audioSettingsLabel(action)}; different source/Warp/loop deletes and recreates the slot Clip`,
      };
    case "set_clip_properties":
      return {
        title: "Clip Changes",
        row: `~ ${clipLocation(action)} on ${trackLabel(action, refLabels)}${action.newName ? ` rename to "${action.newName}"` : ""}${action.looping === undefined ? "" : ` looping=${action.looping}`}${action.muted === undefined ? "" : ` muted=${action.muted}`}${action.color === undefined ? "" : ` color=${action.color}`}`,
      };
    case "set_audio_clip_warp":
      return {
        title: "Clip Changes",
        row: `~ ${clipLocation(action)} on ${trackLabel(action, refLabels)}${action.warping === undefined ? "" : ` warping=${action.warping}`}${action.warpMode ? ` warpMode=${action.warpMode}` : ""}`,
      };
    case "set_tempo":
      return { title: "Song", row: `~ Tempo = ${action.tempo} BPM` };
    case "rename_scene":
      return { title: "Song", row: `~ Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""} → "${action.newName}"` };
    case "duplicate_scene":
      return { title: "Song", row: `+ Duplicate Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}` };
    case "rename_cue_point":
      return { title: "Song", row: `~ Arrangement Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat} → "${action.newName}"` };
    case "rename_track":
      return { title: "Track Changes", row: `~ ${trackLabel(action, refLabels)} → "${action.newName}"` };
    case "duplicate_track":
      return { title: "Track Changes", row: `+ Duplicate ${trackLabel(action, refLabels)}` };
    case "set_track_mute":
      return { title: "Track Changes", row: `~ ${action.mute ? "Mute" : "Unmute"} ${trackLabel(action, refLabels)}` };
    case "set_track_solo":
      return { title: "Track Changes", row: `~ ${action.solo ? "Solo" : "Unsolo"} ${trackLabel(action, refLabels)}` };
    case "set_track_arm":
      return { title: "Track Changes", row: `~ ${action.arm ? "Arm" : "Disarm"} ${trackLabel(action, refLabels)}` };
    case "rename_take_lane":
      return { title: "Track Changes", row: `~ Take Lane ${action.laneIndex}${action.laneName ? ` "${action.laneName}"` : ""} on ${trackLabel(action, refLabels)} → "${action.newName}"` };
    case "set_track_mixer_parameter":
      return {
        title: "Set Parameters",
        row: `~ ${trackLabel(action, refLabels)} mixer ${action.parameter === "send" ? `send[${action.sendIndex}]` : action.parameter} = ${action.value}`,
      };
    case "set_chain_mixer_parameter":
      return {
        title: "Set Parameters",
        row: `~ ${trackLabel(action, refLabels)} ${action.rackName}${action.rackPath ? ` ${pathLabel(action.rackPath)}` : ""} chain ${action.chainIndex} mixer ${action.parameter === "send" ? `send[${action.sendIndex}]` : action.parameter} = ${action.value}`,
      };
    case "delete_clip":
      return {
        title: "Delete",
        row: `- Arrangement clip "${action.clipName ?? "any name"}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat}`,
      };
    case "delete_session_clip":
      return {
        title: "Delete",
        row: `- Session clip "${action.clipName ?? "any name"}" in slot ${action.slotIndex} on ${trackLabel(action, refLabels)}`,
      };
    case "clear_arrangement_range":
      return {
        title: "Delete",
        row: `- Clear arrangement on ${trackLabel(action, refLabels)} from beat ${action.startBeat} to ${action.endBeat}; boundary clips truncate`,
      };
    case "delete_track":
      return { title: "Delete", row: `- ${trackLabel(action, refLabels)}` };
    case "delete_device":
      return {
        title: "Delete",
        row: `- Device ${action.deviceName}${action.devicePath ? ` ${pathLabel(action.devicePath)}` : action.deviceIndex !== undefined ? `[${action.deviceIndex}]` : ""} on ${trackLabel(action, refLabels)}`,
      };
    case "delete_scene":
      return {
        title: "Delete",
        row: `- Session View Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}`,
      };
    case "delete_cue_point":
      return {
        title: "Delete",
        row: `- Arrangement Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat}`,
      };
    default:
      return assertNever(action);
  }
}

function pathLabel(path: import("../live/device-tree.js").DevicePath): string {
  return `path ${JSON.stringify(path)}`;
}

function sourceLabel(source: import("../agent/action-schema.js").SampleSource): string {
  switch (source.kind) {
    case "selected":
      return "selected Live object";
    case "request_audio_attachment":
      return `current request audio input ${source.audioIndex + 1}`;
    case "arrangement_audio_clip":
      return `arrangement clip${source.clipName ? ` "${source.clipName}"` : ""} at beat ${source.startBeat} on ${source.trackName}`;
    case "session_audio_clip":
      return `Session clip${source.clipName ? ` "${source.clipName}"` : ""} in slot ${source.slotIndex} on ${source.trackName}`;
    case "simpler":
      return `Simpler ${source.deviceName}${source.devicePath ? ` ${pathLabel(source.devicePath)}` : source.deviceIndex === undefined ? "" : ` at deviceIndex ${source.deviceIndex}`} on ${source.trackName}`;
  }
}

function audioSettingsLabel(action: {
  isWarped?: boolean;
  loopSettings?: import("../agent/action-schema.js").ClipLoopSettingsInput;
}): string {
  return [
    action.isWarped === undefined ? "" : ` warped=${action.isWarped}`,
    action.loopSettings
      ? ` loop=${action.loopSettings.loopStart}-${action.loopSettings.loopEnd} markers=${action.loopSettings.startMarker}-${action.loopSettings.endMarker} looping=${action.loopSettings.looping}`
      : "",
  ].join("");
}

function clipLocation(action: {
  clipName?: string;
  startBeat?: number;
  slotIndex?: number;
}): string {
  const name = action.clipName ? `clip "${action.clipName}"` : "clip";
  return action.slotIndex === undefined
    ? `${name} at arrangement beat ${action.startBeat}`
    : `${name} in Session slot ${action.slotIndex}`;
}

function trackLabel(
  action: { trackName?: string; trackRef?: string },
  refLabels: ReadonlyMap<string, TrackRefLabel>,
): string {
  if (action.trackRef) {
    const target = refLabels.get(action.trackRef);
    if (target?.role === "return") {
      return `Return track index ${target.index}${target.name ? ` "${target.name}"` : ""} (ref ${action.trackRef})`;
    }
    if (target?.role === "main") {
      return `Main track${target.name ? ` "${target.name}"` : ""} (ref ${action.trackRef})`;
    }
    if (target?.name) return `track "${target.name}" (ref ${action.trackRef})`;
    return `track ref "${action.trackRef}"`;
  }
  return action.trackName ? `track "${action.trackName}"` : "target track";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported action diff: ${JSON.stringify(value)}`);
}
