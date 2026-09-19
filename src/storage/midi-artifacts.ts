import type { NoteDescription } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";
import { TextDecoder } from "node:util";

import { isSafePluginId } from "../plugins/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  removeDirectoryDurably,
  withStorageTransaction,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomicallyCreateOnly,
} from "./persistence.js";
import { listSessions } from "./sessions.js";

export const MAX_MIDI_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_MIDI_ARTIFACTS_PER_SESSION = 64;
export const MAX_MIDI_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_MIDI_NOTES = 4096;
const MAX_MIDI_EVENTS = 200_000;
const MAX_MIDI_TRACKS = 32;
const MAX_MIDI_DURATION_BEATS = 100_000;
const MAX_MIDI_METADATA_BYTES = 4 * 1024;
const supportsPosixPermissions = platform !== "win32";
const metadataKeys = new Set([
  "id", "sessionId", "pluginId", "serverId", "toolName", "label", "byteLength",
  "sha256", "format", "trackCount", "ticksPerQuarterNote", "noteCount",
  "durationBeats", "createdAt",
]);
const hashPattern = /^[a-f0-9]{64}$/u;
const ownerIdPattern = /^[^\u0000-\u001f\u007f]{1,128}$/u;

export interface MidiArtifact {
  id: string;
  sessionId: string;
  pluginId: string;
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
}

export interface ParsedMidiArtifact {
  format: 0 | 1;
  trackCount: number;
  ticksPerQuarterNote: number;
  durationBeats: number;
  notes: NoteDescription[];
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
  throwIfAborted(signal);
  const cursor = new MidiCursor(bytes);
  if (cursor.ascii(4) !== "MThd" || cursor.uint32() !== 6) throw invalidMidi();
  const format = cursor.uint16();
  const trackCount = cursor.uint16();
  const division = cursor.uint16();
  if ((format !== 0 && format !== 1) || trackCount < 1 || trackCount > MAX_MIDI_TRACKS ||
      format === 0 && trackCount !== 1 || division === 0 || (division & 0x8000) !== 0) {
    throw invalidMidi();
  }
  const ticksPerQuarterNote = division;
  const tickNotes: TickNote[] = [];
  let maximumTick = 0;
  let eventCount = 0;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (cursor.ascii(4) !== "MTrk") throw invalidMidi();
    const trackBytes = cursor.slice(cursor.uint32());
    const parsed = parseTrack(trackBytes, trackIndex, signal, eventCount);
    eventCount = parsed.eventCount;
    maximumTick = Math.max(maximumTick, parsed.maximumTick);
    tickNotes.push(...parsed.notes);
    if (tickNotes.length > MAX_MIDI_NOTES) throw invalidMidi();
  }
  if (!cursor.done() || tickNotes.length < 1) throw invalidMidi();
  tickNotes.sort((left, right) => left.startTick - right.startTick || left.pitch - right.pitch ||
    left.trackIndex - right.trackIndex || left.velocity - right.velocity);
  const durationBeats = maximumTick / ticksPerQuarterNote;
  if (!Number.isFinite(durationBeats) || durationBeats <= 0 || durationBeats > MAX_MIDI_DURATION_BEATS) {
    throw invalidMidi();
  }
  return {
    format,
    trackCount,
    ticksPerQuarterNote,
    durationBeats,
    notes: tickNotes.map((note) => ({
      pitch: note.pitch,
      startTime: note.startTick / ticksPerQuarterNote,
      duration: note.durationTicks / ticksPerQuarterNote,
      velocity: note.velocity,
    })),
  };
}

