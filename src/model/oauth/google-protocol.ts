import { randomUUID } from "node:crypto";

import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import {
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import {
  requireModelContextUsage,
  type ModelInputPart,
  type ModelToolCall,
  type ModelTurn,
} from "../contracts.js";
import { cloneJsonValue } from "../json-clone.js";
import type {
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
import {
  assertBinaryInputWithinLimits,
  assertImageInputEnabled,
  assertNeverInputPart,
  unsupportedInputPart,
} from "../transports/input-parts.js";
import {
  assertServerSentEventResponse,
  parseServerSentEventData,
} from "../transports/server-sent-events.js";
import { readBoundedJsonResponse } from "../transports/response-body.js";
import { cancelStreamBestEffort } from "../transports/stream-cancel.js";
import { providerRetryAfterMs } from "../transports/retry-after.js";
import { decodeGoogleCloudCodeAssistCatalog } from "./google-catalog.js";
import { isRecord, requireOAuthJson } from "./oauth-utils.js";
import type { OAuthModelProtocol } from "./protocol.js";

const codeAssistBaseUrl = "https://cloudcode-pa.googleapis.com/v1internal";
const generationEndpoint = `${codeAssistBaseUrl}:streamGenerateContent?alt=sse`;
const catalogEndpoint = `${codeAssistBaseUrl}:retrieveUserQuota`;
const googlePromptIdByReconnectState = new WeakMap<object, string>();
const googleErrorInfoType = "type.googleapis.com/google.rpc.ErrorInfo";
const googleQuotaFailureType = "type.googleapis.com/google.rpc.QuotaFailure";
const googleRetryInfoType = "type.googleapis.com/google.rpc.RetryInfo";
const googlePerMinuteRetryDelayMs = 60_000;
const retryableGoogleStatuses = new Set([
  "ABORTED",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
]);

type GooglePart = Record<string, unknown>;
interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

export function createGoogleCloudCodeAssistProtocol(
  options: TransportFactoryOptions = {},
): OAuthModelProtocol {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    async listModels(_profile, credential, signal) {
      requireGoogleCredential(credential);
      return loadGoogleCatalog(fetchImpl, credential, signal);
    },
    async createToolTurn(request, credential) {
      requireGoogleCredential(credential);
      assertNoGoogleAudioInput(request);
      assertBinaryInputWithinLimits(request);
      const userPromptId = googlePromptId(request);
      const response = await fetchGoogle(
        fetchImpl,
        request,
        credential,
        userPromptId,
      );
      return readGoogleTurn(response, request, userPromptId);
    },
  };
}

async function loadGoogleCatalog(
  fetchImpl: typeof fetch,
  credential: Extract<OAuthCredential, { provider: "google" }>,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetchImpl(catalogEndpoint, {
      method: "POST",
      headers: googleHeaders(credential.accessToken, "application/json"),
      body: JSON.stringify({ project: credential.projectId }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof NetworkProxyError) throw error;
    throw new Error("Google Cloud Code Assist model discovery connection failed.");
  }
  if (response.status === 401) {
    cancelStreamBestEffort(response.body, signal?.reason);
    throwIfAborted(signal);
    throw new ModelAuthenticationError(
      "Google Cloud Code Assist model discovery HTTP 401: request failed",
    );
  }
  const value = await requireOAuthJson(
    response,
    "Google Cloud Code Assist model discovery",
    signal,
  );
  const catalog = decodeGoogleCloudCodeAssistCatalog(value);
  if (!catalog) {
    throw new Error("Google Cloud Code Assist returned an invalid model catalog.");
  }
  return catalog;
}

function assertNoGoogleAudioInput(request: TransportRequest): void {
  for (const part of request.currentUserContent) {
    if (part.type === "audio") unsupportedInputPart(part);
  }
}

async function fetchGoogle(
  fetchImpl: typeof fetch,
  request: TransportRequest,
  credential: Extract<OAuthCredential, { provider: "google" }>,
  userPromptId: string,
): Promise<Response> {
  const body = JSON.stringify(buildGoogleRequest(
    request,
    credential.projectId,
    userPromptId,
  ));
  let response: Response;
  try {
    response = await fetchImpl(generationEndpoint, {
      method: "POST",
      headers: googleHeaders(credential.accessToken, "text/event-stream"),
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throwIfAborted(request.signal);
    if (error instanceof NetworkProxyError) throw error;
    throw new ModelConnectionError("Google Cloud Code Assist connection failed.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      cancelStreamBestEffort(response.body, request.signal?.reason);
      throwIfAborted(request.signal);
      throw new ModelAuthenticationError(
        "Google Cloud Code Assist HTTP 401: request failed",
      );
    }
    const payload = await readGoogleErrorPayload(response, request.signal);
    const error = isRecord(payload) ? payload.error : undefined;
    throw googleProviderError(error, response.headers, response.status);
  }
  if (!response.body) {
    throw new Error("Google Cloud Code Assist returned no response body.");
  }
  assertServerSentEventResponse(response, "Google Cloud Code Assist", request.signal);
  return response;
}

function googleHeaders(
  accessToken: string,
  accept: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept,
    "content-type": "application/json",
    "user-agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "x-goog-api-client": "gl-node/24",
  };
}

function buildGoogleRequest(
  transport: TransportRequest,
  projectId: string,
  userPromptId: string,
): Record<string, unknown> {
  const model = transport.runtimeProfile.model.model;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: transport.runtimeProfile.capabilities.maxOutputTokens ?? 65_535,
  };
  const reasoning = transport.runtimeProfile.model.parameters.reasoning;
  const thinking = googleThinkingConfig(
    reasoning,
    transport.runtimeProfile.capabilities.reasoning,
  );
  if (thinking) generationConfig.thinkingConfig = thinking;
  const tools = transport.tools
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parametersJsonSchema: tool.function.parameters ?? {
        type: "object",
        properties: {},
      },
    }));
  return {
    project: projectId,
    model,
    user_prompt_id: userPromptId,
    request: {
      contents: googleContents(transport),
      systemInstruction: {
        parts: [{ text: transport.systemInstructions }],
      },
      generationConfig,
      ...(tools.length
        ? {
            tools: [{ functionDeclarations: tools }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          }
        : {}),
    },
  };
}

