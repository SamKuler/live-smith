import { writeStandardMidi } from "../../attachments/midi-writer.js";
import type { ModelTool, RuntimeProfile } from "../../model/provider.js";
import type { Toolset } from "../../plugins/registry.js";
import { throwIfAborted } from "../../runtime/host.js";
import { isSafeStorageId } from "../../storage/id.js";
import { midiArtifactVersion, saveMidiArtifact, type MidiArtifact } from "../../storage/midi-artifacts.js";
import { midiArtifactAuthoringSchema, parseMidiArtifactAuthoringArguments } from "./midi-artifact-authoring.js";

export const midiArtifactAuthoringTool = { type: "function", function: {
  name: "save_midi_artifact",
  description: "Save a multitrack MIDI artifact in this Session without changing Live. Supply named tracks, MIDI channels and note timing in quarter-note beats relative to the file start. durationBeats includes trailing silence. To revise a saved artifact, pass its artifactRef as revisionOf; the next-chat source selected by the user is applied automatically. Every revision creates a new immutable version. Use list_session_artifacts and inspect_midi_artifact to read source notes. The user can inspect version changes, export, attach or import saved versions.",
  parameters: { ...midiArtifactAuthoringSchema,
    required: [...midiArtifactAuthoringSchema.required, "durationBeats"],
    properties: { ...midiArtifactAuthoringSchema.properties,
      durationBeats: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
      revisionOf: { type: "string", description: "Existing MIDI artifactRef from this Session. Omit to start a new group unless a source was selected for this request." },
    },
  },
} } satisfies ModelTool;

/** Saves model-authored artifacts independently of Live mutation. */
export function createMidiArtifactAuthoringToolset(input: {
  storageDirectory: string;
  sessionId: string;
  runtimeProfile: RuntimeProfile;
  signal: AbortSignal;
  revisionOf?: string;
}): Toolset {
  return {
    id: "live-smith.midi-authoring",
    tools: () => [midiArtifactAuthoringTool],
    async callTool(call) {
      let bytes: Uint8Array, label: string, revisionOf: string | undefined;
      try {
        const value: unknown = JSON.parse(call.arguments);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide a MIDI artifact object.");
        const args = value as Record<string, unknown>;
        if (Object.keys(args).some((key) => !["label", "tracks", "durationBeats", "revisionOf"].includes(key)) ||
            typeof args.durationBeats !== "number" ||
            args.revisionOf !== undefined && !isSafeStorageId(args.revisionOf)) throw new Error("Provide valid durationBeats and an optional Session MIDI revisionOf reference.");
        if (input.revisionOf && args.revisionOf !== undefined && args.revisionOf !== input.revisionOf) {
          throw new Error("This request is revising the source selected by the user. Use that source or omit revisionOf.");
        }
        revisionOf = input.revisionOf ?? args.revisionOf as string | undefined;
        const parsed = parseMidiArtifactAuthoringArguments({ label: args.label, tracks: args.tracks });
        if (!parsed.tracks.some((track) => track.notes.length)) throw new Error("A saved MIDI artifact must contain at least one note.");
        label = parsed.label;
        bytes = writeStandardMidi({ tracks: parsed.tracks, durationBeats: args.durationBeats, signal: input.signal });
      } catch (error) {
        throwIfAborted(input.signal);
        return { content: error instanceof Error ? error.message : "Invalid MIDI artifact.", failed: true, invalidArguments: true };
      }
      try {
        const artifact = await saveMidiArtifact(input.storageDirectory, input.sessionId, {
          source: { kind: "model", profileId: input.runtimeProfile.profile.id, model: input.runtimeProfile.model.model },
          serverId: "host", toolName: "save_midi_artifact", label, bytes, signal: input.signal,
          ...(revisionOf ? { revisionOf } : {}),
        });
        return { content: JSON.stringify({ artifacts: [midiArtifactView(artifact)] }), artifacts: [{ kind: "midi", id: artifact.id }] };
      } catch {
        throwIfAborted(input.signal);
        return { content: "MIDI artifact storage could not be confirmed. Check this Session's saved artifacts before retrying.", failed: true, stop: true };
      }
    },
  };
}

export function midiArtifactView(artifact: MidiArtifact) {
  return {
    kind: "midi" as const,
    version: midiArtifactVersion(artifact),
    artifactRef: artifact.id,
    label: artifact.label,
    format: artifact.format,
    trackCount: artifact.trackCount,
    noteCount: artifact.noteCount,
    durationBeats: artifact.durationBeats,
    createdAt: artifact.createdAt,
  };
}