export async function saveMidiArtifact(
  storageDirectory: string | undefined,
  sessionId: string,
  input: {
    pluginId: string;
    serverId: string;
    toolName: string;
    label: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  },
): Promise<MidiArtifact> {
  if (!storageDirectory || !path.isAbsolute(storageDirectory)) throw new MidiArtifactStorageError();
  requireSafeStorageId(sessionId, "Session ID");
  if (!isSafePluginId(input.pluginId) || !ownerIdPattern.test(input.serverId) ||
      !ownerIdPattern.test(input.toolName) || !safeLabel(input.label) ||
      !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_MIDI_ARTIFACT_BYTES) {
    throw new MidiArtifactStorageError();
  }
  throwIfAborted(input.signal);
  const bytes = new Uint8Array(input.bytes);
  const parsed = parseMidiArtifact(bytes, input.signal);
  const artifact: MidiArtifact = {
    id: createStorageId("midi"),
    sessionId,
    pluginId: input.pluginId,
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
  return withStorageTransaction(storageDirectory, async () => {
    throwIfAborted(input.signal);
    await requireSession(storageDirectory, sessionId);
    const directory = await bindSessionDirectory(storageDirectory, sessionId, true);
    const entries = await readArtifacts(directory!);
    if (entries.length >= MAX_MIDI_ARTIFACTS_PER_SESSION ||
        await storedMidiBytes(directory!) + bytes.byteLength > MAX_MIDI_SESSION_BYTES) {
      throw new MidiArtifactStorageError("This Session has reached its MIDI artifact storage limit.");
    }
    await assertDirectory(directory!);
    await writeJsonAtomicallyCreateOnly(metadataPath(directory!, artifact.id), artifact);
    await assertDirectory(directory!);
    await writeBytesAtomicallyCreateOnly(blobPath(directory!, artifact.id), bytes);
    await assertDirectory(directory!);
    return cloneArtifact(artifact);
  });
}

export async function listMidiArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<MidiArtifact[]> {
  if (!storageDirectory) return [];
  requireSafeStorageId(sessionId, "Session ID");
  await requireSession(storageDirectory, sessionId);
  const directory = await bindSessionDirectory(storageDirectory, sessionId);
  return directory ? readArtifacts(directory) : [];
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

function parseTrack(
  bytes: Uint8Array,
  trackIndex: number,
  signal: AbortSignal | undefined,
  initialEventCount: number,
): { notes: TickNote[]; maximumTick: number; eventCount: number } {
  const cursor = new MidiCursor(bytes);
  const active = new Map<string, Array<{ tick: number; velocity: number }>>();
  const notes: TickNote[] = [];
  let tick = 0;
  let runningStatus: number | undefined;
  let eventCount = initialEventCount;
  let ended = false;
  while (!cursor.done()) {
    if (++eventCount > MAX_MIDI_EVENTS) throw invalidMidi();
    if ((eventCount & 1023) === 0) throwIfAborted(signal);
    tick += cursor.variableLength();
    if (!Number.isSafeInteger(tick)) throw invalidMidi();
    const first = cursor.peek();
    let status: number;
    let firstData: number | undefined;
    if (first < 0x80) {
      if (runningStatus === undefined) throw invalidMidi();
      status = runningStatus;
      firstData = cursor.uint8();
    } else {
      status = cursor.uint8();
      if (status >= 0x80 && status <= 0xef) runningStatus = status;
    }
    if (status >= 0x80 && status <= 0xef) {
      const type = status & 0xf0;
      const channel = status & 0x0f;
      const firstByte = firstData ?? cursor.dataByte();
      const secondByte = type === 0xc0 || type === 0xd0 ? undefined : cursor.dataByte();
      if (type === 0x80 || type === 0x90) {
        const key = `${channel}:${firstByte}`;
        if (type === 0x90 && secondByte! > 0) {
          const stack = active.get(key) ?? [];
          stack.push({ tick, velocity: secondByte! });
          active.set(key, stack);
          if ([...active.values()].reduce((sum, entries) => sum + entries.length, 0) > MAX_MIDI_NOTES) {
            throw invalidMidi();
          }
        } else {
          const stack = active.get(key);
          const started = stack?.shift();
          if (started && tick > started.tick) {
            notes.push({
              pitch: firstByte,
              startTick: started.tick,
              durationTicks: tick - started.tick,
              velocity: started.velocity,
              trackIndex,
            });
          } else if (started) {
            throw invalidMidi();
          }
          if (stack?.length === 0) active.delete(key);
          if (notes.length > MAX_MIDI_NOTES) throw invalidMidi();
        }
      }
      continue;
    }
    if (status === 0xff) {
      const type = cursor.uint8();
      const length = cursor.variableLength();
      if (type === 0x2f) {
        if (length !== 0 || !cursor.done()) throw invalidMidi();
        ended = true;
        break;
      }
      cursor.skip(length);
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      cursor.skip(cursor.variableLength());
      continue;
    }
    throw invalidMidi();
  }
  if (!ended || active.size > 0) throw invalidMidi();
  return {
    notes,
    maximumTick: tick,
    eventCount,
  };
}

class MidiCursor {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  done(): boolean { return this.offset === this.bytes.byteLength; }
  peek(): number { this.require(1); return this.bytes[this.offset]!; }
  uint8(): number { this.require(1); return this.bytes[this.offset++]!; }
  dataByte(): number { const value = this.uint8(); if (value >= 0x80) throw invalidMidi(); return value; }
  uint16(): number { this.require(2); const value = this.bytes[this.offset]! * 0x100 + this.bytes[this.offset + 1]!; this.offset += 2; return value; }
  uint32(): number {
    this.require(4);
    const value = this.bytes[this.offset]! * 0x1000000 + this.bytes[this.offset + 1]! * 0x10000 +
      this.bytes[this.offset + 2]! * 0x100 + this.bytes[this.offset + 3]!;
    this.offset += 4;
    return value;
  }
  ascii(length: number): string {
    const bytes = this.slice(length);
    return String.fromCharCode(...bytes);
  }
  slice(length: number): Uint8Array { this.require(length); const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  skip(length: number): void { this.require(length); this.offset += length; }
  variableLength(): number {
    let value = 0;
    for (let index = 0; index < 4; index++) {
      const byte = this.uint8();
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw invalidMidi();
  }
  private require(length: number): void {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) throw invalidMidi();
  }
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

async function readArtifacts(directory: DirectoryBinding): Promise<MidiArtifact[]> {
  const entries = await fs.readdir(directory.path);
  const metadataIds = entries.filter((name) => name.endsWith(".midi.json")).map((name) => name.slice(0, -10));
  const artifacts: MidiArtifact[] = [];
  for (const id of metadataIds) {
    if (!isSafeStorageId(id)) throw new MidiArtifactStorageError();
    const artifact = await readMetadata(directory, id);
    if (!artifact) throw new MidiArtifactStorageError();
    const blob = await fs.lstat(blobPath(directory, id));
    if (!blob.isFile() || blob.isSymbolicLink() || blob.nlink !== 1 || blob.size !== artifact.byteLength) {
      throw new MidiArtifactStorageError();
    }
    artifacts.push(artifact);
  }
  for (const name of entries) {
    if (name.endsWith(".mid") && !metadataIds.includes(name.slice(0, -4)) ||
        !name.endsWith(".mid") && !name.endsWith(".midi.json") && !validAtomicTemporary(name)) {
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
  return artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
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
      !isSafeStorageId(value.id) || !isSafeStorageId(value.sessionId) || !isSafePluginId(value.pluginId) ||
      typeof value.serverId !== "string" || !ownerIdPattern.test(value.serverId) ||
      typeof value.toolName !== "string" || !ownerIdPattern.test(value.toolName) ||
      !safeLabel(value.label) || !Number.isInteger(value.byteLength) || (value.byteLength as number) < 22 ||
      (value.byteLength as number) > MAX_MIDI_ARTIFACT_BYTES || typeof value.sha256 !== "string" ||
      !hashPattern.test(value.sha256) || (value.format !== 0 && value.format !== 1) ||
      !Number.isInteger(value.trackCount) || (value.trackCount as number) < 1 || (value.trackCount as number) > MAX_MIDI_TRACKS ||
      !Number.isInteger(value.ticksPerQuarterNote) || (value.ticksPerQuarterNote as number) < 1 ||
      (value.ticksPerQuarterNote as number) > 0x7fff || !Number.isInteger(value.noteCount) ||
      (value.noteCount as number) < 1 || (value.noteCount as number) > MAX_MIDI_NOTES ||
      typeof value.durationBeats !== "number" || !Number.isFinite(value.durationBeats) || value.durationBeats <= 0 ||
      value.durationBeats > MAX_MIDI_DURATION_BEATS || typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))) throw new MidiArtifactStorageError();
  return cloneArtifact(value as unknown as MidiArtifact);
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
function safeLabel(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function cloneArtifact(artifact: MidiArtifact): MidiArtifact { return { ...artifact }; }
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

interface TickNote {
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
  trackIndex: number;
}
