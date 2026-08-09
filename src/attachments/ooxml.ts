import { TextDecoder } from "node:util";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { UnzipInflate } from "fflate";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./processor.js";

export const MAX_OOXML_ENTRY_COUNT = 2_048;
export const MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_OOXML_COMPRESSION_RATIO = 200;

const MAX_XML_NESTED_TAGS = 256;
const MAX_XML_NODE_COUNT = 100_000;
const INFLATE_INPUT_CHUNK_BYTES = 1 * 1024;
const MAX_XML_LEXICAL_TOKEN_COUNT = 200_000;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_EXTRA_FIELD = 0x0001;

const mainPartByKind = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
} as const;

const mainContentTypeByKind = {
  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
} as const;

const packageRelationshipsNamespaces = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://purl.oclc.org/ooxml/package/relationships",
]);
const officeDocumentRelationshipTypes = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const contentTypesNamespace =
  "http://schemas.openxmlformats.org/package/2006/content-types";

export type OoxmlKind = keyof typeof mainPartByKind;

export interface OoxmlPackage {
  kind: OoxmlKind;
  entries: ReadonlyMap<string, Uint8Array>;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlElement {
  type: "element";
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly XmlNode[];
}

export interface XmlText {
  type: "text";
  value: string;
}

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
}

interface ParsedXmlDocument {
  nodes: readonly XmlNode[];
  encoding: XmlEncoding;
}

type XmlEncoding = "utf-8" | "utf-16le" | "utf-16be" | "string";

export async function openOoxmlPackage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<OoxmlPackage> {
  throwIfAborted(signal);
  const index = parseCentralDirectory(bytes);
  if (index.some((entry) => isActiveOfficePart(entry.name))) {
    throw new AttachmentProcessingError(
      "macro_enabled",
      "Macro-enabled or active-content Office documents are not supported.",
    );
  }
  const entries = new Map<string, Uint8Array>();
  let totalActualBytes = 0;

  for (const entry of index) {
    throwIfAborted(signal);
    if (entry.isDirectory) continue;
    const keep = isAllowedXmlPart(entry.name);
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
    if (keep) entries.set(entry.name, concatenateBytes(chunks, actualBytes));
  }

  const contentTypesBytes = entries.get("[Content_Types].xml");
  const rootRelationshipsBytes = entries.get("_rels/.rels");
  if (!contentTypesBytes || !rootRelationshipsBytes) {
    throw invalidDocument("OOXML package metadata is missing.");
  }
  const contentTypes = parseXmlBytes(contentTypesBytes).nodes;
  await yieldToHost(signal);
  const rootRelationships = parseXmlBytes(rootRelationshipsBytes).nodes;
  await yieldToHost(signal);
  const kind = resolvePackageKind(contentTypes, rootRelationships, entries);
  for (const [name, xmlBytes] of entries) {
    if (name === "[Content_Types].xml" || name === "_rels/.rels") continue;
    parseXmlBytes(xmlBytes);
    await yieldToHost(signal);
  }
  return { kind, entries };
}

export function parseXmlPreservingOrder(input: string | Uint8Array): readonly XmlNode[] {
  return typeof input === "string"
    ? parseXmlText(input, "string").nodes
    : parseXmlBytes(input).nodes;
}

export function collectTextNodes(nodes: readonly XmlNode[]): string[] {
  const values: string[] = [];
  const visit = (items: readonly XmlNode[]): void => {
    for (const node of items) {
      if (node.type === "text") values.push(node.value);
      else visit(node.children);
    }
  };
  visit(nodes);
  return values;
}

export function childElements(
  nodes: readonly XmlNode[],
  name?: string,
): XmlElement[] {
  return nodes.filter((node): node is XmlElement =>
    node.type === "element" && (name === undefined || node.name === name)
  );
}

