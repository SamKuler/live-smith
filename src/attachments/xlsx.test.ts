import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { URL } from "node:url";
import { TextEncoder } from "node:util";
import test from "node:test";

import { AttachmentProcessingError } from "./contracts.js";
import { type OoxmlPackage } from "./ooxml.js";
import { extractXlsxText } from "./xlsx.js";

const encoder = new TextEncoder();
const spreadsheetNamespace =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const officeRelationshipsNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const worksheetRelationshipType =
  `${officeRelationshipsNamespace}/worksheet`;
const sharedStringsRelationshipType =
  `${officeRelationshipsNamespace}/sharedStrings`;

interface WorkbookFixture {
  kind?: OoxmlPackage["kind"];
  workbook?: string;
  relationships?: string;
  entries?: Record<string, string>;
}

function xlsxPackage(fixture: WorkbookFixture = {}): OoxmlPackage {
  const workbook = fixture.workbook ??
    `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
      `<sheets><sheet name="Main" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`;
  const relationships = fixture.relationships ?? relationshipsXml([
    relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
  ]);
  const entries = new Map<string, Uint8Array>([
    ["xl/workbook.xml", encoder.encode(workbook)],
    ["xl/_rels/workbook.xml.rels", encoder.encode(relationships)],
    [
      "xl/worksheets/sheet1.xml",
      encoder.encode(worksheetXml(`<row r="1"><c r="A1" t="str"><v>Hello</v></c></row>`)),
    ],
  ]);
  for (const [name, xml] of Object.entries(fixture.entries ?? {})) {
    entries.set(name, encoder.encode(xml));
  }
  return { kind: fixture.kind ?? "xlsx", entries };
}

function relationshipsXml(relationships: readonly string[]): string {
  return `<Relationships xmlns="${packageRelationshipsNamespace}">${relationships.join("")}</Relationships>`;
}

function relationshipXml(
  id: string,
  type: string,
  target: string,
  targetMode?: string,
): string {
  const mode = targetMode === undefined ? "" : ` TargetMode="${targetMode}"`;
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode}/>`;
}

function worksheetXml(sheetData: string, prefix = ""): string {
  return `<worksheet xmlns="${spreadsheetNamespace}">${prefix}<sheetData>${sheetData}</sheetData></worksheet>`;
}

