import { validateHeaderValue } from "node:http";
import { URL } from "node:url";

import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import {
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import {
  decodeDiscoveredModelCatalog,
  isDiscoveredModelId,
  MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_DISCOVERED_MODEL_COUNT,
} from "../catalog.js";
import {
  ModelAuthenticationError,
  ModelConnectionError,
  ModelRetryableError,
} from "../connection-error.js";
import type { ModelTurn } from "../contracts.js";
import { openAIResponsesInputSupport } from "../input-support.js";
import {
  assertApiKeyCanBeUsedInHttpHeader,
  isReasoningEffort,
  requireDirectApiConnection,
  type ModelConnection,
} from "../profile.js";
import type {
  DiscoveredModelInfo,
  TransportFactoryOptions,
  TransportRequest,
} from "../provider.js";
import {
  assertOpenAIResponsesTerminalWithoutPriorError,
  buildOpenAIResponsesBody,
  decodeOpenAIResponsesFailedResponse,
  decodeOpenAIResponsesTerminalTurn,
  openAIResponsesVisibleTextDelta,
} from "../transports/openai-responses.js";
import {
  openAIErrorDiagnostic,
  openAIProviderFailure,
  type OpenAIErrorDiagnostic,
} from "../transports/openai-errors.js";
import { readBoundedProviderErrorJson } from "../transports/provider-error-body.js";
import { readBoundedJsonResponse } from "../transports/response-body.js";
import { providerRetryAfterMs } from "../transports/retry-after.js";
import {
  assertServerSentEventResponse,
  parseServerSentEventData,
} from "../transports/server-sent-events.js";
import { withTransportContext } from "../transports/errors.js";
import {
  oauthDraftAsDirect,
  oauthRequestAsDirect,
} from "./direct-transport-adapter.js";
import type { OAuthModelProtocol } from "./protocol.js";

const codexBaseUrl = "https://chatgpt.com/backend-api/codex";
// The catalog is filtered by Codex protocol compatibility, not product version.
const codexCatalogCompatibilityVersion = "0.149.0";
const maximumTurnStateLength = 16_384;
const codexTurnStateByReconnectState = new WeakMap<object, string>();

interface CodexRequestProfile {
  connection: ModelConnection;
  requestHeaders?: Readonly<Record<string, string>>;
}

export function createOpenAICodexProtocol(
  options: TransportFactoryOptions = {},
): OAuthModelProtocol {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    async listModels(profile, credential, signal) {
      requireOpenAICredential(credential);
      const directProfile = oauthDraftAsDirect(profile, credential);
      return withTransportContext(directProfile, "model discovery", async () => {
        const endpoint = new URL(`${codexBaseUrl}/models`);
        endpoint.searchParams.set(
          "client_version",
          codexCatalogCompatibilityVersion,
        );
        const response = await fetchCodex(
          fetchImpl,
          endpoint.toString(),
          {
            method: "GET",
            headers: codexHeaders(directProfile),
            ...(signal ? { signal } : {}),
          },
          signal,
        );
        await assertCodexResponse(response, signal, false);
        const value = await readBoundedJsonResponse(response, {
          label: "ChatGPT Codex model catalog",
          ...(signal ? { signal } : {}),
        });
        return decodeCodexModels(value);
      }, signal);
    },
    async createToolTurn(request, credential) {
      requireOpenAICredential(credential);
      const directRequest = oauthRequestAsDirect(request, credential);
      const priorTurnState = codexTurnStateForRequest(request);
      return withTransportContext(
        directRequest.runtimeProfile.profile,
        "request",
        async () => {
          const body = buildOpenAIResponsesBody(directRequest);
          delete body.max_output_tokens;
          const response = await fetchCodex(
            fetchImpl,
            `${codexBaseUrl}/responses`,
            {
              method: "POST",
              headers: {
                ...codexHeaders(
                  directRequest.runtimeProfile.profile as CodexRequestProfile,
                ),
                accept: "text/event-stream",
                "content-type": "application/json",
                ...(priorTurnState
                  ? { "x-codex-turn-state": priorTurnState }
                  : {}),
              },
              body: JSON.stringify({
                ...body,
                stream: true,
                parallel_tool_calls: true,
              }),
              ...(request.signal ? { signal: request.signal } : {}),
            },
            request.signal,
          );
          const responseTurnState = rememberCodexTurnState(
            request.reconnectState,
            priorTurnState ?? boundedTurnState(
              response.headers.get("x-codex-turn-state"),
            ),
          );
          await assertCodexResponse(response, request.signal, true);
          if (!response.body) {
            throw new Error("ChatGPT Codex returned no response body.");
          }
          assertServerSentEventResponse(response, "ChatGPT Codex", request.signal);
          return readCodexTurn(
            response,
            directRequest,
            responseTurnState,
            request.reconnectState,
          );
        },
        request.signal,
      );
    },
  };
}

