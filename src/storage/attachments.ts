import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { platform } from "node:process";

import {
  attachmentQuotaIsWithinLimits,
  AttachmentProcessingError,
  type DocumentAttachmentMediaType,
  isLegacyAttachmentFileName,
  isSafeAttachmentFileName,
  MAX_ATTACHMENT_FILE_NAME_BYTES,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import {
  inspectAudioAttachment,
  isAudioAttachmentCandidate,
  isAudioAttachmentInspection,
  type AudioAttachmentInspection,
} from "../attachments/audio.js";
import { classifyDocumentAttachment } from "../attachments/processor.js";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryDurably,
  isStorageCommitOutcomeUnknownError,
  removeDirectoryDurably,
  removeFileDurably,
  withStorageTransaction,
  writeBytesAtomicallyCreateOnly,
  writeJsonAtomicallyCreateOnly,
} from "./persistence.js";

export type AttachmentKind = "image" | "document" | "audio";

export type AttachmentMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "audio/wav"
  | "audio/mpeg";

export type ImageAttachmentMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface SessionAttachmentRefBase {
  id: string;
  fileName: string;
  byteLength: number;
  sha256: string;
}

export interface ImageSessionAttachmentRef extends SessionAttachmentRefBase {
  kind: "image";
  mediaType: ImageAttachmentMediaType;
}

export interface DocumentSessionAttachmentRef extends SessionAttachmentRefBase {
  kind: "document";
  mediaType: DocumentAttachmentMediaType;
}

export interface AudioSessionAttachmentRef extends SessionAttachmentRefBase,
  AudioAttachmentInspection {
  kind: "audio";
}

/** Read-only shape written into old event logs before audio inspection fields. */
export interface LegacyAudioSessionAttachmentRef extends SessionAttachmentRefBase {
  kind: "audio";
  mediaType: AudioAttachmentInspection["mediaType"];
}

export type SessionAttachmentRef =
  | ImageSessionAttachmentRef
  | DocumentSessionAttachmentRef
  | AudioSessionAttachmentRef;

export type PersistedSessionAttachmentRef =
  | SessionAttachmentRef
  | LegacyAudioSessionAttachmentRef;

export type StoredSessionAttachment = SessionAttachmentRef & {
  sessionId: string;
  createdAt: string;
  /** Missing only on metadata written by Live Smith versions before ordinals. */
  ordinal?: number;
};

interface MemoryAttachment {
  metadata: StoredSessionAttachment;
  bytes: Uint8Array;
}

interface AttachmentDirectoryIdentity {
  dev: number;
  ino: number;
}

interface AttachmentDirectoryBinding {
  root: string;
  rootIdentity: AttachmentDirectoryIdentity;
  directory: string;
  directoryIdentity: AttachmentDirectoryIdentity;
}

export interface AttachmentSaveOptions {
  /** Test seam for proving collision handling; production always uses createStorageId. */
  createId?: () => string;
  /** Test seam for proving stable ordering when wall-clock timestamps collide. */
  now?: () => Date;
  /**
   * Immutable pre-save snapshot captured while holding the same-Session fence.
   * Calling without that fence can race another pending-attachment mutation.
   */
  preSavePendingAttachmentRefs: readonly SessionAttachmentRef[];
}

interface AttachmentReadOptions {
  signal?: AbortSignal;
  /** Exact immutable event/current reference expected for this stored attachment. */
  expectedRef?: SessionAttachmentRef;
  /** Test seam for proving stat rejection happens before blob content is read. */
  readFile?: (handle: fs.FileHandle) => Promise<Uint8Array>;
}

const attachmentsDirectoryName = "live-smith-attachments";
const memoryAttachments = new Map<string, Map<string, MemoryAttachment>>();
const maxImageDimension = 16_384;
const maxImagePixels = 100_000_000;

export class AttachmentTooLargeError extends Error {
  constructor() {
    super(`Image attachments may not exceed ${MAX_IMAGE_ATTACHMENT_BYTES} bytes.`);
    this.name = "AttachmentTooLargeError";
  }
}

export class AttachmentPendingQuotaError extends Error {
  constructor() {
    super(
      "Pending attachments exceed the Session count, total, image, document, or audio limit.",
    );
    this.name = "AttachmentPendingQuotaError";
  }
}

export class UnsupportedAttachmentError extends Error {
  constructor() {
    super(
      "The attachment is not a valid PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, or MP3 file.",
    );
    this.name = "UnsupportedAttachmentError";
  }
}

