import assert from "node:assert/strict";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";
import { extractLegacyExcelText } from "./legacy-xls.js";
import { biffBof, biffCell, biffRecord, dataView, joinBytes, multiSheetWorkbookBytes, unicodeBiffString, workbookBytes } from "./legacy-document-test-helpers.js";
import { processingError } from "./ooxml-test-helpers.js";

function extract(workbook: Uint8Array, signal?: AbortSignal) {
  return extractLegacyExcelText({ streams: new Map([["Workbook", workbook]]), entryNames: ["Workbook"] }, signal);
}
function label(column: number, text: string): Uint8Array { return biffCell(0x204, 0, column, unicodeBiffString(text)); }
function chart(...records: Uint8Array[]): Uint8Array { return joinBytes(biffBof(0x20), ...records, biffRecord(0x0a)); }

test("BIFF8 extracts worksheet cells before and after embedded chart substreams", async () => {
  const number = new Uint8Array(8); dataView(number).setFloat64(0, 999, true);
  const workbook = workbookBytes([
    label(0, "before"), chart(biffCell(0x203, 0, 0, number)), label(1, "between"),
    chart(label(0, "chart cache")), label(2, "after"),
  ]);
  const result = await extract(workbook);
  assert.equal(result.text, 'Sheet "Main"\nRow 1: A1="before"\tB1="between"\tC1="after"\n');
  assert.equal(result.truncated, false);
  assert.doesNotMatch(result.text, /999|chart cache/);
});

test("BIFF8 emits multiple worksheets and chart sheets in workbook declaration order", async () => {
  const workbook = multiSheetWorkbookBytes([
    { name: "First", records: [label(0, "one"), chart(label(0, "first chart")), label(1, "continued")] },
    { name: "Overview", kind: 0x20, records: [label(0, "overview cache")] },
    { name: "Second", records: [chart(label(0, "second chart")), label(0, "two")] },
  ], [2, 1, 0]);
  const result = await extract(workbook);
  assert.equal(result.text, 'Sheet "First"\nRow 1: A1="one"\tB1="continued"\nSheet "Overview"\n[chart sheet omitted]\nSheet "Second"\nRow 1: A1="two"\n');
});

test("BIFF8 rejects unbalanced EOFs, unterminated charts and illegal nested substream kinds", async () => {
  for (const workbook of [
    workbookBytes([label(0, "before"), biffBof(0x20), label(0, "chart")]),
    multiSheetWorkbookBytes([
      { name: "One", records: [label(0, "one"), biffBof(0x20)] },
      { name: "Two", records: [label(0, "two")] },
    ]),
    workbookBytes([biffBof(0x20), biffRecord(0x0a, new Uint8Array([1])), label(0, "after")]),
    joinBytes(workbookBytes([label(0, "before")]), biffRecord(0x0a)),
    workbookBytes([biffBof(0x10), biffRecord(0x0a)]),
    workbookBytes([biffBof(0x20), biffBof(0x20), biffRecord(0x0a), biffRecord(0x0a)]),
    workbookBytes([biffBof(5), biffRecord(0x0a)]),
    workbookBytes([biffRecord(0x809, new Uint8Array([0, 6, 0x20, 0])), biffRecord(0x0a)]),
  ]) await assert.rejects(extract(workbook), processingError("invalid_document"));
});

test("BIFF8 rejects sheet offsets that point inside chart substreams or record payloads", async () => {
  const workbook = workbookBytes([label(0, "before"), chart(label(0, "cached")), label(1, "after")]);
  const boundsOffset = biffBof(5).length + 4;
  const sheetOffset = dataView(workbook).getUint32(boundsOffset, true);
  const chartOffset = sheetOffset + biffBof(0x10).length + biffRecord(0x81, new Uint8Array(2)).length + label(0, "before").length;
  const pointsAtChart = new Uint8Array(workbook);
  dataView(pointsAtChart).setUint32(boundsOffset, chartOffset, true); pointsAtChart[boundsOffset + 5] = 2;
  await assert.rejects(extract(pointsAtChart), processingError("invalid_document"));
  const pointsInsideRecord = new Uint8Array(workbook);
  dataView(pointsInsideRecord).setUint32(boundsOffset, chartOffset + 8, true);
  await assert.rejects(extract(pointsInsideRecord), processingError("invalid_document"));
  const crossesBoundary = new Uint8Array(workbook);
  dataView(crossesBoundary).setUint16(chartOffset + biffBof(0x20).length + 2, 8224, true);
  await assert.rejects(extract(crossesBoundary), processingError("invalid_document"));
});

test("BIFF8 preserves macro, encryption and unsupported-version rejection in nested streams", async () => {
  await assert.rejects(extract(workbookBytes([biffBof(0x40), biffRecord(0x0a)])), processingError("macro_enabled"));
  await assert.rejects(extract(workbookBytes([biffBof(0x20), biffRecord(0x2f), biffRecord(0x0a)])), processingError("encrypted_document"));
  await assert.rejects(extract(workbookBytes([biffBof(0x20, 0x500), biffRecord(0x0a)])), processingError("unsupported_type"));
});

test("BIFF8 validates and cancels large embedded chart substreams within the record budget", async () => {
  const records = Array.from({ length: 2000 }, () => biffRecord(0x1002, new Uint8Array(2)));
  const workbook = workbookBytes([label(0, "before"), chart(...records), label(1, "after")]);
  assert.match((await extract(workbook)).text, /A1="before"\tB1="after"/);
  const controller = new AbortController();
  const pending = extract(workbook, controller.signal);
  await yieldImmediate(); controller.abort(new Error("cancel nested chart inspection"));
  await assert.rejects(pending, /cancel nested chart inspection/);
});