function processingError(
  code: AttachmentProcessingError["code"],
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AttachmentProcessingError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

test("xlsx follows workbook declaration order and custom relationship targets", async () => {
  const workbook =
    `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
      `<sheets>` +
      `<sheet name="First &quot;named&quot;" sheetId="2" r:id="rSecond"/>` +
      `<sheet name="Second" sheetId="1" r:id="rFirst"/>` +
      `</sheets></workbook>`;
  const relationships = relationshipsXml([
    relationshipXml("rFirst", worksheetRelationshipType, "worksheets/a.xml"),
    relationshipXml("rSecond", worksheetRelationshipType, "custom/z.xml", "Internal"),
  ]);
  const result = await extractXlsxText({
    officePackage: xlsxPackage({
      workbook,
      relationships,
      entries: {
        "xl/custom/z.xml": worksheetXml(
          `<row r="3"><c r="A3" t="str"><v>first</v></c></row>`,
        ),
        "xl/worksheets/a.xml": worksheetXml(
          `<row r="1"><c r="A1" t="str"><v>second</v></c></row>`,
        ),
      },
    }),
  });

  assert.equal(result.truncated, false);
  assert.ok(result.text.indexOf(`Sheet "First \\"named\\""`) < result.text.indexOf(`Sheet "Second"`));
  assert.match(result.text, /Row 3: A3="first"/);
  assert.match(result.text, /Row 1: A1="second"/);
});

test("xlsx rejects non-xlsx packages and malformed workbook part roots", async () => {
  await assert.rejects(
    extractXlsxText({ officePackage: xlsxPackage({ kind: "docx" }) }),
    processingError("invalid_document"),
  );
  for (const workbook of [
    `<root xmlns="${spreadsheetNamespace}"/>`,
    `<workbook/>`,
    `<workbook xmlns="wrong"/>`,
    `<workbook xmlns="${spreadsheetNamespace}"/><workbook xmlns="${spreadsheetNamespace}"/>`,
  ]) {
    await assert.rejects(
      extractXlsxText({ officePackage: xlsxPackage({ workbook }) }),
      processingError("invalid_document"),
    );
  }
});

test("xlsx accepts coherent Strict namespaces and rejects inner namespace rebinding", async () => {
  const strictSpreadsheet = "http://purl.oclc.org/ooxml/spreadsheetml/main";
  const strictOffice =
    "http://purl.oclc.org/ooxml/officeDocument/relationships";
  const strictPackage =
    "http://purl.oclc.org/ooxml/package/relationships";
  const strict = await extractXlsxText({
    officePackage: xlsxPackage({
      workbook:
        `<workbook xmlns="${strictSpreadsheet}" xmlns:r="${strictOffice}">` +
        `<sheets><sheet name="Strict" sheetId="1" r:id="strict"/></sheets>` +
        `</workbook>`,
      relationships:
        `<Relationships xmlns="${strictPackage}">` +
        relationshipXml("strict", `${strictOffice}/worksheet`, "strict/sheet.xml") +
        `</Relationships>`,
      entries: {
        "xl/strict/sheet.xml":
          `<worksheet xmlns="${strictSpreadsheet}"><sheetData>` +
          `<row r="1"><c r="A1" t="str"><v>strict value</v></c></row>` +
          `</sheetData></worksheet>`,
      },
    }),
  });
  assert.match(strict.text, /Sheet "Strict"\nRow 1: A1="strict value"/);

  const rebindingCases: WorkbookFixture[] = [
    {
      workbook:
        `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
        `<sheets xmlns="urn:wrong"><sheet name="Main" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`,
    },
    {
      relationships:
        `<Relationships xmlns="${packageRelationshipsNamespace}">` +
        `<Relationship xmlns="urn:wrong" Id="rId1" Type="${worksheetRelationshipType}" ` +
        `Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      entries: {
        "xl/worksheets/sheet1.xml":
          `<worksheet xmlns="${spreadsheetNamespace}">` +
          `<sheetData xmlns="urn:wrong"><row r="1"/></sheetData></worksheet>`,
      },
    },
  ];
  for (const fixture of rebindingCases) {
    await assert.rejects(
      extractXlsxText({ officePackage: xlsxPackage(fixture) }),
      processingError("invalid_document"),
    );
  }
});

test("xlsx rejects duplicate relationship ids and targets plus duplicate sheet ids and names", async () => {
  const validSheet = `<sheet name="One" sheetId="1" r:id="rId1"/>`;
  for (const sheets of [
    `${validSheet}<sheet name="Two" sheetId="1" r:id="rId2"/>`,
    `${validSheet}<sheet name="One" sheetId="2" r:id="rId2"/>`,
  ]) {
    await assert.rejects(
      extractXlsxText({
        officePackage: xlsxPackage({
          workbook:
            `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
            `<sheets>${sheets}</sheets></workbook>`,
        }),
      }),
      processingError("invalid_document"),
    );
  }

  for (const relationships of [
    relationshipsXml([
      relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
      relationshipXml("rId1", "other", "unused.xml"),
    ]),
    relationshipsXml([
      relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
      relationshipXml("other", "other", "worksheets/sheet1.xml"),
    ]),
  ]) {
    await assert.rejects(
      extractXlsxText({ officePackage: xlsxPackage({ relationships }) }),
      processingError("invalid_document"),
    );
  }
});

