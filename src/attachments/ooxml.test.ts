import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { AttachmentProcessingError } from "./processor.js";
import {
  collectTextNodes,
  MAX_OOXML_ENTRY_COUNT,
  MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES,
  MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES,
  naturalPartOrder,
  openOoxmlPackage,
  parseXmlPreservingOrder,
} from "./ooxml.js";

const contentTypes = {
  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
} as const;

const mainParts = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
} as const;

function packageBytes(
  kind: keyof typeof contentTypes,
  additions: Record<string, Uint8Array | string> = {},
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/${mainParts[kind]}" ContentType="${contentTypes[kind]}"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="${mainParts[kind]}"/>` +
        `</Relationships>`,
    ),
    [mainParts[kind]]: strToU8("<root/>") ,
  };
  for (const [name, value] of Object.entries(additions)) {
    entries[name] = typeof value === "string" ? strToU8(value) : value;
  }
  return zipSync(entries, { level: 6 });
}

function processingError(code: AttachmentProcessingError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AttachmentProcessingError);
    assert.equal(error.code, code);
    return true;
  };
}

function centralHeaders(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (readU32(bytes, offset) === 0x02014b50) offsets.push(offset);
  }
  return offsets;
}

function mutateEntry(
  source: Uint8Array,
  entryIndex: number,
  mutate: (bytes: Uint8Array, centralOffset: number, localOffset: number) => void,
): Uint8Array {
  const bytes = new Uint8Array(source);
  const centralOffset = centralHeaders(bytes)[entryIndex];
  assert.notEqual(centralOffset, undefined);
  const localOffset = readU32(bytes, centralOffset! + 42);
  mutate(bytes, centralOffset!, localOffset);
  return bytes;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function withZipComment(source: Uint8Array, comment: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(source.byteLength + comment.byteLength);
  bytes.set(source);
  bytes.set(comment, source.byteLength);
  writeU16(bytes, source.byteLength - 2, comment.byteLength);
  return bytes;
}

function utf16Xml(text: string, endian: "le" | "be"): Uint8Array {
  const littleEndian = new Uint8Array(Buffer.from(text, "utf16le"));
  if (endian === "le") {
    const bytes = new Uint8Array(littleEndian.byteLength + 2);
    bytes.set([0xff, 0xfe]);
    bytes.set(littleEndian, 2);
    return bytes;
  }
  const bytes = new Uint8Array(littleEndian.byteLength + 2);
  bytes.set([0xfe, 0xff]);
  for (let index = 0; index < littleEndian.byteLength; index += 2) {
    bytes[index + 2] = littleEndian[index + 1]!;
    bytes[index + 3] = littleEndian[index]!;
  }
  return bytes;
}

test("OOXML safely identifies DOCX, XLSX, and PPTX from content types", async () => {
  for (const kind of ["docx", "xlsx", "pptx"] as const) {
    const pkg = await openOoxmlPackage(packageBytes(kind));
    assert.equal(pkg.kind, kind);
    assert.ok(pkg.entries.has("[Content_Types].xml"));
    assert.ok(pkg.entries.has(mainParts[kind]));
  }
});

test("OOXML ignores embedded binary content instead of exposing its bytes", async () => {
  const pkg = await openOoxmlPackage(packageBytes("docx", {
    "word/embeddings/payload.bin": new Uint8Array([0x4d, 0x5a, 1, 2, 3]),
  }));

  assert.equal(pkg.entries.has("word/embeddings/payload.bin"), false);
});

test("OOXML accepts inert directory entries and a real EOCD followed by a signature-shaped comment", async () => {
  const entries = {
    "word/": new Uint8Array(),
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/word/document.xml" ContentType="${contentTypes.docx}"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8("<document/>"),
  };
  const fakeEocd = new Uint8Array(22);
  writeU32(fakeEocd, 0, 0x06054b50);
  const pkg = await openOoxmlPackage(withZipComment(zipSync(entries), fakeEocd));
  assert.equal(pkg.kind, "docx");
});

test("OOXML rejects entry-count, single-entry, and aggregate archive limits", async () => {
  const tooMany: Record<string, Uint8Array> = {};
  for (let index = 0; index <= MAX_OOXML_ENTRY_COUNT; index += 1) {
    tooMany[`word/items/item-${index}.xml`] = strToU8("<x/>");
  }
  await assert.rejects(
    openOoxmlPackage(zipSync(tooMany, { level: 0 })),
    processingError("archive_limit"),
  );

  const oneOversized = mutateEntry(packageBytes("docx"), 1, (bytes, central, local) => {
    writeU32(bytes, central + 24, MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES + 1);
    writeU32(bytes, local + 22, MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES + 1);
  });
  await assert.rejects(
    openOoxmlPackage(oneOversized),
    processingError("archive_limit"),
  );

  const aggregateEntries: Record<string, Uint8Array> = {};
  for (let index = 0; index < 9; index += 1) {
    aggregateEntries[`word/items/item-${index}.xml`] = strToU8("<x/>");
  }
  let aggregate = new Uint8Array(zipSync(aggregateEntries, { level: 0 }));
  for (let index = 0; index < 9; index += 1) {
    aggregate = new Uint8Array(mutateEntry(aggregate, index, (bytes, central, local) => {
      const declared = Math.floor(MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES / 8);
      writeU32(bytes, central + 24, declared);
      writeU32(bytes, local + 22, declared);
    }));
  }
  await assert.rejects(
    openOoxmlPackage(aggregate),
    processingError("archive_limit"),
  );
});

test("OOXML rejects traversal, duplicate normalized paths, and malformed ranges", async () => {
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", { "../outside.xml": "<x/>" })),
    processingError("archive_limit"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", { "/absolute.xml": "<x/>" })),
    processingError("archive_limit"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", { "word\\..\\outside.xml": "<x/>" })),
    processingError("archive_limit"),
  );

  const twoFiles = zipSync({ "word/a.xml": strToU8("<a/>"), "word/b.xml": strToU8("<b/>") });
  const duplicate = mutateEntry(twoFiles, 1, (bytes, central, local) => {
    bytes[central + 46 + "word/".length] = "a".charCodeAt(0);
    bytes[local + 30 + "word/".length] = "a".charCodeAt(0);
  });
  await assert.rejects(openOoxmlPackage(duplicate), processingError("archive_limit"));

  const overlap = mutateEntry(twoFiles, 1, (bytes, central) => {
    writeU32(bytes, central + 42, readU32(bytes, centralHeaders(bytes)[0]! + 42));
  });
  await assert.rejects(openOoxmlPackage(overlap), processingError("invalid_document"));
});

test("OOXML rejects encrypted, unsupported, multi-disk, and ZIP64 containers", async () => {
  const encrypted = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU16(bytes, central + 8, 1);
    writeU16(bytes, local + 6, 1);
  });
  await assert.rejects(openOoxmlPackage(encrypted), processingError("encrypted_document"));

  const unsupportedMethod = mutateEntry(
    packageBytes("docx"),
    0,
    (bytes, central, local) => {
      writeU16(bytes, central + 10, 99);
      writeU16(bytes, local + 8, 99);
    },
  );
  await assert.rejects(
    openOoxmlPackage(unsupportedMethod),
    processingError("invalid_document"),
  );

  const multiDisk = new Uint8Array(packageBytes("docx"));
  const eocd = multiDisk.byteLength - 22;
  writeU16(multiDisk, eocd + 4, 1);
  await assert.rejects(openOoxmlPackage(multiDisk), processingError("invalid_document"));

  const zip64 = new Uint8Array(packageBytes("docx"));
  writeU16(zip64, zip64.byteLength - 22 + 8, 0xffff);
  writeU16(zip64, zip64.byteLength - 22 + 10, 0xffff);
  await assert.rejects(openOoxmlPackage(zip64), processingError("archive_limit"));

  const dataDescriptor = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU16(bytes, central + 8, 0x0008);
    writeU16(bytes, local + 6, 0x0008);
  });
  await assert.rejects(openOoxmlPackage(dataDescriptor), processingError("invalid_document"));

  const symlink = mutateEntry(packageBytes("docx"), 0, (bytes, central) => {
    writeU16(bytes, central + 4, (3 << 8) | 20);
    writeU32(bytes, central + 38, 0o120777 << 16);
  });
  await assert.rejects(openOoxmlPackage(symlink), processingError("archive_limit"));
});

