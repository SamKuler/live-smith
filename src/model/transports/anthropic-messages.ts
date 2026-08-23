import type {
  ModelConversationMessage,
  ModelHostedWebSearch,
  ModelInputPart,
  ModelToolCall,
  ModelTurn,
} from "../contracts.js";
import { ModelConnectionError } from "../connection-error.js";
import { normalizeModelCitations } from "../citations.js";
import {
  decodeDiscoveredModelCatalog,
  isDiscoveredModelId,
  MAX_DISCOVERED_MODEL_COUNT,
  MAX_MODEL_DISCOVERY_PAGE_COUNT,
} from "../catalog.js";
import {
  HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND,
  isHostedWebSearchRequestMaxUses,
} from "../tools.js";
import {
  normalizeModelHostedWebSearch,
  safeModelWebSearchId,
} from "../web-search.js";
import { cloneJsonValue } from "../json-clone.js";
import type {
  DiscoveredModelInfo,
  ModelCapabilityHints,
  ModelTransport,
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
import {
  isDirectApiProfile,
  type DraftProfile,
} from "../profile.js";
import {
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import {
  requestAnthropicJson,
  requestAnthropicModelPage,
  streamAnthropicEvents,
} from "./anthropic-http.js";
import { mergeExtraBody } from "./request-body.js";
import { withTransportContext } from "./errors.js";
import {
  assertBinaryInputWithinLimits,
  assertImageInputEnabled,
  assertNoUnsupportedAudioInput,
  assertPdfInputEnabled,
  assertNeverInputPart,
  unsupportedInputPart,
} from "./input-parts.js";

const protectedFields = [
  "model",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "stream",
] as const;
const maxPauseTurnContinuations = 3;

type AnthropicContentBlock = Record<string, unknown>;

interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolResultBlock {
  [key: string]: unknown;
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicTool =
  | {
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }
  | {
      type: "web_search_20250305";
      name: "web_search";
      max_uses: number;
    };

export function createAnthropicMessagesTransport(
  options: TransportFactoryOptions = {},
): ModelTransport {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    apiFamily: "anthropic",
    apiMode: "messages",
    listModels: (profile, signal) => withTransportContext(
      profile,
      "model discovery",
      () => listAnthropicModels(profile, fetchImpl, signal),
      signal,
    ),
    createToolTurn(request) {
      return withTransportContext(request.runtimeProfile.profile, "request", async () => {
      assertNoUnsupportedAudioInput(request, "Anthropic Messages");
      assertBinaryInputWithinLimits(request);
      return anthropicTurnWithContinuations(
        request,
        buildAnthropicBody(request),
        fetchImpl,
      );
      }, request.signal);
    },
  };
}

async function anthropicTurnWithContinuations(
  request: TransportRequest,
  initialBody: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<ModelTurn> {
  const continuationContent: AnthropicContentBlock[][] = [];
  const initialSearchCalls = unresolvedAnthropicWebSearchCallsFromAgentMessages(
    request.agentMessages,
  );
  const reportedWebSearches = new Map<string, string>();
  const reportWebSearch = async (search: ModelHostedWebSearch) => {
    if (
      !reportedWebSearches.has(search.id) &&
      reportedWebSearches.size >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND
    ) {
      return;
    }
    const signature = JSON.stringify(search);
    if (reportedWebSearches.get(search.id) === signature) return;
    reportedWebSearches.set(search.id, signature);
    await request.onHostedWebSearch?.(search);
  };
  for (let continuation = 0; continuation <= maxPauseTurnContinuations; continuation += 1) {
    throwIfAborted(request.signal);
    const body = bodyWithAnthropicContinuations(initialBody, continuationContent);
    const priorSearchCalls = unresolvedAnthropicWebSearchCalls(
      continuationContent.flat(),
      initialSearchCalls,
    );
    const response = request.onDelta && request.runtimeProfile.capabilities.streaming
      ? await streamAnthropicMessage(
          request,
          body,
          fetchImpl,
          priorSearchCalls,
          reportWebSearch,
        )
      : await requestAnthropicJson(
          request.runtimeProfile.profile,
          fetchImpl,
          "/messages",
          {
            method: "POST",
            body,
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );
    if (!isRecord(response) || !Array.isArray(response.content)) {
      throw new Error("Anthropic Messages returned no content blocks.");
    }
    for (const search of completedAnthropicWebSearches(
      response.content as AnthropicContentBlock[],
      priorSearchCalls,
    )) {
      await reportWebSearch(search);
    }
    if (response.stop_reason !== "pause_turn") {
      const turn = turnFromAnthropicMessage(response, priorSearchCalls);
      if (!continuationContent.length) return turn;
      const priorCitations = continuationContent.flatMap(
        (content) => citationsFromAnthropicContent(content),
      );
      const priorText = continuationContent
        .map(textFromAnthropicContent)
        .filter(Boolean)
        .join("\n\n");
      const combinedText = [priorText, turn.content ?? ""]
        .filter(Boolean)
        .join("\n\n");
      const citations = normalizeModelCitations([
        ...priorCitations,
        ...(turn.citations ?? []),
      ]);
      const hostedWebSearches = completedAnthropicWebSearches([
        ...continuationContent.flat(),
        ...(response.content as AnthropicContentBlock[]),
      ], initialSearchCalls);
      return {
        ...turn,
        content: combinedText || null,
        ...(citations.length ? { citations } : {}),
        ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
        providerState: {
          kind: "anthropic-messages",
          content: cloneJsonValue(response.content),
          continuationContent: cloneJsonValue(continuationContent),
        },
      };
    }
    if (continuation === maxPauseTurnContinuations) {
      throw new Error(
        `Anthropic Messages exceeded ${maxPauseTurnContinuations} pause_turn continuations.`,
      );
    }
    continuationContent.push(cloneJsonValue(
      response.content as AnthropicContentBlock[],
    ));
  }
  throw new Error("Anthropic Messages continuation limit was reached.");
}

function bodyWithAnthropicContinuations(
  initialBody: Record<string, unknown>,
  continuationContent: readonly AnthropicContentBlock[][],
): Record<string, unknown> {
  if (!continuationContent.length) return initialBody;
  if (!Array.isArray(initialBody.messages)) {
    throw new Error("Anthropic Messages request body has invalid messages.");
  }
  return {
    ...initialBody,
    messages: [
      ...cloneJsonValue(initialBody.messages),
      ...continuationContent.map((content) => ({
        role: "assistant",
        content: cloneJsonValue(content),
      })),
    ],
  };
}

function buildAnthropicBody(
  request: TransportRequest,
): Record<string, unknown> {
  const profile = request.runtimeProfile.profile;
  if (!isDirectApiProfile(profile)) {
    throw new Error("Anthropic Messages requires a Direct API Profile.");
  }
  const reasoning = profile.parameters.reasoning;
  const thinking = anthropicThinking(request);
  const tools = mappedAnthropicTools(request);
  const generated: Record<string, unknown> = {
    model: profile.model,
    max_tokens: profile.parameters.maxOutputTokens,
    system: request.systemInstructions,
    messages: buildAnthropicMessages(request),
    ...(profile.parameters.temperature !== undefined && !thinkingEnabled(thinking)
      ? { temperature: profile.parameters.temperature }
      : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: { type: "auto" },
        }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(reasoning.mode === "enabled" &&
    reasoning.effort &&
    request.runtimeProfile.capabilities.reasoning.efforts.includes(reasoning.effort)
      ? { output_config: { effort: reasoning.effort } }
      : {}),
  };
  return mergeExtraBody(
    generated,
    request.runtimeProfile.profile.advanced.extraBody,
    protectedFields,
  );
}

function buildAnthropicMessages(
  request: TransportRequest,
): AnthropicMessageParam[] {
  const messages: AnthropicMessageParam[] = [
    ...request.history.map((message) => ({
      role: message.role,
      content: message.role === "assistant"
        ? message.content
        : mapAnthropicInputParts(request, message.content),
    })),
    {
      role: "user",
      content: mapAnthropicInputParts(request, request.currentUserContent),
    },
  ];

  for (let index = 0; index < request.agentMessages.length;) {
    const message = request.agentMessages[index]!;
    if (message.role === "tool") {
      const results: AnthropicToolResultBlock[] = [];
      while (index < request.agentMessages.length) {
        const tool = request.agentMessages[index]!;
        if (tool.role !== "tool") break;
        results.push({
          type: "tool_result",
          tool_use_id: tool.toolCallId,
          content: tool.content,
        });
        index += 1;
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    if (message.role === "user") {
      appendAnthropicUserContent(
        messages,
        [{ type: "text", text: message.content }],
      );
      index += 1;
      continue;
    }

    const stateMessages = anthropicStateMessages(message);
    const content = stateMessages?.at(-1) ?? [
      ...(message.content?.trim()
        ? [{ type: "text" as const, text: message.content }]
        : []),
      ...message.toolCalls.map((toolCall) => ({
        type: "tool_use" as const,
        id: toolCall.id,
        name: toolCall.name,
        input: safeToolInput(toolCall.arguments),
      })),
    ];
    if (stateMessages) {
      for (const stateContent of stateMessages) {
        messages.push({ role: "assistant", content: stateContent });
      }
    } else {
      messages.push({ role: "assistant", content });
    }
    index += 1;
  }
  return messages;
}

function appendAnthropicUserContent(
  messages: AnthropicMessageParam[],
  content: AnthropicContentBlock[],
): void {
  const previous = messages.at(-1);
  if (previous?.role === "user" && Array.isArray(previous.content)) {
    previous.content.push(...content);
    return;
  }
  messages.push({ role: "user", content });
}

function mapAnthropicInputParts(
  request: TransportRequest,
  parts: readonly ModelInputPart[],
): AnthropicContentBlock[] {
  return parts.map((part): AnthropicContentBlock => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        assertImageInputEnabled(request);
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.base64,
          },
        };
      case "document":
        assertPdfInputEnabled(request);
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.base64,
          },
          title: part.fileName,
        };
      case "audio":
        return unsupportedInputPart(part);
      default:
        return assertNeverInputPart(part);
    }
  });
}