export class AttachmentNotFoundError extends Error {
  constructor() {
    super("The requested attachment does not exist in this Session.");
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentStorageCorruptionError extends Error {
  constructor(cause?: unknown) {
    super(
      "Saved Live Smith attachment data is invalid. No attachment changes were written; repair or remove the affected attachment data and try again.",
      { cause },
    );
    this.name = "AttachmentStorageCorruptionError";
  }
}

export class AttachmentStorageAccessError extends Error {
  constructor(cause?: unknown) {
    super("Live Smith could not access private attachment storage.", { cause });
    this.name = "AttachmentStorageAccessError";
  }
}

export async function saveSessionAttachment(
  storageDirectory: string | undefined,
  sessionId: string,
  input: {
    fileName: string;
    bytes: Uint8Array;
    claimedMediaType?: string;
    signal?: AbortSignal;
  },
  options: AttachmentSaveOptions,
): Promise<StoredSessionAttachment> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError("Attachment bytes must be binary data.");
  }
  if (input.bytes.byteLength > MAX_DOCUMENT_ATTACHMENT_BYTES) {
    throw new AttachmentProcessingError(
      "archive_limit",
      "Attachment uploads may not exceed 20 MiB.",
    );
  }
  const signal = input.signal;
  const bytes = new Uint8Array(input.bytes);
  const fileNameClaim = String(input.fileName);
  const claimedMediaType = input.claimedMediaType;
  const pendingSnapshot = options.preSavePendingAttachmentRefs.map(
    (attachment) => ({ ...attachment }),
  );
  let storageCommitStarted = false;
  return withAttachmentStorageBoundary(async () => {
    throwIfAborted(signal);
    const classification = await classifyStoredAttachment({
      bytes,
      fileName: fileNameClaim,
      ...(claimedMediaType === undefined ? {} : { claimedMediaType }),
      ...(signal === undefined ? {} : { signal }),
    });
    const sha256 = await hashBytes(bytes, signal);
    throwIfAborted(signal);
    const fileName = sanitizedFileName(fileNameClaim, classification.mediaType);

    return withStorageTransaction(storageDirectory, async () => {
      throwIfAborted(signal);
      storageCommitStarted = true;
      assertPendingAttachmentQuota(pendingSnapshot, {
        kind: classification.kind,
        byteLength: bytes.byteLength,
      });

      if (!storageDirectory) {
        const sessionAttachments = memoryAttachments.get(sessionId) ?? new Map();
        const ordinal = nextAttachmentOrdinal(
          [...sessionAttachments.values()].map((item) => item.metadata),
        );
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const id = nextAttachmentId(options);
          if (sessionAttachments.has(id)) continue;
          const metadata = attachmentMetadata({
            id,
            sessionId,
            fileName,
            ...classification,
            bytes,
            sha256,
            ordinal,
            createdAt: (options.now?.() ?? new Date()).toISOString(),
          });
          sessionAttachments.set(id, { metadata, bytes: new Uint8Array(bytes) });
          memoryAttachments.set(sessionId, sessionAttachments);
          return cloneMetadata(metadata);
        }
        throw new Error("Could not allocate a unique attachment ID.");
      }

      const directory = attachmentSessionDirectory(storageDirectory, sessionId);
      await prepareAttachmentSessionDirectory(storageDirectory, sessionId, true);
      const binding = await captureAttachmentDirectoryBinding(
        storageDirectory,
        sessionId,
      );
      const ordinal = nextAttachmentOrdinal(
        await readAllStoredMetadataBound(binding, sessionId),
      );
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const id = nextAttachmentId(options);
        const metadata = attachmentMetadata({
          id,
          sessionId,
          fileName,
          ...classification,
          bytes,
          sha256,
          ordinal,
          createdAt: (options.now?.() ?? new Date()).toISOString(),
        });
        const blobTarget = attachmentBlobPath(directory, id);
        const metadataTarget = attachmentMetadataPath(directory, id);
        try {
          await writeAttachmentBytesCreateOnlyBound(binding, blobTarget, bytes);
        } catch (error) {
          if (isAlreadyExistsError(error)) continue;
          throw error;
        }
        try {
          await writeAttachmentJsonCreateOnlyBound(
            binding,
            metadataTarget,
            metadata,
          );
        } catch (error) {
          if (!isStorageCommitOutcomeUnknownError(error)) {
            await removeAttachmentFileBound(binding, blobTarget);
          }
          if (isAlreadyExistsError(error)) continue;
          throw error;
        }
        return cloneMetadata(metadata);
      }
      throw new Error("Could not allocate a unique attachment ID.");
    });
  }, signal, () => !storageCommitStarted);
}

export async function listSessionAttachments(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<StoredSessionAttachment[]> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) {
    const items = [...(memoryAttachments.get(sessionId)?.values() ?? [])];
    return sortMetadata(items.map((item) => cloneMetadata(item.metadata)));
  }

  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      return [];
    }
    const binding = await captureAttachmentDirectoryBinding(
      storageDirectory,
      sessionId,
    );
    return sortMetadata(await readAllStoredMetadataBound(binding, sessionId));
  });
}

