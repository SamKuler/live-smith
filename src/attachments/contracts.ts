import { Buffer } from "node:buffer";

export const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 120;
export const MAX_OOXML_XML_PART_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_FILE_NAME_BYTES = 160;
export const MAX_PENDING_ATTACHMENT_COUNT = 4;
export const MAX_PENDING_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_PENDING_IMAGE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PENDING_AUDIO_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_PENDING_AUDIO_ATTACHMENT_COUNT = 2;

export const MAX_REQUEST_BINARY_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_REQUEST_BINARY_ATTACHMENT_COUNT = 4;
export const MAX_REQUEST_IMAGE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_REQUEST_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_AUDIO_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_REQUEST_AUDIO_ATTACHMENT_COUNT = 2;

export type AttachmentQuotaKind = "image" | "document" | "audio";

export interface AttachmentQuotaItem {
  kind: AttachmentQuotaKind;
  byteLength: number;
}

export type DocumentAttachmentMediaType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type AttachmentProcessingErrorCode =
  | "unsupported_type"
  | "encrypted_document"
  | "macro_enabled"
  | "archive_limit"
  | "invalid_document"
  | "invalid_audio"
  | "audio_duration_limit"
  | "profile_incompatible";

export class AttachmentProcessingError extends Error {
  constructor(
    public readonly code: AttachmentProcessingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentProcessingError";
  }
}

export function assertDocumentAttachmentBytesWithinLimit(
  bytes: unknown,
): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new AttachmentProcessingError(
      "invalid_document",
      "The attachment is not a valid supported document.",
    );
  }
  if (bytes.byteLength > MAX_DOCUMENT_ATTACHMENT_BYTES) {
    throw new AttachmentProcessingError(
      "archive_limit",
      "Document attachments may not exceed 20 MiB.",
    );
  }
}

export function attachmentQuotaIsWithinLimits(
  attachments: readonly AttachmentQuotaItem[],
): boolean {
  return attachmentQuotaIsWithinPolicy(attachments, {
    totalCount: MAX_PENDING_ATTACHMENT_COUNT,
    totalBytes: MAX_PENDING_ATTACHMENT_BYTES,
    imageBytes: MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
    documentBytes: MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
    audioBytes: MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
    audioCount: MAX_PENDING_AUDIO_ATTACHMENT_COUNT,
  });
}

export function attachmentRequestQuotaIsWithinLimits(
  attachments: readonly AttachmentQuotaItem[],
): boolean {
  return attachmentQuotaIsWithinPolicy(attachments, {
    totalCount: MAX_REQUEST_BINARY_ATTACHMENT_COUNT,
    totalBytes: MAX_REQUEST_BINARY_ATTACHMENT_BYTES,
    imageBytes: MAX_REQUEST_IMAGE_ATTACHMENT_BYTES,
    documentBytes: MAX_REQUEST_DOCUMENT_ATTACHMENT_BYTES,
    audioBytes: MAX_REQUEST_AUDIO_ATTACHMENT_BYTES,
    audioCount: MAX_REQUEST_AUDIO_ATTACHMENT_COUNT,
  });
}

interface AttachmentQuotaPolicy {
  totalCount: number;
  totalBytes: number;
  imageBytes: number;
  documentBytes: number;
  audioBytes: number;
  audioCount: number;
}

function attachmentQuotaIsWithinPolicy(
  attachments: readonly AttachmentQuotaItem[],
  policy: AttachmentQuotaPolicy,
): boolean {
  if (
    attachments.length === 0 ||
    attachments.length > policy.totalCount ||
    !attachments.every((attachment) =>
      (
        attachment.kind === "image" ||
        attachment.kind === "document" ||
        attachment.kind === "audio"
      ) &&
      Number.isInteger(attachment.byteLength) &&
      attachment.byteLength > 0 &&
      attachment.byteLength <= (
        attachment.kind === "image"
          ? MAX_IMAGE_ATTACHMENT_BYTES
          : attachment.kind === "document"
            ? MAX_DOCUMENT_ATTACHMENT_BYTES
            : MAX_AUDIO_ATTACHMENT_BYTES
      )
    )
  ) return false;

  let totalBytes = 0;
  let imageBytes = 0;
  let documentBytes = 0;
  let audioBytes = 0;
  let audioCount = 0;
  for (const attachment of attachments) {
    totalBytes += attachment.byteLength;
    if (attachment.kind === "image") imageBytes += attachment.byteLength;
    else if (attachment.kind === "document") documentBytes += attachment.byteLength;
    else {
      audioBytes += attachment.byteLength;
      audioCount += 1;
    }
  }
  return totalBytes <= policy.totalBytes &&
    imageBytes <= policy.imageBytes &&
    documentBytes <= policy.documentBytes &&
    audioBytes <= policy.audioBytes &&
    audioCount <= policy.audioCount;
}

export function isSafeAttachmentFileName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    value === value.replaceAll("\\", "/").split("/").at(-1) &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_ATTACHMENT_FILE_NAME_BYTES;
}

export function isLegacyAttachmentFileName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value === value.replaceAll("\\", "/").split("/").at(-1) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Safe, bounded display-only projection for current and legacy metadata. */
export function safeAttachmentDisplayFileName(value: unknown): string {
  if (typeof value !== "string") return "attachment";
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      "",
    )
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";

  let displayName = "";
  let byteLength = 0;
  for (const character of cleaned) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > MAX_ATTACHMENT_FILE_NAME_BYTES) break;
    displayName += character;
    byteLength += characterBytes;
  }
  return displayName || "attachment";
}
