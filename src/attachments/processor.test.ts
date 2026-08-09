import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  AttachmentProcessingError,
  classifyDocumentAttachment,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  processAttachment,
  sniffAttachmentContainer,
} from "./processor.js";

function pdfBytes(
  version: string,
  body = "1 0 obj\n<<>>\nendobj\n",
  trailer = "%%EOF\n",
): Uint8Array {
  return Buffer.from(`%PDF-${version}\n${body}${trailer}`, "latin1");
}

function processingError(
  code: AttachmentProcessingError["code"],
  message?: RegExp,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AttachmentProcessingError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  };
}

test("document signature accepts supported PDF versions with a bounded final EOF", () => {
  for (const version of [
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
    "1.6",
    "1.7",
    "2.0",
  ]) {
    assert.equal(
      sniffAttachmentContainer(
        pdfBytes(version, "1 0 obj\n<<>>\nendobj\n", "%%EOF\n% trailing comment\r\n"),
        `score-${version}.bin`,
      ),
      "pdf",
    );
  }
});

test("document signature rejects malformed, truncated, and ambiguously terminated PDFs", () => {
  const cases = [
    new Uint8Array(),
    Buffer.from("MZ executable", "latin1"),
    pdfBytes("1.8"),
    pdfBytes("2.1"),
    pdfBytes("1.7", "1 0 obj\n<<>>\nendobj\n", ""),
    pdfBytes("1.7", "1 0 obj\n<<>>\nendobj\n", "%%EO"),
    pdfBytes("1.7", "1 0 obj\n<<>>\nendobj\n", "%%EOF\nnot-a-comment"),
    pdfBytes("1.7", "1 0 obj\n<<>>\nendobj\n", `%%EOF\n${" ".repeat(1_025)}`),
  ];

  for (const bytes of cases) {
    assert.throws(
      () => sniffAttachmentContainer(bytes, "renamed.pdf"),
      processingError("invalid_document"),
    );
  }
});

test("document processor conservatively rejects a raw PDF Encrypt name token", async () => {
  for (const encryptName of ["/Encrypt", "/Encr#79pt", "/#45ncrypt"]) {
    await assert.rejects(
      processAttachment({
        bytes: pdfBytes("1.7", `trailer\n<< ${encryptName} 12 0 R >>\n`),
        fileName: "encrypted.pdf",
        claimedMediaType: "application/pdf",
        nativePdfAllowed: true,
      }),
      processingError("encrypted_document"),
    );
  }

  const similarlyNamed = pdfBytes("1.7", "1 0 obj\n<< /Encryption false >>\nendobj\n");
  const processed = await processAttachment({
    bytes: similarlyNamed,
    fileName: "plain.pdf",
    claimedMediaType: "application/pdf",
    nativePdfAllowed: true,
  });
  assert.equal(processed.type, "native_pdf");
});

test("document processor returns native PDF bytes only for a compatible API mode", async () => {
  const bytes = pdfBytes("2.0");
  const processed = await processAttachment({
    bytes,
    fileName: "score.pdf",
    claimedMediaType: "application/pdf",
    nativePdfAllowed: true,
  });

  assert.equal(processed.type, "native_pdf");
  assert.equal(processed.fileName, "score.pdf");
  assert.equal(processed.mediaType, "application/pdf");
  assert.deepEqual(processed.bytes, new Uint8Array(bytes));
  assert.notEqual(processed.bytes, bytes);
  await assert.rejects(
    processAttachment({
      bytes,
      fileName: "score.pdf",
      claimedMediaType: "application/pdf",
      nativePdfAllowed: false,
    }),
    processingError(
      "profile_incompatible",
      /^This Profile\/API mode cannot read PDF attachments\.$/,
    ),
  );
});

test("document processor rejects invalid bytes regardless of claimed media type", async () => {
  await assert.rejects(
    processAttachment({
      bytes: Buffer.from("MZ executable", "latin1"),
      fileName: "renamed.pdf",
      claimedMediaType: "application/pdf",
      nativePdfAllowed: true,
    }),
    processingError("invalid_document"),
  );
});

test("document processor enforces the twenty MiB limit before inspecting bytes", async () => {
  const oversized = new Uint8Array(MAX_DOCUMENT_ATTACHMENT_BYTES + 1);
  await assert.rejects(
    processAttachment({
      bytes: oversized,
      fileName: "oversized.pdf",
      claimedMediaType: "application/pdf",
      nativePdfAllowed: true,
    }),
    processingError("archive_limit", /20 MiB/),
  );
  assert.throws(
    () => sniffAttachmentContainer(oversized, "oversized.zip"),
    processingError("archive_limit", /20 MiB/),
  );
});

test("document PDF EOF marker accepts the exact final-window boundary", () => {
  assert.equal(
    sniffAttachmentContainer(pdfBytes("1.7", "", `%%EOF${" ".repeat(1_019)}`), "exact.pdf"),
    "pdf",
  );
  assert.throws(
    () => sniffAttachmentContainer(
      pdfBytes("1.7", "", `%%EOF${" ".repeat(1_020)}`),
      "over.pdf",
    ),
    processingError("invalid_document"),
  );
});

test("document classification derives canonical Office media types only after validation", async () => {
  const docx = zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Override PartName="/word/document.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
      `Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8("<document/>") ,
  });
  assert.equal(
    await classifyDocumentAttachment({
      bytes: docx,
      fileName: "renamed.bin",
      claimedMediaType: "application/pdf",
    }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  await assert.rejects(
    classifyDocumentAttachment({
      bytes: zipSync({ "generic.txt": strToU8("not Office") }),
      fileName: "renamed.docx",
    }),
    processingError("invalid_document"),
  );
});

test("document processor ignores an untrusted browser media type claim", async () => {
  const processed = await processAttachment({
    bytes: pdfBytes("1.7"),
    fileName: "valid.pdf",
    claimedMediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    nativePdfAllowed: true,
  });
  assert.equal(processed.mediaType, "application/pdf");
});
