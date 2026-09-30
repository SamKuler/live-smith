import { TextDecoder } from "node:util";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import { BoundedDocumentTextBuilder, type ExtractedDocumentText } from "./document-text.js";
import { childElements, parseXmlPreservingOrder, type XmlElement, type XmlNode } from "./ooxml-xml.js";
import { openBoundedOoxmlZip } from "./ooxml-zip.js";

export type OdfMediaType =
  | "application/vnd.oasis.opendocument.text"
  | "application/vnd.oasis.opendocument.spreadsheet"
  | "application/vnd.oasis.opendocument.presentation";

const bodyByMediaType: Readonly<Record<OdfMediaType, string>> = {
  "application/vnd.oasis.opendocument.text": "office:text",
  "application/vnd.oasis.opendocument.spreadsheet": "office:spreadsheet",
  "application/vnd.oasis.opendocument.presentation": "office:presentation",
};
const namespaceAliases: Readonly<Record<string, string>> = {
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0": "presentation",
  "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0": "manifest",
  "urn:oasis:names:tc:opendocument:xmlns:script:1.0": "script",
  "http://www.w3.org/XML/1998/namespace": "xml",
};
const omittedTextElements = new Set([
  "office:annotation", "office:annotation-end", "text:tracked-changes",
  "text:deletion", "office:scripts", "script:event-listener",
]);
const MAX_ROW_NUMBER = 1_048_576;
const MAX_COLUMN_NUMBER = 16_384;
const macroElementNames = new Set([
  "office:script", "text:script", "script:script", "script:event-listener",
]);

interface OdfPackage {
  mediaType: OdfMediaType;
  body: XmlElement;
}

export async function openOdfPackage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<OdfPackage | undefined> {
  const archive = await openBoundedOoxmlZip(bytes, (name) =>
    name === "mimetype" || name === "META-INF/manifest.xml" || name === "content.xml", signal);
  const mimeBytes = archive.retainedEntries.get("mimetype");
  if (!mimeBytes) return undefined;
  let mediaType: string;
  try { mediaType = new TextDecoder("utf-8", { fatal: true }).decode(mimeBytes); }
  catch { throw invalidDocument("OpenDocument MIME metadata is invalid."); }
  if (!Object.hasOwn(bodyByMediaType, mediaType)) return undefined;
  const typedMediaType = mediaType as OdfMediaType;
  const manifestBytes = archive.retainedEntries.get("META-INF/manifest.xml");
  const contentBytes = archive.retainedEntries.get("content.xml");
  if (!manifestBytes || !contentBytes) throw invalidDocument("OpenDocument package metadata or content is missing.");
  const manifest = await normalizeRoot(manifestBytes, "manifest:manifest", signal);
  const fileEntries = childElements(manifest.children, "manifest:file-entry");
  const roots = fileEntries.filter((entry) => entry.attributes["manifest:full-path"] === "/");
  if (roots.length !== 1 || roots[0]!.attributes["manifest:media-type"] !== typedMediaType) {
    throw invalidDocument("OpenDocument manifest and MIME metadata disagree.");
  }
  if (containsElement(manifest, "manifest:encryption-data")) {
    throw new AttachmentProcessingError("encrypted_document", "Encrypted OpenDocument documents are not supported.");
  }
  if (archive.entryNames.some((name) => /^(?:Basic|Scripts)\//i.test(name))) throw macroEnabled();
  const root = await normalizeRoot(contentBytes, "office:document-content", signal);
  if (containsElement(root, macroElementNames)) throw macroEnabled();
  const bodies = childElements(root.children, "office:body");
  if (bodies.length !== 1) throw invalidDocument("OpenDocument body is missing or ambiguous.");
  const contentBodies = childElements(bodies[0]!.children);
  if (contentBodies.length !== 1 || contentBodies[0]!.name !== bodyByMediaType[typedMediaType]) {
    throw invalidDocument("OpenDocument content does not match its document kind.");
  }
  return { mediaType: typedMediaType, body: contentBodies[0]! };
}

export async function extractOdfText(
  document: OdfPackage,
  signal?: AbortSignal,
): Promise<ExtractedDocumentText> {
  throwIfAborted(signal);
  const builder = new BoundedDocumentTextBuilder();
  if (document.mediaType === "application/vnd.oasis.opendocument.spreadsheet") {
    await extractSpreadsheet(document.body, builder, signal);
  } else if (document.mediaType === "application/vnd.oasis.opendocument.presentation") {
    const slides = childElements(document.body.children, "draw:page");
    if (slides.length > 512) throw archiveLimit("OpenDocument slide count exceeds the safe limit.");
    for (let index = 0; index < slides.length; index += 1) {
      const slide = slides[index]!;
      builder.appendLine(`Slide ${index + 1}${slide.attributes["draw:name"] ? ` ${JSON.stringify(slide.attributes["draw:name"])}` : ""}`);
      await extractParagraphs(slide.children, builder, signal);
    }
  } else await extractParagraphs(document.body.children, builder, signal);
  return builder.finish();
}

async function normalizeRoot(bytes: Uint8Array, expected: string, signal?: AbortSignal): Promise<XmlElement> {
  const nodes = parseXmlPreservingOrder(bytes);
  let visited = 0;
  const normalize = async (node: XmlElement, inherited: Readonly<Record<string, string>>): Promise<XmlElement> => {
    visited += 1;
    if (visited % 256 === 0) await yieldToHost(signal);
    const namespaces: Record<string, string> = { ...inherited };
    for (const [name, value] of Object.entries(node.attributes)) {
      if (name === "xmlns") namespaces[""] = value;
      else if (name.startsWith("xmlns:")) namespaces[name.slice(6)] = value;
    }
    const expand = (name: string, attribute: boolean): string => {
      const colon = name.indexOf(":");
      if (colon < 0 && attribute) return name;
      const prefix = colon < 0 ? "" : name.slice(0, colon);
      const local = colon < 0 ? name : name.slice(colon + 1);
      const uri = namespaces[prefix];
      if (!uri) {
        if (prefix) throw invalidDocument("OpenDocument contains an undeclared XML namespace.");
        return local;
      }
      return `${namespaceAliases[uri] ?? uri}:${local}`;
    };
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(node.attributes)) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const expanded = expand(name, true);
      if (attributes[expanded] !== undefined) throw invalidDocument("OpenDocument has duplicate expanded attributes.");
      attributes[expanded] = value;
    }
    const children: XmlNode[] = [];
    for (const child of node.children) children.push(child.type === "text" ? child : await normalize(child, namespaces));
    return { type: "element", name: expand(node.name, false), attributes, children };
  };
  const roots = childElements(nodes);
  if (roots.length !== 1) throw invalidDocument("OpenDocument XML root is invalid.");
  const root = await normalize(roots[0]!, { xml: "http://www.w3.org/XML/1998/namespace" });
  if (root.name !== expected) throw invalidDocument("OpenDocument XML root or namespace is invalid.");
  await yieldToHost(signal);
  return root;
}

