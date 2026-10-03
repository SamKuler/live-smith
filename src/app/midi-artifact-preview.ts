import { MidiTrack, type ExtensionContext } from "@ableton-extensions/sdk";
import { MAX_AGENT_PLAN_ACTIONS } from "../agent/actions.js";
import type { LiveInteractionContext } from "../live/context.js";
import { readMidiArtifact, midiArtifactPartSummaries, type MidiArtifactPartSummary, type ParsedMidiArtifact } from "../storage/midi-artifacts.js";
import { listSessions } from "../storage/sessions.js";

export interface MidiImportTarget { trackId: string; trackName: string }
export type MidiImportDestination =
  | (MidiImportTarget & { createTrack?: never })
  | { createTrack: true; trackName: string; trackId?: never };
export type MidiImportMapping = MidiImportDestination & { partId: string };
export interface MidiArtifactImportPreview {
  sessionId: string;
  artifactRef: string;
  label: string;
  parts: MidiArtifactPartSummary[];
  durationBeats: number;
  timing: ParsedMidiArtifact["timing"];
  targets: MidiImportTarget[];
  unavailableTargetCount: number;
  maxActions: number;
  suggestedTrackId?: string;
  suggestedStartBeat?: number;
}

/** Names must also be unique because the canonical action selector uses names. */
export function observeMidiImportTargets(context: ExtensionContext<"1.0.0">): {
  targets: MidiImportTarget[]; unavailableTargetCount: number;
} {
  const tracks = context.application.song.tracks;
  const midiTracks = tracks.filter((track) => track instanceof MidiTrack);
  const targets = midiTracks.filter((track) => tracks.filter((candidate) =>
    candidate.name.trim().toLowerCase() === track.name.trim().toLowerCase()).length === 1)
    .map((track) => ({ trackId: String(track.handle.id), trackName: track.name }));
  return { targets, unavailableTargetCount: midiTracks.length - targets.length };
}

export function assertMidiImportTargets(context: ExtensionContext<"1.0.0">, expected: readonly MidiImportTarget[]): void {
  const { targets } = observeMidiImportTargets(context);
  if (expected.some((target) => !targets.some((current) => current.trackId === target.trackId && current.trackName === target.trackName))) {
    throw new Error("A MIDI destination changed or is ambiguous. Refresh the import preview and choose its destination again.");
  }
}

export async function prepareMidiArtifactImport(input: {
  context: ExtensionContext<"1.0.0">;
  interaction?: LiveInteractionContext;
  storageDirectory: string | undefined;
  projectKey: string;
  sessionId: string;
  artifactRef: string;
  signal: AbortSignal;
}): Promise<MidiArtifactImportPreview> {
  const session = (await listSessions(input.storageDirectory, input.projectKey)).find((entry) =>
    entry.id === input.sessionId && !entry.archivedAt);
  if (!session) throw new Error("That Session is not available in this Live Set.");
  const { artifact, parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, input.artifactRef, input.signal);
  const observed = observeMidiImportTargets(input.context);
  const boundTrack = input.interaction?.target.track;
  const suggestedTrackId = boundTrack instanceof MidiTrack
    ? observed.targets.find((target) => target.trackId === String(boundTrack.handle.id))?.trackId
    : undefined;
  const range = input.interaction?.presentation.range;
  const suggestedStartBeat = range?.coordinate === "arrangement-beats" && Number.isFinite(range.start) && range.start >= 0
    ? range.start : undefined;
  return { sessionId: input.sessionId, artifactRef: artifact.id, label: artifact.label,
    parts: midiArtifactPartSummaries(parsed), durationBeats: parsed.durationBeats, timing: parsed.timing,
    ...observed, maxActions: MAX_AGENT_PLAN_ACTIONS,
    ...(suggestedTrackId === undefined ? {} : { suggestedTrackId }),
    ...(suggestedStartBeat === undefined ? {} : { suggestedStartBeat }) };
}
