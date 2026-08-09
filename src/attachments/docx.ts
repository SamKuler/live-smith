import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import {
  BoundedDocumentTextBuilder,
  type ExtractedDocumentText,
} from "./document-text.js";
import {
  childElements,
  parseXmlPreservingOrder,
  type OoxmlPackage,
  type XmlElement,
  type XmlNode,
} from "./ooxml.js";

const DOCX_MAIN_PART = "word/document.xml";
const INVALID_DOCX_MESSAGE =
  "The DOCX attachment is not a valid supported document.";
const TRAVERSAL_YIELD_INTERVAL = 256;
const WORDPROCESSINGML_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const EXCLUDED_REVISION_ELEMENTS = new Set(["w:del", "w:moveFrom"]);

export async function extractDocxText(input: {
  officePackage: OoxmlPackage;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  throwIfAborted(input.signal);
  try {
    if (input.officePackage.kind !== "docx") throw invalidDocx();
    const documentBytes = input.officePackage.entries.get(DOCX_MAIN_PART);
    if (documentBytes === undefined) throw invalidDocx();

    const nodes = parseXmlPreservingOrder(documentBytes);
    const roots = childElements(nodes);
    if (roots.length !== 1 || roots[0]!.name !== "w:document") {
      throw invalidDocx();
    }
    const root = roots[0]!;
    const namespace = root.attributes["xmlns:w"];
    if (
      namespace === undefined ||
      !WORDPROCESSINGML_NAMESPACES.has(namespace)
    ) {
      throw invalidDocx();
    }
    const bodies = childElements(root.children, "w:body");
    if (bodies.length !== 1) throw invalidDocx();

    const checkpoint = new TraversalCheckpoint(input.signal);
    await assertStableWordPrefix([root], namespace, checkpoint);

    const writer = new DocumentTextWriter();
    await extractBodyBlocks(bodies[0]!.children, writer, checkpoint);
    return writer.finish();
  } catch (error) {
    if (input.signal?.aborted) throwIfAborted(input.signal);
    if (
      error instanceof AttachmentProcessingError &&
      error.code === "archive_limit"
    ) {
      throw error;
    }
    throw invalidDocx();
  }
}

class TraversalCheckpoint {
  #visitedNodes = 0;

  constructor(private readonly signal?: AbortSignal) {}

  async visit(): Promise<void> {
    throwIfAborted(this.signal);
    this.#visitedNodes += 1;
    if (this.#visitedNodes % TRAVERSAL_YIELD_INTERVAL === 0) {
      await yieldToHost(this.signal);
    }
  }
}

class DocumentTextWriter {
  readonly #builder = new BoundedDocumentTextBuilder();
  #hasBlock = false;

  get truncated(): boolean {
    return this.#builder.truncated;
  }

  beginBlock(): boolean {
    if (this.#hasBlock && !this.#builder.append("\n")) return false;
    this.#hasBlock = true;
    return true;
  }

  append(value: string): boolean {
    return this.#builder.append(value);
  }

  appendParagraph(value: string): boolean {
    if (!value) return true;
    return this.beginBlock() && this.append(value);
  }

  finish(): ExtractedDocumentText {
    return this.#builder.finish();
  }
}

async function assertStableWordPrefix(
  nodes: readonly XmlNode[],
  namespace: string,
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text") continue;
    const declaredNamespace = node.attributes["xmlns:w"];
    if (
      declaredNamespace !== undefined &&
      declaredNamespace !== namespace
    ) {
      throw invalidDocx();
    }
    await assertStableWordPrefix(node.children, namespace, checkpoint);
  }
}

async function extractBodyBlocks(
  nodes: readonly XmlNode[],
  writer: DocumentTextWriter,
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text" || isExcludedRevision(node)) continue;
    if (node.name === "w:p") {
      const text = await extractParagraphText(node, checkpoint);
      if (!writer.appendParagraph(text)) return;
      continue;
    }
    if (node.name === "w:tbl") {
      await appendTable(node, writer, checkpoint);
      if (writer.truncated) return;
      continue;
    }
    await extractBodyBlocks(node.children, writer, checkpoint);
    if (writer.truncated) return;
  }
}

async function extractParagraphText(
  paragraph: XmlElement,
  checkpoint: TraversalCheckpoint,
): Promise<string> {
  const parts: string[] = [];
  await collectParagraphContent(paragraph.children, parts, checkpoint);
  return parts.join("");
}

