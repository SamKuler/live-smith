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

const PRESENTATION_PART = "ppt/presentation.xml";
const PRESENTATION_RELATIONSHIPS_PART =
  "ppt/_rels/presentation.xml.rels";
const MAX_SLIDES = 256;
const MAX_PARAGRAPHS_PER_SLIDE = 20_000;
const HIDDEN_SLIDE_MARKER = "[hidden slide omitted]";
const INVALID_PPTX_MESSAGE =
  "The PPTX attachment is not a valid supported document.";
const TRAVERSAL_YIELD_INTERVAL = 256;
const hiddenCapableShapeNames = new Set([
  "p:sp",
  "p:grpSp",
  "p:pic",
  "p:graphicFrame",
  "p:cxnSp",
  "p:contentPart",
]);

interface NamespaceFamily {
  presentation: string;
  drawing: string;
  officeRelationships: string;
  packageRelationships: string;
}

const namespaceFamilies: readonly NamespaceFamily[] = [
  {
    presentation:
      "http://schemas.openxmlformats.org/presentationml/2006/main",
    drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
    officeRelationships:
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    packageRelationships:
      "http://schemas.openxmlformats.org/package/2006/relationships",
  },
  {
    presentation: "http://purl.oclc.org/ooxml/presentationml/main",
    drawing: "http://purl.oclc.org/ooxml/drawingml/main",
    officeRelationships:
      "http://purl.oclc.org/ooxml/officeDocument/relationships",
    packageRelationships: "http://purl.oclc.org/ooxml/package/relationships",
  },
];
const packageRelationshipsNamespaces = new Set(
  namespaceFamilies.map((family) => family.packageRelationships),
);
interface SlideReference {
  hidden: boolean;
  relationshipId: string;
}

interface PresentationRelationship {
  element: XmlElement;
}

