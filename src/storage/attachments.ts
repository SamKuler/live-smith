import { Buffer } from "node:buffer";
import { openVerifiedStoredStream, type SessionFileExport } from "./file-export.js";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { types as utilTypes } from "node:util";

import { persistTransientSessionInTransaction } from "./sessions.js";
import {
  ATTACHMENT_FORMATS,
  attachmentMediaTypeMatchesKind as attachmentKindMatchesMediaType,
  attachmentQuotaIsWithinLimits,
  AttachmentProcessingError,
  type AttachmentMediaType,
  type DocumentAttachmentMediaType,
  isAttachmentMediaType,
  isLegacyAttachmentFileName,
  isSafeAttachmentFileName,
  MAX_ATTACHMENT_FILE_NAME_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_BUFFERED_ATTACHMENT_BYTES,
  MAX_LOCAL_AUDIO_ATTACHMENT_BYTES,
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_DIMENSION,
  MAX_IMAGE_ATTACHMENT_PIXELS,
} from "../attachments/contracts.js";
import {
  inspectAudioAttachment,
  inspectAudioAttachmentRange,
  previewWaveformRange,
  isAudioAttachmentCandidate,
  isAudioAttachmentInspection,
  type AudioAttachmentInspection,
} from "../attachments/audio.js";
import { classifyDocumentAttachment } from "../attachments/processor.js";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import { isStorageCommitOutcomeUnknownError, withStorageTransaction } from "./persistence.js";
import { listStoredChildren, storedEntry, openStoredReader, openStoredRangeReader, createStoredFileWriter, copyStoredReference, readStoredText, storedTreeExists, removeStoredEntry, removeStoredTree, writeStoredBytes, writeStoredJson } from "./sqlite.js";

import { isAttachmentProvenance, type AttachmentProvenance } from "../attachments/provenance.js";

export type AttachmentKind = "image" | "document" | "audio";

export type { AttachmentMediaType } from "../attachments/contracts.js";

