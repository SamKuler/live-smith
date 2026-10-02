import { Buffer } from "node:buffer";
import { types } from "node:util";

export const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_DIMENSION = 16_384;
export const MAX_IMAGE_ATTACHMENT_PIXELS = 100_000_000;
export const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 120;
export const MAX_MIDI_ATTACHMENT_BYTES = 8 * 1024 * 1024;
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

export type DocumentAttachmentMediaType = Extract<
  (typeof ATTACHMENT_FORMATS)[number], { kind: "document" }
>["mediaType"] | HistoricalDocumentMediaType;

export type AttachmentMediaType = (typeof ATTACHMENT_FORMATS)[number]["mediaType"] | HistoricalDocumentMediaType;

// Historical Session references stay readable after ingestion support is removed.
const HISTORICAL_DOCUMENT_FORMATS = [
  { kind: "document", mediaType: "application/msword", label: "DOC" },
  { kind: "document", mediaType: "application/vnd.ms-excel", label: "XLS" },
  { kind: "document", mediaType: "application/vnd.ms-powerpoint", label: "PPT" },
] as const;
type HistoricalDocumentMediaType = (typeof HISTORICAL_DOCUMENT_FORMATS)[number]["mediaType"];

export function isHistoricalDocumentMediaType(value: unknown): value is HistoricalDocumentMediaType {
  return HISTORICAL_DOCUMENT_FORMATS.some((format) => format.mediaType === value);
}

export const ATTACHMENT_FORMATS = [
  { kind: "image", mediaType: "image/png", extensions: ["png"], label: "PNG" },
  { kind: "image", mediaType: "image/jpeg", extensions: ["jpg", "jpeg"], label: "JPEG" },
  { kind: "image", mediaType: "image/webp", extensions: ["webp"], label: "WebP" },
  { kind: "document", mediaType: "application/pdf", extensions: ["pdf"], label: "PDF" },
  { kind: "document", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: ["docx"], label: "DOCX" },
  { kind: "document", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: ["xlsx"], label: "XLSX" },
  { kind: "document", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: ["pptx"], label: "PPTX" },
  { kind: "document", mediaType: "text/plain", extensions: ["txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "htm", "log"], label: "Text" },
  { kind: "document", mediaType: "audio/midi", extensions: ["mid", "midi"], label: "MIDI" },
  { kind: "document", mediaType: "application/rtf", extensions: ["rtf"], label: "RTF" },
  { kind: "document", mediaType: "application/vnd.oasis.opendocument.text", extensions: ["odt"], label: "ODT" },
  { kind: "document", mediaType: "application/vnd.oasis.opendocument.spreadsheet", extensions: ["ods"], label: "ODS" },
  { kind: "document", mediaType: "application/vnd.oasis.opendocument.presentation", extensions: ["odp"], label: "ODP" },
  { kind: "audio", mediaType: "audio/wav", extensions: ["wav", "wave"], label: "WAV" },
  { kind: "audio", mediaType: "audio/mpeg", extensions: ["mp3", "mpga"], label: "MP3" },
] as const satisfies readonly {
  kind: AttachmentQuotaKind;
  mediaType: string;
  extensions: readonly string[];
  label: string;
}[];

export const ATTACHMENT_IMPORT_FORMATS = [
  { kind: "image", extensions: ["gif", "bmp", "dib", "svg", "avif", "tif", "tiff", "heic", "heif", "ico", "jp2", "jxl"], mediaTypes: ["image/gif", "image/bmp", "image/x-ms-bmp", "image/svg+xml", "image/avif", "image/tiff", "image/heic", "image/heif", "image/x-icon", "image/jp2", "image/jxl"], conversion: "image" },
  { kind: "audio", extensions: ["flac", "ogg", "oga", "opus", "m4a", "m4b", "aac", "aif", "aiff", "aifc", "webm", "weba", "mp4"], mediaTypes: ["audio/flac", "audio/x-flac", "audio/ogg", "application/ogg", "audio/opus", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/aiff", "audio/x-aiff", "audio/webm", "video/webm", "video/mp4"], conversion: "audio" },
] as const;

/** Stored references and display labels include formats retired from ingestion. */
export const ATTACHMENT_REFERENCE_FORMATS = [...ATTACHMENT_FORMATS, ...HISTORICAL_DOCUMENT_FORMATS] as const;

export function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return ATTACHMENT_REFERENCE_FORMATS.some((format) => format.mediaType === value);
}

export function attachmentMediaTypeMatchesKind(kind: unknown, mediaType: unknown): boolean {
  return ATTACHMENT_REFERENCE_FORMATS.some((format) => format.kind === kind && format.mediaType === mediaType);
}

export type AttachmentProcessingErrorCode =
  | "unsupported_type"
  | "encrypted_document"
  | "macro_enabled"
  | "archive_limit"
  | "invalid_document"
  | "invalid_midi"
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
  if (!types.isUint8Array(bytes) || bytes.byteLength === 0) {
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