async function fetchCodex(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof NetworkProxyError) throw error;
    throw new ModelConnectionError();
  }
}

async function assertCodexResponse(
  response: Response,
  signal?: AbortSignal,
  generationRequest = false,
): Promise<void> {
  if (response.ok) return;
  const payload = await readBoundedProviderErrorJson(
    response,
    "ChatGPT Codex error response",
    signal,
  );
  const label = `ChatGPT Codex HTTP ${response.status}`;
  const diagnostic = openAIErrorDiagnostic(payload);
  const hasDiagnostic = diagnostic.code !== undefined || diagnostic.type !== undefined;
  const retryAfterMs = providerRetryAfterMs(response.headers);
  if (response.status === 401) {
    const failure = !hasDiagnostic
      ? new Error(`${label}: request failed`)
      : openAIProviderFailure(payload, label);
    throw new ModelAuthenticationError(failure.message);
  }
  const retryableStatus = generationRequest && (
    response.status === 408 || response.status === 409 ||
    response.status === 429 || response.status >= 500
  );
  if (hasDiagnostic) {
    throw openAIProviderFailure(payload, label, {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(retryableStatus ? { unknownIsRetryable: true } : {}),
    });
  }
  if (retryableStatus) {
    throw new ModelRetryableError(
      `${label}: retryable request failure`,
      retryAfterMs,
    );
  }
  throw new Error(`${label}: request failed`);
}