export function descendantElements(
  nodes: readonly XmlNode[],
  name: string,
): XmlElement[] {
  const elements: XmlElement[] = [];
  const visit = (items: readonly XmlNode[]): void => {
    for (const node of items) {
      if (node.type === "text") continue;
      if (node.name === name) elements.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return elements;
}

function rootElements(nodes: readonly XmlNode[], name: string): XmlElement[] {
  const elements = childElements(nodes);
  return elements.length === 1 && elements[0]?.name === name ? elements : [];
}

export function naturalPartOrder(left: string, right: string): number {
  const leftParts = naturalTokens(left);
  const rightParts = naturalTokens(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return a - b;
      continue;
    }
    const compared = String(a).localeCompare(String(b), "en", {
      sensitivity: "variant",
    });
    if (compared) return compared;
  }
  return left.localeCompare(right, "en", { sensitivity: "variant" });
}

function parseCentralDirectory(bytes: Uint8Array): ZipEntryIndex[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    throw invalidDocument("OOXML ZIP data is truncated.");
  }
  let closestError: AttachmentProcessingError | undefined;
  for (const eocdOffset of endOfCentralDirectoryCandidates(bytes)) {
    try {
      return parseCentralDirectoryAt(bytes, eocdOffset);
    } catch (error) {
      if (!(error instanceof AttachmentProcessingError)) throw error;
      closestError ??= error;
    }
  }
  throw closestError ?? invalidDocument(
    "OOXML end-of-central-directory record is invalid.",
  );
}

function parseCentralDirectoryAt(
  bytes: Uint8Array,
  eocdOffset: number,
): ZipEntryIndex[] {
  const diskNumber = readU16(bytes, eocdOffset + 4);
  const centralDisk = readU16(bytes, eocdOffset + 6);
  const diskEntryCount = readU16(bytes, eocdOffset + 8);
  const entryCount = readU16(bytes, eocdOffset + 10);
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    throw invalidDocument("Multi-disk OOXML ZIP containers are not supported.");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw archiveLimit("ZIP64 OOXML containers are not supported.");
  }
  if (entryCount === 0 || entryCount > MAX_OOXML_ENTRY_COUNT) {
    throw archiveLimit("OOXML ZIP entry count exceeds the safe limit.");
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
    requireRange(bytes, cursor, 46);
    if (readU32(bytes, cursor) !== ZIP_CENTRAL_FILE_HEADER) {
      throw invalidDocument("OOXML central directory entry is invalid.");
    }
    const versionMadeBy = readU16(bytes, cursor + 4);
    const flags = readU16(bytes, cursor + 8);
    const compression = readU16(bytes, cursor + 10);
    const crc32 = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const diskStart = readU16(bytes, cursor + 34);
    const externalAttributes = readU32(bytes, cursor + 38);
    const localHeaderOffset = readU32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, cursor, recordLength);
    if (cursor + recordLength > centralOffset + centralSize || diskStart !== 0) {
      throw invalidDocument("OOXML central directory entry range is invalid.");
    }
    rejectZip64Extra(bytes, cursor + 46 + nameLength, extraLength);
    assertSupportedFlags(flags);
    if (compression !== 0 && compression !== 8) {
      throw invalidDocument("OOXML ZIP compression method is not supported.");
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw archiveLimit("ZIP64 OOXML entries are not supported.");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const { name, isDirectory } = normalizeEntryName(rawName);
    if (names.has(name)) {
      throw archiveLimit("OOXML ZIP contains duplicate normalized entry names.");
    }
    names.add(name);
    if (isUnixSymbolicLink(versionMadeBy, externalAttributes)) {
      throw archiveLimit("OOXML ZIP symbolic-link entries are not supported.");
    }
    if (uncompressedSize > MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES) {
      throw archiveLimit("OOXML ZIP entry exceeds the safe expanded size.");
    }
    totalDeclaredBytes += uncompressedSize;
    if (totalDeclaredBytes > MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES) {
      throw archiveLimit("OOXML ZIP expanded data exceeds the safe total size.");
    }
    if (
      uncompressedSize > Math.max(compressedSize, 1_024) *
        MAX_OOXML_COMPRESSION_RATIO
    ) {
      throw archiveLimit("OOXML ZIP entry compression ratio exceeds the safe limit.");
    }

    const local = parseLocalHeader(bytes, {
      name,
      flags,
      compression: compression as 0 | 8,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      centralOffset,
      rawName,
    });
    if (isDirectory && uncompressedSize !== 0) {
      throw invalidDocument("OOXML ZIP directory entry contains file data.");
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
    });
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw invalidDocument("OOXML central directory size is inconsistent.");
  }
  assertEntryRangesDoNotOverlap(entries, centralOffset);
  return entries;
}