/**
 * Lists only pending attachments. A consumed ID may be skipped from its safe
 * metadata filename without opening the metadata, so damaged history cannot
 * block new work. Every unconsumed metadata file is still validated strictly.
 */
export async function listPendingSessionAttachments(
  storageDirectory: string | undefined,
  sessionId: string,
  consumedAttachmentIds: readonly string[],
): Promise<StoredSessionAttachment[]> {
  requireSafeStorageId(sessionId, "Session ID");
  const consumedIds = new Set(
    consumedAttachmentIds.map((id) => requireSafeStorageId(id, "Attachment ID")),
  );
  if (!storageDirectory) {
    const items = [...(memoryAttachments.get(sessionId)?.values() ?? [])]
      .filter((item) => !consumedIds.has(item.metadata.id));
    return sortMetadata(items.map((item) => cloneMetadata(item.metadata)));
  }

  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      return [];
    }
    const binding = await captureAttachmentDirectoryBinding(
      storageDirectory,
      sessionId,
    );
    return sortMetadata(
      await readAllStoredMetadataBound(binding, sessionId, consumedIds),
    );
  });
}

export async function readSessionAttachmentBytes(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
  options: AttachmentReadOptions = {},
): Promise<Uint8Array> {
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(attachmentId, "Attachment ID");
  if (!storageDirectory) {
    const item = memoryAttachments.get(sessionId)?.get(attachmentId);
    if (!item) throw new AttachmentNotFoundError();
    assertExpectedAttachmentRef(item.metadata, options.expectedRef);
    await verifyBytes(item.metadata, item.bytes, options.signal);
    return new Uint8Array(item.bytes);
  }

  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      throw new AttachmentNotFoundError();
    }
    const binding = await captureAttachmentDirectoryBinding(
      storageDirectory,
      sessionId,
    );
    const metadata = await readStoredMetadataBound(
      binding,
      sessionId,
      attachmentId,
    );
    assertExpectedAttachmentRef(metadata, options.expectedRef);
    return readAndVerifyBlobBound(binding, metadata, options);
  }, options.signal);
}

export async function deleteSessionAttachment(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(attachmentId, "Attachment ID");
  await withAttachmentStorageBoundary(() =>
    withStorageTransaction(storageDirectory, async () => {
      if (!storageDirectory) {
        const sessionAttachments = memoryAttachments.get(sessionId);
        if (!sessionAttachments?.delete(attachmentId)) {
          throw new AttachmentNotFoundError();
        }
        if (sessionAttachments.size === 0) memoryAttachments.delete(sessionId);
        return;
      }

      const directory = attachmentSessionDirectory(storageDirectory, sessionId);
      if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
        throw new AttachmentNotFoundError();
      }
      const binding = await captureAttachmentDirectoryBinding(
        storageDirectory,
        sessionId,
      );
      await readStoredMetadataBound(binding, sessionId, attachmentId);
      await removeAttachmentFileBound(
        binding,
        attachmentBlobPath(directory, attachmentId),
      );
      await removeAttachmentFileBound(
        binding,
        attachmentMetadataPath(directory, attachmentId),
      );
    })
  );
}

export async function deleteSessionAttachments(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  await withAttachmentStorageBoundary(() =>
    withStorageTransaction(storageDirectory, async () => {
      if (!storageDirectory) {
        memoryAttachments.delete(sessionId);
        return;
      }

      const directory = attachmentSessionDirectory(storageDirectory, sessionId);
      if (!await assertAttachmentRootIsSafe(storageDirectory)) return;
      if (!await assertExistingDirectoryIsSafe(directory)) return;
      const binding = await captureAttachmentDirectoryBinding(
        storageDirectory,
        sessionId,
      );
      await removeAttachmentDirectoryBound(binding);
    })
  );
}

export async function listSessionAttachmentDirectoryIds(
  storageDirectory: string | undefined,
): Promise<string[]> {
  if (!storageDirectory) return [...memoryAttachments.keys()].sort();
  return withAttachmentStorageBoundary(async () => {
    const root = path.join(storageDirectory, attachmentsDirectoryName);
    if (!await assertExistingDirectoryIsSafe(root)) return [];
    const rootIdentity = await captureAttachmentDirectoryIdentity(root);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new AttachmentStorageCorruptionError();
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(entry.name);
      } catch (cause) {
        throw new AttachmentStorageCorruptionError(cause);
      }
      if (!isSafeStorageId(decoded) || encodeURIComponent(decoded) !== entry.name) {
        throw new AttachmentStorageCorruptionError();
      }
      ids.push(decoded);
    }
    await assertAttachmentDirectoryIdentity(root, rootIdentity);
    return ids.sort();
  });
}

