import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
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

export interface SessionAttachmentRef {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mediaType: AttachmentMediaType;
  byteLength: number;
  sha256: string;
}

export interface StoredSessionAttachment extends SessionAttachmentRef {
  sessionId: string;
  createdAt: string;
}

interface MemoryAttachment {
  metadata: StoredSessionAttachment;
  bytes: Uint8Array;
}

interface AttachmentSaveOptions {
  /** Test seam for proving collision handling; production always uses createStorageId. */
  createId?: () => string;
}

export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_PENDING_ATTACHMENT_COUNT = 4;
export const MAX_PENDING_ATTACHMENT_BYTES = 16 * 1024 * 1024;

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

export class UnsupportedAttachmentError extends Error {
  constructor() {
    super("Only PNG, JPEG, and WebP image attachments are supported.");
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
  input: { fileName: string; bytes: Uint8Array },
  options: AttachmentSaveOptions = {},
): Promise<StoredSessionAttachment> {
  requireSafeStorageId(sessionId, "Session ID");
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError("Attachment bytes must be binary data.");
  }
  if (input.bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError();
  }
  const mediaType = detectImageMediaType(input.bytes);
  if (!mediaType) throw new UnsupportedAttachmentError();
  if (!validImageDimensions(input.bytes, mediaType)) {
    throw new UnsupportedAttachmentError();
  }

  const bytes = new Uint8Array(input.bytes);
  const fileName = sanitizedFileName(input.fileName, mediaType);
  const sha256 = hashBytes(bytes);

  return withAttachmentStorageBoundary(() =>
    withStorageTransaction(storageDirectory, async () => {
      if (!storageDirectory) {
        const sessionAttachments = memoryAttachments.get(sessionId) ?? new Map();
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const id = nextAttachmentId(options);
          if (sessionAttachments.has(id)) continue;
          const metadata = attachmentMetadata({
            id,
            sessionId,
            fileName,
            mediaType,
            bytes,
            sha256,
          });
          sessionAttachments.set(id, { metadata, bytes });
          memoryAttachments.set(sessionId, sessionAttachments);
          return cloneMetadata(metadata);
        }
        throw new Error("Could not allocate a unique attachment ID.");
      }

      const directory = attachmentSessionDirectory(storageDirectory, sessionId);
      await prepareAttachmentSessionDirectory(storageDirectory, sessionId, true);
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const id = nextAttachmentId(options);
        const metadata = attachmentMetadata({
          id,
          sessionId,
          fileName,
          mediaType,
          bytes,
          sha256,
        });
        const blobTarget = attachmentBlobPath(directory, id);
        const metadataTarget = attachmentMetadataPath(directory, id);
        try {
          await writeBytesAtomicallyCreateOnly(blobTarget, bytes);
        } catch (error) {
          if (isAlreadyExistsError(error)) continue;
          throw error;
        }
        try {
          await writeJsonAtomicallyCreateOnly(metadataTarget, metadata);
        } catch (error) {
          if (!isStorageCommitOutcomeUnknownError(error)) {
            await removeFileDurably(blobTarget);
          }
          if (isAlreadyExistsError(error)) continue;
          throw error;
        }
        return cloneMetadata(metadata);
      }
      throw new Error("Could not allocate a unique attachment ID.");
    })
  );
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
    const directory = attachmentSessionDirectory(storageDirectory, sessionId);
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      return [];
    }
    const names = await fs.readdir(directory);
    const metadata: StoredSessionAttachment[] = [];
    const seenIds = new Set<string>();
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const fileId = name.slice(0, -".json".length);
      if (!isSafeStorageId(fileId)) throw new AttachmentStorageCorruptionError();
      const item = await readMetadataFile(path.join(directory, name));
      if (
        item.id !== fileId ||
        item.sessionId !== sessionId ||
        seenIds.has(item.id)
      ) {
        throw new AttachmentStorageCorruptionError();
      }
      seenIds.add(item.id);
      metadata.push(item);
    }
    return sortMetadata(metadata);
  });
}