async function listAnthropicModels(
  profile: DraftProfile,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<DiscoveredModelInfo[]> {
  const models: DiscoveredModelInfo[] = [];
  const seenCursors = new Set<string>();
  let discoveredEntries = 0;
  let afterId: string | undefined;
  for (let page = 0; page < MAX_MODEL_DISCOVERY_PAGE_COUNT; page += 1) {
    const response = await requestAnthropicModelPage(
      profile,
      fetchImpl,
      {
        limit: "1000",
        ...(afterId ? { after_id: afterId } : {}),
      },
      signal,
    );
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new Error("Anthropic model discovery returned no model list.");
    }
    discoveredEntries += response.data.length;
    if (discoveredEntries > MAX_DISCOVERED_MODEL_COUNT) {
      throw new Error("Anthropic model discovery returned too many models.");
    }
    const pageModels: DiscoveredModelInfo[] = [];
    for (const model of response.data) {
      if (!isRecord(model) || !isDiscoveredModelId(model.id)) {
        throw new Error(
          "Anthropic model discovery returned an invalid model entry.",
        );
      }
      pageModels.push({
        id: model.id,
        displayName: typeof model.display_name === "string"
          ? model.display_name
          : model.id,
        capabilities: anthropicCapabilitiesFromMetadata(model),
      });
    }
    models.push(...pageModels);
    if (response.has_more !== true) {
      const catalog = decodeDiscoveredModelCatalog(models);
      if (!catalog) {
        throw new Error(
          "Anthropic model discovery returned an invalid or oversized catalog.",
        );
      }
      return catalog;
    }
    const nextCursor = response.last_id;
    if (
      typeof nextCursor !== "string" ||
      !nextCursor ||
      seenCursors.has(nextCursor)
    ) {
      throw new Error("Anthropic model discovery returned an invalid pagination cursor.");
    }
    seenCursors.add(nextCursor);
    afterId = nextCursor;
  }
  throw new Error("Anthropic model discovery exceeded its page limit.");
}

