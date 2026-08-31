import {
  requireModelContextUsage,
  type ModelConversationMessage,
  type ModelHostedWebSearch,
  type ModelInputPart,
  type ModelToolCall,
  type ModelTurn,
} from "../contracts.js";
import {
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import { normalizeModelCitations } from "../citations.js";
import {
  decodeDiscoveredModelCatalog,
  isDiscoveredModelId,
  MAX_DISCOVERED_MODEL_COUNT,
  MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS,
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
import { anthropicMessagesInputSupport } from "../input-support.js";
import type {
  DiscoveredModelInfo,
  ModelCapabilityHints,
  ModelTransport,
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
import { isDirectRuntimeModelSource } from "../provider.js";
import type { DraftProfile } from "../profile.js";
import {
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import {
  requestAnthropicJson,
  requestAnthropicModelPage,
  streamAnthropicEvents,
} from "./anthropic-http.js";
import {
  anthropicErrorDiagnostic,
  isAnthropicRetryableError,
  isAnthropicSpendLimitError,
  safeAnthropicErrorObject,
  safeAnthropicIdentifier,
} from "./anthropic-errors.js";
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
const outputLimitContinuationText =
  "Continue the previous response from where it stopped.";
const outputLimitToolError =
  "Tool call was not executed because the response reached its output-token limit.";

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

interface AnthropicPartialToolInput {
  index: number;
  partialJson: string;
}

interface StreamedAnthropicMessage {
  message: Record<string, unknown>;
  partialToolInputs: AnthropicPartialToolInput[];
  hasPartialServerInput: boolean;
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
    let response: unknown;
    let partialToolInputs: AnthropicPartialToolInput[] = [];
    let hasPartialServerInput = false;
    if (request.onDelta && request.runtimeProfile.capabilities.streaming) {
      const streamed = await streamAnthropicMessage(
          request,
          body,
          fetchImpl,
          priorSearchCalls,
          reportWebSearch,
        );
      response = streamed.message;
      partialToolInputs = streamed.partialToolInputs;
      hasPartialServerInput = streamed.hasPartialServerInput;
    } else {
      response = await requestAnthropicJson(
          request.runtimeProfile.profile,
          fetchImpl,
          "/messages",
          {
            method: "POST",
            body,
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );
    }
    if (isRecord(response) && response.type === "error") {
      throw anthropicProviderError(response, "Anthropic Messages response");
    }
    const responseMessage = requireAnthropicMessageEnvelope(
      response,
      "Anthropic Messages returned an invalid message envelope.",
    );
    const responseContent = requireAnthropicContentBlocks(responseMessage.content);
    if (responseMessage.stop_reason === "pause_turn" &&
      responseContent.some((block) => block.type === "tool_use")) {
      throw new Error(
        "Anthropic Messages returned pause_turn with a client tool_use block.",
      );
    }
    for (const search of completedAnthropicWebSearches(
      responseContent,
      priorSearchCalls,
    )) {
      await reportWebSearch(search);
    }
    if (responseMessage.stop_reason !== "pause_turn") {
      const turn = turnFromAnthropicMessage(
        responseMessage,
        priorSearchCalls,
        request.runtimeProfile.capabilities.contextWindowTokens,
        partialToolInputs,
        hasPartialServerInput,
      );
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
        ...responseContent,
      ], initialSearchCalls);
      return {
        ...turn,
        content: combinedText || null,
        ...(citations.length ? { citations } : {}),
        ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
        ...(isRecord(turn.providerState)
          ? {
              providerState: {
                ...turn.providerState,
                continuationContent: cloneJsonValue(continuationContent),
              },
            }
          : {}),
      };
    }
    if (continuation === maxPauseTurnContinuations) {
      throw new Error(
        `Anthropic Messages exceeded ${maxPauseTurnContinuations} pause_turn continuations.`,
      );
    }
    continuationContent.push(cloneJsonValue(
      responseContent,
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
  const runtime = request.runtimeProfile;
  if (!isDirectRuntimeModelSource(runtime)) {
    throw new Error("Anthropic Messages requires a Direct API Profile.");
  }
  const model = runtime.model;
  const reasoning = model.parameters.reasoning;
  const thinking = anthropicThinking(request);
  const tools = mappedAnthropicTools(request);
  const generated: Record<string, unknown> = {
    model: model.model,
    max_tokens: model.parameters.maxOutputTokens,
    system: request.systemInstructions,
    messages: buildAnthropicMessages(request),
    ...(model.parameters.temperature !== undefined && !thinkingEnabled(thinking)
      ? { temperature: model.parameters.temperature }
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
    model.advanced.extraBody,
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
      const continuationUserContent = anthropicContinuationUserContent(
        message,
        content,
      );
      if (continuationUserContent.length) {
        messages.push({ role: "user", content: continuationUserContent });
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
      const providerReported = anthropicProviderReported(model);
      pageModels.push({
        id: model.id,
        displayName: typeof model.display_name === "string"
          ? model.display_name
          : model.id,
        capabilities: anthropicCapabilitiesFromMetadata(model, providerReported),
        ...(providerReported === undefined ? {} : { providerReported }),
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
  providerReported: DiscoveredModelInfo["providerReported"],
): ModelCapabilityHints {
  const maxOutputTokens = firstNumber(record, ["max_tokens", "max_output_tokens"]);
  const contextWindowTokens = Number.isSafeInteger(record.max_input_tokens) &&
      (record.max_input_tokens as number) > 0 &&
      (record.max_input_tokens as number) <=
        MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS
    ? record.max_input_tokens as number
    : undefined;
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const inputs = anthropicInputCapabilities(providerReported?.inputs);
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
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(hasReasoningHints ? { reasoning } : {}),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function anthropicInputCapabilities(
  reported: NonNullable<DiscoveredModelInfo["providerReported"]>["inputs"],
): ModelCapabilityHints["inputs"] | undefined {
  const image = reported?.supportsImages;
  const pdf = reported?.supportsPdf;
  const compatible = reported?.inputModalities
    ? inputCapabilitiesFromModalities(reported.inputModalities)
    : undefined;
  if (image === undefined && pdf === undefined) return compatible;
  return {
    ...compatible,
    ...(image === undefined ? {} : { image }),
    ...(pdf === undefined ? {} : { pdf }),
  };
}

function anthropicProviderReported(
  record: Record<string, unknown>,
): DiscoveredModelInfo["providerReported"] {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const rawModalities = [
    record.input_modalities,
    record.inputModalities,
    capabilities?.input_modalities,
    capabilities?.inputModalities,
  ].find((value) => value !== undefined);
  if (rawModalities !== undefined &&
    (!Array.isArray(rawModalities) ||
      !rawModalities.every((item) => typeof item === "string" && item.trim()))) {
    throw new Error(
      "Anthropic model discovery returned invalid input modality metadata.",
    );
  }
  const inputModalities = rawModalities === undefined
    ? undefined
    : [...new Set(
        (rawModalities as string[])
          .map((item) => item.trim().toLocaleLowerCase()),
      )];
  const supportsImages = supportStatus(capabilities?.image_input);
  const supportsPdf = supportStatus(capabilities?.pdf_input);
  const thinking = capabilities && isRecord(capabilities.thinking)
    ? capabilities.thinking
    : undefined;
  const supportsThinking = supportStatus(thinking);
  const supportsAdaptiveThinking = nestedSupportStatus(
    thinking,
    "types",
    "adaptive",
  );
  const inputs = {
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(supportsPdf === undefined ? {} : { supportsPdf }),
    ...(inputModalities?.includes("video") ? { supportsVideo: true } : {}),
  };
  const reasoning = {
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(supportsAdaptiveThinking === undefined
      ? {}
      : { supportsAdaptiveThinking }),
  };
  if (Object.keys(inputs).length === 0 && Object.keys(reasoning).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
  };
}

function inputCapabilitiesFromModalities(
  value: string[],
): ModelCapabilityHints["inputs"] {
  const modalities = new Set(value.map((item) => item.trim().toLocaleLowerCase()));
  return {
    image: anthropicMessagesInputSupport.image &&
      (modalities.has("image") || modalities.has("images") || modalities.has("vision")),
    audio: anthropicMessagesInputSupport.audio && modalities.has("audio"),
    pdf: anthropicMessagesInputSupport.pdf && modalities.has("pdf"),
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
): Promise<StreamedAnthropicMessage> {
  const contentBlocks = new Map<number, AnthropicContentBlock>();
  const inputJson = new Map<number, string>();
  const startedContentBlocks = new Set<number>();
  const closedContentBlocks = new Set<number>();
  const seenWebSearchResultIds = new Set<string>();
  let pendingToolInputError: Error | undefined;
  let messageStarted = false;
  let stopped = false;
  let stopReason: unknown;
  let initialUsage: unknown;
  let terminalUsage: unknown;
  for await (const event of streamAnthropicEvents(
    request.runtimeProfile.profile,
    fetchImpl,
    body,
    request.signal,
  )) {
    throwIfAborted(request.signal);
    if (event.type === "message_start") {
      if (messageStarted) {
        throw new Error("Anthropic stream returned duplicate message_start events.");
      }
      const message = requireAnthropicMessageEnvelope(
        event.message,
        "Anthropic stream returned an invalid message_start event.",
      );
      if (message.usage !== undefined) initialUsage = message.usage;
      if (message.content.length !== 0) {
        throw new Error(
          "Anthropic stream returned non-empty message_start content.",
        );
      }
      messageStarted = true;
      continue;
    }
    if (event.type === "error") {
      throw anthropicProviderError(event, "Anthropic stream");
    }
    if (!messageStarted && (
      event.type === "content_block_start" ||
      event.type === "content_block_delta" ||
      event.type === "content_block_stop" ||
      event.type === "message_delta" ||
      event.type === "message_stop"
    )) {
      throw new Error("Anthropic stream returned an event before message_start.");
    }
    if (event.type === "content_block_start") {
      const index = eventIndex(event);
      if (index === undefined || !isRecord(event.content_block)) {
        throw new Error("Anthropic stream returned an invalid content_block_start event.");
      }
      if (contentBlocks.has(index)) {
        throw new Error("Anthropic stream returned a duplicate content block index.");
      }
      const contentBlock = requireAnthropicContentBlock(event.content_block);
      startedContentBlocks.add(index);
      contentBlocks.set(index, cloneJsonValue(contentBlock));
      if (
        contentBlock.type === "web_search_tool_result" &&
        typeof contentBlock.tool_use_id === "string" &&
        isAnthropicWebSearchResultContent(contentBlock.content)
      ) {
        if (seenWebSearchResultIds.has(contentBlock.tool_use_id)) {
          throw duplicateAnthropicWebSearchResultError();
        }
        seenWebSearchResultIds.add(contentBlock.tool_use_id);
        const search = anthropicWebSearchFromResult(
          contentBlock,
          [...contentBlocks.values()],
          index,
          priorSearchCalls,
        );
        if (search) {
          await reportWebSearch(search);
        }
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const index = eventIndex(event);
      if (index === undefined || !isRecord(event.delta)) {
        throw new Error("Anthropic stream returned an invalid content_block_delta event.");
      }
      const block = contentBlocks.get(index);
      if (!block || !startedContentBlocks.has(index)) {
        throw new Error(`Anthropic stream sent a delta before block ${index} started.`);
      }
      if (closedContentBlocks.has(index)) {
        throw new Error("Anthropic stream sent a delta after content block stop.");
      }
      switch (event.delta.type) {
        case "text_delta":
          requireAnthropicDeltaBlock(block, "text", "text_delta");
          if (typeof event.delta.text !== "string") {
            throw new Error("Anthropic stream returned an invalid text_delta event.");
          }
          appendBlockText(block, "text", event.delta.text);
          await request.onDelta?.(event.delta.text);
          break;
        case "thinking_delta":
          requireAnthropicDeltaBlock(block, "thinking", "thinking_delta");
          if (typeof event.delta.thinking !== "string") {
            throw new Error("Anthropic stream returned an invalid thinking_delta event.");
          }
          appendBlockText(block, "thinking", event.delta.thinking);
          break;
        case "signature_delta":
          requireAnthropicDeltaBlock(block, "thinking", "signature_delta");
          if (typeof event.delta.signature !== "string") {
            throw new Error("Anthropic stream returned an invalid signature_delta event.");
          }
          appendBlockText(block, "signature", event.delta.signature);
          break;
        case "input_json_delta":
          requireAnthropicDeltaBlock(
            block,
            ["tool_use", "server_tool_use"],
            "input_json_delta",
          );
          if (typeof event.delta.partial_json !== "string") {
            throw new Error("Anthropic stream returned an invalid input_json_delta event.");
          }
          inputJson.set(index, (inputJson.get(index) ?? "") + event.delta.partial_json);
          break;
        case "citations_delta": {
          requireAnthropicDeltaBlock(block, "text", "citations_delta");
          if (!isRecord(event.delta.citation)) {
            throw new Error("Anthropic stream returned an invalid citations_delta event.");
          }
          requireAnthropicCitation(event.delta.citation);
          const citations = Array.isArray(block.citations) ? block.citations : [];
          citations.push(cloneJsonValue(event.delta.citation));
          block.citations = citations;
          break;
        }
        default: {
          const deltaType = safeAnthropicIdentifier(event.delta.type);
          throw new Error(
            deltaType
              ? `Anthropic stream returned an unsupported content delta. [type=${deltaType}]`
              : "Anthropic stream returned an invalid content delta.",
          );
        }
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const index = eventIndex(event);
      if (index === undefined || !startedContentBlocks.has(index)) {
        throw new Error("Anthropic stream returned an invalid content_block_stop event.");
      }
      if (closedContentBlocks.has(index)) {
        throw new Error("Anthropic stream returned a duplicate content block stop.");
      }
      closedContentBlocks.add(index);
      try {
        finalizeToolInput(index, contentBlocks, inputJson);
      } catch (error) {
        pendingToolInputError ??= error instanceof Error
          ? error
          : new Error("Anthropic stream returned invalid tool input.");
      }
      continue;
    }
    if (event.type === "message_delta") {
      if (!isRecord(event.delta)) {
        throw new Error("Anthropic stream returned an invalid message_delta event.");
      }
      if (event.usage !== undefined) terminalUsage = event.usage;
      if (event.delta.stop_reason !== undefined) {
        if (stopReason !== undefined && stopReason !== event.delta.stop_reason) {
          throw new Error("Anthropic stream returned conflicting stop reasons.");
        }
        stopReason = event.delta.stop_reason;
      }
      continue;
    }
    if (event.type === "message_stop") {
      if ([...startedContentBlocks].some((index) =>
        !closedContentBlocks.has(index)
      )) {
        throw new Error(
          "Anthropic stream reached message_stop before content_block_stop.",
        );
      }
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    throw new ModelConnectionError("Anthropic stream ended before message_stop.");
  }
  const terminalStopReason = requireAnthropicStopReason(stopReason);
  for (const index of inputJson.keys()) {
    try {
      finalizeToolInput(index, contentBlocks, inputJson);
    } catch (error) {
      pendingToolInputError ??= error instanceof Error
        ? error
        : new Error("Anthropic stream returned invalid tool input.");
    }
  }
  if (
    pendingToolInputError &&
    terminalStopReason !== "max_tokens" &&
    terminalStopReason !== "model_context_window_exceeded"
  ) throw pendingToolInputError;
  const content = [...contentBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  const partialToolInputs = pendingToolInputError &&
      terminalStopReason === "max_tokens"
    ? [...inputJson.entries()]
        .filter(([index]) => contentBlocks.get(index)?.type === "tool_use")
        .sort(([left], [right]) => left - right)
        .map(([index, partialJson]) => ({ index, partialJson }))
    : [];
  const hasPartialServerInput = pendingToolInputError !== undefined &&
    terminalStopReason === "max_tokens" &&
    [...inputJson.keys()].some((index) =>
      contentBlocks.get(index)?.type === "server_tool_use"
    );
  const usage = mergedAnthropicStreamUsage(initialUsage, terminalUsage);
  return {
    message: {
      type: "message",
      role: "assistant",
      content,
      stop_reason: terminalStopReason,
      ...(usage === undefined ? {} : { usage }),
    },
    partialToolInputs,
    hasPartialServerInput,
  };
}

function turnFromAnthropicMessage(
  value: unknown,
  priorSearchCalls: ReadonlyMap<string, AnthropicContentBlock> = new Map(),
  contextWindowTokens?: number,
  partialToolInputs: readonly AnthropicPartialToolInput[] = [],
  hasPartialServerInput = false,
): ModelTurn {
  const message = requireAnthropicMessageEnvelope(
    value,
    "Anthropic Messages returned an invalid message envelope.",
  );
  const contentBlocks = requireAnthropicContentBlocks(message.content);
  const text = textFromAnthropicContent(contentBlocks);
  const contextUsage = anthropicContextUsage(
    message.usage,
    contextWindowTokens,
  );
  const stopReason = requireAnthropicStopReason(message.stop_reason);
  const citations = citationsFromAnthropicContent(contentBlocks);
  const hostedWebSearches = completedAnthropicWebSearches(
    contentBlocks,
    priorSearchCalls,
  );
  if (
    stopReason === "max_tokens" ||
    stopReason === "model_context_window_exceeded"
  ) {
    if (stopReason === "max_tokens" && contentBlocks.length === 0) {
      throw new Error(
        "Anthropic Messages reached its output-token limit without replayable content.",
      );
    }
    if (stopReason === "max_tokens" && hasPartialServerInput) {
      return {
        content: text || null,
        toolCalls: [],
        termination: { reason: "output_limit" },
        ...(citations.length ? { citations } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
      };
    }
    if (stopReason === "max_tokens" &&
      !contentBlocks.some((block) => block.type === "tool_use") &&
      hasUnresolvedAnthropicServerTool(contentBlocks)) {
      return {
        content: text || null,
        toolCalls: [],
        termination: { reason: "output_limit" },
        ...(citations.length ? { citations } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
      };
    }
    return {
      content: text || null,
      toolCalls: [],
      ...(stopReason === "max_tokens"
        ? {
            continuation: { reason: "output_limit" as const },
            providerState: anthropicProviderState(
              contentBlocks,
              {
                outputLimited: true,
                partialToolInputs,
              },
            ),
          }
        : { termination: { reason: "context_limit" as const } }),
      ...(citations.length ? { citations } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
    };
  }
  const toolCalls = contentBlocks.flatMap((block): ModelToolCall[] => {
    if (block.type !== "tool_use") return [];
    return [{
      id: block.id as string,
      name: block.name as string,
      arguments: JSON.stringify(block.input),
    }];
  });
  assertCompleteAnthropicStopReason(stopReason, toolCalls.length);
  const assistantContent = text || (
    stopReason === "refusal" ? "The model refused this request." : ""
  );
  if (!assistantContent && !toolCalls.length) {
    throw new Error("Anthropic Messages returned an empty response.");
  }
  return {
    content: assistantContent || null,
    toolCalls,
    ...(citations.length ? { citations } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(hostedWebSearches.length ? { hostedWebSearches } : {}),
    providerState: anthropicProviderState(contentBlocks),
  };
}

function hasUnresolvedAnthropicServerTool(
  content: readonly AnthropicContentBlock[],
): boolean {
  const resultIds = new Set(content.flatMap((block) =>
    typeof block.type === "string" && block.type.endsWith("_tool_result") &&
        typeof block.tool_use_id === "string"
      ? [block.tool_use_id]
      : []
  ));
  return content.some((block) =>
    block.type === "server_tool_use" &&
    typeof block.id === "string" &&
    !resultIds.has(block.id)
  );
}

function anthropicProviderState(
  content: readonly AnthropicContentBlock[],
  options: {
    outputLimited?: boolean;
    partialToolInputs?: readonly AnthropicPartialToolInput[];
  } = {},
): Record<string, unknown> {
  const partialToolInputs = options.partialToolInputs ?? [];
  return {
    kind: "anthropic-messages",
    content: cloneJsonValue(content),
    ...(options.outputLimited ? { outputLimited: true } : {}),
    ...(partialToolInputs.length
      ? { partialToolInputs: cloneJsonValue(partialToolInputs) }
      : {}),
  };
}

function mergedAnthropicStreamUsage(
  initial: unknown,
  terminal: unknown,
): unknown {
  if (initial === undefined) return terminal;
  if (terminal === undefined) return initial;
  if (!isRecord(initial) || !isRecord(terminal)) return null;
  return { ...initial, ...terminal };
}

function anthropicContextUsage(
  value: unknown,
  contextWindowTokens: number | undefined,
): ModelTurn["contextUsage"] {
  if (value === undefined || contextWindowTokens === undefined) return undefined;
  const usage = isRecord(value) ? value : undefined;
  const tokenCount = (field: string, required: boolean): number => {
    const raw = usage?.[field];
    if (raw === undefined && !required) return 0;
    if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
      throw new TypeError("Anthropic Messages context usage is invalid.");
    }
    return raw as number;
  };
  const usedTokens = tokenCount("input_tokens", true) +
    tokenCount("cache_creation_input_tokens", false) +
    tokenCount("cache_read_input_tokens", false) +
    tokenCount("output_tokens", true);
  return requireModelContextUsage(usedTokens, contextWindowTokens);
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

function requireAnthropicMessageEnvelope(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> & { content: unknown[] } {
  if (!isRecord(value) || value.type !== "message" ||
    value.role !== "assistant" || !Array.isArray(value.content)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown> & { content: unknown[] };
}

function requireAnthropicContentBlocks(value: unknown[]): AnthropicContentBlock[] {
  const blocks = value.map(requireAnthropicContentBlock);
  const seenToolCallIds = new Set<string>();
  for (const block of blocks) {
    if (block.type === "tool_use") {
      requireUniqueToolCallId(block.id, seenToolCallIds);
    }
  }
  return blocks;
}

function requireAnthropicContentBlock(value: unknown): AnthropicContentBlock {
  if (!isRecord(value) || typeof value.type !== "string" || !value.type) {
    throw new Error("Anthropic Messages returned an invalid content block.");
  }
  switch (value.type) {
    case "text":
      if (typeof value.text !== "string" ||
        (value.citations !== undefined && value.citations !== null &&
          (!Array.isArray(value.citations) ||
            !value.citations.every(isRecord)))) {
        throw invalidAnthropicContentBlock("text");
      }
      for (const citation of Array.isArray(value.citations) ? value.citations : []) {
        requireAnthropicCitation(citation);
      }
      break;
    case "thinking":
      if (typeof value.thinking !== "string" || typeof value.signature !== "string") {
        throw invalidAnthropicContentBlock("thinking");
      }
      break;
    case "redacted_thinking":
      if (typeof value.data !== "string") {
        throw invalidAnthropicContentBlock("redacted_thinking");
      }
      break;
    case "tool_use":
      if (typeof value.id !== "string" || !value.id.trim()) {
        throw new Error(
          "Anthropic Messages returned a tool call ID that was missing or empty.",
        );
      }
      if (typeof value.name !== "string" || !value.name.trim()) {
        throw new Error(
          "Anthropic Messages returned a tool_use with a missing or empty name.",
        );
      }
      if (!isRecord(value.input)) {
        throw new Error("Anthropic Messages returned a tool_use with invalid input.");
      }
      break;
    case "server_tool_use":
      if (typeof value.id !== "string" || !value.id.trim() ||
        typeof value.name !== "string" || !value.name.trim() ||
        !isRecord(value.input)) {
        throw invalidAnthropicContentBlock("server_tool_use");
      }
      break;
    case "web_search_tool_result":
      if (typeof value.tool_use_id !== "string" || !value.tool_use_id.trim() ||
        !isAnthropicWebSearchResultContent(value.content)) {
        throw invalidAnthropicContentBlock("web_search_tool_result");
      }
      requireAnthropicWebSearchResultContent(value.content);
      break;
  }
  return value;
}

function requireAnthropicCitation(value: Record<string, unknown>): void {
  if (typeof value.type !== "string" || !value.type) {
    throw invalidAnthropicContentBlock("text");
  }
  if (value.type !== "web_search_result_location") return;
  if (typeof value.url !== "string" || !value.url ||
    (value.title !== undefined && value.title !== null &&
      typeof value.title !== "string") ||
    (value.cited_text !== undefined && typeof value.cited_text !== "string") ||
    (value.encrypted_index !== undefined &&
      typeof value.encrypted_index !== "string")) {
    throw invalidAnthropicContentBlock("text");
  }
}

function requireAnthropicWebSearchResultContent(value: unknown): void {
  if (Array.isArray(value)) {
    for (const result of value) {
      if (!isRecord(result)) {
        throw invalidAnthropicContentBlock("web_search_tool_result");
      }
      if (typeof result.type !== "string" || !result.type) {
        throw invalidAnthropicContentBlock("web_search_tool_result");
      }
      if (result.type !== "web_search_result") continue;
      if (typeof result.url !== "string" || !result.url ||
        (result.title !== undefined && result.title !== null &&
          typeof result.title !== "string") ||
        (result.encrypted_content !== undefined &&
          typeof result.encrypted_content !== "string") ||
        (result.page_age !== undefined && result.page_age !== null &&
          typeof result.page_age !== "string")) {
        throw invalidAnthropicContentBlock("web_search_tool_result");
      }
    }
    return;
  }
  if (!isRecord(value) || value.type !== "web_search_tool_result_error" ||
    typeof value.error_code !== "string" || !value.error_code) {
    throw invalidAnthropicContentBlock("web_search_tool_result");
  }
}

function requireAnthropicDeltaBlock(
  block: AnthropicContentBlock,
  expected: string | readonly string[],
  deltaType: string,
): void {
  const expectedTypes = typeof expected === "string" ? [expected] : expected;
  if (!expectedTypes.includes(String(block.type))) {
    throw new Error(`Anthropic stream returned an invalid ${deltaType} event.`);
  }
}

function invalidAnthropicContentBlock(type: string): Error {
  return new Error(`Anthropic Messages returned an invalid ${type} content block.`);
}

function requireUniqueToolCallId(value: unknown, seen: Set<string>): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Anthropic Messages returned a tool call ID that was missing or empty.");
  }
  if (seen.has(value)) {
    throw new Error("Anthropic Messages returned a duplicate tool call ID.");
  }
  seen.add(value);
  return value;
}

type AnthropicTerminalStopReason =
  | "end_turn"
  | "max_tokens"
  | "model_context_window_exceeded"
  | "pause_turn"
  | "refusal"
  | "stop_sequence"
  | "tool_use";

function requireAnthropicStopReason(value: unknown): AnthropicTerminalStopReason {
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "model_context_window_exceeded":
    case "pause_turn":
    case "refusal":
    case "stop_sequence":
    case "tool_use":
      return value;
  }
  if (typeof value === "string") {
    throw new Error("Anthropic Messages returned an unsupported stop_reason.");
  }
  throw new Error(
    "Anthropic Messages stop_reason was missing before completion.",
  );
}

function assertCompleteAnthropicStopReason(
  value: AnthropicTerminalStopReason,
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
  if (
    value === "end_turn" ||
    value === "refusal" ||
    value === "stop_sequence"
  ) {
    if (toolCallCount > 0) {
      throw new Error(
        "Anthropic Messages returned tool_use blocks with a non-tool stop_reason.",
      );
    }
    return;
  }
  throw new Error("Anthropic Messages returned an incomplete stop_reason.");
}

function anthropicThinking(
  request: TransportRequest,
): Record<string, unknown> | undefined {
  const runtime = request.runtimeProfile;
  if (!isDirectRuntimeModelSource(runtime)) {
    throw new Error("Anthropic Messages requires a Direct API Profile.");
  }
  const reasoning = runtime.model.parameters.reasoning;
  if (reasoning.mode === "default") return undefined;
  if (reasoning.mode === "disabled") return { type: "disabled" };
  const strategy = request.runtimeProfile.capabilities.reasoning.strategy;
  if (strategy === "adaptive-thinking") return { type: "adaptive" };
  if (strategy === "budget-thinking") {
    const max = runtime.model.parameters.maxOutputTokens;
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
      ? state.continuationContent.map((content) =>
          cloneJsonValue(requireAnthropicContentBlocks(content))
        )
      : [];
    return [
      ...continuationContent,
      cloneJsonValue(requireAnthropicContentBlocks(state.content)),
    ];
  }
  return undefined;
}

function anthropicContinuationUserContent(
  message: Extract<ModelConversationMessage, { role: "assistant" }>,
  content: readonly AnthropicContentBlock[],
): AnthropicContentBlock[] {
  const state = message.providerState;
  if (!isRecord(state) || state.kind !== "anthropic-messages" ||
    state.outputLimited !== true) {
    return [];
  }
  if (state.partialToolInputs !== undefined &&
    !Array.isArray(state.partialToolInputs)) {
    throw new Error("Anthropic Messages output-limit replay state is invalid.");
  }
  const partialByIndex = new Map<number, string>();
  for (const value of state.partialToolInputs ?? []) {
    if (!isRecord(value) || !Number.isSafeInteger(value.index) ||
      (value.index as number) < 0 || typeof value.partialJson !== "string" ||
      partialByIndex.has(value.index as number)) {
      throw new Error("Anthropic Messages output-limit replay state is invalid.");
    }
    partialByIndex.set(value.index as number, value.partialJson);
  }

  const results: AnthropicToolResultBlock[] = [];
  for (const [index, value] of content.entries()) {
    if (value.type !== "tool_use") continue;
    const partialJson = partialByIndex.get(index);
    results.push({
      type: "tool_result",
      tool_use_id: value.id as string,
      is_error: true,
      content: partialJson === undefined
        ? outputLimitToolError
        : JSON.stringify({ INVALID_JSON: partialJson }),
    });
    partialByIndex.delete(index);
  }
  if (partialByIndex.size) {
    throw new Error("Anthropic Messages output-limit replay state is invalid.");
  }
  return results.length
    ? results
    : [{ type: "text", text: outputLimitContinuationText }];
}

function mapAnthropicTool(
  request: TransportRequest,
  tool: TransportRequest["tools"][number],
): AnthropicTool | undefined {
  if (tool.type === "hosted_web_search") {
    if (!request.runtimeProfile.model.advanced.hostedTools?.webSearch) {
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
    const input = fragment ? JSON.parse(fragment) as unknown : {};
    if (!isRecord(input)) throw new Error("invalid tool input");
    block.input = input;
  } catch {
    throw new Error(`Anthropic stream returned invalid tool input for block ${index}.`);
  }
  fragments.delete(index);
}

function anthropicProviderError(
  envelope: Record<string, unknown>,
  label: string,
): Error {
  const error = safeAnthropicErrorObject(envelope.error);
  const diagnostic = anthropicErrorDiagnostic(error);
  if (isAnthropicSpendLimitError(error)) {
    return new Error(
      `${label} account usage limit was reached.${diagnostic}`,
    );
  }
  if (isAnthropicRetryableError(error)) {
    return new ModelRetryableError(
      `${label} reported a retryable failure.${diagnostic}`,
    );
  }
  return new Error(`${label} error.${diagnostic}`);
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
