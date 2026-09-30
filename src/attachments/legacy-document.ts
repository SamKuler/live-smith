import { AttachmentProcessingError } from "./contracts.js";
import { type ExtractedDocumentText } from "./document-text.js";
import { isCompoundDocument, openCompoundDocument, type CompoundDocument } from "./compound.js";
import { extractLegacyWordText } from "./legacy-doc.js";
import { extractLegacyExcelText } from "./legacy-xls.js";
import { extractLegacyPowerPointText } from "./legacy-ppt.js";

export type LegacyDocumentMediaType = "application/msword" | "application/vnd.ms-excel" | "application/vnd.ms-powerpoint";

export async function classifyLegacyDocument(bytes: Uint8Array, signal?: AbortSignal): Promise<LegacyDocumentMediaType | undefined> {
  if (!isCompoundDocument(bytes)) return undefined;
  return identify(await openCompoundDocument(bytes, signal));
}

export async function extractLegacyDocumentText(bytes: Uint8Array, mediaType: LegacyDocumentMediaType, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  const document = await openCompoundDocument(bytes, signal);
  if (identify(document) !== mediaType) throw new AttachmentProcessingError("invalid_document", "The compound document does not match its Office format.");
  if (mediaType === "application/msword") return extractLegacyWordText(document, signal);
  if (mediaType === "application/vnd.ms-excel") return extractLegacyExcelText(document, signal);
  return extractLegacyPowerPointText(document, signal);
}

function identify(document: CompoundDocument): LegacyDocumentMediaType | undefined {
  if (document.entryNames.some((name) => /(?:^|\/)(?:EncryptionInfo|EncryptedPackage)$/i.test(name))) throw new AttachmentProcessingError("encrypted_document", "Encrypted Office documents are not supported.");
  if (document.entryNames.some((name) => /(?:^|\/)(?:VBA|Macros|_VBA_PROJECT(?:_CUR)?)(?:\/|$)/i.test(name))) throw new AttachmentProcessingError("macro_enabled", "Macro-enabled Office documents are not supported.");
  const candidates: LegacyDocumentMediaType[] = [];
  if (document.streams.has("WordDocument")) candidates.push("application/msword");
  if (document.streams.has("Workbook") || document.streams.has("Book")) candidates.push("application/vnd.ms-excel");
  if (document.streams.has("PowerPoint Document")) candidates.push("application/vnd.ms-powerpoint");
  if (candidates.length > 1) throw new AttachmentProcessingError("invalid_document", "The compound document has ambiguous Office streams.");
  return candidates[0];
}
