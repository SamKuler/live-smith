import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate/browser";
import XLSX from "xlsx";

import { processAttachment } from "../../src/attachments/processor.js";
import { odfBytes } from "./support/rich-document-test-helpers.js";

const styleNamespaces = 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"';

function styled(kind: "spreadsheet" | "presentation", body: string, styles: string, location: "content" | "styles"): Uint8Array {
  const parts = unzipSync(odfBytes(kind, body));
  if (location === "content") {
    parts["content.xml"] = strToU8(strFromU8(parts["content.xml"]!).replace("<office:body>",
      `<office:automatic-styles ${styleNamespaces}>${styles}</office:automatic-styles><office:body>`));
  } else {
    parts["styles.xml"] = strToU8('<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
      'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
      `${styleNamespaces}><office:styles>${styles}</office:styles></office:document-styles>`);
  }
  return zipSync(parts, { level: 0 });
}

async function text(bytes: Uint8Array): Promise<string> {
  const result = await processAttachment({ bytes, fileName: "context.bin", nativePdfAllowed: false });
  assert.equal(result.type, "text");
  if (result.type !== "text") throw new Error("Expected document text.");
  assert.equal(result.truncated, false);
  return result.text;
}

test("ODS formula caches distinguish XML indentation from stored values and semantic text", async () => {
  const cells = [
    '<table:table-cell office:value-type="float" table:formula="of:=1+1">\n  <text:p/>\n</table:table-cell>',
    '<table:table-cell office:value-type="boolean" table:formula="of:=1=1">\n  <text:p>TRUE</text:p>\n</table:table-cell>',
    '<table:table-cell office:value-type="float" office:value="0" table:formula="of:=1-1">\n  <text:p>0</text:p>\n</table:table-cell>',
    '<table:table-cell office:value-type="boolean" office:boolean-value="false" table:formula="of:=1=2">\n  <text:p>FALSE</text:p>\n</table:table-cell>',
    '<table:table-cell office:value-type="string" office:string-value="" table:formula="of:=&quot;&quot;">\n  <text:p/>\n</table:table-cell>',
    '<table:table-cell office:value-type="string" table:formula="of:=&quot;cached&quot;">\n  <text:p>cached</text:p>\n</table:table-cell>',
    '<table:table-cell office:value-type="string" table:formula="of:=&quot; &quot;"><text:p><text:s/></text:p></table:table-cell>',
    '<table:table-cell office:value-type="string" table:formula="of:=&quot;text&quot;"><text:p>a<text:s text:c="2"/>b<text:tab/>c<text:line-break/>d</text:p></table:table-cell>',
    '<table:table-cell office:value-type="string" table:formula="of:=&quot;missing&quot;">\n  \n</table:table-cell>',
  ];
  const result = await text(odfBytes("spreadsheet", '<table:table table:name="Caches"><table:table-row>' + cells.join("") + '</table:table-row></table:table>'));
  assert.match(result, /A1="\[cached value unavailable\]"/);
  assert.match(result, /B1="\[cached value unavailable\]"/);
  assert.match(result, /C1="0"/);
  assert.match(result, /D1="false"/);
  assert.match(result, /E1=""/);
  assert.match(result, /F1="cached"/);
  assert.match(result, /G1=" "/);
  assert.ok(result.includes(`H1=${JSON.stringify("a  b\tc\nd")}`));
  assert.match(result, /I1="\[cached value unavailable\]"/);
  assert.doesNotMatch(result, /NaN|undefined/);
});

test("ODS empty string formula caches exported by SheetJS remain available", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, {
    A1: { t: "s", v: "", f: 'IF(1,"","x")' },
    B1: { t: "s", v: "cached", f: '"cached"' },
    "!ref": "A1:B1",
  }, "Caches");
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "ods" }));
  const result = await text(bytes);
  assert.ok(result.includes(`A1="" [formula ${JSON.stringify('IF(1,"","x")')}]`));
  assert.match(result, /B1="cached"/);
  assert.doesNotMatch(result, /cached value unavailable/);
});

test("ODS resolves sheet visibility from referenced styles and inherited properties", async () => {
  const styles = '<style:style style:name="Hidden" style:family="table"><style:table-properties table:display="false"/></style:style>' +
    '<style:style style:name="Inherited" style:family="table" style:parent-style-name="Hidden"/>' +
    '<style:style style:name="Visible" style:family="table" style:parent-style-name="Hidden"><style:table-properties table:display="true"/></style:style>';
  const body = '<table:table table:name="Private" table:style-name="Inherited"><table:table-row><table:table-cell><text:p>HIDDEN_STYLE_VALUE</text:p></table:table-cell></table:table-row></table:table>' +
    '<table:table table:name="Public" table:style-name="Visible"><table:table-row><table:table-cell><text:p>Visible value</text:p></table:table-cell></table:table-row></table:table>';
  for (const location of ["content", "styles"] as const) {
    const result = await text(styled("spreadsheet", body, styles, location));
    assert.match(result, /\[Hidden sheet "Private" omitted\]/);
    assert.doesNotMatch(result, /HIDDEN_STYLE_VALUE/);
    assert.match(result, /Sheet "Public"\nRow 1: A1="Visible value"/);
  }
});

test("ODP resolves page visibility from styles while retaining visible slide numbers and notes", async () => {
  const styles = '<style:style style:name="Hidden" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>' +
    '<style:style style:name="Inherited" style:family="drawing-page" style:parent-style-name="Hidden"/>' +
    '<style:style style:name="Visible" style:family="drawing-page" style:parent-style-name="Hidden"><style:drawing-page-properties presentation:visibility="visible"/></style:style>';
  const body = '<draw:page draw:name="Private" draw:style-name="Inherited"><draw:frame><draw:text-box><text:p>HIDDEN_PAGE_VALUE</text:p></draw:text-box></draw:frame>' +
    '<presentation:notes><draw:frame><draw:text-box><text:p>HIDDEN_PAGE_NOTES</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>' +
    '<draw:page draw:name="Public" draw:style-name="Visible"><draw:frame><draw:text-box><text:p>Visible page</text:p></draw:text-box></draw:frame>' +
    '<presentation:notes><draw:frame><draw:text-box><text:p>Visible notes</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>';
  for (const location of ["content", "styles"] as const) {
    const result = await text(styled("presentation", body, styles, location));
    assert.match(result, /Slide 2\nVisible page\nNotes\nVisible notes/);
    assert.match(result, /\[Hidden slides omitted\]/);
    assert.doesNotMatch(result, /HIDDEN_PAGE_VALUE|HIDDEN_PAGE_NOTES|Slide 1/);
  }
});

test("ODS date styles retain value types and the declared calculation epoch", async () => {
  const styles = '<number:date-style style:name="DateFormat"><number:year number:style="long"/><number:text>-</number:text>' +
    '<number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>' +
    '<style:style style:name="DateCell" style:family="table-cell" style:data-style-name="DateFormat"/>';
  for (const location of ["content", "styles"] as const) {
    for (const epoch of [undefined, "1904-01-01"]) {
      const body = (epoch ? `<table:calculation-settings><table:null-date table:date-value="${epoch}"/></table:calculation-settings>` : "") +
        '<table:table table:name="Dates"><table:table-row>' +
        '<table:table-cell office:value-type="float" office:value="1" table:style-name="DateCell"><text:p>Date</text:p></table:table-cell>' +
        '<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table>';
      const result = await text(styled("spreadsheet", body, styles, location));
      assert.ok(result.includes(`A1="${epoch ? "1904-01-02" : "1900-01-01"}T00:00:00.000Z"`));
      assert.match(result, /B1="1"/);
    }
  }
});
