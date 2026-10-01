import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import { unzipSync, strFromU8, strToU8, zipSync } from "fflate/browser";
import { AttachmentProcessingError } from "../../src/attachments/contracts.js";
import { processAttachment } from "../../src/attachments/processor.js";
import { odfBytes } from "./support/rich-document-test-helpers.js";

const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function changed(name: string, edit: (parts: Record<string, Uint8Array>) => void): Uint8Array {
  const parts = unzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  edit(parts); return zipSync(parts, { level: 0 });
}
async function text(bytes: Uint8Array): Promise<string> {
  const result = await processAttachment({ bytes, fileName: "reference.bin", nativePdfAllowed: false });
  assert.equal(result.type, "text");
  if (result.type !== "text") throw new Error("Expected spreadsheet text.");
  return result.text;
}
const invalid = (error: unknown) => error instanceof AttachmentProcessingError && error.code === "invalid_document";

test("XLSX foreign namespaces cannot create cells or override coordinates and values", async () => {
  const bytes = changed("arrangement.xlsx", (parts) => {
    parts["xl/worksheets/sheet1.xml"] = strToU8(`<worksheet xmlns="${spreadsheetNamespace}" xmlns:evil="urn:spoof">` +
      '<evil:sheetData><evil:row r="2"><evil:c r="A2" t="str"><evil:v>SPOOF_CELL_SECRET</evil:v></evil:c></evil:row></evil:sheetData>' +
      '<sheetData><row r="1"><c r="A1" evil:r="B1" t="str" evil:t="b"><v>Visible value</v></c></row></sheetData></worksheet>');
  });
  const result = await text(bytes);
  assert.match(result, /Row 1: A1="Visible value"/);
  assert.doesNotMatch(result, /SPOOF_CELL_SECRET|B1="false"/);
});

