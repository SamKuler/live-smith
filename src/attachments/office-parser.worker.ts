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
    const hiddenColumns = new Map<string, { first: number; end: number }[]>();
    let slideOrder: { position: number; hasText: boolean }[] | undefined;
    let omittedSlides = false;
    if (job.canonicalOdfContent !== undefined) {
      parts = Object.fromEntries(["mimetype", "META-INF/manifest.xml", "content.xml", "styles.xml"]
        .filter((name) => Object.hasOwn(parts, name)).map((name) => [name, parts[name]!]));
      let content = readXml(strToU8(job.canonicalOdfContent));
      const rootAttributes = childrenNamed(content, "office:document-content")[0]!.attributes;
      const vocabulary = Object.fromEntries(Object.entries(rootAttributes)
        .filter(([name]) => name.startsWith("xmlns:") && !/^xmlns:ns\d+$/u.test(name))
        .map(([name, uri]) => [uri, name.slice(6)]));
      const policy = { elements: vocabulary, attributes: vocabulary, unqualifiedAttributes: false };
      if (parts["styles.xml"]) parts["styles.xml"] = writeXml(projectNamespaces(readXml(parts["styles.xml"]), policy));
      const styleRoot = parts["styles.xml"] ? readXml(parts["styles.xml"]) : [{ "office:document-styles": [], ":@": rootAttributes }];
      const styleContent = projectNamespaces(content, policy);
      const styles = odfStyles(styleRoot, styleContent);
      if (job.fileType === "ods") {
        const styleElement = childrenNamed(styleRoot, "office:document-styles")[0];
        const automatic = childrenNamed(childrenNamed(styleContent, "office:document-content")[0]!, "office:automatic-styles");
        if (styleElement) {
          styleElement.children.push(...automatic.map((node) => ({ "office:automatic-styles": node.children, ":@": node.attributes })));
          parts["styles.xml"] = writeXml(styleRoot);
        }
        content = projectNamespaces(content, { ...policy, members: ODS_MEMBERS, children: ODS_CHILDREN,
          textContainers: ["text:p", "text:h", "text:span", "text:a"], omittedTextElements: ["text:tracked-changes", "text:deletion"] });
        // SheetJS resolves cell-to-number-format references only in content.xml.
        // Restore those owned attributes without restoring arbitrary style children.
        const mappings: OrderedXml[] = [];
        for (const name of styles.get("table-cell")?.keys() ?? []) {
          const format = odfStyleValue(styles, "table-cell", name, (style) => style.attributes["style:data-style-name"]);
          if (name && format) mappings.push({ "style:style": [], ":@": {
            "style:name": name, "style:family": "table-cell", "style:data-style-name": format,
          } });
        }
        if (mappings.length) childrenNamed(content, "office:document-content")[0]!.children.unshift({ "office:automatic-styles": mappings });
        const tables = findNodes(content, "table:table");
        distinctSheetNames(tables.map((node) => node.attributes["table:name"]));
        for (const table of tables) {
          const ranges: { first: number; end: number }[] = [];
          let column = 0;
          for (const definition of findNodes(table.children, "table:table-column")) {
            const repeat = Number(definition.attributes["table:number-columns-repeated"] ?? 1);
            if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error("Invalid column repetition.");
            if (["collapse", "filter"].includes(definition.attributes["table:visibility"] ?? "")) ranges.push({ first: column, end: column + repeat });
            column += repeat;
          }
          hiddenColumns.set(table.attributes["table:name"]!, ranges);
        }
      }
      if (job.fileType === "odp") {
        const presentation = childrenNamed(childrenNamed(childrenNamed(content, "office:document-content")[0]!, "office:body")[0]!, "office:presentation")[0]!;
        slideOrder = [];
        for (const [index, page] of childrenNamed(presentation, "draw:page").entries()) {
          const visibility = odfStyleValue(styles, "drawing-page", page.attributes["draw:style-name"],
            (style) => childrenNamed(style, "style:drawing-page-properties")[0]?.attributes["presentation:visibility"]);
          if (visibility === "hidden") {
            page.children.length = 0;
            omittedSlides = true;
          } else {
            slideOrder.push({ position: index + 1, hasText: hasOdfText(page.children) });
          }
        }
      }
      const prepareSheet = (nodes: OrderedXml[]): OrderedXml[] => nodes.map((node) => {
        const tag = tagOf(node);
        if (!tag) return node;
        const attributes = (node[":@"] ?? {}) as Record<string, string>;
        const display = tag === "table:table" ? attributes["table:display"] ?? odfStyleValue(styles, "table", attributes["table:style-name"],
          (style) => childrenNamed(style, "style:table-properties")[0]?.attributes["table:display"]) : undefined;
        const hiddenSheet = tag === "table:table" && display !== undefined && !onOff(display);
        if (hiddenSheet) hiddenSheets.add(attributes["table:name"] ?? "");
        const hidden = hiddenSheet || (tag === "table:table-row" && ["collapse", "filter"].includes(attributes["table:visibility"] ?? ""));
        let children = hidden ? [] : prepareSheet(node[tag] as OrderedXml[]);
        if (tag === "table:table-cell" && attributes["office:string-value"] !== undefined &&
            childrenNamed(children, "text:p").length === 0) {
          children = [...children, { "text:p": [{ "#text": attributes["office:string-value"] }] }];
        }
        if (tag === "table:table-cell" && attributes["table:formula"] !== undefined &&
            !hasOdfCachedValue(attributes, children)) {
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
      const result = extractSpreadsheet(bytes, job.maxCharacters, job.fileType, hiddenSheets, hiddenColumns);
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

function extractSpreadsheet(bytes: Uint8Array, maxCharacters: number, fileType: "xlsx" | "ods", hiddenSheets: ReadonlySet<string>, hiddenColumns: ReadonlyMap<string, readonly { first: number; end: number }[]>): { text: string; truncated: boolean } {
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
        if (hiddenColumns.get(name)?.some((range) => Number(columnKey) >= range.first && Number(columnKey) < range.end)) continue;
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
    attributeNamePrefix: "", suppressEmptyNode: false,
    // SheetJS recognizes ODF whitespace controls in their empty-element form.
    unpairedTags: ["text:s", "text:tab", "text:line-break"], suppressUnpairedNode: false }).build(nodes) as string);
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
function hasOdfText(nodes: OrderedXml[]): boolean {
  return [...findNodes(nodes, "text:p"), ...findNodes(nodes, "text:h")].some((paragraph) =>
    hasXmlText(paragraph.children) || ["text:s", "text:tab", "text:line-break"].some((name) => findNodes(paragraph.children, name).length > 0));
}
function hasOdfCachedValue(attributes: Readonly<Record<string, string>>, children: OrderedXml[]): boolean {
  const type = attributes["office:value-type"];
  const fields: Readonly<Record<string, string>> = {
    float: "office:value", percentage: "office:value", currency: "office:value", boolean: "office:boolean-value",
    date: "office:date-value", time: "office:time-value", string: "office:string-value",
  };
  return Object.hasOwn(attributes, fields[type ?? ""] ?? "office:string-value") ||
    type === "string" && [...findNodes(children, "text:p"), ...findNodes(children, "text:h")].length > 0 ||
    type === undefined && hasOdfText(children);
}
type OdfStyles = Map<string, Map<string, XmlChildren>>;
function odfStyles(...documents: OrderedXml[][]): OdfStyles {
  const styles: OdfStyles = new Map();
  for (const document of documents) {
    const roots = [...childrenNamed(document, "office:document-styles"), ...childrenNamed(document, "office:document-content")];
    for (const root of roots) {
      for (const collection of [...childrenNamed(root, "office:styles"), ...childrenNamed(root, "office:automatic-styles")]) {
        for (const node of [...childrenNamed(collection, "style:default-style"), ...childrenNamed(collection, "style:style")]) {
          const family = node.attributes["style:family"];
          if (!family) continue;
          let members = styles.get(family);
          if (!members) { members = new Map(); styles.set(family, members); }
          members.set(node.attributes["style:name"] ?? "", node);
        }
      }
    }
  }
  return styles;
}
function odfStyleValue(styles: OdfStyles, family: string, name: string | undefined, value: (style: XmlChildren) => string | undefined): string | undefined {
  const members = styles.get(family);
  const visited = new Set<string>();
  let current: string | undefined = name ?? "";
  while (current !== undefined) {
    if (visited.has(current)) throw new Error("Cyclic ODF style inheritance.");
    visited.add(current);
    const style: XmlChildren | undefined = members?.get(current);
    const property = style && value(style);
    if (property !== undefined) return property;
    current = style?.attributes["style:parent-style-name"] ?? (current ? "" : undefined);
  }
  return undefined;
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
  const names = new Map<string, { path: string; role: string }>([[main, { path: main, role: "officeDocument" }]]);
  const counts = new Map<string, number>();
  const roles: Record<string, { path: string; root: string }> = word ? {
    header: { path: "word/header#.xml", root: "w:hdr" }, footer: { path: "word/footer#.xml", root: "w:ftr" },
    styles: { path: "word/styles.xml", root: "w:styles" }, numbering: { path: "word/numbering.xml", root: "w:numbering" },
    footnotes: { path: "word/footnotes.xml", root: "w:footnotes" }, endnotes: { path: "word/endnotes.xml", root: "w:endnotes" },
  } : {
    worksheet: { path: "xl/worksheets/sheet#.xml", root: "worksheet" },
    styles: { path: "xl/styles.xml", root: "styleSheet" }, sharedStrings: { path: "xl/sharedStrings.xml", root: "sst" },
  };
  const sheets = word ? [] : childrenNamed(childrenNamed(mainXml, "workbook")[0]!, "sheets")
    .flatMap((list) => childrenNamed(list, "sheet"));
  if (!word) distinctSheetNames(sheets.map((sheet) => sheet.attributes.name));
  const sheetIds = new Set<string>();
  const numericIds = new Set<string>();
  for (const sheet of sheets) {
    const id = sheet.attributes["r:id"];
    const numericId = sheet.attributes.sheetId;
    if (!id || sheetIds.has(id) || !numericId || numericIds.has(numericId)) throw new Error("Ambiguous sheet identity.");
    sheetIds.add(id); numericIds.add(numericId);
  }
  const visit = (owner: string, destination: string, xml: OrderedXml[]): void => {
    result[destination] = writeXml(!word && destination.startsWith("xl/worksheets/") ? preserveFormulaCaches(xml) : xml);
    const kept: XmlChildren[] = [];
    for (const relationship of relationshipsFor(source, owner)) {
      const role = relationshipRole(relationship);
      const descriptor = roles[role];
      if (!descriptor) {
        if (role === "hyperlink" && relationship.attributes.TargetMode === "External") kept.push(relationship);
        continue;
      }
      if (owner === main && role === "worksheet" && !sheetIds.has(relationship.attributes.Id!)) continue;
      const part = relationshipPart(owner, relationship);
      let identity = names.get(part);
      if (identity && identity.role !== role) throw new Error("Conflicting semantic part roles.");
      if (identity === undefined) {
        const count = (counts.get(role) ?? 0) + 1; counts.set(role, count);
        identity = { path: descriptor.path.replace("#", String(count)), role };
        if (Object.hasOwn(result, identity.path)) throw new Error("Ambiguous semantic part.");
        names.set(part, identity);
        visit(part, identity.path, officeXml(source, part, descriptor.root, word ? "wordprocessingml" : "spreadsheetml"));
      }
      kept.push({ ...relationship, attributes: { ...relationship.attributes,
        Target: posix.relative(posix.dirname(destination), identity.path) } });
    }
    if (owner === main && !word && [...sheetIds].some((id) => !kept.some((node) => node.attributes.Id! === id && relationshipRole(node) === "worksheet"))) {
      throw new Error("Missing worksheet relationship.");
    }
    if (kept.length) result[relationshipFile(destination)] = writeRelationships(kept);
  };
  visit(main, main, mainXml);
  const types = readXml(source["[Content_Types].xml"]!);
  result["[Content_Types].xml"] = writeXml(types.map((node) => tagOf(node) !== "Types" ? node : {
    ...node, Types: (node.Types as OrderedXml[]).flatMap((declaration) => {
      if (tagOf(declaration) !== "Override") return [declaration];
      const attributes = declaration[":@"] as Record<string, string>;
      const identity = names.get(attributes.PartName?.replace(/^\//u, "") ?? "");
      return identity ? [{ ...declaration, ":@": { ...attributes, PartName: `/${identity.path}` } }] : [];
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
  const normalized = projectNamespaces(nodes, { elements: { [roots[0]!.attributes.xmlns!]: "" },
    attributes: {}, unqualifiedAttributes: true, members: { Relationships: [], Relationship: ["Id", "Type", "Target", "TargetMode"] },
    children: { Relationships: ["Relationship"] } });
  const relationships = childrenNamed(childrenNamed(normalized, "Relationships")[0]!, "Relationship");
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
  if (family === "presentationml") bindings["xmlns:a"] = namespace!.replace("presentationml", "drawingml");
  bindings["xmlns:r"] = namespace!.includes("purl.oclc.org")
    ? "http://purl.oclc.org/ooxml/officeDocument/relationships"
    : "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const visit = (items: OrderedXml[], inherited: Record<string, string> = {}): void => {
    for (const node of items) {
      const attributes = (node[":@"] ?? {}) as Record<string, string>;
      for (const [key, expected] of Object.entries(bindings)) {
        if (attributes[key] !== undefined && attributes[key] !== expected) throw new Error("Rebound semantic namespace.");
      }
      const scoped = { ...inherited };
      for (const [key, value] of Object.entries(attributes)) if (key === "xmlns" || key.startsWith("xmlns:")) scoped[key] = value;
      const tag = tagOf(node);
      if (tag && !tag.startsWith("?")) {
        for (const name of [tag, ...Object.keys(attributes).filter((key) => !key.startsWith("xmlns") && key.includes(":"))]) {
          const key = name.includes(":") ? `xmlns:${name.split(":")[0]}` : "xmlns";
          if (bindings[key] !== undefined && scoped[key] !== bindings[key]) throw new Error("Unbound semantic namespace.");
        }
        visit(node[tag] as OrderedXml[], scoped);
      }
    }
  };
  visit(nodes);
  return family === "spreadsheetml" ? projectNamespaces(nodes, {
    elements: { [namespace!]: "" }, attributes: { [bindings["xmlns:r"]!]: "r", "http://www.w3.org/XML/1998/namespace": "xml" },
    unqualifiedAttributes: true, attributeNames: { r: ["id"], xml: ["space", "lang"] },
    ...(rootName === "styleSheet" ? {} : { members: XLSX_MEMBERS, children: XLSX_CHILDREN }),
  }) : nodes;
}

function distinctSheetNames(names: readonly (string | undefined)[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name)) throw new Error("Ambiguous sheet name.");
    seen.add(name);
  }
}

/** Preserve raw value presence before the library synthesizes typed defaults. */
function preserveFormulaCaches(nodes: OrderedXml[]): OrderedXml[] {
  return nodes.map((node) => {
    const tag = tagOf(node); if (!tag) return node;
    let children = preserveFormulaCaches(node[tag] as OrderedXml[]);
    if (tag === "c") {
      const attributes = (node[":@"] ?? {}) as Record<string, string>;
      const values = childrenNamed(children, "v");
      const cached = values.length === 1 && (attributes.t === "str" || hasXmlText(values[0]!.children) &&
        values[0]!.children.some((child) => String(child["#text"] ?? "").trim()));
      if (!cached && childrenNamed(children, "f").length) {
        children = [...children.filter((child) => !["v", "is"].includes(tagOf(child) ?? "")), { v: [{ "#text": "[cached value unavailable]" }] }];
        return { ...node, c: children, ":@": { ...attributes, t: "str" } };
      }
      if (!cached && !childrenNamed(children, "is").length) {
        const cleaned = { ...attributes }; delete cleaned.t;
        return { ...node, c: children.filter((child) => tagOf(child) !== "v"), ":@": cleaned };
      }
    }
    return { ...node, [tag]: children };
  });
}

interface NamespacePolicy {
  elements: Readonly<Record<string, string>>;
  attributes: Readonly<Record<string, string>>;
  unqualifiedAttributes: boolean;
  attributeNames?: Readonly<Record<string, readonly string[]>>;
  members?: Readonly<Record<string, readonly string[]>>;
  children?: Readonly<Record<string, readonly string[]>>;
  textContainers?: readonly string[];
  omittedTextElements?: readonly string[];
}
/** Feed prefix-insensitive libraries only namespace-owned semantic XML. */
function projectNamespaces(nodes: OrderedXml[], policy: NamespacePolicy): OrderedXml[] {
  const visit = (items: OrderedXml[], inherited: Record<string, string>, parent?: string): OrderedXml[] => items.flatMap((node) => {
    const tag = tagOf(node);
    if (!tag || tag.startsWith("?")) return [node];
    const attributes = (node[":@"] ?? {}) as Record<string, string>;
    const scoped = { ...inherited };
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "xmlns") scoped[""] = value;
      else if (name.startsWith("xmlns:")) scoped[name.slice(6)] = value;
    }
    const expanded = (name: string, attribute: boolean): { uri: string; local: string } => {
      const colon = name.indexOf(":");
      const prefix = colon < 0 ? "" : name.slice(0, colon);
      if (prefix && !scoped[prefix]) throw new Error("Undeclared XML namespace.");
      return { uri: colon < 0 && attribute ? "" : scoped[prefix] ?? "", local: colon < 0 ? name : name.slice(colon + 1) };
    };
    const element = expanded(tag, false);
    if (!Object.hasOwn(policy.elements, element.uri)) return [];
    const prefix = policy.elements[element.uri]!;
    const name = prefix ? `${prefix}:${element.local}` : element.local;
    const childNames = parent && policy.members ? policy.children?.[parent] ?? [] : undefined;
    if (policy.members && !Object.hasOwn(policy.members, name) || childNames && !childNames.includes(name)) {
      if (!parent || !policy.textContainers?.includes(parent) || prefix !== parent.split(":")[0]) return [];
      const flatten = (items: OrderedXml[], inherited: Record<string, string>): OrderedXml[] => items.flatMap((item) => {
        const tag = tagOf(item); if (!tag) return [item];
        const attributes = (item[":@"] ?? {}) as Record<string, string>;
        const scope = { ...inherited };
        for (const [key, value] of Object.entries(attributes)) {
          if (key === "xmlns") scope[""] = value;
          else if (key.startsWith("xmlns:")) scope[key.slice(6)] = value;
        }
        const colon = tag.indexOf(":");
        const local = colon < 0 ? tag : tag.slice(colon + 1);
        const uri = scope[colon < 0 ? "" : tag.slice(0, colon)];
        if (uri !== element.uri || policy.omittedTextElements?.includes(`${prefix}:${local}`)) return [];
        return flatten(item[tag] as OrderedXml[], scope);
      });
      return flatten([node], inherited);
    }
    const allowed = policy.members?.[name];
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      const attribute = expanded(key, true);
      if (!key.includes(":")) { if (policy.unqualifiedAttributes && (!allowed || allowed.includes(key))) kept[key] = value; continue; }
      const alias = policy.attributes[attribute.uri];
      if (alias === undefined || !alias || policy.attributeNames?.[alias] && !policy.attributeNames[alias]!.includes(attribute.local)) continue;
      const canonical = `${alias}:${attribute.local}`;
      if (allowed && !allowed.includes(canonical)) continue;
      if (kept[canonical] !== undefined) throw new Error("Duplicate expanded attribute.");
      kept[canonical] = value;
    }
    return [{ [name]: visit(node[tag] as OrderedXml[], scoped, name), ":@": kept }];
  });
  const projected = visit(nodes, { xml: "http://www.w3.org/XML/1998/namespace" });
  for (const node of projected) {
    const tag = tagOf(node); if (!tag || tag.startsWith("?")) continue;
    const declarations = { ...(node[":@"] as Record<string, string>) };
    for (const [uri, prefix] of Object.entries({ ...policy.elements, ...policy.attributes })) declarations[prefix ? `xmlns:${prefix}` : "xmlns"] = uri;
    node[":@"] = declarations;
  }
  return projected;
}

// These are the semantic branches and fields consumed for spreadsheet context.
// Formatting remains in its separately parsed style part.
const XLSX_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  workbook: [], workbookPr: ["date1904"], sheets: [], sheet: ["name", "sheetId", "state", "r:id"],
  definedNames: [], definedName: ["name", "localSheetId", "hidden"],
  worksheet: [], dimension: ["ref"], sheetData: [], row: ["r", "hidden"], c: ["r", "t", "s"],
  v: [], f: ["t", "si", "ref"], is: [], t: ["xml:space"], r: [], rPr: [],
  cols: [], col: ["min", "max", "hidden"], mergeCells: [], mergeCell: ["ref"],
  hyperlinks: [], hyperlink: ["ref", "r:id", "location", "display"], sst: ["count", "uniqueCount"], si: [],
};
const XLSX_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  workbook: ["workbookPr", "sheets", "definedNames"], sheets: ["sheet"], definedNames: ["definedName"],
  worksheet: ["dimension", "sheetData", "cols", "mergeCells", "hyperlinks"], sheetData: ["row"], row: ["c"],
  c: ["v", "f", "is"], is: ["t", "r"], r: ["rPr", "t"], rPr: [], cols: ["col"],
  mergeCells: ["mergeCell"], hyperlinks: ["hyperlink"], sst: ["si"], si: ["t", "r"],
};
const odfRows = ["table:table-row", "table:table-rows", "table:table-header-rows", "table:table-row-group"];
const odfColumns = ["table:table-column", "table:table-columns", "table:table-header-columns", "table:table-column-group"];
const odfInline = ["text:span", "text:s", "text:tab", "text:line-break", "text:a"];
const odfParagraphs = ["text:p", "text:h", "text:list"];
const odfCellFields = ["office:value-type", "office:value", "office:currency", "office:boolean-value", "office:date-value", "office:time-value", "office:string-value", "calcext:value-type",
  "table:formula", "table:style-name", "table:number-columns-repeated", "table:number-rows-spanned", "table:number-columns-spanned", "table:number-matrix-rows-spanned", "table:number-matrix-columns-spanned"];
const ODS_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "office:document-content": ["office:version"], "office:body": [], "office:spreadsheet": [],
  "table:calculation-settings": [], "table:null-date": ["table:date-value"],
  "table:table": ["table:name", "table:style-name", "table:display"],
  "table:table-row": ["table:style-name", "table:default-cell-style-name", "table:number-rows-repeated", "table:visibility"],
  "table:table-column": ["table:style-name", "table:default-cell-style-name", "table:number-columns-repeated", "table:visibility"],
  "table:table-cell": odfCellFields, "table:covered-table-cell": ["table:number-columns-repeated"],
  ...Object.fromEntries([...odfRows, ...odfColumns].filter((name) => name !== "table:table-row" && name !== "table:table-column").map((name) => [name, []])),
  "text:p": ["text:style-name", "xml:space"], "text:h": ["text:style-name", "text:outline-level", "xml:space"],
  "text:span": ["text:style-name"], "text:a": ["xlink:href"], "text:s": ["text:c"], "text:tab": [], "text:line-break": [],
  "text:list": ["text:style-name"], "text:list-item": [],
};
const ODS_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  "office:document-content": ["office:body"], "office:body": ["office:spreadsheet"], "office:spreadsheet": ["table:calculation-settings", "table:table"],
  "table:calculation-settings": ["table:null-date"],
  "table:table": [...odfRows, ...odfColumns], "table:table-row": ["table:table-cell", "table:covered-table-cell"],
  ...Object.fromEntries(odfRows.filter((name) => name !== "table:table-row").map((name) => [name, odfRows])),
  ...Object.fromEntries(odfColumns.filter((name) => name !== "table:table-column").map((name) => [name, odfColumns])),
  "table:table-cell": odfParagraphs, "table:covered-table-cell": [],
  "text:p": odfInline, "text:h": odfInline, "text:span": odfInline, "text:a": odfInline,
  "text:list": ["text:list-item"], "text:list-item": odfParagraphs,
};

void parse(workerData as ParseJob);
