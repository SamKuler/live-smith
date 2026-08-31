import {
  requireModelContextUsage,
  type ModelTurn,
} from "../contracts.js";
import { ModelConnectionError } from "../connection-error.js";
import { cloneJsonValue } from "../json-clone.js";
import type {
  ModelTransport,
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
import { isDirectRuntimeModelSource } from "../provider.js";
import {
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import { mergeExtraBody } from "./request-body.js";
import { withTransportContext } from "./errors.js";
import {
  requestOpenAIJson,
  streamOpenAIEvents,
} from "./openai-http.js";
import { openAIProviderFailure } from "./openai-errors.js";
import {
  buildOpenAIChatMessages,
  listOpenAIModels,
  requireOpenAIChatAssistantMessage,
  requireOpenAIChatToolCalls,
} from "./openai-shared.js";
import {
  allModelInputParts,
  assertBinaryInputWithinLimits,
  unsupportedOpenAIChatPdfInput,
} from "./input-parts.js";

const protectedFields = [
  "model",
  "n",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "modalities",
  "audio",
] as const;

export function createOpenAIChatTransport(
  options: TransportFactoryOptions = {},
): ModelTransport {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    apiFamily: "openai",
    apiMode: "chat-completions",
    listModels: (profile, signal) => listOpenAIModels(profile, fetchImpl, signal),
    createToolTurn(request) {
      return withTransportContext(request.runtimeProfile.profile, "request", async () => {
      assertNoHostedWebSearch(request);
      assertNoPdfInput(request);
      assertBinaryInputWithinLimits(request);
      const streaming = Boolean(
        request.onDelta && request.runtimeProfile.capabilities.streaming,
      );
      const body = buildChatBody(request, streaming);
      if (streaming) {
        return streamChatTurn(request, body, fetchImpl);
      }

      const completion = await requestOpenAIJson(
        request.runtimeProfile.profile,
        fetchImpl,
        "/chat/completions",
        {
          method: "POST",
          body,
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      if (isOpenAIChatError(completion)) {
        throw openAIProviderFailure(completion, "OpenAI Chat Completions");
      }
      const choice = chatCompletionChoice(completion);
      if (!choice) {
        throw new Error("OpenAI Chat Completions returned no message.");
      }
      const finishReason = requireChatFinishReason(choice.finish_reason, false);
      const contextUsage = openAIChatContextUsage(
        completion,
        request.runtimeProfile.capabilities.contextWindowTokens,
      );
      if (finishReason === "length") {
        return outputLimitTurnFromRawMessage(
          choice.message,
          "OpenAI Chat Completions",
          contextUsage,
        );
      }
      const turn = turnFromRawMessage(
        choice.message,
        "OpenAI Chat Completions",
      );
      assertCompleteChatFinishReason(finishReason, turn.toolCalls.length);
      return {
        ...turn,
        ...(contextUsage ? { contextUsage } : {}),
      };
      }, request.signal);
    },
  };
}

function openAIChatContextUsage(
  value: unknown,
  contextWindowTokens: number | undefined,
): ModelTurn["contextUsage"] {
  if (!isRecord(value) || value.usage === undefined || value.usage === null) {
    return undefined;
  }
  if (!isRecord(value.usage) ||
    !Number.isSafeInteger(value.usage.total_tokens) ||
    (value.usage.total_tokens as number) < 0) {
    throw new TypeError("OpenAI Chat Completions context usage is invalid.");
  }
  return contextWindowTokens === undefined
    ? undefined
    : requireModelContextUsage(value.usage.total_tokens, contextWindowTokens);
}

function assertNoHostedWebSearch(request: TransportRequest): void {
  if (request.tools.some((tool) => tool.type === "hosted_web_search")) {
    throw new Error(
      "OpenAI Chat Completions does not support Live Smith hosted Web Search. Use OpenAI Responses or Anthropic Messages.",
    );
  }
}

function assertNoPdfInput(request: TransportRequest): void {
  const containsPdf = [...allModelInputParts(request)].some(
    (part) => part.type === "document",
  );
  if (containsPdf) unsupportedOpenAIChatPdfInput();
}

function buildChatBody(
  request: TransportRequest,
  streaming: boolean,
): Record<string, unknown> {
  const runtime = request.runtimeProfile;
  if (!isDirectRuntimeModelSource(runtime)) {
    throw new Error("OpenAI Chat Completions requires a Direct API Profile.");
  }
  const { model, capabilities } = runtime;
  const reasoning = model.parameters.reasoning;
  const generated: Record<string, unknown> = {
    model: model.model,
    n: 1,
    messages: buildOpenAIChatMessages(request),
    max_completion_tokens: model.parameters.maxOutputTokens,
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    ...(model.parameters.temperature !== undefined &&
    capabilities.temperature === "supported"
      ? { temperature: model.parameters.temperature }
      : {}),
    ...(request.tools.length && capabilities.tools
      ? {
          tools: request.tools.filter((tool) => tool.type === "function"),
          tool_choice: "auto",
        }
      : {}),
    ...(reasoning.mode === "disabled"
      ? { reasoning_effort: "none" }
      : reasoning.mode === "enabled" && reasoning.effort
        ? { reasoning_effort: reasoning.effort }
        : {}),
  };
  return mergeExtraBody(
    generated,
    model.advanced.extraBody,
    protectedFields,
  );
}

async function streamChatTurn(
  request: TransportRequest,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<ModelTurn> {
  const rawMessage: Record<string, unknown> = {
    content: null,
  };
  let visibleContent = "";
  let visibleContentKind: "content" | "refusal" | undefined;
  let content = "";
  let refusal = "";
  let finishReason: unknown;
  let contextUsage: ModelTurn["contextUsage"];
  const rawToolCalls = new Map<number, Record<string, unknown>>();

  for await (const chunk of streamOpenAIEvents(
    request.runtimeProfile.profile,
    fetchImpl,
    "/chat/completions",
    body,
    request.signal,
    true,
  )) {
    throwIfAborted(request.signal);
    if (isOpenAIChatError(chunk)) {
      throw openAIProviderFailure(chunk, "OpenAI Chat Completions");
    }
    const chunkUsage = openAIChatContextUsage(
      chunk,
      request.runtimeProfile.capabilities.contextWindowTokens,
    );
    if (chunkUsage) contextUsage = chunkUsage;
    const choice = streamedChatChoice(chunk);
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      if (finishReason !== undefined && finishReason !== choice.finish_reason) {
        throw new Error(
          "OpenAI Chat Completions returned conflicting finish reasons.",
        );
      }
      finishReason = choice.finish_reason;
    }
    if (choice?.delta !== undefined && !isRecord(choice.delta)) {
      throw new Error("OpenAI Chat Completions returned a malformed delta.");
    }
    const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
    if (delta) {
      if (delta.role !== undefined) {
        requireOpenAIChatAssistantMessage(delta, "OpenAI Chat Completions");
        rawMessage.role = "assistant";
      }
      assertChatDeltaText(delta, "content");
      assertChatDeltaText(delta, "refusal");
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        if (visibleContentKind && visibleContentKind !== "content") {
          visibleContent += "\n";
          await request.onDelta?.("\n");
        }
        visibleContent += delta.content;
        visibleContentKind = "content";
        rawMessage.content = content;
        await request.onDelta?.(delta.content);
      }
      if (typeof delta.refusal === "string" && delta.refusal) {
        refusal += delta.refusal;
        if (visibleContentKind && visibleContentKind !== "refusal") {
          visibleContent += "\n";
          await request.onDelta?.("\n");
        }
        visibleContent += delta.refusal;
        visibleContentKind = "refusal";
        rawMessage.refusal = refusal;
        await request.onDelta?.(delta.refusal);
      }
      accumulateUnknownDelta(rawMessage, delta);
      const calls = toolCallsArray(delta.tool_calls, "OpenAI Chat Completions");
      for (const [position, entry] of calls.entries()) {
        if (!isRecord(entry)) {
          throw new Error("OpenAI Chat Completions returned a malformed tool call.");
        }
        // Compatible streams may omit OpenAI's per-call index while preserving order.
        if (entry.index !== undefined &&
          (!Number.isSafeInteger(entry.index) || (entry.index as number) < 0)) {
          throw new Error("OpenAI Chat Completions returned an invalid tool call index.");
        }
        const index = typeof entry.index === "number" ? entry.index : position;
        rawToolCalls.set(
          index,
          mergeStreamRecord(rawToolCalls.get(index) ?? {}, entry, new Set(["index"])),
        );
      }
    }
  }

  const completedFinishReason = requireChatFinishReason(finishReason, true);
  const completedRawToolCalls = [...rawToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall);
  if (completedRawToolCalls.length) {
    rawMessage.tool_calls = completedRawToolCalls;
  }
  if (completedFinishReason === "length") {
    return outputLimitTurnFromRawMessage(
      rawMessage,
      "OpenAI Chat Completions",
      contextUsage,
    );
  }
  requireOpenAIChatAssistantMessage(rawMessage, "OpenAI Chat Completions");
  const toolCalls = requireOpenAIChatToolCalls(
    completedRawToolCalls,
    "OpenAI Chat Completions",
  );
  assertCompleteChatFinishReason(
    // Some compatible streams report stop after emitting complete tool calls.
    completedFinishReason === "stop" && toolCalls.length > 0
      ? "tool_calls"
      : completedFinishReason,
    toolCalls.length,
  );
  if (!visibleContent && !toolCalls.length) {
    throw new Error("OpenAI Chat Completions returned an empty response.");
  }
  return {
    content: visibleContent || null,
    toolCalls,
    ...(contextUsage ? { contextUsage } : {}),
    providerState: { kind: "openai-chat", message: rawMessage },
  };
}

function isOpenAIChatError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "error" || isRecord(value.error);
}

function chatCompletionChoice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  if (value.choices.length > 1) {
    throw new Error("OpenAI Chat Completions returned multiple choices.");
  }
  const choice = value.choices[0];
  return isRecord(choice) ? choice : undefined;
}

