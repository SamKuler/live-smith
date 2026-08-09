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
  removeFileDurably,
  withStorageTransaction,
  writeBytesAtomically,
  writeJsonAtomically,
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

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING_ATTACHMENT_COUNT = 8;
export const MAX_PENDING_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const attachmentsDirectoryName = "live-smith-attachments";
const memoryAttachments = new Map<string, Map<string, MemoryAttachment>>();

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

export async function saveSessionAttachment(
  storageDirectory: string | undefined,
  sessionId: string,
  input: { fileName: string; bytes: Uint8Array },
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

  const bytes = new Uint8Array(input.bytes);
  const metadata: StoredSessionAttachment = {
    id: createStorageId("attachment"),
    sessionId,
    kind: "image",
    fileName: sanitizedFileName(input.fileName, mediaType),
    mediaType,
    byteLength: bytes.byteLength,
    sha256: hashBytes(bytes),
    createdAt: new Date().toISOString(),
  };

  return withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      const sessionAttachments = memoryAttachments.get(sessionId) ?? new Map();
      if (sessionAttachments.has(metadata.id)) {
        throw new AttachmentStorageCorruptionError();
      }
      sessionAttachments.set(metadata.id, { metadata, bytes });
      memoryAttachments.set(sessionId, sessionAttachments);
      return cloneMetadata(metadata);
    }

    const directory = attachmentSessionDirectory(storageDirectory, sessionId);
    const blobTarget = attachmentBlobPath(directory, metadata.id);
    const metadataTarget = attachmentMetadataPath(directory, metadata.id);
    await ensurePrivateDirectory(directory);
    await writeBytesAtomically(blobTarget, bytes);
    try {
      await writeJsonAtomically(metadataTarget, metadata);
    } catch (error) {
      if (!isStorageCommitOutcomeUnknownError(error)) {
        await removeFileDurably(blobTarget).catch(() => undefined);
      }
      throw error;
    }
    return cloneMetadata(metadata);
  });
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

  const directory = attachmentSessionDirectory(storageDirectory, sessionId);
  let names: string[];
  try {
    await ensurePrivateDirectory(directory);
    names = await fs.readdir(directory);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

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
    await readAndVerifyBlob(directory, item);
    metadata.push(item);
  }
  return sortMetadata(metadata);
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

  const directory = attachmentSessionDirectory(storageDirectory, sessionId);
  const metadata = await readStoredMetadata(directory, sessionId, attachmentId);
  return readAndVerifyBlob(directory, metadata);
}

export async function deleteSessionAttachment(
  storageDirectory: string | undefined,
  sessionId: string,
  attachmentId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  requireSafeStorageId(attachmentId, "Attachment ID");
  await withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      const sessionAttachments = memoryAttachments.get(sessionId);
      if (!sessionAttachments?.delete(attachmentId)) {
        throw new AttachmentNotFoundError();
      }
      if (sessionAttachments.size === 0) memoryAttachments.delete(sessionId);
      return;
    }

    const directory = attachmentSessionDirectory(storageDirectory, sessionId);
    const metadata = await readStoredMetadata(directory, sessionId, attachmentId);
    await readAndVerifyBlob(directory, metadata);
    await removeFileDurably(attachmentMetadataPath(directory, attachmentId));
    await removeFileDurably(attachmentBlobPath(directory, attachmentId));
  });
}

export async function deleteSessionAttachments(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  await withStorageTransaction(storageDirectory, async () => {
    if (!storageDirectory) {
      memoryAttachments.delete(sessionId);
      return;
    }

    const directory = attachmentSessionDirectory(storageDirectory, sessionId);
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  });
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
    detectImageMediaType(bytes) !== metadata.mediaType
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
