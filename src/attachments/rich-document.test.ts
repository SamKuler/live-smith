import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";
import { zipSync, strToU8 } from "fflate/browser";

import { processingError, mutateEntry, writeU16 } from "./ooxml-test-helpers.js";
import { odfBytes, rtfBytes } from "./rich-document-test-helpers.js";
import { classifyRichDocumentAttachment, extractRichDocumentText, type RichDocumentMediaType } from "./rich-document.js";

function extract(bytes: Uint8Array, mediaType: RichDocumentMediaType) {
  return extractRichDocumentText({ bytes, fileName: "renamed.bin", mediaType });
}

test("rich documents are classified from content instead of filename", async () => {
  for (const kind of ["text", "spreadsheet", "presentation"] as const) {
    const bytes = odfBytes(kind, "");
    assert.equal(await classifyRichDocumentAttachment({ bytes, fileName: "fake.txt" }), `application/vnd.oasis.opendocument.${kind}`);
  }
  assert.equal(await classifyRichDocumentAttachment({ bytes: rtfBytes("{\\rtf1 Hello}"), fileName: "file.doc" }), "application/rtf");
  assert.equal(await classifyRichDocumentAttachment({ bytes: Buffer.from("plain text"), fileName: "file.rtf" }), undefined);
  assert.equal(await classifyRichDocumentAttachment({ bytes: zipSync({ "file.txt": strToU8("hi") }), fileName: "file.odt" }), undefined);
});

test("RTF preserves Unicode, code pages, lines and tables while omitting object and metadata data", async () => {
  const bytes = rtfBytes("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Hidden font;}}" +
    "Hello \\'e9\\par\\u20013?\\u25991? \\u-10180?\\u-8278?\\par" +
    "{\\object{\\objdata SECRET}}{\\*\\unknown SECRET}{\\pict 010203}" +
    "{\\field{\\*\\fldinst HYPERLINK SECRET}{\\fldrslt link}}" +
    "\\v secret\\v0 visible\\cell 2\\row}");
  const result = await extract(bytes, "application/rtf");
  assert.equal(result.text, "Hello é\n中文 🎪\nlinkvisible\t2\n");
  assert.equal(result.truncated, false);
  assert.doesNotMatch(result.text, /SECRET|font|secret|010203/);
  assert.equal((await extract(rtfBytes("{\\rtf1\\ansicpg936 \\'d6\\'d0\\'ce\\'c4}"), "application/rtf")).text, "中文");
  assert.equal((await extract(rtfBytes("{\\rtf1{\\upr{ansi}{\\*\\ud\\u20013?}}}"), "application/rtf")).text, "中");
});

test("RTF binary runs do not affect nesting or expose their bytes", async () => {
  const result = await extract(rtfBytes("{\\rtf1 start{\\object\\bin4 {\\}\u0000}end}"), "application/rtf");
  assert.equal(result.text, "startend");
  for (const value of ["{\\rtf1", "{\\rtf1 hi}trailing", "{\\rtf1\\bin99 x}", "{\\rtf1\\'zz}", "{\\rtf1\\u-10179?}", "{\\rtf1\\ansicpg42 text}"]) {
    await assert.rejects(extract(rtfBytes(value), "application/rtf"), processingError("invalid_document"));
  }
});

test("RTF resolves selected and default font charsets for raw and escaped ANSI text", async () => {
  const header = "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset204 Arial;}}";
  const raw = Buffer.concat([rtfBytes(`${header}\\f0 `), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), rtfBytes("}")]);
  assert.equal((await extract(raw, "application/rtf")).text, "Привет");
  const escaped = rtfBytes(`${header}\\'cf\\'f0\\'e8\\'e2\\'e5\\'f2}`);
  assert.equal((await extract(escaped, "application/rtf")).text, "Привет");
});

test("RTF switches font charsets and explicit code pages while keeping Unicode fallback intact", async () => {
  const bytes = rtfBytes("{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl" +
    "{\\f0\\fcharset204 Cyrillic;} {\\f1\\fcharset134 Chinese;}" +
    "{\\f2\\fcharset0 Latin;} {\\f3\\fcharset204\\cpg65001 UTF8;}}" +
    "\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par" +
    "\\f1 \\'d6\\'d0\\'ce\\'c4 \\u-10180?\\u-8278?\\par" +
    "\\f2 \\'e9\\par\\f3 \\'e4\\'b8\\'ad}");
  assert.equal((await extract(bytes, "application/rtf")).text, "Привет\n中文 🎪\né\n中");
});

