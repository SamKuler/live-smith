import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { strToU8, zipSync } from "fflate/browser";

import { AttachmentProcessingError } from "./contracts.js";

export const contentTypes = {
  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
} as const;

export const mainParts = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
} as const;

export function packageBytes(
  kind: keyof typeof contentTypes,
  additions: Record<string, Uint8Array | string> = {},
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/${mainParts[kind]}" ContentType="${contentTypes[kind]}"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="${mainParts[kind]}"/>` +
        `</Relationships>`,
    ),
    [mainParts[kind]]: strToU8("<root/>") ,
  };
  for (const [name, value] of Object.entries(additions)) {
    entries[name] = typeof value === "string" ? strToU8(value) : value;
  }
  return zipSync(entries, { level: 6 });
}
export function processingError(code: AttachmentProcessingError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AttachmentProcessingError);
    assert.equal(error.code, code);
    return true;
  };
}

export function centralHeaders(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (readU32(bytes, offset) === 0x02014b50) offsets.push(offset);
  }
  return offsets;
}

export function mutateEntry(
  source: Uint8Array,
  entryIndex: number,
  mutate: (bytes: Uint8Array, centralOffset: number, localOffset: number) => void,
): Uint8Array {
  const bytes = new Uint8Array(source);
  const centralOffset = centralHeaders(bytes)[entryIndex];
  assert.notEqual(centralOffset, undefined);
  const localOffset = readU32(bytes, centralOffset! + 42);
  mutate(bytes, centralOffset!, localOffset);
  return bytes;
}

export function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function writeU64(bytes: Uint8Array, offset: number, value: number): void {
  writeU32(bytes, offset, value >>> 0);
  writeU32(bytes, offset + 4, Math.floor(value / 0x1_0000_0000));
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

export function withZipComment(source: Uint8Array, comment: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(source.byteLength + comment.byteLength);
  bytes.set(source);
  bytes.set(comment, source.byteLength);
  writeU16(bytes, source.byteLength - 2, comment.byteLength);
  return bytes;
}

export function zipWithOffsetAdjustedPrefix(prefix: Uint8Array, embedded: Uint8Array): Uint8Array {
  const adjusted = new Uint8Array(embedded);
  const eocdOffset = findEocd(adjusted);
  const entryCount = readU16(adjusted, eocdOffset + 10);
  let centralOffset = readU32(adjusted, eocdOffset + 16);
  writeU32(adjusted, eocdOffset + 16, centralOffset + prefix.byteLength);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(readU32(adjusted, centralOffset), 0x02014b50);
    writeU32(
      adjusted,
      centralOffset + 42,
      readU32(adjusted, centralOffset + 42) + prefix.byteLength,
    );
    centralOffset += 46 +
      readU16(adjusted, centralOffset + 28) +
      readU16(adjusted, centralOffset + 30) +
      readU16(adjusted, centralOffset + 32);
  }
  return withZipComment(prefix, adjusted);
}

export function withMalformedZip64EntryCandidate(source: Uint8Array): Uint8Array {
  const centralRecordBytes = 46;
  const comment = new Uint8Array(centralRecordBytes + 22);
  writeU32(comment, 0, 0x02014b50);
  writeU16(comment, 4, 45);
  writeU16(comment, 6, 45);
  writeU32(comment, 20, 0xffff_ffff);
  writeU32(comment, 24, 0xffff_ffff);
  writeU32(comment, 42, 0xffff_ffff);
  writeU32(comment, centralRecordBytes, 0x06054b50);
  writeU16(comment, centralRecordBytes + 8, 1);
  writeU16(comment, centralRecordBytes + 10, 1);
  writeU32(comment, centralRecordBytes + 12, centralRecordBytes);
  writeU32(comment, centralRecordBytes + 16, source.byteLength);
  return withZipComment(source, comment);
}

export function withIncompleteZip64DirectoryCandidate(source: Uint8Array): Uint8Array {
  const centralRecordBytes = 46;
  const zip64RecordBytes = 56;
  const locatorBytes = 20;
  const zip64Offset = source.byteLength + centralRecordBytes;
  const locatorOffset = centralRecordBytes + zip64RecordBytes;
  const eocdOffset = locatorOffset + locatorBytes;
  const comment = new Uint8Array(eocdOffset + 22);
  writeU32(comment, 0, 0x02014b50);
  writeU16(comment, 4, 45);
  writeU16(comment, 6, 45);
  writeU32(comment, 42, source.byteLength);
  writeU32(comment, centralRecordBytes, 0x06064b50);
  writeU64(comment, centralRecordBytes + 4, 44);
  writeU16(comment, centralRecordBytes + 12, 45);
  writeU16(comment, centralRecordBytes + 14, 45);
  writeU64(comment, centralRecordBytes + 24, 1);
  writeU64(comment, centralRecordBytes + 32, 1);
  writeU64(comment, centralRecordBytes + 40, centralRecordBytes);
  writeU64(comment, centralRecordBytes + 48, source.byteLength);
  writeU32(comment, locatorOffset, 0x07064b50);
  writeU64(comment, locatorOffset + 8, zip64Offset);
  writeU32(comment, locatorOffset + 16, 1);
  writeU32(comment, eocdOffset, 0x06054b50);
  writeU16(comment, eocdOffset + 8, 0xffff);
  writeU16(comment, eocdOffset + 10, 0xffff);
  writeU32(comment, eocdOffset + 12, 0xffff_ffff);
  writeU32(comment, eocdOffset + 16, 0xffff_ffff);
  return withZipComment(source, comment);
}

