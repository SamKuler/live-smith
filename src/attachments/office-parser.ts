import { throwIfAborted } from "../runtime/host.js";
import { runDocumentParserWorker } from "../runtime/document-parser.js";
import { assertDocumentAttachmentBytesWithinLimit, type DocumentAttachmentMediaType } from "./contracts.js";
import { MAX_DOCUMENT_TEXT_CHARACTERS, type ExtractedDocumentText } from "./document-text.js";

declare const __LIVE_SMITH_DOCUMENT_PARSER_SCRIPT__: string;

export type OfficeParserFileType = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";

export function officeParserFileType(mediaType: DocumentAttachmentMediaType): OfficeParserFileType | undefined {
  const formats: Partial<Record<DocumentAttachmentMediaType, OfficeParserFileType>> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
  };
  return formats[mediaType];
}

export async function extractOfficeDocumentText(input: {
  bytes: Uint8Array;
  fileType: OfficeParserFileType;
  canonicalOdfContent?: string;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  assertDocumentAttachmentBytesWithinLimit(input.bytes);
  throwIfAborted(input.signal);
  return runDocumentParserWorker({
    source: typeof __LIVE_SMITH_DOCUMENT_PARSER_SCRIPT__ === "string"
      ? __LIVE_SMITH_DOCUMENT_PARSER_SCRIPT__
      : (await import("./office-parser-worker-url.js")).officeParserWorkerUrl,
    job: { bytes: input.bytes, fileType: input.fileType, maxCharacters: MAX_DOCUMENT_TEXT_CHARACTERS,
      canonicalOdfContent: input.canonicalOdfContent },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
