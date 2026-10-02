import { isMidiContinuationBuffer, type MidiContinuationView } from "../../../agent/midi-continuation-contracts.js";
import type { PluginParameterPanel } from "../../../plugins/parameter-panel.js";
import { hasOnlyWireKeys, isWireRecord, isWireStorageId } from "./primitives.js";

export function isWireMidiContinuation(value: unknown, sessionId: unknown,
  isPanel: (value: unknown) => value is PluginParameterPanel): value is MidiContinuationView {
  const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && !value.includes("\0");
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!isWireRecord(value) || !hasOnlyWireKeys<MidiContinuationView>(value, ["sessionId", "clips", "clipsTruncated", "generators", "buffer", "stale", "staleReason"]) ||
      !isWireStorageId(value.sessionId) || value.sessionId !== sessionId || typeof value.clipsTruncated !== "boolean" || typeof value.stale !== "boolean" ||
      value.staleReason !== undefined && !["source_changed", "generator_changed", "unavailable"].includes(value.staleReason as string) ||
      !Array.isArray(value.clips) || value.clips.length > 256 || !Array.isArray(value.generators) ||
      value.buffer !== undefined && (!isMidiContinuationBuffer(value.buffer) || value.buffer.sessionId !== sessionId)) return false;
  return value.clips.every((clip) => isWireRecord(clip) && hasOnlyWireKeys<MidiContinuationView["clips"][number]>(clip,
    ["trackId", "clipId", "trackName", "clipName", "location", "startBeat", "durationBeats", "noteCount"]) &&
    isWireStorageId(clip.trackId) && isWireStorageId(clip.clipId) && text(clip.trackName, 1024) && text(clip.clipName, 1024) &&
    ["arrangement", "session"].includes(clip.location as string) && typeof clip.startBeat === "number" && Number.isFinite(clip.startBeat) && clip.startBeat >= 0 &&
    positive(clip.durationBeats) && Number.isSafeInteger(clip.noteCount) && Number(clip.noteCount) >= 0) &&
    new Set(value.clips.map((clip) => `${clip.trackId}:${clip.clipId}`)).size === value.clips.length &&
    value.generators.every((generator) => isWireRecord(generator) && hasOnlyWireKeys<MidiContinuationView["generators"][number]>(generator,
      ["toolName", "label", "signature", "inputArgument", "lengthArgument", "panel"]) &&
      text(generator.toolName, 128) && text(generator.label, 512) && text(generator.signature, 128) &&
      text(generator.inputArgument, 64) && text(generator.lengthArgument, 64) && generator.inputArgument !== generator.lengthArgument &&
      isPanel(generator.panel) && generator.panel.toolName === generator.toolName && generator.panel.signature === generator.signature);
}
