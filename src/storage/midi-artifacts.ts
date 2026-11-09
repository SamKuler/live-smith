import { isMcpToolActor, type ToolActor } from "../agent/tool-actor.js";
import { openVerifiedStoredStream, type SessionFileExport } from "./file-export.js";
import { allocateArtifactVersion, artifactVersion, isArtifactLabel, isArtifactVersion, type ArtifactPluginSource, type ArtifactVersion } from "../agent/artifact-contracts.js";
import type { NoteDescription } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import { TextDecoder } from "node:util";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import { parseStandardMidi } from "../attachments/midi.js";
import { isSafePluginId } from "../plugins/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import { withStorageTransaction } from "./persistence.js";
import { listStoredChildren, readStoredBytes, storedEntry, storedTreeExists, removeStoredEntry, removeStoredTree, writeStoredBytes, writeStoredJson } from "./sqlite.js";
import { listSessions, persistTransientSessionInTransaction } from "./sessions.js";

export const MAX_MIDI_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_MIDI_ARTIFACTS_PER_SESSION = 64;
export const MAX_MIDI_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_MIDI_ARTIFACT_NOTES = 4096;
export const MAX_MIDI_ARTIFACT_TRACKS = 32;
const MAX_MIDI_DURATION_BEATS = 100_000;
const MAX_MIDI_METADATA_BYTES = 4 * 1024;
const MAX_LEGACY_CONTINUATION_BYTES = 64 * 1024;
const metadataKeys = new Set([
  "id", "sessionId", "pluginId", "connectionId", "source", "generationKind", "serverId", "toolName", "label", "byteLength",
  "sha256", "format", "trackCount", "ticksPerQuarterNote", "noteCount",
  "durationBeats", "createdAt", "version",
]);
const hashPattern = /^[a-f0-9]{64}$/u;
const ownerIdPattern = /^[^\u0000-\u001f\u007f]{1,128}$/u;

export type MidiArtifactPluginSource = ArtifactPluginSource;

export type MidiArtifactVersion = ArtifactVersion;

export function midiArtifactVersion(artifact: MidiArtifact): MidiArtifactVersion {
  return artifactVersion(artifact);
}

export type MidiArtifactHostSource =
  | ToolActor
  | { kind: "host"; operation: "live-midi-context" | "midi-conditioning-context" };

export type MidiArtifactSource =
  | (MidiArtifactPluginSource & { source?: never })
  | { source: MidiArtifactHostSource; pluginId?: never; connectionId?: never };

export type MidiArtifact = MidiArtifactSource & {
  generationKind?: "continuation";
  id: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  label: string;
  byteLength: number;
  sha256: string;
  format: 0 | 1;
  trackCount: number;
  ticksPerQuarterNote: number;
  noteCount: number;
  durationBeats: number;
  createdAt: string;
  version?: MidiArtifactVersion;
};

export interface ParsedMidiArtifact {
  format: 0 | 1;
  trackCount: number;
  ticksPerQuarterNote: number;
  durationBeats: number;
  notes: NoteDescription[];
  parts: MidiArtifactPart[];
  timing: { tempoEventCount: number; timeSignatureEventCount: number };
}

/** A note-bearing SMF track/channel pair. Identity is independent of names. */
export interface MidiArtifactPart {
  id: string;
  sourceTrackIndex: number;
  sourceTrackName?: string;
  channel: number;
  durationBeats: number;
  notes: NoteDescription[];
}

export type MidiArtifactPartSummary = Omit<MidiArtifactPart, "notes"> & { noteCount: number };

export function midiArtifactPartSummaries(parsed: ParsedMidiArtifact): MidiArtifactPartSummary[] {
  return parsed.parts.map(({ notes, ...part }) => ({ ...part,
    ...(part.sourceTrackName ? { sourceTrackName: part.sourceTrackName.slice(0, 120) } : {}), noteCount: notes.length }));
}

export interface MidiArtifactListing {
  artifacts: MidiArtifact[];
  unavailableCount: number;
}