export function isImageAttachmentMediaType(
  mediaType: AttachmentMediaType,
): mediaType is ImageAttachmentMediaType {
  return mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/webp";
}

export function sessionAttachmentRefFromStored(
  attachment: StoredSessionAttachment,
): SessionAttachmentRef {
  const base = {
    id: attachment.id,
    fileName: attachment.fileName,
    byteLength: attachment.byteLength,
    sha256: attachment.sha256,
  };
  if (attachment.kind === "audio") {
    return {
      ...base,
      kind: "audio",
      mediaType: attachment.mediaType,
      durationSeconds: attachment.durationSeconds,
      sampleRate: attachment.sampleRate,
      channels: attachment.channels,
    };
  }
  if (attachment.kind === "image") {
    return { ...base, kind: "image", mediaType: attachment.mediaType };
  }
  return { ...base, kind: "document", mediaType: attachment.mediaType };
}

type StoredAttachmentClassification =
  | {
      kind: "image";
      mediaType: ImageAttachmentMediaType;
    }
  | {
      kind: "document";
      mediaType: DocumentAttachmentMediaType;
    }
  | ({ kind: "audio" } & AudioAttachmentInspection);

async function classifyStoredAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  signal?: AbortSignal;
}): Promise<StoredAttachmentClassification> {
  const imageMediaType = detectImageMediaType(input.bytes);
  if (imageMediaType !== null) {
    if (input.bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError();
    }
    if (!validImageDimensions(input.bytes, imageMediaType)) {
      throw new UnsupportedAttachmentError();
    }
    return { kind: "image", mediaType: imageMediaType };
  }

  if (isAudioAttachmentCandidate(input.bytes)) {
    const inspection = await inspectAudioAttachment({
      bytes: input.bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { kind: "audio", ...inspection };
  }

  const mediaType = await classifyDocumentAttachment(input);
  return { kind: "document", mediaType };
}

function assertPendingAttachmentQuota(
  preSavePendingAttachmentRefs: readonly SessionAttachmentRef[],
  candidate: { kind: AttachmentKind; byteLength: number },
): void {
  if (!attachmentQuotaIsWithinLimits([
    ...preSavePendingAttachmentRefs.map((attachment) => ({
      kind: attachment.kind,
      byteLength: attachment.byteLength,
    })),
    candidate,
  ])) {
    throw new AttachmentPendingQuotaError();
  }
}

async function readAllStoredMetadataBound(
  binding: AttachmentDirectoryBinding,
  sessionId: string,
  skippedIds: ReadonlySet<string> = new Set(),
): Promise<StoredSessionAttachment[]> {
  return runWithAttachmentDirectoryBinding(
    binding,
    () => readAllStoredMetadata(binding.directory, sessionId, skippedIds),
  );
}

async function readStoredMetadataBound(
  binding: AttachmentDirectoryBinding,
  sessionId: string,
  attachmentId: string,
): Promise<StoredSessionAttachment> {
  return runWithAttachmentDirectoryBinding(
    binding,
    () => readStoredMetadata(binding.directory, sessionId, attachmentId),
  );
}

async function readAndVerifyBlobBound(
  binding: AttachmentDirectoryBinding,
  metadata: StoredSessionAttachment,
  options: AttachmentReadOptions,
): Promise<Uint8Array> {
  return runWithAttachmentDirectoryBinding(
    binding,
    () => readAndVerifyBlob(binding.directory, metadata, options),
  );
}

async function writeAttachmentBytesCreateOnlyBound(
  binding: AttachmentDirectoryBinding,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  await runWithAttachmentDirectoryBinding(
    binding,
    () => writeBytesAtomicallyCreateOnly(target, bytes),
  );
}

async function writeAttachmentJsonCreateOnlyBound(
  binding: AttachmentDirectoryBinding,
  target: string,
  metadata: StoredSessionAttachment,
): Promise<void> {
  await runWithAttachmentDirectoryBinding(
    binding,
    () => writeJsonAtomicallyCreateOnly(target, metadata),
  );
}

async function removeAttachmentFileBound(
  binding: AttachmentDirectoryBinding,
  target: string,
): Promise<void> {
  await runWithAttachmentDirectoryBinding(
    binding,
    () => removeFileDurably(target),
  );
}

async function removeAttachmentDirectoryBound(
  binding: AttachmentDirectoryBinding,
): Promise<void> {
  await assertAttachmentDirectoryBinding(binding);
  try {
    await removeDirectoryDurably(binding.directory);
  } catch (error) {
    await assertAttachmentDirectoryIdentity(binding.root, binding.rootIdentity);
    if (!isStorageCommitOutcomeUnknownError(error)) {
      await assertAttachmentDirectoryIdentity(
        binding.directory,
        binding.directoryIdentity,
      );
    }
    throw error;
  }
  await assertAttachmentDirectoryIdentity(binding.root, binding.rootIdentity);
  if (await assertExistingDirectoryIsSafe(binding.directory)) {
    throw new AttachmentStorageCorruptionError();
  }
}

async function runWithAttachmentDirectoryBinding<T>(
  binding: AttachmentDirectoryBinding,
  operation: () => Promise<T>,
): Promise<T> {
  await assertAttachmentDirectoryBinding(binding);
  try {
    const result = await operation();
    await assertAttachmentDirectoryBinding(binding);
    return result;
  } catch (error) {
    await assertAttachmentDirectoryBinding(binding);
    throw error;
  }
}

async function readAllStoredMetadata(
  directory: string,
  sessionId: string,
  skippedIds: ReadonlySet<string> = new Set(),
): Promise<StoredSessionAttachment[]> {
  const names = await fs.readdir(directory);
  const metadata: StoredSessionAttachment[] = [];
  const seenIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const fileId = name.slice(0, -".json".length);
    if (!isSafeStorageId(fileId)) throw new AttachmentStorageCorruptionError();
    if (skippedIds.has(fileId)) continue;
    const item = await readMetadataFile(path.join(directory, name));
    if (
      item.id !== fileId ||
      item.sessionId !== sessionId ||
      seenIds.has(item.id) ||
      (item.ordinal !== undefined && seenOrdinals.has(item.ordinal))
    ) {
      throw new AttachmentStorageCorruptionError();
    }
    seenIds.add(item.id);
    if (item.ordinal !== undefined) seenOrdinals.add(item.ordinal);
    metadata.push(item);
  }
  return metadata;
}

function assertExpectedAttachmentRef(
  metadata: StoredSessionAttachment,
  expectedRef: SessionAttachmentRef | undefined,
): void {
  if (expectedRef === undefined) return;
  if (
    metadata.id !== expectedRef.id ||
    metadata.kind !== expectedRef.kind ||
    metadata.fileName !== expectedRef.fileName ||
    metadata.mediaType !== expectedRef.mediaType ||
    metadata.byteLength !== expectedRef.byteLength ||
    metadata.sha256 !== expectedRef.sha256 ||
    (
      metadata.kind === "audio" && expectedRef.kind === "audio" &&
      (
        metadata.durationSeconds !== expectedRef.durationSeconds ||
        metadata.sampleRate !== expectedRef.sampleRate ||
        metadata.channels !== expectedRef.channels
      )
    )
  ) {
    throw new AttachmentStorageCorruptionError();
  }
}

function nextAttachmentOrdinal(
  metadata: readonly StoredSessionAttachment[],
): number {
  const highest = metadata.reduce(
    (maximum, attachment) => Math.max(maximum, attachment.ordinal ?? 0),
    metadata.length,
  );
  if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER) {
    throw new AttachmentStorageCorruptionError();
  }
  return highest + 1;
}