export type ImageAttachmentMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface SessionAttachmentRefBase {
  provenance?: AttachmentProvenance;
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

interface AttachmentDirectoryBinding {
  storageDirectory: string;
  directory: string;
}

export interface AttachmentSaveOptions {
  /** Upload retries may reuse an identical pending reference before consuming quota. */
  reuseMatchingPending?: boolean;
  /** Test seam for proving collision handling; production always uses createStorageId. */
  createId?: () => string;
  provenance?: AttachmentProvenance;
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
  /** Consumer-specific limit checked before allocating or reading content. */
  maxBytes?: number;
  /** Test seam for proving the size bound is checked before blob content is read. */
  readFile?: (reader: { readFile(): Promise<Uint8Array> }) => Promise<Uint8Array>;
}

export interface ReadSessionAttachmentResult {
  attachment: SessionAttachmentRef;
  bytes: Uint8Array;
}

const localAudioLimits = { maxBytes: MAX_LOCAL_AUDIO_ATTACHMENT_BYTES, maxDurationSeconds: MAX_LOCAL_AUDIO_DURATION_SECONDS };

const attachmentsDirectoryName = "live-smith-attachments";
const memoryAttachments = new Map<string, Map<string, MemoryAttachment>>();

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
  if (!isUint8Array(input.bytes)) {
    throw new TypeError("Attachment bytes must be binary data.");
  }
  if (input.bytes.byteLength > MAX_BUFFERED_ATTACHMENT_BYTES) {
    throw new AttachmentProcessingError(
      "archive_limit",
      `Attachment uploads may not exceed ${MAX_BUFFERED_ATTACHMENT_BYTES / (1024 * 1024)} MiB.`,
    );
  }
  const signal = input.signal;
  const bytes = new Uint8Array(input.bytes);
  const fileNameClaim = String(input.fileName);
  const claimedMediaType = input.claimedMediaType;
  const pendingSnapshot = options.preSavePendingAttachmentRefs.map(
    (attachment) => ({ ...attachment }),
  );
  const provenance = options.provenance === undefined ? undefined : { ...options.provenance, replacedIds: [...options.provenance.replacedIds] };
  if (provenance && !isAttachmentProvenance(provenance, undefined)) throw new AttachmentProcessingError("archive_limit", "The attachment selection history exceeds its 16 KiB metadata budget or contains an invalid source.");
  let storageCommitStarted = false;
  return withAttachmentStorageBoundary(async () => {
    throwIfAborted(signal);
    const classification = await classifyStoredAttachment({
      bytes,
      fileName: fileNameClaim,
      ...(claimedMediaType === undefined ? {} : { claimedMediaType }),
      ...(signal === undefined ? {} : { signal }),
    });
    const sha256 = await hashAttachmentBytes(bytes, signal);
    throwIfAborted(signal);
    const fileName = sanitizedAttachmentFileName(fileNameClaim, classification.mediaType);

    return withStorageTransaction(storageDirectory, async (transaction) => {
      throwIfAborted(signal);
      storageCommitStarted = true;
      assertPendingAttachmentQuota(pendingSnapshot, {
        kind: classification.kind,
        byteLength: bytes.byteLength,
      });
      await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);

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
            ...(provenance ? { provenance } : {}),
            byteLength: bytes.byteLength,
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
        await readAllStoredMetadata(binding, sessionId),
      );
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const id = nextAttachmentId(options);
        const metadata = attachmentMetadata({
          id,
          sessionId,
          fileName,
          ...classification,
          ...(provenance ? { provenance } : {}),
          byteLength: bytes.byteLength,
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

export interface StagedSessionAttachment {
  publish(options: AttachmentSaveOptions): Promise<StoredSessionAttachment>;
  dispose(): Promise<void>;
}

/** Receive and validate the original independently of the Session publication fence. */
export async function stageSessionAttachmentStream(
  storageDirectory: string | undefined, sessionId: string,
  input: { fileName: string; chunks: AsyncIterable<Uint8Array>; claimedMediaType?: string; signal?: AbortSignal; expectedByteLength?: number },
): Promise<StagedSessionAttachment> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!storageDirectory) {
    const parts: Uint8Array[] = []; let length = 0;
    for await (const chunk of input.chunks) {
      throwIfAborted(input.signal);
      if (!isUint8Array(chunk)) throw new TypeError("Attachment bytes must be binary data.");
      length += chunk.byteLength;
      if (length > 128 * 1024 * 1024) throw new AttachmentProcessingError("archive_limit", "In-memory attachments may not exceed 128 MiB.");
      parts.push(new Uint8Array(chunk));
    }
    if (input.expectedByteLength !== undefined && input.expectedByteLength !== length) throw new AttachmentProcessingError("invalid_document", "Attachment length does not match its declared length.");
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return { dispose: async () => {}, publish: options => saveSessionAttachment(storageDirectory, sessionId,
      { fileName: input.fileName, bytes, ...(input.claimedMediaType === undefined ? {} : { claimedMediaType: input.claimedMediaType }),
        ...(input.signal === undefined ? {} : { signal: input.signal }) }, options) };
  }
  const writer = await createStoredFileWriter(storageDirectory, input.expectedByteLength === undefined ? {} : { expectedByteLength: input.expectedByteLength });
  const uploadHash = createHash("sha256");
  try {
    for await (const chunk of input.chunks) {
      throwIfAborted(input.signal);
      if (!isUint8Array(chunk)) throw new TypeError("Attachment bytes must be binary data.");
      if (writer.byteLength + chunk.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) throw new AttachmentProcessingError("archive_limit", "Attachment exceeds the local upload limit.");
      uploadHash.update(chunk);
      await writer.append(chunk);
    }
    throwIfAborted(input.signal);
    const prefix = await writer.readRange(0, Math.min(writer.byteLength, 64 * 1024));
    let classification: StoredAttachmentClassification;
    if (isAudioAttachmentCandidate(prefix)) {
      classification = { kind: "audio", ...await inspectAudioAttachmentRange({ byteLength: writer.byteLength, readRange: (offset, length) => writer.readRange(offset, length), limits: localAudioLimits, ...(input.signal === undefined ? {} : { signal: input.signal }) }) };
    } else {
      if (writer.byteLength > Math.max(MAX_IMAGE_ATTACHMENT_BYTES, MAX_DOCUMENT_ATTACHMENT_BYTES)) throw new AttachmentProcessingError("archive_limit", "Attachment exceeds the local image or document limit.");
      const bytes = new Uint8Array(writer.byteLength);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) bytes.set(await writer.readRange(offset, Math.min(64 * 1024, bytes.length - offset)), offset);
      classification = await classifyStoredAttachment({ bytes, fileName: input.fileName, ...(input.claimedMediaType === undefined ? {} : { claimedMediaType: input.claimedMediaType }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    }
    const uploadDigest = uploadHash.digest("hex");
    const fileName = sanitizedAttachmentFileName(input.fileName, classification.mediaType);
    return { dispose: () => writer.abort(), publish: async options => {
      const pending = options.preSavePendingAttachmentRefs.map(item => ({ ...item }));
      const provenance = options.provenance === undefined ? undefined : { ...options.provenance, replacedIds: [...options.provenance.replacedIds] };
      if (provenance && !isAttachmentProvenance(provenance, undefined)) throw new AttachmentProcessingError("archive_limit", "The attachment selection history is invalid.");
      let committed = false;
      return withAttachmentStorageBoundary(() => withStorageTransaction(storageDirectory, async transaction => {
        throwIfAborted(input.signal);
        if (options.reuseMatchingPending) {
          const matching = pending.find(item => item.byteLength === writer.byteLength && item.sha256 === uploadDigest && item.fileName === fileName);
          if (matching) {
            const existing = await readSessionAttachmentMetadata(storageDirectory, sessionId, matching.id);
            assertExpectedAttachmentRef(existing, matching);
            return existing;
          }
        }
        assertPendingAttachmentQuota(pending, { kind: classification.kind, byteLength: writer.byteLength });
        committed = true;
        await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
        await prepareAttachmentSessionDirectory(storageDirectory, sessionId, true);
        const binding = await captureAttachmentDirectoryBinding(storageDirectory, sessionId);
        const ordinal = nextAttachmentOrdinal(await readAllStoredMetadata(binding, sessionId));
        for (let attempt = 0; attempt < 32; attempt++) {
          const id = nextAttachmentId(options), target = attachmentBlobPath(binding.directory, id);
          if (await storedEntry(storageDirectory, target) || await storedEntry(storageDirectory, attachmentMetadataPath(binding.directory, id))) continue;
          const entry = await writer.publish(target, { createOnly: true });
          const metadata = attachmentMetadata({ id, sessionId, fileName, ...classification, ...(provenance ? { provenance } : {}), byteLength: entry.byteLength, sha256: entry.sha256, ordinal, createdAt: (options.now?.() ?? new Date()).toISOString() });
          try { await writeAttachmentJsonCreateOnlyBound(binding, attachmentMetadataPath(binding.directory, id), metadata); }
          catch (error) { if (!isStorageCommitOutcomeUnknownError(error)) await removeAttachmentFileBound(binding, target); throw error; }
          return cloneMetadata(metadata);
        }
        throw new Error("Could not allocate a unique attachment ID.");
      }), input.signal, () => !committed);
    } };
  } catch (error) { await writer.abort(); throw error; }
}

/** Receive, validate and publish using an already authorized attachment snapshot. */
export async function saveSessionAttachmentStream(
  storageDirectory: string | undefined, sessionId: string,
  input: Parameters<typeof stageSessionAttachmentStream>[2], options: AttachmentSaveOptions,
): Promise<StoredSessionAttachment> {
  const staged = await stageSessionAttachmentStream(storageDirectory,sessionId,input);
  try { return await staged.publish(options); }
  finally { await staged.dispose(); }
}

/** Read an attachment reference without materializing its content. */
export async function readSessionAttachmentMetadata(storageDirectory: string | undefined, sessionId: string, attachmentId: string): Promise<StoredSessionAttachment> {
  requireSafeStorageId(sessionId, "Session ID"); requireSafeStorageId(attachmentId, "Attachment ID");
  if (!storageDirectory) {
    const item = memoryAttachments.get(sessionId)?.get(attachmentId);
    if (!item) throw new AttachmentNotFoundError();
    return cloneMetadata(item.metadata);
  }
  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) throw new AttachmentNotFoundError();
    return readStoredMetadata(await captureAttachmentDirectoryBinding(storageDirectory, sessionId), sessionId, attachmentId);
  });
}

/** Open a bounded reader tied to this Session and immutable attachment metadata. */
export async function openSessionAttachmentRange(storageDirectory: string | undefined, sessionId: string, attachmentId: string) {
  const metadata = await readSessionAttachmentMetadata(storageDirectory, sessionId, attachmentId);
  if (!storageDirectory) {
    const item = memoryAttachments.get(sessionId)?.get(attachmentId)!;
    return { attachment: sessionAttachmentRefFromStored(metadata), async readRange(offset: number, length: number) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 || offset + length > item.bytes.length) throw new RangeError("Invalid attachment range.");
      return Buffer.from(item.bytes.subarray(offset, offset + length));
    }, async close() {} };
  }
  const reader = await openStoredRangeReader(storageDirectory, attachmentBlobPath(attachmentSessionDirectory(storageDirectory, sessionId), attachmentId));
  if (reader.entry.byteLength !== metadata.byteLength || reader.entry.sha256 !== metadata.sha256) { await reader.close(); throw new AttachmentStorageCorruptionError(); }
  return { attachment: sessionAttachmentRefFromStored(metadata), readRange: reader.readRange, close: reader.close };
}