export function withDataDescriptor(
  source: Uint8Array,
  entryIndex: number,
  options: { includeSignature?: boolean; crc32?: number } = {},
): Uint8Array {
  const sourceCentralOffsets = centralHeaders(source);
  const sourceCentral = sourceCentralOffsets[entryIndex];
  assert.notEqual(sourceCentral, undefined);
  const sourceLocal = readU32(source, sourceCentral! + 42);
  const nameLength = readU16(source, sourceLocal + 26);
  const extraLength = readU16(source, sourceLocal + 28);
  const compressedSize = readU32(source, sourceCentral! + 20);
  const dataEnd = sourceLocal + 30 + nameLength + extraLength + compressedSize;
  const includeSignature = options.includeSignature ?? true;
  const crc32 = options.crc32 ?? readU32(source, sourceCentral! + 16);
  const descriptor = new Uint8Array(includeSignature ? 16 : 12);
  const payloadOffset = includeSignature ? 4 : 0;
  if (includeSignature) writeU32(descriptor, 0, 0x08074b50);
  writeU32(descriptor, payloadOffset, crc32);
  writeU32(descriptor, payloadOffset + 4, compressedSize);
  writeU32(descriptor, payloadOffset + 8, readU32(source, sourceCentral! + 24));

  const bytes = new Uint8Array(source.byteLength + descriptor.byteLength);
  bytes.set(source.subarray(0, dataEnd));
  bytes.set(descriptor, dataEnd);
  bytes.set(source.subarray(dataEnd), dataEnd + descriptor.byteLength);
  const eocd = findEocd(bytes);
  writeU32(bytes, eocd + 16, readU32(bytes, eocd + 16) + descriptor.byteLength);
  for (const central of centralHeaders(bytes)) {
    const local = readU32(bytes, central + 42);
    if (local > sourceLocal) writeU32(bytes, central + 42, local + descriptor.byteLength);
  }
  const central = centralHeaders(bytes)[entryIndex];
  assert.notEqual(central, undefined);
  writeU16(bytes, central! + 8, readU16(bytes, central! + 8) | 0x0008);
  writeU32(bytes, central! + 16, crc32);
  writeU16(bytes, sourceLocal + 6, readU16(bytes, sourceLocal + 6) | 0x0008);
  writeU32(bytes, sourceLocal + 14, crc32);
  return bytes;
}

export function asStructurallyValidZip64(source: Uint8Array): Uint8Array {
  const eocdOffset = findEocd(source);
  assert.equal(readU16(source, eocdOffset + 20), 0);
  const entryCount = readU16(source, eocdOffset + 10);
  const centralSize = readU32(source, eocdOffset + 12);
  const centralOffset = readU32(source, eocdOffset + 16);
  const zip64RecordBytes = 56;
  const locatorBytes = 20;
  const result = new Uint8Array(source.byteLength + zip64RecordBytes + locatorBytes);
  result.set(source.subarray(0, eocdOffset));
  const zip64Offset = eocdOffset;
  writeU32(result, zip64Offset, 0x06064b50);
  writeU64(result, zip64Offset + 4, 44);
  writeU16(result, zip64Offset + 12, 45);
  writeU16(result, zip64Offset + 14, 45);
  writeU64(result, zip64Offset + 24, entryCount);
  writeU64(result, zip64Offset + 32, entryCount);
  writeU64(result, zip64Offset + 40, centralSize);
  writeU64(result, zip64Offset + 48, centralOffset);
  const locatorOffset = zip64Offset + zip64RecordBytes;
  writeU32(result, locatorOffset, 0x07064b50);
  writeU64(result, locatorOffset + 8, zip64Offset);
  writeU32(result, locatorOffset + 16, 1);
  const newEocdOffset = locatorOffset + locatorBytes;
  result.set(source.subarray(eocdOffset), newEocdOffset);
  writeU16(result, newEocdOffset + 8, 0xffff);
  writeU16(result, newEocdOffset + 10, 0xffff);
  writeU32(result, newEocdOffset + 12, 0xffff_ffff);
  writeU32(result, newEocdOffset + 16, 0xffff_ffff);
  return result;
}

export function findEocd(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      readU32(bytes, offset) === 0x06054b50 &&
      offset + 22 + readU16(bytes, offset + 20) === bytes.byteLength
    ) {
      return offset;
    }
  }
  assert.fail("Test ZIP has no EOCD record.");
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

export function utf16Xml(text: string, endian: "le" | "be"): Uint8Array {
  const littleEndian = new Uint8Array(Buffer.from(text, "utf16le"));
  if (endian === "le") {
    const bytes = new Uint8Array(littleEndian.byteLength + 2);
    bytes.set([0xff, 0xfe]);
    bytes.set(littleEndian, 2);
    return bytes;
  }
  const bytes = new Uint8Array(littleEndian.byteLength + 2);
  bytes.set([0xfe, 0xff]);
  for (let index = 0; index < littleEndian.byteLength; index += 2) {
    bytes[index + 2] = littleEndian[index + 1]!;
    bytes[index + 3] = littleEndian[index]!;
  }
  return bytes;
}
