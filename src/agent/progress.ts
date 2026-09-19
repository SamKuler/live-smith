import type { ModelToolCall } from "../model/contracts.js";
import { builtInAudioLocalToolName } from "../plugins/builtins/audio-toolsets.js";
import type { AgentPlan } from "./actions.js";

export function progressLabelForToolCall(toolCall: ModelToolCall): string {
  const args = parseArgs(toolCall.arguments);
  const toolName = builtInAudioLocalToolName(toolCall.name) ?? toolCall.name;

  if (toolName === "inspect_device") {
    const suffix = typeof args.deviceIndex === "number" ? `[${args.deviceIndex}]` : "";
    const deviceName = stringArg(args.deviceName, "device");
    const track = trackInspectionTarget(args);
    return `Inspecting ${deviceName}${suffix}${track ? ` on ${track}` : ""}`;
  }

  if (toolName === "inspect_device_tree") {
    const deviceName = stringArg(args.deviceName, "selected");
    const track = trackInspectionTarget(args);
    return `Inspecting ${deviceName} device tree${track ? ` on ${track}` : ""}`;
  }

  if (toolName === "inspect_rack_chain") {
    const rackName = stringArg(args.rackName, "Rack");
    const chainIndex = typeof args.chainIndex === "number" ? args.chainIndex : "?";
    const track = trackInspectionTarget(args);
    return `Inspecting Chain ${chainIndex} in ${rackName}${track ? ` on ${track}` : ""}`;
  }

  if (toolName === "inspect_mixer") {
    const track = trackInspectionTarget(args);
    return track
      ? `Inspecting mixer on ${track}`
      : "Inspecting selected track mixer";
  }

  if (toolName === "inspect_current_object") {
    return "Inspecting selected Live object";
  }

  if (toolName === "inspect_clip") {
    const clipName = stringArg(args.clipName);
    return `Inspecting Clip ${clipName ? `"${clipName}"` : "selection"}`;
  }

  if (toolName === "inspect_track") {
    const track = trackInspectionTarget(args);
    return `Inspecting ${track ?? "track selection"}`;
  }

  if (toolName === "inspect_take_lane") {
    const trackName = stringArg(args.trackName);
    const laneName = stringArg(args.laneName);
    const laneIndex = typeof args.laneIndex === "number" ? args.laneIndex : "?";
    return `Inspecting Take Lane ${laneIndex}${laneName ? ` "${laneName}"` : ""}${trackName ? ` on "${trackName}"` : ""}`;
  }

  if (toolName === "inspect_midi_clip") {
    const clipName = stringArg(args.clipName);
    return `Inspecting MIDI clip ${clipName ? `"${clipName}"` : "selection"}`;
  }

  if (toolName === "analyze_audio_clip") {
    const clipName = stringArg(args.clipName);
    return `Analyzing pre-FX audio for ${clipName ? `"${clipName}"` : "Arrangement Clip"}`;
  }

  if (toolName === "read_arrangement_audio") {
    const clipName = stringArg(args.clipName);
    return `Reading pre-FX audio for ${clipName ? `"${clipName}"` : "Arrangement Clip"}`;
  }

  if (toolName === "listen_to_audio_asset") {
    return "Listening to saved Session audio";
  }

  if (toolName === "inspect_live_set") {
    return "Inspecting Live Set";
  }

  if (toolName === "inspect_song_info") {
    return "Inspecting song settings and markers";
  }

  if (toolName === "apply_live_actions") {
    return "Preparing Live changes";
  }

  if (toolName === "resolve_live_recovery") {
    return "Reviewing unfinished Live work";
  }

  if (toolName === "generate_music") return "Generating music";
  if (toolName === "generate_sound_effect") return "Generating a sound effect";
  if (toolName === "separate_stems") return "Separating audio stems";
  if (toolName === "inspect_music_service") return "Reading music account";
  if (toolName === "extend_music") return "Extending music";
  if (toolName === "get_whole_song") return "Collecting the whole song";
  if (toolName === "retrieve_music") return "Retrieving music";

  return `Running ${toolCall.name}`;
}

export function progressLabelForActionPlan(plan: AgentPlan): string {
  return `Preparing ${plan.actions.length} Live action${plan.actions.length === 1 ? "" : "s"}`;
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function trackInspectionTarget(args: Record<string, unknown>): string | undefined {
  const name = stringArg(args.trackName);
  if (args.trackRole === "return" && Number.isSafeInteger(args.trackIndex)) {
    return `Return track index ${args.trackIndex}${name ? ` "${name}"` : ""}`;
  }
  if (args.trackRole === "main") return `Main track${name ? ` "${name}"` : ""}`;
  return name ? `"${name}"` : undefined;
}