export class MidiArtifactStorageError extends Error {
  constructor(message = "Saved MIDI artifact data is invalid, unavailable, or changed.") {
    super(message);
    this.name = "MidiArtifactStorageError";
  }
}

export function parseMidiArtifact(bytes: Uint8Array, signal?: AbortSignal): ParsedMidiArtifact {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > MAX_MIDI_ARTIFACT_BYTES) {
    throw new MidiArtifactStorageError("MIDI artifacts must be valid Standard MIDI Files of at most 8 MiB.");
  }
  let midi;
  try {
    midi = parseStandardMidi(bytes, { purpose: "artifact", ...(signal ? { signal } : {}) });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AttachmentProcessingError) throw invalidMidi();
    throw error;
  }
  const tickNotes = midi.tracks.flatMap((track) => track.notes.map((note) => ({ ...note, trackIndex: track.index })));
  if (tickNotes.length < 1 || tickNotes.some((note) => note.durationTicks === null || note.durationTicks <= 0)) {
    throw invalidMidi();
  }
  tickNotes.sort((left, right) => left.startTick - right.startTick || left.pitch - right.pitch ||
    left.trackIndex - right.trackIndex || left.velocity - right.velocity);
  const { durationBeats, ticksPerQuarterNote, trackCount } = midi;
  if (!Number.isFinite(durationBeats) || durationBeats <= 0 || durationBeats > MAX_MIDI_DURATION_BEATS) {
    throw invalidMidi();
  }
  return {
    format: midi.format as 0 | 1,
    trackCount,
    ticksPerQuarterNote,
    durationBeats,
    parts: midi.tracks.flatMap((track) => [...new Set(track.notes.map((note) => note.channel))]
      .sort((a, b) => a - b).map((channel) => ({
        id: `track-${track.index}-channel-${channel}`,
        sourceTrackIndex: track.index,
        ...(track.name ? { sourceTrackName: track.name } : {}),
        channel,
        durationBeats: track.durationBeats,
        notes: tickNotes.filter((note) => note.trackIndex === track.index && note.channel === channel)
          .map((note) => ({ pitch: note.pitch, startTime: note.startTick / ticksPerQuarterNote,
            duration: note.durationTicks! / ticksPerQuarterNote, velocity: note.velocity })),
      }))),
    timing: {
      tempoEventCount: midi.tracks.reduce((sum, track) => sum + track.events.filter((event) => event.type === "tempo").length, 0),
      timeSignatureEventCount: midi.tracks.reduce((sum, track) => sum + track.events.filter((event) => event.type === "time_signature").length, 0),
    },
    notes: tickNotes.map((note) => ({
      pitch: note.pitch,
      startTime: note.startTick / ticksPerQuarterNote,
      duration: note.durationTicks! / ticksPerQuarterNote,
      velocity: note.velocity,
    })),
  };
}