function attachmentSessionDirectory(
  storageDirectory: string,
  sessionId: string,
): string {
  const safeSessionId = requireSafeStorageId(sessionId, "Session ID");
  return path.join(
    storageDirectory,
    attachmentsDirectoryName,
    encodeURIComponent(safeSessionId),
  );
}

function attachmentMetadataPath(directory: string, attachmentId: string): string {
  return path.join(
    directory,
    `${requireSafeStorageId(attachmentId, "Attachment ID")}.json`,
  );
}

function attachmentBlobPath(directory: string, attachmentId: string): string {
  return path.join(
    directory,
    `${requireSafeStorageId(attachmentId, "Attachment ID")}.bin`,
  );
}

async function readStoredMetadata(
  directory: string,
  sessionId: string,
  attachmentId: string,
): Promise<StoredSessionAttachment> {
  const target = attachmentMetadataPath(directory, attachmentId);
  let metadata: StoredSessionAttachment;
  try {
    metadata = await readMetadataFile(target);
  } catch (error) {
    if (isMissingFileError(error)) throw new AttachmentNotFoundError();
    throw error;
  }
  if (metadata.id !== attachmentId || metadata.sessionId !== sessionId) {
    throw new AttachmentStorageCorruptionError();
  }
  return metadata;
}

async function readMetadataFile(target: string): Promise<StoredSessionAttachment> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await openRegularPrivateFile(target);
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!isStoredSessionAttachment(parsed)) {
      throw new AttachmentStorageCorruptionError();
    }
    return cloneMetadata(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AttachmentStorageCorruptionError(error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readAndVerifyBlob(
  directory: string,
  metadata: StoredSessionAttachment,
  options: AttachmentReadOptions,
): Promise<Uint8Array> {
  let handle: fs.FileHandle | undefined;
  try {
    const target = attachmentBlobPath(directory, metadata.id);
    handle = await openRegularPrivateFile(target);
    await assertBlobHandleMatchesMetadata(handle, metadata);
    const bytes = options.readFile === undefined
      ? new Uint8Array(await handle.readFile())
      : new Uint8Array(await options.readFile(handle));
    await verifyBytes(metadata, bytes, options.signal);
    return bytes;
  } catch (error) {
    if (
      isMissingFileError(error) ||
      error instanceof AttachmentStorageCorruptionError
    ) {
      throw error instanceof AttachmentStorageCorruptionError
        ? error
        : new AttachmentStorageCorruptionError(error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertBlobHandleMatchesMetadata(
  handle: fs.FileHandle,
  metadata: StoredSessionAttachment,
): Promise<void> {
  const info = await handle.stat();
  const maximumBytes = metadata.kind === "image"
    ? MAX_IMAGE_ATTACHMENT_BYTES
    : metadata.kind === "audio"
      ? MAX_AUDIO_ATTACHMENT_BYTES
      : MAX_DOCUMENT_ATTACHMENT_BYTES;
  if (
    !info.isFile() ||
    !Number.isSafeInteger(info.size) ||
    info.size !== metadata.byteLength ||
    info.size > maximumBytes
  ) {
    throw new AttachmentStorageCorruptionError();
  }
}

async function verifyBytes(
  metadata: StoredSessionAttachment,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (
    bytes.byteLength !== metadata.byteLength ||
    await hashBytes(bytes, signal) !== metadata.sha256
  ) {
    throw new AttachmentStorageCorruptionError();
  }
  if (metadata.kind === "image") {
    if (
      !isImageMediaType(metadata.mediaType) ||
      detectImageMediaType(bytes) !== metadata.mediaType ||
      !validImageDimensions(bytes, metadata.mediaType)
    ) throw new AttachmentStorageCorruptionError();
    return;
  }

  if (metadata.kind === "audio") {
    try {
      const inspection = await inspectAudioAttachment({
        bytes,
        ...(signal === undefined ? {} : { signal }),
      });
      if (
        inspection.mediaType !== metadata.mediaType ||
        inspection.durationSeconds !== metadata.durationSeconds ||
        inspection.sampleRate !== metadata.sampleRate ||
        inspection.channels !== metadata.channels
      ) throw new AttachmentStorageCorruptionError();
      return;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof AttachmentStorageCorruptionError) throw error;
      throw new AttachmentStorageCorruptionError(error);
    }
  }

  try {
    const mediaType = await classifyDocumentAttachment({
      bytes,
      fileName: metadata.fileName,
      claimedMediaType: metadata.mediaType,
      ...(signal === undefined ? {} : { signal }),
    });
    if (mediaType !== metadata.mediaType) {
      throw new AttachmentStorageCorruptionError();
    }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AttachmentStorageCorruptionError) throw error;
    throw new AttachmentStorageCorruptionError(error);
  }
}

function isStoredSessionAttachment(value: unknown): value is StoredSessionAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "sessionId",
    "kind",
    "fileName",
    "mediaType",
    "byteLength",
    "sha256",
    "createdAt",
    "ordinal",
    "durationSeconds",
    "sampleRate",
    "channels",
  ]);
  const keys = Object.keys(record);
  const hasOrdinal = record.ordinal !== undefined;
  const audioFields = record.kind === "audio" ? 3 : 0;
  if (
    !keys.every((key) => allowed.has(key)) ||
    keys.length !== (hasOrdinal ? 9 : 8) + audioFields ||
    !isSafeStorageId(record.id) ||
    !isSafeStorageId(record.sessionId) ||
    !Number.isInteger(record.byteLength) ||
    (record.byteLength as number) <= 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    typeof record.createdAt !== "string"
  ) return false;

  if (!hasOrdinal) {
    return record.kind === "image" &&
      isImageMediaType(record.mediaType) &&
      isLegacyAttachmentFileName(record.fileName) &&
      (record.byteLength as number) <= MAX_IMAGE_ATTACHMENT_BYTES;
  }

  return Number.isSafeInteger(record.ordinal) &&
    (record.ordinal as number) > 0 &&
    (record.kind === "image" || record.kind === "document" || record.kind === "audio") &&
    isSafeAttachmentFileName(record.fileName) &&
    isAttachmentMediaType(record.mediaType) &&
    attachmentKindMatchesMediaType(record.kind, record.mediaType) &&
    (record.byteLength as number) <= (
      record.kind === "image"
        ? MAX_IMAGE_ATTACHMENT_BYTES
        : record.kind === "audio"
          ? MAX_AUDIO_ATTACHMENT_BYTES
          : MAX_DOCUMENT_ATTACHMENT_BYTES
    ) && (
      record.kind !== "audio" ||
      isAudioAttachmentInspection({
        mediaType: record.mediaType,
        durationSeconds: record.durationSeconds,
        sampleRate: record.sampleRate,
        channels: record.channels,
      })
    );
}

function detectImageMediaType(bytes: Uint8Array): ImageAttachmentMediaType | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

function validImageDimensions(
  bytes: Uint8Array,
  mediaType: ImageAttachmentMediaType,
): boolean {
  const dimensions = mediaType === "image/png"
    ? pngDimensions(bytes)
    : mediaType === "image/jpeg"
      ? jpegDimensions(bytes)
      : webpDimensions(bytes);
  if (!dimensions) return false;
  return dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= maxImageDimension &&
    dimensions.height <= maxImageDimension &&
    dimensions.width * dimensions.height <= maxImagePixels;
}

function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.byteLength < 24 || ascii(bytes, 12, 16) !== "IHDR") return null;
  return {
    width: unsigned32BigEndian(bytes, 16),
    height: unsigned32BigEndian(bytes, 20),
  };
}

