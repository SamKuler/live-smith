import type { ModelToolCall } from "../model/contracts.js";
import type { AgentPlan } from "./actions.js";

export function progressLabelForToolCall(toolCall: ModelToolCall): string {
  const args = parseArgs(toolCall.arguments);

  if (toolCall.name === "inspect_device") {
    const suffix = typeof args.deviceIndex === "number" ? `[${args.deviceIndex}]` : "";
    const deviceName = stringArg(args.deviceName, "device");
    const track = trackInspectionTarget(args);
    return `Inspecting ${deviceName}${suffix}${track ? ` on ${track}` : ""}`;
  }

  if (toolCall.name === "inspect_device_tree") {
    const deviceName = stringArg(args.deviceName, "selected");
    const track = trackInspectionTarget(args);
    return `Inspecting ${deviceName} device tree${track ? ` on ${track}` : ""}`;
  }

  if (toolCall.name === "inspect_rack_chain") {
    const rackName = stringArg(args.rackName, "Rack");
    const chainIndex = typeof args.chainIndex === "number" ? args.chainIndex : "?";
    const track = trackInspectionTarget(args);
    return `Inspecting Chain ${chainIndex} in ${rackName}${track ? ` on ${track}` : ""}`;
  }

  if (toolCall.name === "inspect_mixer") {
    const track = trackInspectionTarget(args);
    return track
      ? `Inspecting mixer on ${track}`
      : "Inspecting selected track mixer";
  }

  if (toolCall.name === "inspect_current_object") {
    return "Inspecting selected Live object";
  }

  if (toolCall.name === "inspect_clip") {
    const clipName = stringArg(args.clipName);
    return `Inspecting Clip ${clipName ? `"${clipName}"` : "selection"}`;
  }

  if (toolCall.name === "inspect_track") {
    const track = trackInspectionTarget(args);
    return `Inspecting ${track ?? "track selection"}`;
  }

  if (toolCall.name === "inspect_take_lane") {
    const trackName = stringArg(args.trackName);
    const laneName = stringArg(args.laneName);
    const laneIndex = typeof args.laneIndex === "number" ? args.laneIndex : "?";
    return `Inspecting Take Lane ${laneIndex}${laneName ? ` "${laneName}"` : ""}${trackName ? ` on "${trackName}"` : ""}`;
  }

  if (toolCall.name === "inspect_midi_clip") {
    const clipName = stringArg(args.clipName);
    return `Inspecting MIDI clip ${clipName ? `"${clipName}"` : "selection"}`;
  }

  if (toolCall.name === "analyze_audio_clip") {
    const clipName = stringArg(args.clipName);
    return `Analyzing pre-FX audio for ${clipName ? `"${clipName}"` : "Arrangement Clip"}`;
  }

  if (toolCall.name === "read_arrangement_audio") {
    const clipName = stringArg(args.clipName);
    return `Reading pre-FX audio for ${clipName ? `"${clipName}"` : "Arrangement Clip"}`;
  }

  if (toolCall.name === "inspect_live_set") {
    return "Inspecting Live Set";
  }

  if (toolCall.name === "inspect_song_info") {
    return "Inspecting song settings and markers";
  }

  if (toolCall.name === "apply_live_actions") {
    return "Preparing Live changes";
  }

  if (toolCall.name === "resolve_live_recovery") {
    return "Reviewing unfinished Live work";
  }

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
