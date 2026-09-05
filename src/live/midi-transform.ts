import type { NoteDescription } from "@ableton-extensions/sdk";
import type { AgentAction } from "../agent/actions.js";

export type MidiNoteEditAction = Extract<AgentAction, {
  type: "replace_midi_clip_segment" | "transpose_midi_notes" | "quantize_midi_notes"
    | "scale_midi_velocity" | "shift_midi_notes";
}>;

/** The proposed note set and no-op decision shared by preflight and execution. */
export function calculateMidiNoteEdit(
  clip: { name: string; duration: number; notes: readonly NoteDescription[] },
  action: MidiNoteEditAction,
): { notes: NoteDescription[]; changed: boolean; removedNoteCount: number } {
  if (action.type === "replace_midi_clip_segment") {
    const segmentEnd = action.segmentStartTime + action.segmentDurationBeats;
    const tolerance = 1e-7;
    if (segmentEnd > clip.duration + tolerance) {
      throw new Error(
        `Relative segment ${action.segmentStartTime}-${segmentEnd} exceeds MIDI clip "${clip.name}" bounds 0-${clip.duration}. Inspect the clip and use a segment inside its duration.`,
      );
    }
    const preserved = clip.notes.filter((note) => !(
      note.startTime < segmentEnd - tolerance &&
      note.startTime + note.duration > action.segmentStartTime + tolerance
    ));
    const merged = [...preserved, ...action.notes].sort(compareMidiNotes);
    const changed = !midiNotesEqual(clip.notes, merged);
    return {
      notes: (changed ? merged : clip.notes).map((note) => ({ ...note })),
      changed,
      removedNoteCount: clip.notes.length - preserved.length,
    };
  }
  const transformed = transformMidiNotes(clip.notes, clip.duration, midiTransformForAction(action));
  return {
    notes: transformed,
    changed: !transformedMidiNotesEqual(clip.notes, transformed),
    removedNoteCount: 0,
  };
}

export type MidiTransform =
  | { type: "transpose"; semitones: number }
  | { type: "quantize"; gridBeats: number; strength: number }
  | { type: "scale_velocity"; factor: number }
  | { type: "shift"; offsetBeats: number };

export function transformMidiNotes(
  notes: readonly NoteDescription[],
  clipDuration: number,
  transform: MidiTransform,
): NoteDescription[] {
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
    throw new Error("MIDI Clip duration must be positive and finite.");
  }
  validateTransform(transform);

  return notes.map((note, index) => {
    assertValidNote(note, index);
    let transformed: NoteDescription;
    switch (transform.type) {
      case "transpose":
        transformed = { ...note, pitch: note.pitch + transform.semitones };
        break;
      case "quantize": {
        if (transform.strength === 0) {
          transformed = { ...note };
          break;
        }
        const gridPosition = note.startTime / transform.gridBeats;
        if (!Number.isFinite(gridPosition)) {
          throw new Error("MIDI quantize grid position must remain finite.");
        }
        const gridIndex = Math.round(gridPosition);
        if (!Number.isSafeInteger(gridIndex)) {
          throw new Error("MIDI quantize grid index must be represented safely.");
        }
        const nearest = gridIndex * transform.gridBeats;
        if (!Number.isFinite(nearest)) {
          throw new Error("MIDI quantize nearest beat must remain finite.");
        }
        const startTime = note.startTime +
          (nearest - note.startTime) * transform.strength;
        if (!Number.isFinite(startTime)) {
          throw new Error("MIDI quantize note start must remain finite.");
        }
        transformed = {
          ...note,
          startTime,
        };
        break;
      }
      case "scale_velocity": {
        const velocity = clamp(
          Math.round((note.velocity ?? 100) * transform.factor),
          1,
          127,
        );
        transformed = {
          ...note,
          ...(note.velocity === undefined && velocity === 100
            ? {}
            : { velocity }),
        };
        break;
      }
      case "shift":
        transformed = {
          ...note,
          startTime: note.startTime + transform.offsetBeats,
        };
        break;
    }
    assertTransformedNote(transformed, clipDuration, index);
    return transformed;
  });
}

function validateTransform(transform: MidiTransform): void {
  switch (transform.type) {
    case "transpose":
      if (!Number.isSafeInteger(transform.semitones)) {
        throw new Error("MIDI transpose semitones must be an integer.");
      }
      return;
    case "quantize":
      if (!Number.isFinite(transform.gridBeats) || transform.gridBeats <= 0) {
        throw new Error("MIDI quantize gridBeats must be positive and finite.");
      }
      if (
        !Number.isFinite(transform.strength) ||
        transform.strength < 0 ||
        transform.strength > 1
      ) {
        throw new Error("MIDI quantize strength must be between 0 and 1.");
      }
      return;
    case "scale_velocity":
      if (!Number.isFinite(transform.factor) || transform.factor <= 0) {
        throw new Error("MIDI velocity factor must be positive and finite.");
      }
      return;
    case "shift":
      if (!Number.isFinite(transform.offsetBeats)) {
        throw new Error("MIDI shift offsetBeats must be finite.");
      }
  }
}

