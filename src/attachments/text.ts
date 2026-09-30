import { TextDecoder } from "node:util";

import { throwIfAborted, yieldToHost } from "../runtime/host.js";
import {
  assertDocumentAttachmentBytesWithinLimit,
  AttachmentProcessingError,
} from "./contracts.js";
import {
  BoundedDocumentTextBuilder,
  type ExtractedDocumentText,
} from "./document-text.js";

const TEXT_CHUNK_BYTES = 64 * 1024;
type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";

/** Decodes text as data; markup, source code and escape sequences stay inert. */
export async function inspectTextAttachment(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedDocumentText> {
  assertDocumentAttachmentBytesWithinLimit(bytes);
  throwIfAborted(signal);
  const encoding = detectTextEncoding(bytes);
  const decoder = new TextDecoder(encoding, { fatal: true });
  const builder = new BoundedDocumentTextBuilder();
  let hasDecodedCharacters = false;

  for (let offset = 0; offset < bytes.byteLength; offset += TEXT_CHUNK_BYTES) {
    throwIfAborted(signal);
    const end = Math.min(offset + TEXT_CHUNK_BYTES, bytes.byteLength);
    let decoded: string;
    try {
      decoded = decoder.decode(bytes.subarray(offset, end), {
        stream: end < bytes.byteLength,
      });
    } catch {
      throw invalidText();
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/u.test(decoded)) {
      throw invalidText();
    }
    hasDecodedCharacters ||= decoded.length > 0;
    builder.append(decoded);
    await yieldToHost(signal);
  }
  if (!hasDecodedCharacters) throw invalidText();
  return builder.finish();
}

function detectTextEncoding(bytes: Uint8Array): TextEncoding {
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) throw invalidText();
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes.byteLength % 2 !== 0) return "utf-8";

  const sampleLength = Math.min(TEXT_CHUNK_BYTES, bytes.byteLength);
  const pairs = sampleLength / 2;
  if (pairs < 4) return "utf-8";
  let evenZeroes = 0;
  let oddZeroes = 0;
  for (let offset = 0; offset < sampleLength; offset += 2) {
    if (bytes[offset] === 0) evenZeroes += 1;
    if (bytes[offset + 1] === 0) oddZeroes += 1;
  }
  const reliableZeroes = Math.max(4, Math.ceil(pairs * 0.3));
  const toleratedOtherZeroes = Math.floor(pairs * 0.01);
  if (oddZeroes >= reliableZeroes && evenZeroes <= toleratedOtherZeroes) {
    return "utf-16le";
  }
  if (evenZeroes >= reliableZeroes && oddZeroes <= toleratedOtherZeroes) {
    return "utf-16be";
  }
  return "utf-8";
}

function invalidText(): AttachmentProcessingError {
  return new AttachmentProcessingError(
    "invalid_document",
    "The attachment does not contain valid UTF-8 or UTF-16 text.",
  );
}
