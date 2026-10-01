import { TextDecoder } from "node:util";
import { XMLBuilder } from "fast-xml-parser";

import { yieldToHost } from "../runtime/host.js";
import { AttachmentProcessingError } from "./contracts.js";
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
  "urn:oasis:names:tc:opendocument:xmlns:style:1.0": "style",
  "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0": "number",
  "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0": "fo",
  "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0": "svg",
  "http://www.w3.org/1999/xlink": "xlink",
  "http://purl.org/dc/elements/1.1/": "dc",
  "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0": "calcext",
  "http://www.w3.org/XML/1998/namespace": "xml",
};
const macroElementNames = new Set([
  "office:script", "text:script", "script:script", "script:event-listener",
]);

interface OdfPackage {
  mediaType: OdfMediaType;
  body: XmlElement;
  canonicalContent: string;
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
  return { mediaType: typedMediaType, body: contentBodies[0]!, canonicalContent: serializeRoot(root) };
}

async function normalizeRoot(bytes: Uint8Array, expected: string, signal?: AbortSignal): Promise<XmlElement> {
  const nodes = parseXmlPreservingOrder(bytes);
  let visited = 0;
  const prefixes = new Map(Object.entries(namespaceAliases).map(([uri, prefix]) => [uri, prefix]));
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
      let canonicalPrefix = prefixes.get(uri);
      if (canonicalPrefix === undefined) {
        canonicalPrefix = `ns${prefixes.size}`;
        prefixes.set(uri, canonicalPrefix);
      }
      return `${canonicalPrefix}:${local}`;
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
  const attributes = { ...root.attributes };
  for (const [uri, prefix] of prefixes) attributes[`xmlns:${prefix}`] = uri;
  if (root.name !== expected) throw invalidDocument("OpenDocument XML root or namespace is invalid.");
  await yieldToHost(signal);
  return { ...root, attributes };
}

/** Canonical prefixes adapt namespace-aware admission to the parser's QName selectors. */
function serializeRoot(root: XmlElement): string {
  const ordered = (node: XmlNode): Record<string, unknown> => node.type === "text"
    ? { "#text": node.value }
    : { [node.name]: node.children.map(ordered), ":@": node.attributes };
  return new XMLBuilder({ preserveOrder: true, ignoreAttributes: false,
    attributeNamePrefix: "", suppressEmptyNode: false }).build([ordered(root)]) as string;
}

function containsElement(root: XmlElement, names: string | ReadonlySet<string>): boolean {
  return (typeof names === "string" ? root.name === names : names.has(root.name)) ||
    root.children.some((node) => node.type === "element" && containsElement(node, names));
}

function invalidDocument(message: string): AttachmentProcessingError { return new AttachmentProcessingError("invalid_document", message); }
function macroEnabled(): AttachmentProcessingError { return new AttachmentProcessingError("macro_enabled", "Macro-enabled OpenDocument documents are not supported."); }
