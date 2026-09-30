import { TextDecoder } from "node:util";
import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";
import type { CompoundDocument } from "./compound.js";

interface RecordData { type: number; offset: number; data: Uint8Array }
interface Sheet { offset: number; name: string; hidden: number; type: number }
interface BiffSubstream { first: number; end: number; kind: number; parent: number | undefined }
const errors: Readonly<Record<number, string>> = { 0: "#NULL!", 7: "#DIV/0!", 15: "#VALUE!", 23: "#REF!", 29: "#NAME?", 36: "#NUM!", 42: "#N/A", 43: "#GETTING_DATA" };

/** BIFF8 sheets are emitted sparsely, using cached values without evaluating formulas. */
export async function extractLegacyExcelText(document: CompoundDocument, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  throwIfAborted(signal);
  const bytes = document.streams.get("Workbook") ?? document.streams.get("Book");
  if (!bytes) throw invalid("Excel Workbook stream is missing.");
  const records: RecordData[] = [];
  const byOffset = new Map<number, number>();
  for (let cursor = 0; cursor < bytes.byteLength;) {
    if (records.length % 256 === 0) await yieldToHost(signal);
    if (cursor + 4 > bytes.byteLength) throw invalid("Excel record header is truncated.");
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.byteLength - cursor);
    const type = view.getUint16(0, true);
    const length = view.getUint16(2, true);
    if (type === 0 && length === 0) {
      if (bytes.subarray(cursor).every((value) => value === 0)) break;
      throw invalid("Excel record padding is malformed.");
    }
    if (length > 8224 || cursor + 4 + length > bytes.byteLength) throw invalid("Excel BIFF record length is invalid.");
    if (type === 0x2f) throw new AttachmentProcessingError("encrypted_document", "Encrypted Excel workbooks are not supported.");
    byOffset.set(cursor, records.length);
    records.push({ type, offset: cursor, data: bytes.subarray(cursor + 4, cursor + 4 + length) });
    if (records.length > 100_000) throw limit("Excel record count exceeds the safe limit.");
    cursor += 4 + length;
  }
  const substreams = await indexSubstreams(records, signal);
  const globalStream = substreams.get(0);
  if (!globalStream || globalStream.kind !== 5) throw invalid("Excel workbook globals are missing.");
  const globalEnd = globalStream.end;
  const sheets: Sheet[] = [];
  const names = new Set<string>();
  const offsets = new Set<number>();
  let sharedStrings: readonly string[] = [];
  let foundSst = false;
  for (let index = 1; index < globalEnd; index += 1) {
    const record = records[index]!;
    if (record.type === 0x85) {
      if (record.data.byteLength < 8) throw invalid("Excel sheet metadata is truncated.");
      const view = viewOf(record.data);
      const sheet: Sheet = { offset: view.getUint32(0, true), hidden: record.data[4]! & 3, type: record.data[5]!, name: shortString(record.data.subarray(6)) };
      if (sheet.type === 1 || sheet.type === 6) throw new AttachmentProcessingError("macro_enabled", "Macro-enabled Excel sheets are not supported.");
      if (![0, 2].includes(sheet.type) || sheet.hidden > 2 || !sheet.name || sheet.name.length > 31 || names.has(sheet.name.toLowerCase()) || offsets.has(sheet.offset)) throw invalid("Excel sheet metadata is invalid or ambiguous.");
      names.add(sheet.name.toLowerCase()); offsets.add(sheet.offset); sheets.push(sheet);
      if (sheets.length > 64) throw limit("Excel sheet count exceeds the safe limit.");
    } else if (record.type === 0xfc) {
      if (foundSst) throw invalid("Excel workbook has duplicate shared-string tables.");
      foundSst = true;
      const chunks = [record.data];
      while (records[index + 1]?.type === 0x3c) chunks.push(records[++index]!.data);
      sharedStrings = await parseSharedStrings(chunks, signal);
    }
  }
  if (sheets.length === 0) throw invalid("Excel workbook has no sheets.");
  const topLevelSheets = [...substreams.values()].filter((stream) => stream.parent === undefined && stream.kind !== 5);
  if (topLevelSheets.length !== sheets.length) throw invalid("Excel sheet substreams do not match the workbook directory.");
  const builder = new BoundedDocumentTextBuilder();
  for (const sheet of sheets) {
    const first = byOffset.get(sheet.offset);
    if (first === undefined || first <= globalEnd) throw invalid("Excel sheet offset is invalid.");
    const stream = substreams.get(first);
    if (!stream || stream.parent !== undefined || stream.kind !== (sheet.type === 2 ? 0x20 : 0x10)) throw invalid("Excel sheet offset or substream kind is invalid.");
    const rows = new Map<number, Map<number, string>>();
    const hiddenRows = new Set<number>();
    const hiddenColumns: [number, number][] = [];
    let count = 0;
    let pendingFormula: { row: number; column: number } | undefined;
    const add = (row: number, column: number, value: string): void => {
      count += 1;
      if (row > 65535 || column > 255) throw invalid("Excel cell coordinate is invalid.");
      if (count > 50_000) throw limit("Excel cell count exceeds the safe limit.");
      let cells = rows.get(row);
      if (!cells) { cells = new Map(); rows.set(row, cells); }
      if (rows.size > 10_000) throw limit("Excel populated-row count exceeds the safe limit.");
      if (cells.has(column)) throw invalid("Excel workbook has duplicate cell coordinates.");
      cells.set(column, value);
    };
    for (let index = first + 1; index < stream.end; index += 1) {
      if (index % 256 === 0) await yieldToHost(signal);
      const record = records[index]!;
      const data = record.data;
      const view = viewOf(data);
      if (record.type === 0x809) {
        index = substreams.get(index)!.end;
        continue;
      }
      if (sheet.type === 2) continue;
      if ([0x203, 0x204, 0x205, 0x27e, 0xfd, 6].includes(record.type)) {
        if (data.byteLength < 6) throw invalid("Excel cell record is truncated.");
        const row = view.getUint16(0, true); const column = view.getUint16(2, true);
        if (record.type === 0x203) { requireBytes(data, 14); add(row, column, finiteNumber(view.getFloat64(6, true))); }
        else if (record.type === 0x27e) { requireBytes(data, 10); add(row, column, rkNumber(view.getUint32(6, true))); }
        else if (record.type === 0x204) add(row, column, unicodeString(data.subarray(6)));
        else if (record.type === 0x205) {
          requireBytes(data, 8);
          if (data[7] !== 0 && data[7] !== 1) throw invalid("Excel Boolean/error value kind is invalid.");
          add(row, column, data[7] === 0 ? data[6] ? "TRUE" : "FALSE" : errorValue(data[6]!));
        }
        else if (record.type === 0xfd) {
          requireBytes(data, 10);
          const value = sharedStrings[view.getUint32(6, true)];
          if (value === undefined) throw invalid("Excel shared-string reference is invalid.");
          add(row, column, value);
        } else {
          requireBytes(data, 20);
          if (data[12] === 0xff && data[13] === 0xff) {
            if (data[6] === 0) {
              if (pendingFormula) throw invalid("Excel string formula result is missing.");
              pendingFormula = { row, column };
            } else if (data[6] === 1) add(row, column, data[8] ? "TRUE" : "FALSE");
            else if (data[6] === 2) add(row, column, errorValue(data[8]!));
            else if (data[6] === 3) add(row, column, "");
            else throw invalid("Excel cached formula result is invalid.");
          } else add(row, column, finiteNumber(view.getFloat64(6, true)));
        }
      } else if (record.type === 0x207) {
        if (!pendingFormula) throw invalid("Excel string result has no formula cell.");
        add(pendingFormula.row, pendingFormula.column, unicodeString(data)); pendingFormula = undefined;
      } else if (record.type === 0xbd) {
        requireBytes(data, 6);
        const row = view.getUint16(0, true); const start = view.getUint16(2, true); const end = view.getUint16(data.byteLength - 2, true);
        if (end < start || data.byteLength !== 6 + (end - start + 1) * 6) throw invalid("Excel multiple-RK record is malformed.");
        for (let column = start; column <= end; column += 1) add(row, column, rkNumber(view.getUint32(6 + (column - start) * 6, true)));
      } else if (record.type === 0x208) { requireBytes(data, 16); if ((view.getUint16(12, true) & 0x20) !== 0) hiddenRows.add(view.getUint16(0, true)); }
      else if (record.type === 0x7d) { requireBytes(data, 10); if ((view.getUint16(8, true) & 1) !== 0) hiddenColumns.push([view.getUint16(0, true), view.getUint16(2, true)]); }
    }
    if (pendingFormula) throw invalid("Excel cached formula result is incomplete.");
    builder.appendLine(`Sheet ${JSON.stringify(sheet.name)}`);
    if (sheet.hidden !== 0) { builder.appendLine("[hidden sheet omitted]"); continue; }
    if (sheet.type === 2) { builder.appendLine("[chart sheet omitted]"); continue; }
    for (const [row, cells] of [...rows].sort(([a], [b]) => a - b)) {
      builder.append(`Row ${row + 1}: `);
      if (hiddenRows.has(row)) { builder.appendLine("[hidden row omitted]"); continue; }
      let firstCell = true;
      for (const [column, value] of [...cells].sort(([a], [b]) => a - b)) {
        if (hiddenColumns.some(([start, end]) => column >= start && column <= end)) continue;
        if (!firstCell) builder.append("\t"); firstCell = false;
        builder.append(`${columnName(column + 1)}${row + 1}=${JSON.stringify(value)}`);
      }
      builder.appendLine();
      if (builder.truncated) break;
    }
  }
  throwIfAborted(signal);
  return builder.finish();
}