export async function saveMidiArtifact(
  storageDirectory: string | undefined,
  sessionId: string,
  input: MidiArtifactSource & {
    serverId: string;
    toolName: string;
    label: string;
    bytes: Uint8Array;
    signal: AbortSignal;
    revisionOf?: string;
    groupWith?: string;
  },
): Promise<MidiArtifact> {
  if (!storageDirectory || !path.isAbsolute(storageDirectory)) throw new MidiArtifactStorageError();
  requireSafeStorageId(sessionId, "Session ID");
  if (!validArtifactSource(input) || !ownerIdPattern.test(input.serverId) ||
      !ownerIdPattern.test(input.toolName) || !isArtifactLabel(input.label) ||
      !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_MIDI_ARTIFACT_BYTES) {
    throw new MidiArtifactStorageError();
  }
  if ([input.revisionOf, input.groupWith].some((id) => id !== undefined && !isSafeStorageId(id))) throw new MidiArtifactStorageError("Choose an existing MIDI version in this Session.");
  throwIfAborted(input.signal);
  const bytes = new Uint8Array(input.bytes);
  const parsed = parseMidiArtifact(bytes, input.signal);
  const artifact: MidiArtifact = {
    id: createStorageId("midi"),
    sessionId,
    ...(input.source ? { source: { ...input.source } } : input.pluginId === undefined ? { connectionId: input.connectionId } : { pluginId: input.pluginId }),
    serverId: input.serverId,
    toolName: input.toolName,
    label: input.label,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: parsed.format,
    trackCount: parsed.trackCount,
    ticksPerQuarterNote: parsed.ticksPerQuarterNote,
    noteCount: parsed.notes.length,
    durationBeats: parsed.durationBeats,
    createdAt: new Date().toISOString(),
  };
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(input.signal);
    await requireSession(storageDirectory, sessionId);
    await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
    const directory = await bindSessionDirectory(storageDirectory, sessionId, true);
    const entries = await readArtifacts(directory!);
    for (const ref of [input.revisionOf, input.groupWith]) {
      if (ref && !entries.artifacts.some((entry) => entry.id === ref)) {
        throw new MidiArtifactStorageError("The source MIDI version is unavailable in this Session.");
      }
    }
    try { artifact.version = allocateArtifactVersion(artifact.id, entries.records, input); }
    catch (error) { throw new MidiArtifactStorageError(error instanceof Error ? error.message : undefined); }
    if (entries.artifacts.length + entries.unavailableCount >= MAX_MIDI_ARTIFACTS_PER_SESSION ||
        await storedMidiBytes(directory!) + bytes.byteLength > MAX_MIDI_SESSION_BYTES) {
      throw new MidiArtifactStorageError("This Session has reached its MIDI artifact storage limit.");
    }
    throwIfAborted(input.signal);
    await writeStoredBytes(storageDirectory, blobPath(directory!, artifact.id), bytes, { createOnly: true, storage: "file" });
    try {
      throwIfAborted(input.signal);
    } catch (error) {
      // Metadata has not been attempted, so this newly written blob has no published owner.
      await removeStoredEntry(storageDirectory, blobPath(directory!, artifact.id)).catch(() => {});
      throw error;
    }
    await writeStoredJson(storageDirectory, metadataPath(directory!, artifact.id), artifact, { createOnly: true });
    return cloneArtifact(artifact);
  });
}

export async function listMidiArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<MidiArtifact[]> {
  return (await inspectMidiArtifacts(storageDirectory, sessionId)).artifacts;
}

export async function inspectMidiArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<MidiArtifactListing> {
  if (!storageDirectory) return { artifacts: [], unavailableCount: 0 };
  requireSafeStorageId(sessionId, "Session ID");
  return withStorageTransaction(storageDirectory, async () => {
    await requireSession(storageDirectory, sessionId);
    const directory = await bindSessionDirectory(storageDirectory, sessionId);
    if (!directory) return { artifacts: [], unavailableCount: 0 };
    const { artifacts, unavailableCount } = await readArtifacts(directory);
    return { artifacts, unavailableCount };
  });
}

/** Read-only content check usable within a caller's storage snapshot transaction. */
export async function hasSessionMidiContent(storageDirectory: string | undefined, sessionId: string): Promise<boolean> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) return false;
  const directory = await bindSessionDirectory(storageDirectory, sessionId);
  if (!directory) return false;
  const entries = await readArtifacts(directory);
  return entries.artifacts.length > 0 || entries.unavailableCount > 0 || entries.hasLegacyContinuation;
}

