import type { ModelInputPart } from "../contracts.js";
import type { TransportRequest } from "../provider.js";

export function assertImageInputEnabled(request: TransportRequest): void {
  if (!request.runtimeProfile.capabilities.inputs.image) {
    throw new Error("Image input is disabled by the active model Profile capability.");
  }
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

export function assertNeverInputPart(value: never): never {
  void value;
  throw new Error("Unsupported model input part.");
}