async function indexSubstreams(records: readonly RecordData[], signal?: AbortSignal): Promise<ReadonlyMap<number, BiffSubstream>> {
  const substreams = new Map<number, BiffSubstream>();
  const stack: { first: number; kind: number; parent: number | undefined }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (index % 256 === 0) await yieldToHost(signal);
    const record = records[index]!;
    if (record.type === 0x809) {
      const kind = bofKind(record);
      const parent = stack.at(-1);
      // MS-XLS permits one embedded chart level inside a worksheet. Every
      // other supported sheet substream is top-level in the Workbook stream.
      if (parent !== undefined && (parent.kind !== 0x10 || kind !== 0x20)) throw invalid("Excel nested substream kind is invalid.");
      if (kind === 5 && index !== 0) throw invalid("Excel workbook globals are duplicated or nested.");
      stack.push({ first: index, kind, parent: parent?.first });
    } else if (record.type === 0x0a) {
      const open = stack.pop();
      if (!open || record.data.byteLength !== 0) throw invalid("Excel substream EOF is unmatched or malformed.");
      substreams.set(open.first, { ...open, end: index });
    } else if (stack.length === 0) throw invalid("Excel record is outside a BOF/EOF substream.");
  }
  if (stack.length > 0) throw invalid("Excel BOF/EOF substreams are incomplete.");
  return substreams;
}