export async function extractPptxText(input: {
  officePackage: OoxmlPackage;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  throwIfAborted(input.signal);
  try {
    return await extractValidatedPptxText(input);
  } catch (error) {
    if (input.signal?.aborted) throwIfAborted(input.signal);
    if (
      error instanceof AttachmentProcessingError &&
      error.code === "archive_limit"
    ) {
      throw error;
    }
    throw invalidDocument();
  }
}

async function extractValidatedPptxText(input: {
  officePackage: OoxmlPackage;
  signal?: AbortSignal;
}): Promise<ExtractedDocumentText> {
  if (input.officePackage.kind !== "pptx") {
    throw invalidDocument();
  }

  const checkpoint = new TraversalCheckpoint(input.signal);
  const presentationRoot = parseRequiredRoot(
    input.officePackage,
    PRESENTATION_PART,
    "p:presentation",
  );
  const family = resolvePresentationFamily(presentationRoot);
  await assertStableNamespaces(presentationRoot, [
    ["xmlns:p", family.presentation],
    ["xmlns:r", family.officeRelationships],
  ], checkpoint);
  const slides = await readSlideReferences(presentationRoot, checkpoint);

  const relationshipsRoot = parseRequiredRoot(
    input.officePackage,
    PRESENTATION_RELATIONSHIPS_PART,
    "Relationships",
  );
  const relationshipsNamespace = relationshipsRoot.attributes.xmlns;
  if (
    relationshipsNamespace === undefined ||
    !packageRelationshipsNamespaces.has(relationshipsNamespace)
  ) {
    throw invalidDocument();
  }
  await assertStableNamespaces(
    relationshipsRoot,
    [["xmlns", relationshipsNamespace]],
    checkpoint,
  );
  const relationships = await indexRelationships(
    relationshipsRoot,
    checkpoint,
  );
  const builder = new BoundedDocumentTextBuilder();

  for (let index = 0; index < slides.length; index += 1) {
    await yieldToHost(input.signal);
    const slideReference = slides[index]!;
    const relationship = relationships.get(slideReference.relationshipId);
    if (!relationship) {
      throw invalidDocument();
    }
    const slidePart = resolveSlidePart(
      input.officePackage,
      relationship,
      family,
    );
    const slideRoot = parseRequiredRoot(
      input.officePackage,
      slidePart,
      "p:sld",
    );
    await assertSlideNamespaces(slideRoot, family, checkpoint);
    const slideShown = parseXmlBoolean(slideRoot.attributes.show, true);
    const hidden = slideReference.hidden || !slideShown;
    const visibleParagraphs = await collectSlideParagraphs(
      slideRoot,
      !hidden,
      checkpoint,
    );

    if (index > 0 && !builder.append("\n\n")) return builder.finish();
    if (!builder.appendLine(`Slide ${index + 1}:`)) return builder.finish();
    if (hidden) {
      builder.append(HIDDEN_SLIDE_MARKER);
      if (builder.truncated) return builder.finish();
      continue;
    }

    for (let paragraphIndex = 0;
      paragraphIndex < visibleParagraphs.length;
      paragraphIndex += 1) {
      await yieldToHost(input.signal);
      if (paragraphIndex > 0 && !builder.append("\n")) {
        return builder.finish();
      }
      const paragraphText = await extractParagraphText(
        visibleParagraphs[paragraphIndex]!,
        checkpoint,
      );
      if (!builder.append(paragraphText)) {
        return builder.finish();
      }
    }
  }

  return builder.finish();
}

function parseRequiredRoot(
  officePackage: OoxmlPackage,
  partName: string,
  rootName: string,
): XmlElement {
  const bytes = officePackage.entries.get(partName);
  if (!bytes) throw invalidDocument();
  const roots = childElements(parseXmlPreservingOrder(bytes));
  if (roots.length !== 1 || roots[0]!.name !== rootName) {
    throw invalidDocument();
  }
  return roots[0]!;
}

function resolvePresentationFamily(root: XmlElement): NamespaceFamily {
  const family = namespaceFamilies.find((candidate) =>
    root.attributes["xmlns:p"] === candidate.presentation
  );
  if (
    !family ||
    root.attributes["xmlns:r"] !== family.officeRelationships
  ) {
    throw invalidDocument();
  }
  return family;
}

async function readSlideReferences(
  root: XmlElement,
  checkpoint: TraversalCheckpoint,
): Promise<SlideReference[]> {
  const slideIdLists: XmlElement[] = [];
  for (const node of root.children) {
    await checkpoint.visit();
    if (node.type === "element" && node.name === "p:sldIdLst") {
      slideIdLists.push(node);
    }
  }
  if (slideIdLists.length !== 1) {
    throw invalidDocument();
  }

  const slideNumericIds = new Set<string>();
  const relationshipIds = new Set<string>();
  const slides: SlideReference[] = [];
  for (const node of slideIdLists[0]!.children) {
    await checkpoint.visit();
    if (node.type === "text" || node.name !== "p:sldId") continue;
    const numericId = node.attributes.id;
    if (
      !isCanonicalSlideNumericId(numericId) ||
      slideNumericIds.has(numericId)
    ) {
      throw invalidDocument();
    }
    slideNumericIds.add(numericId);

    const slide = node;
    const relationshipId = slide.attributes["r:id"];
    if (!relationshipId || relationshipIds.has(relationshipId)) {
      throw invalidDocument();
    }
    relationshipIds.add(relationshipId);
    slides.push({
      hidden: !parseXmlBoolean(slide.attributes.show, true),
      relationshipId,
    });
    if (slides.length > MAX_SLIDES) {
      throw archiveLimit("PPTX contains more than 256 slides.");
    }
  }
  return slides;
}

function isCanonicalSlideNumericId(value: string | undefined): value is string {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return false;
  const numeric = Number(value);
  return numeric >= 256 && numeric <= 2_147_483_647;
}

async function indexRelationships(
  root: XmlElement,
  checkpoint: TraversalCheckpoint,
): Promise<ReadonlyMap<string, PresentationRelationship>> {
  const relationships = new Map<string, PresentationRelationship>();
  for (const node of root.children) {
    await checkpoint.visit();
    if (node.type === "text" || node.name !== "Relationship") continue;
    const element = node;
    const id = element.attributes.Id;
    if (!id || relationships.has(id)) {
      throw invalidDocument();
    }
    relationships.set(id, { element });
  }
  return relationships;
}

function resolveSlidePart(
  officePackage: OoxmlPackage,
  relationship: PresentationRelationship,
  family: NamespaceFamily,
): string {
  const attributes = relationship.element.attributes;
  if (attributes.Type !== `${family.officeRelationships}/slide`) {
    throw invalidDocument();
  }
  if (
    attributes.TargetMode !== undefined &&
    attributes.TargetMode !== "Internal"
  ) {
    throw invalidDocument();
  }
  const target = normalizeSlideTarget(attributes.Target);
  const slidePart = `ppt/${target}`;
  if (!officePackage.entries.has(slidePart)) {
    throw invalidDocument();
  }
  return slidePart;
}

function normalizeSlideTarget(value: string | undefined): string {
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes(":") ||
    value.split("/").some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) {
    throw invalidDocument();
  }
  return value;
}

