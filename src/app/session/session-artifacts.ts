import { MAX_MIDI_ARTIFACT_OVERVIEW_NOTES, artifactKey, artifactVersion, pendingArtifactParentFromEvents, primaryArtifactsFromEvents, type ArtifactRef, type ArtifactSelection, type ArtifactVersion, type ArtifactVersionSummary } from "../../agent/artifact-contracts.js";
import { audioOutputDescriptor } from "../../audio-services/audio-output.js";
import type { MidiPreviewNote } from "../../agent/action-preview.js";
import { readAudioSessionState } from "../../storage/audio-assets.js";
import { listPluginAudioArtifacts, readSessionAudioArtifact } from "../../storage/audio-artifacts.js";
import { appendSessionEvent, loadSessionEvents, type SessionEvent } from "../../storage/events.js";
import { MAX_MIDI_ARTIFACT_NOTES, inspectMidiArtifacts, readMidiArtifact, midiArtifactPartSummaries, midiArtifactVersion, type MidiArtifactPartSummary } from "../../storage/midi-artifacts.js";
import { listSessions } from "../../storage/sessions.js";
import { throwIfAborted } from "../../runtime/host.js";
import { normalizeSearchQuery, searchTextMatches } from "./search-contracts.js";
import { uiCatalogs } from "../../ui/i18n/messages.js";

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
  version?: ArtifactVersion & { groupLabel: string };
  versions?: ArtifactVersionSummary[];
  primary?: ArtifactRef;
  audio?: { durationSeconds: number; mediaType: "audio/wav" | "audio/mpeg"; jobId?: string };
  midi?: { durationBeats: number; noteCount: number; parts: MidiArtifactPartSummary[];
    notes: (MidiPreviewNote & { partId: string })[]; omittedNoteCount: number };
}
export interface SessionArtifactDetail { sessionId: string; artifact: SessionArtifact }
export interface SessionArtifacts {
  sessionId: string;
  query?: string;
  artifacts: SessionArtifact[];
  total: number;
  offset: number;
  unavailableCount: number;
  continuation?: ArtifactRef;
}
export interface MidiPartPreview {
  sessionId: string;
  artifactRef: string;
  partId: string;
  notes: (MidiPreviewNote & { partId: string })[];
  omittedNoteCount: number;
}
type SessionInput = { storageDirectory: string | undefined; sessionId: string; projectKey?: string; signal: AbortSignal };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Correlation comes from owned output IDs and the original persisted call, never current settings. */
export function artifactGenerationsFromEvents(events: readonly SessionEvent[]): Map<string, { generation: ArtifactGeneration; parent?: ArtifactRef; startedAt: string; endedAt: string }> {
  type PendingCall = { event: SessionEvent; ambiguous: boolean };
  const calls = new Map<string, PendingCall[]>();
  const enclosingCallIds = new Set(events.flatMap((event) => event.kind === "tool_call" && event.requestEventId ? [event.requestEventId] : []));
  const retainCalls = (keep: (entry: PendingCall) => boolean) => {
    for (const [name, entries] of calls) {
      const active = entries.filter(keep);
      if (active.length) calls.set(name, active);
      else calls.delete(name);
    }
  };
  const generations = new Map<string, { generation: ArtifactGeneration; parent?: ArtifactRef; startedAt: string; endedAt: string }>();
  for (const event of events) {
    // Initial requests are serialized; steering keeps the current request open.
    if (event.kind === "user" && !event.steeringReceipt) calls.clear();
    // Errors end leaf calls; enclosing workflows still own their terminal result.
    if (event.kind === "error") retainCalls((entry) => entry.ambiguous || enclosingCallIds.has(entry.event.id));
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
    // An enclosing result closes unfinished child calls even on failure or Stop.
    retainCalls((entry) => entry.event.requestEventId !== call.id);
    let result: unknown;
    try { result = JSON.parse(event.content); } catch { continue; }
    if (!record(result) || result.isError === true || result.status === "failed") continue;
    const meta = record(result._meta) ? result._meta["io.github.samkuler/live-smith-artifacts"] : undefined;
    const entries = record(meta) && meta.version === 1 ? meta.artifacts : result.artifacts;
    const refs = Array.isArray(entries) ? entries.flatMap((entry) => record(entry) && (entry.kind === "midi" || entry.kind === "audio") && typeof entry.artifactRef === "string"
      ? [`${entry.kind}:${entry.artifactRef}`] : []) : [];
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
    const read = await readSessionAudioArtifact(input.storageDirectory, input.sessionId, input.artifact.id, input.signal);
    if ("role" in read.asset && read.asset.role === "source") throw new Error("Choose a saved audio result.");
  }
}

