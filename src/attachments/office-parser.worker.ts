import { parentPort, workerData } from "node:worker_threads";
import { posix } from "node:path";
import { TextDecoder } from "node:util";

import { parseOffice, type OfficeContentNode } from "officeparser/slim";
import XLSX from "xlsx";
import { unzipSync, strToU8, zipSync } from "fflate/browser";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

interface ParseJob {
  bytes: Uint8Array;
  fileType: "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";
  maxCharacters: number;
  canonicalOdfContent?: string;
}

async function parse(job: ParseJob): Promise<void> {
  try {
    let bytes = job.bytes;
    let parts: Record<string, Uint8Array> = unzipSync(bytes);
    const hiddenSheets = new Set<string>();
    let slideOrder: { position: number; hasText: boolean }[] | undefined;
    let omittedSlides = false;
    if (job.canonicalOdfContent !== undefined) {
      parts = Object.fromEntries(["mimetype", "META-INF/manifest.xml", "content.xml", "styles.xml"]
        .filter((name) => Object.hasOwn(parts, name)).map((name) => [name, parts[name]!]));
      const content = readXml(strToU8(job.canonicalOdfContent));
      const prepareSheet = (nodes: OrderedXml[]): OrderedXml[] => nodes.map((node) => {
        const tag = tagOf(node);
        if (!tag) return node;
        const attributes = (node[":@"] ?? {}) as Record<string, string>;
        const hiddenSheet = tag === "table:table" && attributes["table:display"] !== undefined && !onOff(attributes["table:display"]);
        if (hiddenSheet) hiddenSheets.add(attributes["table:name"] ?? "");
        const hidden = hiddenSheet || (tag === "table:table-row" && ["collapse", "filter"].includes(attributes["table:visibility"] ?? ""));
        let children = hidden ? [] : prepareSheet(node[tag] as OrderedXml[]);
        if (tag === "table:table-cell" && attributes["office:string-value"] !== undefined &&
            childrenNamed(children, "text:p").length === 0) {
          children = [...children, { "text:p": [{ "#text": attributes["office:string-value"] }] }];
        }
        if (tag === "table:table-cell" && attributes["table:formula"] !== undefined &&
            !Object.keys(attributes).some((name) => name.startsWith("office:") && name.endsWith("value")) &&
            !hasXmlText(children)) {
          // SheetJS omits empty formula cells without stubs; retain an explicit unavailable-cache value.
          children = [{ "text:p": [{ "#text": "[cached value unavailable]" }] }];
          return { ...node, [tag]: children, ":@": { ...attributes, "office:value-type": "string" } };
        }
        return { ...node, [tag]: children };
      });
      parts["content.xml"] = writeXml(job.fileType === "ods" ? prepareSheet(content) : content);
      if (parts["styles.xml"] === undefined) {
        parts["styles.xml"] = strToU8('<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
      }
    }
    if (job.fileType === "docx" || job.fileType === "xlsx") {
      parts = canonicalWorkbookOrDocument(parts, job.fileType);
    }
    if (job.fileType === "docx") {
      for (const name of Object.keys(parts).filter((name) => /^word\/.*\.xml$/u.test(name))) {
        const visible = filterXml(readXml(parts[name]!), (tag, children) => {
          if (tag === "w:del" || tag === "w:moveFrom") return true;
          if (tag !== "w:r") return false;
          return childrenNamed(children, "w:rPr").some((properties) =>
            childrenNamed(properties, "w:vanish").some((node) => onOff(node.attributes["w:val"])));
        });
        parts[name] = writeXml(visible);
      }
    }
    if (job.fileType === "pptx") {
      const root = officeXml(parts, "ppt/presentation.xml", "p:presentation", "presentationml");
      const relationships = relationshipsFor(parts, "ppt/presentation.xml");
      const targets = new Map(relationships.map((node) => [node.attributes.Id, node]));
      const canonical: Record<string, Uint8Array> = { "ppt/presentation.xml": writeXml(root) };
      const rootElement = childrenNamed(root, "p:presentation")[0]!;
      const lists = childrenNamed(rootElement, "p:sldIdLst");
      if (lists.length > 1) throw new Error("Ambiguous slide list.");
      const slides = lists.length ? childrenNamed(lists[0]!, "p:sldId") : [];
      slideOrder = [];
      for (const [index, slide] of slides.entries()) {
        const relationship = targets.get(slide.attributes["r:id"]);
        if (!relationship || relationshipRole(relationship) !== "slide") throw new Error("Missing slide relationship.");
        const name = relationshipPart("ppt/presentation.xml", relationship);
        const xml = officeXml(parts, name, "p:sld", "presentationml");
        const slideRoot = findNodes(xml, "p:sld")[0]!;
        if ((slide.attributes.show !== undefined && !onOff(slide.attributes.show)) ||
            (slideRoot.attributes.show !== undefined && !onOff(slideRoot.attributes.show))) {
          omittedSlides = true;
          continue;
        }
        const visible = visibleShapes(xml);
        canonical[`ppt/slides/slide${index + 1}.xml`] = writeXml(visible);
        const notes = relationshipsFor(parts, name).filter((node) => relationshipRole(node) === "notesSlide");
        if (notes.length > 1) throw new Error("Ambiguous notes relationship.");
        if (notes[0]) {
          const noteName = relationshipPart(name, notes[0]);
          canonical[`ppt/notesSlides/notesSlide${index + 1}.xml`] = writeXml(visibleShapes(
            officeXml(parts, noteName, "p:notes", "presentationml")));
        }
        slideOrder.push({ position: index + 1,
          hasText: findNodes(visible, "a:t").some((node) => node.children.some((child) => String(child["#text"] ?? "").trim())) });
      }
      parts = canonical;
    }
    bytes = zipSync(parts);
    if (job.fileType === "xlsx" || job.fileType === "ods") {
      const result = extractSpreadsheet(bytes, job.maxCharacters, job.fileType, hiddenSheets);
      parentPort!.postMessage({ ok: true, ...result });
      return;
    }
    const document = await parseOffice(bytes, {
      fileType: job.fileType,
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      ignoreComments: true,
      ignoreSlideMasters: true,
      decompressionLimits: {
        maxUncompressedBytes: 64 * 1024 * 1024,
        maxZipEntries: 2_048,
        maxXmlElements: 100_000,
        maxTableCells: 100_000,
        maxRepeatedContent: 1_000_000,
      },
    });
    if (slideOrder) {
      const slides = new Map(document.content.filter((node) => node.type === "slide")
        .map((node) => [node.metadata?.slideNumber, node]));
      document.content = slideOrder.map(({ position, hasText }) => {
        let node: OfficeContentNode | undefined = slides.get(position);
        if (!node && hasText) throw new Error("The parser omitted a referenced slide.");
        node ??= { type: "slide", children: [], metadata: { slideNumber: position } };
        node.metadata = { ...node.metadata, slideNumber: position };
        return node;
      });
    }
    const annotate = (nodes: typeof document.content): void => {
      for (const node of nodes) {
        if (node.children) annotate(node.children);
        if (node.notes) annotate(node.notes);
        const caption = node.type === "slide"
          ? `Slide ${node.metadata?.slideNumber ?? ""}`
          : node.type === "note" ? "Notes" : undefined;
        if (caption) node.children = [{ type: "paragraph", text: caption,
          children: [{ type: "text", text: caption }] }, ...(node.children ?? [])];
      }
    };
    annotate(document.content);
    const generated = await document.to("text", { textConfig: { preserveLayout: false } });
    const text = generated.value + (omittedSlides ? "\n[Hidden slides omitted]" : "");
    let end = 0;
    let count = 0;
    while (end < text.length && count < job.maxCharacters) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
      count += 1;
    }
    parentPort!.postMessage({
      ok: true,
      text: text.slice(0, end),
      truncated: end < text.length || document.warnings.length > 0 || generated.messages.some((issue) => issue.type !== "info"),
    });
  } catch (error) {
    const issue = (error as { officeIssue?: { code?: string } })?.officeIssue?.code;
    parentPort!.postMessage({ ok: false, limit: issue?.includes("LIMIT_EXCEEDED") === true });
  }
}