function anthropicCapabilitiesFromMetadata(
  record: Record<string, unknown>,
): ModelCapabilityHints {
  const maxOutputTokens = firstNumber(record, ["max_tokens", "max_output_tokens"]);
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const inputs = anthropicInputCapabilities(record, capabilities);
  const thinking = capabilities && isRecord(capabilities.thinking)
    ? capabilities.thinking
    : undefined;
  const effort = capabilities && isRecord(capabilities.effort)
    ? capabilities.effort
    : undefined;
  const thinkingSupported = supportStatus(thinking);
  const effortSupported = supportStatus(effort);
  const adaptive = nestedSupportStatus(thinking, "types", "adaptive");
  const budget = nestedSupportStatus(thinking, "types", "enabled");
  const canDisable = nestedSupportStatus(thinking, "types", "disabled");
  const efforts = (["low", "medium", "high", "xhigh", "max"] as const)
    .filter((level) => supportValue(effort?.[level]));
  const supportStates = [thinkingSupported, effortSupported]
    .filter((value): value is boolean => value !== undefined);
  const reasoningSupported = supportStates.includes(true)
    ? true
    : supportStates.length && supportStates.every((value) => !value)
      ? false
      : undefined;
  const strategy = adaptive === true
    ? "adaptive-thinking" as const
    : budget === true
      ? "budget-thinking" as const
      : adaptive === undefined && budget === undefined && effortSupported === true
        ? "effort" as const
      : adaptive === false && budget === false
        ? effortSupported === true
          ? "effort" as const
          : "none" as const
        : undefined;
  const reasoning = reasoningSupported === false
    ? {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none" as const,
      }
    : {
        ...(reasoningSupported === undefined
          ? {}
          : { supported: reasoningSupported }),
        ...(canDisable === undefined ? {} : { canDisable }),
        ...(effortSupported === undefined ? {} : { efforts }),
        ...(budget === undefined ? {} : { budgetTokens: budget }),
        ...(strategy === undefined ? {} : { strategy }),
      };
  const hasReasoningHints = Object.keys(reasoning).length > 0;

  return {
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(hasReasoningHints ? { reasoning } : {}),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function anthropicInputCapabilities(
  record: Record<string, unknown>,
  capabilities: Record<string, unknown> | undefined,
): ModelCapabilityHints["inputs"] | undefined {
  const image = supportStatus(capabilities?.image_input);
  const pdf = supportStatus(capabilities?.pdf_input);
  const value = [
    record.input_modalities,
    record.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
  ].find(Array.isArray);
  const compatible = value && value.every((item) => typeof item === "string")
    ? inputCapabilitiesFromModalities(value)
    : undefined;
  if (image === undefined && pdf === undefined) return compatible;
  return {
    ...compatible,
    ...(image === undefined ? {} : { image }),
    ...(pdf === undefined ? {} : { pdf }),
  };
}

function inputCapabilitiesFromModalities(
  value: string[],
): ModelCapabilityHints["inputs"] {
  const modalities = new Set(value.map((item) => item.trim().toLocaleLowerCase()));
  return {
    image: modalities.has("image") || modalities.has("images") || modalities.has("vision"),
    audio: modalities.has("audio"),
    pdf: modalities.has("pdf"),
  };
}

function nestedSupportStatus(
  record: Record<string, unknown> | undefined,
  parent: string,
  child: string,
): boolean | undefined {
  const nested = record && isRecord(record[parent]) ? record[parent] : undefined;
  return supportStatus(nested?.[child]);
}

function supportStatus(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.supported === "boolean"
    ? value.supported
    : undefined;
}

function supportValue(value: unknown): boolean {
  return supportStatus(value) === true;
}

async function streamAnthropicMessage(
  request: TransportRequest,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  priorSearchCalls: ReadonlyMap<string, AnthropicContentBlock>,
  reportWebSearch: (search: ModelHostedWebSearch) => Promise<void>,
): Promise<Record<string, unknown>> {
  const contentBlocks = new Map<number, AnthropicContentBlock>();
  const inputJson = new Map<number, string>();
  const seenWebSearchResultIds = new Set<string>();
  let stopped = false;
  let stopReason: unknown;
  for await (const event of streamAnthropicEvents(
    request.runtimeProfile.profile,
    fetchImpl,
    body,
    request.signal,
  )) {
    throwIfAborted(request.signal);
    if (event.type === "message_start" && isRecord(event.message)) {
      const initial = event.message.content;
      if (Array.isArray(initial)) {
        initial.forEach((block, index) => {
          if (isRecord(block)) contentBlocks.set(index, cloneJsonValue(block));
        });
      }
      continue;
    }
    if (event.type === "content_block_start") {
      const index = eventIndex(event);
      if (index !== undefined && isRecord(event.content_block)) {
        contentBlocks.set(index, cloneJsonValue(event.content_block));
        if (
          event.content_block.type === "web_search_tool_result" &&
          typeof event.content_block.tool_use_id === "string" &&
          isAnthropicWebSearchResultContent(event.content_block.content)
        ) {
          if (seenWebSearchResultIds.has(event.content_block.tool_use_id)) {
            throw duplicateAnthropicWebSearchResultError();
          }
          seenWebSearchResultIds.add(event.content_block.tool_use_id);
          const search = anthropicWebSearchFromResult(
            event.content_block,
            [...contentBlocks.values()],
            index,
            priorSearchCalls,
          );
          if (search) {
            await reportWebSearch(search);
          }
        }
      }
      continue;
    }
    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      const index = eventIndex(event);
      if (index === undefined) continue;
      const block = contentBlocks.get(index);
      if (!block) {
        throw new Error(`Anthropic stream sent a delta before block ${index} started.`);
      }
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        appendBlockText(block, "text", event.delta.text);
        await request.onDelta?.(event.delta.text);
      } else if (
        event.delta.type === "thinking_delta" &&
        typeof event.delta.thinking === "string"
      ) {
        appendBlockText(block, "thinking", event.delta.thinking);
      } else if (
        event.delta.type === "signature_delta" &&
        typeof event.delta.signature === "string"
      ) {
        appendBlockText(block, "signature", event.delta.signature);
      } else if (
        event.delta.type === "input_json_delta" &&
        typeof event.delta.partial_json === "string"
      ) {
        inputJson.set(index, (inputJson.get(index) ?? "") + event.delta.partial_json);
      } else if (
        event.delta.type === "citations_delta" &&
        isRecord(event.delta.citation)
      ) {
        const citations = Array.isArray(block.citations) ? block.citations : [];
        citations.push(cloneJsonValue(event.delta.citation));
        block.citations = citations;
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const index = eventIndex(event);
      if (index !== undefined) finalizeToolInput(index, contentBlocks, inputJson);
      continue;
    }
    if (event.type === "error") {
      throw anthropicStreamError();
    }
    if (event.type === "message_delta" && isRecord(event.delta)) {
      if (event.delta.stop_reason !== undefined) {
        stopReason = event.delta.stop_reason;
      }
      continue;
    }
    if (event.type === "message_stop") {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    throw new ModelConnectionError("Anthropic stream ended before message_stop.");
  }
  for (const index of inputJson.keys()) {
    finalizeToolInput(index, contentBlocks, inputJson);
  }
  const content = [...contentBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  return { content, stop_reason: stopReason };
}

function turnFromAnthropicMessage(
  value: unknown,
  priorSearchCalls: ReadonlyMap<string, AnthropicContentBlock> = new Map(),
): ModelTurn {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Anthropic Messages returned no content blocks.");
  }
  const contentBlocks = value.content as Array<Record<string, unknown>>;
  const text = textFromAnthropicContent(contentBlocks);
  const seenToolCallIds = new Set<string>();
  const toolCalls = contentBlocks.flatMap((block): ModelToolCall[] => {
    if (block.type !== "tool_use") return [];
    const id = requireUniqueToolCallId(block.id, seenToolCallIds);
    if (typeof block.name !== "string" || !block.name.trim()) {
      throw new Error(
        "Anthropic Messages returned a tool_use with a missing or empty name.",
      );
    }
    if (!isRecord(block.input)) {
      throw new Error("Anthropic Messages returned a tool_use with invalid input.");
    }
    return [{
      id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    }];
  });
  const citations = citationsFromAnthropicContent(contentBlocks);
  const hostedWebSearches = completedAnthropicWebSearches(
    contentBlocks,
    priorSearchCalls,
  );
  assertCompleteAnthropicStopReason(value.stop_reason, toolCalls.length);
  if (!text && !toolCalls.length) {
    throw new Error("Anthropic Messages returned an empty response.");
  }
  return {
    content: text || null,
    toolCalls,
    ...(citations.length ? { citations } : {}),
    ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
    providerState: {
      kind: "anthropic-messages",
      content: cloneJsonValue(contentBlocks),
    },
  };
}

function completedAnthropicWebSearches(
  contentBlocks: readonly Record<string, unknown>[],
  priorSearchCalls: ReadonlyMap<string, AnthropicContentBlock> = new Map(),
): ModelHostedWebSearch[] {
  const searchCalls = new Map(priorSearchCalls);
  for (const block of contentBlocks) {
    if (
      block.type === "server_tool_use" &&
      block.name === "web_search" &&
      typeof block.id === "string" &&
      block.id
    ) searchCalls.set(block.id, block);
  }
  const searches: ModelHostedWebSearch[] = [];
  const seenResultIds = new Set<string>();
  for (const block of contentBlocks) {
    if (
      block.type !== "web_search_tool_result" ||
      typeof block.tool_use_id !== "string" ||
      !isAnthropicWebSearchResultContent(block.content) ||
      !searchCalls.has(block.tool_use_id)
    ) continue;
    if (searches.length >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND) break;
    if (seenResultIds.has(block.tool_use_id)) {
      throw duplicateAnthropicWebSearchResultError();
    }
    seenResultIds.add(block.tool_use_id);
    const search = anthropicWebSearchFromResult(
      block,
      [],
      searches.length,
      searchCalls,
    );
    if (search) searches.push(search);
  }
  return searches;
}

function duplicateAnthropicWebSearchResultError(): Error {
  return new Error(
    "Anthropic Messages returned a duplicate Web Search result for one tool call.",
  );
}

function anthropicWebSearchFromResult(
  result: Record<string, unknown>,
  contentBlocks: readonly Record<string, unknown>[],
  index: number,
  priorSearchCalls: ReadonlyMap<string, AnthropicContentBlock> = new Map(),
): ModelHostedWebSearch | undefined {
  if (
    result.type !== "web_search_tool_result" ||
    typeof result.tool_use_id !== "string" ||
    !isAnthropicWebSearchResultContent(result.content)
  ) return undefined;
  const call = contentBlocks.find((block) =>
    block.type === "server_tool_use" &&
    block.name === "web_search" &&
    block.id === result.tool_use_id
  ) ?? priorSearchCalls.get(result.tool_use_id);
  if (!call) return undefined;
  const input = call && isRecord(call.input) ? call.input : undefined;
  const sources = Array.isArray(result.content)
    ? result.content.filter((candidate) =>
        isRecord(candidate) && candidate.type === "web_search_result"
      )
    : [];
  return normalizeModelHostedWebSearch({
    id: safeModelWebSearchId(result.tool_use_id, `anthropic-search-${index + 1}`),
    status: Array.isArray(result.content) ? "completed" : "failed",
    action: "search",
    queries: typeof input?.query === "string" ? [input.query] : [],
    sources,
  });
}

function isAnthropicWebSearchResultContent(value: unknown): boolean {
  return Array.isArray(value) || (
    isRecord(value) && value.type === "web_search_tool_result_error"
  );
}

function unresolvedAnthropicWebSearchCallsFromAgentMessages(
  messages: readonly ModelConversationMessage[],
): Map<string, AnthropicContentBlock> {
  const contentBlocks = messages.flatMap((message) =>
    message.role === "assistant"
      ? anthropicStateMessages(message)?.flat() ?? []
      : []
  );
  return unresolvedAnthropicWebSearchCalls(contentBlocks);
}

function unresolvedAnthropicWebSearchCalls(
  contentBlocks: readonly AnthropicContentBlock[],
  initial: ReadonlyMap<string, AnthropicContentBlock> = new Map(),
): Map<string, AnthropicContentBlock> {
  const unresolved = new Map(initial);
  for (const block of contentBlocks) {
    if (
      block.type === "server_tool_use" &&
      block.name === "web_search" &&
      typeof block.id === "string" &&
      block.id
    ) {
      unresolved.set(block.id, block);
    } else if (
      block.type === "web_search_tool_result" &&
      typeof block.tool_use_id === "string"
    ) {
      unresolved.delete(block.tool_use_id);
    }
  }
  return unresolved;
}

function textFromAnthropicContent(
  contentBlocks: readonly Record<string, unknown>[],
): string {
  return contentBlocks
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : []
    )
    .join("\n\n")
    .trim();
}

function requireUniqueToolCallId(value: unknown, seen: Set<string>): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Anthropic Messages returned a tool call ID that was missing or empty.");
  }
  if (seen.has(value)) {
    throw new Error(`Anthropic Messages returned duplicate tool call ID ${value}.`);
  }
  seen.add(value);
  return value;
}

