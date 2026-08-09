import { UnzipInflate } from "fflate/browser";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import {
  assertDocumentAttachmentBytesWithinLimit,
  AttachmentProcessingError,
  MAX_OOXML_XML_PART_BYTES,
} from "./contracts.js";

export const MAX_OOXML_ENTRY_COUNT = 2_048;
export const MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES = MAX_OOXML_XML_PART_BYTES;
export const MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_OOXML_COMPRESSION_RATIO = 200;

const INFLATE_INPUT_CHUNK_BYTES = 1 * 1024;
const ZIP_STRUCTURE_YIELD_INTERVAL = 64;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;

interface ZipEntryIndex {
  name: string;
  isDirectory: boolean;
  flags: number;
  compression: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
  localRecordEnd: number;
}

interface ParsedCentralDirectory {
  entries: ZipEntryIndex[];
  policyViolation?: AttachmentProcessingError;
}

interface Zip64ExtraField {
  payloadOffset: number;
  payloadLength: number;
}

export interface BoundedOoxmlZip {
  entryNames: readonly string[];
  retainedEntries: ReadonlyMap<string, Uint8Array>;
}

export async function openBoundedOoxmlZip(
  bytes: Uint8Array,
  shouldRetain: (name: string) => boolean,
  signal?: AbortSignal,
): Promise<BoundedOoxmlZip> {
  assertDocumentAttachmentBytesWithinLimit(bytes);
  throwIfAborted(signal);
  const index = await parseCentralDirectory(bytes, signal);
  const retainedEntries = new Map<string, Uint8Array>();
  let totalActualBytes = 0;

  for (const entry of index) {
    throwIfAborted(signal);
    const keep = shouldRetain(entry.name);
    const chunks: Uint8Array[] = [];
    let actualBytes = 0;
    let crc = 0xffffffff;
    const acceptChunk = (chunk: Uint8Array): void => {
      throwIfAborted(signal);
      actualBytes += chunk.byteLength;
      totalActualBytes += chunk.byteLength;
      if (
        actualBytes > entry.uncompressedSize ||
        actualBytes > MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES ||
        totalActualBytes > MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES
      ) {
        throw archiveLimit("OOXML expanded data exceeds the safe extraction limit.");
      }
      crc = updateCrc32(crc, chunk);
      if (keep && chunk.byteLength) chunks.push(new Uint8Array(chunk));
    };
    await inflateEntry(bytes, entry, acceptChunk, signal);
    if (
      actualBytes !== entry.uncompressedSize ||
      ((crc ^ 0xffffffff) >>> 0) !== entry.crc32
    ) {
      throw invalidDocument("OOXML ZIP entry integrity validation failed.");
    }
    if (keep) {
      retainedEntries.set(entry.name, concatenateBytes(chunks, actualBytes));
    }
  }

  return {
    entryNames: index.map((entry) => entry.name),
    retainedEntries,
  };
}

async function parseCentralDirectory(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ZipEntryIndex[]> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    throw invalidDocument("OOXML ZIP data is truncated.");
  }
  const interpretations: ParsedCentralDirectory[] = [];
  let closestError: AttachmentProcessingError | undefined;
  for (const candidate of endOfCentralDirectoryCandidates(bytes)) {
    try {
      interpretations.push(await parseCentralDirectoryAt(bytes, candidate, signal));
    } catch (error) {
      if (!(error instanceof AttachmentProcessingError)) throw error;
      closestError ??= error;
    }
    await yieldToHost(signal);
  }
  if (interpretations.length === 0) {
    throw closestError ?? invalidDocument(
      "OOXML end-of-central-directory record is invalid.",
    );
  }
  if (interpretations.length > 1) {
    throw invalidDocument("OOXML contains ambiguous ZIP directory interpretations.");
  }
  const selected = interpretations[0]!;
  if (selected.policyViolation) throw selected.policyViolation;
  return selected.entries;
}