async function assertSlideNamespaces(
  root: XmlElement,
  family: NamespaceFamily,
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  if (
    root.attributes["xmlns:p"] !== family.presentation ||
    root.attributes["xmlns:a"] !== family.drawing
  ) {
    throw invalidDocument();
  }
  await assertStableNamespaces(
    root,
    [
      ["xmlns:p", family.presentation],
      ["xmlns:a", family.drawing],
    ],
    checkpoint,
  );
}

async function assertStableNamespaces(
  root: XmlElement,
  bindings: readonly (readonly [attribute: string, expected: string])[],
  checkpoint: TraversalCheckpoint,
): Promise<void> {
  const visit = async (nodes: readonly XmlNode[]): Promise<void> => {
    for (const node of nodes) {
      await checkpoint.visit();
      if (node.type === "text") continue;
      for (const [attribute, expected] of bindings) {
        const declaration = node.attributes[attribute];
        if (declaration !== undefined && declaration !== expected) {
          throw invalidDocument();
        }
      }
      await visit(node.children);
    }
  };
  await visit([root]);
}

async function collectSlideParagraphs(
  root: XmlElement,
  includeVisible: boolean,
  checkpoint: TraversalCheckpoint,
): Promise<XmlElement[]> {
  const paragraphs: XmlElement[] = [];
  let paragraphCount = 0;
  const visit = async (
    nodes: readonly XmlNode[],
    visible: boolean,
  ): Promise<void> => {
    for (const node of nodes) {
      await checkpoint.visit();
      if (node.type === "text") continue;
      const descendantsVisible = visible && !isDirectlyHiddenShape(node);
      if (node.name === "a:p") {
        paragraphCount += 1;
        if (paragraphCount > MAX_PARAGRAPHS_PER_SLIDE) {
          throw archiveLimit("PPTX slide contains more than 20,000 paragraphs.");
        }
        if (descendantsVisible) paragraphs.push(node);
      }
      await visit(node.children, descendantsVisible);
    }
  };
  await visit(root.children, includeVisible);
  return paragraphs;
}

function isDirectlyHiddenShape(element: XmlElement): boolean {
  if (!hiddenCapableShapeNames.has(element.name)) return false;
  let hidden = false;
  for (const nonVisualContainer of childElements(element.children)) {
    for (const properties of childElements(
      nonVisualContainer.children,
      "p:cNvPr",
    )) {
      if (parseXmlBoolean(properties.attributes.hidden, false)) hidden = true;
    }
  }
  return hidden;
}

function parseXmlBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw invalidDocument();
}

async function extractParagraphText(
  paragraph: XmlElement,
  checkpoint: TraversalCheckpoint,
): Promise<string> {
  // Paragraphs and their tokens intentionally follow DrawingML XML order;
  // PPTX geometry is not a safe or deterministic visual reading order.
  const parts: string[] = [];
  const collectLiteralText = async (
    nodes: readonly XmlNode[],
  ): Promise<void> => {
    for (const node of nodes) {
      await checkpoint.visit();
      if (node.type === "text") {
        parts.push(node.value);
      } else {
        await collectLiteralText(node.children);
      }
    }
  };
  const visit = async (nodes: readonly XmlNode[]): Promise<void> => {
    for (const node of nodes) {
      await checkpoint.visit();
      if (node.type === "text") continue;
      if (node.name === "a:t") {
        await collectLiteralText(node.children);
      } else if (node.name === "a:br") {
        parts.push("\n");
      } else if (node.name === "a:tab") {
        parts.push("\t");
      } else {
        await visit(node.children);
      }
    }
  };
  await visit(paragraph.children);
  return parts.join("");
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

function archiveLimit(message: string): AttachmentProcessingError {
  return new AttachmentProcessingError("archive_limit", message);
}

function invalidDocument(): AttachmentProcessingError {
  return new AttachmentProcessingError("invalid_document", INVALID_PPTX_MESSAGE);
}