function containsElement(root: XmlElement, names: string | ReadonlySet<string>): boolean {
  return (typeof names === "string" ? root.name === names : names.has(root.name)) ||
    root.children.some((node) => node.type === "element" && containsElement(node, names));
}

async function extractParagraphs(nodes: readonly XmlNode[], builder: BoundedDocumentTextBuilder, signal?: AbortSignal): Promise<void> {
  let visited = 0;
  const visit = async (items: readonly XmlNode[]): Promise<void> => {
    for (const node of items) {
      if (node.type === "text") continue;
      visited += 1;
      if (visited % 128 === 0) await yieldToHost(signal);
      if (omittedTextElements.has(node.name)) continue;
      if (node.name === "text:p" || node.name === "text:h") {
        appendInline(node.children, builder);
        builder.appendLine();
      } else {
        if (node.name === "presentation:notes") builder.appendLine("Notes");
        await visit(node.children);
      }
    }
  };
  await visit(nodes);
  throwIfAborted(signal);
}

function appendInline(nodes: readonly XmlNode[], builder: BoundedDocumentTextBuilder): void {
  for (const node of nodes) {
    if (node.type === "text") { builder.append(node.value); continue; }
    if (omittedTextElements.has(node.name)) continue;
    if (node.name === "text:s") {
      const count = positiveInteger(node.attributes["text:c"], 1);
      builder.append(" ".repeat(Math.min(count, builder.maxCharacters + 1)));
    } else if (node.name === "text:tab") builder.append("\t");
    else if (node.name === "text:line-break") builder.append("\n");
    else appendInline(node.children, builder);
  }
}

interface OdfCell { column: number; repeat: number; value: string; formula?: string }

