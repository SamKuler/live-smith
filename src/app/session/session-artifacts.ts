import { artifactKey, pendingArtifactParentFromEvents, preferredArtifactFromEvents, type ArtifactRef, type ArtifactSelection } from "../../agent/artifact-contracts.js";
import { MAX_MIDI_PREVIEW_NOTES, type MidiPreviewNote } from "../../agent/action-preview.js";
import { readAudioSessionState, readAudioAsset } from "../../storage/audio-assets.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../storage/events.js";
import { inspectMidiArtifacts, readMidiArtifact, midiArtifactPartSummaries, midiArtifactVersion, type MidiArtifactVersion, type MidiArtifactPartSummary } from "../../storage/midi-artifacts.js";
import { listSessions } from "../../storage/sessions.js";
import { throwIfAborted } from "../../runtime/host.js";

export const ARTIFACT_PAGE_SIZE = 24;
export interface ArtifactGeneration {
  toolName: string;
  callEventId: string;
  resultEventId: string;
  requestEventId?: string;
  parameters: string;
  parametersTruncated: boolean;
}
export interface SessionArtifact {
  ref: ArtifactRef;
  label: string;
  createdAt: string;
  sourceLabel: string;
  generation?: ArtifactGeneration;
  parent?: ArtifactRef;
  preferred: boolean;
  version?: MidiArtifactVersion & { groupLabel: string };
  audio?: { durationSeconds: number; mediaType: "audio/wav" | "audio/mpeg"; jobId: string };
  midi?: { durationBeats: number; noteCount: number; parts: MidiArtifactPartSummary[];
    notes: MidiPreviewNote[]; omittedNoteCount: number };
}
export interface SessionArtifacts {
  sessionId: string;
  artifacts: SessionArtifact[];
  total: number;
  offset: number;
  unavailableCount: number;
  preferred?: ArtifactRef;
  continuation?: ArtifactRef;
}
type SessionInput = { storageDirectory: string | undefined; sessionId: string; projectKey?: string; signal: AbortSignal };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Correlation comes from owned output IDs and the original persisted call, never current settings. */
export function artifactGenerationsFromEvents(events: readonly SessionEvent[]): Map<string, { generation: ArtifactGeneration; parent?: ArtifactRef; startedAt: string; endedAt: string }> {
  const calls = new Map<string, { event: SessionEvent; ambiguous: boolean }[]>();
  const generations = new Map<string, { generation: ArtifactGeneration; parent?: ArtifactRef; startedAt: string; endedAt: string }>();
  for (const event of events) {
    if (event.kind === "tool_call" && event.name) {
      const pending = calls.get(event.name) ?? [];
      for (const entry of pending) entry.ambiguous = true;
      pending.push({ event, ambiguous: pending.length > 0 }); calls.set(event.name, pending);
    }
    if (event.kind !== "tool_result" || !event.name) continue;
    const pending = calls.get(event.name);
    const paired = pending?.shift();
    if (!pending?.length) calls.delete(event.name);
    if (!paired || paired.ambiguous) continue;
    const call = paired.event;
    let result: unknown;
    try { result = JSON.parse(event.content); } catch { continue; }
    if (!record(result) || result.isError === true || result.status === "failed") continue;
    const meta = record(result._meta) ? result._meta["io.github.samkuler/live-smith-artifacts"] : undefined;
    const entries = record(meta) && meta.version === 1 ? meta.artifacts : result.artifacts;
    const refs = Array.isArray(entries) ? entries.flatMap((entry) => record(entry) && entry.kind === "midi" && typeof entry.artifactRef === "string"
      ? [`midi:${entry.artifactRef}`] : []) : [];
    if (typeof result.id === "string" && typeof result.createdAt === "string" && call.createdAt <= result.createdAt) refs.push(`job:${result.id}`);
    for (const ref of refs) {
      if (generations.has(ref)) continue;
      generations.set(ref, { startedAt: call.createdAt, endedAt: event.createdAt,
        generation: { toolName: call.name!, callEventId: call.id, resultEventId: event.id,
        ...(call.requestEventId ? { requestEventId: call.requestEventId } : {}),
        parameters: call.content.slice(0, 4000), parametersTruncated: call.content.length > 4000 },
      ...(call.parentCandidate ? { parent: { ...call.parentCandidate } } : {}) });
    }
  }
  return generations;
}

async function requireSession(input: SessionInput): Promise<void> {
  const session = (await listSessions(input.storageDirectory, input.projectKey)).find((entry) => entry.id === input.sessionId && !entry.archivedAt);
  if (!session) throw new Error("That Session is not available in this Live Set.");
  throwIfAborted(input.signal);
}