/** Generate a bounded, sampled waveform preview for a saved WAV attachment. */
export async function readSessionAttachmentWaveform(storageDirectory: string | undefined, sessionId: string, attachmentId: string, options: { buckets?: number; signal?: AbortSignal } = {}): Promise<{ peaks: number[]; durationSeconds: number } | undefined> {
  const reader = await openSessionAttachmentRange(storageDirectory, sessionId, attachmentId);
  try {
    if (reader.attachment.kind !== "audio" || reader.attachment.mediaType !== "audio/wav") return undefined;
    const preview = await previewWaveformRange({ byteLength: reader.attachment.byteLength, readRange: reader.readRange,
      ...(options.buckets === undefined ? {} : { buckets: options.buckets }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (preview?.durationSeconds !== reader.attachment.durationSeconds) throw new AttachmentStorageCorruptionError();
    return preview;
  } finally { await reader.close(); }
}

/** Create a new attachment reference to an existing immutable object. */
export async function reuseSessionAttachment(storageDirectory: string | undefined, sessionId: string, attachmentId: string, options: AttachmentSaveOptions & { signal?: AbortSignal }): Promise<StoredSessionAttachment> {
  requireSafeStorageId(sessionId, "Session ID"); requireSafeStorageId(attachmentId, "Attachment ID");
  const source = await readSessionAttachmentMetadata(storageDirectory, sessionId, attachmentId);
  const provenance = options.provenance === undefined ? undefined : { ...options.provenance, replacedIds: [...options.provenance.replacedIds] };
  if (provenance && !isAttachmentProvenance(provenance, undefined)) throw new AttachmentProcessingError("archive_limit", "The attachment selection history is invalid.");
  assertPendingAttachmentQuota(options.preSavePendingAttachmentRefs, source);
  return withAttachmentStorageBoundary(() => withStorageTransaction(storageDirectory, async transaction => {
    throwIfAborted(options.signal);
    await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
    if (!storageDirectory) {
      const items = memoryAttachments.get(sessionId); const item = items?.get(attachmentId);
      if (!items || !item) throw new AttachmentNotFoundError();
      const ordinal = nextAttachmentOrdinal([...items.values()].map(value => value.metadata));
      for (let attempt = 0; attempt < 32; attempt++) {
        const id = nextAttachmentId(options); if (items.has(id)) continue;
        const metadata = { ...source, id, ordinal, createdAt: (options.now?.() ?? new Date()).toISOString(), ...(provenance ? { provenance } : {}) };
        if (!provenance) delete metadata.provenance;
        items.set(id, { metadata, bytes: item.bytes }); return cloneMetadata(metadata);
      }
    } else {
      const binding = await captureAttachmentDirectoryBinding(storageDirectory, sessionId);
      const current = await readStoredMetadata(binding, sessionId, attachmentId);
      assertExpectedAttachmentRef(current, sessionAttachmentRefFromStored(source));
      const ordinal = nextAttachmentOrdinal(await readAllStoredMetadata(binding, sessionId));
      for (let attempt = 0; attempt < 32; attempt++) {
        const id = nextAttachmentId(options), target = attachmentBlobPath(binding.directory, id);
        try {
          const entry = await copyStoredReference(storageDirectory, attachmentBlobPath(binding.directory, attachmentId), target, { createOnly: true });
          if (entry.sha256 !== source.sha256 || entry.byteLength !== source.byteLength) {
            await removeAttachmentFileBound(binding, target);
            throw new AttachmentStorageCorruptionError();
          }
        } catch (error) { if (isAlreadyExistsError(error)) continue; throw error; }
        const metadata = { ...source, id, ordinal, createdAt: (options.now?.() ?? new Date()).toISOString(), ...(provenance ? { provenance } : {}) };
        if (!provenance) delete metadata.provenance;
        try { await writeAttachmentJsonCreateOnlyBound(binding, attachmentMetadataPath(binding.directory, id), metadata); }
        catch (error) { if (!isStorageCommitOutcomeUnknownError(error)) await removeAttachmentFileBound(binding, target); if (isAlreadyExistsError(error)) continue; throw error; }
        return cloneMetadata(metadata);
      }
    }
    throw new Error("Could not allocate a unique attachment ID.");
  }), options.signal);
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
    return sortMetadata(await readAllStoredMetadata(binding, sessionId));
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
  omittedAttachmentId?: string,
): Promise<StoredSessionAttachment[]> {
  requireSafeStorageId(sessionId, "Session ID");
  const consumedIds = new Set(
    consumedAttachmentIds.map((id) => requireSafeStorageId(id, "Attachment ID")),
  );
  if (!storageDirectory) {
    const items = [...(memoryAttachments.get(sessionId)?.values() ?? [])]
      .filter((item) => !consumedIds.has(item.metadata.id));
    return pendingMetadata(items.map((item) => cloneMetadata(item.metadata)), omittedAttachmentId);
  }

  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      return [];
    }
    const binding = await captureAttachmentDirectoryBinding(
      storageDirectory,
      sessionId,
    );
    return pendingMetadata(
      await readAllStoredMetadata(binding, sessionId, consumedIds),
      omittedAttachmentId,
    );
  });
}

