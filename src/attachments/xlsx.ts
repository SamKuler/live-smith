import {
  throwIfAborted,
  yieldToHost,
} from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import {
  BoundedDocumentTextBuilder,
  type ExtractedDocumentText,
} from "./document-text.js";
import {
  childElements,
  collectTextNodes,
  parseXmlPreservingOrder,
  type OoxmlPackage,
  type XmlElement,
  type XmlNode,
} from "./ooxml.js";

const MAX_SHEETS = 64;
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_CELLS_PER_SHEET = 50_000;
const MAX_SHARED_STRINGS = 100_000;
const MAX_SPARSE_GAP = 256;
const MAX_ROW_NUMBER = 1_048_576;
const MAX_COLUMN_NUMBER = 16_384;
const MAX_CELL_REFERENCE_LENGTH = 10;
const ROW_GAP_MARKER = "[sparse rows omitted]";
const COLUMN_GAP_MARKER = "[sparse columns omitted]";

interface SpreadsheetNamespaceFamily {
  spreadsheet: string;
  officeRelationships: string;
  packageRelationships: string;
  worksheetRelationship: string;
  sharedStringsRelationship: string;
}

const spreadsheetNamespaceFamilies: readonly SpreadsheetNamespaceFamily[] = [
  {
    spreadsheet:
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    officeRelationships:
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    packageRelationships:
      "http://schemas.openxmlformats.org/package/2006/relationships",
    worksheetRelationship:
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
    sharedStringsRelationship:
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
  },
  {
    spreadsheet: "http://purl.oclc.org/ooxml/spreadsheetml/main",
    officeRelationships:
      "http://purl.oclc.org/ooxml/officeDocument/relationships",
    packageRelationships:
      "http://purl.oclc.org/ooxml/package/relationships",
    worksheetRelationship:
      "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
    sharedStringsRelationship:
      "http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings",
  },
];

interface WorkbookRelationship {
  id: string;
  type: string;
  target: string;
  targetMode: string | undefined;
}

interface WorkbookSheet {
  name: string;
  relationshipId: string;
  state: "visible" | "hidden" | "veryHidden";
}

interface CellCoordinate {
  column: number;
  row: number;
  reference: string;
}

interface ColumnRange {
  min: number;
  max: number;
}

interface SharedStringsState {
  values?: readonly string[];
  relationshipPresent: boolean;
}

class TraversalCheckpoint {
  #visited = 0;

  constructor(private readonly signal?: AbortSignal) {}

