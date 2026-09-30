import { throwIfAborted } from "../runtime/host.js";
import { assertDocumentAttachmentBytesWithinLimit, AttachmentProcessingError } from "./contracts.js";
import { type ExtractedDocumentText } from "./document-text.js";
import { openOdfPackage, extractOdfText, type OdfMediaType } from "./odf.js";
import { extractRtfText } from "./rich-rtf.js";
import { inspectBoundedZipEntryNames } from "./ooxml-zip.js";
import { classifyLegacyDocument, extractLegacyDocumentText, type LegacyDocumentMediaType } from "./legacy-document.js";

export type RichDocumentMediaType = "application/rtf" | OdfMediaType | LegacyDocumentMediaType;

export async function classifyRichDocumentAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
}): Promise<RichDocumentMediaType | undefined> {
  assertDocumentAttachmentBytesWithinLimit(input.bytes);
  throwIfAborted(input.signal);
  if (isRtf(input.bytes)) return "application/rtf";
  if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) {
    const names = await inspectBoundedZipEntryNames(input.bytes, input.signal);
    if (!names.includes("mimetype")) return undefined;
    return (await openOdfPackage(input.bytes, input.signal))?.mediaType;
  }
  return classifyLegacyDocument(input.bytes, input.signal);
}

export async function extractRichDocumentText(input: {
  bytes: Uint8Array;
  fileName: string;
  mediaType: RichDocumentMediaType;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  assertDocumentAttachmentBytesWithinLimit(input.bytes);
  throwIfAborted(input.signal);
  if (input.mediaType === "application/rtf") return extractRtfText(input.bytes, input.signal);
  if (input.mediaType === "application/msword" || input.mediaType === "application/vnd.ms-excel" || input.mediaType === "application/vnd.ms-powerpoint") {
    return extractLegacyDocumentText(input.bytes, input.mediaType, input.signal);
  }
  const document = await openOdfPackage(input.bytes, input.signal);
  if (!document || document.mediaType !== input.mediaType) {
    throw new AttachmentProcessingError("invalid_document", "The document content does not match its OpenDocument format.");
  }
  return extractOdfText(document, input.signal);
}

function isRtf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66;
}
