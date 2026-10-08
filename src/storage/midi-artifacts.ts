import { allocateArtifactVersion, artifactVersion, isArtifactLabel, isArtifactVersion, type ArtifactPluginSource, type ArtifactVersion } from "../agent/artifact-contracts.js";
import { isMidiContinuationBuffer, type MidiContinuationBuffer } from "../agent/midi-continuation-contracts.js";
import type { NoteDescription } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";
import { TextDecoder } from "node:util";

import { AttachmentProcessingError } from "../attachments/contracts.js";
import { parseStandardMidi } from "../attachments/midi.js";
import { isSafePluginId } from "../plugins/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  removeDirectoryDurably,
  removeFileDurably,
  withStorageTransaction,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomicallyCreateOnly,
  writeJsonAtomically,
} from "./persistence.js";
import { listSessions, persistTransientSessionInTransaction } from "./sessions.js";

export const MAX_MIDI_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_MIDI_ARTIFACTS_PER_SESSION = 64;
export const MAX_MIDI_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_MIDI_ARTIFACT_NOTES = 4096;
export const MAX_MIDI_ARTIFACT_TRACKS = 32;
const MAX_MIDI_DURATION_BEATS = 100_000;
const MAX_MIDI_METADATA_BYTES = 4 * 1024;
const supportsPosixPermissions = platform !== "win32";
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
  | { kind: "model"; profileId: string; model: string }
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
    generationKind?: "continuation";
    beforeCommit?(): void;
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
  if (input.generationKind !== undefined && input.generationKind !== "continuation" || !validArtifactSource(input) || !ownerIdPattern.test(input.serverId) ||
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
    ...(input.generationKind ? { generationKind: input.generationKind } : {}),
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
    await assertDirectory(directory!);
    throwIfAborted(input.signal);
    await writeBytesAtomicallyCreateOnly(blobPath(directory!, artifact.id), bytes);
    await assertDirectory(directory!);
    try {
      throwIfAborted(input.signal);
      input.beforeCommit?.();
    } catch (error) {
      // Metadata has not been attempted, so this newly written blob has no published owner.
      await assertDirectory(directory!).then(() => removeFileDurably(blobPath(directory!, artifact.id))).catch(() => {});
      throw error;
    }
    await writeJsonAtomicallyCreateOnly(metadataPath(directory!, artifact.id), artifact);
    await assertDirectory(directory!);
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
  return entries.artifacts.length > 0 || entries.unavailableCount > 0 ||
    (await readMidiContinuation(storageDirectory, sessionId)) !== undefined;
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
  const bytes = await readPrivateFile(blobPath(directory, artifactId), artifact.byteLength, signal);
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

export async function deleteSessionMidiArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) return;
  await withStorageTransaction(storageDirectory, async () => {
    const directory = await bindSessionDirectory(storageDirectory, sessionId);
    if (!directory) return;
    await assertDirectory(directory);
    await removeDirectoryDurably(directory.path);
  });
}

export async function listSessionMidiArtifactDirectoryIds(
  storageDirectory: string | undefined,
): Promise<string[]> {
  if (!storageDirectory) return [];
  const root = artifactRoot(storageDirectory);
  let before;
  try { before = await fs.lstat(root); }
  catch (error) { if (isMissingFileError(error)) return []; throw new MidiArtifactStorageError(); }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new MidiArtifactStorageError();
  const ids: string[] = [];
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeStorageId(entry.name)) {
      throw new MidiArtifactStorageError();
    }
    ids.push(entry.name);
  }
  const after = await fs.lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new MidiArtifactStorageError();
  }
  return ids.sort();
}

interface DirectoryBinding { path: string; dev: bigint | number; ino: bigint | number }

