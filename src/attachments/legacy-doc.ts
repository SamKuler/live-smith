import { TextDecoder } from "node:util";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError, MAX_DOCUMENT_ATTACHMENT_BYTES } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";
import type { CompoundDocument } from "./compound.js";

export async function extractLegacyWordText(document: CompoundDocument, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  throwIfAborted(signal);
  const word = document.streams.get("WordDocument");
  if (!word || word.byteLength < 154) throw invalid("Word document FIB is missing or truncated.");
  const view = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (view.getUint16(0, true) !== 0xa5ec) throw invalid("Word document FIB signature is invalid.");
  const flags = view.getUint16(10, true);
  if ((flags & 0x8100) !== 0) throw new AttachmentProcessingError("encrypted_document", "Encrypted or obfuscated Word documents are not supported.");
  if (![0x00c1, 0x00d9, 0x0101, 0x010c, 0x0112].includes(view.getUint16(2, true))) {
    throw new AttachmentProcessingError("unsupported_type", "Only Word 97–2007 binary documents are supported.");
  }
  const table = document.streams.get(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw invalid("Word document Table stream is missing.");
  const requireRange = (start: number, length: number): void => {
    if (start < 0 || length < 0 || start + length > word.byteLength) throw invalid("Word document FIB is truncated.");
  };
  const csw = view.getUint16(32, true);
  const cslwOffset = 34 + csw * 2;
  requireRange(cslwOffset, 2);
  const cslw = view.getUint16(cslwOffset, true);
  const longWordsOffset = cslwOffset + 2;
  const fcCountOffset = longWordsOffset + cslw * 4;
  requireRange(longWordsOffset, Math.max(cslw * 4, 44));
  requireRange(fcCountOffset, 2);
  const fcCount = view.getUint16(fcCountOffset, true);
  const fcOffset = fcCountOffset + 2;
  requireRange(fcOffset, fcCount * 8);
  if (csw !== 14 || cslw < 22 || fcCount < 34) throw invalid("Word document FIB fields are invalid.");
  const counts = Array.from({ length: 8 }, (_, index) => view.getUint32(longWordsOffset + 12 + index * 4, true));
  if (counts[3] !== 0) throw new AttachmentProcessingError("macro_enabled", "Word macro text is not supported.");
  const totalCharacters = counts.reduce((total, count) => total + count, 0);
  if (totalCharacters > MAX_DOCUMENT_ATTACHMENT_BYTES) throw limit("Word document character count exceeds the safe limit.");
  const clxOffset = view.getUint32(fcOffset + 33 * 8, true);
  const clxLength = view.getUint32(fcOffset + 33 * 8 + 4, true);
  if (clxLength < 5 || clxOffset + clxLength > table.byteLength) throw invalid("Word document piece table is missing or out of bounds.");
  const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let cursor = clxOffset;
  const clxEnd = clxOffset + clxLength;
  while (table[cursor] === 1) {
    if (cursor + 3 > clxEnd) throw invalid("Word document formatting group is truncated.");
    cursor += 3 + tableView.getUint16(cursor + 1, true);
    if (cursor >= clxEnd) throw invalid("Word document piece table is truncated.");
  }
  if (table[cursor] !== 2 || cursor + 5 > clxEnd) throw invalid("Word document piece-table record is invalid.");
  const pieceTableLength = tableView.getUint32(cursor + 1, true);
  cursor += 5;
  if (cursor + pieceTableLength !== clxEnd || pieceTableLength < 4 || (pieceTableLength - 4) % 12 !== 0) throw invalid("Word document piece-table length is invalid.");
  const pieces = (pieceTableLength - 4) / 12;
  if (pieces > 100_000) throw limit("Word document piece count exceeds the safe limit.");
  if (tableView.getUint32(cursor, true) !== 0 || tableView.getUint32(cursor + pieces * 4, true) < totalCharacters) throw invalid("Word document character positions are invalid.");
  const builder = new BoundedDocumentTextBuilder();
  const fields: boolean[] = [];
  let highSurrogate: number | undefined;
  let processed = 0;
  let story = 0;
  let storyEnd = counts[0]!;
  const labels = ["", "Footnotes", "Headers and footers", "", "Comments", "Endnotes", "Text boxes", "Header text boxes"];
  const consume = (unit: number): void => {
    while (processed >= storyEnd && story < counts.length - 1) {
      story += 1; storyEnd += counts[story]!;
      if (counts[story]! > 0 && labels[story]) builder.appendLine(`\n${labels[story]}`);
    }
    processed += 1;
    if (unit === 0x13) { if (fields.length >= 256) throw limit("Word field nesting exceeds the safe limit."); fields.push(false); return; }
    if (unit === 0x14) { if (fields.length === 0) throw invalid("Word field separator has no field."); fields[fields.length - 1] = true; return; }
    if (unit === 0x15) { if (fields.pop() === undefined) throw invalid("Word field terminator has no field."); return; }
    if (fields.some((visible) => !visible)) return;
    if (unit >= 0xd800 && unit <= 0xdbff) { if (highSurrogate !== undefined) throw invalid("Word text contains malformed Unicode."); highSurrogate = unit; return; }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      if (highSurrogate === undefined) throw invalid("Word text contains malformed Unicode.");
      builder.append(String.fromCharCode(highSurrogate, unit)); highSurrogate = undefined; return;
    }
    if (highSurrogate !== undefined) throw invalid("Word text contains malformed Unicode.");
    if (unit === 13 || unit === 11 || unit === 12) builder.append("\n");
    else if (unit === 7 || unit === 9) builder.append("\t");
    else if (unit === 30) builder.append("‑");
    else if (unit === 31) builder.append("­");
    else if (unit >= 32 && unit !== 127) builder.append(String.fromCharCode(unit));
  };
  const decoder = new TextDecoder("windows-1252");
  for (let index = 0; index < pieces; index += 1) {
    if (index % 128 === 0) await yieldToHost(signal);
    const cpStart = tableView.getUint32(cursor + index * 4, true);
    const cpEnd = tableView.getUint32(cursor + (index + 1) * 4, true);
    if (cpEnd < cpStart || cpEnd > MAX_DOCUMENT_ATTACHMENT_BYTES + 1) throw invalid("Word piece character positions are invalid.");
    const encodedOffset = tableView.getUint32(cursor + (pieces + 1) * 4 + index * 8 + 2, true);
    if ((encodedOffset & 0x80000000) !== 0) throw invalid("Word piece offset has reserved flags.");
    const compressed = (encodedOffset & 0x40000000) !== 0;
    const rawOffset = encodedOffset & 0x3fffffff;
    if (compressed && rawOffset % 2 !== 0) throw invalid("Word compressed piece offset is invalid.");
    const offset = compressed ? rawOffset / 2 : rawOffset;
    const length = cpEnd - cpStart;
    if (offset + length * (compressed ? 1 : 2) > word.byteLength) throw invalid("Word text piece exceeds its stream.");
    const retainLength = Math.max(0, Math.min(cpEnd, totalCharacters) - cpStart);
    for (let start = 0; start < retainLength; start += 16_384) {
      await yieldToHost(signal);
      const end = Math.min(start + 16_384, retainLength);
      if (compressed) {
        for (const character of decoder.decode(word.subarray(offset + start, offset + end))) consume(character.charCodeAt(0));
      } else for (let unit = start; unit < end; unit += 1) consume(view.getUint16(offset + unit * 2, true));
    }
  }
  if (processed !== totalCharacters || highSurrogate !== undefined || fields.length > 0) throw invalid("Word document text or fields are incomplete.");
  return builder.finish();
}

function invalid(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function limit(message: string): AttachmentProcessingError { return new AttachmentProcessingError("archive_limit", message); }
