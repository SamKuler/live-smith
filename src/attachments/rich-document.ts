import { assertDocumentAttachmentBytesWithinLimit, AttachmentProcessingError } from "./contracts.js";
import type { ExtractedDocumentText } from "./document-text.js";
import { throwIfAborted } from "../runtime/host.js";
import { openOdfPackage, type OdfMediaType } from "./odf.js";
import { extractOfficeDocumentText, officeParserFileType } from "./office-parser.js";
import { inspectBoundedZipEntryNames } from "./ooxml-zip.js";
import { extractRtfText } from "./rich-rtf.js";

export type RichDocumentMediaType = "application/rtf" | OdfMediaType;

export async function classifyRichDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
}): Promise<RichDocumentMediaType | undefined> {
  return (await inspectRichDocumentAttachment(input))?.mediaType;
}

export async function inspectRichDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
}): Promise<{ mediaType: RichDocumentMediaType; canonicalOdfContent?: string } | undefined> {
  assertDocumentAttachmentBytesWithinLimit(input.bytes);
  throwIfAborted(input.signal);
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => input.bytes[index] === value)) {
    throw new AttachmentProcessingError("unsupported_type", "Legacy Office attachments are unsupported. Save this file as DOCX, XLSX or PPTX.");
  }
  if (input.bytes[0] === 0x7b && input.bytes[1] === 0x5c && input.bytes[2] === 0x72 && input.bytes[3] === 0x74 && input.bytes[4] === 0x66) {
    return { mediaType: "application/rtf" };
  }
  if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) {
    const names = await inspectBoundedZipEntryNames(input.bytes, input.signal);
    if (!names.includes("mimetype")) return undefined;
    const document = await openOdfPackage(input.bytes, input.signal);
    return document === undefined ? undefined : {
      mediaType: document.mediaType, canonicalOdfContent: document.canonicalContent,
    };
  }
  return undefined;
}

export async function extractRichDocumentText(input: {
  bytes: Uint8Array;
  fileName: string;
  mediaType: RichDocumentMediaType;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  const inspected = await inspectRichDocumentAttachment(input);
  if (inspected?.mediaType !== input.mediaType) {
    throw new AttachmentProcessingError("invalid_document", "The document content does not match its format.");
  }
  if (input.mediaType === "application/rtf") return extractRtfText(input.bytes, input.signal);
  return extractOfficeDocumentText({ bytes: input.bytes, fileType: officeParserFileType(input.mediaType)!,
    ...(inspected.canonicalOdfContent ? { canonicalOdfContent: inspected.canonicalOdfContent } : {}),
    ...(input.signal ? { signal: input.signal } : {}) });
}
