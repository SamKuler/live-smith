import type { ModelInputPart } from "./contracts.js";
import type { ModelConnection } from "./profile.js";
import type { ProviderReportedModelMetadata } from "./provider.js";

export type BinaryInputCapability = "image" | "audio" | "pdf";

type BinaryInputPart = Extract<
  ModelInputPart,
  { type: "image" | "document" | "audio" }
>;

type MediaTypeFor<Kind extends BinaryInputCapability> = Extract<
  BinaryInputPart,
  { type: Kind extends "pdf" ? "document" : Kind }
>["mediaType"];

export const modelInputMediaTypes = {
  image: ["image/png", "image/jpeg", "image/webp"],
  audio: ["audio/wav", "audio/mpeg"],
  pdf: ["application/pdf"],
} as const satisfies {
  [Kind in BinaryInputCapability]: readonly MediaTypeFor<Kind>[];
};

export interface InputTransportSupport {
  image: boolean;
  audio: boolean;
  pdf: boolean;
}

export const openAIResponsesInputSupport: InputTransportSupport = {
  image: true,
  audio: false,
  pdf: true,
};

export const openAIChatInputSupport: InputTransportSupport = {
  image: true,
  audio: true,
  pdf: false,
};

export const anthropicMessagesInputSupport: InputTransportSupport = {
  image: true,
  audio: false,
  pdf: true,
};

export const googleAntigravityInputSupport: InputTransportSupport = {
  image: true,
  audio: true,
  pdf: true,
};

export function inputTransportSupport(
  connection: ModelConnection,
): InputTransportSupport {
  if (connection.kind === "oauth-subscription") {
    if (connection.provider === "google") return googleAntigravityInputSupport;
    return connection.provider === "openai"
      ? openAIResponsesInputSupport
      : anthropicMessagesInputSupport;
  }
  if (connection.apiFamily === "anthropic") {
    return anthropicMessagesInputSupport;
  }
  return connection.apiMode === "chat-completions"
    ? openAIChatInputSupport
    : openAIResponsesInputSupport;
}

export function isModelInputMediaType(
  kind: BinaryInputCapability,
  mediaType: string,
): boolean {
  return (modelInputMediaTypes[kind] as readonly string[]).includes(mediaType);
}

export function providerSupportsMimeType(
  supportedMimeTypes: Readonly<Record<string, boolean>>,
  mimeType: string,
): boolean {
  if (supportedMimeTypes[mimeType] !== undefined) {
    return supportedMimeTypes[mimeType] === true;
  }
  const slash = mimeType.indexOf("/");
  const wildcard = slash < 0 ? "" : `${mimeType.slice(0, slash)}/*`;
  if (wildcard && supportedMimeTypes[wildcard] !== undefined) {
    return supportedMimeTypes[wildcard] === true;
  }
  return supportedMimeTypes["*/*"] === true;
}

export function providerCoversModelInput(
  supportedMimeTypes: Readonly<Record<string, boolean>>,
  kind: BinaryInputCapability,
): boolean {
  return modelInputMediaTypes[kind].every((mediaType) =>
    providerSupportsMimeType(supportedMimeTypes, mediaType)
  );
}

/**
 * Projects raw provider input evidence into capabilities the selected wire
 * protocol can actually encode. Broad positive flags remain raw evidence;
 * image/audio require coverage for every concrete format Live Smith emits.
 */
export function mimeBackedInputCapabilities(
  reported: ProviderReportedModelMetadata["inputs"],
  transport: InputTransportSupport,
): Partial<InputTransportSupport> | undefined {
  if (!reported) return undefined;
  const mimeTypes = reported.supportedMimeTypes;
  const providerSupport = {
    image: reported.supportsImages === false
      ? false
      : mimeTypes
        ? providerCoversModelInput(mimeTypes, "image")
        : undefined,
    audio: mimeTypes
      ? providerCoversModelInput(mimeTypes, "audio")
      : undefined,
    pdf: reported.supportsPdf === false
      ? false
      : mimeTypes
        ? providerCoversModelInput(mimeTypes, "pdf")
        : reported.supportsPdf,
  };
  const modalities = new Set(reported.inputModalities ?? []);
  const positiveCoarseEvidence = {
    image: reported.supportsImages === true ||
      modalities.has("image") || modalities.has("images") ||
      modalities.has("vision") || modalities.has("image_url"),
    audio: modalities.has("audio"),
    pdf: reported.supportsPdf === true || modalities.has("pdf"),
  };
  const result: Partial<InputTransportSupport> = {};
  for (const kind of ["image", "audio", "pdf"] as const) {
    const supported = providerSupport[kind];
    if (supported !== undefined) {
      result[kind] = supported && transport[kind];
    } else if (positiveCoarseEvidence[kind] && !transport[kind]) {
      result[kind] = false;
    }
  }
  return Object.keys(result).length ? result : undefined;
}
