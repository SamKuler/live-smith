import { Buffer } from "node:buffer";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import {
  assertDocumentAttachmentBytesWithinLimit,
  AttachmentProcessingError,
  type DocumentAttachmentMediaType,
} from "./contracts.js";
import { extractDocxText } from "./docx.js";
import { type OoxmlPackage, openOoxmlPackage } from "./ooxml.js";
import { extractPptxText } from "./pptx.js";
import { extractXlsxText } from "./xlsx.js";

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
  const ownedInput = ownedInspectionInput(input);
  const inspected = await inspectDocumentAttachment(ownedInput);
  if (inspected.mediaType === "application/pdf") {
    if (!ownedInput.nativePdfAllowed) {
      throw new AttachmentProcessingError(
        "profile_incompatible",
        "This Profile/API mode cannot read PDF attachments.",
      );
    }
    throwIfAborted(ownedInput.signal);
    return {
      type: "native_pdf",
      fileName: ownedInput.fileName,
      mediaType: "application/pdf",
      bytes: ownedInput.bytes,
    };
  }
  const officePackage = inspected.package;
  if (officePackage === undefined) throw invalidDocument();
  const extracted = await extractOfficeText(officePackage, ownedInput.signal);
  throwIfAborted(ownedInput.signal);
  return {
    type: "text",
    fileName: ownedInput.fileName,
    mediaType: inspected.mediaType,
    text: extracted.text,
    truncated: extracted.truncated,
  };
}

export async function classifyDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  signal?: AbortSignal;
}): Promise<DocumentAttachmentMediaType> {
  return (await inspectDocumentAttachment(ownedInspectionInput(input))).mediaType;
}

function ownedInspectionInput<T extends {
  bytes: Uint8Array;
  fileName: string;
  claimedMediaType?: string;
  signal?: AbortSignal;
}>(input: T): T {
  assertBinaryBytes(input.bytes);
  return { ...input, bytes: new Uint8Array(input.bytes) };
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
    if (await containsPdfEncryptToken(input.bytes, input.signal)) {
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

async function extractOfficeText(
  officePackage: OoxmlPackage,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const input = signal === undefined
    ? { officePackage }
    : { officePackage, signal };
  switch (officePackage.kind) {
    case "docx":
      return extractDocxText(input);
    case "xlsx":
      return extractXlsxText(input);
    case "pptx":
      return extractPptxText(input);
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

const pdfEncryptName = new Uint8Array([0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]);
const pdfScanYieldInterval = 256 * 1024;

async function containsPdfEncryptToken(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<boolean> {
  let nextYieldOffset = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    if (offset >= nextYieldOffset) {
      await yieldToHost(signal);
      nextYieldOffset = offset + pdfScanYieldInterval;
    }
    if (bytes[offset] !== 0x2f) continue;
    let cursor = offset + 1;
    let targetIndex = 0;
    while (cursor < bytes.byteLength && !isPdfNameDelimiterByte(bytes[cursor]!)) {
      let decoded = bytes[cursor]!;
      let consumed = 1;
      if (
        decoded === 0x23 &&
        cursor + 2 < bytes.byteLength &&
        isAsciiHexByte(bytes[cursor + 1]!) &&
        isAsciiHexByte(bytes[cursor + 2]!)
      ) {
        decoded = (asciiHexValue(bytes[cursor + 1]!) << 4) |
          asciiHexValue(bytes[cursor + 2]!);
        consumed = 3;
      }
      if (
        targetIndex >= pdfEncryptName.byteLength ||
        decoded !== pdfEncryptName[targetIndex]
      ) break;
      targetIndex += 1;
      cursor += consumed;
      if (targetIndex === pdfEncryptName.byteLength) {
        if (
          cursor === bytes.byteLength ||
          isPdfNameDelimiterByte(bytes[cursor]!)
        ) return true;
        break;
      }
    }
  }
  return false;
}

function isPdfNameDelimiterByte(value: number): boolean {
  return value === 0x00 ||
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20 ||
    value === 0x28 ||
    value === 0x29 ||
    value === 0x3c ||
    value === 0x3e ||
    value === 0x5b ||
    value === 0x5d ||
    value === 0x7b ||
    value === 0x7d ||
    value === 0x2f ||
    value === 0x25;
}

function isAsciiHexByte(value: number): boolean {
  return (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x46) ||
    (value >= 0x61 && value <= 0x66);
}

function asciiHexValue(value: number): number {
  if (value <= 0x39) return value - 0x30;
  return (value & 0xdf) - 0x41 + 10;
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
