import { artifactKey } from "../../agent/artifact-contracts.js";
import type { ModelTool } from "../../model/provider.js";
import type { Toolset } from "../../plugins/registry.js";
import { createHostAbortController, throwIfAborted } from "../../runtime/host.js";
import { isSafeStorageId } from "../../storage/id.js";
import { readMidiArtifact, midiArtifactPartSummaries } from "../../storage/midi-artifacts.js";
import { midiArtifactView } from "../midi/midi-artifact-tools.js";
import { defaultSessionArtifact, groupSessionArtifacts, readSessionArtifactCatalog, type SessionArtifact } from "./session-artifacts.js";

export const sessionArtifactTools = [{
  type: "function",
  function: {
    name: "list_session_artifacts",
    description: "List saved MIDI and audio artifacts owned by this Session, including Plugin outputs whose tool result was not confirmed. Audio entries contain metadata and exact artifactRef values for audio tools; complete audio bytes are checked when consumed. If saved MIDI data is unavailable, the result includes an unavailableCount and warning; do not use those missing artifacts. Use an exact listed MIDI artifactRef with create_midi_clip_from_artifact when that action is available. This verifies saved MIDI bytes and returns read-derived source part summaries and timing event counts; it does not run a Plugin or change Live. Each work marks its primary version when selected, otherwise its newest readable version, with defaultForWork; explicit artifactRef requests always keep that exact version. For multitrack MIDI, select a listed partId per destination or explicitly request mergeParts.",
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
}] satisfies ModelTool[];

export function createSessionArtifactToolset(
  input: { storageDirectory: string | undefined; sessionId: string; signal?: AbortSignal },
): Toolset {
  return {
    id: "live-smith.artifacts",
    tools: () => sessionArtifactTools,
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
        const catalog = await readSessionArtifactCatalog({ ...input,
          signal: input.signal ?? createHostAbortController().signal, includeHostMidi: true });
        let unavailableCount = catalog.unavailableCount;
        const current: { artifact: SessionArtifact; view: Record<string, unknown>; revision: string }[] = [];
        for (const artifact of catalog.artifacts) {
          throwIfAborted(input.signal);
          if (artifact.ref.kind === "audio") {
            const { groupLabel: _groupLabel, ...version } = artifact.version!;
            current.push({ artifact, revision: artifact.ref.id, view: {
              kind: "audio", artifactRef: artifact.ref.id, label: artifact.label, createdAt: artifact.createdAt,
              mediaType: artifact.audio!.mediaType, durationSeconds: artifact.audio!.durationSeconds, version,
            } });
            continue;
          }
          try {
            const { artifact: saved, parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.ref.id, input.signal);
            current.push({ artifact, revision: saved.sha256,
              view: { ...midiArtifactView(saved), parts: midiArtifactPartSummaries(parsed), timing: parsed.timing } });
          } catch { throwIfAborted(input.signal); unavailableCount += 1; }
        }
        const groups = groupSessionArtifacts(current.map((entry) => entry.artifact));
        const views = new Map(current.map((entry) => [artifactKey(entry.artifact.ref), entry.view]));
        const artifacts = groups.flatMap((group) => {
          const selected = defaultSessionArtifact(group)!;
          const primary = selected.primary && artifactKey(selected.primary) === artifactKey(selected.ref) ? selected.primary : undefined;
          return group.map((artifact) => ({ ...views.get(artifactKey(artifact.ref))!,
            defaultForWork: artifactKey(selected.ref) === artifactKey(artifact.ref), ...(primary ? { primary } : {}) }));
        });
        return {
          content: JSON.stringify(unavailableCount
            ? { artifacts, unavailableCount, warning: "One or more saved artifacts are unavailable. Their metadata was preserved." }
            : artifacts),
          progressKey: JSON.stringify([current.map((entry) => [artifactKey(entry.artifact.ref), entry.revision]), artifacts, unavailableCount]),
        };
      } catch {
        throwIfAborted(input.signal);
        return invalidArguments();
      }
    },
  };
}

function invalidArguments() {
  return { content: "Invalid Session artifact arguments.", failed: true, invalidArguments: true };
}