test("OOXML cross-checks central/local metadata and actual inflate length", async () => {
  const source = packageBytes("docx");
  const mismatches = [
    (bytes: Uint8Array, central: number) => writeU16(bytes, central + 8, 0x0800),
    (bytes: Uint8Array, central: number) => writeU16(bytes, central + 10, 0),
    (bytes: Uint8Array, central: number) => writeU32(bytes, central + 16, 1),
    (bytes: Uint8Array, central: number) => writeU32(bytes, central + 20, 1),
    (bytes: Uint8Array, central: number) => writeU32(bytes, central + 24, 1),
  ];
  for (const mismatch of mismatches) {
    await assert.rejects(
      openOoxmlPackage(mutateEntry(source, 0, (bytes, central) => mismatch(bytes, central))),
      processingError("invalid_document"),
    );
  }

  const declaredShort = mutateEntry(source, 0, (bytes, central, local) => {
    const actual = readU32(bytes, central + 24);
    writeU32(bytes, central + 24, actual - 1);
    writeU32(bytes, local + 22, actual - 1);
  });
  await assert.rejects(openOoxmlPackage(declaredShort), processingError("archive_limit"));

  const declaredLong = mutateEntry(source, 0, (bytes, central, local) => {
    const actual = readU32(bytes, central + 24);
    writeU32(bytes, central + 24, actual + 1);
    writeU32(bytes, local + 22, actual + 1);
  });
  await assert.rejects(openOoxmlPackage(declaredLong), processingError("invalid_document"));
});

