import type { ModelToolCall, ModelTurn } from "../contracts.js";
import { cloneJsonValue } from "../json-clone.js";
import type {
  ModelTransport,
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
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
import {
  buildOpenAIChatMessages,
  listOpenAIModels,
} from "./openai-shared.js";
import {
  assertBinaryInputWithinLimits,
  unsupportedOpenAIChatPdfInput,
} from "./input-parts.js";

const protectedFields = ["model", "messages", "tools", "stream"] as const;

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
      assertNoPdfInput(request);
      assertBinaryInputWithinLimits(request);
      const body = buildChatBody(request);
      if (request.onDelta && request.runtimeProfile.capabilities.streaming) {
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
      const choice = chatCompletionChoice(completion);
      if (!choice) {
        throw new Error("OpenAI Chat Completions returned no message.");
      }
      const turn = turnFromRawMessage(
        choice.message,
        "OpenAI Chat Completions",
      );
      assertCompleteChatFinishReason(choice.finish_reason, turn.toolCalls.length);
      return turn;
      });
    },
  };
}

function assertNoPdfInput(request: TransportRequest): void {
  const containsPdf = request.currentUserContent.some((part) =>
    part.type === "document"
  ) || request.history.some((message) =>
    message.role === "user" &&
    message.content.some((part) => part.type === "document")
  );
  if (containsPdf) unsupportedOpenAIChatPdfInput();
}

function buildChatBody(
  request: TransportRequest,
): Record<string, unknown> {
  const { profile, capabilities } = request.runtimeProfile;
  const reasoning = profile.parameters.reasoning;
  const generated: Record<string, unknown> = {
    model: profile.model,
    messages: buildOpenAIChatMessages(request),
    max_completion_tokens: profile.parameters.maxOutputTokens,
    ...(profile.parameters.temperature !== undefined &&
    capabilities.temperature === "supported"
      ? { temperature: profile.parameters.temperature }
      : {}),
    ...(request.tools.length && capabilities.tools
      ? { tools: request.tools, tool_choice: "auto" }
      : {}),
    ...(reasoning.mode === "disabled"
      ? { reasoning_effort: "none" }
      : reasoning.mode === "enabled" && reasoning.effort
        ? { reasoning_effort: reasoning.effort }
        : {}),
  };
  return mergeExtraBody(
    generated,
    profile.advanced.extraBody,
    protectedFields,
  );
}

async function streamChatTurn(
  request: TransportRequest,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<ModelTurn> {
  const rawMessage: Record<string, unknown> = {
    role: "assistant",
    content: null,
  };
  let content = "";
  let finishReason: unknown;
  const rawToolCalls = new Map<number, Record<string, unknown>>();

  for await (const chunk of streamOpenAIEvents(
    request.runtimeProfile.profile,
    fetchImpl,
    "/chat/completions",
    body,
    request.signal,
  )) {
    throwIfAborted(request.signal);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }
    const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      rawMessage.content = content;
      await request.onDelta?.(delta.content);
    }
    accumulateUnknownDelta(rawMessage, delta);
    const calls = toolCallsArray(delta.tool_calls, "OpenAI Chat Completions");
    for (const entry of calls) {
      if (!isRecord(entry)) {
        throw new Error("OpenAI Chat Completions returned a malformed tool call.");
      }
      const index = typeof entry.index === "number" ? entry.index : 0;
      rawToolCalls.set(
        index,
        mergeStreamRecord(rawToolCalls.get(index) ?? {}, entry, new Set(["index"])),
      );
    }
  }

  const completedRawToolCalls = [...rawToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall);
  const toolCalls = normalizedToolCalls(
    completedRawToolCalls,
    "OpenAI Chat Completions",
  );
  assertCompleteChatFinishReason(finishReason, toolCalls.length);
  if (completedRawToolCalls.length) {
    rawMessage.tool_calls = completedRawToolCalls;
  }
  if (!content && !toolCalls.length) {
    throw new Error("OpenAI Chat Completions returned an empty response.");
  }
  return {
    content: content || null,
    toolCalls,
    providerState: { kind: "openai-chat", message: rawMessage },
  };
}

function chatCompletionChoice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const choice = value.choices[0];
  return isRecord(choice) ? choice : undefined;
}

function assertCompleteChatFinishReason(
  value: unknown,
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
  if (typeof value === "string") {
    throw new Error(
      `OpenAI Chat Completions stopped with finish_reason ${value}.`,
    );
  }
  throw new Error(
    "OpenAI Chat Completions finish_reason was missing before completion.",
  );
}

function turnFromRawMessage(
  value: unknown,
  label: string,
): ModelTurn {
  if (!isRecord(value)) throw new Error(`${label} returned no message.`);
  const content = typeof value.content === "string" && value.content.trim()
    ? value.content
    : null;
  const rawCalls = toolCallsArray(value.tool_calls, label);
  const toolCalls = normalizedToolCalls(rawCalls, label);
  if (!content && !toolCalls.length) throw new Error(`${label} returned an empty response.`);
  return {
    content,
    toolCalls,
    providerState: {
      kind: "openai-chat",
      message: cloneJsonValue(value),
    },
  };
}

function toolCallsArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned tool_calls in an invalid format.`);
  }
  return value;
}

function normalizedToolCalls(
  rawCalls: unknown[],
  label: string,
): ModelToolCall[] {
  const seenIds = new Set<string>();
  return rawCalls.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(`${label} returned a malformed tool call.`);
    }
    if (entry.type !== "function") {
      throw new Error(`${label} returned a tool call with invalid type.`);
    }
    const id = requireUniqueToolCallId(entry.id, seenIds, label);
    const fn = isRecord(entry.function) ? entry.function : undefined;
    if (typeof fn?.name !== "string" || !fn.name.trim()) {
      throw new Error(`${label} returned a tool call with a missing or empty name.`);
    }
    if (typeof fn.arguments !== "string" || !fn.arguments.trim()) {
      throw new Error(`${label} returned a tool call with invalid arguments.`);
    }
    return {
      id,
      name: fn.name,
      arguments: fn.arguments,
    };
  });
}

function requireUniqueToolCallId(
  value: unknown,
  seen: Set<string>,
  label: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} returned a tool call ID that was missing or empty.`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} returned duplicate tool call ID ${value}.`);
  }
  seen.add(value);
  return value;
}

function accumulateUnknownDelta(
  message: Record<string, unknown>,
  delta: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(delta)) {
    if (key === "role" || key === "content" || key === "tool_calls" || value === undefined) {
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
