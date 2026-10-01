import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";

import { unzipSync, strFromU8, strToU8, zipSync } from "fflate/browser";
import XLSX from "xlsx";
import * as esbuild from "esbuild";

import { buildDocumentParserScript } from "../../scripts/build-document-parser.js";
import { AttachmentProcessingError, ATTACHMENT_FORMATS } from "./contracts.js";
import { processAttachment } from "./processor.js";

function fixture(name: string): Uint8Array { return readFileSync(new URL(`./fixtures/${name}`, import.meta.url)); }
function changed(name: string, edit: (parts: Record<string, Uint8Array>) => void): Uint8Array {
  const parts = unzipSync(fixture(name)); edit(parts); return zipSync(parts, { level: 0 });
}
async function text(bytes: Uint8Array, name = "renamed.bin") {
  const result = await processAttachment({ bytes, fileName: name, nativePdfAllowed: false });
  assert.equal(result.type, "text");
  if (result.type !== "text") throw new Error("Expected document text.");
  return result;
}

test("native DOCX exports retain Unicode, paragraphs and table values", async () => {
  const result = await text(fixture("score.docx"));
  assert.match(result.text, /Score sketch\n音乐 reference 🎵\nMelody: C4 E4 G4/);
  assert.match(result.text, /Track\nRole\nLead\n旋律/);
  assert.ok(result.text.indexOf("End of sketch") > result.text.indexOf("Lead"));
  assert.equal(result.truncated, false);
});

test("native XLSX exports retain sheet identity, exact values and uncached formulas", async () => {
  const result = await text(fixture("arrangement.xlsx"));
  assert.match(result.text, /Sheet "Harmony"/);
  assert.match(result.text, /C2="123456789\.125"\tD2="true"/);
  assert.match(result.text, /F4="\[cached value unavailable\]" \[formula "SUM\(A2:A3\)"\]/);
  assert.match(result.text, /Sheet "节奏"\nRow 1: A1="Track"/);
  assert.equal(result.truncated, false);
});

test("native PPTX exports retain referenced slide order and speaker notes", async () => {
  const result = await text(fixture("arrangement.pptx"));
  assert.match(result.text, /Slide 1\nVerse\n音乐: sparse drums\nNotes\nStart softly/);
  assert.match(result.text, /Slide 2\nChorus\nBring in the lead 🎵\nNotes\nKeep the bass clear/);
  assert.equal(result.truncated, false);
  const reordered = changed("arrangement.pptx", (parts) => {
    const xml = strFromU8(parts["ppt/presentation.xml"]!);
    const ids = [...xml.matchAll(/<p:sldId\b[^>]*\/>/gu)].map((match) => match[0]);
    assert.equal(ids.length, 2);
    parts["ppt/presentation.xml"] = strToU8(xml.replace(ids.join(""), [...ids].reverse().join("")));
  });
  const reversed = await text(reordered);
  assert.ok(reversed.text.indexOf("Chorus") < reversed.text.indexOf("Verse"));
  assert.match(reversed.text, /Slide 1\nChorus/);
});

test("PPTX speaker notes follow relationships independently of filename numbers", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    for (const number of [1, 2]) {
      const name = `ppt/slides/_rels/slide${number}.xml.rels`;
      parts[name] = strToU8(strFromU8(parts[name]!).replace(`notesSlide${number}.xml`, `notesSlide${3 - number}.xml`));
    }
  });
  const result = await text(bytes);
  assert.match(result.text, /Verse\n音乐: sparse drums\nNotes\nKeep the bass clear/);
  assert.match(result.text, /Chorus\nBring in the lead 🎵\nNotes\nStart softly/);
  const renamed = changed("arrangement.pptx", (parts) => {
    for (const [original, replacement] of [[1, 5], [2, 12]]) {
      for (const name of Object.keys(parts)) {
        if (name === `ppt/slides/slide${original}.xml` || name === `ppt/slides/_rels/slide${original}.xml.rels`) {
          const target = name.replace(`slide${original}.xml`, `slide${replacement}.xml`);
          parts[target] = parts[name]!; delete parts[name];
        } else if (name.endsWith(".rels") || name === "[Content_Types].xml") {
          parts[name] = strToU8(strFromU8(parts[name]!).replaceAll(`slide${original}.xml`, `slide${replacement}.xml`));
        }
      }
    }
  });
  assert.match((await text(renamed)).text, /Verse\n音乐: sparse drums\nNotes\nStart softly/);
});

