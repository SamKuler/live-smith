import assert from "node:assert/strict";
import test from "node:test";

import {
  contentTypes,
  mainParts,
  mutateEntry,
  packageBytes,
  processingError,
  writeU32,
} from "./ooxml-test-helpers.js";
import { openOoxmlPackage } from "./ooxml.js";

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

  for (const activePart of [
    "word/vbaData.xml",
    "word/vbaProjectSignature.bin",
    "word/activeXObject.xml",
  ]) {
    await assert.rejects(
      openOoxmlPackage(packageBytes("docx", { [activePart]: "<root/>" })),
      processingError("macro_enabled"),
    );
  }
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "[Content_Types].xml":
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>` +
        `<Override PartName="/word/document.xml" ContentType="${contentTypes.docx}"/>` +
        `</Types>`,
    })),
    processingError("macro_enabled"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "word/_rels/document.xml.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" ` +
        `Type="http://schemas.microsoft.com/office/2006/relationships/activeXControl" ` +
        `Target="activeX/activeX1.xml"/></Relationships>`,
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
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "_rels/.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="word\\document.xml"/></Relationships>`,
    })),
    processingError("invalid_document"),
  );
  await assert.rejects(
    openOoxmlPackage(packageBytes("docx", {
      "_rels/.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
        `Target="word/document.xml" TargetMode="internal"/></Relationships>`,
    })),
    processingError("invalid_document"),
  );
  const explicitInternal = await openOoxmlPackage(packageBytes("docx", {
    "_rels/.rels":
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
      `Target="word/document.xml" TargetMode="Internal"/></Relationships>`,
  }));
  assert.equal(explicitInternal.kind, "docx");
});