test("xlsx accepts only internal safe worksheet targets and ignores ordinary external hyperlinks", async () => {
  for (const target of [
    "../sheet.xml",
    "./sheet.xml",
    "/sheet.xml",
    "worksheets\\sheet.xml",
    "worksheets//sheet.xml",
    "worksheets/sheet.xml?x=1",
    "worksheets/sheet.xml#x",
    "https:sheet.xml",
  ]) {
    await assert.rejects(
      extractXlsxText({
        officePackage: xlsxPackage({
          relationships: relationshipsXml([
            relationshipXml("rId1", worksheetRelationshipType, target),
          ]),
        }),
      }),
      processingError("invalid_document"),
    );
  }
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage({
        relationships: relationshipsXml([
          relationshipXml(
            "rId1",
            worksheetRelationshipType,
            "https://example.test/sheet.xml",
            "External",
          ),
        ]),
      }),
    }),
    processingError("invalid_document"),
  );

  const result = await extractXlsxText({
    officePackage: xlsxPackage({
      relationships: relationshipsXml([
        relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
        relationshipXml(
          "link",
          `${officeRelationshipsNamespace}/hyperlink`,
          "https://example.test/?a=b#fragment",
          "External",
        ),
      ]),
    }),
  });
  assert.match(result.text, /Hello/);
});

test("xlsx reads shared and inline rich text in run order without phonetic text", async () => {
  const relationships = relationshipsXml([
    relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
    relationshipXml("strings", sharedStringsRelationshipType, "strings/custom.xml"),
  ]);
  const sheet = worksheetXml(
    `<row r="1">` +
      `<c r="A1" t="s"><v>0</v></c>` +
      `<c r="B1" t="inlineStr"><is><r><t>In</t></r><rPh><t>NO</t></rPh><r><t>line</t></r></is></c>` +
      `</row>`,
  );
  const shared =
    `<sst xmlns="${spreadsheetNamespace}">` +
      `<si><r><t>Rich</t></r><rPh><t>PHONETIC</t></rPh><r><t> text</t></r></si>` +
      `</sst>`;
  const result = await extractXlsxText({
    officePackage: xlsxPackage({
      relationships,
      entries: {
        "xl/worksheets/sheet1.xml": sheet,
        "xl/strings/custom.xml": shared,
      },
    }),
  });

  assert.match(result.text, /A1="Rich text"/);
  assert.match(result.text, /B1="Inline"/);
  assert.doesNotMatch(result.text, /PHONETIC|NO/);
});

test("xlsx renders inline, raw, boolean, error, and string cells without evaluating formulas", async () => {
  const sheet = worksheetXml(
    `<row r="1">` +
      `<c r="A1" t="inlineStr"><is><t>inline</t></is></c>` +
      `<c r="B1"><v>0001.2500</v></c>` +
      `<c r="C1" t="b"><v>1</v></c>` +
      `<c r="D1" t="e"><v>#DIV/0!</v></c>` +
      `<c r="E1" t="str"><v>cached string</v></c>` +
      `<c r="F1"><f>=1+2</f><v>3</v></c>` +
      `</row>`,
  );
  const result = await extractXlsxText({
    officePackage: xlsxPackage({ entries: { "xl/worksheets/sheet1.xml": sheet } }),
  });

  assert.match(result.text, /A1="inline"/);
  assert.match(result.text, /B1="0001\.2500"/);
  assert.match(result.text, /C1=true/);
  assert.match(result.text, /D1="#DIV\/0!"/);
  assert.match(result.text, /E1="cached string"/);
  assert.match(
    result.text,
    /F1=Formula \{"formula":"=1\+2","cached":"3"\}/,
  );
  for (const line of result.text.split("\n")) assert.equal(line.startsWith("="), false);
});