function parseLocalHeader(
  bytes: Uint8Array,
  expected: {
    name: string;
    flags: number;
    compression: 0 | 8;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    centralOffset: number;
    rawName: Uint8Array;
  },
): { dataOffset: number; dataEnd: number } {
  requireRange(bytes, expected.localHeaderOffset, 30);
  if (readU32(bytes, expected.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw invalidDocument("OOXML local ZIP header is invalid.");
  }
  const flags = readU16(bytes, expected.localHeaderOffset + 6);
  const compression = readU16(bytes, expected.localHeaderOffset + 8);
  const crc32 = readU32(bytes, expected.localHeaderOffset + 14);
  const compressedSize = readU32(bytes, expected.localHeaderOffset + 18);
  const uncompressedSize = readU32(bytes, expected.localHeaderOffset + 22);
  const nameLength = readU16(bytes, expected.localHeaderOffset + 26);
  const extraLength = readU16(bytes, expected.localHeaderOffset + 28);
  const headerLength = 30 + nameLength + extraLength;
  requireRange(bytes, expected.localHeaderOffset, headerLength);
  const localName = bytes.subarray(
    expected.localHeaderOffset + 30,
    expected.localHeaderOffset + 30 + nameLength,
  );
  rejectZip64Extra(
    bytes,
    expected.localHeaderOffset + 30 + nameLength,
    extraLength,
  );
  if (
    flags !== expected.flags ||
    compression !== expected.compression ||
    crc32 !== expected.crc32 ||
    compressedSize !== expected.compressedSize ||
    uncompressedSize !== expected.uncompressedSize ||
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
  return { dataOffset, dataEnd };
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

function parseXmlBytes(bytes: Uint8Array): ParsedXmlDocument {
  const decoded = decodeXml(bytes);
  return parseXmlText(decoded.text, decoded.encoding);
}

function parseXmlText(text: string, encoding: XmlEncoding): ParsedXmlDocument {
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    throw invalidDocument("OOXML DTD and entity declarations are not supported.");
  }
  const withoutDeclaration = text.replace(/^\uFEFF?<\?xml\s[^?]*\?>/i, "");
  if (/<\?(?!xml(?:\s|\?>))/i.test(withoutDeclaration)) {
    throw invalidDocument("OOXML processing instructions are not supported.");
  }
  assertXmlLexicalBudget(text);
  const validation = XMLValidator.validate(text, {
    allowBooleanAttributes: false,
  });
  if (validation !== true) {
    throw invalidDocument("OOXML XML is malformed.");
  }
  try {
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      processEntities: false,
      allowBooleanAttributes: false,
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      maxNestedTags: MAX_XML_NESTED_TAGS,
    });
    const parsed = parser.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw invalidDocument("OOXML XML root is invalid.");
    let nodeCount = 0;
    const nodes = normalizeParsedNodes(parsed, 0, () => {
      nodeCount += 1;
      if (nodeCount > MAX_XML_NODE_COUNT) {
        throw archiveLimit("OOXML XML node count exceeds the safe limit.");
      }
    });
    return { nodes, encoding };
  } catch (cause) {
    if (cause instanceof AttachmentProcessingError) throw cause;
    throw invalidDocument("OOXML XML could not be parsed safely.", cause);
  }
}

function assertXmlLexicalBudget(text: string): void {
  let tokens = 0;
  let insideMarkup = false;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (!insideMarkup) {
      if (character === "<") {
        insideMarkup = true;
        tokens += 1;
      } else if (character === "&") {
        tokens += 1;
      }
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      tokens += 1;
    } else if (character === ">") {
      insideMarkup = false;
    }
    if (tokens > MAX_XML_LEXICAL_TOKEN_COUNT) {
      throw archiveLimit("OOXML XML token count exceeds the safe limit.");
    }
  }
}