function assertCompleteAnthropicStopReason(
  value: unknown,
  toolCallCount: number,
): void {
  if (value === "tool_use") {
    if (toolCallCount === 0) {
      throw new Error(
        "Anthropic Messages returned stop_reason tool_use without a tool_use block.",
      );
    }
    return;
  }
  if (value === "end_turn" || value === "stop_sequence") {
    if (toolCallCount > 0) {
      throw new Error(
        `Anthropic Messages returned tool_use blocks with stop_reason ${value}.`,
      );
    }
    return;
  }
  if (typeof value === "string") {
    throw new Error(`Anthropic Messages stopped with stop_reason ${value}.`);
  }
  throw new Error(
    "Anthropic Messages stop_reason was missing before completion.",
  );
}

function anthropicThinking(
  request: TransportRequest,
): Record<string, unknown> | undefined {
  const profile = request.runtimeProfile.profile;
  if (!isDirectApiProfile(profile)) {
    throw new Error("Anthropic Messages requires a Direct API Profile.");
  }
  const reasoning = profile.parameters.reasoning;
  if (reasoning.mode === "default") return undefined;
  if (reasoning.mode === "disabled") return { type: "disabled" };
  const strategy = request.runtimeProfile.capabilities.reasoning.strategy;
  if (strategy === "adaptive-thinking") return { type: "adaptive" };
  if (strategy === "budget-thinking") {
    const max = profile.parameters.maxOutputTokens;
    const budget = reasoning.budgetTokens ?? Math.floor(max / 2);
    if (budget < 1024 || budget >= max) {
      throw new Error("Thinking budget must be at least 1024 and below max output tokens.");
    }
    return { type: "enabled", budget_tokens: budget };
  }
  return undefined;
}

