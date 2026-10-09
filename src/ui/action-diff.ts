import type {
  AgentAction,
  AgentPlanTarget,
} from "../agent/actions.js";

import type { actionMessages } from "./i18n/action-messages.js";
import { uiMessage, type UiMessage, type UiMessageDescriptor, type UiMessageValues } from "./i18n/ui-message.js";

// Keep authored templates catalogued; raw action values never become message keys.
const m: (source: keyof typeof actionMessages, values?: UiMessageValues) => UiMessageDescriptor = uiMessage;

export interface ActionDiffGroup {
  title: UiMessage;
  rows: UiMessage[];
}

interface TrackRefLabel {
  name?: UiMessage;
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
    const numberedRow = m("{number}. {description}", { number: index + 1, description: diff.row });
    const currentGroup = groups.at(-1);
    if (currentGroup && typeof currentGroup.title !== "string" && currentGroup.title.source === diff.title) {
      currentGroup.rows.push(numberedRow);
    } else {
      groups.push({ title: m(diff.title), rows: [numberedRow] });
    }
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref
    ) {
      refLabels.set(
        action.ref,
        { name: action.name ?? m(action.type === "create_midi_track" ? "AI MIDI" : "AI Audio") },
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
): { title: keyof typeof actionMessages; row: UiMessage } {
  switch (action.type) {
    case "create_midi_track":
      return { title: "Create", row: m('+ MIDI track "{name}"{ref}', {
        name: action.name ?? m("AI MIDI"), ref: refSuffix(action.ref),
      }) };
    case "create_audio_track":
      return { title: "Create", row: m('+ Audio track "{name}"{ref}', {
        name: action.name ?? m("AI Audio"), ref: refSuffix(action.ref),
      }) };
    case "create_scene":
      return { title: "Create", row: m('+ Session View Scene "{name}"{index}', {
        name: action.name ?? m("Scene"),
        index: action.index === undefined ? "" : m(" at index {index}", { index: action.index }),
      }) };
    case "create_cue_point":
      return { title: "Create", row: m('+ Arrangement Cue Point "{name}" at beat {timeBeat}', {
        name: action.name ?? m("Cue Point"), timeBeat: action.timeBeat,
      }) };
    case "create_take_lane":
      return { title: "Create", row: m('+ Take Lane "{name}" on {track}', {
        name: action.name ?? m("Take Lane"), track: trackLabel(action, refLabels),
      }) };
    case "insert_device":
      return { title: "Insert Devices", row: m("+ [{index}] {deviceName} on {track}", {
        index: action.index ?? m("end"), deviceName: action.deviceName, track: trackLabel(action, refLabels),
      }) };
    case "insert_chain_device":
      return { title: "Insert Devices", row: m("+ [{index}] {deviceName} in chain {chainIndex} of {rackName}{path} on {track}", {
        index: action.index ?? m("end"), deviceName: action.deviceName, chainIndex: action.chainIndex,
        rackName: action.rackName, path: pathSuffix(action.rackPath), track: trackLabel(action, refLabels),
      }) };
    case "create_rack_chain":
      return { title: "Rack & Samples", row: m("+ Append empty Chain to {rackName}{path} on {track}", {
        rackName: action.rackName, path: pathSuffix(action.rackPath), track: trackLabel(action, refLabels),
      }) };
    case "set_device_parameter":
      return { title: "Set Parameters", row: m("~ {track}.{deviceName}{path}.{parameterName} = {value}", {
        track: trackLabel(action, refLabels), deviceName: action.deviceName,
        path: pathSuffix(action.devicePath, action.deviceIndex), parameterName: action.parameterName, value: action.value,
      }) };
    case "set_device_parameters":
      return { title: "Set Parameters", row: m("~ {track}.{deviceName}{path}: {values}", {
        track: trackLabel(action, refLabels), deviceName: action.deviceName, path: pathSuffix(action.devicePath, action.deviceIndex),
        values: action.values.map((entry) => `[${entry.parameterIndex}] ${entry.parameterName} = ${entry.value}`).join(", "),
      }) };
    case "duplicate_device":
      return { title: "Insert Devices", row: m("+ Duplicate {deviceName}{path} on {track}", {
        deviceName: action.deviceName, path: pathSuffix(action.devicePath, action.deviceIndex), track: trackLabel(action, refLabels),
      }) };
    case "replace_simpler_sample":
      return { title: "Rack & Samples", row: m("~ Replace sample in {simplerName}{path} on {track} from {source}", {
        simplerName: action.simplerName, path: pathSuffix(action.simplerPath),
        track: trackLabel(action, refLabels), source: sourceLabel(action.source),
      }) };
    case "configure_drum_pad":
      return {
        title: "Rack & Samples",
        row: action.mode === "fill_empty_pad"
          ? m("+ Fill empty Drum Rack {rackName} pad {receivingNote} on {track} from {source}", {
            rackName: action.rackName, receivingNote: action.receivingNote,
            track: trackLabel(action, refLabels), source: sourceLabel(action.source),
          })
          : m("~ Replace sample in Simpler {path} on Drum Rack {rackName} pad {receivingNote} on {track} from {source}", {
            path: pathLabel(action.simplerPath!), rackName: action.rackName, receivingNote: action.receivingNote,
            track: trackLabel(action, refLabels), source: sourceLabel(action.source),
          }),
      };
    case "create_midi_clip":
      return {
        title: "Write MIDI",
        row: action.laneIndex === undefined
          ? m('± Create or replace MIDI clip "{name}" on {track} at beat {startBeat} ({noteCount} notes, {durationBeats} beats)', {
            name: action.name ?? m("Untitled"), track: trackLabel(action, refLabels), startBeat: action.startBeat,
            noteCount: action.notes.length, durationBeats: action.durationBeats,
          })
          : m('{operation} MIDI clip "{name}" in {lane} on {track} at beat {startBeat} ({noteCount} notes, {durationBeats} beats; empty range required for creation)', {
            operation: m(action.name ? "± Create or update exact" : "+ Create"), name: action.name ?? m("Untitled"),
            lane: laneLabel(action.laneIndex, action.laneName), track: trackLabel(action, refLabels), startBeat: action.startBeat,
            noteCount: action.notes.length, durationBeats: action.durationBeats,
          }),
      };
    case "create_session_midi_clip":
      return { title: "Write MIDI", row: m('{operation} Session MIDI clip "{name}" in {slot} {slotIndex} on {track} ({noteCount} notes, {durationBeats} beats)', {
        operation: m(action.requireEmpty ? "+ Create" : "± Create or replace"), name: action.name ?? m("Untitled"),
        slot: m(action.requireEmpty ? "empty slot" : "slot"), slotIndex: action.slotIndex,
        track: trackLabel(action, refLabels), noteCount: action.notes.length, durationBeats: action.durationBeats,
      }) };
    case "replace_midi_clip_segment":
      return { title: "Write MIDI", row: m('± Replace MIDI clip "{clipName}" on {track} at beat {startBeat}, relative beats {segmentStartTime}-{segmentEndTime} ({noteCount} notes)', {
        clipName: action.clipName, track: trackLabel(action, refLabels), startBeat: action.startBeat,
        segmentStartTime: action.segmentStartTime, segmentEndTime: action.segmentStartTime + action.segmentDurationBeats,
        noteCount: action.notes.length,
      }) };
    case "transpose_midi_notes":
      return { title: "Transform MIDI", row: m("~ Transpose every note in {clip} on {track} by {semitones} semitones", {
        clip: clipLocation(action), track: trackLabel(action, refLabels), semitones: action.semitones,
      }) };
    case "quantize_midi_notes":
      return { title: "Transform MIDI", row: m("~ Quantize every note start in {clip} on {track} to {gridBeats}-beat grid at {strength} strength", {
        clip: clipLocation(action), track: trackLabel(action, refLabels), gridBeats: action.gridBeats, strength: action.strength,
      }) };
    case "scale_midi_velocity":
      return { title: "Transform MIDI", row: m("~ Scale every note velocity in {clip} on {track} by {factor}", {
        clip: clipLocation(action), track: trackLabel(action, refLabels), factor: action.factor,
      }) };
    case "shift_midi_notes":
      return { title: "Transform MIDI", row: m("~ Shift every note in {clip} on {track} by {offsetBeats} beats", {
        clip: clipLocation(action), track: trackLabel(action, refLabels), offsetBeats: action.offsetBeats,
      }) };
    case "create_arrangement_audio_clip":
      return { title: "Write Audio", row: m('+ {location} audio clip "{name}" on {track} at beat {startBeat}{duration} from {source}{settings}{consequence}', {
        location: action.laneIndex === undefined ? m("Arrangement") : laneLabel(action.laneIndex, action.laneName),
        name: action.name ?? m("Untitled"), track: trackLabel(action, refLabels), startBeat: action.startBeat,
        duration: action.durationBeats ? m(" ({durationBeats} beats)", { durationBeats: action.durationBeats }) : m(" (natural duration)"),
        source: sourceLabel(action.source), settings: audioSettingsLabel(action),
        consequence: action.laneIndex === undefined ? "" : m("; empty lane range required"),
      }) };
    case "create_session_audio_clip":
      return { title: "Write Audio", row: m('± Create or replace Session audio clip "{name}" in slot {slotIndex} on {track} from {source}{settings}; different source/Warp/loop deletes and recreates the slot Clip', {
        name: action.name ?? m("Untitled"), slotIndex: action.slotIndex, track: trackLabel(action, refLabels),
        source: sourceLabel(action.source), settings: audioSettingsLabel(action),
      }) };
    case "set_clip_properties":
      return { title: "Clip Changes", row: m("~ {clip} on {track}{rename}{looping}{muted}{color}", {
        clip: clipLocation(action), track: trackLabel(action, refLabels),
        rename: action.newName ? m(' rename to "{name}"', { name: action.newName }) : "",
        looping: action.looping === undefined ? "" : m(" looping={looping}", { looping: action.looping }),
        muted: action.muted === undefined ? "" : m(" muted={muted}", { muted: action.muted }),
        color: action.color === undefined ? "" : m(" color={color}", { color: action.color }),
      }) };
    case "set_audio_clip_warp":
      return { title: "Clip Changes", row: m("~ {clip} on {track}{warping}{warpMode}", {
        clip: clipLocation(action), track: trackLabel(action, refLabels),
        warping: action.warping === undefined ? "" : m(" warping={warping}", { warping: action.warping }),
        warpMode: action.warpMode ? m(" warpMode={warpMode}", { warpMode: action.warpMode }) : "",
      }) };
    case "set_tempo":
      return { title: "Song", row: m("~ Tempo = {tempo} BPM", { tempo: action.tempo }) };
    case "rename_scene":
      return { title: "Song", row: m('~ Session View Scene {sceneIndex}{name} → "{newName}"', {
        sceneIndex: action.sceneIndex, name: nameSuffix(action.sceneName), newName: action.newName,
      }) };
    case "duplicate_scene":
      return { title: "Song", row: m("+ Duplicate Session View Scene {sceneIndex}{name}", {
        sceneIndex: action.sceneIndex, name: nameSuffix(action.sceneName),
      }) };
    case "rename_cue_point":
      return { title: "Song", row: m('~ Arrangement Cue Point{name} at beat {timeBeat} → "{newName}"', {
        name: nameSuffix(action.cueName), timeBeat: action.timeBeat, newName: action.newName,
      }) };
    case "rename_track":
      return { title: "Track Changes", row: m('~ {track} → "{newName}"', {
        track: trackLabel(action, refLabels), newName: action.newName,
      }) };
    case "duplicate_track":
      return { title: "Track Changes", row: m("+ Duplicate {track}", { track: trackLabel(action, refLabels) }) };
    case "set_track_mute":
      return { title: "Track Changes", row: m(action.mute ? "~ Mute {track}" : "~ Unmute {track}", { track: trackLabel(action, refLabels) }) };
    case "set_track_solo":
      return { title: "Track Changes", row: m(action.solo ? "~ Solo {track}" : "~ Unsolo {track}", { track: trackLabel(action, refLabels) }) };
    case "set_track_arm":
      return { title: "Track Changes", row: m(action.arm ? "~ Arm {track}" : "~ Disarm {track}", { track: trackLabel(action, refLabels) }) };
    case "rename_take_lane":
      return { title: "Track Changes", row: m('~ {lane} on {track} → "{newName}"', {
        lane: laneLabel(action.laneIndex, action.laneName), track: trackLabel(action, refLabels), newName: action.newName,
      }) };
    case "set_track_mixer_parameter":
      return { title: "Set Parameters", row: m("~ {track} mixer {parameter} = {value}", {
        track: trackLabel(action, refLabels),
        parameter: action.parameter === "send" ? `send[${action.sendIndex}]` : action.parameter, value: action.value,
      }) };
    case "set_chain_mixer_parameter":
      return { title: "Set Parameters", row: m("~ {track} {rackName}{path} chain {chainIndex} mixer {parameter} = {value}", {
        track: trackLabel(action, refLabels), rackName: action.rackName, path: pathSuffix(action.rackPath), chainIndex: action.chainIndex,
        parameter: action.parameter === "send" ? `send[${action.sendIndex}]` : action.parameter, value: action.value,
      }) };
    case "delete_clip":
      return { title: "Delete", row: m('- Arrangement clip "{name}" on {track} at beat {startBeat}', {
        name: action.clipName ?? m("any name"), track: trackLabel(action, refLabels), startBeat: action.startBeat,
      }) };
    case "delete_session_clip":
      return { title: "Delete", row: m('- Session clip "{name}" in slot {slotIndex} on {track}', {
        name: action.clipName ?? m("any name"), slotIndex: action.slotIndex, track: trackLabel(action, refLabels),
      }) };
    case "clear_arrangement_range":
      return { title: "Delete", row: m("- Clear arrangement on {track} from beat {startBeat} to {endBeat}; boundary clips truncate", {
        track: trackLabel(action, refLabels), startBeat: action.startBeat, endBeat: action.endBeat,
      }) };
    case "delete_track":
      return { title: "Delete", row: m("- {track}", { track: trackLabel(action, refLabels) }) };
    case "delete_device":
      return { title: "Delete", row: m("- Device {deviceName}{path} on {track}", {
        deviceName: action.deviceName, path: pathSuffix(action.devicePath, action.deviceIndex), track: trackLabel(action, refLabels),
      }) };
    case "delete_scene":
      return { title: "Delete", row: m("- Session View Scene {sceneIndex}{name}", {
        sceneIndex: action.sceneIndex, name: nameSuffix(action.sceneName),
      }) };
    case "delete_cue_point":
      return { title: "Delete", row: m("- Arrangement Cue Point{name} at beat {timeBeat}", {
        name: nameSuffix(action.cueName), timeBeat: action.timeBeat,
      }) };
    default:
      return assertNever(action);
  }
}

function refSuffix(ref?: string): UiMessage {
  return ref ? m(" (ref {ref})", { ref }) : "";
}

function nameSuffix(name?: UiMessage): UiMessage {
  return name ? m(' "{name}"', { name }) : "";
}

function pathLabel(path: import("../live/device-tree.js").DevicePath): UiMessage {
  return m("path {path}", { path: JSON.stringify(path) });
}

function pathSuffix(path?: import("../live/device-tree.js").DevicePath, index?: number): UiMessage {
  return path ? m(" {path}", { path: pathLabel(path) })
    : index === undefined ? "" : m("[{index}]", { index });
}

function laneLabel(laneIndex: number, laneName?: string): UiMessage {
  return m("Take Lane {laneIndex}{name}", { laneIndex, name: nameSuffix(laneName) });
}

function sourceLabel(source: import("../agent/action-schema.js").SampleSource): UiMessage {
  switch (source.kind) {
    case "selected":
      return m("selected Live object");
    case "request_audio_attachment":
      return m("current request audio input {number}", { number: source.audioIndex + 1 });
    case "audio_asset":
      return m("processed audio asset {assetRef}", { assetRef: source.assetRef });
    case "arrangement_audio_clip":
      return m("arrangement clip{name} at beat {startBeat} on {trackName}", {
        name: nameSuffix(source.clipName), startBeat: source.startBeat, trackName: source.trackName,
      });
    case "session_audio_clip":
      return m("Session clip{name} in slot {slotIndex} on {trackName}", {
        name: nameSuffix(source.clipName), slotIndex: source.slotIndex, trackName: source.trackName,
      });
    case "simpler":
      return m("Simpler {deviceName}{path} on {trackName}", {
        deviceName: source.deviceName,
        path: source.devicePath ? pathSuffix(source.devicePath) : source.deviceIndex === undefined ? ""
          : m(" at deviceIndex {deviceIndex}", { deviceIndex: source.deviceIndex }),
        trackName: source.trackName,
      });
  }
}

function audioSettingsLabel(action: {
  isWarped?: boolean;
  loopSettings?: import("../agent/action-schema.js").ClipLoopSettingsInput;
}): UiMessage {
  return m("{warped}{loop}", {
    warped: action.isWarped === undefined ? "" : m(" warped={isWarped}", { isWarped: action.isWarped }),
    loop: action.loopSettings
      ? m(" loop={loopStart}-{loopEnd} markers={startMarker}-{endMarker} looping={looping}", {
        loopStart: action.loopSettings.loopStart, loopEnd: action.loopSettings.loopEnd,
        startMarker: action.loopSettings.startMarker, endMarker: action.loopSettings.endMarker,
        looping: action.loopSettings.looping,
      }) : "",
  });
}

function clipLocation(action: {
  clipName?: string;
  startBeat?: number;
  slotIndex?: number;
}): UiMessage {
  const clip = action.clipName ? m('clip "{name}"', { name: action.clipName }) : m("clip");
  return action.slotIndex === undefined
    ? m("{clip} at arrangement beat {startBeat}", { clip, startBeat: action.startBeat! })
    : m("{clip} in Session slot {slotIndex}", { clip, slotIndex: action.slotIndex });
}

function trackLabel(
  action: { trackName?: string; trackRef?: string },
  refLabels: ReadonlyMap<string, TrackRefLabel>,
): UiMessage {
  if (action.trackRef) {
    const target = refLabels.get(action.trackRef);
    if (target?.role === "return") {
      return m("Return track index {index}{name} (ref {ref})", {
        index: target.index!, name: nameSuffix(target.name), ref: action.trackRef,
      });
    }
    if (target?.role === "main") {
      return m("Main track{name} (ref {ref})", { name: nameSuffix(target.name), ref: action.trackRef });
    }
    if (target?.name) return m('track "{name}" (ref {ref})', { name: target.name, ref: action.trackRef });
    return m('track ref "{ref}"', { ref: action.trackRef });
  }
  return action.trackName ? m('track "{name}"', { name: action.trackName }) : m("target track");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported action diff: ${JSON.stringify(value)}`);
}
