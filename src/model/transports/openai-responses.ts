import {
  requireModelContextUsage,
  type ModelHostedWebSearch,
  type ModelHostedWebSearchAction,
  type ModelInputPart,
  type ModelToolCall,
  type ModelTurn,
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
import {
  openAIErrorDiagnostic,
  openAIProviderFailure,
} from "./openai-errors.js";
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
const outputLimitContinuationText =
  "Continue the preceding response from where it was truncated.";
const outputLimitFunctionCallError =
  "Function call was not executed because the model response reached its output-token limit.";

type ResponsesTerminalStatus = "completed" | "incomplete";

interface ResponsesTerminalResponse {
  response: Record<string, unknown>;
  output: Array<Record<string, unknown>>;
  status: ResponsesTerminalStatus;
}

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
      const body = buildOpenAIResponsesBody(request);
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
      if (isRecord(response) && response.status === "failed") {
        throw openAIProviderFailure(
          decodeOpenAIResponsesFailedResponse(response, "OpenAI Responses"),
          "OpenAI Responses",
        );
      }
      const terminal = requireResponsesTerminalResponse(
        response,
        "OpenAI Responses",
      );
      const hostedWebSearches = webSearchesFromResponsesOutput(terminal.output);
      for (const search of hostedWebSearches) {
        await request.onHostedWebSearch?.(search);
      }
      return turnFromResponse(
        terminal,
        "OpenAI Responses",
        hostedWebSearches,
        request.runtimeProfile.capabilities.contextWindowTokens,
      );
      }, request.signal);
    },
  };
}

