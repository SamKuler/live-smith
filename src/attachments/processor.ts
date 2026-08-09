import { Buffer } from "node:buffer";

import { throwIfAborted } from "../runtime/host.js";
import {
  assertDocumentAttachmentBytesWithinLimit,
  AttachmentProcessingError,
  type DocumentAttachmentMediaType,
} from "./contracts.js";
import { type OoxmlPackage, openOoxmlPackage } from "./ooxml.js";

export {
  AttachmentProcessingError,
  type AttachmentProcessingErrorCode,
  type DocumentAttachmentMediaType,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
} from "./contracts.js";

export type ProcessedAttachment =
  | {
      type: "text";
      fileName: string;
      mediaType: DocumentAttachmentMediaType;
      text: string;
      truncated: boolean;
    }
  | {
      type: "native_pdf";
      fileName: string;
      mediaType: "application/pdf";
      bytes: Uint8Array;
    };

export type PreliminaryAttachmentContainer = "pdf" | "zip_candidate";

export function sniffAttachmentContainer(
  bytes: Uint8Array,
  _fileName: string,
): PreliminaryAttachmentContainer {
  assertBinaryBytes(bytes);
  if (isPdfHeader(bytes)) {
    assertValidPdf(bytes);
    return "pdf";
  }
  if (isZipHeader(bytes)) return "zip_candidate";
  throw new AttachmentProcessingError(
    "invalid_document",
    "The attachment is not a supported document.",
  );
}

export async function processAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  nativePdfAllowed: boolean;
  signal?: AbortSignal;
}): Promise<ProcessedAttachment> {
  throwIfAborted(input.signal);
  const inspected = await inspectDocumentAttachment(input);
  if (inspected.mediaType === "application/pdf") {
    if (!input.nativePdfAllowed) {
      throw new AttachmentProcessingError(
        "profile_incompatible",
        "This Profile/API mode cannot read PDF attachments.",
      );
    }
    throwIfAborted(input.signal);
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

export async function classifyDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  signal?: AbortSignal;
}): Promise<DocumentAttachmentMediaType> {
  return (await inspectDocumentAttachment(input)).mediaType;
}

async function inspectDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  signal?: AbortSignal;
}): Promise<{
  mediaType: DocumentAttachmentMediaType;
  package?: OoxmlPackage;
}> {
  throwIfAborted(input.signal);
  const container = sniffAttachmentContainer(input.bytes, input.fileName);
  if (container === "pdf") {
    if (containsPdfEncryptToken(input.bytes)) {
      throw new AttachmentProcessingError(
        "encrypted_document",
        "Encrypted PDF documents are not supported.",
      );
    }
    return { mediaType: "application/pdf" };
  }

  const officePackage = await openOoxmlPackage(input.bytes, input.signal);
  const mediaType = ooxmlMediaType(officePackage.kind);
  return { mediaType, package: officePackage };
}

function ooxmlMediaType(kind: OoxmlPackage["kind"]): DocumentAttachmentMediaType {
  switch (kind) {
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
}

const pdfWhitespace = "\\x00\\x09\\x0a\\x0c\\x0d\\x20";
const validPdfTrailer = new RegExp(
  `^%%EOF(?:[${pdfWhitespace}]|%[^\\r\\n]*(?:\\r\\n?|\\n|$))*$`,
);

function assertBinaryBytes(bytes: Uint8Array): void {
  assertDocumentAttachmentBytesWithinLimit(bytes);
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