test("OOXML rejects inconsistent EOCD fields and trailing data outside its comment", async () => {
  const source = packageBytes("docx");
  for (const mutate of [
    (bytes: Uint8Array, eocd: number) => writeU16(bytes, eocd + 8, 1),
    (bytes: Uint8Array, eocd: number) => writeU32(bytes, eocd + 12, 1),
    (bytes: Uint8Array, eocd: number) => writeU32(bytes, eocd + 16, 1),
  ]) {
    const bytes = new Uint8Array(source);
    mutate(bytes, bytes.byteLength - 22);
    await assert.rejects(openOoxmlPackage(bytes), processingError("invalid_document"));
  }
  const trailing = new Uint8Array(source.byteLength + 1);
  trailing.set(source);
  trailing[trailing.byteLength - 1] = 1;
  await assert.rejects(openOoxmlPackage(trailing), processingError("invalid_document"));
});

test("OOXML rejects CRC corruption, malformed XML, DTDs, macros, and required external relationships", async () => {
  const badCrc = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU32(bytes, central + 16, 0);
    writeU32(bytes, local + 14, 0);
  });
  await assert.rejects(openOoxmlPackage(badCrc), processingError("invalid_document"));

  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", { "[Content_Types].xml": "<Types>" })),
    processingError("invalid_document"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "word/document.xml": "<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>",
    })),
    processingError("invalid_document"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "[Content_Types].xml":
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/word/document.xml" ` +
        `ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`,
    })),
    processingError("macro_enabled"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "_rels/.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="https://example.test/data" TargetMode="External"/></Relationships>`,
    })),
    processingError("invalid_document"),
  );

  const harmlessExternalLink = await openOoxmlPackage(packageBytes("docx", {
    "word/_rels/document.xml.rels":
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId2" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ` +
      `Target="https://example.test/ignored" TargetMode="External"/></Relationships>`,
  }));
  assert.equal(harmlessExternalLink.kind, "docx");

  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "word/vbaProject.bin": new Uint8Array([1, 2, 3]),
    })),
    processingError("macro_enabled"),
  );
});

test("OOXML requires exact package roots, namespaces, and officeDocument relationship types", async () => {
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "_rels/.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="https://evil.test/officeDocument" ` +
        `Target="word/document.xml"/></Relationships>`,
    })),
    processingError("invalid_document"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "[Content_Types].xml":
        `<Types xmlns="https://evil.test/content-types">` +
        `<Override PartName="/word/document.xml" ContentType="${contentTypes.docx}"/>` +
        `</Types>`,
    })),
    processingError("invalid_document"),
  );
});

