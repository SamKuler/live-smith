import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import { unzipSync, strFromU8, strToU8, zipSync } from "fflate/browser";
import { AttachmentProcessingError } from "./contracts.js";
import { processAttachment } from "./processor.js";

function changed(name: string, edit: (parts: Record<string, Uint8Array>) => void): Uint8Array {
  const parts = unzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  edit(parts); return zipSync(parts, { level: 0 });
}
async function text(bytes: Uint8Array) {
  const result = await processAttachment({ bytes, fileName: "reference.bin", nativePdfAllowed: false });
  assert.equal(result.type, "text");
  if (result.type !== "text") throw new Error("Expected document text.");
  return result.text;
}

test("DOCX admission rejects incorrect main roots, namespaces and body identity", async () => {
  for (const edit of [
    (xml: string) => xml.replaceAll("w:document", "w:foo"),
    (xml: string) => xml.replace('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', 'xmlns:w="urn:spoof"'),
    (xml: string) => xml.replaceAll("w:body", "w:foo"),
    (xml: string) => xml.replace("<w:body>", '<w:body xmlns:w="urn:spoof">'),
  ]) {
    const bytes = changed("score.docx", (parts) => { parts["word/document.xml"] = strToU8(edit(strFromU8(parts["word/document.xml"]!))); });
    await assert.rejects(text(bytes), (error: unknown) => error instanceof AttachmentProcessingError && error.code === "invalid_document");
  }
});

test("unreferenced Word XML cannot append document text", async () => {
  const bytes = changed("score.docx", (parts) => {
    parts["word/document.xml.evil.xml"] = strToU8(strFromU8(parts["word/document.xml"]!).replace("Score sketch", "ORPHAN_MAIN_SECRET"));
  });
  const result = await text(bytes);
  assert.match(result, /Score sketch/); assert.doesNotMatch(result, /ORPHAN_MAIN_SECRET/);
});

test("unreferenced PowerPoint XML cannot replace declared slide content", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    parts["ppt/slides/slide1.xml.evil.xml"] = strToU8(strFromU8(parts["ppt/slides/slide1.xml"]!).replace("Verse", "ORPHAN_SLIDE_SECRET"));
  });
  const result = await text(bytes);
  assert.match(result, /Slide 1\nVerse/); assert.doesNotMatch(result, /ORPHAN_SLIDE_SECRET/);
});

test("PowerPoint parts follow references with arbitrary slide and notes filenames", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    const replacements = [["slide1.xml", "verse.xml"], ["notesSlide1.xml", "verse-notes.xml"]] as const;
    for (const name of Object.keys(parts)) {
      let target = name;
      for (const [original, replacement] of replacements) target = target.replace(original, replacement);
      let value = parts[name]!;
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        let xml = strFromU8(value);
        for (const [original, replacement] of replacements) xml = xml.replaceAll(original, replacement);
        value = strToU8(xml);
      }
      parts[target] = value;
      if (target !== name) delete parts[name];
    }
  });
  const result = await text(bytes);
  assert.match(result, /Slide 1\nVerse\n音乐: sparse drums\nNotes\nStart softly/);
  assert.match(result, /Slide 2\nChorus/);
});