export async function assertSessionArtifact(input: SessionInput & { artifact: ArtifactRef }): Promise<void> {
  await requireSession(input);
  if (input.artifact.kind === "midi") await readMidiArtifact(input.storageDirectory, input.sessionId, input.artifact.id, input.signal);
  else {
    const read = await readAudioAsset(input.storageDirectory, input.sessionId, input.artifact.id, input.signal);
    if (read.asset.role === "source") throw new Error("Choose a saved audio result.");
  }
}

export async function selectSessionArtifact(input: SessionInput & { selection: ArtifactSelection }): Promise<void> {
  await requireSession(input);
  if (input.selection.candidate) await assertSessionArtifact({ ...input, artifact: input.selection.candidate });
  const ref = input.selection.candidate;
  await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "candidate",
    content: input.selection.action === "prefer" ? ref ? "Preferred artifact selected." : "Preferred artifact cleared."
      : ref ? "Source selected for the next request." : "Next-request source cleared.",
    candidateSelection: input.selection });
}

export async function listSessionArtifacts(input: SessionInput & { offset?: number }): Promise<SessionArtifacts> {
  await requireSession(input);
  const [listing, audio, events] = await Promise.all([
    inspectMidiArtifacts(input.storageDirectory, input.sessionId), input.storageDirectory
      ? readAudioSessionState(input.storageDirectory, input.sessionId) : Promise.resolve({ jobs: [], assets: [] }),
    loadSessionEvents(input.storageDirectory, input.sessionId),
  ]);
  const { jobs, assets } = audio;
  const generations = artifactGenerationsFromEvents(events);
  const generationAt = (key: string, createdAt: string) => {
    const source = generations.get(key);
    if (!source || createdAt < source.startedAt || createdAt > source.endedAt) return {};
    return { generation: source.generation, ...(source.parent ? { parent: source.parent } : {}) };
  };
  const preferred = preferredArtifactFromEvents(events);
  const continuation = pendingArtifactParentFromEvents(events);
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const summaries: SessionArtifact[] = [
    ...listing.artifacts.filter((artifact) => artifact.source?.kind !== "host").map((artifact): SessionArtifact => ({ ref: { kind: "midi", id: artifact.id }, label: artifact.label,
      createdAt: artifact.createdAt, sourceLabel: artifact.toolName, preferred: preferred?.kind === "midi" && preferred.id === artifact.id,
      ...generationAt(`midi:${artifact.id}`, artifact.createdAt),
      version: { ...midiArtifactVersion(artifact), groupLabel: listing.artifacts.find((entry) => entry.id === midiArtifactVersion(artifact).groupId)?.label ?? artifact.label } })),
    ...assets.filter((asset) => asset.role !== "source").map((asset): SessionArtifact => {
      const job = jobMap.get(asset.jobId)!;
      return { ref: { kind: "audio", id: asset.id }, label: `${job.title || asset.label} · ${asset.role}`, createdAt: job.createdAt,
        sourceLabel: [job.provider, job.modelId, job.operation].filter(Boolean).join(" · "),
        preferred: preferred?.kind === "audio" && preferred.id === asset.id, ...generationAt(`job:${job.id}`, job.createdAt),
        audio: { durationSeconds: asset.durationSeconds, mediaType: asset.mediaType, jobId: job.id } };
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || artifactKey(a.ref).localeCompare(artifactKey(b.ref)));
  const offset = input.offset ?? 0;
  const artifacts: SessionArtifact[] = [];
  let unavailableCount = listing.unavailableCount;
  for (const artifact of summaries.slice(offset, offset + ARTIFACT_PAGE_SIZE)) {
    throwIfAborted(input.signal);
    if (artifact.ref.kind === "midi") {
      try {
        const { parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.ref.id, input.signal);
        artifact.midi = { durationBeats: parsed.durationBeats, noteCount: parsed.notes.length,
          parts: midiArtifactPartSummaries(parsed), notes: parsed.notes.slice(0, MAX_MIDI_PREVIEW_NOTES),
          omittedNoteCount: Math.max(0, parsed.notes.length - MAX_MIDI_PREVIEW_NOTES) };
      } catch { throwIfAborted(input.signal); unavailableCount += 1; continue; }
    }
    artifacts.push(artifact);
  }
  return { sessionId: input.sessionId, artifacts, total: summaries.length, offset, unavailableCount,
    ...(preferred ? { preferred } : {}), ...(continuation ? { continuation } : {}) };
}
