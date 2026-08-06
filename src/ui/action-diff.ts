import type {
  AgentAction,
  AgentPlanTarget,
} from "../agent/actions.js";

export interface ActionDiffGroup {
  title: string;
  rows: string[];
}

export function actionDiffGroups(
  actions: AgentAction[],
  targets: Record<string, AgentPlanTarget> = {},
): ActionDiffGroup[] {
  const titles = [
    "Create",
    "Insert Devices",
    "Set Parameters",
    "Rack & Samples",
    "Write MIDI",
    "Write Audio",
    "Clip Changes",
    "Song",
    "Track Changes",
    "Delete",
  ];
  const rows = new Map(titles.map((title) => [title, [] as string[]]));
  const refLabels = new Map(
    Object.entries(targets).map(([ref, target]) => [ref, target.trackName]),
  );

  for (const action of actions) {
    const diff = actionDiffRow(action, refLabels);
    rows.get(diff.title)?.push(diff.row);
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      refLabels.set(
        action.ref,
        action.name ?? (action.type === "create_midi_track" ? "AI MIDI" : "AI Audio"),
      );
    }
    if (action.type === "rename_track" && action.trackRef) {
      refLabels.set(action.trackRef, action.newName);
    }
  }

  return titles.flatMap((title) => {
    const groupRows = rows.get(title) ?? [];
    return groupRows.length ? [{ title, rows: groupRows }] : [];
  });
}

function actionDiffRow(
  action: AgentAction,
  refLabels: ReadonlyMap<string, string>,
): { title: string; row: string } {
  switch (action.type) {
    case "create_midi_track":
      return { title: "Create", row: `+ MIDI track "${action.name ?? "AI MIDI"}"${action.ref ? ` (ref ${action.ref})` : ""}` };
    case "create_audio_track":
      return { title: "Create", row: `+ Audio track "${action.name ?? "AI Audio"}"${action.ref ? ` (ref ${action.ref})` : ""}` };
    case "create_scene":
      return {
        title: "Create",
        row: `+ Scene "${action.name ?? "Scene"}"${action.index !== undefined ? ` at index ${action.index}` : ""}`,
      };
    case "create_cue_point":
      return {
        title: "Create",
        row: `+ Cue Point "${action.name ?? "Cue Point"}" at beat ${action.timeBeat}`,
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
        row: `~ Drum Rack ${action.rackName} pad ${action.receivingNote} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}`,
      };
    case "create_midi_clip":
      return {
        title: "Write MIDI",
        row: `± Create or replace MIDI clip "${action.name ?? "Untitled"}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat} (${action.notes.length} notes, ${action.durationBeats} beats)`,
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
    case "create_arrangement_audio_clip":
      return {
        title: "Write Audio",
        row: `+ Arrangement audio clip "${action.name ?? "Untitled"}" on ${trackLabel(action, refLabels)} at beat ${action.startBeat}${action.durationBeats ? ` (${action.durationBeats} beats)` : " (natural duration)"} from ${sourceLabel(action.source)}`,
      };
    case "create_session_audio_clip":
      return {
        title: "Write Audio",
        row: `± Create or replace Session audio clip "${action.name ?? "Untitled"}" in slot ${action.slotIndex} on ${trackLabel(action, refLabels)} from ${sourceLabel(action.source)}`,
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
      return { title: "Song", row: `~ Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""} → "${action.newName}"` };
    case "duplicate_scene":
      return { title: "Song", row: `+ Duplicate Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}` };
    case "rename_cue_point":
      return { title: "Song", row: `~ Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat} → "${action.newName}"` };
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
        row: `- Scene ${action.sceneIndex}${action.sceneName ? ` "${action.sceneName}"` : ""}`,
      };
    case "delete_cue_point":
      return {
        title: "Delete",
        row: `- Cue Point${action.cueName ? ` "${action.cueName}"` : ""} at beat ${action.timeBeat}`,
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
    case "arrangement_audio_clip":
      return `arrangement clip ${source.clipName ?? `at beat ${source.startBeat}`} on ${source.trackName}`;
    case "session_audio_clip":
      return `Session slot ${source.slotIndex} on ${source.trackName}`;
    case "simpler":
      return `Simpler ${source.deviceName} on ${source.trackName}`;
  }
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
  refLabels: ReadonlyMap<string, string>,
): string {
  if (action.trackRef) {
    const currentName = refLabels.get(action.trackRef);
    return currentName
      ? `track "${currentName}" (ref ${action.trackRef})`
      : `track ref "${action.trackRef}"`;
  }
  return action.trackName ? `track "${action.trackName}"` : "target track";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported action diff: ${JSON.stringify(value)}`);
}