function normalizeParsedNodes(
  values: readonly unknown[],
  depth: number,
  countNode: () => void,
): XmlNode[] {
  if (depth > MAX_XML_NESTED_TAGS) {
    throw archiveLimit("OOXML XML nesting exceeds the safe limit.");
  }
  const nodes: XmlNode[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidDocument("OOXML XML parser returned an invalid node.");
    }
    const record = value as Record<string, unknown>;
    const attributes = normalizeAttributes(record[":@"]);
    const names = Object.keys(record).filter((key) => key !== ":@");
    if (names.length !== 1) {
      throw invalidDocument("OOXML XML parser returned an ambiguous node.");
    }
    const name = names[0]!;
    const child = record[name];
    countNode();
    if (name === "#text") {
      if (typeof child !== "string" || Object.keys(attributes).length) {
        throw invalidDocument("OOXML XML text node is invalid.");
      }
      nodes.push({ type: "text", value: decodeXmlEntities(child) });
      continue;
    }
    if (!Array.isArray(child)) {
      throw invalidDocument("OOXML XML element children are invalid.");
    }
    nodes.push({
      type: "element",
      name,
      attributes,
      children: normalizeParsedNodes(child, depth + 1, countNode),
    });
  }
  return nodes;
}

function normalizeAttributes(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDocument("OOXML XML attributes are invalid.");
  }
  const attributes: Record<string, string> = {};
  for (const [name, attribute] of Object.entries(value)) {
    if (typeof attribute !== "string") {
      throw invalidDocument("OOXML XML attribute value is invalid.");
    }
    attributes[name.startsWith("@_") ? name.slice(2) : name] =
      decodeXmlEntities(attribute);
  }
  return Object.freeze(attributes);
}

function decodeXml(bytes: Uint8Array): { text: string; encoding: XmlEncoding } {
  let encoding: Exclude<XmlEncoding, "string"> = "utf-8";
  let offset = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    offset = 3;
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = "utf-16le";
    offset = 2;
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    encoding = "utf-16be";
    offset = 2;
  } else if (
    bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[3] === 0x00
  ) {
    encoding = "utf-16le";
  } else if (
    bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00
  ) {
    encoding = "utf-16be";
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true })
      .decode(bytes.subarray(offset));
  } catch (cause) {
    throw invalidDocument("OOXML XML encoding is invalid.", cause);
  }
  const declaration = /^<\?xml\s+([^?]*)\?>/i.exec(text);
  const declaredEncoding = declaration?.[1]
    ?.match(/\bencoding\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
  if (declaredEncoding && !encodingMatchesDeclaration(encoding, declaredEncoding)) {
    throw invalidDocument("OOXML XML encoding declaration disagrees with its bytes.");
  }
  return { text, encoding };
}

