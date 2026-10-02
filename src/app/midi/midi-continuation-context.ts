import { MidiClip, MidiTrack, type ExtensionContext, type NoteDescription } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";
import type { MidiWriteTrack } from "../../attachments/midi-writer.js";
import { throwIfAborted } from "../../runtime/host.js";
import { projectMidiClipNotes } from "../../live/midi-clip-timing.js";

import type { MidiContinuationClipChoice, MidiContinuationClipRef } from "../../agent/midi-continuation-contracts.js";
export type { MidiContinuationClipRef } from "../../agent/midi-continuation-contracts.js";


function sourceClips(context: ExtensionContext<"1.0.0">) {
  return context.application.song.tracks.filter((track) => track instanceof MidiTrack).flatMap((track) => [
    ...track.arrangementClips.filter((clip) => clip instanceof MidiClip).map((clip) => ({ track, clip, location: "arrangement" as const })),
    ...track.clipSlots.flatMap((slot) => slot.clip instanceof MidiClip ? [{ track, clip: slot.clip, location: "session" as const }] : []),
  ]);
}

export function observeMidiContinuationClips(context: ExtensionContext<"1.0.0">): MidiContinuationClipChoice[] {
  return sourceClips(context).slice(0, 257).map(({ track, clip, location }) => ({
    trackId: String(track.handle.id), clipId: String(clip.handle.id), trackName: track.name.slice(0, 160),
    clipName: clip.name.slice(0, 160), location, startBeat: location === "arrangement" ? clip.startTime : 0,
    durationBeats: clip.duration, noteCount: clip.notes.length,
  }));
}

function noteSnapshot(note: NoteDescription) {
  return { pitch: note.pitch, startTime: note.startTime, duration: note.duration, velocity: note.velocity ?? 100,
    muted: note.muted ?? false, probability: note.probability ?? 1,
    velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 };
}

/** Reads only the selected clips; importing new Arrangement clips does not invalidate this source. */
export function captureMidiContinuationContext(context: ExtensionContext<"1.0.0">, refs: readonly MidiContinuationClipRef[], signal?: AbortSignal): {
  fingerprint: string; tracks: MidiWriteTrack[]; durationBeats: number; insertBeat: number; tempo: number;
  ranges: { trackId: string; location: "arrangement" | "session"; startBeat: number; durationBeats: number }[];
} {
  throwIfAborted(signal);
  if (!refs.length || refs.length > 16 || new Set(refs.map((ref) => `${ref.trackId}:${ref.clipId}`)).size !== refs.length) {
    throw new Error("Choose between one and sixteen distinct MIDI source clips.");
  }
  const available = sourceClips(context);
  let noteCount = 0;
  const selected = refs.map((ref) => {
    const found = available.find(({ track, clip }) => String(track.handle.id) === ref.trackId && String(clip.handle.id) === ref.clipId);
    if (!found) throw new Error("A selected MIDI source clip is no longer available. Observe the sources again.");
    const notes = found.clip.notes;
    noteCount += notes.length;
    if (noteCount > 4096) throw new Error("The selected source clips exceed the 4096-note MIDI context budget.");
    return { ...found, notes: notes.map(noteSnapshot) };
  });
  const tempo = context.application.song.tempo;
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error("The current Live tempo is unavailable.");
  const arrangement = selected.filter((source) => source.location === "arrangement");
  const firstBeat = arrangement.length ? Math.min(...arrangement.map(({ clip }) => clip.startTime)) : 0;
  let expandedNotes = 0;
  const tracks = selected.map(({ track, clip, location, notes }, index) => {
    const projected = projectMidiClipNotes(notes, clip, 4096 - expandedNotes, signal);
    expandedNotes += projected.length;
    return { name: track.name, channel: index + 1,
      notes: projected.map(({ pitch, startTime, duration, velocity }) => ({
        pitch, startTime: startTime + (location === "arrangement" ? clip.startTime - firstBeat : 0), duration, velocity,
      })) };
  });
  const durationBeats = Math.max(...selected.map(({ clip, location }) => clip.duration + (location === "arrangement" ? clip.startTime - firstBeat : 0)));
  const snapshot = { tempo, clips: selected.map(({ track, clip, location, notes }) => ({
    trackId: String(track.handle.id), clipId: String(clip.handle.id), location,
    startBeat: location === "arrangement" ? clip.startTime : 0, duration: clip.duration,
    startMarker: clip.startMarker, endMarker: clip.endMarker, looping: clip.looping, loopStart: clip.loopStart, loopEnd: clip.loopEnd, muted: clip.muted, notes,
  })) };
  throwIfAborted(signal);
  return { tracks, durationBeats, tempo,
    ranges: selected.map(({ track, clip, location }) => ({ trackId: String(track.handle.id), location, startBeat: location === "arrangement" ? clip.startTime : 0, durationBeats: clip.duration })),
    insertBeat: arrangement.length ? Math.max(...arrangement.map(({ clip }) => clip.startTime + clip.duration)) : 0,
    fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}
