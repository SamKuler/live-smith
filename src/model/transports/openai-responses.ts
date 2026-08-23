import type {
  ModelHostedWebSearch,
  ModelHostedWebSearchAction,
  ModelInputPart,
  ModelToolCall,
  ModelTurn,
} from "../contracts.js";
import { ModelConnectionError } from "../connection-error.js";
import { normalizeModelCitations } from "../citations.js";
import {
  HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND,
  isHostedWebSearchRequestMaxUses,
} from "../tools.js";
import {
  normalizeModelHostedWebSearch,
  safeModelWebSearchId,
} from "../web-search.js";
import { cloneJsonValue } from "../json-clone.js";
import { isDirectApiProfile } from "../profile.js";
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
  listOpenAIModels,
} from "./openai-shared.js";
import {
  assertBinaryInputWithinLimits,
  assertImageInputEnabled,
  assertNoUnsupportedAudioInput,
  assertPdfInputEnabled,
  assertNeverInputPart,
  imageDataUrl,
  pdfDataUrl,
  unsupportedInputPart,
} from "./input-parts.js";

const protectedFields = [
  "model",
  "input",
  "tools",
  "tool_choice",
  "max_tool_calls",
  "stream",
  "store",
  "instructions",
  "previous_response_id",
  "conversation",
] as const;
const encryptedReasoningInclude = "reasoning.encrypted_content";
const webSearchSourcesInclude = "web_search_call.action.sources";

export function createOpenAIResponsesTransport(
  options: TransportFactoryOptions = {},
): ModelTransport {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    apiFamily: "openai",
    apiMode: "responses",
    listModels: (profile, signal) => listOpenAIModels(profile, fetchImpl, signal),
    createToolTurn(request) {
      return withTransportContext(request.runtimeProfile.profile, "request", async () => {
      assertNoUnsupportedAudioInput(request, "OpenAI Responses");
      assertBinaryInputWithinLimits(request);
      const body = buildResponsesBody(request);
      if (request.onDelta && request.runtimeProfile.capabilities.streaming) {
        return streamResponsesTurn(request, body, fetchImpl);
      }
      const response = await requestOpenAIJson(
        request.runtimeProfile.profile,
        fetchImpl,
        "/responses",
        {
          method: "POST",
          body,
          ...(request.signal ? { signal: request.signal } : {}),
          },
        );
      const hostedWebSearches = terminalWebSearchesFromResponse(
        response,
        "OpenAI Responses",
      );
      for (const search of hostedWebSearches) {
        await request.onHostedWebSearch?.(search);
      }
      return turnFromResponse(response, "OpenAI Responses", hostedWebSearches);
      }, request.signal);
    },
  };
}

function buildResponsesBody(
  request: TransportRequest,
): Record<string, unknown> {
  const { profile, capabilities } = request.runtimeProfile;
  if (!isDirectApiProfile(profile)) {
    throw new Error("OpenAI Responses requires a Direct API Profile.");
  }
  const reasoning = profile.parameters.reasoning;
  const tools = mappedResponsesTools(request);
  const hostedWebSearchMaxUses = request.tools.find(
    (tool) => tool.type === "hosted_web_search",
  )?.maxUses;
  const generated: Record<string, unknown> = {
    model: profile.model,
    instructions: request.systemInstructions,
    input: buildResponsesInput(request),
    store: false,
    include: [encryptedReasoningInclude],
    max_output_tokens: profile.parameters.maxOutputTokens,
    ...(profile.parameters.temperature !== undefined &&
    capabilities.temperature === "supported"
      ? { temperature: profile.parameters.temperature }
      : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: "auto",
          ...(tools.some((tool) => tool.type === "web_search")
            ? { max_tool_calls: hostedWebSearchMaxUses }
            : {}),
        }
      : {}),
    ...(reasoning.mode === "disabled"
      ? { reasoning: { effort: "none" } }
      : reasoning.mode === "enabled" && reasoning.effort
        ? { reasoning: { effort: reasoning.effort } }
        : {}),
  };
  const body = mergeExtraBody(
    generated,
    profile.advanced.extraBody,
    protectedFields,
  );
  const include = body.include;
  if (
    !Array.isArray(include) ||
    include.some((value) => typeof value !== "string")
  ) {
    throw new Error("Extra Body field include must be an array of strings.");
  }
  body.include = [
    ...new Set([
      encryptedReasoningInclude,
      ...(tools.some((tool) => tool.type === "web_search")
        ? [webSearchSourcesInclude]
        : []),
      ...(include as string[]),
    ]),
  ];
  return body;
}