void parse(workerData as ParseJob);

function extractSpreadsheet(bytes: Uint8Array, maxCharacters: number, fileType: "xlsx" | "ods", hiddenSheets: ReadonlySet<string>): { text: string; truncated: boolean } {
  const workbook = XLSX.read(bytes, { type: "array", dense: true, cellFormula: true,
    // XLSX needs styles for hidden-row/column metadata; enabling styles also forces blank-cell stubs.
    cellHTML: false, cellDates: true, sheetStubs: false, cellStyles: fileType === "xlsx" });
  const lines: string[] = [];
  let characters = 0;
  let truncated = false;
  const append = (line: string): boolean => {
    if (characters >= maxCharacters) { truncated = true; return false; }
    const value = `${lines.length ? "\n" : ""}${line}`;
    let end = 0;
    let count = 0;
    while (end < value.length && characters + count < maxCharacters) {
      end += value.codePointAt(end)! > 0xffff ? 2 : 1;
      count += 1;
    }
    lines.push(value.slice(0, end));
    characters += count;
    if (end < value.length) truncated = true;
    return end === value.length;
  };
  for (const name of workbook.SheetNames) {
    const sheetIndex = workbook.SheetNames.indexOf(name);
    if (hiddenSheets.has(name) || workbook.Workbook?.Sheets?.[sheetIndex]?.Hidden) {
      if (!append(`[Hidden sheet ${JSON.stringify(name)} omitted]`)) break;
      continue;
    }
    if (!append(`Sheet ${JSON.stringify(name)}`)) break;
    const sheet = workbook.Sheets[name]!;
    const rows = sheet["!data"] ?? [];
    for (const [rowKey, row] of Object.entries(rows)) {
      if (!row) continue;
      if (sheet["!rows"]?.[Number(rowKey)]?.hidden) {
        if (!append(`[Hidden row ${Number(rowKey) + 1} omitted]`)) break;
        continue;
      }
      const cells: string[] = [];
      for (const [columnKey, cell] of Object.entries(row)) {
        if (!cell || (cell.t === "z" && !cell.f) || (cell.v === undefined && !cell.f)) continue;
        if (sheet["!cols"]?.[Number(columnKey)]?.hidden) continue;
        const address = XLSX.utils.encode_cell({ r: Number(rowKey), c: Number(columnKey) });
        const value = cell.t === "z" ? "[cached value unavailable]" : cell.t === "e" ? XLSX.utils.format_cell(cell)
          : cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? "");
        cells.push(`${address}=${JSON.stringify(value)}${cell.f ? ` [formula ${JSON.stringify(cell.f)}]` : ""}`);
      }
      if (cells.length && !append(`Row ${Number(rowKey) + 1}: ${cells.join("\t")}`)) break;
    }
  }
  return { text: lines.join(""), truncated };
}