export async function readMidiArtifact(
  storageDirectory: string | undefined,
  sessionId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<{ artifact: MidiArtifact; bytes: Uint8Array; parsed: ParsedMidiArtifact }> {
  if (!storageDirectory) throw new MidiArtifactStorageError();
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(artifactId, "MIDI artifact ID");
  throwIfAborted(signal);
  await requireSession(storageDirectory, sessionId);
  const directory = await bindSessionDirectory(storageDirectory, sessionId);
  if (!directory) throw new MidiArtifactStorageError("The MIDI artifact does not exist in this Session.");
  const artifact = await readMetadata(directory, artifactId);
  if (!artifact || artifact.sessionId !== sessionId) throw new MidiArtifactStorageError();
  const bytes = await readPrivateFile(directory.storageDirectory, blobPath(directory, artifactId), artifact.byteLength, signal);
  if (bytes.byteLength !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new MidiArtifactStorageError();
  }
  const parsed = parseMidiArtifact(bytes, signal);
  if (parsed.format !== artifact.format || parsed.trackCount !== artifact.trackCount ||
      parsed.ticksPerQuarterNote !== artifact.ticksPerQuarterNote || parsed.notes.length !== artifact.noteCount ||
      parsed.durationBeats !== artifact.durationBeats) throw new MidiArtifactStorageError();
  if (JSON.stringify(await readMetadata(directory, artifactId)) !== JSON.stringify(artifact)) {
    throw new MidiArtifactStorageError();
  }
  return { artifact: cloneArtifact(artifact), bytes, parsed };
}

export function midiArtifactFileName(artifact: MidiArtifact): string {
  const label = Buffer.from(artifact.label, "utf8").toString("utf8").normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").replace(/\s+/gu, " ").trim();
  const name = [...label].slice(0, 30).join("") || "MIDI";
  return `${name}-v${midiArtifactVersion(artifact).number}-${artifact.id.slice(-8)}.mid`;
}


export async function midiArtifactExport(storageDirectory: string, sessionId: string, artifactId: string): Promise<SessionFileExport> {
  requireSafeStorageId(sessionId, "Session ID"); requireSafeStorageId(artifactId, "MIDI artifact ID");
  await requireSession(storageDirectory, sessionId);
  const directory = await bindSessionDirectory(storageDirectory, sessionId);
  if (!directory) throw new MidiArtifactStorageError();
  const artifact = await readMetadata(directory, artifactId);
  if (!artifact || artifact.sessionId !== sessionId) throw new MidiArtifactStorageError();
  return { fileName: midiArtifactFileName(artifact), mediaType: "audio/midi", byteLength: artifact.byteLength,
    open: (signal, range) => openVerifiedStoredStream({ storageDirectory, ...(range ? { range } : {}), key: blobPath(directory, artifactId), byteLength: artifact.byteLength, sha256: artifact.sha256, signal,
      assertCurrent: async () => { if (JSON.stringify(await readMetadata(directory, artifactId)) !== JSON.stringify(artifact)) throw new MidiArtifactStorageError(); } }),
  };
}

export async function deleteSessionMidiArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) return;
  await withStorageTransaction(storageDirectory, async () => {
    const directory = await bindSessionDirectory(storageDirectory, sessionId);
    if (!directory) return;
    await removeStoredTree(storageDirectory, directory.path);
  });
}

export async function listSessionMidiArtifactDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (!storageDirectory) return [];
  const ids = await listStoredChildren(storageDirectory, artifactRoot(storageDirectory));
  if (ids.some(id => !isSafeStorageId(id))) throw new MidiArtifactStorageError();
  return ids;
}

interface DirectoryBinding { storageDirectory: string; path: string }

async function bindSessionDirectory(
  storageDirectory: string, sessionId: string, create = false,
): Promise<DirectoryBinding | undefined> {
  const target = path.join(artifactRoot(storageDirectory), sessionId);
  if (!create && !await storedTreeExists(storageDirectory, target)) return undefined;
  return { storageDirectory, path: target };
}