export async function readSessionMidiPartPreview(input: SessionInput & { artifactRef: string; partId: string }): Promise<MidiPartPreview> {
  await requireSession(input);
  const { parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, input.artifactRef, input.signal);
  const part = parsed.parts.find((entry) => entry.id === input.partId);
  if (!part) throw new Error("Choose a source part from this Session MIDI artifact.");
  throwIfAborted(input.signal);
  return { sessionId: input.sessionId, artifactRef: input.artifactRef, partId: part.id,
    notes: part.notes.map((note) => ({ ...note, partId: part.id })),
    omittedNoteCount: 0 };
}

export async function selectSessionArtifact(input: SessionInput & { selection: ArtifactSelection }): Promise<void> {
  const selection = input.selection;
  if (selection.action === "prefer") throw new Error("Choose a source or primary version.");
  await requireSession(input);
  if (selection.candidate) await assertSessionArtifact({ ...input, artifact: selection.candidate });
  if (selection.action === "primary") {
    const catalog = await readSessionArtifactCatalog(input);
    const members = catalog.artifacts.filter((artifact) => artifactGroupKey(artifact) === artifactKey(selection.group));
    if (!members.length || selection.candidate && !members.some((artifact) => artifactKey(artifact.ref) === artifactKey(selection.candidate!))) {
      throw new Error("Choose a version from this Session work.");
    }
  }
  await appendSessionEvent(input.storageDirectory, input.sessionId, { kind: "candidate",
    content: selection.action === "primary"
      ? selection.candidate ? "Primary version selected." : "Primary version cleared."
      : selection.candidate ? "Source selected for the next request." : "Next-request source cleared.",
    candidateSelection: selection });
}

function artifactGroupKey(artifact: SessionArtifact): string {
  return artifactKey({ kind: artifact.ref.kind, id: artifact.version?.groupId ?? artifact.ref.id });
}