async function bindSessionDirectory(
  storageDirectory: string,
  sessionId: string,
  create = false,
): Promise<DirectoryBinding | undefined> {
  const root = artifactRoot(storageDirectory);
  const target = path.join(root, sessionId);
  if (create) {
    await ensureDirectory(root);
    await ensureDirectory(target);
  }
  let info;
  try { info = await fs.lstat(target, { bigint: true }); }
  catch (error) { if (isMissingFileError(error)) return undefined; throw new MidiArtifactStorageError(); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MidiArtifactStorageError();
  return { path: target, dev: info.dev, ino: info.ino };
}

async function ensureDirectory(target: string): Promise<void> {
  let created = false;
  try { await fs.mkdir(target, { mode: 0o700 }); created = true; }
  catch (error) {
    if (!isAlreadyExistsError(error)) throw new MidiArtifactStorageError();
  }
  const before = await fs.lstat(target);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      (supportsPosixPermissions && getuid && before.uid !== getuid())) {
    throw new MidiArtifactStorageError();
  }
  if (supportsPosixPermissions) await fs.chmod(target, 0o700);
  const after = await fs.lstat(target);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new MidiArtifactStorageError();
  }
  if (created && supportsPosixPermissions) {
    const parent = await fs.open(path.dirname(target), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

async function assertDirectory(binding: DirectoryBinding): Promise<void> {
  const info = await fs.lstat(binding.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== binding.dev || info.ino !== binding.ino) {
    throw new MidiArtifactStorageError();
  }
}

async function readArtifacts(directory: DirectoryBinding): Promise<MidiArtifactListing & { records: MidiArtifact[] }> {
  const entries = await fs.readdir(directory.path);
  const metadataIds = entries.filter((name) => name.endsWith(".midi.json")).map((name) => name.slice(0, -10));
  const artifacts: MidiArtifact[] = [];
  const records: MidiArtifact[] = [];
  let unavailableCount = 0;
  for (const id of metadataIds) {
    if (!isSafeStorageId(id)) throw new MidiArtifactStorageError();
    const artifact = await readMetadata(directory, id);
    if (!artifact) throw new MidiArtifactStorageError();
    records.push(artifact);
    let blob;
    try { blob = await fs.lstat(blobPath(directory, id)); }
    catch (error) {
      if (!isMissingFileError(error)) throw error;
      unavailableCount += 1;
      continue;
    }
    if (!blob.isFile() || blob.isSymbolicLink() || blob.nlink !== 1 || blob.size !== artifact.byteLength) {
      throw new MidiArtifactStorageError();
    }
    artifacts.push(artifact);
  }
  for (const name of entries) {
    if (name.endsWith(".mid") && !metadataIds.includes(name.slice(0, -4))) {
      const id = name.slice(0, -4);
      if (!isSafeStorageId(id)) throw new MidiArtifactStorageError();
      const info = await fs.lstat(blobPath(directory, id));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 ||
          info.size > MAX_MIDI_ARTIFACT_BYTES || (supportsPosixPermissions && getuid && info.uid !== getuid())) {
        throw new MidiArtifactStorageError();
      }
      continue;
    }
    if (name === "continuation.json" || /^\.continuation\.json\.tmp_[A-Za-z0-9_-]+$/u.test(name)) {
      const info = await fs.lstat(path.join(directory.path, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > MAX_MIDI_CONTINUATION_BYTES) throw new MidiArtifactStorageError();
      continue;
    }
    if (!name.endsWith(".mid") && !name.endsWith(".midi.json") && !validAtomicTemporary(name)) {
      throw new MidiArtifactStorageError();
    }
    if (validAtomicTemporary(name)) {
      const info = await fs.lstat(path.join(directory.path, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 0 ||
          info.size > (name.includes(".midi.json.") ? MAX_MIDI_METADATA_BYTES : MAX_MIDI_ARTIFACT_BYTES)) {
        throw new MidiArtifactStorageError();
      }
    }
  }
  await assertDirectory(directory);
  return { artifacts: artifacts.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)), unavailableCount, records };
}

async function storedMidiBytes(directory: DirectoryBinding): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(directory.path)) {
    if (!name.endsWith(".mid") && !(validAtomicTemporary(name) && name.includes(".mid."))) continue;
    const info = await fs.lstat(path.join(directory.path, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 0 ||
        info.size > MAX_MIDI_ARTIFACT_BYTES) throw new MidiArtifactStorageError();
    total += info.size;
  }
  await assertDirectory(directory);
  return total;
}