function googlePromptId(request: TransportRequest): string {
  const reconnectState = request.reconnectState;
  if (reconnectState) {
    const existing = googlePromptIdByReconnectState.get(reconnectState);
    if (existing) return existing;
  }
  const promptId = googleContinuationPromptId(request) ?? randomUUID();
  if (reconnectState) {
    googlePromptIdByReconnectState.set(reconnectState, promptId);
  }
  return promptId;
}

function googleContinuationPromptId(
  request: TransportRequest,
): string | undefined {
  for (let index = request.agentMessages.length - 1; index >= 0; index -= 1) {
    const message = request.agentMessages[index];
    if (message?.role === "tool") continue;
    if (message?.role !== "assistant") return undefined;
    const state = message.providerState;
    return isRecord(state) &&
        state.kind === "google-cloud-code-assist" &&
        typeof state.userPromptId === "string" && state.userPromptId
      ? state.userPromptId
      : undefined;
  }
  return undefined;
}

function googleContents(request: TransportRequest): GoogleContent[] {
  const contents: GoogleContent[] = [
    ...request.history.map((message): GoogleContent => message.role === "assistant"
      ? { role: "model", parts: [{ text: message.content }] }
      : { role: "user", parts: mapGoogleInputParts(request, message.content) }),
    {
      role: "user",
      parts: mapGoogleInputParts(request, request.currentUserContent),
    },
  ];
  const toolCorrelations = new Map<string, {
    name: string;
    providerId?: string;
  }>();
  for (const message of request.agentMessages) {
    if (message.role === "user") {
      appendGoogleContent(contents, "user", [{ text: message.content }]);
      continue;
    }
    if (message.role === "assistant") {
      const state = message.providerState;
      const parts: GooglePart[] = isRecord(state) &&
          state.kind === "google-cloud-code-assist" &&
          Array.isArray(state.parts) &&
          state.parts.every(isRecord)
        ? cloneJsonValue(state.parts as GooglePart[])
        : [
            ...(message.content ? [{ text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              functionCall: {
                id: call.id,
                name: call.name,
                args: parseArguments(call.arguments),
              },
            })),
          ];
      const providerCalls = parts.flatMap((part) =>
        isRecord(part.functionCall) ? [part.functionCall] : []
      );
      for (const [index, call] of message.toolCalls.entries()) {
        const providerId = providerCalls[index]?.id;
        toolCorrelations.set(call.id, {
          name: call.name,
          ...(typeof providerId === "string" && providerId
            ? { providerId }
            : {}),
        });
      }
      appendGoogleContent(contents, "model", parts);
      continue;
    }
    const correlation = toolCorrelations.get(message.toolCallId);
    if (!correlation) {
      throw new Error("Google tool replay is missing the original function name.");
    }
    appendGoogleContent(contents, "user", [{
      functionResponse: {
        ...(correlation.providerId ? { id: correlation.providerId } : {}),
        name: correlation.name,
        response: { result: message.content },
      },
    }]);
  }
  return contents;
}