async function readCodexTurn(
  response: Response,
  request: TransportRequest,
  priorTurnState: string | undefined,
  reconnectState: object | undefined,
): Promise<ModelTurn> {
  const completedOutputItems = new Map<number, Record<string, unknown>>();
  let pendingError: OpenAIErrorDiagnostic | undefined;
  let malformedPendingError = false;
  let turnState = rememberCodexTurnState(
    reconnectState,
    priorTurnState ?? boundedTurnState(
      response.headers.get("x-codex-turn-state"),
    ),
  );
  for await (const data of parseServerSentEventData(response.body!, request.signal)) {
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("ChatGPT Codex returned invalid stream JSON.");
    }
    if (!isRecord(event)) {
      throw new Error("ChatGPT Codex returned a non-object stream event.");
    }
    if (event.type === "error") {
      const diagnostic = openAIErrorDiagnostic(event);
      if (diagnostic.code === undefined && diagnostic.type === undefined) {
        malformedPendingError = true;
      } else if (
        (pendingError?.code !== undefined && diagnostic.code !== undefined &&
          pendingError.code !== diagnostic.code) ||
        (pendingError?.type !== undefined && diagnostic.type !== undefined &&
          pendingError.type !== diagnostic.type)
      ) {
        throw new Error("ChatGPT Codex returned conflicting error events.");
      } else {
        const code = pendingError?.code ?? diagnostic.code;
        const type = pendingError?.type ?? diagnostic.type;
        pendingError = {
          ...(code === undefined ? {} : { code }),
          ...(type === undefined ? {} : { type }),
        };
      }
      continue;
    }
    const metadataTurnState = codexTurnStateFromMetadata(event);
    if (!turnState && metadataTurnState) {
      turnState = rememberCodexTurnState(reconnectState, metadataTurnState);
    }
    if (event.type === "response.output_item.done") {
      if (!isRecord(event.item)) {
        throw new Error("ChatGPT Codex returned an invalid completed output item.");
      }
      if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0) {
        throw new Error("ChatGPT Codex returned an invalid completed output index.");
      }
      const outputIndex = Number(event.output_index);
      if (completedOutputItems.has(outputIndex)) {
        throw new Error("ChatGPT Codex returned a duplicate completed output index.");
      }
      completedOutputItems.set(outputIndex, event.item);
      continue;
    }
    const visibleDelta = openAIResponsesVisibleTextDelta(
      event,
      "ChatGPT Codex",
    );
    if (visibleDelta !== undefined) {
      await request.onDelta?.(visibleDelta);
      continue;
    }
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      assertOpenAIResponsesTerminalWithoutPriorError(
        malformedPendingError || pendingError !== undefined,
        "ChatGPT Codex",
      );
      const expectedStatus = event.type === "response.completed"
        ? "completed"
        : "incomplete";
      const turn = decodeOpenAIResponsesTerminalTurn(
        codexTerminalResponse(event.response, expectedStatus, completedOutputItems),
        expectedStatus,
        "ChatGPT Codex",
        request.runtimeProfile.capabilities.contextWindowTokens,
      );
      return withCodexTurnState(turn, turnState);
    }
    if (event.type === "response.failed") {
      const retryAfterMs = providerRetryAfterMs(response.headers);
      throw codexProviderFailure(event.response, retryAfterMs);
    }
    if (event.type === "response.cancelled") {
      throw new Error("ChatGPT Codex was cancelled.");
    }
  }
  if (malformedPendingError) {
    throw new Error("ChatGPT Codex returned a malformed error event.");
  }
  if (pendingError !== undefined) {
    const retryAfterMs = providerRetryAfterMs(response.headers);
    throw openAIProviderFailure(
      pendingError,
      "ChatGPT Codex",
      {
        unknownIsRetryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }
  throw new ModelConnectionError("ChatGPT Codex stream ended without a terminal response.");
}

function codexProviderFailure(
  value: unknown,
  retryAfterMs: number | undefined,
): Error {
  const response = decodeOpenAIResponsesFailedResponse(value, "ChatGPT Codex");
  return openAIProviderFailure(response, "ChatGPT Codex", {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    unknownIsRetryable: true,
  });
}

function codexTerminalResponse(
  value: unknown,
  expectedStatus: "completed" | "incomplete",
  completedOutputItems: ReadonlyMap<number, Record<string, unknown>>,
): unknown {
  if (!isRecord(value)) return value;
  const terminalOutput = value.output === undefined ||
      (Array.isArray(value.output) && value.output.length === 0)
    ? orderedCodexOutput(completedOutputItems)
    : value.output;
  return {
    ...value,
    ...(value.status === undefined ? { status: expectedStatus } : {}),
    output: terminalOutput,
  };
}

function orderedCodexOutput(
  completedOutputItems: ReadonlyMap<number, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (let index = 0; index < completedOutputItems.size; index += 1) {
    const item = completedOutputItems.get(index);
    if (!item) {
      throw new Error("ChatGPT Codex returned incomplete completed output indices.");
    }
    output.push(item);
  }
  return output;
}

function codexTurnStateForRequest(
  request: TransportRequest,
): string | undefined {
  const remembered = request.reconnectState
    ? codexTurnStateByReconnectState.get(request.reconnectState)
    : undefined;
  if (remembered) return remembered;
  return rememberCodexTurnState(
    request.reconnectState,
    codexTurnStateFromMessages(request),
  );
}

function rememberCodexTurnState(
  reconnectState: object | undefined,
  turnState: string | undefined,
): string | undefined {
  if (!reconnectState) return turnState;
  const remembered = codexTurnStateByReconnectState.get(reconnectState);
  if (remembered) return remembered;
  if (turnState) codexTurnStateByReconnectState.set(reconnectState, turnState);
  return turnState;
}

function withCodexTurnState(
  turn: ModelTurn,
  turnState: string | undefined,
): ModelTurn {
  if (!turnState || !isRecord(turn.providerState) ||
    turn.providerState.kind !== "openai-responses" ||
    !Array.isArray(turn.providerState.output)) {
    return turn;
  }
  return {
    ...turn,
    providerState: {
      ...turn.providerState,
      codexTurnState: turnState,
    },
  };
}

function codexTurnStateFromMessages(request: TransportRequest): string | undefined {
  for (let index = request.agentMessages.length - 1; index >= 0; index -= 1) {
    const message = request.agentMessages[index];
    if (message?.role !== "assistant" || !isRecord(message.providerState) ||
      message.providerState.kind !== "openai-responses") {
      continue;
    }
    const turnState = boundedTurnState(message.providerState.codexTurnState);
    if (turnState) return turnState;
  }
  return undefined;
}

function codexTurnStateFromMetadata(event: Record<string, unknown>): string | undefined {
  if (event.type !== "response.metadata" || !isRecord(event.headers)) {
    return undefined;
  }
  for (const [name, value] of Object.entries(event.headers)) {
    if (name.toLowerCase() === "x-codex-turn-state") {
      return boundedTurnState(Array.isArray(value) ? value[0] : value);
    }
  }
  return undefined;
}

function boundedTurnState(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > maximumTurnStateLength) {
    return undefined;
  }
  try {
    validateHeaderValue("x-codex-turn-state", value);
    return value;
  } catch {
    return undefined;
  }
}

