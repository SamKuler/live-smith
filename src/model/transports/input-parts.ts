import {
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../../attachments/contracts.js";
import type { ModelInputPart } from "../contracts.js";
import type { TransportRequest } from "../provider.js";

const MAX_BINARY_BASE64_CHARACTERS =
  Math.ceil(MAX_PENDING_ATTACHMENT_BYTES / 3) * 4;

export function assertBinaryInputWithinLimits(
  request: TransportRequest,
): void {
  let count = 0;
  let totalBytes = 0;
  let imageBytes = 0;
  let pdfBytes = 0;

  for (const part of binaryUserInputParts(request)) {
    count += 1;
    if (count > MAX_PENDING_ATTACHMENT_COUNT) {
      throw new Error(
        `Model requests may contain at most ${MAX_PENDING_ATTACHMENT_COUNT} binary attachments.`,
      );
    }

    assertBinaryPartMediaType(part);
    const byteLength = canonicalBase64DecodedByteLength(part.base64);
    if (part.type === "image") {
      if (byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error("Image input may not exceed 5 MiB per attachment.");
      }
      imageBytes += byteLength;
      if (imageBytes > MAX_PENDING_IMAGE_ATTACHMENT_BYTES) {
        throw new Error("Image input subtotal may not exceed 16 MiB.");
      }
    } else {
      if (byteLength > MAX_DOCUMENT_ATTACHMENT_BYTES) {
        throw new Error("PDF input may not exceed 20 MiB per attachment.");
      }
      pdfBytes += byteLength;
      if (pdfBytes > MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES) {
        throw new Error("PDF input subtotal may not exceed 20 MiB.");
      }
    }

    totalBytes += byteLength;
    if (totalBytes > MAX_PENDING_ATTACHMENT_BYTES) {
      throw new Error("Binary input subtotal may not exceed 20 MiB.");
    }
  }
}

function assertBinaryPartMediaType(
  part: Extract<ModelInputPart, { type: "image" | "document" }>,
): void {
  const valid = part.type === "image"
    ? part.mediaType === "image/png" ||
      part.mediaType === "image/jpeg" ||
      part.mediaType === "image/webp"
    : part.mediaType === "application/pdf";
  if (!valid) {
    throw new Error("Binary input has an invalid media type.");
  }
}

function* binaryUserInputParts(
  request: TransportRequest,
): Generator<Extract<ModelInputPart, { type: "image" | "document" }>> {
  for (const message of request.history) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type === "image" || part.type === "document") yield part;
    }
  }
  for (const part of request.currentUserContent) {
    if (part.type === "image" || part.type === "document") yield part;
  }
}

function canonicalBase64DecodedByteLength(value: unknown): number {
  if (typeof value === "string" && value.length > MAX_BINARY_BASE64_CHARACTERS) {
    throw new Error("Binary input subtotal may not exceed 20 MiB.");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0
  ) {
    throw invalidBase64();
  }

  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) {
    padding = value.charCodeAt(value.length - 2) === 0x3d ? 2 : 1;
  }
  const contentLength = value.length - padding;
  let finalValue = -1;
  for (let index = 0; index < contentLength; index += 1) {
    finalValue = base64SextetValue(value.charCodeAt(index));
    if (finalValue < 0) throw invalidBase64();
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) throw invalidBase64();
  }
  if (
    (padding === 2 && (finalValue & 0x0f) !== 0) ||
    (padding === 1 && (finalValue & 0x03) !== 0)
  ) {
    throw invalidBase64();
  }
  return value.length / 4 * 3 - padding;
}

function base64SextetValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function invalidBase64(): Error {
  return new Error("Binary input must use canonical base64 encoding.");
}

export function assertImageInputEnabled(request: TransportRequest): void {
  if (!request.runtimeProfile.capabilities.inputs.image) {
    throw new Error("Image input is disabled by the active model Profile capability.");
  }
}

export function assertPdfInputEnabled(request: TransportRequest): void {
  if (!request.runtimeProfile.capabilities.inputs.pdf) {
    throw new Error("PDF input is disabled by the active model Profile capability.");
  }
}

export function unsupportedOpenAIChatPdfInput(): never {
  throw new Error(
    "OpenAI Chat Completions does not support PDF attachments in Live Smith.",
  );
}

export function unsupportedInputPart(
  part: Extract<ModelInputPart, { type: "document" | "audio" }>,
): never {
  throw new Error(
    `${part.type === "document" ? "Document" : "Audio"} input is not supported by this transport milestone.`,
  );
}

export function imageDataUrl(
  part: Extract<ModelInputPart, { type: "image" }>,
): string {
  return `data:${part.mediaType};base64,${part.base64}`;
}

export function pdfDataUrl(
  part: Extract<ModelInputPart, { type: "document" }>,
): string {
  return `data:${part.mediaType};base64,${part.base64}`;
}

export function assertNeverInputPart(value: never): never {
  void value;
  throw new Error("Unsupported model input part.");
}