async function readMetadata(directory: DirectoryBinding, id: string): Promise<MidiArtifact | undefined> {
  let bytes: Uint8Array;
  try { bytes = await readPrivateFile(metadataPath(directory, id), MAX_MIDI_METADATA_BYTES); }
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
      : source.kind === "model" && Object.keys(source).length === 3 && isSafeStorageId(source.profileId) &&
        typeof source.model === "string" && source.model.trim().length > 0 &&
        !/[\u0000-\u001f\u007f]/u.test(source.model) && Buffer.byteLength(source.model, "utf8") <= 1024;
  }
  return value.pluginId === undefined
    ? isSafeStorageId(value.connectionId)
    : isSafePluginId(value.pluginId) && value.connectionId === undefined;
}

async function readPrivateFile(target: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes ||
      (supportsPosixPermissions && getuid && before.uid !== getuid())) throw new MidiArtifactStorageError();
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new MidiArtifactStorageError();
    }
    const bytes = new Uint8Array(await handle.readFile());
    throwIfAborted(signal);
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.byteLength !== opened.size) {
      throw new MidiArtifactStorageError();
    }
    return bytes;
  } finally { await handle.close(); }
}

async function requireSession(storageDirectory: string, sessionId: string): Promise<void> {
  if (!(await listSessions(storageDirectory)).some((session) => session.id === sessionId)) {
    throw new MidiArtifactStorageError("The owning Session does not exist.");
  }
}

function artifactRoot(storageDirectory: string): string { return path.join(storageDirectory, "live-smith-midi"); }
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
function isAlreadyExistsError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}
function invalidMidi(): MidiArtifactStorageError {
  return new MidiArtifactStorageError("MIDI artifact is not a supported bounded Standard MIDI File.");
}


const MAX_MIDI_CONTINUATION_BYTES = 64 * 1024;

export async function readMidiContinuation(storageDirectory: string | undefined, sessionId: string, signal?: AbortSignal): Promise<MidiContinuationBuffer | undefined> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) return undefined;
  const directory = await bindSessionDirectory(storageDirectory, sessionId);
  if (!directory) return undefined;
  let bytes;
  try { bytes = await readPrivateFile(path.join(directory.path, "continuation.json"), MAX_MIDI_CONTINUATION_BYTES, signal); }
  catch (error) { if (isMissingFileError(error)) return undefined; throw error; }
  await assertDirectory(directory);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new MidiArtifactStorageError("Saved MIDI continuation data is invalid."); }
  if (!isMidiContinuationBuffer(value) || value.sessionId !== sessionId) throw new MidiArtifactStorageError("Saved MIDI continuation data is invalid.");
  return value;
}

/** Caller holds the owning Session mutation fence across read/modify/save. */
export async function saveMidiContinuation(storageDirectory: string | undefined, sessionId: string, input: MidiContinuationBuffer, signal: AbortSignal): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory || !isMidiContinuationBuffer(input) || input.sessionId !== sessionId ||
      Buffer.byteLength(JSON.stringify(input, null, 2), "utf8") > MAX_MIDI_CONTINUATION_BYTES) throw new MidiArtifactStorageError("MIDI continuation settings exceed the supported limits.");
  const value = JSON.parse(JSON.stringify(input)) as MidiContinuationBuffer;
  await withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(signal);
    await requireSession(storageDirectory, sessionId);
    await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
    const directory = await bindSessionDirectory(storageDirectory, sessionId, true);
    await assertDirectory(directory!);
    await writeJsonAtomically(path.join(directory!.path, "continuation.json"), value);
    await assertDirectory(directory!);
  });
}