test("RTF restores current fonts across nested groups and plain resets to the default font", async () => {
  const bytes = rtfBytes("{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl" +
    "{\\f0\\fcharset204 Cyrillic;} {\\f1\\fcharset134 Chinese;} {\\f2\\fcharset0 Latin;}}" +
    "\\f0 \\'cf{\\f1 \\'d6\\'d0{\\f2 \\'e9}\\'ce\\'c4}\\'f0" +
    "{\\f2 \\'e9\\plain \\'e8}\\'e2}");
  assert.equal((await extract(bytes, "application/rtf")).text, "П中é文рéив");
});

test("RTF font metadata in omitted destinations cannot alter visible font encodings", async () => {
  const bytes = rtfBytes("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl" +
    "{\\f0\\fcharset204 Arial{\\*\\falt\\cpg936 hidden font;};}}" +
    "{\\object{\\fonttbl{\\f0\\fcharset134 object font;}}}" +
    "\\f0 \\'cf\\'f0}");
  const result = await extract(bytes, "application/rtf");
  assert.equal(result.text, "Пр");
  assert.doesNotMatch(result.text, /font|Arial|hidden/);
});

test("RTF rejects unavailable selected-font encodings instead of silently using the header code page", async () => {
  for (const font of ["\\fcharset1", "\\fcharset2", "\\fcharset130", "\\fcharset255", "\\fcharset137", "\\cpg42"]) {
    const bytes = rtfBytes(`{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0${font} Unknown;}}\\f0 \\'cf}`);
    await assert.rejects(extract(bytes, "application/rtf"), processingError("invalid_document"));
  }
  await assert.rejects(extract(rtfBytes("{\\rtf1\\f99 text}"), "application/rtf"), processingError("invalid_document"));
  const unused = rtfBytes("{\\rtf1{\\fonttbl{\\f0\\fcharset2 Symbol;}}plain \\'e9}");
  assert.equal((await extract(unused, "application/rtf")).text, "plain é");
  const unicode = rtfBytes("{\\rtf1{\\fonttbl{\\f0\\fcharset2 Symbol;}}\\f0\\u20013?}");
  assert.equal((await extract(unicode, "application/rtf")).text, "中");
});

test("RTF font definitions stay bounded and flat entries do not inherit another font's charset", async () => {
  const flat = rtfBytes("{\\rtf1{\\fonttbl\\f0\\fcharset204 Cyrillic;\\f1 Latin;}\\f0\\'cf\\f1\\'e9}");
  assert.equal((await extract(flat, "application/rtf")).text, "Пé");
  const fonts = Array.from({ length: 4097 }, (_, index) => `{\\f${index}\\fcharset0 Font;}`).join("");
  await assert.rejects(extract(rtfBytes(`{\\rtf1{\\fonttbl${fonts}}\\f4096 text}`), "application/rtf"), processingError("archive_limit"));
});

test("ODT retains paragraph order, explicit spaces and Unicode with inert markup", async () => {
  const result = await extract(odfBytes("text",
    `<text:h>Title</text:h><text:p>音乐<text:s text:c="3"/>🎵<text:tab/>end<text:line-break/>next</text:p>` +
    `<office:annotation><text:p>secret</text:p></office:annotation><text:p>&lt;script&gt;</text:p>`), "application/vnd.oasis.opendocument.text");
  assert.equal(result.text, "Title\n音乐   🎵\tend\nnext\n<script>\n");
});

test("ODS preserves sheets, numbers, repeated cells and sparse coordinates without dense allocation", async () => {
  const result = await extract(odfBytes("spreadsheet",
    `<table:table table:name="First"><table:table-row>` +
    `<table:table-cell office:value-type="float" office:value="123456789.125"/>` +
    `<table:table-cell office:value-type="boolean" office:boolean-value="true"/>` +
    `<table:table-cell table:number-columns-repeated="2"><text:p>音乐</text:p></table:table-cell>` +
    `</table:table-row><table:table-row table:number-rows-repeated="100000"/>` +
    `<table:table-row><table:table-cell table:number-columns-repeated="16383"/>` +
    `<table:table-cell office:value-type="float" office:value="2" table:formula="of:=1+1"/></table:table-row></table:table>` +
    `<table:table table:name="Second"><table:table-row><table:table-cell office:value-type="date" office:date-value="2026-09-30"/></table:table-row></table:table>`), "application/vnd.oasis.opendocument.spreadsheet");
  assert.match(result.text, /Sheet "First"\nRow 1: A1="123456789\.125"\tB1="true"\tC1="音乐"\tD1="音乐"/);
  assert.match(result.text, /Row 100002: XFD100002="2" \[formula "of:=1\+1"\]/);
  assert.match(result.text, /Sheet "Second"\nRow 1: A1="2026-09-30"/);
  assert.ok(result.text.length < 500);
});

