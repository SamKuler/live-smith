import type { NoteDescription } from "@ableton-extensions/sdk";
import { throwIfAborted } from "../runtime/host.js";

type Note = Pick<NoteDescription, "pitch" | "startTime" | "duration" | "velocity" | "muted">;
type ProjectedNote = Required<Pick<NoteDescription, "pitch" | "startTime" | "duration" | "velocity">>;
interface ClipTiming {
  duration: number; startMarker: number; endMarker: number;
  looping: boolean; loopStart: number; loopEnd: number; muted: boolean;
}

/** Creation writes section-relative notes directly into the retained source timeline. */
export function midiClipHasAuthoringTiming(timing: Pick<ClipTiming, "duration" | "startMarker" | "endMarker" | "looping" | "loopEnd">, durationBeats: number): boolean {
  return Math.abs(timing.duration - durationBeats) < 0.0001 &&
    timing.startMarker === 0 &&
    (timing.looping
      ? timing.loopEnd >= durationBeats
      : timing.endMarker >= durationBeats);
}

/** Projects nominal note intervals into the bounded Clip span, cropping at markers and each loop boundary. */
export function projectMidiClipNotes(notes: readonly Note[], timing: ClipTiming, maxNotes: number, signal?: AbortSignal): ProjectedNote[] {
  throwIfAborted(signal);
  const { duration, startMarker, endMarker, loopStart, loopEnd } = timing;
  if (![duration, startMarker, endMarker, loopStart, loopEnd].every(Number.isFinite) || duration <= 0 ||
      (timing.looping ? loopEnd <= loopStart : endMarker < startMarker)) {
    throw new Error("The MIDI source Clip has unavailable marker or loop timing.");
  }
  if (timing.muted) return [];
  const crop = (start: number, length: number): ProjectedNote[] => notes.flatMap((note) => {
    const left = Math.max(start, note.startTime), right = Math.min(start + length, note.startTime + note.duration);
    return !note.muted && right > left ? [{ pitch: note.pitch, startTime: left - start, duration: right - left, velocity: note.velocity ?? 100 }] : [];
  });
  if (!timing.looping) {
    const result = crop(startMarker, Math.min(duration, endMarker - startMarker));
    if (result.length > maxNotes) throw new Error("The expanded source clips exceed the 4096-note MIDI context budget.");
    return result;
  }
  const loopLength = loopEnd - loopStart;
  const firstStart = startMarker < loopEnd ? startMarker : loopStart + ((startMarker - loopStart) % loopLength);
  const firstLength = Math.min(duration, loopEnd - firstStart);
  const result = crop(firstStart, firstLength);
  if (result.length > maxNotes) throw new Error("The expanded source clips exceed the 4096-note MIDI context budget.");
  const repeated = crop(loopStart, loopLength);
  if (!repeated.length) return result;
  const remaining = duration - firstLength;
  for (const note of repeated) {
    const occurrences = Math.max(0, Math.ceil((remaining - note.startTime) / loopLength));
    if (occurrences > maxNotes - result.length) throw new Error("The expanded source clips exceed the 4096-note MIDI context budget.");
    for (let index = 0; index < occurrences; index++) {
      throwIfAborted(signal);
      const startTime = firstLength + index * loopLength + note.startTime;
      result.push({ ...note, startTime, duration: Math.min(note.duration, duration - startTime) });
    }
  }
  return result.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}