class StringCursor {
  chunk = 0; offset = 0;
  constructor(readonly chunks: readonly Uint8Array[]) {}
  byte(): number {
    while (this.offset >= (this.chunks[this.chunk]?.length ?? 0)) {
      this.chunk += 1; this.offset = 0;
      if (this.chunk >= this.chunks.length) throw invalid("Excel shared-string table is truncated.");
    }
    return this.chunks[this.chunk]![this.offset++]!;
  }
  integer(length: number): number { let value = 0; for (let index = 0; index < length; index += 1) value += this.byte() * 2 ** (index * 8); return value; }
  skip(length: number): void { for (let index = 0; index < length; index += 1) this.byte(); }
  string(length: number, wide: boolean): string {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      if (this.offset === this.chunks[this.chunk]!.length) {
        this.chunk += 1; this.offset = 0;
        if (!this.chunks[this.chunk]) throw invalid("Excel continued string is truncated.");
        const option = this.byte();
        if (option !== 0 && option !== 1) throw invalid("Excel continued-string encoding is invalid.");
        wide = option === 1;
      }
      if (wide && this.offset + 2 > this.chunks[this.chunk]!.length) throw invalid("Excel UTF-16 code unit is split across records.");
      value += String.fromCharCode(this.integer(wide ? 2 : 1));
    }
    return validateUnicode(value);
  }
}