function codexHeaders(
  profile: CodexRequestProfile,
): Record<string, string> {
  const connection = requireDirectApiConnection(profile);
  assertApiKeyCanBeUsedInHttpHeader(connection.apiKey);
  const headers: Record<string, string> = {
    authorization: `Bearer ${connection.apiKey}`,
    ...(profile.requestHeaders ?? {}),
  };
  for (const [name, value] of Object.entries(headers)) {
    validateHeaderValue(name, value);
  }
  return headers;
}

function decodeCodexModels(value: unknown): DiscoveredModelInfo[] {
  if (!isRecord(value) || !Array.isArray(value.models) ||
    value.models.length > MAX_DISCOVERED_MODEL_COUNT) {
    throw new Error("ChatGPT Codex returned an invalid model catalog.");
  }
  const models: DiscoveredModelInfo[] = [];
  for (const raw of value.models) {
    const model = decodeCodexModel(raw);
    if (!model) {
      throw new Error("ChatGPT Codex returned an invalid model catalog.");
    }
    if (model !== "hidden") models.push(model);
  }
  const decoded = decodeDiscoveredModelCatalog(models);
  if (!decoded) throw new Error("ChatGPT Codex returned an invalid model catalog.");
  return decoded;
}

function decodeCodexModel(
  value: unknown,
): DiscoveredModelInfo | "hidden" | undefined {
  if (!isRecord(value) || !isDiscoveredModelId(value.slug) ||
    typeof value.display_name !== "string" || !value.display_name.trim()) {
    return undefined;
  }
  if (value.visibility !== undefined && value.visibility !== "list") {
    return "hidden";
  }
  const capabilities: DiscoveredModelInfo["capabilities"] = {
    tools: true,
    streaming: true,
    temperature: "unsupported",
  };
  let providerReported: DiscoveredModelInfo["providerReported"];
  const contextWindow = value.context_window ?? value.max_context_window;
  if (contextWindow !== undefined) {
    if (!Number.isSafeInteger(contextWindow) ||
      (contextWindow as number) <= 0 ||
      (contextWindow as number) > MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS) {
      return undefined;
    }
    capabilities.contextWindowTokens = contextWindow as number;
  }
  if (value.supported_reasoning_levels !== undefined) {
    if (!Array.isArray(value.supported_reasoning_levels)) return undefined;
    const efforts: NonNullable<
      NonNullable<DiscoveredModelInfo["capabilities"]["reasoning"]>["efforts"]
    > = [];
    let canDisable = false;
    for (const level of value.supported_reasoning_levels) {
      if (!isRecord(level) || typeof level.effort !== "string") return undefined;
      if (level.effort === "none") {
        canDisable = true;
      } else if (isReasoningEffort(level.effort) && !efforts.includes(level.effort)) {
        efforts.push(level.effort);
      } else if (!isReasoningEffort(level.effort)) {
        return undefined;
      }
    }
    capabilities.reasoning = efforts.length || canDisable
      ? {
          supported: true,
          canDisable,
          efforts,
          budgetTokens: false,
          strategy: "effort",
        }
      : {
          supported: false,
          canDisable: false,
          efforts: [],
          budgetTokens: false,
          strategy: "none",
        };
  }
  if (value.input_modalities !== undefined) {
    if (!Array.isArray(value.input_modalities) ||
      !value.input_modalities.every((modality) =>
        typeof modality === "string" && modality.trim()
      )) {
      return undefined;
    }
    const inputModalities = [...new Set(
      value.input_modalities.map((modality) => modality.trim().toLocaleLowerCase()),
    )];
    capabilities.inputs = {
      image: openAIResponsesInputSupport.image &&
        inputModalities.includes("image"),
      audio: openAIResponsesInputSupport.audio &&
        inputModalities.includes("audio"),
      pdf: openAIResponsesInputSupport.pdf && inputModalities.includes("pdf"),
    };
    providerReported = { inputs: { inputModalities } };
  }
  return {
    id: value.slug,
    displayName: value.display_name,
    capabilities,
    ...(providerReported === undefined ? {} : { providerReported }),
  };
}

function requireOpenAICredential(
  credential: OAuthCredential,
): asserts credential is Extract<OAuthCredential, { provider: "openai" }> {
  if (credential.provider !== "openai") {
    throw new Error("ChatGPT Codex protocol received another provider's credential.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
