import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  AttachmentProcessingError,
  processAttachment,
  sniffAttachmentType,
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
      sniffAttachmentType(
        pdfBytes(version, "1 0 obj\n<<>>\nendobj\n", "%%EOF\n% trailing comment\r\n"),
        `score-${version}.bin`,
      ),
      "application/pdf",
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
      () => sniffAttachmentType(bytes, "renamed.pdf"),
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
        mediaType: "application/pdf",
        nativePdfAllowed: true,
      }),
      processingError("encrypted_document"),
    );
  }

  const similarlyNamed = pdfBytes("1.7", "1 0 obj\n<< /Encryption false >>\nendobj\n");
  const processed = await processAttachment({
    bytes: similarlyNamed,
    fileName: "plain.pdf",
    mediaType: "application/pdf",
    nativePdfAllowed: true,
  });
  assert.equal(processed.type, "native_pdf");
});

test("document processor returns native PDF bytes only for a compatible API mode", async () => {
  const bytes = pdfBytes("2.0");
  const processed = await processAttachment({
    bytes,
    fileName: "score.pdf",
    mediaType: "application/pdf",
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
      mediaType: "application/pdf",
      nativePdfAllowed: false,
    }),
    processingError(
      "unsupported_type",
      /^This Profile\/API mode cannot read PDF attachments\.$/,
    ),
  );
});

test("document processor rejects a claimed PDF media type when bytes disagree", async () => {
  await assert.rejects(
    processAttachment({
      bytes: Buffer.from("MZ executable", "latin1"),
      fileName: "renamed.pdf",
      mediaType: "application/pdf",
      nativePdfAllowed: true,
    }),
    processingError("invalid_document"),
  );
});