type OrderedXml = Record<string, unknown>;
interface XmlChildren { attributes: Record<string, string>; children: OrderedXml[] }
function tagOf(node: OrderedXml): string | undefined { return Object.keys(node).find((name) => name !== ":@" && name !== "#text"); }
function readXml(bytes: Uint8Array): OrderedXml[] {
  const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0) ? "utf-16le"
    : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c) ? "utf-16be" : "utf-8";
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false,
    parseTagValue: false, parseAttributeValue: false })
    .parse(new TextDecoder(encoding, { fatal: true }).decode(bytes)) as OrderedXml[];
}
function writeXml(nodes: OrderedXml[]): Uint8Array {
  nodes = nodes.map((node) => node["?xml"] ? { ...node,
    ":@": { ...(node[":@"] as Record<string, string>), encoding: "UTF-8" } } : node);
  return strToU8(new XMLBuilder({ preserveOrder: true, ignoreAttributes: false,
    attributeNamePrefix: "", suppressEmptyNode: false }).build(nodes) as string);
}
function childrenNamed(nodes: OrderedXml[] | XmlChildren, name: string): XmlChildren[] {
  const children = Array.isArray(nodes) ? nodes : nodes.children;
  return children.filter((node) => tagOf(node) === name).map((node) => ({
    children: node[name] as OrderedXml[], attributes: (node[":@"] ?? {}) as Record<string, string>,
  }));
}
function findNodes(nodes: OrderedXml[], name: string): XmlChildren[] {
  const found = childrenNamed(nodes, name);
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag) found.push(...findNodes(node[tag] as OrderedXml[], name));
  }
  return found;
}
function filterXml(nodes: OrderedXml[], omit: (name: string, children: OrderedXml[]) => boolean): OrderedXml[] {
  return nodes.flatMap((node) => {
    const tag = tagOf(node);
    if (!tag) return [node];
    const children = node[tag] as OrderedXml[];
    if (omit(tag, children)) return [];
    return [{ ...node, [tag]: filterXml(children, omit) }];
  });
}
function visibleShapes(nodes: OrderedXml[]): OrderedXml[] {
  return filterXml(nodes, (_name, children) => children.some((node) => {
    const tag = tagOf(node);
    return tag?.startsWith("p:nv") && childrenNamed(node[tag] as OrderedXml[], "p:cNvPr")
      .some((properties) => properties.attributes.hidden !== undefined && onOff(properties.attributes.hidden));
  }));
}
function hasXmlText(nodes: OrderedXml[]): boolean {
  return nodes.some((node) => node["#text"] !== undefined ? String(node["#text"]).length > 0
    : Boolean(tagOf(node) && hasXmlText(node[tagOf(node)!] as OrderedXml[])));
}
function onOff(value?: string): boolean {
  if (value === undefined || value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === "off") return false;
  throw new Error("Invalid visibility flag.");
}