async function extractSpreadsheet(body: XmlElement, builder: BoundedDocumentTextBuilder, signal?: AbortSignal): Promise<void> {
  const tables = childElements(body.children, "table:table");
  if (tables.length > 64) throw archiveLimit("OpenDocument sheet count exceeds the safe limit.");
  for (const table of tables) {
    builder.appendLine(`Sheet ${JSON.stringify(table.attributes["table:name"] ?? "")}`);
    if (table.attributes["table:display"] === "false") { builder.appendLine("[hidden sheet omitted]"); continue; }
    let rowNumber = 1;
    let physicalRows = 0;
    let physicalCells = 0;
    const rows = (nodes: readonly XmlNode[]): XmlElement[] => {
      const found: XmlElement[] = [];
      for (const node of childElements(nodes)) {
        if (node.name === "table:table-row") found.push(node);
        else if (["table:table-header-rows", "table:table-rows", "table:table-row-group"].includes(node.name)) found.push(...rows(node.children));
      }
      return found;
    };
    for (const row of rows(table.children)) {
      await yieldToHost(signal);
      physicalRows += 1;
      if (physicalRows > 10_000) throw archiveLimit("OpenDocument row count exceeds the safe limit.");
      const repeatRows = positiveInteger(row.attributes["table:number-rows-repeated"], 1);
      if (rowNumber + repeatRows - 1 > MAX_ROW_NUMBER) throw archiveLimit("OpenDocument row coordinates exceed the safe limit.");
      const cells: OdfCell[] = [];
      let column = 1;
      for (const cell of childElements(row.children)) {
        if (cell.name !== "table:table-cell" && cell.name !== "table:covered-table-cell") continue;
        physicalCells += 1;
        if (physicalCells > 50_000) throw archiveLimit("OpenDocument cell count exceeds the safe limit.");
        const repeat = positiveInteger(cell.attributes["table:number-columns-repeated"], 1);
        if (column + repeat - 1 > MAX_COLUMN_NUMBER) throw archiveLimit("OpenDocument column coordinates exceed the safe limit.");
        const value = cell.name === "table:covered-table-cell" ? "" : cellValue(cell);
        const formula = cell.attributes["table:formula"];
        if (value !== "" || formula !== undefined) cells.push({ column, repeat, value, ...(formula === undefined ? {} : { formula }) });
        column += repeat;
      }
      if (row.attributes["table:visibility"] === "collapse" || row.attributes["table:visibility"] === "filter") {
        builder.appendLine(`Row ${rowNumber}${repeatRows > 1 ? `–${rowNumber + repeatRows - 1}` : ""}: [hidden row omitted]`);
      } else if (cells.length > 0) {
        for (let index = 0; index < repeatRows; index += 1) {
          if (index % 128 === 0) await yieldToHost(signal);
          const coordinateRow = rowNumber + index;
          builder.append(`Row ${coordinateRow}: `);
          let first = true;
          for (const cell of cells) {
            for (let repeated = 0; repeated < cell.repeat; repeated += 1) {
              if (!first) builder.append("\t");
              first = false;
              const reference = `${columnName(cell.column + repeated)}${coordinateRow}`;
              builder.append(`${reference}=${JSON.stringify(cell.value)}`);
              if (cell.formula !== undefined) builder.append(` [formula ${JSON.stringify(cell.formula)}]`);
              if (builder.truncated) break;
            }
            if (builder.truncated) break;
          }
          builder.appendLine();
          if (builder.truncated) break;
        }
      }
      rowNumber += repeatRows;
    }
  }
}

function cellValue(cell: XmlElement): string {
  const text = new BoundedDocumentTextBuilder();
  const paragraphs = childElements(cell.children).filter((node) => node.name === "text:p" || node.name === "text:h");
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (index > 0) text.append("\n");
    appendInline(paragraphs[index]!.children, text);
  }
  if (text.characterCount > 0) return text.finish().text;
  const kind = cell.attributes["office:value-type"];
  if (kind === "boolean") return cell.attributes["office:boolean-value"] ?? "";
  if (kind === "date") return cell.attributes["office:date-value"] ?? "";
  if (kind === "time") return cell.attributes["office:time-value"] ?? "";
  if (kind === "string") return cell.attributes["office:string-value"] ?? "";
  return cell.attributes["office:value"] ?? "";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,9}$/.test(value)) throw invalidDocument("OpenDocument repetition count is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidDocument("OpenDocument repetition count is invalid.");
  return parsed;
}
function columnName(column: number): string {
  let result = "";
  while (column > 0) { column -= 1; result = String.fromCharCode(65 + column % 26) + result; column = Math.floor(column / 26); }
  return result;
}
function invalidDocument(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function archiveLimit(message: string): AttachmentProcessingError { return new AttachmentProcessingError("archive_limit", message); }
function macroEnabled(): AttachmentProcessingError { return new AttachmentProcessingError("macro_enabled", "Macro-enabled OpenDocument documents are not supported."); }