function appendGoogleContent(
  contents: GoogleContent[],
  role: GoogleContent["role"],
  parts: GooglePart[],
): void {
  const previous = contents.at(-1);
  if (previous?.role === role) {
    previous.parts.push(...parts);
    return;
  }
  contents.push({ role, parts });
}

function mapGoogleInputParts(
  request: TransportRequest,
  parts: readonly ModelInputPart[],
): GooglePart[] {
  return parts.map((part): GooglePart => {
    switch (part.type) {
      case "text":
        return { text: part.text };
      case "image":
        assertImageInputEnabled(request);
        return {
          inlineData: {
            mimeType: part.mediaType,
            data: part.base64,
          },
        };
      case "document":
      case "audio":
        return unsupportedInputPart(part);
      default:
        return assertNeverInputPart(part);
    }
  });
}

async function readGoogleTurn(
  response: Response,
  request: TransportRequest,
  userPromptId: string,
): Promise<ModelTurn> {
  const text: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  const replayParts: GooglePart[] = [];
  let totalTokens: number | undefined;
  let finishReason: string | undefined;
  for await (const data of parseServerSentEventData(response.body!, request.signal)) {
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      throw new Error("Google Cloud Code Assist returned invalid stream JSON.");
    }
    if (!isRecord(chunk)) {
      throw new Error("Google Cloud Code Assist returned a non-object stream event.");
    }
    if (chunk.error !== undefined && chunk.error !== null) {
      if (!isRecord(chunk.error)) {
        throw new Error("Google Cloud Code Assist stream error.");
      }
      throw googleProviderError(chunk.error, response.headers);
    }
    if (chunk.response === undefined || chunk.response === null) continue;
    if (!isRecord(chunk.response)) {
      throw new Error("Google Cloud Code Assist returned an invalid response event.");
    }
    const googleResponse = chunk.response;
    const promptFeedback = isRecord(googleResponse.promptFeedback)
      ? googleResponse.promptFeedback
      : undefined;
    if (promptFeedback?.blockReason !== undefined) {
      throw new Error("Google Cloud Code Assist blocked the prompt.");
    }
    const candidate = Array.isArray(googleResponse.candidates) &&
        isRecord(googleResponse.candidates[0])
      ? googleResponse.candidates[0]
      : undefined;
    const candidateFinishReason = googleFinishReason(candidate?.finishReason);
    const content = isRecord(candidate?.content) ? candidate.content : undefined;
    const parts = Array.isArray(content?.parts)
      ? content.parts.filter(isRecord)
      : [];
    for (const part of parts) {
      replayParts.push(cloneJsonValue(part));
      if (typeof part.text === "string" && part.thought !== true) {
        text.push(part.text);
        await request.onDelta?.(part.text);
      }
      const call = isRecord(part.functionCall) ? part.functionCall : undefined;
      if (call) {
        const name = call.name;
        if (typeof name !== "string" || !name) {
          throw new Error("Google Cloud Code Assist returned a tool call without a name.");
        }
        const id = typeof call.id === "string" && call.id
          ? call.id
          : `google-call-${toolCalls.length + 1}`;
        if (toolCalls.some((existing) => existing.id === id)) {
          throw new Error("Google Cloud Code Assist returned duplicate tool call IDs.");
        }
        toolCalls.push({
          id,
          name,
          arguments: JSON.stringify(isRecord(call.args) ? call.args : {}),
        });
      }
    }
    if (candidateFinishReason) finishReason = candidateFinishReason;
    const usage = isRecord(googleResponse.usageMetadata)
      ? googleResponse.usageMetadata
      : undefined;
    if (Number.isSafeInteger(usage?.totalTokenCount) &&
      (usage?.totalTokenCount as number) >= 0) {
      totalTokens = usage!.totalTokenCount as number;
    }
  }
  if (!finishReason) {
    throw new ModelConnectionError(
      "Google Cloud Code Assist stream ended without a finish reason.",
    );
  }
  if (finishReason === "MAX_TOKENS" && toolCalls.length > 0) {
    throw new Error(
      "Google Cloud Code Assist reached its output limit with an incomplete tool call.",
    );
  }
  const content = text.join("");
  if (!content && toolCalls.length === 0) {
    throw new Error("Google Cloud Code Assist returned an empty response.");
  }
  const contextWindow = request.runtimeProfile.capabilities.contextWindowTokens;
  return {
    content: content || null,
    toolCalls,
    ...(totalTokens !== undefined && contextWindow !== undefined
      ? { contextUsage: requireModelContextUsage(totalTokens, contextWindow) }
      : {}),
    ...(finishReason === "MAX_TOKENS"
      ? { continuation: { reason: "output_limit" as const } }
      : {}),
    providerState: {
      kind: "google-cloud-code-assist",
      parts: replayParts,
      userPromptId,
    },
  };
}

