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