async function collectParagraphContent(
  nodes: readonly XmlNode[],
  parts: string[],
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text" || isExcludedRevision(node)) continue;
    if (node.name === "w:r") {
      if (!hasDirectVanish(node)) {
        await collectRunContent(node.children, parts, checkpoint);
      }
      continue;
    }
    if (node.name === "w:instrText" || node.name === "w:delText") continue;
    await collectParagraphContent(node.children, parts, checkpoint);
  }
}

async function collectRunContent(
  nodes: readonly XmlNode[],
  parts: string[],
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text" || isExcludedRevision(node)) continue;
    if (node.name === "w:rPr") continue;
    if (node.name === "w:instrText" || node.name === "w:delText") continue;
    if (node.name === "w:t") {
      await collectDirectText(node, parts, checkpoint);
      continue;
    }
    if (node.name === "w:tab") {
      parts.push("\t");
      continue;
    }
    if (node.name === "w:br" || node.name === "w:cr") {
      parts.push("\n");
      continue;
    }
    await collectRunContent(node.children, parts, checkpoint);
  }
}

async function collectDirectText(
  textElement: XmlElement,
  parts: string[],
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of textElement.children) {
    await checkpoint.visit();
    if (node.type !== "text") throw invalidDocx();
    parts.push(node.value);
  }
}

function hasDirectVanish(run: XmlElement): boolean {
  let hidden = false;
  for (const properties of childElements(run.children, "w:rPr")) {
    for (const vanish of childElements(properties.children, "w:vanish")) {
      hidden = parseOnOff(vanish.attributes["w:val"]) || hidden;
    }
  }
  return hidden;
}

function parseOnOff(value: string | undefined): boolean {
  if (value === undefined || value === "true" || value === "1" || value === "on") {
    return true;
  }
  if (value === "false" || value === "0" || value === "off") return false;
  throw invalidDocx();
}

async function appendTable(
  table: XmlElement,
  writer: DocumentTextWriter,
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  if (!writer.beginBlock() || !writer.append("[Table]")) return;
  const rows = await collectWrappedElements(
    table.children,
    "w:tr",
    new Set(["w:tbl"]),
    checkpoint,
  );
  for (const row of rows) {
    if (!writer.append("\n")) return;
    const cells = await collectWrappedElements(
      row.children,
      "w:tc",
      new Set(["w:tr", "w:tbl"]),
      checkpoint,
    );
    for (let index = 0; index < cells.length; index += 1) {
      if (index > 0 && !writer.append("\t")) return;
      const cellText = await extractCellText(cells[index]!, checkpoint);
      if (!writer.append(cellText)) return;
    }
  }
  writer.append("\n[/Table]");
}

async function collectWrappedElements(
  nodes: readonly XmlNode[],
  targetName: string,
  boundaryNames: ReadonlySet<string>,
  checkpoint: TraversalCheckpoint,
): Promise<XmlElement[]> {
  const results: XmlElement[] = [];
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text" || isExcludedRevision(node)) continue;
    if (node.name === targetName) {
      results.push(node);
      continue;
    }
    if (boundaryNames.has(node.name)) continue;
    results.push(...await collectWrappedElements(
      node.children,
      targetName,
      boundaryNames,
      checkpoint,
    ));
  }
  return results;
}

async function extractCellText(
  cell: XmlElement,
  checkpoint: TraversalCheckpoint,
): Promise<string> {
  const paragraphs: string[] = [];
  await collectCellParagraphs(cell.children, paragraphs, checkpoint);
  return normalizeCellWhitespace(paragraphs.join("\n"));
}

async function collectCellParagraphs(
  nodes: readonly XmlNode[],
  paragraphs: string[],
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  for (const node of nodes) {
    await checkpoint.visit();
    if (node.type === "text" || isExcludedRevision(node)) continue;
    if (node.name === "w:p") {
      paragraphs.push(await extractParagraphText(node, checkpoint));
      continue;
    }
    await collectCellParagraphs(node.children, paragraphs, checkpoint);
  }
}

function normalizeCellWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/gu, " ").trim();
}

function isExcludedRevision(element: XmlElement): boolean {
  return EXCLUDED_REVISION_ELEMENTS.has(element.name);
}

function invalidDocx(): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", INVALID_DOCX_MESSAGE);
}