export async function readSessionAttachmentBytes(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
  options: AttachmentReadOptions = {},
): Promise<Uint8Array> {
  return (await readSessionAttachment(
    storageDirectory,
    sessionId,
    attachmentId,
    options,
  )).bytes;
}

export async function readSessionAttachment(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
  options: AttachmentReadOptions = {},
): Promise<ReadSessionAttachmentResult> {
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(attachmentId, "Attachment ID");
  if (!storageDirectory) {
    const item = memoryAttachments.get(sessionId)?.get(attachmentId);
    if (!item) throw new AttachmentNotFoundError();
    assertExpectedAttachmentRef(item.metadata, options.expectedRef);
    if (options.maxBytes !== undefined && item.metadata.byteLength > options.maxBytes) throw new AttachmentProcessingError("archive_limit", "Attachment exceeds the consumer byte limit.");
    await verifyBytes(item.metadata, item.bytes, options.signal);
    return {
      attachment: sessionAttachmentRefFromStored(item.metadata),
      bytes: new Uint8Array(item.bytes),
    };
  }

  return withAttachmentStorageBoundary(async () => {
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      throw new AttachmentNotFoundError();
    }
    const binding = await captureAttachmentDirectoryBinding(
      storageDirectory,
      sessionId,
    );
    const metadata = await readStoredMetadata(
      binding,
      sessionId,
      attachmentId,
    );
    assertExpectedAttachmentRef(metadata, options.expectedRef);
    if (options.maxBytes !== undefined && metadata.byteLength > options.maxBytes) throw new AttachmentProcessingError("archive_limit", "Attachment exceeds the consumer byte limit.");
    return {
      attachment: sessionAttachmentRefFromStored(metadata),
      bytes: await readAndVerifyBlob(binding, metadata, options),
    };
  }, options.signal);
}