test("valid blank PPTX slides preserve their position without rejecting other slides", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    parts["ppt/slides/slide1.xml"] = strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>');
    delete parts["ppt/slides/_rels/slide1.xml.rels"];
    delete parts["ppt/notesSlides/notesSlide1.xml"];
    parts["[Content_Types].xml"] = strToU8(strFromU8(parts["[Content_Types].xml"]!).replace(/<Override[^>]*PartName="\/ppt\/notesSlides\/notesSlide1\.xml"[^>]*\/>/u, ""));
  });
  const result = await text(bytes);
  assert.match(result.text, /Slide 1\nSlide 2\nChorus/);
  assert.doesNotMatch(result.text, /Start softly/);
});

test("PPTX accepts empty notes parts while retaining notes on other slides", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    parts["ppt/notesSlides/notesSlide1.xml"] = strToU8(strFromU8(parts["ppt/notesSlides/notesSlide1.xml"]!).replace("Start softly", ""));
  });
  const result = await text(bytes);
  assert.match(result.text, /Slide 1\nVerse/);
  assert.match(result.text, /Slide 2\nChorus\nBring in the lead 🎵\nNotes\nKeep the bass clear/);
  assert.doesNotMatch(result.text, /Start softly/);
});

test("PPTX explicitly hidden notes stay outside context", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    parts["ppt/notesSlides/notesSlide1.xml"] = strToU8(strFromU8(parts["ppt/notesSlides/notesSlide1.xml"]!).replaceAll("<p:cNvPr ", '<p:cNvPr hidden="1" '));
  });
  const result = await text(bytes);
  assert.doesNotMatch(result.text, /Start softly/);
  assert.match(result.text, /Keep the bass clear/);
});

test("DOCX explicitly hidden and deleted runs remain excluded", async () => {
  const bytes = changed("score.docx", (parts) => {
    const hidden = '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN_DOCX</w:t></w:r>' +
      '<w:del><w:r><w:delText>DELETED_DOCX</w:delText></w:r></w:del>' +
      '<w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>VISIBLE_DOCX</w:t></w:r></w:p>';
    parts["word/document.xml"] = strToU8(strFromU8(parts["word/document.xml"]!).replace("</w:body>", `${hidden}</w:body>`));
  });
  const result = await text(bytes);
  assert.doesNotMatch(result.text, /HIDDEN_DOCX|DELETED_DOCX/);
  assert.match(result.text, /VISIBLE_DOCX/);
});

