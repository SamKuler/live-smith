import type { MidiArtifactImportCommand } from "../app/midi-artifact-import.js";
import type { PluginParameterPanel } from "../plugins/parameter-panel.js";

export interface MidiContinuationClipRef { trackId: string; clipId: string }
export interface MidiContinuationClipChoice extends MidiContinuationClipRef {
  trackName: string;
  clipName: string;
  location: "arrangement" | "session";
  startBeat: number;
  durationBeats: number;
  noteCount: number;
}
export type MidiContinuationGenerator =
  | { kind: "model"; profileId: string; model: string; configurationFingerprint: string }
  | { kind: "plugin"; toolName: string; signature: string; inputArgument: string; lengthArgument: string; arguments: Record<string, unknown> };

export interface MidiContinuationBuffer {
  id: string;
  sessionId: string;
  sourceArtifactRef: string;
  sourceFingerprint: string;
  sourceClips: MidiContinuationClipRef[];
  segmentBeats: number;
  capacity: number;
  insertBeat: number;
  nextSequence: number;
  consumedCount: number;
  lastArtifactRef?: string;
  queue: { artifactRef: string; sequence: number; label: string; noteCount: number }[];
  generator: MidiContinuationGenerator;
  prompt: string;
  updatedAt: string;
}

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number) => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
export function isMidiContinuationBuffer(value: unknown): value is MidiContinuationBuffer {
  if (!record(value) || !keys(value, ["id", "sessionId", "sourceArtifactRef", "sourceFingerprint", "sourceClips", "segmentBeats", "capacity", "insertBeat", "nextSequence", "consumedCount", "lastArtifactRef", "queue", "generator", "prompt", "updatedAt"]) ||
      !id(value.id) || !id(value.sessionId) || !id(value.sourceArtifactRef) || !hash(value.sourceFingerprint) ||
      !Array.isArray(value.sourceClips) || !value.sourceClips.length || value.sourceClips.length > 16 ||
      !value.sourceClips.every((entry) => record(entry) && keys(entry, ["trackId", "clipId"]) && id(entry.trackId) && id(entry.clipId)) ||
      new Set(value.sourceClips.map((entry) => `${entry.trackId}:${entry.clipId}`)).size !== value.sourceClips.length ||
      typeof value.segmentBeats !== "number" || !Number.isFinite(value.segmentBeats) || value.segmentBeats < 1 || value.segmentBeats > 256 ||
      !Number.isInteger(value.capacity) || Number(value.capacity) < 1 || Number(value.capacity) > 4 ||
      typeof value.insertBeat !== "number" || !Number.isFinite(value.insertBeat) ||
      !Number.isSafeInteger(value.nextSequence) || Number(value.nextSequence) < 0 ||
      !Number.isSafeInteger(value.consumedCount) || Number(value.consumedCount) < 0 || Number(value.consumedCount) > Number(value.nextSequence) ||
      value.lastArtifactRef !== undefined && !id(value.lastArtifactRef) ||
      typeof value.prompt !== "string" || value.prompt.length > 8000 ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
      !Array.isArray(value.queue) || value.queue.length > Number(value.capacity) ||
      !value.queue.every((entry, index) => record(entry) && keys(entry, ["artifactRef", "sequence", "label", "noteCount"]) && id(entry.artifactRef) && text(entry.label, 120) && Number.isInteger(entry.noteCount) && Number(entry.noteCount) >= 1 && Number(entry.noteCount) <= 4096 && entry.sequence === Number(value.consumedCount) + index) ||
      new Set(value.queue.map((entry) => entry.artifactRef)).size !== value.queue.length ||
      value.queue.length !== Number(value.nextSequence) - Number(value.consumedCount) ||
      Number(value.insertBeat) + Number(value.consumedCount) * Number(value.segmentBeats) < 0 ||
      Number(value.nextSequence) > 0 && !id(value.lastArtifactRef) ||
      value.queue.length > 0 && value.queue.at(-1)?.artifactRef !== value.lastArtifactRef || !record(value.generator)) return false;
  const generator = value.generator;
  return generator.kind === "model"
    ? keys(generator, ["kind", "profileId", "model", "configurationFingerprint"]) && id(generator.profileId) && text(generator.model, 1024) && hash(generator.configurationFingerprint)
    : generator.kind === "plugin" && keys(generator, ["kind", "toolName", "signature", "inputArgument", "lengthArgument", "arguments"]) &&
      text(generator.toolName, 128) && text(generator.signature, 128) &&
      text(generator.inputArgument, 64) && text(generator.lengthArgument, 64) && generator.inputArgument !== generator.lengthArgument && record(generator.arguments);
}


export interface MidiContinuationGeneratorChoice {
  toolName: string;
  label: string;
  signature: string;
  inputArgument: string;
  lengthArgument: string;
  panel: PluginParameterPanel;
}

/** Explicitly loaded, Session-scoped control data. Buffer entries are persisted server facts. */
export interface MidiContinuationView {
  sessionId: string;
  clips: MidiContinuationClipChoice[];
  clipsTruncated: boolean;
  generators: MidiContinuationGeneratorChoice[];
  buffer?: MidiContinuationBuffer;
  stale: boolean;
  staleReason?: "source_changed" | "generator_changed" | "unavailable";
}

export type MidiContinuationCommand =
  | { kind: "load_midi_continuation"; sessionId: string }
  | { kind: "configure_midi_continuation"; sessionId: string; expectedBufferId: string | null;
      sourceClips: MidiContinuationClipRef[]; segmentBeats: number; capacity: number; prompt: string;
      generator: { kind: "model" } | { kind: "plugin"; toolName: string; signature: string; arguments: Record<string, unknown> } }
  | { kind: "fill_midi_continuation"; sessionId: string; bufferId: string }
  | (Omit<MidiArtifactImportCommand, "kind"> & { kind: "import_midi_continuation"; bufferId: string });
