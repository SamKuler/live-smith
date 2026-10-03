import { writeStandardMidi } from "../../attachments/midi-writer.js";
import type { RuntimeProfile } from "../../model/provider.js";
import type { Toolset } from "../../plugins/registry.js";
import { throwIfAborted } from "../../runtime/host.js";
import { isSafeStorageId } from "../../storage/id.js";
import { midiArtifactVersion, saveMidiArtifact, inspectMidiArtifacts, readMidiArtifact, midiArtifactPartSummaries, type MidiArtifact } from "../../storage/midi-artifacts.js";
import { midiArtifactAuthoringSchema, parseMidiArtifactAuthoringArguments } from "./midi-artifact-authoring.js";

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
    tools: () => [{ type: "function", function: {
      name: "save_midi_artifact",
      description: "Save a multitrack MIDI artifact in this Session without changing Live. Supply named tracks, MIDI channels and note timing in quarter-note beats relative to the file start. durationBeats includes trailing silence. To revise a saved artifact, pass its artifactRef as revisionOf; the next-chat source selected by the user is applied automatically. Every revision creates a new immutable version. Use list_session_artifacts and inspect_midi_artifact to read source notes. The user can compare, export, attach or import saved versions.",
      parameters: { ...midiArtifactAuthoringSchema,
        required: [...midiArtifactAuthoringSchema.required, "durationBeats"],
        properties: { ...midiArtifactAuthoringSchema.properties,
          durationBeats: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
          revisionOf: { type: "string", description: "Existing MIDI artifactRef from this Session. Omit to start a new group unless a source was selected for this request." },
        },
      },
    } }],
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
        return { content: JSON.stringify({ artifacts: [midiArtifactView(artifact)] }) };
      } catch {
        throwIfAborted(input.signal);
        return { content: "MIDI artifact storage could not be confirmed. Check this Session's saved artifacts before retrying.", failed: true, stop: true };
      }
    },
  };
}

export function createSessionMidiArtifactToolset(
  input: { storageDirectory: string | undefined; sessionId: string; signal?: AbortSignal },
): Toolset {
  return {
    id: "live-smith.artifacts",
    tools: () => [{
      type: "function",
      function: {
        name: "list_session_artifacts",
        description: "List validated non-audio artifacts saved in this Session. If saved MIDI data is unavailable, the result includes an unavailableCount and warning; do not use those missing artifacts. Use an exact listed MIDI artifactRef with create_midi_clip_from_artifact when that action is available. This verifies saved MIDI bytes and returns read-derived source part summaries and timing event counts; it does not run a Plugin or change Live. For multitrack MIDI, select a listed partId per destination or explicitly request mergeParts.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }, {
      type: "function",
      function: {
        name: "inspect_midi_artifact",
        description: "Read exact saved MIDI notes for one source part from list_session_artifacts. Notes use source-relative quarter-note beats; channel and source track identity remain in the part summary. Returns at most 256 notes with nextOffset for pagination. Reads this Session only; does not change Live or run a generator.",
        parameters: { type: "object", properties: {
          artifactRef: { type: "string" }, partId: { type: "string" }, offset: { type: "integer", minimum: 0 },
        }, required: ["artifactRef", "partId"], additionalProperties: false },
      },
    }],
    async callTool(call) {
      if (call.name !== "list_session_artifacts" && call.name !== "inspect_midi_artifact") return invalidArguments();
      try {
        const value: unknown = JSON.parse(call.arguments || "{}");
        if (call.name === "inspect_midi_artifact") {
          if (!value || typeof value !== "object" || Array.isArray(value)) return invalidArguments();
          const args = value as Record<string, unknown>;
          if (Object.keys(args).some((key) => !["artifactRef", "partId", "offset"].includes(key)) ||
              !isSafeStorageId(args.artifactRef) || typeof args.partId !== "string" ||
              args.offset !== undefined && (!Number.isInteger(args.offset) || (args.offset as number) < 0)) return invalidArguments();
          const { artifact, parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, args.artifactRef, input.signal);
          const part = parsed.parts.find((part) => part.id === args.partId);
          const offset = args.offset as number ?? 0;
          if (!part || offset > part.notes.length) return invalidArguments();
          return { content: JSON.stringify({ artifactRef: artifact.id, label: artifact.label,
            part: midiArtifactPartSummaries(parsed).find((part) => part.id === args.partId),
            offset, notes: part.notes.slice(offset, offset + 256),
            ...(offset + 256 < part.notes.length ? { nextOffset: offset + 256 } : {}), timing: parsed.timing }),
          progressKey: JSON.stringify([artifact.id, artifact.sha256, part.id, offset]) };
        }
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
          return invalidArguments();
        }
        const listing = await inspectMidiArtifacts(input.storageDirectory, input.sessionId);
        let unavailableCount = listing.unavailableCount;
        const current = [];
        for (const artifact of listing.artifacts) {
          try {
            const { parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.id, input.signal);
            current.push({ ...midiArtifactView(artifact), parts: midiArtifactPartSummaries(parsed), timing: parsed.timing });
          } catch { throwIfAborted(input.signal); unavailableCount += 1; }
        }
        return {
          content: JSON.stringify(unavailableCount
            ? { artifacts: current, unavailableCount,
                warning: "One or more saved MIDI artifacts are unavailable. Their metadata was preserved." }
            : current),
          progressKey: JSON.stringify([
            listing.artifacts.map((artifact) => [artifact.id, artifact.sha256]),
            unavailableCount,
          ]),
        };
      } catch {
        throwIfAborted(input.signal);
        return invalidArguments();
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

function invalidArguments() {
  return { content: "Invalid MIDI artifact arguments.", failed: true, invalidArguments: true };
}
