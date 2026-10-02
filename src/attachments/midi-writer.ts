import type { NoteDescription } from "@ableton-extensions/sdk";
import { Buffer } from "node:buffer";
import { throwIfAborted } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";

export interface MidiWriteTrack {
  name: string;
  /** MIDI channels are numbered 1–16. */
  channel: number;
  notes: readonly Pick<NoteDescription, "pitch" | "startTime" | "duration" | "velocity">[];
}

const PPQ = 960;
interface NoteEvent { tick: number; pitch: number; velocity: number; off: boolean }

/** Writes note-only SMF format 1, rounding beat positions to 1/960 of a beat. */
export function writeStandardMidi(input: {
  tracks: readonly MidiWriteTrack[];
  durationBeats: number;
  signal?: AbortSignal;
}): Uint8Array {
  throwIfAborted(input.signal);
  if (!Number.isFinite(input.durationBeats) || input.durationBeats <= 0 || input.durationBeats > 100_000 ||
      !Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 32) {
    throw invalid("Choose 1–32 MIDI tracks and a positive duration of at most 100000 beats.");
  }
  const endTick = Math.round(input.durationBeats * PPQ);
  if (!endTick) throw invalid("MIDI duration must span at least one tick at 960 ticks per beat.");
  const header = Buffer.alloc(14);
  header.write("MThd"); header.writeUInt32BE(6, 4); header.writeUInt16BE(1, 8);
  header.writeUInt16BE(input.tracks.length, 10); header.writeUInt16BE(PPQ, 12);
  const chunks = [header];
  let noteCount = 0;
  for (const track of input.tracks) {
    if (typeof track.name !== "string" || Buffer.byteLength(track.name, "utf8") > 4096 ||
        !Number.isInteger(track.channel) || track.channel < 1 || track.channel > 16 || !Array.isArray(track.notes)) {
      throw invalid("MIDI tracks require a UTF-8 name of at most 4096 bytes and a channel from 1 to 16.");
    }
    noteCount += track.notes.length;
    if (noteCount > 4096) throw invalid("A MIDI file may contain at most 4096 notes.");
    const events: NoteEvent[] = [];
    const pitchEnds = new Map<number, number>();
    for (const note of [...track.notes].sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch)) {
      const velocity = note.velocity ?? 100;
      if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 ||
          !Number.isInteger(velocity) || velocity < 1 || velocity > 127 ||
          !Number.isFinite(note.startTime) || note.startTime < 0 ||
          !Number.isFinite(note.duration) || note.duration <= 0) {
        throw invalid("MIDI notes require pitch 0–127, velocity 1–127, a non-negative start and a positive duration.");
      }
      const start = Math.round(note.startTime * PPQ);
      const end = Math.round((note.startTime + note.duration) * PPQ);
      if (end <= start || end > endTick || start >= endTick) {
        throw invalid("Each MIDI note must span at least one tick and fit inside the section after rounding to 960 ticks per beat.");
      }
      if (start < (pitchEnds.get(note.pitch) ?? 0)) {
        throw invalid("Notes of the same pitch cannot overlap within one MIDI track and channel.");
      }
      pitchEnds.set(note.pitch, end);
      events.push({ tick: start, pitch: note.pitch, velocity, off: false },
        { tick: end, pitch: note.pitch, velocity: 0, off: true });
    }
    events.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off) || a.pitch - b.pitch);
    const name = Buffer.from(track.name, "utf8");
    const body = [0, 0xff, 0x03, ...variableLength(name.length), ...name];
    let previousTick = 0;
    for (const event of events) {
      body.push(...variableLength(event.tick - previousTick), (event.off ? 0x80 : 0x90) | (track.channel - 1), event.pitch, event.velocity);
      previousTick = event.tick;
    }
    body.push(...variableLength(endTick - previousTick), 0xff, 0x2f, 0);
    const chunk = Buffer.alloc(8);
    chunk.write("MTrk"); chunk.writeUInt32BE(body.length, 4);
    chunks.push(chunk, Buffer.from(body));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining; remaining >>>= 7) bytes.unshift((remaining & 0x7f) | 0x80);
  return bytes;
}

function invalid(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_midi", message);
}