function thinkingEnabled(value: Record<string, unknown> | undefined): boolean {
  return value?.type === "adaptive" || value?.type === "enabled";
}

function anthropicStateMessages(
  message: Extract<ModelConversationMessage, { role: "assistant" }>,
): AnthropicContentBlock[][] | undefined {
  const state = message.providerState;
  if (
    isRecord(state) &&
    state.kind === "anthropic-messages" &&
    Array.isArray(state.content)
  ) {
    const continuationContent = Array.isArray(state.continuationContent) &&
        state.continuationContent.every(Array.isArray)
      ? cloneJsonValue(state.continuationContent) as AnthropicContentBlock[][]
      : [];
    return [
      ...continuationContent,
      cloneJsonValue(state.content) as AnthropicContentBlock[],
    ];
  }
  return undefined;
}

function mapAnthropicTool(
  request: TransportRequest,
  tool: TransportRequest["tools"][number],
): AnthropicTool | undefined {
  if (tool.type === "hosted_web_search") {
    if (!request.runtimeProfile.profile.advanced.hostedTools?.webSearch) {
      throw new Error("Anthropic Messages Web Search is not enabled in this Profile.");
    }
    if (!isHostedWebSearchRequestMaxUses(tool.maxUses)) {
      throw new Error("Anthropic Messages Web Search has an invalid local usage limit.");
    }
    return {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: tool.maxUses,
    };
  }
  if (!request.runtimeProfile.capabilities.tools) return undefined;
  const parameters = tool.function.parameters;
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: parameters?.type === "object"
      ? parameters
      : { type: "object", properties: {} },
  };
}

