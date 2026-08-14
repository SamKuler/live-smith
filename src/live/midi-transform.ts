import type { NoteDescription } from "@ableton-extensions/sdk";

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