test("xlsx skips hidden sheets, rows, and columns while emitting omission markers", async () => {
  const workbook =
    `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
      `<sheets>` +
      `<sheet name="Visible" sheetId="1" r:id="visible"/>` +
      `<sheet name="Hidden" sheetId="2" r:id="hidden" state="hidden"/>` +
      `<sheet name="Very Hidden" sheetId="3" r:id="veryHidden" state="veryHidden"/>` +
      `</sheets></workbook>`;
  const relationships = relationshipsXml([
    relationshipXml("visible", worksheetRelationshipType, "worksheets/visible.xml"),
    relationshipXml("hidden", worksheetRelationshipType, "worksheets/hidden.xml"),
    relationshipXml("veryHidden", worksheetRelationshipType, "worksheets/very-hidden.xml"),
  ]);
  const visible = worksheetXml(
    `<row r="1"><c r="A1" t="str"><v>shown</v></c><c r="B1" t="str"><v>column secret</v></c></row>` +
      `<row r="2" hidden="1"><c r="A2" t="str"><v>row secret</v></c></row>`,
    `<cols><col min="2" max="2" hidden="1"/></cols>`,
  );
  const result = await extractXlsxText({
    officePackage: xlsxPackage({
      workbook,
      relationships,
      entries: {
        "xl/worksheets/visible.xml": visible,
        "xl/worksheets/hidden.xml": worksheetXml(
          `<row r="1"><c r="A1" t="str"><v>sheet secret</v></c></row>`,
        ),
        "xl/worksheets/very-hidden.xml": worksheetXml(""),
      },
    }),
  });

  assert.match(result.text, /Sheet "Hidden"\n\[hidden sheet omitted\]/);
  assert.match(result.text, /Sheet "Very Hidden"\n\[hidden sheet omitted\]/);
  assert.match(result.text, /\[hidden columns omitted\]/);
  assert.match(result.text, /Row 2: \[hidden row omitted\]/);
  assert.match(result.text, /shown/);
  assert.doesNotMatch(result.text, /column secret|row secret|sheet secret/);
});

test("xlsx accepts exact A1 coordinate bounds and rejects over-limit, lowercase, and duplicate refs", async () => {
  const exact = await extractXlsxText({
    officePackage: xlsxPackage({
      entries: {
        "xl/worksheets/sheet1.xml": worksheetXml(
          `<row r="1"><c r="A1"><v>1</v></c></row>` +
            `<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>`,
        ),
      },
    }),
  });
  assert.match(exact.text, /XFD1048576="2"/);

  for (const cell of [
    `<row r="1"><c r="XFE1"><v>1</v></c></row>`,
    `<row r="1048576"><c r="A1048577"><v>1</v></c></row>`,
    `<row r="1"><c r="a1"><v>1</v></c></row>`,
    `<row r="1"><c r="A01"><v>1</v></c></row>`,
    `<row r="1"><c r="A1"/><c r="A1"/></row>`,
  ]) {
    await assert.rejects(
      extractXlsxText({
        officePackage: xlsxPackage({
          entries: { "xl/worksheets/sheet1.xml": worksheetXml(cell) },
        }),
      }),
      processingError("invalid_document"),
    );
  }
});

test("xlsx rejects a near-limit cell reference before regex or column iteration and preserves cancellation", async () => {
  const extractorSource = readFileSync(
    new URL("./xlsx.ts", import.meta.url),
    "utf8",
  );
  const lengthGuard = extractorSource.indexOf(
    "reference.length > MAX_CELL_REFERENCE_LENGTH",
  );
  const coordinateRegex = extractorSource.indexOf(
    "/^([A-Z]+)([1-9][0-9]*)$/",
  );
  assert.ok(lengthGuard >= 0 && lengthGuard < coordinateRegex);

  const oversizedReference = `${"A".repeat(8_000_000)}1`;
  const oversizedPackage = xlsxPackage({
    entries: {
      "xl/worksheets/sheet1.xml": worksheetXml(
        `<row r="1"><c r="${oversizedReference}"><v>1</v></c></row>`,
      ),
    },
  });
  await assert.rejects(
    extractXlsxText({ officePackage: oversizedPackage }),
    processingError("invalid_document"),
  );

  const controller = new AbortController();
  const pending = extractXlsxText({
    officePackage: oversizedPackage,
    signal: controller.signal,
  });
  await yieldImmediate();
  controller.abort(new Error("cancelled before oversized cell traversal"));
  await assert.rejects(pending, /cancelled before oversized cell traversal/);
});

test("xlsx represents sparse row and column gaps with fixed markers", async () => {
  const sheet = worksheetXml(
    `<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>` +
      `<row r="1048576"><c r="XFD1048576"><v>3</v></c></row>`,
  );
  const result = await extractXlsxText({
    officePackage: xlsxPackage({ entries: { "xl/worksheets/sheet1.xml": sheet } }),
  });
  assert.equal(result.text.match(/\[sparse columns omitted\]/g)?.length, 1);
  assert.equal(result.text.match(/\[sparse rows omitted\]/g)?.length, 1);
  assert.ok(result.text.length < 500);
});

test("xlsx enforces sheet, row, cell, and shared-string caps", async () => {
  const sheets = Array.from(
    { length: 65 },
    (_, index) => `<sheet name="S${index}" sheetId="${index + 1}" r:id="r${index}"/>`,
  ).join("");
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage({
        workbook:
          `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipsNamespace}">` +
          `<sheets>${sheets}</sheets></workbook>`,
      }),
    }),
    processingError("archive_limit"),
  );

  const rows = Array.from(
    { length: 10_001 },
    (_, index) => `<row r="${index + 1}"/>`,
  ).join("");
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage({
        entries: { "xl/worksheets/sheet1.xml": worksheetXml(rows) },
      }),
    }),
    processingError("archive_limit"),
  );

  const cells = Array.from(
    { length: 50_001 },
    (_, index) => `<c r="A${index + 1}"/>`,
  ).join("");
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage({
        entries: {
          "xl/worksheets/sheet1.xml": worksheetXml(`<row r="1">${cells}</row>`),
        },
      }),
    }),
    processingError("archive_limit"),
  );

  const relationships = relationshipsXml([
    relationshipXml("rId1", worksheetRelationshipType, "worksheets/sheet1.xml"),
    relationshipXml("strings", sharedStringsRelationshipType, "sharedStrings.xml"),
  ]);
  const shared = `<sst xmlns="${spreadsheetNamespace}">${"<si/>".repeat(100_001)}</sst>`;
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage({
        relationships,
        entries: { "xl/sharedStrings.xml": shared },
      }),
    }),
    processingError("archive_limit"),
  );
});