function streamedChatChoice(
  chunk: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (chunk.choices === undefined) return undefined;
  if (!Array.isArray(chunk.choices)) {
    throw new Error("OpenAI Chat Completions returned malformed choices.");
  }
  if (chunk.choices.length > 1) {
    throw new Error("OpenAI Chat Completions returned multiple choices.");
  }
  const choice = chunk.choices[0];
  if (choice !== undefined && !isRecord(choice)) {
    throw new Error("OpenAI Chat Completions returned a malformed choice.");
  }
  return choice;
}

function assertChatDeltaText(
  delta: Record<string, unknown>,
  field: "content" | "refusal",
): void {
  const value = delta[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(
      `OpenAI Chat Completions returned malformed delta ${field}.`,
    );
  }
}

function assertCompleteChatFinishReason(
  value: "stop" | "tool_calls",
  toolCallCount: number,
): void {
  if (value === "tool_calls") {
    if (toolCallCount === 0) {
      throw new Error(
        "OpenAI Chat Completions returned finish_reason tool_calls without a tool call.",
      );
    }
    return;
  }
  if (value === "stop") {
    if (toolCallCount > 0) {
      throw new Error(
        "OpenAI Chat Completions returned tool calls with finish_reason stop.",
      );
    }
    return;
  }
}