function mappedResponsesTools(
  request: TransportRequest,
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  for (const tool of request.tools) {
    if (tool.type === "function") {
      if (!request.runtimeProfile.capabilities.tools) continue;
      tools.push({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? { type: "object", properties: {} },
        strict: false,
      });
      continue;
    }
    if (!request.runtimeProfile.profile.advanced.hostedTools?.webSearch) {
      throw new Error("OpenAI Responses Web Search is not enabled in this Profile.");
    }
    if (!isHostedWebSearchRequestMaxUses(tool.maxUses)) {
      throw new Error("OpenAI Responses Web Search has an invalid local usage limit.");
    }
    tools.push({ type: "web_search" });
  }
  return tools;
}

function buildResponsesInput(
  request: TransportRequest,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [
    ...request.history.map((message) => message.role === "assistant"
      ? { role: "assistant", content: message.content }
      : { role: "user", content: mapResponsesParts(request, message.content) }),
    {
      role: "user",
      content: mapResponsesParts(request, request.currentUserContent),
    },
  ];

  for (const message of request.agentMessages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content,
      });
      continue;
    }
    const state = message.providerState;
    if (
      isRecord(state) &&
      state.kind === "openai-responses" &&
      Array.isArray(state.output)
    ) {
      input.push(...cloneJsonValue(state.output));
      continue;
    }
    if (message.content?.trim()) {
      input.push({ role: "assistant", content: message.content });
    }
    input.push(
      ...message.toolCalls.map((toolCall) => ({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })),
    );
  }
  return input;
}

function mapResponsesParts(
  request: TransportRequest,
  parts: readonly ModelInputPart[],
): Array<Record<string, unknown>> {
  return parts.map((part): Record<string, unknown> => {
    switch (part.type) {
      case "text":
        return { type: "input_text", text: part.text };
      case "image":
        assertImageInputEnabled(request);
        return {
          type: "input_image",
          image_url: imageDataUrl(part),
          detail: "auto",
        };
      case "document":
        assertPdfInputEnabled(request);
        return {
          type: "input_file",
          filename: part.fileName,
          file_data: pdfDataUrl(part),
        };
      case "audio":
        return unsupportedInputPart(part);
      default:
        return assertNeverInputPart(part);
    }
  });
}

async function streamResponsesTurn(
  request: TransportRequest,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<ModelTurn> {
  const reportedWebSearches = new Map<string, string>();
  const reportWebSearch = async (update: ModelHostedWebSearch | undefined) => {
    if (!update) return;
    if (
      !reportedWebSearches.has(update.id) &&
      reportedWebSearches.size >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND
    ) {
      return;
    }
    const signature = JSON.stringify(update);
    if (reportedWebSearches.get(update.id) === signature) return;
    reportedWebSearches.set(update.id, signature);
    await request.onHostedWebSearch?.(update);
  };
  for await (const event of streamOpenAIEvents(
    request.runtimeProfile.profile,
    fetchImpl,
    "/responses",
    body,
    request.signal,
  )) {
    throwIfAborted(request.signal);
    await reportWebSearch(webSearchUpdateFromOpenAIEvent(event));
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      await request.onDelta?.(event.delta);
    } else if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      const hostedWebSearches = terminalWebSearchesFromResponse(
        event.response,
        "OpenAI Responses",
      );
      for (const search of hostedWebSearches) {
        await reportWebSearch(search);
      }
      return turnFromResponse(
        event.response,
        "OpenAI Responses",
        hostedWebSearches,
      );
    } else if (event.type === "response.failed") {
      if (isRecord(event.response) && Array.isArray(event.response.output)) {
        const hostedWebSearches = webSearchesFromResponsesOutput(
          event.response.output as Array<Record<string, unknown>>,
        );
        for (const search of hostedWebSearches) {
          await reportWebSearch(search);
        }
      }
      throw new Error("OpenAI Responses failed.");
    }
  }
  throw new ModelConnectionError(
    "OpenAI Responses stream ended without a terminal response.",
  );
}