function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc;
}

function webpDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.byteLength < 21) return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X") {
    if (bytes.byteLength < 30 || unsigned32LittleEndian(bytes, 16) < 10) return null;
    return {
      width: unsigned24LittleEndian(bytes, 24) + 1,
      height: unsigned24LittleEndian(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 ") {
    if (
      bytes.byteLength < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) return null;
    return {
      width: ((bytes[27]! << 8) | bytes[26]!) & 0x3fff,
      height: ((bytes[29]! << 8) | bytes[28]!) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return null;
    const bits = unsigned32LittleEndian(bytes, 21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function unsigned24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function unsigned32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function unsigned32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0;
}

function isImageMediaType(value: unknown): value is ImageAttachmentMediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function isDocumentMediaType(
  value: unknown,
): value is DocumentAttachmentMediaType {
  return value === "application/pdf" ||
    value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    value === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    value === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return isImageMediaType(value) ||
    isDocumentMediaType(value) ||
    value === "audio/wav" ||
    value === "audio/mpeg";
}

function attachmentKindMatchesMediaType(
  kind: AttachmentKind,
  mediaType: AttachmentMediaType,
): boolean {
  if (kind === "image") return isImageMediaType(mediaType);
  if (kind === "audio") return mediaType === "audio/wav" || mediaType === "audio/mpeg";
  return isDocumentMediaType(mediaType);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function sanitizedFileName(
  value: string,
  mediaType: AttachmentMediaType,
): string {
  const leaf = String(value).normalize("NFC").replaceAll("\\", "/")
    .split("/").at(-1) ?? "";
  const sanitized = leaf.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    "",
  ).trim();
  const bounded = truncateUtf8(sanitized, MAX_ATTACHMENT_FILE_NAME_BYTES);
  if (bounded) return bounded;
  return defaultFileName(mediaType);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

function defaultFileName(
  mediaType: AttachmentMediaType,
): string {
  switch (mediaType) {
    case "image/png": return "image.png";
    case "image/jpeg": return "image.jpg";
    case "image/webp": return "image.webp";
    case "application/pdf": return "document.pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "document.docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "spreadsheet.xlsx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "presentation.pptx";
    case "audio/wav": return "audio.wav";
    case "audio/mpeg": return "audio.mp3";
  }
}

async function hashBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const chunkBytes = 256 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    throwIfAborted(signal);
    const end = Math.min(offset + chunkBytes, bytes.byteLength);
    hash.update(Buffer.from(bytes.buffer, bytes.byteOffset + offset, end - offset));
    if (end < bytes.byteLength) await yieldToHost(signal);
  }
  throwIfAborted(signal);
  return hash.digest("hex");
}

function nextAttachmentId(options: AttachmentSaveOptions): string {
  return requireSafeStorageId(
    options.createId?.() ?? createStorageId("attachment"),
    "Attachment ID",
  );
}

function attachmentMetadata(input: {
  id: string;
  sessionId: string;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  ordinal: number;
  createdAt: string;
} & StoredAttachmentClassification): StoredSessionAttachment {
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    fileName: input.fileName,
    byteLength: input.bytes.byteLength,
    sha256: input.sha256,
    createdAt: input.createdAt,
    ordinal: input.ordinal,
  };
  if (input.kind === "audio") {
    return {
      ...base,
      kind: "audio",
      mediaType: input.mediaType,
      durationSeconds: input.durationSeconds,
      sampleRate: input.sampleRate,
      channels: input.channels,
    };
  }
  if (input.kind === "image") {
    return { ...base, kind: "image", mediaType: input.mediaType };
  }
  return { ...base, kind: "document", mediaType: input.mediaType };
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}

async function withAttachmentStorageBoundary<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  abortMaySupersedeFailure: () => boolean = () => true,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AttachmentTooLargeError ||
      error instanceof AttachmentPendingQuotaError ||
      error instanceof UnsupportedAttachmentError ||
      error instanceof AttachmentProcessingError ||
      error instanceof AttachmentNotFoundError ||
      error instanceof AttachmentStorageCorruptionError ||
      error instanceof AttachmentStorageAccessError ||
      isStorageCommitOutcomeUnknownError(error)
    ) {
      throw error;
    }
    if (abortMaySupersedeFailure()) throwIfAborted(signal);
    throw new AttachmentStorageAccessError(error);
  }
}