function googleProviderError(
  value: unknown,
  headers: Headers,
  httpStatus?: number,
): Error {
  if (!isRecord(value)) {
    return googleFallbackError(httpStatus, headers);
  }
  const reason = googleErrorReason(value);
  const status = googleErrorStatus(value.status);
  if (reason === "VALIDATION_REQUIRED" || status === "VALIDATION_REQUIRED") {
    return new Error(
      "Google Cloud Code Assist requires account validation before continuing.",
    );
  }
  if (
    reason === "QUOTA_EXHAUSTED" || status === "QUOTA_EXHAUSTED" ||
    reason === "INSUFFICIENT_G1_CREDITS_BALANCE" ||
    status === "INSUFFICIENT_G1_CREDITS_BALANCE"
  ) {
    return new Error("Google Cloud Code Assist quota is exhausted for this account.");
  }
  if (
    reason === "MODEL_CAPACITY_EXHAUSTED" ||
    status === "MODEL_CAPACITY_EXHAUSTED" ||
    reason === "MODEL_CAPACITY_EXCEEDED" ||
    status === "MODEL_CAPACITY_EXCEEDED"
  ) {
    return new Error("Google Cloud Code Assist model capacity is exhausted.");
  }
  const quotaWindow = googleQuotaWindow(value);
  if (quotaWindow === "daily") {
    return new Error("Google Cloud Code Assist daily quota is exhausted.");
  }
  const retryAfterMs = googleRetryAfterMs(value, headers);
  if (quotaWindow === "per-minute") {
    return new ModelRetryableError(
      "Google Cloud Code Assist rate limit was reached.",
      retryAfterMs ?? googlePerMinuteRetryDelayMs,
    );
  }
  const code = googleErrorCode(value.code) ?? googleErrorCode(value.status);
  if (reason === "RATE_LIMIT_EXCEEDED") {
    return new ModelRetryableError(
      "Google Cloud Code Assist rate limit was reached.",
      retryAfterMs,
    );
  }
  if (status !== undefined) {
    return retryableGoogleStatuses.has(status)
      ? new ModelRetryableError(
          "Google Cloud Code Assist temporarily could not complete the request.",
          retryAfterMs,
        )
      : googleFatalFallbackError(httpStatus);
  }
  if (code !== undefined && isRetryableGoogleHttpStatus(code)) {
    return new ModelRetryableError(
      "Google Cloud Code Assist temporarily could not complete the request.",
      retryAfterMs,
    );
  }
  return googleFallbackError(httpStatus, headers);
}

function googleFallbackError(
  httpStatus: number | undefined,
  headers: Headers,
): Error {
  if (httpStatus !== undefined && isRetryableGoogleHttpStatus(httpStatus)) {
    return new ModelRetryableError(
      `Google Cloud Code Assist HTTP ${httpStatus}: retryable request failure`,
      providerRetryAfterMs(headers),
    );
  }
  return googleFatalFallbackError(httpStatus);
}

function googleFatalFallbackError(httpStatus: number | undefined): Error {
  return new Error(
    httpStatus === undefined
      ? "Google Cloud Code Assist stream error."
      : `Google Cloud Code Assist HTTP ${httpStatus}: request failed`,
  );
}