async function parseCentralDirectoryAt(
  bytes: Uint8Array,
  eocdOffset: number,
  signal?: AbortSignal,
): Promise<ParsedCentralDirectory> {
  let policyViolation: AttachmentProcessingError | undefined;
  const notePolicyViolation = (error: AttachmentProcessingError): void => {
    policyViolation ??= error;
  };
  const diskNumber = readU16(bytes, eocdOffset + 4);
  const centralDisk = readU16(bytes, eocdOffset + 6);
  const diskEntryCount = readU16(bytes, eocdOffset + 8);
  const entryCount = readU16(bytes, eocdOffset + 10);
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    notePolicyViolation(
      invalidDocument("Multi-disk OOXML ZIP containers are not supported."),
    );
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    await assertStructurallyValidZip64End(bytes, eocdOffset, signal);
    return {
      entries: [],
      policyViolation: archiveLimit("ZIP64 OOXML containers are not supported."),
    };
  }
  if (entryCount === 0 || entryCount > MAX_OOXML_ENTRY_COUNT) {
    notePolicyViolation(
      archiveLimit("OOXML ZIP entry count exceeds the safe limit."),
    );
  }
  if (
    centralOffset > eocdOffset ||
    centralSize > eocdOffset - centralOffset ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw invalidDocument("OOXML central directory range is invalid.");
  }

  const entries: ZipEntryIndex[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let totalDeclaredBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (index > 0 && index % ZIP_STRUCTURE_YIELD_INTERVAL === 0) {
      await yieldToHost(signal);
    }
    requireRange(bytes, cursor, 46);
    if (readU32(bytes, cursor) !== ZIP_CENTRAL_FILE_HEADER) {
      throw invalidDocument("OOXML central directory entry is invalid.");
    }
    const versionMadeBy = readU16(bytes, cursor + 4);
    const flags = readU16(bytes, cursor + 8);
    const compression = readU16(bytes, cursor + 10);
    const crc32 = readU32(bytes, cursor + 16);
    const compressedSizeField = readU32(bytes, cursor + 20);
    const uncompressedSizeField = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const diskStartField = readU16(bytes, cursor + 34);
    const externalAttributes = readU32(bytes, cursor + 38);
    const localHeaderOffsetField = readU32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, cursor, recordLength);
    if (cursor + recordLength > centralOffset + centralSize) {
      throw invalidDocument("OOXML central directory entry range is invalid.");
    }
    const zip64Extra = findZip64ExtraField(
      bytes,
      cursor + 46 + nameLength,
      extraLength,
    );
    const resolved = resolveCentralZip64Values(bytes, zip64Extra, {
      compressedSize: compressedSizeField,
      uncompressedSize: uncompressedSizeField,
      localHeaderOffset: localHeaderOffsetField,
      diskStart: diskStartField,
    });
    if (zip64Extra) {
      notePolicyViolation(archiveLimit("ZIP64 OOXML entries are not supported."));
    }
    if (resolved.diskStart !== 0) {
      notePolicyViolation(
        invalidDocument("Multi-disk OOXML ZIP entries are not supported."),
      );
    }
    const flagsViolation = unsupportedFlagsError(flags);
    if (flagsViolation) notePolicyViolation(flagsViolation);
    if (compression !== 0 && compression !== 8) {
      notePolicyViolation(
        invalidDocument("OOXML ZIP compression method is not supported."),
      );
    }
    const { compressedSize, uncompressedSize, localHeaderOffset } = resolved;
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    let isDirectory: boolean;
    try {
      ({ name, isDirectory } = normalizeEntryName(rawName));
    } catch (error) {
      if (!(error instanceof AttachmentProcessingError)) throw error;
      notePolicyViolation(error);
      name = `__unsafe_entry_${index}`;
      isDirectory = rawName[rawName.byteLength - 1] === 0x2f;
    }
    if (names.has(name)) {
      notePolicyViolation(
        archiveLimit("OOXML ZIP contains duplicate normalized entry names."),
      );
    }
    names.add(name);
    if (isUnixSymbolicLink(versionMadeBy, externalAttributes)) {
      notePolicyViolation(
        archiveLimit("OOXML ZIP symbolic-link entries are not supported."),
      );
    }
    if (uncompressedSize > MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES) {
      notePolicyViolation(
        archiveLimit("OOXML ZIP entry exceeds the safe expanded size."),
      );
    }
    totalDeclaredBytes += uncompressedSize;
    if (totalDeclaredBytes > MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES) {
      notePolicyViolation(
        archiveLimit("OOXML ZIP expanded data exceeds the safe total size."),
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize > compressedSize * MAX_OOXML_COMPRESSION_RATIO)
    ) {
      notePolicyViolation(
        archiveLimit("OOXML ZIP entry compression ratio exceeds the safe limit."),
      );
    }

    const local = parseLocalHeader(bytes, {
      name,
      flags,
      compression: compression as 0 | 8,
      crc32,
      compressedSize,
      uncompressedSize,
      compressedSizeField,
      uncompressedSizeField,
      localHeaderOffset,
      centralOffset,
      rawName,
    });
    if (local.hasZip64Extra) {
      notePolicyViolation(archiveLimit("ZIP64 OOXML entries are not supported."));
    }
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      notePolicyViolation(
        invalidDocument("OOXML ZIP directory entry contains file data."),
      );
    }
    entries.push({
      name,
      isDirectory,
      flags,
      compression: compression as 0 | 8,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: local.dataOffset,
      dataEnd: local.dataEnd,
      localRecordEnd: local.localRecordEnd,
    });
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw invalidDocument("OOXML central directory size is inconsistent.");
  }
  assertEntryRangesDoNotOverlap(entries, centralOffset);
  return policyViolation ? { entries, policyViolation } : { entries };
}

