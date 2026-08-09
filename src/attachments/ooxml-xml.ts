import { TextDecoder } from "node:util";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import {
  AttachmentProcessingError,
  MAX_OOXML_XML_PART_BYTES,
} from "./contracts.js";

const MAX_XML_NESTED_TAGS = 256;
const MAX_XML_NODE_COUNT = 100_000;
const MAX_XML_PART_BYTES_OR_CODE_UNITS = MAX_OOXML_XML_PART_BYTES;
const MAX_XML_ATTRIBUTE_COUNT = 100_000;
const MAX_XML_ENTITY_REFERENCE_COUNT = 100_000;
const strictXmlDeclarationPattern =
  /^<\?xml[\t\r\n ]+version[\t\r\n ]*=[\t\r\n ]*(?:"1\.0"|'1\.0')(?:[\t\r\n ]+encoding[\t\r\n ]*=[\t\r\n ]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[\t\r\n ]+standalone[\t\r\n ]*=[\t\r\n ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\r\n ]*\?>$/;

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

interface ParsedXmlDocument {
  nodes: readonly XmlNode[];
  encoding: XmlEncoding;
}

type XmlEncoding = "utf-8" | "utf-16le" | "utf-16be" | "string";

export function parseXmlPreservingOrder(input: string | Uint8Array): readonly XmlNode[] {
  return typeof input === "string"
    ? parseXmlText(input, "string").nodes
    : parseXmlBytesPreservingOrder(input).nodes;
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

export function parseXmlBytesPreservingOrder(bytes: Uint8Array): ParsedXmlDocument {
  if (bytes.byteLength > MAX_XML_PART_BYTES_OR_CODE_UNITS) {
    throw archiveLimit("OOXML XML part exceeds the safe size limit.");
  }
  const decoded = decodeXml(bytes);
  return parseXmlText(decoded.text, decoded.encoding);
}

function parseXmlText(text: string, encoding: XmlEncoding): ParsedXmlDocument {
  if (text.length > MAX_XML_PART_BYTES_OR_CODE_UNITS) {
    throw archiveLimit("OOXML XML text exceeds the safe size limit.");
  }
  const declaredEncoding = assertSafeXmlLexicalStructure(text);
  if (
    encoding !== "string" &&
    declaredEncoding !== undefined &&
    !encodingMatchesDeclaration(encoding, declaredEncoding)
  ) {
    throw invalidDocument("OOXML XML encoding declaration disagrees with its bytes.");
  }
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
      cdataPropName: "#cdata",
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

function assertSafeXmlLexicalStructure(text: string): string | undefined {
  const declarationOffset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cursor = declarationOffset;
  let declaredEncoding: string | undefined;
  if (text.startsWith("<?xml", cursor)) {
    const end = text.indexOf("?>", cursor + 5);
    if (end < 0) throw invalidDocument("OOXML XML declaration is malformed.");
    const declaration = text.slice(cursor, end + 2);
    if (!strictXmlDeclarationPattern.test(declaration)) {
      throw invalidDocument("OOXML XML declaration is malformed.");
    }
    declaredEncoding = /[\t\r\n ]encoding[\t\r\n ]*=[\t\r\n ]*["']([^"']+)["']/
      .exec(declaration)?.[1]?.toLowerCase();
    cursor = end + 2;
  }

  let potentialNodes = 0;
  let attributes = 0;
  let entityReferences = 0;
  let depth = 0;
  let insideTextNode = false;
  const countPotentialNode = (): void => {
    potentialNodes += 1;
    if (potentialNodes > MAX_XML_NODE_COUNT) {
      throw archiveLimit("OOXML XML node count exceeds the safe limit.");
    }
  };
  const countAttribute = (): void => {
    attributes += 1;
    if (attributes > MAX_XML_ATTRIBUTE_COUNT) {
      throw archiveLimit("OOXML XML attribute count exceeds the safe limit.");
    }
  };
  const countEntityReference = (): void => {
    entityReferences += 1;
    if (entityReferences > MAX_XML_ENTITY_REFERENCE_COUNT) {
      throw archiveLimit("OOXML XML entity count exceeds the safe limit.");
    }
  };

  while (cursor < text.length) {
    if (text.startsWith("<!--", cursor)) {
      countPotentialNode();
      const end = text.indexOf("-->", cursor + 4);
      if (end < 0) throw invalidDocument("OOXML XML comment is not closed.");
      assertXml10Range(text, cursor, end + 3);
      cursor = end + 3;
      insideTextNode = false;
      continue;
    }
    if (text.startsWith("<![CDATA[", cursor)) {
      countPotentialNode();
      const end = text.indexOf("]]>", cursor + 9);
      if (end < 0) throw invalidDocument("OOXML XML CDATA is not closed.");
      assertXml10Range(text, cursor, end + 3);
      cursor = end + 3;
      insideTextNode = false;
      continue;
    }
    if (text.startsWith("<?", cursor)) {
      throw invalidDocument("OOXML processing instructions are not supported.");
    }
    if (text.startsWith("<!", cursor)) {
      throw invalidDocument("OOXML DTD and markup declarations are not supported.");
    }
    if (text[cursor] === "<") {
      const closing = text.startsWith("</", cursor);
      if (!closing) countPotentialNode();
      const markup = scanXmlMarkup(
        text,
        cursor,
        countAttribute,
        countEntityReference,
      );
      if (closing) {
        depth -= 1;
        if (depth < 0) throw invalidDocument("OOXML XML element nesting is invalid.");
      } else if (!markup.selfClosing) {
        depth += 1;
        if (depth > MAX_XML_NESTED_TAGS) {
          throw archiveLimit("OOXML XML nesting exceeds the safe limit.");
        }
      }
      cursor = markup.end;
      insideTextNode = false;
      continue;
    }
    if (text[cursor] === "&") {
      if (!insideTextNode) {
        countPotentialNode();
        insideTextNode = true;
      }
      countEntityReference();
      cursor = consumeXmlEntityReference(text, cursor);
      continue;
    }
    if (!insideTextNode) {
      countPotentialNode();
      insideTextNode = true;
    }
    cursor = advancePastXml10CodePoint(text, cursor);
  }
  if (depth !== 0) throw invalidDocument("OOXML XML element nesting is invalid.");
  return declaredEncoding;
}

function scanXmlMarkup(
  text: string,
  start: number,
  countAttribute: () => void,
  countEntityReference: () => void,
): { end: number; selfClosing: boolean } {
  let cursor = start + 1;
  let quote: '"' | "'" | undefined;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        cursor += 1;
      } else if (character === "&") {
        countEntityReference();
        cursor = consumeXmlEntityReference(text, cursor);
      } else {
        cursor = advancePastXml10CodePoint(text, cursor);
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === "=") countAttribute();
    if (character === "&") {
      countEntityReference();
      cursor = consumeXmlEntityReference(text, cursor);
      continue;
    }
    if (character === ">") {
      const selfClosing = /\/\s*$/.test(text.slice(start + 1, cursor));
      return { end: cursor + 1, selfClosing };
    }
    cursor = advancePastXml10CodePoint(text, cursor);
  }
  throw invalidDocument("OOXML XML markup is not closed.");
}

function consumeXmlEntityReference(text: string, start: number): number {
  const semicolon = text.indexOf(";", start + 1);
  if (semicolon < 0) {
    throw invalidDocument("OOXML XML contains an invalid entity reference.");
  }
  const token = text.slice(start + 1, semicolon);
  if (/^(?:amp|lt|gt|quot|apos)$/.test(token)) return semicolon + 1;
  const numeric = /^(?:#(\d+)|#x([0-9a-fA-F]+))$/.exec(token);
  if (!numeric) {
    throw invalidDocument("OOXML XML contains an unsupported entity reference.");
  }
  const codePoint = Number.parseInt(
    numeric[1] ?? numeric[2]!,
    numeric[1] === undefined ? 16 : 10,
  );
  if (!Number.isInteger(codePoint) || !isXml10CodePoint(codePoint)) {
    throw invalidDocument("OOXML XML numeric entity is invalid.");
  }
  return semicolon + 1;
}

function assertXml10Range(text: string, start: number, end: number): void {
  for (let cursor = start; cursor < end;) {
    cursor = advancePastXml10CodePoint(text, cursor);
  }
}

function advancePastXml10CodePoint(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined || !isXml10CodePoint(codePoint)) {
    throw invalidDocument("OOXML XML contains an invalid character.");
  }
  return offset + (codePoint > 0xffff ? 2 : 1);
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
    if (name === "#cdata") {
      if (
        Object.keys(attributes).length ||
        !Array.isArray(child) ||
        child.length !== 1
      ) {
        throw invalidDocument("OOXML XML CDATA node is invalid.");
      }
      const cdata = child[0];
      if (
        typeof cdata !== "object" ||
        cdata === null ||
        Array.isArray(cdata) ||
        typeof (cdata as Record<string, unknown>)["#text"] !== "string"
      ) {
        throw invalidDocument("OOXML XML CDATA text is invalid.");
      }
      nodes.push({
        type: "text",
        value: (cdata as Record<string, string>)["#text"]!,
      });
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
  return { text, encoding };
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
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g,
    (_entity, token: string) => {
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
        throw invalidDocument("OOXML XML numeric entity is invalid.");
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

function archiveLimit(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("archive_limit", message);
}

function invalidDocument(message: string, cause?: unknown): AttachmentProcessingError {
  const error = new AttachmentProcessingError("invalid_document", message);
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}