export async function readSessionArtifactCatalog(input: SessionInput & { includeHostMidi?: boolean }): Promise<{
  artifacts: SessionArtifact[]; unavailableCount: number; continuation?: ArtifactRef;
}> {
  await requireSession(input);
  const [listing, audio, pluginAudio, events] = await Promise.all([
    inspectMidiArtifacts(input.storageDirectory, input.sessionId), input.storageDirectory
      ? readAudioSessionState(input.storageDirectory, input.sessionId) : Promise.resolve({ jobs: [], assets: [] }),
    listPluginAudioArtifacts(input.storageDirectory, input.sessionId),
    loadSessionEvents(input.storageDirectory, input.sessionId),
  ]);
  const { jobs, assets } = audio;
  const generations = artifactGenerationsFromEvents(events);
  const generationAt = (key: string, createdAt: string) => {
    const source = generations.get(key);
    if (!source || createdAt < source.startedAt || createdAt > source.endedAt) return {};
    return { generation: source.generation, ...(source.parent ? { parent: source.parent } : {}) };
  };
  const continuation = pendingArtifactParentFromEvents(events);
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const summaries: SessionArtifact[] = [
    ...listing.artifacts.filter((artifact) => input.includeHostMidi || artifact.source?.kind !== "host").map((artifact): SessionArtifact => ({ ref: { kind: "midi", id: artifact.id }, label: artifact.label,
      createdAt: artifact.createdAt, sourceLabel: artifact.source?.kind === "model" ? "AI-generated MIDI" : artifact.source?.kind === "host" ? "Live MIDI source" : "Plugin-generated MIDI",
      ...generationAt(`midi:${artifact.id}`, artifact.createdAt),
      version: { ...midiArtifactVersion(artifact), groupLabel: listing.artifacts.find((entry) => entry.id === midiArtifactVersion(artifact).groupId)?.label ?? artifact.label } })),
    ...assets.filter((asset) => asset.role !== "source" && jobMap.get(asset.jobId)?.outputAssets.some((output) => output.id === asset.id)).map((asset): SessionArtifact => {
      const job = jobMap.get(asset.jobId)!;
      return { ref: { kind: "audio", id: asset.id }, label: `${job.title || asset.label} · ${audioOutputDescriptor(asset.role)!.label}`, createdAt: job.createdAt,
        sourceLabel: [job.provider, job.modelId, job.operation].filter(Boolean).join(" · "),
        ...generationAt(`job:${job.id}`, job.createdAt),
        ...(job.artifactSource ? { parent: { ...job.artifactSource } } : {}),
        version: { ...artifactVersion(asset), groupLabel: job.title || asset.label },
        audio: { durationSeconds: asset.durationSeconds, mediaType: asset.mediaType, jobId: job.id } };
    }),
    ...pluginAudio.map((artifact): SessionArtifact => ({ ref: { kind: "audio", id: artifact.id }, label: artifact.label,
      createdAt: artifact.createdAt, sourceLabel: "Plugin-generated audio",
      ...generationAt(`audio:${artifact.id}`, artifact.createdAt),
      ...(artifact.sourceArtifact ? { parent: artifact.sourceArtifact } : {}),
      version: { ...artifact.version, groupLabel: artifact.label },
      audio: { durationSeconds: artifact.durationSeconds, mediaType: artifact.mediaType } })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || artifactKey(a.ref).localeCompare(artifactKey(b.ref)));
  const artifacts = summaries;
  const groups = new Map<string, SessionArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifactGroupKey(artifact);
    const group = groups.get(key) ?? [];
    group.push(artifact); groups.set(key, group);
  }
  const selectedPrimaries = primaryArtifactsFromEvents(events);
  for (const [key, group] of groups) {
    const versioned = group.filter((artifact) => artifact.version);
    const versions = versioned.map((artifact): ArtifactVersionSummary => ({ id: artifact.ref.id,
      label: artifact.label, number: artifact.version!.number, createdAt: artifact.createdAt,
      ...(artifact.version!.derivedFromId ? { derivedFromId: artifact.version!.derivedFromId } : {}) }))
      .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    const groupLabel = versions[0]?.label;
    for (const artifact of versioned) {
      artifact.versions = versions;
      artifact.version!.groupLabel = groupLabel!;
    }
    const primary = selectedPrimaries.get(key);
    if (!primary || !group.some((artifact) => artifactKey(artifact.ref) === artifactKey(primary))) continue;
    if (primary.kind === "midi") {
      try { await assertSessionArtifact({ ...input, artifact: primary }); }
      catch { throwIfAborted(input.signal); continue; }
    }
    for (const artifact of group) artifact.primary = { ...primary };
  }
  await requireSession(input);
  return { artifacts, unavailableCount: listing.unavailableCount, ...(continuation ? { continuation } : {}) };
}