  async visit(): Promise<void> {
    throwIfAborted(this.signal);
    this.#visited += 1;
    if (this.#visited % 256 === 0) await yieldToHost(this.signal);
  }
}

export async function extractXlsxText(input: {
  officePackage: OoxmlPackage;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  throwIfAborted(input.signal);
  if (input.officePackage.kind !== "xlsx") {
    throw invalidDocument("The Office package is not an XLSX workbook.");
  }

  const workbookBytes = requiredEntry(
    input.officePackage.entries,
    "xl/workbook.xml",
    "XLSX workbook part is missing.",
  );
  const relationshipBytes = requiredEntry(
    input.officePackage.entries,
    "xl/_rels/workbook.xml.rels",
    "XLSX workbook relationships are missing.",
  );
  const workbookRoot = parseRoot(workbookBytes, "workbook");
  const namespaceFamily = resolveSpreadsheetNamespaceFamily(workbookRoot);
  await assertStableNamespaces(
    [workbookRoot],
    namespaceFamily.spreadsheet,
    namespaceFamily.officeRelationships,
    input.signal,
  );
  const sheets = parseWorkbookSheets(workbookRoot);
  await yieldToHost(input.signal);

  const relationships = await parseWorkbookRelationships(
    relationshipBytes,
    namespaceFamily,
    input.signal,
  );
  const relationshipsById = new Map(
    relationships.map((relationship) => [relationship.id, relationship]),
  );
  await yieldToHost(input.signal);

  const sharedStrings = await loadSharedStrings(
    relationships,
    input.officePackage.entries,
    namespaceFamily,
    input.signal,
  );
  const builder = new BoundedDocumentTextBuilder();

  for (const sheet of sheets) {
    throwIfAborted(input.signal);
    builder.appendLine(`Sheet ${JSON.stringify(sheet.name)}`);
    const relationship = relationshipsById.get(sheet.relationshipId);
    if (
      !relationship ||
      relationship.type !== namespaceFamily.worksheetRelationship
    ) {
      throw invalidDocument("XLSX sheet relationship is missing or has the wrong type.");
    }
    const worksheetPath = resolveInternalPart(
      relationship,
      input.officePackage.entries,
      "worksheet",
    );
    const worksheetRoot = parseSpreadsheetRoot(
      input.officePackage.entries.get(worksheetPath)!,
      "worksheet",
      namespaceFamily.spreadsheet,
    );
    await assertStableNamespaces(
      [worksheetRoot],
      namespaceFamily.spreadsheet,
      namespaceFamily.officeRelationships,
      input.signal,
    );

    if (sheet.state !== "visible") {
      builder.appendLine("[hidden sheet omitted]");
      await appendWorksheet(
        worksheetRoot,
        sharedStrings,
        builder,
        input.signal,
        false,
      );
    } else {
      await appendWorksheet(
        worksheetRoot,
        sharedStrings,
        builder,
        input.signal,
      );
    }
    await yieldToHost(input.signal);
  }

  return builder.finish();
}

function parseWorkbookSheets(workbookRoot: XmlElement): WorkbookSheet[] {
  const sheetContainers = childElements(workbookRoot.children, "sheets");
  if (sheetContainers.length !== 1) {
    throw invalidDocument("XLSX workbook must contain exactly one sheets declaration.");
  }
  const declarations = childElements(sheetContainers[0]!.children, "sheet");
  if (declarations.length > MAX_SHEETS) {
    throw archiveLimit("XLSX workbook contains too many sheets.");
  }

  const names = new Set<string>();
  const sheetIds = new Set<string>();
  const relationshipIds = new Set<string>();
  return declarations.map((declaration) => {
    const name = requiredAttribute(declaration, "name", "XLSX sheet name is missing.");
    const sheetId = requiredAttribute(
      declaration,
      "sheetId",
      "XLSX sheet id is missing.",
    );
    const relationshipId = requiredAttribute(
      declaration,
      "r:id",
      "XLSX sheet relationship id is missing.",
    );
    if (!/^[1-9][0-9]*$/.test(sheetId) || Number(sheetId) > 0xffff_ffff) {
      throw invalidDocument("XLSX sheet id is invalid.");
    }
    if (names.has(name) || sheetIds.has(sheetId) || relationshipIds.has(relationshipId)) {
      throw invalidDocument("XLSX sheet declarations must be unique.");
    }
    names.add(name);
    sheetIds.add(sheetId);
    relationshipIds.add(relationshipId);

    const state = declaration.attributes.state ?? "visible";
    if (state !== "visible" && state !== "hidden" && state !== "veryHidden") {
      throw invalidDocument("XLSX sheet visibility state is invalid.");
    }
    return { name, relationshipId, state };
  });
}

async function parseWorkbookRelationships(
  bytes: Uint8Array,
  namespaceFamily: SpreadsheetNamespaceFamily,
  signal?: AbortSignal,
): Promise<WorkbookRelationship[]> {
  const root = exactRoot(parseXlsxXml(bytes), "Relationships");
  if (root.attributes.xmlns !== namespaceFamily.packageRelationships) {
    throw invalidDocument("XLSX workbook-relationships namespace is invalid.");
  }
  await assertStableNamespaces(
    [root],
    namespaceFamily.packageRelationships,
    undefined,
    signal,
  );

  const ids = new Set<string>();
  const targets = new Set<string>();
  return childElements(root.children, "Relationship").map((element) => {
    const id = requiredAttribute(
      element,
      "Id",
      "XLSX relationship id is missing.",
    );
    const type = requiredAttribute(
      element,
      "Type",
      "XLSX relationship type is missing.",
    );
    const target = requiredAttribute(
      element,
      "Target",
      "XLSX relationship target is missing.",
    );
    if (ids.has(id) || targets.has(target)) {
      throw invalidDocument("XLSX relationship ids and targets must be unique.");
    }
    ids.add(id);
    targets.add(target);
    return {
      id,
      type,
      target,
      targetMode: element.attributes.TargetMode,
    };
  });
}

async function loadSharedStrings(
  relationships: readonly WorkbookRelationship[],
  entries: ReadonlyMap<string, Uint8Array>,
  namespaceFamily: SpreadsheetNamespaceFamily,
  signal?: AbortSignal,
): Promise<SharedStringsState> {
  const candidates = relationships.filter((relationship) =>
    relationship.type === namespaceFamily.sharedStringsRelationship
  );
  if (candidates.length > 1) {
    throw invalidDocument("XLSX shared-strings relationship is ambiguous.");
  }
  const relationship = candidates[0];
  if (!relationship) return { relationshipPresent: false };
  if (!isInternal(relationship)) return { relationshipPresent: true };

  const path = resolveInternalPart(relationship, entries, "shared strings");
  const root = parseSpreadsheetRoot(
    entries.get(path)!,
    "sst",
    namespaceFamily.spreadsheet,
  );
  await assertStableNamespaces(
    [root],
    namespaceFamily.spreadsheet,
    namespaceFamily.officeRelationships,
    signal,
  );
  const items = childElements(root.children, "si");
  if (items.length > MAX_SHARED_STRINGS) {
    throw archiveLimit("XLSX shared-string count exceeds the safe limit.");
  }

  const values: string[] = [];
  const checkpoint = new TraversalCheckpoint(signal);
  for (let index = 0; index < items.length; index += 1) {
    values.push(await richText(items[index]!.children, checkpoint));
    if ((index + 1) % 256 === 0) await yieldToHost(signal);
  }
  await yieldToHost(signal);
  return { values, relationshipPresent: true };
}

async function appendWorksheet(
  worksheetRoot: XmlElement,
  sharedStrings: SharedStringsState,
  builder: BoundedDocumentTextBuilder,
  signal?: AbortSignal,
  emit = true,
): Promise<void> {
  const hiddenColumns = await parseHiddenColumns(worksheetRoot, signal);
  if (emit && hiddenColumns.length) builder.appendLine("[hidden columns omitted]");

  const sheetDataElements = childElements(worksheetRoot.children, "sheetData");
  if (sheetDataElements.length > 1) {
    throw invalidDocument("XLSX worksheet contains multiple sheet-data elements.");
  }
  const rows = sheetDataElements[0] === undefined
    ? []
    : childElements(sheetDataElements[0].children, "row");
  if (rows.length > MAX_ROWS_PER_SHEET) {
    throw archiveLimit("XLSX worksheet row count exceeds the safe limit.");
  }
  let cellCount = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    cellCount += childElements(row.children, "c").length;
    if (cellCount > MAX_CELLS_PER_SHEET) {
      throw archiveLimit("XLSX worksheet cell count exceeds the safe limit.");
    }
    if ((index + 1) % 256 === 0) await yieldToHost(signal);
  }

  const references = new Set<string>();
  let previousRow = 0;
  let visitedCells = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const cells = childElements(row.children, "c");
    const coordinates: CellCoordinate[] = [];
    for (const cell of cells) {
      coordinates.push(parseCellCoordinate(cell, references));
      visitedCells += 1;
      if (visitedCells % 512 === 0) await yieldToHost(signal);
    }
    const rowNumber = resolveRowNumber(row, coordinates, previousRow);
    if (rowNumber <= previousRow) {
      throw invalidDocument("XLSX worksheet rows must use increasing coordinates.");
    }
    for (const coordinate of coordinates) {
      if (coordinate.row !== rowNumber) {
        throw invalidDocument("XLSX cell coordinate does not match its row.");
      }
    }
    for (let cellIndex = 1; cellIndex < coordinates.length; cellIndex += 1) {
      if (coordinates[cellIndex]!.column <= coordinates[cellIndex - 1]!.column) {
        throw invalidDocument("XLSX cells must use increasing column coordinates.");
      }
    }
    if (emit && previousRow > 0 && rowNumber - previousRow > MAX_SPARSE_GAP) {
      builder.appendLine(ROW_GAP_MARKER);
    }

    const hiddenRow = parseBooleanAttribute(row.attributes.hidden, "row hidden");
    if (!emit) {
      previousRow = rowNumber;
      if ((index + 1) % 64 === 0) await yieldToHost(signal);
      continue;
    }
    if (hiddenRow) {
      builder.appendLine(`Row ${rowNumber}: [hidden row omitted]`);
    } else {
      const renderedCells: string[] = [];
      let previousVisibleColumn = 0;
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const coordinate = coordinates[cellIndex]!;
        if (columnIsHidden(coordinate.column, hiddenColumns)) continue;
        if (
          previousVisibleColumn > 0 &&
          coordinate.column - previousVisibleColumn > MAX_SPARSE_GAP
        ) {
          renderedCells.push(COLUMN_GAP_MARKER);
        }
        renderedCells.push(
          `${coordinate.reference}=${await renderCell(
            cells[cellIndex]!,
            sharedStrings,
            signal,
          )}`,
        );
        previousVisibleColumn = coordinate.column;
      }
      builder.appendLine(
        `Row ${rowNumber}: ${renderedCells.length ? renderedCells.join("; ") : "[empty]"}`,
      );
    }
    previousRow = rowNumber;
    if ((index + 1) % 64 === 0) await yieldToHost(signal);
  }
}

