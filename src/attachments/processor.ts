import { Buffer } from "node:buffer";

import type { AttachmentMediaType } from "../storage/attachments.js";

export type ProcessedAttachment =
  | {
      type: "text";
      fileName: string;
      mediaType: AttachmentMediaType;
      text: string;
      truncated: boolean;
    }
  | {
      type: "native_pdf";
      fileName: string;
      mediaType: "application/pdf";
      bytes: Uint8Array;
    };

export type AttachmentProcessingErrorCode =
  | "unsupported_type"
  | "encrypted_document"
  | "macro_enabled"
  | "archive_limit"
  | "invalid_document";

export class AttachmentProcessingError extends Error {
  constructor(
    public readonly code: AttachmentProcessingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentProcessingError";
  }
}

export type SniffedAttachmentType = "application/pdf" | "application/zip";

export function sniffAttachmentType(
  bytes: Uint8Array,
  _fileName: string,
): SniffedAttachmentType {
  assertBinaryBytes(bytes);
  if (isPdfHeader(bytes)) {
    assertValidPdf(bytes);
    return "application/pdf";
  }
  if (isZipHeader(bytes)) return "application/zip";
  throw new AttachmentProcessingError(
    "invalid_document",
    "The attachment is not a supported document.",
  );
}

export async function processAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  mediaType?: AttachmentMediaType;
  nativePdfAllowed: boolean;
}): Promise<ProcessedAttachment> {
  const sniffed = sniffAttachmentType(input.bytes, input.fileName);
  if (sniffed === "application/pdf") {
    if (input.mediaType !== undefined && input.mediaType !== "application/pdf") {
      throw invalidDocument();
    }
    if (containsPdfEncryptToken(input.bytes)) {
      throw new AttachmentProcessingError(
        "encrypted_document",
        "Encrypted PDF documents are not supported.",
      );
    }
    if (!input.nativePdfAllowed) {
      throw new AttachmentProcessingError(
        "unsupported_type",
        "This Profile/API mode cannot read PDF attachments.",
      );
    }
    return {
      type: "native_pdf",
      fileName: input.fileName,
      mediaType: "application/pdf",
      bytes: new Uint8Array(input.bytes),
    };
  }
  throw new AttachmentProcessingError(
    "unsupported_type",
    "The attachment is not a supported Office document.",
  );
}

const pdfWhitespace = "\\x00\\x09\\x0a\\x0c\\x0d\\x20";
const validPdfTrailer = new RegExp(
  `^%%EOF(?:[${pdfWhitespace}]|%[^\\r\\n]*(?:\\r\\n?|\\n|$))*$`,
);

function assertBinaryBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw invalidDocument();
  }
}

function isPdfHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && ascii(bytes, 0, 5) === "%PDF-";
}

function isZipHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = unsigned32LittleEndian(bytes, 0);
  return signature === 0x04034b50 ||
    signature === 0x06054b50 ||
    signature === 0x08074b50;
}

function assertValidPdf(bytes: Uint8Array): void {
  const header = ascii(bytes, 0, Math.min(bytes.byteLength, 16));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:[\x00\x09\x0a\x0c\x0d\x20]|$)/.test(header)) {
    throw invalidDocument();
  }
  const tailOffset = Math.max(0, bytes.byteLength - 1_024);
  const tail = latin1(bytes.subarray(tailOffset));
  const eofOffset = tail.lastIndexOf("%%EOF");
  if (eofOffset < 0 || !validPdfTrailer.test(tail.slice(eofOffset))) {
    throw invalidDocument();
  }
}

function containsPdfEncryptToken(bytes: Uint8Array): boolean {
  const source = latin1(bytes);
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] !== "/") continue;
    let decoded = "";
    for (let cursor = offset + 1; cursor < source.length; cursor += 1) {
      const character = source[cursor]!;
      if (isPdfNameDelimiter(character)) break;
      if (
        character === "#" &&
        cursor + 2 < source.length &&
        /^[0-9a-f]{2}$/i.test(source.slice(cursor + 1, cursor + 3))
      ) {
        decoded += String.fromCharCode(Number.parseInt(
          source.slice(cursor + 1, cursor + 3),
          16,
        ));
        cursor += 2;
      } else {
        decoded += character;
      }
      if (decoded.length > "Encrypt".length) break;
    }
    if (decoded === "Encrypt") return true;
  }
  return false;
}

function isPdfNameDelimiter(value: string): boolean {
  return /[\x00\x09\x0a\x0c\x0d\x20()<>\[\]{}/%]/.test(value);
}

function invalidDocument(): AttachmentProcessingError {
  return new AttachmentProcessingError(
    "invalid_document",
    "The attachment is not a valid supported document.",
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function unsigned32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}