test("visibility preprocessing preserves numeric-looking strings literally", async () => {
  const values = ["00123", "0xFF", "1e3", "000", "1.2300", "true", "false"];
  const word = changed("score.docx", (parts) => {
    const paragraphs = values.map((value) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`).join("");
    parts["word/document.xml"] = strToU8(strFromU8(parts["word/document.xml"]!).replace("</w:body>", `${paragraphs}</w:body>`));
  });
  const wordResult = await text(word);
  assert.ok(wordResult.text.endsWith(values.join("\n")));
  const presentation = changed("arrangement.pptx", (parts) => {
    parts["ppt/slides/slide1.xml"] = strToU8(strFromU8(parts["ppt/slides/slide1.xml"]!).replace(">Verse<", ">00123<"));
  });
  assert.match((await text(presentation)).text, /Slide 1\n00123\n/);
});

test("XLSX hidden sheets, rows and columns stay outside context", async () => {
  const book = XLSX.read(fixture("arrangement.xlsx"), { type: "array", cellStyles: true });
  book.Sheets.Harmony!["!rows"] = [{}, { hidden: true }];
  book.Sheets.Harmony!["!cols"] = [{}, { hidden: true }];
  book.Workbook!.Sheets![1]!.Hidden = 2;
  const result = await text(new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })));
  assert.doesNotMatch(result.text, /Cmaj7|Fmaj7|123456789|Drums|Chord/);
  assert.match(result.text, /Hidden row 2 omitted/);
  assert.match(result.text, /Hidden sheet "节奏" omitted/);
});

test("PPTX hidden slides and shapes stay excluded while visible notes remain", async () => {
  const bytes = changed("arrangement.pptx", (parts) => {
    parts["ppt/slides/slide1.xml"] = strToU8(strFromU8(parts["ppt/slides/slide1.xml"]!).replace("<p:sld ", '<p:sld show="0" '));
    parts["ppt/slides/slide2.xml"] = strToU8(strFromU8(parts["ppt/slides/slide2.xml"]!).replace('<p:cNvPr id="2"', '<p:cNvPr hidden="1" id="2"'));
  });
  const result = await text(bytes);
  assert.doesNotMatch(result.text, /Verse|sparse drums|Start softly|Chorus/);
  assert.match(result.text, /Slide 2\nBring in the lead 🎵/);
  assert.match(result.text, /Hidden slides omitted/);
});

test("spreadsheet output at the exact boundary reports omitted later sheets", async () => {
  const book = XLSX.utils.book_new();
  const overhead = 'Sheet "Exact"'.length + [1, 2, 3, 4].reduce((sum, row) => sum + `\nRow ${row}: A${row}=""`.length, 0);
  const rows = [30_000, 30_000, 30_000, 100_000 - overhead - 90_000].map((length) => ["x".repeat(length)]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Exact");
  const exact = await text(new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })));
  assert.equal(exact.text.length, 100_000); assert.equal(exact.truncated, false);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["later"]]), "Later");
  const more = await text(new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })));
  assert.equal(more.text.length, 100_000); assert.equal(more.truncated, true);
  assert.doesNotMatch(more.text, /later/);
});

test("modern document truncation counts code points without splitting Unicode", async () => {
  const bytes = changed("score.docx", (parts) => {
    parts["word/document.xml"] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
      "🎵".repeat(100_001) + "</w:t></w:r></w:p></w:body></w:document>");
  });
  const result = await text(bytes);
  assert.equal([...result.text].length, 100_000); assert.equal(result.truncated, true);
  assert.equal(result.text.endsWith("🎵"), true);
});

test("legacy Office ingestion stops without advertising unsupported formats", async () => {
  assert.equal(ATTACHMENT_FORMATS.some((format) => format.extensions.some((ext: string) => ["doc", "xls", "ppt"].includes(ext))), false);
  const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  await assert.rejects(text(bytes, "old.doc"), (error: unknown) => error instanceof AttachmentProcessingError && error.code === "unsupported_type");
});

test("bundled parser runs under a restricted parent VM without runtime node_modules", async (t) => {
  const directory = mkdtempSync("/private/tmp/live-smith-parser-package-");
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const script = await buildDocumentParserScript(true);
  const parent = await esbuild.build({ entryPoints: ["src/attachments/office-parser.ts"], bundle: true,
    format: "cjs", platform: "node", write: false, logLevel: "silent",
    define: { __LIVE_SMITH_DOCUMENT_PARSER_SCRIPT__: JSON.stringify(script) } });
  const bundlePath = join(directory, "parser-parent.cjs"); writeFileSync(bundlePath, parent.outputFiles[0]!.text);
  const code = 'const {readFileSync}=require("node:fs");const {runInNewContext}=require("node:vm");' +
    'const m={exports:{}};runInNewContext(readFileSync(process.argv[1],"utf8"),{module:m,exports:m.exports,require}, {timeout:5000});' +
    'm.exports.extractOfficeDocumentText({bytes:readFileSync(process.argv[2]),fileType:"docx"}).then(r=>console.log(JSON.stringify(r)));';
  const output = execFileSync(process.execPath, ["-e", code, bundlePath,
    new URL("./fixtures/score.docx", import.meta.url).pathname], { cwd: directory, env: {}, timeout: 15_000, encoding: "utf8" });
  const result = JSON.parse(output) as { text: string; truncated: boolean };
  assert.match(result.text, /音乐 reference 🎵/); assert.equal(result.truncated, false);
});