async function prepareAttachmentSessionDirectory(
  storageDirectory: string,
  sessionId: string,
  create: boolean,
): Promise<boolean> {
  const root = path.join(storageDirectory, attachmentsDirectoryName);
  const directory = attachmentSessionDirectory(storageDirectory, sessionId);
  for (const target of [root, directory]) {
    const exists = await assertExistingDirectoryIsSafe(target);
    if (!exists) {
      if (!create) return false;
      await ensurePrivateDirectoryDurably(target);
    } else {
      await ensurePrivateDirectory(target);
    }
  }
  return true;
}

async function assertAttachmentRootIsSafe(
  storageDirectory: string,
): Promise<boolean> {
  return assertExistingDirectoryIsSafe(
    path.join(storageDirectory, attachmentsDirectoryName),
  );
}

async function captureAttachmentDirectoryBinding(
  storageDirectory: string,
  sessionId: string,
): Promise<AttachmentDirectoryBinding> {
  const root = path.join(storageDirectory, attachmentsDirectoryName);
  const directory = attachmentSessionDirectory(storageDirectory, sessionId);
  const binding = {
    root,
    rootIdentity: await captureAttachmentDirectoryIdentity(root),
    directory,
    directoryIdentity: await captureAttachmentDirectoryIdentity(directory),
  };
  await assertAttachmentDirectoryBinding(binding);
  return binding;
}