function webSearchUpdateFromOpenAIEvent(
  event: Record<string, unknown>,
): ModelHostedWebSearch | undefined {
  if (
    (event.type === "response.output_item.added" ||
      event.type === "response.output_item.done") &&
    isRecord(event.item) &&
    event.item.type === "web_search_call"
  ) {
    return webSearchFromResponsesItem(
      event.item,
      typeof event.output_index === "number" ? event.output_index : 0,
    );
  }
  if (
    event.type === "response.web_search_call.in_progress" ||
    event.type === "response.web_search_call.searching"
  ) {
    return normalizeModelHostedWebSearch({
      id: safeModelWebSearchId(event.item_id, "openai-search-1"),
      status: "searching",
      action: "search",
      queries: [],
      sources: [],
    });
  }
  return undefined;
}

function turnFromResponse(
  value: unknown,
  label: string,
  hostedWebSearches?: ModelHostedWebSearch[],
): ModelTurn {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    throw new Error(`${label} returned no output items.`);
  }
  const output = value.output as Array<Record<string, unknown>>;
  const content = typeof value.output_text === "string" && value.output_text.trim()
    ? value.output_text
    : textFromOutput(output);
  const citations = citationsFromResponsesOutput(output);
  const terminalWebSearches = hostedWebSearches ?? webSearchesFromResponsesOutput(output);
  const functionCalls = output.filter((item) =>
    isRecord(item) && item.type === "function_call"
  );
  if (value.status === "incomplete") {
    const details = isRecord(value.incomplete_details)
      ? value.incomplete_details
      : undefined;
    const reason = typeof details?.reason === "string" ? details.reason : undefined;
    if (reason !== "max_output_tokens") {
      throw new Error(
        `${label} returned a non-recoverable incomplete response.`,
      );
    }
    if (output.length === 0) {
      throw new Error(
        `${label} reached its output-token limit without replayable output. Increase this Profile's Max Output Tokens and try again.`,
      );
    }
    if (
      functionCalls.length === 0 ||
      functionCalls.some((item) => item.status !== "completed")
    ) {
      return {
        content: content || null,
        toolCalls: [],
        continuation: { reason: "output_limit" },
        ...(citations.length ? { citations } : {}),
        ...(terminalWebSearches.length ? { hostedWebSearches: terminalWebSearches } : {}),
        providerState: {
          kind: "openai-responses",
          output: cloneJsonValue(output),
        },
      };
    }
  }
  assertCompleteResponseToolCalls(value, output, label);
  const toolCallIds = new Set<string>();
  const toolCalls = output.flatMap((item): ModelToolCall[] => {
    if (!isRecord(item) || item.type !== "function_call") return [];
    const id = requireUniqueToolCallId(item.call_id, toolCallIds, label);
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new Error(`${label} returned a function_call with a missing or empty name.`);
    }
    if (typeof item.arguments !== "string" || !item.arguments.trim()) {
      throw new Error(`${label} returned a function_call with invalid arguments.`);
    }
    return [{
      id,
      name: item.name,
      arguments: item.arguments,
    }];
  });
  if (!content && !toolCalls.length) {
    throw new Error(`${label} returned an empty response.`);
  }
  return {
    content: content || null,
    toolCalls,
    ...(citations.length ? { citations } : {}),
    ...(terminalWebSearches.length ? { hostedWebSearches: terminalWebSearches } : {}),
    providerState: {
      kind: "openai-responses",
      output: cloneJsonValue(output),
    },
  };
}