export async function sessionAttachmentExport(storageDirectory: string, sessionId: string, attachmentId: string): Promise<SessionFileExport> {
  requireSafeStorageId(sessionId, "Session ID"); requireSafeStorageId(attachmentId, "Attachment ID");
  if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) throw new AttachmentNotFoundError();
  const binding = await captureAttachmentDirectoryBinding(storageDirectory, sessionId);
  const metadata = await readStoredMetadata(binding, sessionId, attachmentId);
  return { fileName: metadata.fileName, mediaType: metadata.mediaType, byteLength: metadata.byteLength,
    open: (signal, range) => openVerifiedStoredStream({ storageDirectory, key: attachmentBlobPath(binding.directory, attachmentId), byteLength: metadata.byteLength, sha256: metadata.sha256, signal, ...(range ? { range } : {}),
      assertCurrent: async () => {
        if (JSON.stringify(await readStoredMetadata(binding, sessionId, attachmentId)) !== JSON.stringify(metadata)) throw new AttachmentStorageCorruptionError();
      } }),
  };
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
      await readStoredMetadata(binding, sessionId, attachmentId);
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

      if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) return;
      const binding = await captureAttachmentDirectoryBinding(
        storageDirectory,
        sessionId,
      );
      await removeAttachmentDirectoryBound(binding);
    })
  );
}