function requireChatFinishReason(
  value: unknown,
  missingIsConnectionFailure: boolean,
): "stop" | "tool_calls" | "length" {
  if (value === "stop" || value === "tool_calls" || value === "length") {
    return value;
  }
  if (value === "content_filter") {
    throw new Error(
      "OpenAI Chat Completions response was blocked by content filtering.",
    );
  }
  if (value === "function_call") {
    throw new Error(
      "OpenAI Chat Completions returned an unsupported legacy function_call finish reason.",
    );
  }
  if (typeof value === "string") {
    throw new Error(
      "OpenAI Chat Completions returned an unsupported finish_reason.",
    );
  }
  if (value === undefined || value === null) {
    const message =
      "OpenAI Chat Completions finish_reason was missing before completion.";
    if (missingIsConnectionFailure) throw new ModelConnectionError(message);
    throw new Error(message);
  }
  throw new Error(
    "OpenAI Chat Completions returned an unsupported finish_reason.",
  );
}

function turnFromRawMessage(
  value: unknown,
  label: string,
): ModelTurn {
  const message = requireOpenAIChatAssistantMessage(value, label);
  const content = chatAssistantContent(message, label);
  const toolCalls = requireOpenAIChatToolCalls(message.tool_calls, label);
  if (!content && !toolCalls.length) throw new Error(`${label} returned an empty response.`);
  return {
    content,
    toolCalls,
    providerState: {
      kind: "openai-chat",
      message: cloneJsonValue(message),
    },
  };
}