function assertValidNote(note: NoteDescription, index: number): void {
  if (
    !Number.isInteger(note.pitch) ||
    !Number.isFinite(note.startTime) ||
    !Number.isFinite(note.duration) ||
    note.duration <= 0 ||
    (note.velocity !== undefined &&
      (!Number.isInteger(note.velocity) ||
        note.velocity < 1 ||
        note.velocity > 127))
  ) {
    throw new Error(`MIDI note ${index + 1} is invalid.`);
  }
}

function assertTransformedNote(
  note: NoteDescription,
  clipDuration: number,
  index: number,
): void {
  const end = note.startTime + note.duration;
  if (
    !Number.isFinite(note.pitch) ||
    !Number.isFinite(note.startTime) ||
    !Number.isFinite(note.duration) ||
    !Number.isFinite(end) ||
    (note.velocity !== undefined && !Number.isFinite(note.velocity))
  ) {
    throw new Error(`MIDI note ${index + 1} must remain finite after transform.`);
  }
  if (note.pitch < 0 || note.pitch > 127) {
    throw new Error(
      `MIDI note ${index + 1} pitch ${note.pitch} is outside 0-127 after transform.`,
    );
  }
  const normalizedEnd = nearlyEqual(end, clipDuration) ? clipDuration : end;
  if (note.startTime < 0 || normalizedEnd > clipDuration) {
    throw new Error(
      `MIDI note ${index + 1} at ${note.startTime}-${end} is outside Clip bounds 0-${clipDuration} after transform.`,
    );
  }
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 4;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function midiTransformForAction(
  action: Extract<AgentAction, {
    type:
      | "transpose_midi_notes"
      | "quantize_midi_notes"
      | "scale_midi_velocity"
      | "shift_midi_notes";
  }>,
): MidiTransform {
  switch (action.type) {
    case "transpose_midi_notes":
      return { type: "transpose", semitones: action.semitones };
    case "quantize_midi_notes":
      return {
        type: "quantize",
        gridBeats: action.gridBeats,
        strength: action.strength,
      };
    case "scale_midi_velocity":
      return { type: "scale_velocity", factor: action.factor };
    case "shift_midi_notes":
      return { type: "shift", offsetBeats: action.offsetBeats };
  }
}

function compareMidiNotes(left: NoteDescription, right: NoteDescription): number {
  return left.startTime - right.startTime ||
    left.pitch - right.pitch ||
    left.duration - right.duration ||
    compareOptionalNumbers(left.velocity, right.velocity) ||
    compareOptionalBooleans(left.muted, right.muted) ||
    compareOptionalNumbers(left.probability, right.probability) ||
    compareOptionalNumbers(left.velocityDeviation, right.velocityDeviation) ||
    compareOptionalNumbers(left.releaseVelocity, right.releaseVelocity);
}

export function midiNotesEqual(
  left: readonly NoteDescription[],
  right: readonly NoteDescription[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareMidiNotes);
  const sortedRight = [...right].sort(compareMidiNotes);
  return sortedLeft.every((note, index) => midiNoteEqual(note, sortedRight[index]!));
}

function transformedMidiNotesEqual(
  current: readonly NoteDescription[],
  transformed: readonly NoteDescription[],
): boolean {
  return current.length === transformed.length && current.every((note, index) => {
    const candidate = transformed[index]!;
    return note.pitch === candidate.pitch &&
      note.startTime === candidate.startTime &&
      note.duration === candidate.duration &&
      note.velocity === candidate.velocity &&
      note.muted === candidate.muted &&
      note.probability === candidate.probability &&
      note.velocityDeviation === candidate.velocityDeviation &&
      note.releaseVelocity === candidate.releaseVelocity;
  });
}

function midiNoteEqual(left: NoteDescription, right: NoteDescription): boolean {
  return left.pitch === right.pitch &&
    sameMidiNumericValue(left.startTime, right.startTime) &&
    sameMidiNumericValue(left.duration, right.duration) &&
    optionalNumbersEqual(left.velocity, right.velocity) &&
    left.muted === right.muted &&
    optionalNumbersEqual(left.probability, right.probability) &&
    optionalNumbersEqual(left.velocityDeviation, right.velocityDeviation) &&
    optionalNumbersEqual(left.releaseVelocity, right.releaseVelocity);
}

function optionalNumbersEqual(left?: number, right?: number): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameMidiNumericValue(left, right);
}

function compareOptionalNumbers(left?: number, right?: number): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return left - right;
}

function compareOptionalBooleans(left?: boolean, right?: boolean): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left ? 1 : -1;
}

function sameMidiNumericValue(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-7;
}