async function hydrateMidiArtifact(input: SessionInput, artifact: SessionArtifact, maximumNotes = MAX_MIDI_ARTIFACT_OVERVIEW_NOTES): Promise<SessionArtifact> {
  const { parsed } = await readMidiArtifact(input.storageDirectory, input.sessionId, artifact.ref.id, input.signal);
  return { ...artifact, midi: { durationBeats: parsed.durationBeats, noteCount: parsed.notes.length,
    parts: midiArtifactPartSummaries(parsed), notes: parsed.parts.flatMap((part) => part.notes.map((note) => ({ ...note, partId: part.id })))
      .sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch || a.partId.localeCompare(b.partId)).slice(0, maximumNotes),
    omittedNoteCount: Math.max(0, parsed.notes.length - maximumNotes) } };
}

export function groupSessionArtifacts(artifacts: readonly SessionArtifact[]): SessionArtifact[][] {
  const groups = new Map<string, SessionArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifactGroupKey(artifact);
    const group = groups.get(key) ?? [];
    group.push(artifact); groups.set(key, group);
  }
  return [...groups.values()].map((group) => group.sort((a, b) => (b.version?.number ?? 0) - (a.version?.number ?? 0)))
    .sort((a, b) => b[0]!.createdAt.localeCompare(a[0]!.createdAt) || artifactKey(a[0]!.ref).localeCompare(artifactKey(b[0]!.ref)));
}

/** Groups are ordered newest first; an available explicit primary overrides that default. */
export function defaultSessionArtifact(group: readonly SessionArtifact[]): SessionArtifact | undefined {
  const primary = group[0]?.primary;
  return primary ? group.find((artifact) => artifactKey(artifact.ref) === artifactKey(primary)) ?? group[0] : group[0];
}

export async function listSessionArtifacts(input: SessionInput & { offset?: number; query?: string }): Promise<SessionArtifacts> {
  const catalog = await readSessionArtifactCatalog(input);
  const query = normalizeSearchQuery(input.query ?? "");
  const summaries = groupSessionArtifacts(catalog.artifacts).map((group) => {
    if (!query) return group;
    const matches = group.filter((artifact) => [artifact.label, artifact.sourceLabel, artifact.version ? `v${artifact.version.number}` : "",
      ...Object.values(uiCatalogs).map((catalog) => catalog[artifact.sourceLabel] ?? "")]
      .some((text) => searchTextMatches(text, query)));
    return matches.length ? matches : group.some((artifact) => searchTextMatches(artifact.version?.groupLabel ?? "", query)) ? group : [];
  }).filter((group) => group.length > 0);
  const offset = input.offset ?? 0;
  const artifacts: SessionArtifact[] = [];
  let unavailableCount = catalog.unavailableCount;
  for (const group of summaries.slice(offset, offset + ARTIFACT_PAGE_SIZE)) {
    const selected = defaultSessionArtifact(group)!;
    const ordered = [selected, ...group.filter((artifact) => artifact !== selected)];
    for (const artifact of ordered) {
      throwIfAborted(input.signal);
      if (artifact.ref.kind === "audio") { artifacts.push(artifact); break; }
      try { artifacts.push(await hydrateMidiArtifact(input, artifact)); break; }
      catch { throwIfAborted(input.signal); unavailableCount += 1; }
    }
  }
  await requireSession(input);
  return { sessionId: input.sessionId, artifacts, total: summaries.length, offset, unavailableCount,
    ...(query ? { query } : {}),
    ...(catalog.continuation ? { continuation: catalog.continuation } : {}) };
}

export async function readSessionArtifact(input: SessionInput & { artifact: ArtifactRef }): Promise<SessionArtifactDetail> {
  const catalog = await readSessionArtifactCatalog(input);
  let artifact = catalog.artifacts.find((entry) => artifactKey(entry.ref) === artifactKey(input.artifact));
  if (!artifact) throw new Error("That saved artifact is not available in this Session.");
  if (artifact.ref.kind === "midi") artifact = await hydrateMidiArtifact(input, artifact, MAX_MIDI_ARTIFACT_NOTES);
  await requireSession(input);
  return { sessionId: input.sessionId, artifact };
}
