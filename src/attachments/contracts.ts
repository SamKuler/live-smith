export const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_OOXML_XML_PART_BYTES = 8 * 1024 * 1024;

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
