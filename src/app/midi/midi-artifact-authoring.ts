import type { MidiWriteTrack } from "../../attachments/midi-writer.js";

export const midiArtifactAuthoringSchema = {
  type: "object", additionalProperties: false, required: ["label", "tracks"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 120 },
    tracks: { type: "array", minItems: 1, maxItems: 32, items: {
      type: "object", additionalProperties: false, required: ["name", "channel", "notes"], properties: {
        name: { type: "string", minLength: 1, maxLength: 120 }, channel: { type: "integer", minimum: 1, maximum: 16 },
        notes: { type: "array", maxItems: 4096, items: { type: "object", additionalProperties: false,
          required: ["pitch", "startTime", "duration", "velocity"], properties: {
            pitch: { type: "integer", minimum: 0, maximum: 127 }, startTime: { type: "number", minimum: 0 },
            duration: { type: "number", exclusiveMinimum: 0 }, velocity: { type: "integer", minimum: 1, maximum: 127 },
          } } },
      },
    } },
  },
};

export function parseMidiArtifactAuthoringArguments(value: unknown): { label: string; tracks: MidiWriteTrack[] } {
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  const only = (item: Record<string, unknown>, allowed: string[]) => Object.keys(item).every((key) => allowed.includes(key));
  if (!record(value) || !only(value, ["label", "tracks"]) || typeof value.label !== "string" || !value.label.trim() || value.label.length > 120 || /[\u0000-\u001f\u007f]/u.test(value.label) ||
      !Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > 32 ||
      !value.tracks.every((track) => record(track) && only(track, ["name", "channel", "notes"]) &&
        typeof track.name === "string" && track.name.length > 0 && track.name.length <= 120 &&
        Array.isArray(track.notes) && track.notes.every((note) => record(note) && only(note, ["pitch", "startTime", "duration", "velocity"]) &&
          ["pitch", "startTime", "duration", "velocity"].every((key) => typeof note[key] === "number")))) {
    throw new Error("Provide a label and named MIDI tracks with channel, pitch, startTime, duration and velocity.");
  }
  return value as unknown as { label: string; tracks: MidiWriteTrack[] };
}