function parseLocalHeader(
  bytes: Uint8Array,
  expected: {
    name: string;
    flags: number;
    compression: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    compressedSizeField: number;
    uncompressedSizeField: number;
    localHeaderOffset: number;
    centralOffset: number;
    rawName: Uint8Array;
  },
): {
  dataOffset: number;
  dataEnd: number;
  localRecordEnd: number;
  hasZip64Extra: boolean;
} {
  requireRange(bytes, expected.localHeaderOffset, 30);
  if (readU32(bytes, expected.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw invalidDocument("OOXML local ZIP header is invalid.");
  }
  const flags = readU16(bytes, expected.localHeaderOffset + 6);
  const compression = readU16(bytes, expected.localHeaderOffset + 8);
  const crc32 = readU32(bytes, expected.localHeaderOffset + 14);
  const compressedSizeField = readU32(bytes, expected.localHeaderOffset + 18);
  const uncompressedSizeField = readU32(bytes, expected.localHeaderOffset + 22);
  const nameLength = readU16(bytes, expected.localHeaderOffset + 26);
  const extraLength = readU16(bytes, expected.localHeaderOffset + 28);
  const headerLength = 30 + nameLength + extraLength;
  requireRange(bytes, expected.localHeaderOffset, headerLength);
  const localName = bytes.subarray(
    expected.localHeaderOffset + 30,
    expected.localHeaderOffset + 30 + nameLength,
  );
  const zip64Extra = findZip64ExtraField(
    bytes,
    expected.localHeaderOffset + 30 + nameLength,
    extraLength,
  );
  const resolvedSizes = resolveLocalZip64Sizes(bytes, zip64Extra, {
    compressedSize: compressedSizeField,
    uncompressedSize: uncompressedSizeField,
  });
  if (
    flags !== expected.flags ||
    compression !== expected.compression ||
    (!(expected.flags & 0x0008) && (
      crc32 !== expected.crc32 ||
      compressedSizeField !== expected.compressedSizeField ||
      uncompressedSizeField !== expected.uncompressedSizeField ||
      resolvedSizes.compressedSize !== expected.compressedSize ||
      resolvedSizes.uncompressedSize !== expected.uncompressedSize
    )) ||
    !equalBytes(localName, expected.rawName)
  ) {
    throw invalidDocument("OOXML central and local ZIP headers disagree.");
  }
  const dataOffset = expected.localHeaderOffset + headerLength;
  const dataEnd = dataOffset + expected.compressedSize;
  if (
    dataOffset > expected.centralOffset ||
    dataEnd < dataOffset ||
    dataEnd > expected.centralOffset
  ) {
    throw invalidDocument("OOXML compressed entry range is invalid.");
  }
  const localRecordEnd = expected.flags & 0x0008
    ? validateDataDescriptor(bytes, dataEnd, expected)
    : dataEnd;
  if (localRecordEnd > expected.centralOffset) {
    throw invalidDocument("OOXML ZIP data descriptor range is invalid.");
  }
  return {
    dataOffset,
    dataEnd,
    localRecordEnd,
    hasZip64Extra: zip64Extra !== undefined,
  };
}

function validateDataDescriptor(
  bytes: Uint8Array,
  offset: number,
  expected: {
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    compressedSizeField: number;
    uncompressedSizeField: number;
  },
): number {
  const usesZip64Sizes = expected.compressedSizeField === 0xffff_ffff ||
    expected.uncompressedSizeField === 0xffff_ffff;
  const candidateOffsets = [offset];
  if (readU32(bytes, offset) === ZIP_DATA_DESCRIPTOR) {
    candidateOffsets.push(offset + 4);
  }
  const matchingEnds = candidateOffsets.flatMap((candidateOffset) => {
    const end = matchingDataDescriptorEnd(
      bytes,
      candidateOffset,
      usesZip64Sizes,
      expected,
    );
    return end === undefined ? [] : [end];
  });
  if (matchingEnds.length !== 1) {
    throw invalidDocument("OOXML ZIP data descriptor is invalid.");
  }
  return matchingEnds[0]!;
}

function matchingDataDescriptorEnd(
  bytes: Uint8Array,
  offset: number,
  usesZip64Sizes: boolean,
  expected: {
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
  },
): number | undefined {
  const payloadBytes = usesZip64Sizes ? 20 : 12;
  try {
    requireRange(bytes, offset, payloadBytes);
    const crc32 = readU32(bytes, offset);
    const compressedSize = usesZip64Sizes
      ? readU64Safe(bytes, offset + 4)
      : readU32(bytes, offset + 4);
    const uncompressedSize = usesZip64Sizes
      ? readU64Safe(bytes, offset + 12)
      : readU32(bytes, offset + 8);
    return crc32 === expected.crc32 &&
        compressedSize !== undefined &&
        compressedSize === expected.compressedSize &&
        uncompressedSize !== undefined &&
        uncompressedSize === expected.uncompressedSize
      ? offset + payloadBytes
      : undefined;
  } catch (error) {
    if (error instanceof AttachmentProcessingError) return undefined;
    throw error;
  }
}

async function inflateEntry(
  archive: Uint8Array,
  entry: ZipEntryIndex,
  acceptChunk: (chunk: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<void> {
  const compressed = archive.subarray(entry.dataOffset, entry.dataEnd);
  if (entry.compression === 0) {
    for (let offset = 0; offset < compressed.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
      throwIfAborted(signal);
      acceptChunk(compressed.subarray(
        offset,
        Math.min(compressed.byteLength, offset + INFLATE_INPUT_CHUNK_BYTES),
      ));
      await yieldToHost(signal);
    }
    return;
  }

  let failure: unknown;
  const inflater = new UnzipInflate();
  inflater.ondata = (error, chunk) => {
    if (failure !== undefined) return;
    if (error) {
      failure = error;
      return;
    }
    try {
      acceptChunk(chunk);
    } catch (cause) {
      failure = cause;
    }
  };
  try {
    if (compressed.byteLength === 0) inflater.push(compressed, true);
    for (let offset = 0; offset < compressed.byteLength && failure === undefined;) {
      throwIfAborted(signal);
      const end = Math.min(compressed.byteLength, offset + INFLATE_INPUT_CHUNK_BYTES);
      inflater.push(compressed.subarray(offset, end), end === compressed.byteLength);
      offset = end;
      await yieldToHost(signal);
    }
  } catch (cause) {
    if (signal?.aborted) throwIfAborted(signal);
    failure = cause;
  }
  if (failure !== undefined) {
    if (signal?.aborted) throwIfAborted(signal);
    if (failure instanceof AttachmentProcessingError) throw failure;
    throw invalidDocument("OOXML compressed data could not be decoded.", failure);
  }
}

function endOfCentralDirectoryCandidates(bytes: Uint8Array): number[] {
  const firstCandidate = Math.max(0, bytes.byteLength - 22 - 0xffff);
  const candidates: number[] = [];
  for (let offset = bytes.byteLength - 22; offset >= firstCandidate; offset -= 1) {
    if (readU32(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) candidates.push(offset);
  }
  return candidates;
}

async function assertStructurallyValidZip64End(
  bytes: Uint8Array,
  eocdOffset: number,
  signal?: AbortSignal,
): Promise<void> {
  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset < 0 ||
    readU32(bytes, locatorOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
  ) {
    throw invalidDocument("ZIP64 end-of-central-directory locator is missing.");
  }
  const zip64Offset = readU64Safe(bytes, locatorOffset + 8);
  const totalDisks = readU32(bytes, locatorOffset + 16);
  if (zip64Offset === undefined || totalDisks === 0 || zip64Offset >= locatorOffset) {
    throw invalidDocument("ZIP64 end-of-central-directory locator is invalid.");
  }
  requireRange(bytes, zip64Offset, 56);
  if (readU32(bytes, zip64Offset) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw invalidDocument("ZIP64 end-of-central-directory record is missing.");
  }
  const recordPayloadSize = readU64Safe(bytes, zip64Offset + 4);
  if (
    recordPayloadSize === undefined ||
    recordPayloadSize < 44 ||
    recordPayloadSize > locatorOffset - zip64Offset - 12 ||
    zip64Offset + 12 + recordPayloadSize !== locatorOffset
  ) {
    throw invalidDocument("ZIP64 end-of-central-directory record is invalid.");
  }
  const entryCount = readU64Safe(bytes, zip64Offset + 32);
  const centralSize = readU64Safe(bytes, zip64Offset + 40);
  const centralOffset = readU64Safe(bytes, zip64Offset + 48);
  if (
    entryCount === undefined ||
    centralSize === undefined ||
    centralOffset === undefined ||
    centralOffset > zip64Offset ||
    centralSize > zip64Offset - centralOffset ||
    centralOffset + centralSize !== zip64Offset ||
    entryCount > Math.floor(centralSize / 46)
  ) {
    throw invalidDocument("ZIP64 central directory range is invalid.");
  }
  let cursor = centralOffset;
  const entries: ZipEntryIndex[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (index > 0 && index % ZIP_STRUCTURE_YIELD_INTERVAL === 0) {
      await yieldToHost(signal);
    }
    requireRange(bytes, cursor, 46);
    if (readU32(bytes, cursor) !== ZIP_CENTRAL_FILE_HEADER) {
      throw invalidDocument("ZIP64 central directory entry is invalid.");
    }
    const flags = readU16(bytes, cursor + 8);
    const compression = readU16(bytes, cursor + 10);
    const crc32 = readU32(bytes, cursor + 16);
    const compressedSizeField = readU32(bytes, cursor + 20);
    const uncompressedSizeField = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const diskStartField = readU16(bytes, cursor + 34);
    const localHeaderOffsetField = readU32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, cursor, recordLength);
    if (cursor + recordLength > zip64Offset) {
      throw invalidDocument("ZIP64 central directory entry range is invalid.");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const zip64Extra = findZip64ExtraField(
      bytes,
      cursor + 46 + nameLength,
      extraLength,
    );
    const resolved = resolveCentralZip64Values(bytes, zip64Extra, {
      compressedSize: compressedSizeField,
      uncompressedSize: uncompressedSizeField,
      localHeaderOffset: localHeaderOffsetField,
      diskStart: diskStartField,
    });
    const local = parseLocalHeader(bytes, {
      name: "",
      flags,
      compression,
      crc32,
      compressedSize: resolved.compressedSize,
      uncompressedSize: resolved.uncompressedSize,
      compressedSizeField,
      uncompressedSizeField,
      localHeaderOffset: resolved.localHeaderOffset,
      centralOffset,
      rawName,
    });
    entries.push({
      name: `__zip64_entry_${index}`,
      isDirectory: rawName[rawName.byteLength - 1] === 0x2f,
      flags,
      compression: compression as 0 | 8,
      crc32,
      compressedSize: resolved.compressedSize,
      uncompressedSize: resolved.uncompressedSize,
      localHeaderOffset: resolved.localHeaderOffset,
      dataOffset: local.dataOffset,
      dataEnd: local.dataEnd,
      localRecordEnd: local.localRecordEnd,
    });
    cursor += recordLength;
  }
  if (cursor !== zip64Offset) {
    throw invalidDocument("ZIP64 central directory size is inconsistent.");
  }
  assertEntryRangesDoNotOverlap(entries, centralOffset);
}

function normalizeEntryName(raw: Uint8Array): { name: string; isDirectory: boolean } {
  if (!raw.byteLength || raw.some((value) => value < 0x20 || value > 0x7e)) {
    throw archiveLimit("OOXML ZIP entry name is invalid.");
  }
  const decoded = String.fromCharCode(...raw);
  if (decoded.includes("\\")) {
    throw archiveLimit("OOXML ZIP entry path uses a non-canonical separator.");
  }
  const isDirectory = decoded.endsWith("/");
  const withoutTrailingSlash = isDirectory ? decoded.slice(0, -1) : decoded;
  if (
    !withoutTrailingSlash ||
    withoutTrailingSlash.startsWith("/") ||
    /^[A-Za-z]:/.test(withoutTrailingSlash)
  ) {
    throw archiveLimit("OOXML ZIP entry path is not relative.");
  }
  const segments = withoutTrailingSlash.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw archiveLimit("OOXML ZIP entry path contains unsafe segments.");
  }
  return { name: segments.join("/"), isDirectory };
}

function unsupportedFlagsError(flags: number): AttachmentProcessingError | undefined {
  if (flags & 0x0001 || flags & 0x0040) {
    return new AttachmentProcessingError(
      "encrypted_document",
      "Encrypted Office documents are not supported.",
    );
  }
  // Data descriptors complicate local/central integrity comparison. OOXML files
  // with explicit local sizes are deterministic and sufficient for this boundary.
  if (flags & 0x0008 || (flags & ~0x0800) !== 0) {
    return invalidDocument("OOXML ZIP flags are not supported.");
  }
  return undefined;
}

function findZip64ExtraField(
  bytes: Uint8Array,
  offset: number,
  length: number,
): Zip64ExtraField | undefined {
  requireRange(bytes, offset, length);
  const end = offset + length;
  let cursor = offset;
  let zip64: Zip64ExtraField | undefined;
  while (cursor < end) {
    requireRange(bytes, cursor, 4);
    const id = readU16(bytes, cursor);
    const size = readU16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + size > end) throw invalidDocument("OOXML ZIP extra field is invalid.");
    if (id === ZIP64_EXTRA_FIELD) {
      if (zip64) throw invalidDocument("OOXML ZIP contains duplicate ZIP64 extra fields.");
      zip64 = { payloadOffset: cursor, payloadLength: size };
    }
    cursor += size;
  }
  return zip64;
}

function resolveCentralZip64Values(
  bytes: Uint8Array,
  extra: Zip64ExtraField | undefined,
  fields: {
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    diskStart: number;
  },
): {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  diskStart: number;
} {
  const needsZip64 = fields.compressedSize === 0xffff_ffff ||
    fields.uncompressedSize === 0xffff_ffff ||
    fields.localHeaderOffset === 0xffff_ffff ||
    fields.diskStart === 0xffff;
  if (!needsZip64) return fields;
  if (!extra) throw invalidDocument("OOXML ZIP64 entry metadata is missing.");

  const end = extra.payloadOffset + extra.payloadLength;
  let cursor = extra.payloadOffset;
  const readRequiredU64 = (): number => {
    if (cursor + 8 > end) {
      throw invalidDocument("OOXML ZIP64 entry metadata is truncated.");
    }
    const value = readU64Safe(bytes, cursor);
    cursor += 8;
    if (value === undefined) {
      throw invalidDocument("OOXML ZIP64 entry metadata exceeds the safe integer range.");
    }
    return value;
  };
  const uncompressedSize = fields.uncompressedSize === 0xffff_ffff
    ? readRequiredU64()
    : fields.uncompressedSize;
  const compressedSize = fields.compressedSize === 0xffff_ffff
    ? readRequiredU64()
    : fields.compressedSize;
  const localHeaderOffset = fields.localHeaderOffset === 0xffff_ffff
    ? readRequiredU64()
    : fields.localHeaderOffset;
  let diskStart = fields.diskStart;
  if (diskStart === 0xffff) {
    if (cursor + 4 > end) {
      throw invalidDocument("OOXML ZIP64 entry metadata is truncated.");
    }
    diskStart = readU32(bytes, cursor);
    cursor += 4;
  }
  if (cursor !== end) {
    throw invalidDocument("OOXML ZIP64 entry metadata has an invalid length.");
  }
  return { compressedSize, uncompressedSize, localHeaderOffset, diskStart };
}

function resolveLocalZip64Sizes(
  bytes: Uint8Array,
  extra: Zip64ExtraField | undefined,
  fields: { compressedSize: number; uncompressedSize: number },
): { compressedSize: number; uncompressedSize: number } {
  const needsZip64 = fields.compressedSize === 0xffff_ffff ||
    fields.uncompressedSize === 0xffff_ffff;
  if (!needsZip64) return fields;
  if (!extra) throw invalidDocument("OOXML local ZIP64 entry metadata is missing.");

  const end = extra.payloadOffset + extra.payloadLength;
  let cursor = extra.payloadOffset;
  const readRequiredU64 = (): number => {
    if (cursor + 8 > end) {
      throw invalidDocument("OOXML local ZIP64 entry metadata is truncated.");
    }
    const value = readU64Safe(bytes, cursor);
    cursor += 8;
    if (value === undefined) {
      throw invalidDocument(
        "OOXML local ZIP64 entry metadata exceeds the safe integer range.",
      );
    }
    return value;
  };
  const uncompressedSize = fields.uncompressedSize === 0xffff_ffff
    ? readRequiredU64()
    : fields.uncompressedSize;
  const compressedSize = fields.compressedSize === 0xffff_ffff
    ? readRequiredU64()
    : fields.compressedSize;
  if (cursor !== end) {
    throw invalidDocument("OOXML local ZIP64 entry metadata has an invalid length.");
  }
  return { compressedSize, uncompressedSize };
}

function assertEntryRangesDoNotOverlap(
  entries: readonly ZipEntryIndex[],
  centralOffset: number,
): void {
  const sorted = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  let previousEnd = 0;
  for (const entry of sorted) {
    if (
      entry.localHeaderOffset < previousEnd ||
      entry.localHeaderOffset >= centralOffset ||
      entry.localRecordEnd > centralOffset
    ) {
      throw invalidDocument("OOXML ZIP entry ranges overlap or escape the archive.");
    }
    previousEnd = entry.localRecordEnd;
  }
}

function isUnixSymbolicLink(versionMadeBy: number, externalAttributes: number): boolean {
  const host = versionMadeBy >>> 8;
  const mode = externalAttributes >>> 16;
  return host === 3 && (mode & 0o170000) === 0o120000;
}

function concatenateBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function requireRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength ||
    length > bytes.byteLength - offset
  ) {
    throw invalidDocument("OOXML ZIP record is truncated.");
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4);
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readU64Safe(bytes: Uint8Array, offset: number): number | undefined {
  requireRange(bytes, offset, 8);
  const low = readU32(bytes, offset);
  const high = readU32(bytes, offset + 4);
  const value = high * 0x1_0000_0000 + low;
  return Number.isSafeInteger(value) ? value : undefined;
}

const crc32Table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

function archiveLimit(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("archive_limit", message);
}

function invalidDocument(message: string, cause?: unknown): AttachmentProcessingError {
  const error = new AttachmentProcessingError("invalid_document", message);
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}
