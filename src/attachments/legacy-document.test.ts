import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";
import { openCompoundDocument } from "./compound.js";
import { classifyRichDocumentAttachment, extractRichDocumentText, type RichDocumentMediaType } from "./rich-document.js";
import { processingError } from "./ooxml-test-helpers.js";
import { biffBof, biffCell, biffRecord, compoundBytes, dataView, joinBytes, pptStreams, unicodeBiffString, wordStreams, workbookBytes } from "./legacy-document-test-helpers.js";

function extract(streams: Record<string, Uint8Array>, mediaType: RichDocumentMediaType) {
  return extractRichDocumentText({ bytes: compoundBytes(streams), fileName: "renamed.bin", mediaType });
}

test("CFB reads bounded regular and mini streams and legacy types come from actual stream names", async () => {
  const bytes = compoundBytes({ Small: Buffer.from("small"), Large: Buffer.from("x".repeat(4097)) });
  const document = await openCompoundDocument(bytes);
  assert.equal(Buffer.from(document.streams.get("Small")!).toString(), "small");
  assert.equal(document.streams.get("Large")!.length, 4097);
  assert.equal(await classifyRichDocumentAttachment({ bytes, fileName: "fake.doc" }), undefined);
  assert.equal(await classifyRichDocumentAttachment({ bytes: compoundBytes(wordStreams("hi\r")), fileName: "fake.pdf" }), "application/msword");
  assert.equal(await classifyRichDocumentAttachment({ bytes: compoundBytes(pptStreams()), fileName: "fake.txt" }), "application/vnd.ms-powerpoint");
});

test("CFB rejects malformed sector lengths, cycles, overlapping mini chains and directory links", async () => {
  const source = compoundBytes({ Small: Buffer.from("hi"), Large: Buffer.from("x".repeat(4096)) });
  await assert.rejects(openCompoundDocument(source.subarray(0, source.length - 1)), processingError("invalid_document"));
  const mutations: ((bytes: Uint8Array, view: DataView) => void)[] = [
    (_, view) => view.setUint32(48, 0xfffffffd, true),
    (_, view) => view.setUint32(512 + 76, 0, true),
    (_, view) => view.setBigUint64(512 + 120, BigInt(21 * 1024 * 1024), true),
    (_, view) => { const fat = view.getUint32(76, true); view.setUint32((fat + 1) * 512, 0, true); },
  ];
  for (const mutate of mutations) {
    const bytes = new Uint8Array(source); mutate(bytes, dataView(bytes));
    await assert.rejects(openCompoundDocument(bytes), (error: unknown) => error instanceof Error);
  }
  const mini = compoundBytes({ First: Buffer.from("first"), Second: Buffer.from("second") });
  dataView(mini).setUint32(512 + 2 * 128 + 116, 0, true);
  await assert.rejects(openCompoundDocument(mini), processingError("invalid_document"));
});

test("Word97 piece tables preserve Unicode and field results while omitting field instructions", async () => {
  const result = await extract(wordStreams("正文 🎵\r\u0013HYPERLINK SECRET\u0014Visible\u0015\r"), "application/msword");
  assert.equal(result.text, "正文 🎵\nVisible\n"); assert.equal(result.truncated, false);
  assert.equal((await extract(wordStreams("ASCII\rA\u0007B\r", true), "application/msword")).text, "ASCII\nA\tB\n");
});

test("Word rejects encryption, unsupported versions, invalid pieces and unresolved fields", async () => {
  for (const [offset, value, code] of [[10, 0x100, "encrypted_document"], [2, 0x65, "unsupported_type"]] as const) {
    const streams = wordStreams("hi\r"); dataView(streams.WordDocument!).setUint16(offset, value, true);
    await assert.rejects(extract(streams, "application/msword"), processingError(code));
  }
  const invalidPiece = wordStreams("hi\r"); dataView(invalidPiece["0Table"]!).setUint32(15, 0x3fffffff, true);
  await assert.rejects(extract(invalidPiece, "application/msword"), processingError("invalid_document"));
  await assert.rejects(extract(wordStreams("\u0013unresolved"), "application/msword"), processingError("invalid_document"));
  await assert.rejects(extract({ ...wordStreams("hi"), VBA: Buffer.from("macro") }, "application/msword"), processingError("macro_enabled"));
});

