import type { ModelConversationMessage, ModelInputPart } from "../contracts.js";
import { cloneJsonValue } from "../json-clone.js";
import type {
  DiscoveredModelInfo,
  ModelCapabilityHints,
  TransportRequest,
} from "../provider.js";
import type { DraftProfile } from "../profile.js";
import { withTransportContext } from "./errors.js";
import { discoverOpenAIModels } from "./openai-http.js";
import {
  assertAudioInputEnabled,
  assertImageInputEnabled,
  assertNeverInputPart,
  imageDataUrl,
  openAIChatAudioPart,
  unsupportedInputPart,
} from "./input-parts.js";

export async function listOpenAIModels(
  profile: DraftProfile,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<DiscoveredModelInfo[]> {
  return withTransportContext(profile, "model discovery", async () => {
    const response = await discoverOpenAIModels(
      profile,
      fetchImpl,
      signal,
    );
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new Error("OpenAI-compatible model discovery returned no model list.");
    }
    return response.data.flatMap((model): DiscoveredModelInfo[] => {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) return [];
      return [{
        id: model.id,
        displayName: stringMetadata(model, ["display_name", "displayName", "name"]) ?? model.id,
        capabilities: capabilitiesFromMetadata(model) ?? {},
      }];
    });
  });
}

export function buildOpenAIChatMessages(
  request: TransportRequest,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: request.systemInstructions },
    ...request.history.map((message) => message.role === "assistant"
      ? { role: "assistant", content: message.content }
      : { role: "user", content: mapOpenAIChatParts(request, message.content) }),
    {
      role: "user",
      content: mapOpenAIChatParts(request, request.currentUserContent),
    },
  ];

  for (const message of request.agentMessages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    messages.push(chatAssistantMessage(message));
  }
  return messages;
}

function mapOpenAIChatParts(
  request: TransportRequest,
  parts: readonly ModelInputPart[],
): string | Array<Record<string, unknown>> {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts.map((part): Record<string, unknown> => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        assertImageInputEnabled(request);
        return {
          type: "image_url",
          image_url: { url: imageDataUrl(part), detail: "auto" },
        };
      case "document":
        return unsupportedInputPart(part);
      case "audio":
        assertAudioInputEnabled(request);
        return openAIChatAudioPart(part);
      default:
        return assertNeverInputPart(part);
    }
  });
}

function chatAssistantMessage(
  message: Extract<ModelConversationMessage, { role: "assistant" }>,
): Record<string, unknown> {
  const state = message.providerState;
  if (
    isRecord(state) &&
    state.kind === "openai-chat" &&
    isRecord(state.message)
  ) {
    return cloneJsonValue(state.message);
  }
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls.length
      ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        }
      : {}),
  };
}

function capabilitiesFromMetadata(
  record: Record<string, unknown>,
): ModelCapabilityHints | undefined {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const inputs = inputCapabilitiesFromMetadata(record, capabilities);
  const maxOutputTokens = numberMetadata(record, [
    "max_output_tokens",
    "maxOutputTokens",
    "max_tokens",
  ]);
  const tools = capabilities && typeof capabilities.tools === "boolean"
    ? capabilities.tools
    : undefined;
  const streaming = capabilities && typeof capabilities.streaming === "boolean"
    ? capabilities.streaming
    : undefined;
  if (
    maxOutputTokens === undefined &&
    tools === undefined &&
    streaming === undefined &&
    inputs === undefined
  ) {
    return undefined;
  }
  return {
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(tools === undefined ? {} : { tools }),
    ...(streaming === undefined ? {} : { streaming }),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function inputCapabilitiesFromMetadata(
  record: Record<string, unknown>,
  capabilities: Record<string, unknown> | undefined,
): ModelCapabilityHints["inputs"] | undefined {
  const value = [
    record.input_modalities,
    record.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
  ].find(Array.isArray);
  if (!value || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  const modalities = new Set(
    value.map((item) => item.trim().toLocaleLowerCase()),
  );
  return {
    image: modalities.has("image") ||
      modalities.has("images") ||
      modalities.has("vision") ||
      modalities.has("image_url"),
    audio: modalities.has("audio"),
    pdf: modalities.has("pdf"),
  };
}

function stringMetadata(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}

function numberMetadata(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