test("xlsx shares the exact 100,000-code-point text budget without splitting Unicode", async () => {
  const prefix = `Sheet "Main"\nRow 1: A1="`;
  const suffix = `"\n`;
  const exactValue = "🎵".repeat(100_000 - prefix.length - suffix.length);
  const exact = await extractXlsxText({
    officePackage: xlsxPackage({
      entries: {
        "xl/worksheets/sheet1.xml": worksheetXml(
          `<row r="1"><c r="A1" t="str"><v>${exactValue}</v></c></row>`,
        ),
      },
    }),
  });
  assert.equal([...exact.text].length, 100_000);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text.endsWith(suffix), true);

  const over = await extractXlsxText({
    officePackage: xlsxPackage({
      entries: {
        "xl/worksheets/sheet1.xml": worksheetXml(
          `<row r="1"><c r="A1" t="str"><v>${exactValue}🎵</v></c></row>`,
        ),
      },
    }),
  });
  assert.equal([...over.text].length, 100_000);
  assert.equal(over.truncated, true);
  assert.equal(/\ud800$/.test(over.text), false);
});

test("xlsx honors pre-cancellation and cancellation during traversal", async () => {
  const preCancelled = new AbortController();
  preCancelled.abort(new Error("cancelled before XLSX extraction"));
  await assert.rejects(
    extractXlsxText({
      officePackage: xlsxPackage(),
      signal: preCancelled.signal,
    }),
    /cancelled before XLSX extraction/,
  );

  const rows = Array.from(
    { length: 10_000 },
    (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"/></row>`,
  ).join("");
  const during = new AbortController();
  const pending = extractXlsxText({
    officePackage: xlsxPackage({
      entries: { "xl/worksheets/sheet1.xml": worksheetXml(rows) },
    }),
    signal: during.signal,
  });
  await yieldImmediate();
  during.abort(new Error("cancelled during XLSX extraction"));
  await assert.rejects(pending, /cancelled during XLSX extraction/);
});