function mappedAnthropicTools(request: TransportRequest): AnthropicTool[] {
  return request.tools.flatMap((tool) => {
    const mapped = mapAnthropicTool(request, tool);
    return mapped ? [mapped] : [];
  });
}

function citationsFromAnthropicContent(
  contentBlocks: Array<Record<string, unknown>>,
) {
  const candidates: Array<Record<string, unknown>> = [];
  for (const block of contentBlocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (
        isRecord(citation) &&
        citation.type === "web_search_result_location"
      ) candidates.push(citation);
    }
  }
  return normalizeModelCitations(candidates);
}

function safeToolInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw: value };
  }
}

function eventIndex(event: Record<string, unknown>): number | undefined {
  return typeof event.index === "number" &&
    Number.isInteger(event.index) &&
    event.index >= 0
    ? event.index
    : undefined;
}

function appendBlockText(
  block: AnthropicContentBlock,
  field: "text" | "thinking" | "signature",
  delta: string,
): void {
  const current = typeof block[field] === "string" ? block[field] : "";
  block[field] = current + delta;
}

function finalizeToolInput(
  index: number,
  blocks: Map<number, AnthropicContentBlock>,
  fragments: Map<number, string>,
): void {
  const fragment = fragments.get(index);
  if (fragment === undefined) return;
  const block = blocks.get(index);
  if (!block) {
    throw new Error(`Anthropic stream ended unknown tool block ${index}.`);
  }
  try {
    block.input = fragment ? JSON.parse(fragment) as unknown : {};
  } catch {
    throw new Error(`Anthropic stream returned invalid tool input for block ${index}.`);
  }
  fragments.delete(index);
}

function anthropicStreamError(): Error {
  return new Error("Anthropic stream error.");
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