test("XLSX and PPTX reject foreign relationship identities", async () => {
  for (const [fixture, part, edit] of [
    ["arrangement.xlsx", "xl/workbook.xml", (xml: string) => xml.replaceAll("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "urn:spoof")],
    ["arrangement.xlsx", "xl/_rels/workbook.xml.rels", (xml: string) => xml.replaceAll("<Relationship ", '<Relationship xmlns="urn:spoof" ')],
    ["arrangement.pptx", "ppt/_rels/presentation.xml.rels", (xml: string) => xml.replaceAll("<Relationship ", '<Relationship xmlns="urn:spoof" ')],
  ] as const) {
    await assert.rejects(text(changed(fixture, (parts) => { parts[part] = strToU8(edit(strFromU8(parts[part]!))); })), invalid);
  }
});

test("duplicate sheet identities cannot replace a visible sheet with hidden data", async () => {
  await assert.rejects(text(changed("arrangement.xlsx", (parts) => {
    parts["xl/workbook.xml"] = strToU8(strFromU8(parts["xl/workbook.xml"]!).replace('name="节奏" sheetId="2" state="visible"', 'name="Harmony" sheetId="2" state="hidden"'));
  })), invalid);
  await assert.rejects(text(odfBytes("spreadsheet", '<table:table table:name="Same"/><table:table table:name="Same" table:display="false"/>')), invalid);
});

test("XLSX cache absence stays distinct from cached false, empty string and errors", async () => {
  const types = ["n", "b", "str", "e", "d", "s"];
  const bytes = changed("arrangement.xlsx", (parts) => {
    const missing = types.map((type, index) => `<c r="${String.fromCharCode(65 + index)}1" t="${type}"><f>IF(1,1,0)</f></c>`).join("");
    parts["xl/worksheets/sheet1.xml"] = strToU8(`<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row r="1">${missing}</row>` +
      '<row r="2"><c r="A2" t="b"><f>IF(1,0,1)</f><v>0</v></c><c r="B2" t="str"><f>""</f><v></v></c>' +
      '<c r="C2" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>');
  });
  const result = await text(bytes);
  for (const [index] of types.entries()) assert.ok(result.includes(`${String.fromCharCode(65 + index)}1="[cached value unavailable]"`));
  assert.match(result, /A2="false"/); assert.match(result, /B2=""/); assert.match(result, /C2="#DIV\/0!"/);
  assert.doesNotMatch(result, /=undefined/);
});

test("semantic part reuse cannot bypass a different relationship role", async () => {
  for (const [fixture, part, role, target] of [
    ["arrangement.xlsx", "xl/_rels/workbook.xml.rels", "styles", "worksheets/sheet1.xml"],
    ["score.docx", "word/_rels/document.xml.rels", "footnotes", "document.xml"],
  ] as const) {
    await assert.rejects(text(changed(fixture, (parts) => {
      parts[part] = strToU8(strFromU8(parts[part]!).replace("</Relationships>",
        `<Relationship Id="conflict" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${role}" Target="${target}"/></Relationships>`));
    })), invalid);
  }
});

test("ODS foreign namespaces cannot create sheets or override stored values", async () => {
  const bytes = odfBytes("spreadsheet", '<fake:table xmlns:fake="urn:spoof" fake:name="Spoof"><fake:table-row><fake:table-cell><text:p>SPOOF_CELL_SECRET</text:p></fake:table-cell></fake:table-row></fake:table>' +
    '<table:table table:name="Visible"><table:table-row><table:table-cell xmlns:fake="urn:spoof" office:value-type="float" office:value="1" fake:value="999"/></table:table-row></table:table>');
  const result = await text(bytes);
  assert.match(result, /Sheet "Visible"\nRow 1: A1="1"/); assert.doesNotMatch(result, /Spoof|SPOOF_CELL_SECRET|999/);
});

test("ODS error caches retain their namespace identity", async () => {
  const bytes = odfBytes("spreadsheet", '<table:table table:name="Errors"><table:table-row><table:table-cell ' +
    'xmlns:calc="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:value-type="string" office:string-value="" calc:value-type="error" table:formula="of:=1/0">' +
    '<text:p>#DIV/0!</text:p></table:table-cell></table:table-row></table:table>');
  assert.match(await text(bytes), /A1="#DIV\/0!" \[formula "1\/0"\]/);
});

test("ODS explicitly hidden repeated columns preserve visible cell coordinates", async () => {
  const bytes = odfBytes("spreadsheet", '<table:table table:name="Visibility">' +
    '<table:table-column table:visibility="collapse" table:number-columns-repeated="2"/><table:table-column/>' +
    '<table:table-row><table:table-cell table:number-columns-repeated="2"><text:p>HIDDEN_COLUMN</text:p></table:table-cell>' +
    '<table:table-cell><text:p>VISIBLE_COLUMN</text:p></table:table-cell></table:table-row></table:table>');
  const result = await text(bytes);
  assert.doesNotMatch(result, /HIDDEN_COLUMN/); assert.match(result, /C1="VISIBLE_COLUMN"/);
});

test("XLSX extra attributes cannot override the authoritative sheet relationship", async () => {
  const bytes = changed("arrangement.xlsx", (parts) => {
    parts["xl/workbook.xml"] = strToU8(strFromU8(parts["xl/workbook.xml"]!)
      .replace('r:id="rId1"', 'r:id="rId1" id="rId2"').replace('name="节奏" sheetId="2" state="visible"', 'name="节奏" sheetId="2" state="hidden"'));
  });
  const result = await text(bytes);
  assert.match(result, /Cmaj7/); assert.doesNotMatch(result, /Drums|Subdivision/);
});

test("ODS element and attribute ownership survive prefix-insensitive normalization", async () => {
  const bytes = odfBytes("spreadsheet", '<text:table table:name="Wrong"><text:table-row><text:table-cell office:value-type="string"><text:p>WRONG_QNAME_VALUE</text:p></text:table-cell></text:table-row></text:table>' +
    '<table:table table:name="Original" office:name="WrongName"><table:table-row><table:table-cell office:value-type="float" office:value="1" table:value="999"/></table:table-row></table:table>');
  const result = await text(bytes);
  assert.match(result, /Sheet "Original"\nRow 1: A1="1"/);
  assert.doesNotMatch(result, /Wrong|WRONG_QNAME_VALUE|999/);
});

test("ODS body ownership excludes tables stored in automatic style metadata", async () => {
  const bytes = odfBytes("spreadsheet", '<table:table table:name="Body"><table:table-row><table:table-cell><text:p>Body value</text:p></table:table-cell></table:table-row></table:table>');
  const parts = unzipSync(bytes);
  parts["content.xml"] = strToU8(strFromU8(parts["content.xml"]!).replace("<office:body>", '<office:automatic-styles><table:table table:name="Outside"><table:table-row><table:table-cell><text:p>OUTSIDE_BODY_VALUE</text:p></table:table-cell></table:table-row></table:table></office:automatic-styles><office:body>'));
  const result = await text(zipSync(parts, { level: 0 }));
  assert.match(result, /Sheet "Body"/); assert.doesNotMatch(result, /Outside|OUTSIDE_BODY_VALUE/);
});

test("spreadsheet scalar leaves cannot contain additional rows or tables", async () => {
  const workbook = changed("arrangement.xlsx", (parts) => {
    parts["xl/worksheets/sheet1.xml"] = strToU8(`<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row r="1"><c r="A1" t="str"><v>Body` +
      '<row r="2"><c r="A2" t="str"><v>NESTED_VALUE</v></c></row></v></c></row></sheetData></worksheet>');
  });
  const result = await text(workbook);
  assert.doesNotMatch(result.slice(0, result.indexOf('Sheet "节奏"')), /NESTED_VALUE|Row 2:/);
  assert.doesNotMatch(result, /NESTED_VALUE/);
  const document = odfBytes("spreadsheet", '<table:table table:name="Body"><table:table-row><table:table-cell><text:p>Body<text:s>' +
    '<table:table table:name="Nested"><table:table-row><table:table-cell><text:p>NESTED_VALUE</text:p></table:table-cell></table:table-row></table:table>' +
    '</text:s></text:p></table:table-cell></table:table-row></table:table>');
  assert.doesNotMatch(await text(document), /Nested|NESTED_VALUE/);
});

test("ODS inline semantic fields retain text without introducing spreadsheet structure", async () => {
  const bytes = odfBytes("spreadsheet", '<table:table table:name="Text"><table:table-row><table:table-cell><text:p>' +
    'Before<text:ruby><text:ruby-base>漢字</text:ruby-base><text:ruby-text>かんじ</text:ruby-text></text:ruby>After ' +
    '<text:date>2026-10-01</text:date><text:deletion>REMOVED_TEXT</text:deletion>' +
    '</text:p></table:table-cell></table:table-row></table:table>');
  const result = await text(bytes);
  assert.match(result, /Before漢字かんじAfter 2026-10-01/); assert.doesNotMatch(result, /REMOVED_TEXT/);
});