async function captureAttachmentDirectoryIdentity(
  directory: string,
): Promise<AttachmentDirectoryIdentity> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AttachmentStorageCorruptionError();
    }
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error instanceof AttachmentStorageCorruptionError) throw error;
    throw new AttachmentStorageCorruptionError(error);
  }
}

async function assertAttachmentDirectoryBinding(
  binding: AttachmentDirectoryBinding,
): Promise<void> {
  await assertAttachmentDirectoryIdentity(binding.root, binding.rootIdentity);
  await assertAttachmentDirectoryIdentity(
    binding.directory,
    binding.directoryIdentity,
  );
}

async function assertAttachmentDirectoryIdentity(
  directory: string,
  expected: AttachmentDirectoryIdentity,
): Promise<void> {
  try {
    const actual = await fs.lstat(directory);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw new AttachmentStorageCorruptionError();
    }
  } catch (error) {
    if (error instanceof AttachmentStorageCorruptionError) throw error;
    throw new AttachmentStorageCorruptionError(error);
  }
}

async function assertExistingDirectoryIsSafe(target: string): Promise<boolean> {
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AttachmentStorageCorruptionError();
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function openRegularPrivateFile(target: string): Promise<fs.FileHandle> {
  let handle: fs.FileHandle;
  try {
    const flags = platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    handle = await fs.open(target, flags);
  } catch (error) {
    if (isSymbolicLinkOpenError(error)) {
      throw new AttachmentStorageCorruptionError(error);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AttachmentStorageCorruptionError();
    if (platform !== "win32") await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ["ELOOP", "EMLINK"].includes(String((error as { code?: unknown }).code));
}

function cloneMetadata(metadata: StoredSessionAttachment): StoredSessionAttachment {
  return { ...metadata };
}

function sortMetadata(
  metadata: StoredSessionAttachment[],
): StoredSessionAttachment[] {
  return metadata.sort((left, right) => {
    if (left.ordinal !== undefined && right.ordinal !== undefined) {
      return left.ordinal - right.ordinal;
    }
    if (left.ordinal === undefined && right.ordinal !== undefined) return -1;
    if (left.ordinal !== undefined && right.ordinal === undefined) return 1;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}