export async function listSessionAttachmentDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (!storageDirectory) return [...memoryAttachments.keys()].sort();
  return withAttachmentStorageBoundary(async () => {
    const names = await listStoredChildren(storageDirectory, attachmentsDirectoryName);
    return names.map(name => {
      let id: string;
      try { id = decodeURIComponent(name); } catch (cause) { throw new AttachmentStorageCorruptionError(cause); }
      if (!isSafeStorageId(id) || encodeURIComponent(id) !== name) throw new AttachmentStorageCorruptionError();
      return id;
    }).sort();
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
    ...(attachment.provenance ? { provenance: { ...attachment.provenance, replacedIds: [...attachment.provenance.replacedIds] } } : {}),
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
      limits: localAudioLimits,
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

async function writeAttachmentBytesCreateOnlyBound(binding: AttachmentDirectoryBinding, target: string, bytes: Uint8Array): Promise<void> {
  await writeStoredBytes(binding.storageDirectory, target, bytes, { createOnly: true, storage: "file" });
}

async function writeAttachmentJsonCreateOnlyBound(binding: AttachmentDirectoryBinding, target: string, metadata: StoredSessionAttachment): Promise<void> {
  await writeStoredJson(binding.storageDirectory, target, metadata, { createOnly: true });
}

async function removeAttachmentFileBound(binding: AttachmentDirectoryBinding, target: string): Promise<void> {
  await removeStoredEntry(binding.storageDirectory, target);
}

async function removeAttachmentDirectoryBound(binding: AttachmentDirectoryBinding): Promise<void> {
  await removeStoredTree(binding.storageDirectory, binding.directory);
}

async function readAllStoredMetadata(
  binding: AttachmentDirectoryBinding,
  sessionId: string,
  skippedIds: ReadonlySet<string> = new Set(),
): Promise<StoredSessionAttachment[]> {
  const names = await listStoredChildren(binding.storageDirectory, binding.directory);
  const metadata: StoredSessionAttachment[] = [];
  const seenOrdinals = new Set<number>();
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const fileId = name.slice(0, -".json".length);
    if (!isSafeStorageId(fileId)) throw new AttachmentStorageCorruptionError();
    if (skippedIds.has(fileId)) continue;
    const item = await readMetadataFile(binding.storageDirectory, path.join(binding.directory, name));
    if (
      item.id !== fileId ||
      item.sessionId !== sessionId ||
      (item.ordinal !== undefined && seenOrdinals.has(item.ordinal))
    ) {
      throw new AttachmentStorageCorruptionError();
    }
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
    metadata.provenance?.sourceId !== expectedRef.provenance?.sourceId ||
    metadata.provenance?.startSeconds !== expectedRef.provenance?.startSeconds ||
    metadata.provenance?.endSeconds !== expectedRef.provenance?.endSeconds ||
    JSON.stringify(metadata.provenance?.replacedIds) !== JSON.stringify(expectedRef.provenance?.replacedIds) ||
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
  return path.resolve(
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
  binding: AttachmentDirectoryBinding,
  sessionId: string,
  attachmentId: string,
): Promise<StoredSessionAttachment> {
  const target = attachmentMetadataPath(binding.directory, attachmentId);
  let metadata: StoredSessionAttachment;
  try {
    metadata = await readMetadataFile(binding.storageDirectory, target);
  } catch (error) {
    if (isMissingFileError(error)) throw new AttachmentNotFoundError();
    throw error;
  }
  if (metadata.id !== attachmentId || metadata.sessionId !== sessionId) {
    throw new AttachmentStorageCorruptionError();
  }
  return metadata;
}

async function readMetadataFile(storageDirectory: string, target: string): Promise<StoredSessionAttachment> {
  try {
    const parsed = JSON.parse(await readStoredText(storageDirectory, target)) as unknown;
    if (!isStoredSessionAttachment(parsed)) throw new AttachmentStorageCorruptionError();
    return cloneMetadata(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) throw new AttachmentStorageCorruptionError(error);
    throw error;
  }
}

async function readAndVerifyBlob(
  binding: AttachmentDirectoryBinding, metadata: StoredSessionAttachment, options: AttachmentReadOptions,
): Promise<Uint8Array> {
  try {
    const key = attachmentBlobPath(binding.directory, metadata.id);
    const entry = await storedEntry(binding.storageDirectory, key);
    if (!entry || entry.byteLength !== metadata.byteLength) throw new AttachmentStorageCorruptionError();
    const reader = await openStoredReader(binding.storageDirectory, key);
    try {
      const maximumBytes = metadata.kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES
        : metadata.kind === "audio" ? MAX_LOCAL_AUDIO_ATTACHMENT_BYTES : MAX_DOCUMENT_ATTACHMENT_BYTES;
      if (reader.entry.byteLength !== metadata.byteLength || reader.entry.byteLength > maximumBytes) throw new AttachmentStorageCorruptionError();
      const readFile = async () => {
        const bytes = new Uint8Array(reader.entry.byteLength);
        for (let offset = 0, index = 0; offset < bytes.length; index++) {
          throwIfAborted(options.signal);
          const chunk = reader.readChunk(index);
          bytes.set(chunk, offset);
          offset += chunk.length;
          if (index % 16 === 15) await yieldToHost(options.signal);
        }
        return bytes;
      };
      const bytes = options.readFile ? new Uint8Array(await options.readFile({ readFile })) : await readFile();
      await verifyBytes(metadata, bytes, options.signal);
      reader.readChunk(0);
      return bytes;
    } finally { reader.close(); }
  } catch (error) {
    if (isMissingFileError(error)) throw new AttachmentStorageCorruptionError(error);
    throw error;
  }
}

async function verifyBytes(
  metadata: StoredSessionAttachment,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (
    bytes.byteLength !== metadata.byteLength ||
    await hashAttachmentBytes(bytes, signal) !== metadata.sha256
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
        limits: localAudioLimits,
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
    "provenance",
  ]);
  const keys = Object.keys(record);
  const hasOrdinal = record.ordinal !== undefined;
  const audioFields = record.kind === "audio" ? 3 : 0;
  if (
    !keys.every((key) => allowed.has(key)) ||
    keys.length !== (hasOrdinal ? 9 : 8) + audioFields + (record.provenance === undefined ? 0 : 1) ||
    (record.provenance !== undefined && !isAttachmentProvenance(record.provenance, record.id)) ||
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
          ? MAX_LOCAL_AUDIO_ATTACHMENT_BYTES
          : MAX_DOCUMENT_ATTACHMENT_BYTES
    ) && (
      record.kind !== "audio" ||
      isAudioAttachmentInspection({
        mediaType: record.mediaType,
        durationSeconds: record.durationSeconds,
        sampleRate: record.sampleRate,
        channels: record.channels,
      }, localAudioLimits)
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
    dimensions.width <= MAX_IMAGE_ATTACHMENT_DIMENSION &&
    dimensions.height <= MAX_IMAGE_ATTACHMENT_DIMENSION &&
    dimensions.width * dimensions.height <= MAX_IMAGE_ATTACHMENT_PIXELS;
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

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function sanitizedAttachmentFileName(
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
    default: {
      const format = ATTACHMENT_FORMATS.find((format) => format.mediaType === mediaType)!;
      return `document.${format.extensions[0]}`;
    }
  }
}

export async function hashAttachmentBytes(
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
  provenance?: AttachmentProvenance;
  id: string;
  sessionId: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  ordinal: number;
  createdAt: string;
} & StoredAttachmentClassification): StoredSessionAttachment {
  const base = {
    id: input.id,
    sessionId: input.sessionId,
    fileName: input.fileName,
    byteLength: input.byteLength,
    sha256: input.sha256,
    createdAt: input.createdAt,
    ordinal: input.ordinal,
    ...(input.provenance ? { provenance: input.provenance } : {}),
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

function isUint8Array(value: unknown): value is Uint8Array {
  return utilTypes.isUint8Array(value);
}

async function prepareAttachmentSessionDirectory(storageDirectory: string, sessionId: string, create: boolean): Promise<boolean> {
  const exists = await storedTreeExists(storageDirectory, attachmentSessionDirectory(storageDirectory, sessionId));
  return create || exists;
}

async function captureAttachmentDirectoryBinding(storageDirectory: string, sessionId: string): Promise<AttachmentDirectoryBinding> {
  return { storageDirectory, directory: attachmentSessionDirectory(storageDirectory, sessionId) };
}

function cloneMetadata(metadata: StoredSessionAttachment): StoredSessionAttachment {
  return { ...metadata, ...(metadata.provenance ? { provenance: { ...metadata.provenance, replacedIds: [...metadata.provenance.replacedIds] } } : {}) };
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

function pendingMetadata(metadata: StoredSessionAttachment[], omittedAttachmentId?: string): StoredSessionAttachment[] {
  metadata = metadata.filter((item) => item.id !== omittedAttachmentId);
  const replaced = new Set(metadata.flatMap((item) => item.provenance?.replacedIds ?? []));
  return sortMetadata(metadata.filter((item) => !replaced.has(item.id)));
}