async function readGoogleErrorPayload(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await readBoundedJsonResponse(response, {
      label: "Google Cloud Code Assist error response",
      maximumBytes: 64 * 1024,
      ...(signal ? { signal } : {}),
    });
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

function googleErrorReason(value: Record<string, unknown>): string | undefined {
  const direct = googleErrorStatus(value.reason);
  if (direct) return direct;
  if (!Array.isArray(value.details)) return undefined;
  for (const detail of value.details) {
    if (
      !isRecord(detail) ||
      detail["@type"] !== googleErrorInfoType
    ) continue;
    const reason = googleErrorStatus(detail.reason);
    if (reason) return reason;
  }
  return undefined;
}

function googleErrorStatus(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function googleErrorCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 100 && value <= 599
    ? value
    : undefined;
}

function googleQuotaWindow(
  value: Record<string, unknown>,
): "daily" | "per-minute" | undefined {
  if (!Array.isArray(value.details)) return undefined;
  // Cloud Code Assist's Gemini client encodes these windows in quotaId and
  // treats other RESOURCE_EXHAUSTED quota IDs as transient.
  let perMinute = false;
  for (const detail of value.details) {
    if (
      !isRecord(detail) ||
      detail["@type"] !== googleQuotaFailureType ||
      !Array.isArray(detail.violations)
    ) continue;
    for (const violation of detail.violations) {
      if (!isRecord(violation) || typeof violation.quotaId !== "string") continue;
      if (violation.quotaId.includes("PerDay") || violation.quotaId.includes("Daily")) {
        return "daily";
      }
      if (violation.quotaId.includes("PerMinute")) perMinute = true;
    }
  }
  return perMinute ? "per-minute" : undefined;
}

function googleRetryAfterMs(
  value: Record<string, unknown>,
  headers: Headers,
): number | undefined {
  const headerDelay = providerRetryAfterMs(headers);
  if (headerDelay !== undefined) return headerDelay;
  if (!Array.isArray(value.details)) return undefined;
  for (const detail of value.details) {
    if (!isRecord(detail) || detail["@type"] !== googleRetryInfoType) continue;
    if (typeof detail.retryDelay !== "string") return undefined;
    const match = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?s$/u.exec(detail.retryDelay);
    if (!match) return undefined;
    const milliseconds = Math.ceil(Number(detail.retryDelay.slice(0, -1)) * 1_000);
    return milliseconds;
  }
  return undefined;
}

function isRetryableGoogleHttpStatus(status: number): boolean {
  return status === 429 || status === 499 ||
    (status >= 500 && status <= 599 && status !== 501);
}

function googleFinishReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "STOP" || value === "MAX_TOKENS") return value;
  throw new Error("Google Cloud Code Assist did not complete the response.");
}

function googleThinkingConfig(
  reasoning: TransportRequest["runtimeProfile"]["model"]["parameters"]["reasoning"],
  capabilities: TransportRequest["runtimeProfile"]["capabilities"]["reasoning"],
): Record<string, unknown> | undefined {
  if (reasoning.mode === "default") return undefined;
  if (reasoning.mode === "disabled") {
    if (!capabilities.canDisable || capabilities.strategy !== "budget-thinking") {
      throw new Error("This Google model cannot explicitly disable reasoning.");
    }
    return { thinkingBudget: 0 };
  }
  if (reasoning.budgetTokens !== undefined && !capabilities.budgetTokens) {
    throw new Error("This Google model does not accept a custom thinking budget.");
  }
  const effort = reasoning.effort ??
    (capabilities.efforts.includes("medium") ? "medium" : capabilities.efforts.at(-1));
  if (!effort || !capabilities.efforts.includes(effort)) {
    throw new Error("This Google model does not support the selected reasoning effort.");
  }
  if (capabilities.strategy === "effort") {
    return {
      includeThoughts: true,
      thinkingLevel: effort.toUpperCase(),
    };
  }
  if (capabilities.strategy !== "budget-thinking") {
    throw new Error("This Google model has no supported reasoning strategy.");
  }
  const effortBudgets = {
    minimal: 1_024,
    low: 4_096,
    medium: 8_192,
    high: 24_576,
    xhigh: 32_768,
    max: 32_768,
    ultra: 32_768,
  } as const;
  return {
    includeThoughts: true,
    thinkingBudget: reasoning.budgetTokens ??
      effortBudgets[effort],
  };
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireGoogleCredential(
  credential: OAuthCredential,
): asserts credential is Extract<OAuthCredential, { provider: "google" }> {
  if (credential.provider !== "google") {
    throw new Error("Google protocol received another provider's credential.");
  }
}
