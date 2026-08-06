import type { NoteDescription } from "@ableton-extensions/sdk";

export function summarizeMidiNotes(
  notes: NoteDescription[],
  options: { limit?: number; offset?: number } = {},
): string {
  const limit = options.limit ?? 64;
  const offset = options.offset ?? 0;
  const sorted = [...notes].sort(
    (left, right) => left.startTime - right.startTime || left.pitch - right.pitch,
  );
  const shown = sorted.slice(offset, offset + limit);
  const lines = [
    `notes=${notes.length}`,
    ...shown.map((note, index) => `${offset + index + 1}. ${describeMidiNote(note)}`),
  ];

  if (offset > 0) {
    lines.push(`... ${Math.min(offset, sorted.length)} earlier notes omitted.`);
  }
  const remaining = Math.max(0, sorted.length - offset - shown.length);
  if (remaining > 0) {
    lines.push(`... ${remaining} later notes omitted; continue with noteOffset=${offset + shown.length}.`);
  }

  return lines.join("\n");
}

function describeMidiNote(note: NoteDescription): string {
  return [
    `pitch=${note.pitch}`,
    `name=${midiNoteName(note.pitch)}`,
    `start=${note.startTime}`,
    `duration=${note.duration}`,
    `velocity=${note.velocity ?? 100}`,
  ].join(", ");
}

export function midiNoteName(pitch: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const normalized = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12) - 1;
  return `${names[normalized]}${octave}`;
}