async function parseSharedStrings(chunks: readonly Uint8Array[], signal?: AbortSignal): Promise<readonly string[]> {
  const cursor = new StringCursor(chunks);
  const total = cursor.integer(4); const unique = cursor.integer(4);
  if (unique > total) throw invalid("Excel shared-string counts are invalid.");
  if (unique > 100_000) throw limit("Excel shared-string count exceeds the safe limit.");
  const strings: string[] = [];
  for (let index = 0; index < unique; index += 1) {
    if (index % 128 === 0) await yieldToHost(signal);
    const length = cursor.integer(2); const flags = cursor.byte();
    if ((flags & ~0x0d) !== 0 || length > 32767) throw invalid("Excel shared-string flags or length are invalid.");
    const runs = flags & 8 ? cursor.integer(2) : 0;
    const extension = flags & 4 ? cursor.integer(4) : 0;
    strings.push(cursor.string(length, (flags & 1) !== 0));
    cursor.skip(runs * 4 + extension);
  }
  if (cursor.chunk !== chunks.length - 1 || cursor.offset !== chunks[cursor.chunk]!.length) throw invalid("Excel shared-string table has unexpected trailing data.");
  return strings;
}
function shortString(bytes: Uint8Array): string { requireBytes(bytes, 2); return stringData(bytes, bytes[0]!, 1); }
function unicodeString(bytes: Uint8Array): string { requireBytes(bytes, 3); return stringData(bytes, viewOf(bytes).getUint16(0, true), 2); }
function stringData(bytes: Uint8Array, length: number, flagOffset: number): string {
  const wide = bytes[flagOffset]! & 1;
  if ((bytes[flagOffset]! & ~1) !== 0) throw invalid("Excel string encoding is unsupported.");
  const offset = flagOffset + 1;
  requireBytes(bytes, offset + length * (wide ? 2 : 1));
  if (wide) {
    try { return validateUnicode(new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(offset, offset + length * 2))); }
    catch { throw invalid("Excel string encoding is invalid."); }
  }
  let value = ""; for (const byte of bytes.subarray(offset, offset + length)) value += String.fromCharCode(byte); return validateUnicode(value);
}
function validateUnicode(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const low = value.charCodeAt(++index); if (!(low >= 0xdc00 && low <= 0xdfff)) throw invalid("Excel string contains malformed Unicode."); }
    else if (unit >= 0xdc00 && unit <= 0xdfff || unit === 0) throw invalid("Excel string contains malformed Unicode.");
  }
  return value;
}
function bofKind(record: RecordData): number {
  if (record.data.byteLength < 4) throw invalid("Excel substream BOF is truncated.");
  const view = viewOf(record.data);
  if (view.getUint16(0, true) !== 0x600) throw new AttachmentProcessingError("unsupported_type", "Only Excel 97–2003 BIFF8 binary workbooks are supported.");
  if (record.data.byteLength !== 16) throw invalid("Excel BIFF8 BOF length is invalid.");
  const kind = view.getUint16(2, true);
  if (kind === 6 || kind === 0x40) throw new AttachmentProcessingError("macro_enabled", "Macro-enabled Excel substreams are not supported.");
  if (kind !== 5 && kind !== 0x10 && kind !== 0x20) throw new AttachmentProcessingError("unsupported_type", "This Excel substream kind is not supported.");
  return kind;
}
function rkNumber(raw: number): string {
  let number: number;
  if (raw & 2) number = (raw | 0) >> 2;
  else { const bytes = new Uint8Array(8); const view = viewOf(bytes); view.setUint32(4, raw & 0xfffffffc, true); number = view.getFloat64(0, true); }
  return finiteNumber(raw & 1 ? number / 100 : number);
}
function finiteNumber(value: number): string { if (!Number.isFinite(value)) throw invalid("Excel numeric value is invalid."); return String(value); }
function errorValue(value: number): string { const error = errors[value]; if (!error) throw invalid("Excel error value is invalid."); return error; }
function requireBytes(bytes: Uint8Array, length: number): void { if (bytes.byteLength < length) throw invalid("Excel record is truncated."); }
function viewOf(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function columnName(column: number): string { let value = ""; while (column > 0) { column -= 1; value = String.fromCharCode(65 + column % 26) + value; column = Math.floor(column / 26); } return value; }
function invalid(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function limit(message: string): AttachmentProcessingError { return new AttachmentProcessingError("archive_limit", message); }