function outputLimitTurnFromRawMessage(
  value: unknown,
  label: string,
  contextUsage: ModelTurn["contextUsage"],
): ModelTurn {
  const message = requireOpenAIChatAssistantMessage(value, label);
  requireOpenAIChatToolCalls(message.tool_calls, label, {
    allowIncompleteArguments: true,
  });
  return {
    content: chatAssistantContent(message, label),
    toolCalls: [],
    continuation: { reason: "output_limit" },
    ...(contextUsage ? { contextUsage } : {}),
    providerState: {
      kind: "openai-chat",
      message: cloneJsonValue(message),
      outputLimited: true,
    },
  };
}

function chatAssistantContent(
  value: Record<string, unknown>,
  label: string,
): string | null {
  const content = optionalChatMessageText(value.content, "content", label);
  const refusal = optionalChatMessageText(value.refusal, "refusal", label);
  return content && refusal
    ? `${content}\n${refusal}`
    : content || refusal || null;
}

function optionalChatMessageText(
  value: unknown,
  field: "content" | "refusal",
  label: string,
): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error(`${label} returned malformed message ${field}.`);
  }
  return value.trim() ? value : "";
}

function toolCallsArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned tool_calls in an invalid format.`);
  }
  return value;
}

function accumulateUnknownDelta(
  message: Record<string, unknown>,
  delta: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(delta)) {
    if (
      key === "role" || key === "content" || key === "refusal" ||
      key === "tool_calls" || value === undefined
    ) {
      continue;
    }
    message[key] = key === "reasoning_details" && Array.isArray(value)
      ? mergeReasoningDetails(message[key], value)
      : mergeStreamValue(message[key], value);
  }
}

function mergeReasoningDetails(
  current: unknown,
  delta: unknown[],
): unknown[] {
  const result: unknown[] = Array.isArray(current)
    ? cloneJsonValue(current)
    : [];
  for (const entry of delta) {
    const index = reasoningDetailIndex(entry);
    if (index === undefined) {
      result.push(cloneJsonValue(entry));
      continue;
    }
    const position = result.findIndex((candidate) =>
      reasoningDetailIndex(candidate) === index
    );
    if (position >= 0 && isRecord(result[position]) && isRecord(entry)) {
      result[position] = mergeReasoningDetailRecord(result[position], entry);
    } else {
      result.push(cloneJsonValue(entry));
    }
  }
  return result.sort((left, right) => {
    const leftIndex = reasoningDetailIndex(left);
    const rightIndex = reasoningDetailIndex(right);
    if (leftIndex === undefined) return rightIndex === undefined ? 0 : 1;
    if (rightIndex === undefined) return -1;
    return leftIndex - rightIndex;
  });
}

function mergeReasoningDetailRecord(
  base: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const identityFields = new Set(["index", "type", "id", "format", "status"]);
  const result = cloneJsonValue(base);
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined) continue;
    result[key] = identityFields.has(key)
      ? cloneJsonValue(value)
      : mergeStreamValue(result[key], value);
  }
  return result;
}

function reasoningDetailIndex(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0
    ? value.index
    : undefined;
}

function mergeStreamRecord(
  base: Record<string, unknown>,
  delta: Record<string, unknown>,
  ignoredKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const result = cloneJsonValue(base);
  for (const [key, value] of Object.entries(delta)) {
    if (ignoredKeys.has(key) || value === undefined) continue;
    result[key] = mergeStreamValue(result[key], value);
  }
  return result;
}

function mergeStreamValue(current: unknown, delta: unknown): unknown {
  if (typeof current === "string" && typeof delta === "string") {
    return current + delta;
  }
  if (isRecord(current) && isRecord(delta)) {
    return mergeStreamRecord(current, delta);
  }
  if (Array.isArray(delta)) {
    return cloneJsonValue(delta);
  }
  return cloneJsonValue(delta);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
