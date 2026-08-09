import { yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
import {
  childElements,
  descendantElements,
  parseXmlBytesPreservingOrder,
  type XmlElement,
  type XmlNode,
} from "./ooxml-xml.js";
import { openBoundedOoxmlZip } from "./ooxml-zip.js";

export {
  childElements,
  collectTextNodes,
  descendantElements,
  parseXmlPreservingOrder,
  type XmlElement,
  type XmlNode,
  type XmlText,
} from "./ooxml-xml.js";
export {
  MAX_OOXML_COMPRESSION_RATIO,
  MAX_OOXML_ENTRY_COUNT,
  MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES,
  MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES,
} from "./ooxml-zip.js";

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

export async function openOoxmlPackage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<OoxmlPackage> {
  const archive = await openBoundedOoxmlZip(bytes, isAllowedXmlPart, signal);
  if (archive.entryNames.some(isActiveOfficePart)) {
    throw macroEnabled();
  }
  const entries = archive.retainedEntries;
  const contentTypesBytes = entries.get("[Content_Types].xml");
  const rootRelationshipsBytes = entries.get("_rels/.rels");
  if (!contentTypesBytes || !rootRelationshipsBytes) {
    throw invalidDocument("OOXML package metadata is missing.");
  }

  const contentTypes = parseXmlBytesPreservingOrder(contentTypesBytes).nodes;
  assertNoActiveContentTypes(contentTypes);
  await yieldToHost(signal);
  const rootRelationships =
    parseXmlBytesPreservingOrder(rootRelationshipsBytes).nodes;
  assertNoActiveRelationships(rootRelationships);
  await yieldToHost(signal);
  const kind = resolvePackageKind(contentTypes, rootRelationships, entries);
  for (const [name, xmlBytes] of entries) {
    if (name === "[Content_Types].xml" || name === "_rels/.rels") continue;
    const parsed = parseXmlBytesPreservingOrder(xmlBytes).nodes;
    if (name.endsWith(".rels")) assertNoActiveRelationships(parsed);
    await yieldToHost(signal);
  }
  return { kind, entries };
}

function rootElements(nodes: readonly XmlNode[], name: string): XmlElement[] {
  const elements = childElements(nodes);
  return elements.length === 1 && elements[0]?.name === name ? elements : [];
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
    officeRelationship.attributes.TargetMode !== "Internal"
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

function normalizeRelationshipTarget(value: string | undefined): string {
  if (!value) throw invalidDocument("OOXML relationship target is missing.");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw invalidDocument("OOXML relationship target is invalid.");
  }
  return value;
}

function isAllowedXmlPart(name: string): boolean {
  return name === "[Content_Types].xml" ||
    name.endsWith(".xml") ||
    name.endsWith(".rels");
}

function isActiveOfficePart(name: string): boolean {
  return /(?:^|\/)vba(?:Data\.xml|Project(?:Signature)?\.bin)$/i.test(name) ||
    /(?:^|\/)activeXObject\d*\.xml$/i.test(name) ||
    /(?:^|\/)activeX(?:\/|$)/i.test(name) ||
    /(?:^|\/)macrosheets?(?:\/|$)/i.test(name);
}

function assertNoActiveContentTypes(nodes: readonly XmlNode[]): void {
  const roots = rootElements(nodes, "Types");
  if (roots.length !== 1) return;
  const declarations = [
    ...childElements(roots[0]!.children, "Default"),
    ...childElements(roots[0]!.children, "Override"),
  ];
  if (declarations.some((declaration) =>
    isActiveOfficeMetadata(declaration.attributes.ContentType)
  )) {
    throw macroEnabled();
  }
}

function assertNoActiveRelationships(nodes: readonly XmlNode[]): void {
  if (descendantElements(nodes, "Relationship").some((relationship) =>
    isActiveOfficeMetadata(relationship.attributes.Type)
  )) {
    throw macroEnabled();
  }
}

function isActiveOfficeMetadata(value: string | undefined): boolean {
  return value !== undefined && /(?:macro|vba|activex)/i.test(value);
}

function macroEnabled(): AttachmentProcessingError {
  return new AttachmentProcessingError(
    "macro_enabled",
    "Macro-enabled or active-content Office documents are not supported.",
  );
}


function invalidDocument(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", message);
}
