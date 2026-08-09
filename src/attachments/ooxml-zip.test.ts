import assert from "node:assert/strict";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import { MAX_DOCUMENT_ATTACHMENT_BYTES } from "./contracts.js";
import {
  asStructurallyValidZip64,
  centralHeaders,
  contentTypes,
  mutateEntry,
  packageBytes,
  processingError,
  readU16,
  readU32,
  withDataDescriptor,
  withIncompleteZip64DirectoryCandidate,
  withMalformedZip64EntryCandidate,
  withZipComment,
  writeU16,
  writeU32,
  zipWithOffsetAdjustedPrefix,
} from "./ooxml-test-helpers.js";
import {
  MAX_OOXML_ENTRY_COUNT,
  MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES,
  MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES,
  openOoxmlPackage,
} from "./ooxml.js";

test("OOXML accepts inert directory entries and ignores a structurally invalid EOCD comment", async () => {
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
  const withInvalidFake = await openOoxmlPackage(
    withZipComment(zipSync(entries, { level: 0 }), fakeEocd),
  );
  assert.equal(withInvalidFake.kind, "docx");
  const fakeZip64Eocd = new Uint8Array(fakeEocd);
  writeU32(fakeZip64Eocd, 12, 0xffff_ffff);
  const withInvalidZip64Fake = await openOoxmlPackage(
    withZipComment(zipSync(entries, { level: 0 }), fakeZip64Eocd),
  );
  assert.equal(withInvalidZip64Fake.kind, "docx");
  const harmlessComment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3]);
  const pkg = await openOoxmlPackage(
    withZipComment(zipSync(entries, { level: 0 }), harmlessComment),
  );
  assert.equal(pkg.kind, "docx");

  const withMalformedZip64Entry = await openOoxmlPackage(
    withMalformedZip64EntryCandidate(zipSync(entries, { level: 0 })),
  );
  assert.equal(withMalformedZip64Entry.kind, "docx");
  const withIncompleteZip64Directory = await openOoxmlPackage(
    withIncompleteZip64DirectoryCandidate(zipSync(entries, { level: 0 })),
  );
  assert.equal(withIncompleteZip64Directory.kind, "docx");
});

test("OOXML enforces the document byte limit at its public package boundary", async () => {
  await assert.rejects(
    openOoxmlPackage(new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1)),
    processingError("archive_limit"),
  );
});

test("OOXML rejects an outer archive hiding behind an offset-adjusted benign ZIP comment", async () => {
  const encrypted = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU16(bytes, central + 8, readU16(bytes, central + 8) | 0x0001);
    writeU16(bytes, local + 6, readU16(bytes, local + 6) | 0x0001);
  });
  const unsupportedMethod = mutateEntry(
    packageBytes("docx"),
    0,
    (bytes, central, local) => {
      writeU16(bytes, central + 10, 99);
      writeU16(bytes, local + 8, 99);
    },
  );
  const oversized = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU32(bytes, central + 24, MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES + 1);
    writeU32(bytes, local + 22, MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES + 1);
  });
  const zip64 = asStructurallyValidZip64(packageBytes("docx"));
  for (const outer of [
    packageBytes("docx", { "word/vbaProject.bin": new Uint8Array([1, 2, 3]) }),
    zipSync({ "generic.txt": strToU8("not Office") }),
    encrypted,
    unsupportedMethod,
    oversized,
    zip64,
    packageBytes("docx", { "../outside.xml": "<root/>" }),
  ]) {
    const polyglot = zipWithOffsetAdjustedPrefix(outer, packageBytes("docx"));
    await assert.rejects(
      openOoxmlPackage(polyglot),
      processingError("invalid_document"),
    );
  }
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
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", { "word\\document.xml": "<x/>" })),
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

  const zip64 = asStructurallyValidZip64(packageBytes("docx"));
  await assert.rejects(openOoxmlPackage(zip64), processingError("archive_limit"));

  const invalidZip64Sentinel = new Uint8Array(packageBytes("docx"));
  writeU16(invalidZip64Sentinel, invalidZip64Sentinel.byteLength - 22 + 8, 0xffff);
  writeU16(invalidZip64Sentinel, invalidZip64Sentinel.byteLength - 22 + 10, 0xffff);
  await assert.rejects(
    openOoxmlPackage(invalidZip64Sentinel),
    processingError("invalid_document"),
  );

  const dataDescriptor = mutateEntry(packageBytes("docx"), 0, (bytes, central, local) => {
    writeU16(bytes, central + 8, 0x0008);
    writeU16(bytes, local + 6, 0x0008);
  });
  await assert.rejects(openOoxmlPackage(dataDescriptor), processingError("invalid_document"));

  const hiddenBehindMissingDescriptor = await openOoxmlPackage(
    zipWithOffsetAdjustedPrefix(dataDescriptor, packageBytes("docx")),
  );
  assert.equal(hiddenBehindMissingDescriptor.kind, "docx");
  await assert.rejects(
    openOoxmlPackage(zipWithOffsetAdjustedPrefix(
      withDataDescriptor(packageBytes("docx"), 0),
      packageBytes("docx"),
    )),
    processingError("invalid_document"),
  );
  await assert.rejects(
    openOoxmlPackage(zipWithOffsetAdjustedPrefix(
      withDataDescriptor(packageBytes("docx"), 0, {
        includeSignature: false,
        crc32: 0x08074b50,
      }),
      packageBytes("docx"),
    )),
    processingError("invalid_document"),
  );

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

test("OOXML rejects small compressed entries whose declared expansion ratio exceeds the limit", async () => {
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "word/document.xml": `<document>${"A".repeat(184 * 1024)}</document>`,
    })),
    processingError("archive_limit"),
  );
});

test("OOXML validates directory entry CRC instead of skipping its integrity", async () => {
  const directoryArchive = zipSync({
    "word/": new Uint8Array(),
    ...Object.fromEntries(Object.entries({
      "[Content_Types].xml":
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Override PartName="/word/document.xml" ContentType="${contentTypes.docx}"/>` +
        `</Types>`,
      "_rels/.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="word/document.xml"/></Relationships>`,
      "word/document.xml": "<document/>",
    }).map(([name, value]) => [name, strToU8(value)])),
  });
  const corruptDirectory = mutateEntry(
    directoryArchive,
    0,
    (bytes, central, local) => {
      writeU32(bytes, central + 16, 1);
      writeU32(bytes, local + 14, 1);
    },
  );
  await assert.rejects(
    openOoxmlPackage(corruptDirectory),
    processingError("invalid_document"),
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

test("OOXML directory parsing cooperatively observes cancellation", async () => {
  const entries: Record<string, Uint8Array> = {};
  for (let index = 0; index < 4_096; index += 1) {
    entries[`word/items/item-${index}.xml`] = strToU8("<x/>");
  }
  const controller = new AbortController();
  const reason = new Error("cancelled during central directory parsing");
  const pending = openOoxmlPackage(zipSync(entries, { level: 0 }), controller.signal);
  await yieldImmediate();
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});