export async function readSessionAttachmentBytes(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(attachmentId, "Attachment ID");
  if (!storageDirectory) {
    const item = memoryAttachments.get(sessionId)?.get(attachmentId);
    if (!item) throw new AttachmentNotFoundError();
    verifyBytes(item.metadata, item.bytes);
    return new Uint8Array(item.bytes);
  }

  return withAttachmentStorageBoundary(async () => {
    const directory = attachmentSessionDirectory(storageDirectory, sessionId);
    if (!await prepareAttachmentSessionDirectory(storageDirectory, sessionId, false)) {
      throw new AttachmentNotFoundError();
    }
    const metadata = await readStoredMetadata(directory, sessionId, attachmentId);
    return readAndVerifyBlob(directory, metadata);
  });
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
      await readStoredMetadata(directory, sessionId, attachmentId);
      await removeFileDurably(attachmentBlobPath(directory, attachmentId));
      await removeFileDurably(attachmentMetadataPath(directory, attachmentId));
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
      await assertAttachmentRootIsSafe(storageDirectory);
      await assertExistingDirectoryIsSafe(directory);
      await removeDirectoryDurably(directory);
    })
  );
}

export function isImageAttachmentMediaType(
  mediaType: AttachmentMediaType,
): mediaType is ImageAttachmentMediaType {
  return mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/webp";
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
  try {
    await assertRegularFile(target);
    await ensurePrivateFile(target);
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as unknown;
    if (!isStoredSessionAttachment(parsed)) {
      throw new AttachmentStorageCorruptionError();
    }
    return cloneMetadata(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AttachmentStorageCorruptionError(error);
    }
    throw error;
  }
}

async function readAndVerifyBlob(
  directory: string,
  metadata: StoredSessionAttachment,
): Promise<Uint8Array> {
  try {
    const target = attachmentBlobPath(directory, metadata.id);
    await assertRegularFile(target);
    await ensurePrivateFile(target);
    const bytes = new Uint8Array(await fs.readFile(target));
    verifyBytes(metadata, bytes);
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
  }
}

function verifyBytes(
  metadata: StoredSessionAttachment,
  bytes: Uint8Array,
): void {
  if (
    bytes.byteLength !== metadata.byteLength ||
    hashBytes(bytes) !== metadata.sha256 ||
    detectImageMediaType(bytes) !== metadata.mediaType ||
    !validImageDimensions(bytes, metadata.mediaType)
  ) {
    throw new AttachmentStorageCorruptionError();
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
  ]);
  return Object.keys(record).every((key) => allowed.has(key)) &&
    Object.keys(record).length === allowed.size &&
    isSafeStorageId(record.id) &&
    isSafeStorageId(record.sessionId) &&
    record.kind === "image" &&
    typeof record.fileName === "string" &&
    record.fileName.length > 0 &&
    record.fileName.length <= 160 &&
    isImageMediaType(record.mediaType) &&
    Number.isInteger(record.byteLength) &&
    (record.byteLength as number) > 0 &&
    (record.byteLength as number) <= MAX_IMAGE_ATTACHMENT_BYTES &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    typeof record.createdAt === "string";
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

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function sanitizedFileName(
  value: string,
  mediaType: ImageAttachmentMediaType,
): string {
  const leaf = String(value).replaceAll("\\", "/").split("/").at(-1) ?? "";
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (sanitized) return sanitized.slice(0, 160);
  return mediaType === "image/png"
    ? "image.png"
    : mediaType === "image/jpeg"
      ? "image.jpg"
      : "image.webp";
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
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
  mediaType: ImageAttachmentMediaType;
  bytes: Uint8Array;
  sha256: string;
}): StoredSessionAttachment {
  return {
    id: input.id,
    sessionId: input.sessionId,
    kind: "image",
    fileName: input.fileName,
    mediaType: input.mediaType,
    byteLength: input.bytes.byteLength,
    sha256: input.sha256,
    createdAt: new Date().toISOString(),
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}

async function withAttachmentStorageBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AttachmentTooLargeError ||
      error instanceof UnsupportedAttachmentError ||
      error instanceof AttachmentNotFoundError ||
      error instanceof AttachmentStorageCorruptionError ||
      error instanceof AttachmentStorageAccessError ||
      isStorageCommitOutcomeUnknownError(error)
    ) {
      throw error;
    }
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
      await ensurePrivateDirectory(target);
    } else {
      await ensurePrivateDirectory(target);
    }
  }
  return true;
}

async function assertAttachmentRootIsSafe(
  storageDirectory: string,
): Promise<void> {
  await assertExistingDirectoryIsSafe(
    path.join(storageDirectory, attachmentsDirectoryName),
  );
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

async function assertRegularFile(target: string): Promise<void> {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AttachmentStorageCorruptionError();
  }
}

function cloneMetadata(metadata: StoredSessionAttachment): StoredSessionAttachment {
  return { ...metadata };
}

function sortMetadata(
  metadata: StoredSessionAttachment[],
): StoredSessionAttachment[] {
  return metadata.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}