async function parseHiddenColumns(
  worksheetRoot: XmlElement,
  signal?: AbortSignal,
): Promise<ColumnRange[]> {
  const ranges: ColumnRange[] = [];
  let visited = 0;
  for (const container of childElements(worksheetRoot.children, "cols")) {
    for (const column of childElements(container.children, "col")) {
      const min = parseCanonicalPositiveInteger(
        column.attributes.min,
        MAX_COLUMN_NUMBER,
        "XLSX column-range minimum is invalid.",
      );
      const max = parseCanonicalPositiveInteger(
        column.attributes.max,
        MAX_COLUMN_NUMBER,
        "XLSX column-range maximum is invalid.",
      );
      if (min > max) throw invalidDocument("XLSX column range is reversed.");
      if (parseBooleanAttribute(column.attributes.hidden, "column hidden")) {
        ranges.push({ min, max });
      }
      visited += 1;
      if (visited % 256 === 0) await yieldToHost(signal);
    }
  }
  ranges.sort((left, right) => left.min - right.min || left.max - right.max);
  const merged: ColumnRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.min <= previous.max + 1) {
      previous.max = Math.max(previous.max, range.max);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function resolveRowNumber(
  row: XmlElement,
  coordinates: readonly CellCoordinate[],
  previousRow: number,
): number {
  const declared = row.attributes.r;
  if (declared !== undefined) {
    return parseCanonicalPositiveInteger(
      declared,
      MAX_ROW_NUMBER,
      "XLSX row coordinate is invalid.",
    );
  }
  const inferred = coordinates[0]?.row ?? previousRow + 1;
  if (inferred > MAX_ROW_NUMBER) {
    throw invalidDocument("XLSX row coordinate exceeds the worksheet limit.");
  }
  return inferred;
}

function parseCellCoordinate(
  cell: XmlElement,
  references: Set<string>,
): CellCoordinate {
  const reference = requiredAttribute(
    cell,
    "r",
    "XLSX cell reference is missing.",
  );
  if (reference.length > MAX_CELL_REFERENCE_LENGTH) {
    throw invalidDocument("XLSX cell reference is invalid.");
  }
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(reference);
  if (!match) throw invalidDocument("XLSX cell reference is invalid.");
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  const row = Number(match[2]);
  if (column > MAX_COLUMN_NUMBER || row > MAX_ROW_NUMBER) {
    throw invalidDocument("XLSX cell reference exceeds worksheet bounds.");
  }
  if (references.has(reference)) {
    throw invalidDocument("XLSX cell references must be unique.");
  }
  references.add(reference);
  return { column, row, reference };
}

async function renderCell(
  cell: XmlElement,
  sharedStrings: SharedStringsState,
  signal?: AbortSignal,
): Promise<string> {
  const formula = optionalUniqueChild(cell, "f");
  const value = optionalUniqueChild(cell, "v");
  const inline = optionalUniqueChild(cell, "is");
  if (formula) {
    return `Formula ${JSON.stringify({
      formula: textContent(formula),
      cached: value ? textContent(value) : null,
    })}`;
  }

  const type = cell.attributes.t;
  if (type === "inlineStr") {
    if (!inline) throw invalidDocument("XLSX inline string is missing its value.");
    return JSON.stringify(
      await richText(inline.children, new TraversalCheckpoint(signal)),
    );
  }
  if (inline) throw invalidDocument("XLSX inline-string data has the wrong cell type.");

  const raw = value ? textContent(value) : "";
  if (type === "s") {
    if (!sharedStrings.relationshipPresent || !sharedStrings.values) {
      throw invalidDocument("XLSX shared strings must use an internal relationship.");
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
      throw invalidDocument("XLSX shared-string index is invalid.");
    }
    const index = Number(raw);
    const shared = sharedStrings.values[index];
    if (!Number.isSafeInteger(index) || shared === undefined) {
      throw invalidDocument("XLSX shared-string index is out of range.");
    }
    return JSON.stringify(shared);
  }
  if (type === "b") {
    if (raw !== "0" && raw !== "1") {
      throw invalidDocument("XLSX boolean cell value is invalid.");
    }
    return raw === "1" ? "true" : "false";
  }
  if (type === "e") return JSON.stringify(raw);
  if (type === undefined || type === "n" || type === "str") {
    return value ? JSON.stringify(raw) : "null";
  }
  throw invalidDocument("XLSX cell type is unsupported.");
}

async function richText(
  nodes: readonly XmlNode[],
  checkpoint: TraversalCheckpoint,
): Promise<string> {
  let value = "";
  const visit = async (items: readonly XmlNode[]): Promise<void> => {
    for (const node of items) {
      await checkpoint.visit();
      if (node.type === "text") continue;
      if (node.name === "rPh") continue;
      if (node.name === "t") {
        value += collectTextNodes(node.children).join("");
      } else {
        await visit(node.children);
      }
    }
  };
  await visit(nodes);
  return value;
}

function resolveInternalPart(
  relationship: WorkbookRelationship,
  entries: ReadonlyMap<string, Uint8Array>,
  label: string,
): string {
  if (!isInternal(relationship)) {
    throw invalidDocument(`XLSX ${label} relationship must be internal.`);
  }
  const target = relationship.target;
  if (
    target.includes("\\") ||
    target.startsWith("/") ||
    target.includes("?") ||
    target.includes("#") ||
    target.includes(":") ||
    target.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw invalidDocument(`XLSX ${label} relationship target is unsafe.`);
  }
  const path = `xl/${target}`;
  if (!entries.has(path)) {
    throw invalidDocument(`XLSX ${label} relationship target is missing.`);
  }
  return path;
}

function isInternal(relationship: WorkbookRelationship): boolean {
  return relationship.targetMode === undefined ||
    relationship.targetMode === "Internal";
}

function parseSpreadsheetRoot(
  bytes: Uint8Array,
  expectedName: string,
  expectedNamespace: string,
): XmlElement {
  const root = exactRoot(parseXlsxXml(bytes), expectedName);
  if (root.attributes.xmlns !== expectedNamespace) {
    throw invalidDocument(`XLSX ${expectedName} namespace is invalid.`);
  }
  return root;
}

function parseRoot(bytes: Uint8Array, expectedName: string): XmlElement {
  return exactRoot(parseXlsxXml(bytes), expectedName);
}

function parseXlsxXml(bytes: Uint8Array): readonly XmlNode[] {
  try {
    return parseXmlPreservingOrder(bytes);
  } catch (cause) {
    if (cause instanceof AttachmentProcessingError) throw cause;
    throw invalidDocument("XLSX XML could not be parsed safely.");
  }
}

function resolveSpreadsheetNamespaceFamily(
  workbookRoot: XmlElement,
): SpreadsheetNamespaceFamily {
  const family = spreadsheetNamespaceFamilies.find((candidate) =>
    workbookRoot.attributes.xmlns === candidate.spreadsheet &&
    workbookRoot.attributes["xmlns:r"] === candidate.officeRelationships
  );
  if (!family) throw invalidDocument("XLSX workbook namespace is invalid.");
  return family;
}

async function assertStableNamespaces(
  nodes: readonly XmlNode[],
  defaultNamespace: string,
  officeRelationshipsNamespace: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const checkpoint = new TraversalCheckpoint(signal);
  const visit = async (items: readonly XmlNode[]): Promise<void> => {
    for (const node of items) {
      await checkpoint.visit();
      if (node.type === "text") continue;
      const declaredDefault = node.attributes.xmlns;
      if (
        declaredDefault !== undefined &&
        declaredDefault !== defaultNamespace
      ) {
        throw invalidDocument("XLSX inner namespace rebinding is invalid.");
      }
      const declaredOfficeRelationships = node.attributes["xmlns:r"];
      if (
        declaredOfficeRelationships !== undefined &&
        declaredOfficeRelationships !== officeRelationshipsNamespace
      ) {
        throw invalidDocument("XLSX relationship namespace rebinding is invalid.");
      }
      await visit(node.children);
    }
  };
  await visit(nodes);
}

function exactRoot(nodes: readonly XmlNode[], name: string): XmlElement {
  const elements = childElements(nodes);
  if (elements.length !== 1 || elements[0]!.name !== name) {
    throw invalidDocument(`XLSX ${name} root is invalid.`);
  }
  return elements[0]!;
}

function optionalUniqueChild(parent: XmlElement, name: string): XmlElement | undefined {
  const matches = childElements(parent.children, name);
  if (matches.length > 1) {
    throw invalidDocument(`XLSX cell contains duplicate ${name} values.`);
  }
  return matches[0];
}

function textContent(element: XmlElement): string {
  return collectTextNodes(element.children).join("");
}

function columnIsHidden(column: number, ranges: readonly ColumnRange[]): boolean {
  for (const range of ranges) {
    if (column < range.min) return false;
    if (column <= range.max) return true;
  }
  return false;
}

function parseBooleanAttribute(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw invalidDocument(`XLSX ${label} value is invalid.`);
}

function parseCanonicalPositiveInteger(
  value: string | undefined,
  maximum: number,
  message: string,
): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw invalidDocument(message);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw invalidDocument(message);
  }
  return parsed;
}

function requiredAttribute(
  element: XmlElement,
  name: string,
  message: string,
): string {
  const value = element.attributes[name];
  if (value === undefined || value.length === 0) throw invalidDocument(message);
  return value;
}

function requiredEntry(
  entries: ReadonlyMap<string, Uint8Array>,
  name: string,
  message: string,
): Uint8Array {
  const value = entries.get(name);
  if (!value) throw invalidDocument(message);
  return value;
}

function invalidDocument(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", message);
}

function archiveLimit(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("archive_limit", message);
}
