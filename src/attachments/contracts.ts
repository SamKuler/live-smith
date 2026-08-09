import { Buffer } from "node:buffer";

export const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_OOXML_XML_PART_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_FILE_NAME_BYTES = 160;
export const MAX_PENDING_ATTACHMENT_COUNT = 4;
export const MAX_PENDING_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PENDING_IMAGE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

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
  if (
    attachments.length === 0 ||
    attachments.length > MAX_PENDING_ATTACHMENT_COUNT ||
    !attachments.every((attachment) =>
      (attachment.kind === "image" || attachment.kind === "document") &&
      Number.isInteger(attachment.byteLength) &&
      attachment.byteLength > 0 &&
      attachment.byteLength <= (
        attachment.kind === "image"
          ? MAX_IMAGE_ATTACHMENT_BYTES
          : MAX_DOCUMENT_ATTACHMENT_BYTES
      )
    )
  ) return false;

  let totalBytes = 0;
  let imageBytes = 0;
  let documentBytes = 0;
  for (const attachment of attachments) {
    totalBytes += attachment.byteLength;
    if (attachment.kind === "image") imageBytes += attachment.byteLength;
    else documentBytes += attachment.byteLength;
  }
  return totalBytes <= MAX_PENDING_ATTACHMENT_BYTES &&
    imageBytes <= MAX_PENDING_IMAGE_ATTACHMENT_BYTES &&
    documentBytes <= MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES;
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