function resolvePackageKind(
  contentTypes: readonly XmlNode[],
  rootRelationships: readonly XmlNode[],
  entries: ReadonlyMap<string, Uint8Array>,
): OoxmlKind {
  const contentTypeRoots = rootElements(contentTypes, "Types");
  if (
    contentTypeRoots.length !== 1 ||
    contentTypeRoots[0]!.attributes.xmlns !== contentTypesNamespace
  ) {
    throw invalidDocument("OOXML content-types namespace is invalid.");
  }
  const relationshipRoots = rootElements(rootRelationships, "Relationships");
  if (
    relationshipRoots.length !== 1 ||
    !packageRelationshipsNamespaces.has(
      relationshipRoots[0]!.attributes.xmlns ?? "",
    )
  ) {
    throw invalidDocument("OOXML package-relationships namespace is invalid.");
  }
  const officeRelationships = childElements(
    relationshipRoots[0]!.children,
    "Relationship",
  ).filter((relationship) =>
    officeDocumentRelationshipTypes.has(relationship.attributes.Type ?? "")
  );
  if (officeRelationships.length !== 1) {
    throw invalidDocument("OOXML must contain exactly one main Office document relationship.");
  }
  const officeRelationship = officeRelationships[0]!;
  if (
    officeRelationship.attributes.TargetMode !== undefined &&
    officeRelationship.attributes.TargetMode.toLowerCase() !== "internal"
  ) {
    throw invalidDocument("OOXML main document relationship must be internal.");
  }
  const target = normalizeRelationshipTarget(officeRelationship.attributes.Target);
  const kind = (Object.entries(mainPartByKind) as [OoxmlKind, string][])
    .find(([, mainPart]) => target === mainPart)?.[0];
  if (!kind || !entries.has(mainPartByKind[kind])) {
    throw invalidDocument("OOXML main document part is invalid.");
  }

  const overrides = childElements(contentTypeRoots[0]!.children, "Override");
  for (const override of overrides) {
    if (/macroenabled|vba/i.test(override.attributes.ContentType ?? "")) {
      throw new AttachmentProcessingError(
        "macro_enabled",
        "Macro-enabled Office documents are not supported.",
      );
    }
  }
  const matching = overrides.filter((override) =>
    override.attributes.PartName === `/${mainPartByKind[kind]}` &&
    override.attributes.ContentType === mainContentTypeByKind[kind]
  );
  const supportedMainOverrides = overrides.filter((override) =>
    (Object.values(mainContentTypeByKind) as string[]).includes(
      override.attributes.ContentType ?? "",
    )
  );
  if (matching.length !== 1 || supportedMainOverrides.length !== 1) {
    throw invalidDocument("OOXML content types do not identify one supported document kind.");
  }
  if ([...entries.keys()].some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) {
    throw new AttachmentProcessingError(
      "macro_enabled",
      "Macro-enabled Office documents are not supported.",
    );
  }
  return kind;
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

function normalizeEntryName(raw: Uint8Array): { name: string; isDirectory: boolean } {
  if (!raw.byteLength || raw.some((value) => value < 0x20 || value > 0x7e)) {
    throw archiveLimit("OOXML ZIP entry name is invalid.");
  }
  const decoded = String.fromCharCode(...raw).replaceAll("\\", "/");
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

function normalizeRelationshipTarget(value: string | undefined): string {
  if (!value) throw invalidDocument("OOXML relationship target is missing.");
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw invalidDocument("OOXML relationship target is invalid.");
  }
  return normalized;
}

function isAllowedXmlPart(name: string): boolean {
  return name === "[Content_Types].xml" ||
    name.endsWith(".xml") ||
    name.endsWith(".rels");
}

function isActiveOfficePart(name: string): boolean {
  return /(?:^|\/)vbaProject\.bin$/i.test(name) ||
    /(?:^|\/)activeX(?:\/|$)/i.test(name) ||
    /(?:^|\/)macrosheets?(?:\/|$)/i.test(name);
}

function assertSupportedFlags(flags: number): void {
  if (flags & 0x0001 || flags & 0x0040) {
    throw new AttachmentProcessingError(
      "encrypted_document",
      "Encrypted Office documents are not supported.",
    );
  }
  // Data descriptors complicate local/central integrity comparison. OOXML files
  // with explicit local sizes are deterministic and sufficient for this boundary.
  if (flags & 0x0008 || (flags & ~0x0800) !== 0) {
    throw invalidDocument("OOXML ZIP flags are not supported.");
  }
}

function rejectZip64Extra(bytes: Uint8Array, offset: number, length: number): void {
  requireRange(bytes, offset, length);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    requireRange(bytes, cursor, 4);
    const id = readU16(bytes, cursor);
    const size = readU16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + size > end) throw invalidDocument("OOXML ZIP extra field is invalid.");
    if (id === ZIP64_EXTRA_FIELD) {
      throw archiveLimit("ZIP64 OOXML entries are not supported.");
    }
    cursor += size;
  }
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
      entry.dataEnd > centralOffset
    ) {
      throw invalidDocument("OOXML ZIP entry ranges overlap or escape the archive.");
    }
    previousEnd = entry.dataEnd;
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

function naturalTokens(value: string): (string | number)[] {
  return value.split(/(\d+)/).filter(Boolean).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part
  );
}

function encodingMatchesDeclaration(
  actual: Exclude<XmlEncoding, "string">,
  declared: string,
): boolean {
  if (actual === "utf-8") return declared === "utf-8" || declared === "utf8";
  if (declared === "utf-16") return true;
  return actual === declared;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi,
    (entity, token: string) => {
      const predefined: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      const replacement = predefined[token.toLowerCase()];
      if (replacement !== undefined) return replacement;
      const hexadecimal = token.toLowerCase().startsWith("#x");
      const digits = token.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        !isXml10CodePoint(codePoint)
      ) {
        throw invalidDocument(`OOXML XML numeric entity is invalid: ${entity}.`);
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function isXml10CodePoint(codePoint: number): boolean {
  return codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
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