function terminalWebSearchesFromResponse(
  value: unknown,
  label: string,
): ModelHostedWebSearch[] {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    throw new Error(`${label} returned no output items.`);
  }
  return webSearchesFromResponsesOutput(
    value.output as Array<Record<string, unknown>>,
  );
}

function webSearchesFromResponsesOutput(
  output: Array<Record<string, unknown>>,
): ModelHostedWebSearch[] {
  const searches: ModelHostedWebSearch[] = [];
  for (const [index, item] of output.entries()) {
    if (
      !isRecord(item) ||
      item.type !== "web_search_call" ||
      (item.status !== "completed" && item.status !== "failed")
    ) continue;
    if (searches.length >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND) break;
    const search = webSearchFromResponsesItem(item, index);
    if (search) searches.push(search);
  }
  return searches;
}

function webSearchFromResponsesItem(
  item: Record<string, unknown>,
  index: number,
): ModelHostedWebSearch | undefined {
  if (item.type !== "web_search_call") return undefined;
  const action = isRecord(item.action) ? item.action : undefined;
  const actionType = isWebSearchAction(action?.type) ? action.type : "search";
  const sourceCandidates = Array.isArray(action?.sources)
    ? action.sources.filter((candidate) =>
        isRecord(candidate) && candidate.type === "url"
      )
    : [];
  if (
    (actionType === "open_page" || actionType === "find_in_page") &&
    typeof action?.url === "string"
  ) {
    sourceCandidates.unshift({ type: "url", url: action.url, title: action.title });
  }
  const queries = searchQueriesFromOpenAIAction(action);
  return normalizeModelHostedWebSearch({
    id: safeModelWebSearchId(item.id, `openai-search-${index + 1}`),
    status: item.status === "completed"
      ? "completed"
      : item.status === "failed"
        ? "failed"
        : "searching",
    action: actionType,
    queries,
    sources: sourceCandidates,
  });
}

function searchQueriesFromOpenAIAction(
  action: Record<string, unknown> | undefined,
): unknown[] {
  const queries = Array.isArray(action?.queries) && action.queries.length
    ? [...action.queries]
    : typeof action?.query === "string"
      ? [action.query]
      : [];
  if (action?.type === "find_in_page" && typeof action.pattern === "string") {
    queries.push(action.pattern);
  }
  return queries;
}

function isWebSearchAction(value: unknown): value is ModelHostedWebSearchAction {
  return value === "search" || value === "open_page" || value === "find_in_page";
}

function citationsFromResponsesOutput(
  output: Array<Record<string, unknown>>,
) {
  const candidates: Array<Record<string, unknown>> = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) {
        continue;
      }
      for (const annotation of part.annotations) {
        if (
          isRecord(annotation) &&
          annotation.type === "url_citation"
        ) candidates.push(annotation);
      }
    }
  }
  return normalizeModelCitations(candidates);
}

function assertCompleteResponseToolCalls(
  response: Record<string, unknown>,
  output: Array<Record<string, unknown>>,
  label: string,
): void {
  const functionCalls = output.filter((item) =>
    isRecord(item) && item.type === "function_call"
  );
  if (functionCalls.length && response.status !== "completed") {
    const details = isRecord(response.incomplete_details)
      ? response.incomplete_details
      : undefined;
    const status = typeof response.status === "string" && response.status.trim()
      ? response.status
      : "missing";
    const isCompletedOutputLimitBatch = response.status === "incomplete" &&
      details?.reason === "max_output_tokens" &&
      functionCalls.every((item) => item.status === "completed");
    if (!isCompletedOutputLimitBatch) {
      throw new Error(
        `${label} returned a tool call response with non-completed status ${status}.`,
      );
    }
  }
  for (const item of functionCalls) {
    if (typeof item.status === "string" && item.status !== "completed") {
      throw new Error(
        `${label} returned a function_call with ${item.status} status.`,
      );
    }
  }
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

function textFromOutput(output: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