test("ODP preserves slide order and labels notes", async () => {
  const result = await extract(odfBytes("presentation",
    `<draw:page draw:name="Z"><draw:frame><text:p>first</text:p></draw:frame><presentation:notes><text:p>note</text:p></presentation:notes></draw:page>` +
    `<draw:page draw:name="A"><text:p>second</text:p></draw:page>`), "application/vnd.oasis.opendocument.presentation");
  assert.equal(result.text, 'Slide 1 "Z"\nfirst\nNotes\nnote\nSlide 2 "A"\nsecond\n');
});

test("ODF recognizes namespace aliases and rejects spoofed namespace content", async () => {
  const aliased = `<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><o:body><o:text><t:p>aliased</t:p></o:text></o:body></o:document-content>`;
  assert.equal((await extract(odfBytes("text", "", { "content.xml": aliased }), "application/vnd.oasis.opendocument.text")).text, "aliased\n");
  await assert.rejects(extract(odfBytes("text", "", { "content.xml": aliased.replaceAll("xmlns:office:1.0", "xmlns:spoof:1.0") }), "application/vnd.oasis.opendocument.text"), processingError("invalid_document"));
});

test("rich extraction rejects format mismatch, invalid XML, encrypted and active content", async () => {
  const mime: RichDocumentMediaType = "application/vnd.oasis.opendocument.text";
  await assert.rejects(extract(odfBytes("presentation", ""), mime), processingError("invalid_document"));
  await assert.rejects(extract(odfBytes("text", "", { "content.xml": "<!DOCTYPE x [<!ENTITY x 'a'>]><x>&x;</x>" }), mime), processingError("invalid_document"));
  await assert.rejects(extract(odfBytes("text", "", { "Basic/Standard/Module1.xml": "source" }), mime), processingError("macro_enabled"));
  const encrypted = `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>`;
  await assert.rejects(extract(odfBytes("text", "", { "META-INF/manifest.xml": encrypted, "content.xml": new Uint8Array([1, 2]) }), mime), processingError("encrypted_document"));
  const zipEncrypted = mutateEntry(odfBytes("text", ""), 0, (bytes, central, local) => { writeU16(bytes, central + 8, 1); writeU16(bytes, local + 6, 1); });
  await assert.rejects(extract(zipEncrypted, mime), processingError("encrypted_document"));
});

test("rich extraction bounds Unicode output, repeated spreadsheets and nested RTF", async () => {
  const over = await extract(odfBytes("text", `<text:p>${"🎵".repeat(100001)}</text:p>`), "application/vnd.oasis.opendocument.text");
  assert.equal([...over.text].length, 100000);
  assert.equal(over.truncated, true);
  const repeated = await extract(odfBytes("spreadsheet", `<table:table table:name="Main"><table:table-row table:number-rows-repeated="1048576"><table:table-cell><text:p>1</text:p></table:table-cell></table:table-row></table:table>`), "application/vnd.oasis.opendocument.spreadsheet");
  assert.equal(repeated.text.length, 100000);
  assert.equal(repeated.truncated, true);
  const rtfOver = await extract(rtfBytes(`{\\rtf1 ${"a".repeat(100001)}}`), "application/rtf");
  assert.equal(rtfOver.text.length, 100000);
  assert.equal(rtfOver.truncated, true);
  await assert.rejects(extract(rtfBytes(`{\\rtf1 ${"{".repeat(256)}text${"}".repeat(256)}}`), "application/rtf"), processingError("archive_limit"));
});

test("rich extraction honors cancellation before and during ZIP or RTF parsing", async () => {
  const before = new AbortController(); before.abort(new Error("cancel rich before"));
  await assert.rejects(extractRichDocumentText({ bytes: rtfBytes("{\\rtf1 hi}"), fileName: "x", mediaType: "application/rtf", signal: before.signal }), /cancel rich before/);
  for (const [bytes, mediaType] of [[rtfBytes(`{\\rtf1 ${"x".repeat(2_000_000)}}`), "application/rtf"], [odfBytes("text", `<text:p>${"x".repeat(2_000_000)}</text:p>`), "application/vnd.oasis.opendocument.text"]] as const) {
    const during = new AbortController();
    const pending = extractRichDocumentText({ bytes, fileName: "x", mediaType, signal: during.signal });
    await yieldImmediate(); during.abort(new Error("cancel rich during"));
    await assert.rejects(pending, /cancel rich during/);
  }
});
