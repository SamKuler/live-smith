export const MAX_MIDI_PREVIEW_NOTES = 256;
/** Matches the existing Live observer's default parameter value-item page. */
export const MAX_PARAMETER_PREVIEW_VALUE_ITEMS = 12;

/** Serializable proposed facts, never SDK target identities or write authority. */
export interface MidiPreviewNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity?: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
  releaseVelocity?: number;
  selected?: boolean;
}

export interface MidiActionPreview {
  kind: "midi-notes";
  actionIndex: number;
  status: "proposed";
  targetLabel: string;
  range: { coordinate: "clip-beats"; start: number; end: number };
  before: { notes: MidiPreviewNote[]; totalNoteCount: number; omittedNoteCount: number };
  after: { notes: MidiPreviewNote[]; totalNoteCount: number; omittedNoteCount: number };
}

export interface ParameterActionPreview {
  kind: "parameter-value";
  actionIndex: number;
  status: "proposed";
  targetLabel: string;
  parameterName: string;
  before: number;
  after: number;
  minimum: number;
  maximum: number;
  isQuantized?: boolean;
  /** SDK labels only; the SDK does not define their numeric value mapping. */
  valueItems?: { name: string; shortName: string }[];
}

export type AgentActionPreview = MidiActionPreview | ParameterActionPreview;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isMidiPreviewNote(note: unknown): note is MidiPreviewNote {
  return isRecord(note) && hasOnlyKeys(note, [
    "pitch", "startTime", "duration", "velocity", "muted", "probability",
    "velocityDeviation", "releaseVelocity", "selected",
  ]) && isSafeInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
    isFiniteNumber(note.startTime) && isFiniteNumber(note.duration) && note.duration > 0 &&
    ["velocity", "probability", "velocityDeviation", "releaseVelocity"].every((key) =>
      note[key] === undefined || isFiniteNumber(note[key])) &&
    ["muted", "selected"].every((key) => note[key] === undefined || typeof note[key] === "boolean");
}

function isMidiPreviewSide(side: unknown, range: { start: number; end: number }): side is MidiActionPreview["before"] {
  return isRecord(side) && hasOnlyKeys(side, ["notes", "totalNoteCount", "omittedNoteCount"]) &&
    Array.isArray(side.notes) && side.notes.length <= MAX_MIDI_PREVIEW_NOTES && side.notes.every(isMidiPreviewNote) &&
    side.notes.every((note) => note.startTime >= range.start && note.startTime < range.end &&
      note.startTime + note.duration <= range.end + 1e-7) &&
    isSafeInteger(side.totalNoteCount) && side.totalNoteCount >= side.notes.length &&
    side.omittedNoteCount === side.totalNoteCount - side.notes.length;
}

function isAgentActionPreview(preview: unknown): preview is AgentActionPreview {
  if (!isRecord(preview) || preview.actionIndex !== 0 || preview.status !== "proposed" ||
    typeof preview.targetLabel !== "string") return false;
  if (preview.kind === "midi-notes") {
    const range = preview.range;
    return hasOnlyKeys(preview, ["kind", "actionIndex", "status", "targetLabel", "range", "before", "after"]) &&
      isRecord(range) && hasOnlyKeys(range, ["coordinate", "start", "end"]) &&
      range.coordinate === "clip-beats" && isFiniteNumber(range.start) && isFiniteNumber(range.end) &&
      range.start >= 0 && range.end > range.start && isMidiPreviewSide(preview.before, { start: range.start, end: range.end }) && isMidiPreviewSide(preview.after, { start: range.start, end: range.end });
  }
  return preview.kind === "parameter-value" && hasOnlyKeys(preview, [
    "kind", "actionIndex", "status", "targetLabel", "parameterName", "before", "after",
    "minimum", "maximum", "isQuantized", "valueItems",
  ]) && typeof preview.parameterName === "string" &&
    isFiniteNumber(preview.before) && isFiniteNumber(preview.after) &&
    isFiniteNumber(preview.minimum) && isFiniteNumber(preview.maximum) &&
    preview.minimum <= preview.maximum &&
    preview.before >= preview.minimum && preview.before <= preview.maximum &&
    preview.after >= preview.minimum && preview.after <= preview.maximum &&
    (preview.isQuantized === undefined || typeof preview.isQuantized === "boolean") &&
    (preview.valueItems === undefined || Array.isArray(preview.valueItems) &&
      preview.valueItems.length <= MAX_PARAMETER_PREVIEW_VALUE_ITEMS && preview.valueItems.every((item) =>
      isRecord(item) && hasOnlyKeys(item, ["name", "shortName"]) &&
      typeof item.name === "string" && typeof item.shortName === "string"));
}

export function isAgentActionPreviews(value: unknown): value is AgentActionPreview[] {
  return Array.isArray(value) && value.length === 1 && value.every(isAgentActionPreview);
}

/** Outcome metadata never converts proposal snapshots into observed Live state. */
export interface AgentApplyOperation {
  id: string;
  status: "proposed" | "approved" | "applied" | "partial" | "cancelled" | "failed";
  previews?: AgentActionPreview[];
}

export function isAgentApplyOperation(value: unknown, eventKind: unknown): value is AgentApplyOperation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "status", "previews"]) ||
    typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.id)) return false;
  if (eventKind === "apply_requested") return value.status === "proposed" &&
    (value.previews === undefined || isAgentActionPreviews(value.previews));
  if (value.previews !== undefined) return false;
  if (eventKind === "apply_auto_approved") return value.status === "approved";
  return eventKind === "apply_result" &&
    typeof value.status === "string" && ["applied", "partial", "cancelled", "failed"].includes(value.status);
}