test("BIFF8 Excel extracts SST Unicode, numeric and cached formula values with sparse coordinates", async () => {
  const sst = new Uint8Array(8); dataView(sst).setUint32(0, 1, true); dataView(sst).setUint32(4, 1, true);
  const labelIndex = new Uint8Array(4);
  const number = new Uint8Array(8); dataView(number).setFloat64(0, 42.125, true);
  const formula = new Uint8Array(23); dataView(formula).setFloat64(0, 3, true); dataView(formula).setUint16(14, 7, true); formula.set([0x1e, 1, 0, 0x1e, 2, 0, 3], 16);
  const rk = new Uint8Array(4); dataView(rk).setUint32(0, 99 << 2 | 2, true);
  const workbook = workbookBytes([
    biffCell(0xfd, 0, 0, labelIndex), biffCell(0x203, 0, 1, number), biffCell(6, 1, 0, formula), biffCell(0x27e, 65535, 255, rk),
  ], [biffRecord(0xfc, joinBytes(sst, unicodeBiffString("音乐 🎵")))]);
  const result = await extract({ Workbook: workbook }, "application/vnd.ms-excel");
  assert.equal(result.text, 'Sheet "Main"\nRow 1: A1="音乐 🎵"\tB1="42.125"\nRow 2: A2="3"\nRow 65536: IV65536="99"\n');
  assert.ok(result.text.length < 200);
});

test("Excel SST Continue can switch compressed and UTF-16 characters without losing boundaries", async () => {
  const header = new Uint8Array(11); dataView(header).setUint32(0, 1, true); dataView(header).setUint32(4, 1, true); dataView(header).setUint16(8, 4, true);
  const workbook = workbookBytes([biffCell(0xfd, 0, 0, new Uint8Array(4))], [
    biffRecord(0xfc, joinBytes(header, Buffer.from("AB"))), biffRecord(0x3c, joinBytes(new Uint8Array([1]), Buffer.from("中文", "utf16le"))),
  ]);
  assert.match((await extract({ Workbook: workbook }, "application/vnd.ms-excel")).text, /A1="AB中文"/);
});

test("Excel rejects encrypted, old BIFF, macro sheets and invalid shared-string references", async () => {
  await assert.rejects(extract({ Workbook: joinBytes(biffBof(5), biffRecord(0x2f)) }, "application/vnd.ms-excel"), processingError("encrypted_document"));
  await assert.rejects(extract({ Book: joinBytes(biffBof(5, 0x500), biffRecord(0x0a)) }, "application/vnd.ms-excel"), processingError("unsupported_type"));
  await assert.rejects(extract({ Workbook: workbookBytes([biffCell(0xfd, 0, 0, new Uint8Array(4))]) }, "application/vnd.ms-excel"), processingError("invalid_document"));
  const macro = workbookBytes([]); macro[20 + 4 + 5] = 1;
  await assert.rejects(extract({ Workbook: macro }, "application/vnd.ms-excel"), processingError("macro_enabled"));
});

test("PowerPoint97 follows the live slide order and excludes stale text in unrelated records", async () => {
  const result = await extract(pptStreams(), "application/vnd.ms-powerpoint");
  assert.equal(result.text, "Slide 1\n音乐 🎵\nSlide 2\nSecond\n"); assert.doesNotMatch(result.text, /STALE|SECRET/);
});

test("PowerPoint resolves notes IDs through NotesPersistAtom and nested text boxes", async () => {
  const result = await extract(pptStreams(true), "application/vnd.ms-powerpoint");
  assert.equal(result.text, "Slide 1\n音乐 🎵\nText box\nNotes\nSpeaker notes\nSlide 2\nSecond\n");
});

test("PowerPoint rejects encrypted, missing persist maps and cyclic edit chains without raw recovery", async () => {
  const encrypted = pptStreams(); dataView(encrypted["Current User"]!).setUint32(12, 0xf3d1c4df, true);
  await assert.rejects(extract(encrypted, "application/vnd.ms-powerpoint"), processingError("encrypted_document"));
  const invalid = pptStreams(); const edit = dataView(invalid["Current User"]!).getUint32(16, true);
  dataView(invalid["PowerPoint Document"]!).setUint32(edit + 8 + 12, 0xffffffff, true);
  await assert.rejects(extract(invalid, "application/vnd.ms-powerpoint"), processingError("invalid_document"));
  const cyclic = pptStreams(); const position = dataView(cyclic["Current User"]!).getUint32(16, true);
  dataView(cyclic["PowerPoint Document"]!).setUint32(position + 8 + 8, position, true);
  await assert.rejects(extract(cyclic, "application/vnd.ms-powerpoint"), processingError("invalid_document"));
});

test("legacy extraction enforces text limits and cancellable compound traversal", async () => {
  const long = await extract(wordStreams(`${"🎵".repeat(100001)}\r`), "application/msword");
  assert.equal([...long.text].length, 100000); assert.equal(long.truncated, true);
  const before = new AbortController(); before.abort(new Error("cancel legacy before"));
  await assert.rejects(openCompoundDocument(compoundBytes(wordStreams("hi")), before.signal), /cancel legacy before/);
  const during = new AbortController();
  const pending = openCompoundDocument(compoundBytes(wordStreams("x".repeat(2_000_000))), during.signal);
  await yieldImmediate(); during.abort(new Error("cancel legacy during"));
  await assert.rejects(pending, /cancel legacy during/);
});