async function readArtifacts(directory: DirectoryBinding): Promise<MidiArtifactListing & {
  records: MidiArtifact[];
  hasLegacyContinuation: boolean;
}> {
  const entries = await listStoredChildren(directory.storageDirectory, directory.path);
  const metadataIds = entries.filter((name) => name.endsWith(".midi.json")).map((name) => name.slice(0, -10));
  const artifacts: MidiArtifact[] = [];
  const records: MidiArtifact[] = [];
  let unavailableCount = 0;
  let hasLegacyContinuation = false;
  for (const id of metadataIds) {
    if (!isSafeStorageId(id)) throw new MidiArtifactStorageError();
    const artifact = await readMetadata(directory, id);
    if (!artifact) throw new MidiArtifactStorageError();
    records.push(artifact);
    const blob = await storedEntry(directory.storageDirectory, blobPath(directory, id));
    if (!blob) { unavailableCount += 1; continue; }
    if (blob.byteLength !== artifact.byteLength) throw new MidiArtifactStorageError();
    artifacts.push(artifact);
  }
  for (const name of entries) {
    if (name.endsWith(".mid") && !metadataIds.includes(name.slice(0, -4))) {
      const id = name.slice(0, -4);
      if (!isSafeStorageId(id)) throw new MidiArtifactStorageError();
      const info = await storedEntry(directory.storageDirectory, blobPath(directory, id));
      if (!info || info.byteLength < 1 ||
          info.byteLength > MAX_MIDI_ARTIFACT_BYTES) {
        throw new MidiArtifactStorageError();
      }
      continue;
    }
    if (name === "continuation.json" || /^\.continuation\.json\.tmp_[A-Za-z0-9_-]+$/u.test(name)) {
      const info = await storedEntry(directory.storageDirectory, path.join(directory.path, name));
      if (!info || info.byteLength < 1 ||
          info.byteLength > MAX_LEGACY_CONTINUATION_BYTES) {
        throw new MidiArtifactStorageError();
      }
      // A committed legacy file still makes this Session nonempty.
      if (name === "continuation.json") hasLegacyContinuation = true;
      continue;
    }
    if (!name.endsWith(".mid") && !name.endsWith(".midi.json") && !validAtomicTemporary(name)) {
      throw new MidiArtifactStorageError();
    }
    if (validAtomicTemporary(name)) {
      const info = await storedEntry(directory.storageDirectory, path.join(directory.path, name));
      if (!info || info.byteLength < 0 ||
          info.byteLength > (name.includes(".midi.json.") ? MAX_MIDI_METADATA_BYTES : MAX_MIDI_ARTIFACT_BYTES)) {
        throw new MidiArtifactStorageError();
      }
    }
  }
  return { artifacts: artifacts.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    unavailableCount, records, hasLegacyContinuation };
}

async function storedMidiBytes(directory: DirectoryBinding): Promise<number> {
  let total = 0;
  for (const name of await listStoredChildren(directory.storageDirectory, directory.path)) {
    if (!name.endsWith(".mid") && !(validAtomicTemporary(name) && name.includes(".mid."))) continue;
    const info = await storedEntry(directory.storageDirectory, path.join(directory.path, name));
    if (!info || info.byteLength < 0 ||
        info.byteLength > MAX_MIDI_ARTIFACT_BYTES) throw new MidiArtifactStorageError();
    total += info.byteLength;
  }
  return total;
}

async function readMetadata(directory: DirectoryBinding, id: string): Promise<MidiArtifact | undefined> {
  let bytes: Uint8Array;
  try { bytes = await readPrivateFile(directory.storageDirectory, metadataPath(directory, id), MAX_MIDI_METADATA_BYTES); }
  catch (error) { if (isMissingFileError(error)) return undefined; throw error; }
  try {
    return decodeArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof MidiArtifactStorageError) throw error;
    throw new MidiArtifactStorageError();
  }
}