/** Rebuild only declared semantic parts under the library's canonical filenames. */
function canonicalWorkbookOrDocument(source: Record<string, Uint8Array>, kind: "docx" | "xlsx"): Record<string, Uint8Array> {
  const word = kind === "docx";
  const main = word ? "word/document.xml" : "xl/workbook.xml";
  const mainXml = officeXml(source, main, word ? "w:document" : "workbook", word ? "wordprocessingml" : "spreadsheetml");
  if (word && childrenNamed(childrenNamed(mainXml, "w:document")[0]!, "w:body").length !== 1) {
    throw new Error("Missing document body.");
  }
  const result: Record<string, Uint8Array> = {};
  const names = new Map<string, string>([[main, main]]);
  const counts = new Map<string, number>();
  const roles: Record<string, { path: string; root: string }> = word ? {
    header: { path: "word/header#.xml", root: "w:hdr" }, footer: { path: "word/footer#.xml", root: "w:ftr" },
    styles: { path: "word/styles.xml", root: "w:styles" }, numbering: { path: "word/numbering.xml", root: "w:numbering" },
    footnotes: { path: "word/footnotes.xml", root: "w:footnotes" }, endnotes: { path: "word/endnotes.xml", root: "w:endnotes" },
  } : {
    worksheet: { path: "xl/worksheets/sheet#.xml", root: "worksheet" },
    styles: { path: "xl/styles.xml", root: "styleSheet" }, sharedStrings: { path: "xl/sharedStrings.xml", root: "sst" },
  };
  const sheetIds = new Set(findNodes(mainXml, "sheet").map((sheet) => sheet.attributes["r:id"]));
  const visit = (owner: string, destination: string, xml: OrderedXml[]): void => {
    result[destination] = writeXml(xml);
    const kept: XmlChildren[] = [];
    for (const relationship of relationshipsFor(source, owner)) {
      const role = relationshipRole(relationship);
      const descriptor = roles[role];
      if (!descriptor) {
        if (role === "hyperlink" && relationship.attributes.TargetMode === "External") kept.push(relationship);
        continue;
      }
      if (owner === main && role === "worksheet" && !sheetIds.has(relationship.attributes.Id)) continue;
      const part = relationshipPart(owner, relationship);
      let canonical = names.get(part);
      if (canonical === undefined) {
        const count = (counts.get(role) ?? 0) + 1; counts.set(role, count);
        canonical = descriptor.path.replace("#", String(count));
        if (Object.hasOwn(result, canonical)) throw new Error("Ambiguous semantic part.");
        names.set(part, canonical);
        visit(part, canonical, officeXml(source, part, descriptor.root, word ? "wordprocessingml" : "spreadsheetml"));
      }
      kept.push({ ...relationship, attributes: { ...relationship.attributes,
        Target: posix.relative(posix.dirname(destination), canonical) } });
    }
    if (kept.length) result[relationshipFile(destination)] = writeRelationships(kept);
  };
  visit(main, main, mainXml);
  const types = readXml(source["[Content_Types].xml"]!);
  result["[Content_Types].xml"] = writeXml(types.map((node) => tagOf(node) !== "Types" ? node : {
    ...node, Types: (node.Types as OrderedXml[]).flatMap((declaration) => {
      if (tagOf(declaration) !== "Override") return [declaration];
      const attributes = declaration[":@"] as Record<string, string>;
      const name = names.get(attributes.PartName?.replace(/^\//u, "") ?? "");
      return name ? [{ ...declaration, ":@": { ...attributes, PartName: `/${name}` } }] : [];
    }),
  }));
  result["_rels/.rels"] = writeRelationships([{ attributes: { Id: "main", Type:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", Target: main }, children: [] }]);
  return result;
}

function relationshipFile(owner: string): string { return posix.join(posix.dirname(owner), "_rels", `${posix.basename(owner)}.rels`); }
function relationshipRole(node: XmlChildren): string {
  return /^http:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/(\w+)$/u
    .exec(node.attributes.Type ?? "")?.[1] ?? "";
}
function relationshipPart(owner: string, node: XmlChildren): string {
  const value = node.attributes.Target;
  if (!value || (node.attributes.TargetMode !== undefined && node.attributes.TargetMode !== "Internal") || /[\\?#:\u0000]/u.test(value)) {
    throw new Error("Invalid internal relationship.");
  }
  const decoded = decodeURIComponent(value);
  if (/[\\?#:\u0000]/u.test(decoded)) throw new Error("Invalid part URI.");
  const part = posix.normalize(decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(owner), decoded));
  if (part.startsWith("../") || part === "..") throw new Error("Invalid part URI.");
  return part;
}
function relationshipsFor(parts: Record<string, Uint8Array>, owner: string): XmlChildren[] {
  const bytes = parts[relationshipFile(owner)];
  if (!bytes) return [];
  const nodes = readXml(bytes);
  const roots = childrenNamed(nodes, "Relationships");
  if (roots.length !== 1 || !["http://schemas.openxmlformats.org/package/2006/relationships", "http://purl.oclc.org/ooxml/package/relationships"]
    .includes(roots[0]!.attributes.xmlns ?? "")) throw new Error("Invalid part relationships.");
  const relationships = childrenNamed(roots[0]!, "Relationship");
  const ids = new Set<string>();
  for (const relationship of relationships) {
    const id = relationship.attributes.Id;
    if (!id || ids.has(id)) throw new Error("Ambiguous relationship identifier.");
    ids.add(id);
  }
  return relationships;
}
function writeRelationships(nodes: XmlChildren[]): Uint8Array {
  return writeXml([{ Relationships: nodes.map((node) => ({ Relationship: [], ":@": node.attributes })),
    ":@": { xmlns: "http://schemas.openxmlformats.org/package/2006/relationships" } }]);
}
function officeXml(parts: Record<string, Uint8Array>, name: string, rootName: string, family: string): OrderedXml[] {
  if (!Object.hasOwn(parts, name)) throw new Error("Missing semantic part.");
  const nodes = readXml(parts[name]!);
  const roots = nodes.filter((node) => tagOf(node) && !tagOf(node)!.startsWith("?"));
  const root = roots[0];
  const prefix = rootName.includes(":") ? rootName.split(":")[0]! : "";
  const namespaceName = prefix ? `xmlns:${prefix}` : "xmlns";
  const namespace = (root?.[":@"] as Record<string, string> | undefined)?.[namespaceName];
  if (roots.length !== 1 || tagOf(root!) !== rootName || ![
    `http://schemas.openxmlformats.org/${family}/2006/main`, `http://purl.oclc.org/ooxml/${family}/main`,
  ].includes(namespace ?? "")) throw new Error("Invalid semantic part identity.");
  const bindings: Record<string, string> = { [namespaceName]: namespace! };
  if (family === "presentationml") {
    bindings["xmlns:a"] = namespace!.replace("presentationml", "drawingml");
    bindings["xmlns:r"] = namespace!.includes("purl.oclc.org")
      ? "http://purl.oclc.org/ooxml/officeDocument/relationships"
      : "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  }
  const visit = (items: OrderedXml[]): void => {
    for (const node of items) {
      const attributes = (node[":@"] ?? {}) as Record<string, string>;
      for (const [key, expected] of Object.entries(bindings)) {
        if (attributes[key] !== undefined && attributes[key] !== expected) throw new Error("Rebound semantic namespace.");
      }
      const tag = tagOf(node); if (tag) visit(node[tag] as OrderedXml[]);
    }
  };
  visit(nodes);
  return nodes;
}
