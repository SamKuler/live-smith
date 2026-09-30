import { Buffer } from "node:buffer";
import { strToU8, zipSync } from "fflate/browser";
import type { OdfMediaType } from "./odf.js";

export function rtfBytes(value: string): Uint8Array { return Buffer.from(value, "latin1"); }

export function odfBytes(kind: "text" | "spreadsheet" | "presentation", content: string, additions: Record<string, string | Uint8Array> = {}): Uint8Array {
  const mediaType: OdfMediaType = `application/vnd.oasis.opendocument.${kind}`;
  const entries: Record<string, Uint8Array> = {
    mimetype: strToU8(mediaType),
    "META-INF/manifest.xml": strToU8(
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">` +
      `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/>` +
      `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
      `</manifest:manifest>`,
    ),
    "content.xml": strToU8(
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
      `xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ` +
      `xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ` +
      `xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">` +
      `<office:body><office:${kind}>${content}</office:${kind}></office:body></office:document-content>`,
    ),
  };
  for (const [name, value] of Object.entries(additions)) entries[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(entries, { level: 0 });
}