export function buildOpenAIResponsesBody(
  request: TransportRequest,
): Record<string, unknown> {
  const runtime = request.runtimeProfile;
  if (!isDirectRuntimeModelSource(runtime)) {
    throw new Error("OpenAI Responses requires a Direct API Profile.");
  }
  const { model, capabilities } = runtime;
  const reasoning = model.parameters.reasoning;
  const tools = mappedResponsesTools(request);
  const hostedWebSearchMaxUses = request.tools.find(
    (tool) => tool.type === "hosted_web_search",
  )?.maxUses;
  const generated: Record<string, unknown> = {
    model: model.model,
    instructions: request.systemInstructions,
    input: buildResponsesInput(request),
    store: false,
    include: [encryptedReasoningInclude],
    max_output_tokens: model.parameters.maxOutputTokens,
    ...(model.parameters.temperature !== undefined &&
    capabilities.temperature === "supported"
      ? { temperature: model.parameters.temperature }
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
    model.advanced.extraBody,
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

export function decodeOpenAIResponsesTerminalTurn(
  value: unknown,
  expectedStatus: ResponsesTerminalStatus,
  label: string,
  contextWindowTokens: number | undefined,
): ModelTurn {
  return turnFromResponse(
    requireResponsesTerminalResponse(value, label, expectedStatus),
    label,
    [],
    contextWindowTokens,
  );
}

export function openAIResponsesVisibleTextDelta(
  event: Record<string, unknown>,
  label: string,
): string | undefined {
  if (
    event.type !== "response.output_text.delta" &&
    event.type !== "response.refusal.delta"
  ) return undefined;
  if (typeof event.delta !== "string") {
    throw new Error(`${label} returned an invalid visible text delta.`);
  }
  return event.delta;
}

export function assertOpenAIResponsesTerminalWithoutPriorError(
  hadErrorEvent: boolean,
  label: string,
): void {
  if (hadErrorEvent) {
    throw new Error(`${label} returned a terminal response after an error event.`);
  }
}

export function decodeOpenAIResponsesFailedResponse(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const response = isRecord(value) && value.status === "failed" ? value : undefined;
  const error = isRecord(response?.error) ? response.error : undefined;
  const diagnostic = openAIErrorDiagnostic(error);
  if (!response || !error ||
    (diagnostic.code === undefined && diagnostic.type === undefined)) {
    throw new Error(`${label} returned a malformed failed response.`);
  }
  return response;
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
    if (!request.runtimeProfile.model.advanced.hostedTools?.webSearch) {
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
      const output = cloneJsonValue(state.output);
      if (state.outputLimited === true) {
        appendOutputLimitedResponsesInput(input, output);
      } else {
        input.push(...output);
      }
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

function appendOutputLimitedResponsesInput(
  input: Array<Record<string, unknown>>,
  output: unknown[],
): void {
  const functionCallIds: string[] = [];
  const seenFunctionCallIds = new Set<string>();
  for (const item of output) {
    if (!isRecord(item)) {
      throw new Error("OpenAI Responses output-limit replay state is invalid.");
    }
    input.push(item);
    if (item.type !== "function_call") continue;
    if (typeof item.call_id !== "string" || !item.call_id.trim()) {
      throw new Error("OpenAI Responses output-limit replay state is invalid.");
    }
    if (seenFunctionCallIds.has(item.call_id)) {
      throw new Error("OpenAI Responses output-limit replay state is invalid.");
    }
    seenFunctionCallIds.add(item.call_id);
    functionCallIds.push(item.call_id);
  }
  for (const callId of functionCallIds) {
    input.push({
      type: "function_call_output",
      call_id: callId,
      output: outputLimitFunctionCallError,
    });
  }
  if (functionCallIds.length === 0) {
    input.push({ role: "user", content: outputLimitContinuationText });
  }
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
  let pendingError: Record<string, unknown> | undefined;
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
    if (event.type === "error") {
      pendingError = event;
      continue;
    }
    await reportWebSearch(webSearchUpdateFromOpenAIEvent(event));
    const visibleDelta = openAIResponsesVisibleTextDelta(
      event,
      "OpenAI Responses",
    );
    if (visibleDelta !== undefined) {
      await request.onDelta?.(visibleDelta);
    } else if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      assertOpenAIResponsesTerminalWithoutPriorError(
        pendingError !== undefined,
        "OpenAI Responses",
      );
      const terminal = requireResponsesTerminalResponse(
        event.response,
        "OpenAI Responses",
        event.type === "response.completed" ? "completed" : "incomplete",
      );
      const hostedWebSearches = webSearchesFromResponsesOutput(terminal.output);
      for (const search of hostedWebSearches) {
        await reportWebSearch(search);
      }
      return turnFromResponse(
        terminal,
        "OpenAI Responses",
        hostedWebSearches,
        request.runtimeProfile.capabilities.contextWindowTokens,
      );
    } else if (event.type === "response.failed") {
      const failedResponse = decodeOpenAIResponsesFailedResponse(
        event.response,
        "OpenAI Responses",
      );
      if (Array.isArray(failedResponse.output) &&
        failedResponse.output.every(isRecord)) {
        const hostedWebSearches = webSearchesFromResponsesOutput(
          failedResponse.output,
        );
        for (const search of hostedWebSearches) {
          await reportWebSearch(search);
        }
      }
      throw openAIProviderFailure(failedResponse, "OpenAI Responses");
    } else if (event.type === "response.cancelled") {
      throw new Error("OpenAI Responses was cancelled.");
    }
  }
  if (pendingError) {
    throw openAIProviderFailure(pendingError, "OpenAI Responses");
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
  terminal: ResponsesTerminalResponse,
  label: string,
  hostedWebSearches?: ModelHostedWebSearch[],
  contextWindowTokens?: number,
): ModelTurn {
  const { response: value, output, status } = terminal;
  const outputContent = textFromOutput(output);
  if (value.output_text !== undefined && value.output_text !== null &&
    typeof value.output_text !== "string") {
    throw new Error(`${label} returned invalid output_text.`);
  }
  const content = outputContent ||
    (typeof value.output_text === "string" && value.output_text.trim()
      ? value.output_text
      : "");
  const citations = citationsFromResponsesOutput(output);
  const contextUsage = openAIContextUsage(value.usage, contextWindowTokens);
  const terminalWebSearches = hostedWebSearches ?? webSearchesFromResponsesOutput(output);
  if (status === "incomplete") {
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
    return {
      content: content || null,
      toolCalls: [],
      continuation: { reason: "output_limit" },
      ...(citations.length ? { citations } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(terminalWebSearches.length ? { hostedWebSearches: terminalWebSearches } : {}),
      providerState: {
        kind: "openai-responses",
        output: cloneJsonValue(output),
        outputLimited: true,
      },
    };
  }
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
    ...(contextUsage ? { contextUsage } : {}),
    ...(terminalWebSearches.length ? { hostedWebSearches: terminalWebSearches } : {}),
    providerState: {
      kind: "openai-responses",
      output: cloneJsonValue(output),
    },
  };
}

function openAIContextUsage(
  value: unknown,
  contextWindowTokens: number | undefined,
): ModelTurn["contextUsage"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Number.isSafeInteger(value.total_tokens) ||
    (value.total_tokens as number) < 0) {
    throw new TypeError("OpenAI Responses context usage is invalid.");
  }
  return contextWindowTokens === undefined
    ? undefined
    : requireModelContextUsage(value.total_tokens, contextWindowTokens);
}

function requireResponsesTerminalResponse(
  value: unknown,
  label: string,
  expectedStatus?: ResponsesTerminalStatus,
): ResponsesTerminalResponse {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    throw new Error(`${label} returned no output items.`);
  }
  if (!value.output.every(isRecord)) {
    throw new Error(`${label} returned a non-object output item.`);
  }
  if (value.status !== "completed" && value.status !== "incomplete") {
    throw new Error(`${label} returned an invalid terminal response status.`);
  }
  if (expectedStatus !== undefined && value.status !== expectedStatus) {
    throw new Error(
      `${label} returned a terminal event that contradicted its response status.`,
    );
  }
  if (
    (value.error !== undefined && value.error !== null) ||
    (value.status === "completed" &&
      value.incomplete_details !== undefined &&
      value.incomplete_details !== null)
  ) {
    throw new Error(`${label} returned contradictory terminal response metadata.`);
  }
  requireKnownResponsesOutputItems(value.output, value.status, label);
  return {
    response: value,
    output: value.output,
    status: value.status,
  };
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

function requireKnownResponsesOutputItems(
  output: Array<Record<string, unknown>>,
  terminalStatus: ResponsesTerminalStatus,
  label: string,
): void {
  const incompleteCallIds = new Set<string>();
  for (const item of output) {
    if (item.type === "message") {
      requireResponsesMessageContent(item, label);
    }
    if (terminalStatus === "completed" &&
      (item.type === "function_call" || item.type === "message") &&
      item.status !== undefined && item.status !== "completed") {
      throw new Error(
        `${label} returned a ${item.type} with non-completed status.`,
      );
    }
    if (terminalStatus === "incomplete" && item.type === "function_call") {
      requireIncompleteResponsesFunctionCall(item, label);
      requireUniqueToolCallId(item.call_id, incompleteCallIds, label);
    }
    if (item.type === "web_search_call") {
      requireResponsesWebSearchCall(item, terminalStatus, label);
    }
  }
}

function requireResponsesMessageContent(
  item: Record<string, unknown>,
  label: string,
): void {
  if (item.role !== "assistant") {
    throw new Error(`${label} returned an invalid message role.`);
  }
  if (!Array.isArray(item.content) || !item.content.every(isRecord)) {
    throw new Error(`${label} returned invalid message content.`);
  }
  for (const part of item.content) {
    if (part.type === "output_text") {
      if (typeof part.text !== "string" ||
        (part.annotations !== undefined &&
          (!Array.isArray(part.annotations) ||
            !part.annotations.every(isRecord)))) {
        throw new Error(`${label} returned invalid output_text content.`);
      }
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation.type === "url_citation") {
          requireResponsesUrlCitation(annotation, label);
        }
      }
    } else if (part.type === "refusal" && typeof part.refusal !== "string") {
      throw new Error(`${label} returned invalid refusal content.`);
    }
  }
}

function requireResponsesUrlCitation(
  annotation: Record<string, unknown>,
  label: string,
): void {
  if (typeof annotation.url !== "string" ||
    typeof annotation.title !== "string" ||
    !Number.isSafeInteger(annotation.start_index) ||
    (annotation.start_index as number) < 0 ||
    !Number.isSafeInteger(annotation.end_index) ||
    (annotation.end_index as number) < 0) {
    throw new Error(`${label} returned an invalid url_citation annotation.`);
  }
}

function requireIncompleteResponsesFunctionCall(
  item: Record<string, unknown>,
  label: string,
): void {
  if (typeof item.id !== "string" || !item.id.trim()) {
    throw new Error(`${label} returned an incomplete function_call with an invalid ID.`);
  }
  if (typeof item.call_id !== "string" || !item.call_id.trim()) {
    throw new Error(`${label} returned an incomplete function_call with an invalid call ID.`);
  }
  if (typeof item.name !== "string" || !item.name.trim()) {
    throw new Error(`${label} returned an incomplete function_call with an invalid name.`);
  }
  if (typeof item.arguments !== "string") {
    throw new Error(`${label} returned an incomplete function_call with invalid arguments.`);
  }
  if (item.status !== undefined &&
    item.status !== "completed" && item.status !== "incomplete") {
    throw new Error(`${label} returned an incomplete function_call with invalid status.`);
  }
}

function requireResponsesWebSearchCall(
  item: Record<string, unknown>,
  terminalStatus: ResponsesTerminalStatus,
  label: string,
): void {
  const validStatus = terminalStatus === "completed"
    ? item.status === "completed" || item.status === "failed"
    : item.status === "in_progress" || item.status === "searching" ||
      item.status === "incomplete" || item.status === "completed" ||
      item.status === "failed";
  if (typeof item.id !== "string" || !item.id.trim() ||
    !validStatus || !isRecord(item.action)) {
    throw new Error(`${label} returned an invalid web_search_call.`);
  }
  const action = item.action;
  if (!isWebSearchAction(action.type)) {
    throw new Error(`${label} returned an invalid web_search_call.`);
  }
  if ((action.query !== undefined && typeof action.query !== "string") ||
    (action.queries !== undefined &&
      (!Array.isArray(action.queries) ||
        !action.queries.every((query) => typeof query === "string"))) ||
    (action.sources !== undefined &&
      (!Array.isArray(action.sources) || !action.sources.every(isRecord)))) {
    throw new Error(`${label} returned an invalid web_search_call.`);
  }
  for (const source of Array.isArray(action.sources) ? action.sources : []) {
    if (source.type === "url" &&
      (typeof source.url !== "string" ||
        (source.title !== undefined && source.title !== null &&
          typeof source.title !== "string"))) {
      throw new Error(`${label} returned an invalid web_search_call.`);
    }
  }
  if ((action.type === "open_page" && typeof action.url !== "string") ||
    (action.type === "find_in_page" &&
      (typeof action.url !== "string" || typeof action.pattern !== "string"))) {
    throw new Error(`${label} returned an invalid web_search_call.`);
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
    throw new Error(`${label} returned a duplicate tool call ID.`);
  }
  seen.add(value);
  return value;
}

function textFromOutput(
  output: Array<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === "output_text") {
        parts.push(part.text as string);
      } else if (part.type === "refusal") {
        parts.push(part.refusal as string);
      }
    }
  }
  return parts.join("").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