function decodeArtifact(value: unknown): MidiArtifact {
  if (!plainRecord(value) || Object.keys(value).some((key) => !metadataKeys.has(key)) ||
      !isSafeStorageId(value.id) || !isSafeStorageId(value.sessionId) || !validArtifactSource(value) ||
      value.generationKind !== undefined && value.generationKind !== "continuation" ||
      typeof value.serverId !== "string" || !ownerIdPattern.test(value.serverId) ||
      typeof value.toolName !== "string" || !ownerIdPattern.test(value.toolName) ||
      !isArtifactLabel(value.label) || !Number.isInteger(value.byteLength) || (value.byteLength as number) < 22 ||
      (value.byteLength as number) > MAX_MIDI_ARTIFACT_BYTES || typeof value.sha256 !== "string" ||
      !hashPattern.test(value.sha256) || (value.format !== 0 && value.format !== 1) ||
      !Number.isInteger(value.trackCount) || (value.trackCount as number) < 1 || (value.trackCount as number) > MAX_MIDI_ARTIFACT_TRACKS ||
      !Number.isInteger(value.ticksPerQuarterNote) || (value.ticksPerQuarterNote as number) < 1 ||
      (value.ticksPerQuarterNote as number) > 0x7fff || !Number.isInteger(value.noteCount) ||
      (value.noteCount as number) < 1 || (value.noteCount as number) > MAX_MIDI_ARTIFACT_NOTES ||
      typeof value.durationBeats !== "number" || !Number.isFinite(value.durationBeats) || value.durationBeats <= 0 ||
      value.durationBeats > MAX_MIDI_DURATION_BEATS || typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))) throw new MidiArtifactStorageError();
  if (value.version !== undefined && !isArtifactVersion(value.version, value.id as string)) throw new MidiArtifactStorageError();
  return cloneArtifact(value as unknown as MidiArtifact);
}

function validArtifactSource(value: { pluginId?: unknown; connectionId?: unknown; source?: unknown }): boolean {
  if (value.source !== undefined) {
    if (value.pluginId !== undefined || value.connectionId !== undefined || !plainRecord(value.source)) return false;
    const source = value.source;
    return source.kind === "host"
      ? Object.keys(source).length === 2 && ["live-midi-context", "midi-conditioning-context"].includes(String(source.operation))
      : isMcpToolActor(source) || source.kind === "model" && Object.keys(source).length === 3 && isSafeStorageId(source.profileId) &&
        typeof source.model === "string" && source.model.trim().length > 0 &&
        !/[\u0000-\u001f\u007f]/u.test(source.model) && Buffer.byteLength(source.model, "utf8") <= 1024;
  }
  return value.pluginId === undefined
    ? isSafeStorageId(value.connectionId)
    : isSafePluginId(value.pluginId) && value.connectionId === undefined;
}

async function readPrivateFile(storageDirectory: string, target: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const entry = await storedEntry(storageDirectory, target);
  if (entry && (entry.byteLength < 1 || entry.byteLength > maximumBytes)) throw new MidiArtifactStorageError();
  const bytes = await readStoredBytes(storageDirectory, target);
  throwIfAborted(signal);
  if (!entry || bytes.length !== entry.byteLength || (await storedEntry(storageDirectory, target))?.revision !== entry.revision) throw new MidiArtifactStorageError();
  return new Uint8Array(bytes);
}

async function requireSession(storageDirectory: string, sessionId: string): Promise<void> {
  if (!(await listSessions(storageDirectory)).some((session) => session.id === sessionId)) {
    throw new MidiArtifactStorageError("The owning Session does not exist.");
  }
}

function artifactRoot(storageDirectory: string): string { return path.resolve(storageDirectory, "live-smith-midi"); }
function metadataPath(directory: DirectoryBinding, id: string): string { return path.join(directory.path, `${id}.midi.json`); }
function blobPath(directory: DirectoryBinding, id: string): string { return path.join(directory.path, `${id}.mid`); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function cloneArtifact(artifact: MidiArtifact): MidiArtifact {
  const copy = artifact.source ? { ...artifact, source: { ...artifact.source } } : { ...artifact };
  if (artifact.version) copy.version = { ...artifact.version };
  return copy;
}
function validAtomicTemporary(value: string): boolean {
  const match = /^\.(.+)\.(midi\.json|mid)\.(tmp_.+)$/u.exec(value);
  return Boolean(match && isSafeStorageId(match[1]) && isSafeStorageId(match[3]));
}
function invalidMidi(): MidiArtifactStorageError {
  return new MidiArtifactStorageError("MIDI artifact is not a supported bounded Standard MIDI File.");
}