test("OOXML terminates a high-expansion entry before accepting forged declared output", async () => {
  const source = packageBytes("docx", {
    "word/document.xml": `<document><text>${"A".repeat(128 * 1024)}</text></document>`,
  });
  const forged = mutateEntry(source, 2, (bytes, central, local) => {
    writeU32(bytes, central + 24, 1);
    writeU32(bytes, local + 22, 1);
  });
  await assert.rejects(openOoxmlPackage(forged), processingError("archive_limit"));
});

test("OOXML XML helpers preserve order without expanding entities", () => {
  const nodes = parseXmlPreservingOrder(
    "<root><a>first</a><a>第二</a><value>001 &amp; &#x41; &lt;</value></root>",
  );
  assert.deepEqual(collectTextNodes(nodes), ["first", "第二", "001 & A <"]);
  assert.deepEqual(
    ["slide10.xml", "slide2.xml", "slide1.xml"].sort(naturalPartOrder),
    ["slide1.xml", "slide2.xml", "slide10.xml"],
  );
  assert.throws(
    () => parseXmlPreservingOrder("<!DOCTYPE root [<!ENTITY x 'expanded'>]><root>&x;</root>"),
    processingError("invalid_document"),
  );
  assert.throws(
    () => parseXmlPreservingOrder("<?target value?><root/>") ,
    processingError("invalid_document"),
  );
  for (const numericEntity of ["&#0;", "&#1;", "&#xB;", "&#xFFFE;", "&#xFFFF;"]) {
    assert.throws(
      () => parseXmlPreservingOrder(`<root>${numericEntity}</root>`),
      processingError("invalid_document"),
    );
  }
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder("<root>&#9;&#10;&#13;&#x10000;</root>")),
    ["\t\n\r\u{10000}"],
  );
  assert.throws(
    () => parseXmlPreservingOrder(`<root>${"<x>".repeat(257)}value${"</x>".repeat(257)}</root>`),
    (error: unknown) => error instanceof AttachmentProcessingError,
  );
});

test("OOXML XML decoding accepts strict UTF BOMs and rejects malformed or mismatched encodings", () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><root>ok</root>`,
  )]);
  assert.deepEqual(collectTextNodes(parseXmlPreservingOrder(utf8)), ["ok"]);
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml(
      `<?xml version="1.0" encoding="UTF-16"?><root>左</root>`,
      "le",
    ))),
    ["左"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml(
      `<?xml version="1.0" encoding="UTF-16BE"?><root>右</root>`,
      "be",
    ))),
    ["右"],
  );
  assert.deepEqual(
    collectTextNodes(parseXmlPreservingOrder(utf16Xml("<root>无声明</root>", "le"))),
    ["无声明"],
  );
  assert.throws(
    () => parseXmlPreservingOrder(new Uint8Array([0x3c, 0x72, 0x80, 0x2f, 0x3e])),
    processingError("invalid_document"),
  );
  assert.throws(
    () => parseXmlPreservingOrder(strToU8(
      `<?xml version="1.0" encoding="UTF-16"?><root/>`,
    )),
    processingError("invalid_document"),
  );
});

test("OOXML XML token budget rejects an AST allocation bomb before parsing", () => {
  const bomb = `<root>${"<x/>".repeat(200_001)}</root>`;
  assert.throws(
    () => parseXmlPreservingOrder(bomb),
    processingError("archive_limit"),
  );
});

test("OOXML extraction observes cancellation before inflating content", async () => {
  const reason = new Error("stopped");
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx"), {
      aborted: true,
      reason,
    } as AbortSignal),
    (error: unknown) => error === reason,
  );
});

test("OOXML extraction cooperatively observes cancellation between compressed chunks", async () => {
  const binary = new Uint8Array(128 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < binary.byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    binary[index] = state >>> 24;
  }
  const controller = new AbortController();
  const reason = new Error("cancelled during inflate");
  const pending = openOoxmlPackage(packageBytes("docx", {
    "word/embeddings/inert.bin": binary,
  }), controller.signal);
  await yieldImmediate();
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});
