import type { ModelToolCall } from "../model/contracts.js";
import type { AgentPlan } from "./actions.js";

export function progressLabelForToolCall(toolCall: ModelToolCall): string {
  const args = parseArgs(toolCall.arguments);

  if (toolCall.name === "inspect_device") {
    const suffix = typeof args.deviceIndex === "number" ? `[${args.deviceIndex}]` : "";
    const deviceName = stringArg(args.deviceName, "device");
    const trackName = stringArg(args.trackName);
    return `Inspecting ${deviceName}${suffix}${trackName ? ` on "${trackName}"` : ""}`;
  }

  if (toolCall.name === "inspect_device_tree") {
    const deviceName = stringArg(args.deviceName, "selected");
    const trackName = stringArg(args.trackName);
    return `Inspecting ${deviceName} device tree${trackName ? ` on "${trackName}"` : ""}`;
  }

  if (toolCall.name === "inspect_mixer") {
    const trackName = stringArg(args.trackName);
    return trackName
      ? `Inspecting mixer on "${trackName}"`
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
    const trackName = stringArg(args.trackName);
    return `Inspecting track ${trackName ? `"${trackName}"` : "selection"}`;
  }

  if (toolCall.name === "inspect_midi_clip") {
    const clipName = stringArg(args.clipName);
    return `Inspecting MIDI clip ${clipName ? `"${clipName}"` : "selection"}`;
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

  return `Running ${toolCall.name}`;
}

export function progressLabelForActionPlan(plan: AgentPlan): string {
  return `Applying ${plan.actions.length} Live action${plan.actions.length === 1 ? "" : "s"}`;
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
