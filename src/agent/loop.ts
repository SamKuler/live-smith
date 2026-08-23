import { createHash } from "node:crypto";

import {
  observationRequestForAction,
  validateAgentPlan,
  summarizeAgentAction,
  summarizeActionPlan,
  type AgentAction,
  type AgentObservationRequest,
  type AgentPlan,
} from "./actions.js";
import {
  progressLabelForActionPlan,
  progressLabelForToolCall,
} from "./progress.js";
import type {
  ModelCitation,
  ModelConversationMessage,
  ModelHostedWebSearch,
  ModelToolCall,
  ModelTurn,
} from "../model/contracts.js";
import {
  isModelHostedWebSearch,
} from "../model/web-search.js";
import { normalizeModelCitations } from "../model/citations.js";
import { HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND } from "../model/tools.js";
import { throwIfAborted } from "../runtime/host.js";

export type AgentLoopTraceEvent =
  | { kind: "assistant"; content: string; citations?: ModelCitation[] }
  | {
      kind: "web_search";
      content: string;
      webSearch: ModelHostedWebSearch;
    }
  | { kind: "tool_call"; name: string; content: string }
  | { kind: "tool_result"; name: string; content: string }
  | { kind: "apply_requested"; content: string }
  | { kind: "apply_auto_approved"; content: string }
  | {
      kind: "apply_result";
      content: string;
      recovery?: AgentRecoveryLedgerUpdate;
    }
  | { kind: "error"; content: string };

export type AgentConfirmationDecision =
  | { confirmed: boolean; source: "user" }
  | {
      confirmed: true;
      source: "automatic";
      mode: "low-risk" | "everything";
    };

export interface AgentRecoveryLedgerUpdate {
  active: boolean;
  completedActionDigests: string[];
}

export interface AgentLoopInitialRecoveryState {
  completedActionDigests: readonly string[];
  unresolvedFailure: string;
}

export interface AgentLoopModelInput {
  messages: ModelConversationMessage[];
  iteration: number;
}

export interface AgentLoopResult {
  message: string;
}

export interface AgentActionExecutionOutcome {
  results: string[];
  mutationCount: number;
  incompleteRecovery?: {
    completedActionKeys: readonly (readonly string[])[];
    failedActionIndex?: number;
    failureMessage: string;
  };
}

export interface AgentActionPreflightGuard<ExecutionBindings = undefined> {
  (): Promise<ExecutionBindings>;
  readonly actionKeys?: readonly (readonly string[])[];
}

export interface AgentLoopOptions<ExecutionBindings = undefined> {
  /** Stops the same repeated model argument/protocol violation; distinct repairs do not count. */
  maxConsecutiveFailures: number;
  /** Rolling number of planning steps allowed without new Live information or mutation. */
  maxIterations?: number;
  /** Protocol guard for one assistant turn, not an accumulated request budget. */
  maxToolCallsPerTurn?: number;
  /** Bounded replay attempts for provider responses stopped by their output limit. */
  maxModelContinuations?: number;
  /** Stops repeated host repair attempts that make no actual Live mutation. */
  maxHostFailuresWithoutMutation?: number;
  /** Persisted replay guard from the latest unfinished operation in this Session. */
  initialRecoveryState?: AgentLoopInitialRecoveryState;
  signal?: AbortSignal;
  /** Returns newly persisted user guidance accepted by the active send. */
  consumeSteering?(): Promise<readonly string[]>;
  /** Synchronous guard used immediately before an irreversible Live boundary. */
  hasPendingSteering?(): boolean;
  /** Clears transient provider output after the new user guidance is installed. */
  onSteeringApplied?(messageCount: number): Promise<void> | void;
  /** Advances transient output after one complete, non-continuation model turn. */
  onModelTurnAccepted?(): Promise<void> | void;
  askModel(input: AgentLoopModelInput): Promise<ModelTurn>;
  observe(request: AgentObservationRequest): Promise<string>;
  preflightActions?(
    plan: AgentPlan,
  ): Promise<AgentActionPreflightGuard<ExecutionBindings>>;
  confirmActions(
    plan: AgentPlan,
  ): Promise<boolean | AgentConfirmationDecision>;
  withActionExecutionLock?(
    operation: () => Promise<AgentActionExecutionOutcome>,
  ): Promise<AgentActionExecutionOutcome>;
  executeActions(
    plan: AgentPlan,
    bindings: ExecutionBindings,
  ): Promise<AgentActionExecutionOutcome>;
  onProgress?(message: string): Promise<void> | void;
  onEvent?(event: AgentLoopTraceEvent): Promise<void> | void;
}

export class AgentActionPreflightError extends Error {
  constructor(
    message: string,
    cause: unknown,
    readonly recoverable: boolean,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentActionPreflightError";
  }
}

export class AgentSteeringInterruptError extends Error {
  constructor() {
    super("The current model turn was interrupted by newer user guidance.");
    this.name = "AgentSteeringInterruptError";
  }
}

export class AgentApplyResultReportingError extends Error {
  readonly completedResults: string[];

  constructor(completedResults: string[], cause: unknown) {
    super([
      completedResults.length
        ? "Live actions completed, but their apply result could not be recorded."
        : "The Live action failure could not be recorded.",
      ...completedResults.map((result) => `Completed: ${result}`),
      completedResults.length
        ? "The completed actions will not be retried automatically."
        : "No actions from this plan were completed.",
      errorMessage(cause),
    ].join(" "), { cause });
    this.name = "AgentApplyResultReportingError";
    this.completedResults = [...completedResults];
  }
}

export class AgentPartialCompletionError extends Error {
  readonly completedResults: string[];

  constructor(
    completedResults: string[],
    cause: unknown,
    readonly failedActionIndex?: number,
    readonly failedAction?: AgentAction,
    readonly failedTrackName?: string,
    readonly completedActionKeys: readonly (readonly string[])[] = [],
    readonly completedMutationCount: number = completedResults.length,
  ) {
    super([
      completedResults.length
        ? `Live action plan partially completed after ${completedResults.length} action(s).`
        : "Live action plan could not complete its first action.",
      ...completedResults.map((result) => `Completed: ${result}`),
      failedActionIndex !== undefined && failedAction
        ? `Failed action ${failedActionIndex + 1}: ${summarizeAgentAction(failedAction)}`
        : "",
      completedResults.length
        ? "The completed actions will not be retried automatically."
        : "No actions from this plan were completed.",
      errorMessage(cause),
    ].filter(Boolean).join("\n"), { cause });
    this.name = "AgentPartialCompletionError";
    this.completedResults = [...completedResults];
  }
}

interface AgentRecoveryState {
  readonly completedActionKeys: Set<string>;
  readonly completedActionDigests: Set<string>;
  requiresExplicitResolution: boolean;
  requiredObservation: AgentObservationRequest | undefined;
  unresolvedFailure: string | undefined;
}

interface ToolCallExecutionResult {
  toolContent: string;
  userMessage: string;
  cancelled: boolean;
  failed: boolean;
  mutationProgress: boolean;
  progressKey?: string;
  failureKind?: "arguments" | "observation" | "host" | "internal";
}

class AgentRecoveryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRecoveryPlanError";
  }
}

class AgentToolArgumentsError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "AgentToolArgumentsError";
  }
}

class AgentObservationError extends Error {
  constructor(readonly request: AgentObservationRequest, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "AgentObservationError";
  }
}

export class AgentSteeringBeforeApplyError extends Error {
  constructor(
    message =
      "The proposed Live actions were not applied because a newer user steering message superseded the plan.",
  ) {
    super(message);
    this.name = "AgentSteeringBeforeApplyError";
  }
}

export async function runAgentLoop(
  options: AgentLoopOptions<unknown>,
): Promise<AgentLoopResult> {
  const messages: ModelConversationMessage[] = [];
  const maxIterations = options.maxIterations ?? 12;
  const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 32;
  const maxModelContinuations = options.maxModelContinuations ?? 2;
  const maxHostFailuresWithoutMutation =
    options.maxHostFailuresWithoutMutation ?? 6;
  let lastMessage = "";
  let repeatedArgumentFailures = 0;
  let lastArgumentFailure = "";
  let hostFailuresWithoutMutation = 0;
  let planningProgressDeadline = maxIterations;
  let consecutiveModelContinuations = 0;
  let pendingContinuationContent = "";
  let pendingContinuationCitations: ModelCitation[] = [];
  let pendingContinuationMessageStart: number | undefined;
  const observedProgress = new Set<string>();
  const recoveryState: AgentRecoveryState = {
    completedActionKeys: new Set(),
    completedActionDigests: new Set(
      options.initialRecoveryState?.completedActionDigests ?? [],
    ),
    requiresExplicitResolution: options.initialRecoveryState !== undefined,
    requiredObservation: undefined,
    unresolvedFailure: options.initialRecoveryState?.unresolvedFailure,
  };
  const appendSteering = () => appendPendingSteering(
    options,
    messages,
    () => {
      if (pendingContinuationMessageStart === undefined) return;
      messages.splice(pendingContinuationMessageStart);
      pendingContinuationMessageStart = undefined;
    },
  );

  planningLoop:
  for (let iteration = 1; ; iteration += 1) {
    throwIfAborted(options.signal);
    if (await appendSteering()) {
      planningProgressDeadline = iteration + maxIterations;
      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
      consecutiveModelContinuations = 0;
      pendingContinuationContent = "";
      pendingContinuationCitations = [];
    }
    if (iteration > planningProgressDeadline) {
      return stopAtSafetyLimit(
        options,
        `Stopped after ${maxIterations} planning steps without new Live information or a completed Live mutation. Continue in this Session with the unfinished stage or inspect the latest error.`,
      );
    }

    await options.onProgress?.(`Planning step ${iteration}`);
    throwIfAborted(options.signal);

    let turn: ModelTurn;
    try {
      turn = await options.askModel({
        messages: [...messages],
        iteration,
      });
    } catch (error) {
      if (!(error instanceof AgentSteeringInterruptError)) throw error;
      throwIfAborted(options.signal);
      if (!(await appendSteering())) {
        throw new Error(
          "A model turn reported a steering interruption without any pending user guidance.",
          { cause: error },
        );
      }
      planningProgressDeadline = iteration + maxIterations;
      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
      consecutiveModelContinuations = 0;
      pendingContinuationContent = "";
      pendingContinuationCitations = [];
      continue;
    }
    throwIfAborted(options.signal);

    if (await appendSteering()) {
      planningProgressDeadline = iteration + maxIterations;
      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
      consecutiveModelContinuations = 0;
      pendingContinuationContent = "";
      pendingContinuationCitations = [];
      continue;
    }

    const assistantMessageIndex = messages.length;
    messages.push({
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls,
      ...(turn.providerState !== undefined
        ? { providerState: turn.providerState }
        : {}),
    });

    if (turn.hostedWebSearches !== undefined) {
      const visibleSearches = Array.isArray(turn.hostedWebSearches)
        ? turn.hostedWebSearches.slice(0, HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND)
        : [];
      if (
        !Array.isArray(turn.hostedWebSearches) ||
        new Set(visibleSearches.map((search) => search.id)).size !==
          visibleSearches.length ||
        visibleSearches.some((search) =>
          search.status === "searching" || !isModelHostedWebSearch(search)
        )
      ) {
        throw new TypeError("Hosted Web Search activity is invalid.");
      }
      for (const search of visibleSearches) {
        await emitTraceEvent(options, {
          kind: "web_search",
          content: webSearchSummary(search),
          webSearch: search,
        });
      }
    }

    if (turn.continuation) {
      if (
        turn.continuation.reason !== "output_limit" ||
        turn.toolCalls.length !== 0 ||
        turn.providerState === undefined
      ) {
        throw new TypeError("Model continuation state is invalid.");
      }
      pendingContinuationMessageStart ??= assistantMessageIndex;
      consecutiveModelContinuations += 1;
      pendingContinuationContent += turn.content ?? "";
      pendingContinuationCitations = mergeCitations(
        pendingContinuationCitations,
        turn.citations ?? [],
      );
      if (consecutiveModelContinuations > maxModelContinuations) {
        return stopAtSafetyLimit(
          options,
          `Stopped after ${maxModelContinuations} automatic continuation attempts because the model repeatedly reached its output-token limit. No incomplete tool call was executed. Increase this Profile's Max Output Tokens or continue in this Session.`,
        );
      }
      planningProgressDeadline += 1;
      await options.onProgress?.(
        `Continuing model response after output limit (${consecutiveModelContinuations}/${maxModelContinuations})`,
      );
      continue;
    }

    await options.onModelTurnAccepted?.();

    const completedTurnContent = pendingContinuationContent + (turn.content ?? "");
    const completedTurnCitations = mergeCitations(
      pendingContinuationCitations,
      turn.citations ?? [],
    );
    consecutiveModelContinuations = 0;
    pendingContinuationContent = "";
    pendingContinuationCitations = [];
    pendingContinuationMessageStart = undefined;

    if (!turn.toolCalls.length) {
      const finalText = completedTurnContent.trim();
      if (recoveryState.unresolvedFailure) {
        if (finalText) {
          await emitTraceEvent(options, {
            kind: "assistant",
            content: finalText,
            ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
          });
        }
        if (await appendSteering()) {
          planningProgressDeadline = iteration + maxIterations;
          continue;
        }
        const message = unfinishedWorkMessage(
          recoveryState.unresolvedFailure,
          Boolean(finalText),
        );
        await emitTraceEvent(options, { kind: "error", content: message });
        return { message };
      }
      if (finalText) {
        lastMessage = finalText;
        await emitTraceEvent(options, {
          kind: "assistant",
          content: lastMessage,
          ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
        });
      }
      if (await appendSteering()) {
        planningProgressDeadline = iteration + maxIterations;
        continue;
      }
      return {
        message: lastMessage || "Done.",
      };
    }

    if (completedTurnContent.trim()) {
      lastMessage = completedTurnContent.trim();
      await emitTraceEvent(options, {
        kind: "assistant",
        content: lastMessage,
        ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
      });
    }

    if (turn.toolCalls.length > maxToolCallsPerTurn) {
      const content = `This model turn returned ${turn.toolCalls.length} tool calls, exceeding the per-turn safety limit of ${maxToolCallsPerTurn}. None were executed. Regroup the same unfinished stage into fewer tool calls; completed Live work is preserved.`;
      answerToolCallsWithoutExecution(messages, turn.toolCalls, content);
      await emitTraceEvent(options, { kind: "error", content });
      if (content === lastArgumentFailure) repeatedArgumentFailures += 1;
      else {
        lastArgumentFailure = content;
        repeatedArgumentFailures = 1;
      }
      if (repeatedArgumentFailures >= options.maxConsecutiveFailures) {
        return {
          message: [
            content,
            "",
            `Stopped after the same invalid tool-call batch repeated ${repeatedArgumentFailures} times.`,
          ].join("\n"),
        };
      }
      continue;
    }

    for (const [toolCallIndex, toolCall] of turn.toolCalls.entries()) {
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        skipRemainingToolCalls(
          messages,
          turn.toolCalls,
          toolCallIndex,
          "not executed because a newer user steering message superseded this tool batch",
        );
        if (!(await appendSteering())) {
          throw new Error(
            "Pending steering disappeared before it could be added to the conversation.",
          );
        }
        planningProgressDeadline = iteration + maxIterations;
        repeatedArgumentFailures = 0;
        lastArgumentFailure = "";
        continue planningLoop;
      }
      await options.onProgress?.(progressLabelForToolCall(toolCall));
      await emitTraceEvent(options, {
        kind: "tool_call",
        name: toolCall.name,
        content: toolCall.arguments,
      });
      const result = await executeToolCall(options, toolCall, recoveryState);
      throwIfAborted(options.signal);
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: result.toolContent,
      });

      if (options.hasPendingSteering?.()) {
        skipRemainingToolCalls(
          messages,
          turn.toolCalls,
          toolCallIndex + 1,
          "not executed because a newer user steering message superseded this tool batch",
        );
        if (!(await appendSteering())) {
          throw new Error(
            "Pending steering disappeared before it could be added to the conversation.",
          );
        }
        planningProgressDeadline = iteration + maxIterations;
        repeatedArgumentFailures = 0;
        lastArgumentFailure = "";
        continue planningLoop;
      }

      const newObservationProgress = result.progressKey !== undefined &&
        !observedProgress.has(result.progressKey);
      if (result.progressKey !== undefined) observedProgress.add(result.progressKey);
      if (result.mutationProgress || newObservationProgress) {
        planningProgressDeadline = iteration + maxIterations;
      }
      if (result.mutationProgress) {
        hostFailuresWithoutMutation = 0;
      } else if (result.failed && result.failureKind === "host") {
        hostFailuresWithoutMutation += 1;
      }

      if (result.cancelled) {
        skipRemainingToolCalls(messages, turn.toolCalls, toolCallIndex + 1);
        return {
          message: result.userMessage,
        };
      }

      if (result.failed) {
        // Every tool call in the turn needs a tool result message, even when we
        // stop early - otherwise the next model request is rejected for having
        // unanswered tool calls.
        skipRemainingToolCalls(messages, turn.toolCalls, toolCallIndex + 1);
        if (
          hostFailuresWithoutMutation >= maxHostFailuresWithoutMutation
        ) {
          const safetyMessage =
            `Stopped after ${hostFailuresWithoutMutation} host failures without a completed Live mutation. ` +
            "This bounds unproductive repair churn; it is not a total workflow or tool-call limit.";
          return stopAtSafetyLimit(
            options,
            recoveryState.unresolvedFailure
              ? `${safetyMessage}\n\n${unfinishedWorkMessage(recoveryState.unresolvedFailure)}`
              : safetyMessage,
          );
        }
        if (result.failureKind === "arguments") {
          if (result.toolContent === lastArgumentFailure) repeatedArgumentFailures += 1;
          else {
            lastArgumentFailure = result.toolContent;
            repeatedArgumentFailures = 1;
          }
        } else {
          repeatedArgumentFailures = 0;
          lastArgumentFailure = "";
        }
        if (repeatedArgumentFailures >= options.maxConsecutiveFailures) {
          const stopMessage =
            `Stopped after the same invalid tool error repeated ${repeatedArgumentFailures} times.`;
          await emitTraceEvent(options, { kind: "error", content: stopMessage });
          return {
            message: [
              result.userMessage,
              "",
              stopMessage,
            ].join("\n"),
          };
        }
        break;
      }

      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
    }
  }
}

function mergeCitations(
  first: readonly ModelCitation[],
  second: readonly ModelCitation[],
): ModelCitation[] {
  return normalizeModelCitations([...first, ...second]);
}

export function webSearchSummary(search: ModelHostedWebSearch): string {
  if (search.status === "failed") {
    return search.queries[0]
      ? `Web Search failed for “${search.queries[0]}”`
      : "Web Search failed";
  }
  const pages = search.sources.length;
  const firstQuery = search.queries[0];
  const action = search.action === "open_page"
    ? "Opened a web page"
    : search.action === "find_in_page"
      ? "Searched within a web page"
      : firstQuery
        ? `Searched for “${firstQuery}”${
          search.queries.length > 1 ? ` + ${search.queries.length - 1} more` : ""
        }`
        : "Searched the web";
  return [
    action,
    ...(pages > 0 ? [`${pages} ${pages === 1 ? "page" : "pages"}`] : []),
  ].join(" · ");
}

function unfinishedWorkMessage(
  failure: string,
  modelReturnedCompletion = false,
): string {
  return [
    "Live Smith stopped with unfinished Live work.",
    failure,
    modelReturnedCompletion
      ? "The model returned a completion response without resolving that Live failure."
      : "",
    "Continue in this Session to choose an available alternative or finish the remaining stage.",
  ].filter(Boolean).join("\n");
}

async function stopAtSafetyLimit(
  options: AgentLoopOptions<unknown>,
  message: string,
): Promise<AgentLoopResult> {
  await emitTraceEvent(options, { kind: "error", content: message });
  return { message };
}

function skipRemainingToolCalls(
  messages: ModelConversationMessage[],
  toolCalls: ModelToolCall[],
  startIndex: number,
  reason = "not executed because an earlier tool call in this turn did not complete",
): void {
  for (const toolCall of toolCalls.slice(startIndex)) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content: `Tool call "${toolCall.name}" was ${reason}.`,
    });
  }
}

async function appendPendingSteering(
  options: AgentLoopOptions<unknown>,
  messages: ModelConversationMessage[],
  beforeAppend?: () => void,
): Promise<number> {
  const steering = await options.consumeSteering?.() ?? [];
  for (const content of steering) {
    if (typeof content !== "string" || !content.trim()) {
      throw new TypeError("A steering message must contain non-empty text.");
    }
  }
  if (steering.length) beforeAppend?.();
  for (const content of steering) {
    messages.push({
      role: "user",
      content,
    });
  }
  if (steering.length) {
    await options.onSteeringApplied?.(steering.length);
  }
  return steering.length;
}

function answerToolCallsWithoutExecution(
  messages: ModelConversationMessage[],
  toolCalls: ModelToolCall[],
  content: string,
): void {
  for (const toolCall of toolCalls) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content,
    });
  }
}

async function executeToolCall(
  options: AgentLoopOptions<unknown>,
  toolCall: ModelToolCall,
  recoveryState: AgentRecoveryState,
): Promise<ToolCallExecutionResult> {
  let applyPlan: AgentPlan | undefined;
  let applyActionKeys: readonly (readonly string[])[] | undefined;
  try {
    if (isObservationTool(toolCall.name)) {
      let request: AgentObservationRequest;
      try {
        request = observationRequestFromToolCall(toolCall);
      } catch (error) {
        throw new AgentToolArgumentsError(error);
      }
      throwIfAborted(options.signal);
      let observation: string;
      try {
        observation = await options.observe(request);
      } catch (error) {
        throw new AgentObservationError(request, error);
      }
      throwIfAborted(options.signal);
      if (
        recoveryState.requiredObservation &&
        observationCoversRecovery(request, recoveryState.requiredObservation)
      ) {
        recoveryState.requiredObservation = undefined;
      }
      await emitTraceEvent(options, {
        kind: "tool_result",
        name: toolCall.name,
        content: observation,
      });
      return {
        toolContent: observation,
        userMessage: observation,
        cancelled: false,
        failed: false,
        mutationProgress: false,
        progressKey: observation,
      };
    }

    if (toolCall.name === "apply_live_actions") {
      let plan: AgentPlan;
      try {
        plan = actionPlanFromToolCall(toolCall);
      } catch (error) {
        throw new AgentToolArgumentsError(error);
      }
      applyPlan = plan;
      if (plan.resolvesPriorFailure && !recoveryState.unresolvedFailure) {
        throw new AgentRecoveryPlanError(
          "resolvesPriorFailure is only valid while this Session has an unfinished Live operation. Omit it for normal work.",
        );
      }
      if (recoveryState.requiredObservation) {
        throw new AgentRecoveryPlanError(
          "Live state could not be refreshed after the previous partial apply. Inspect the affected Live object successfully before proposing another mutation.",
        );
      }
      const repeatedActionIndex = plan.actions.findIndex((action) =>
        hasCompletedActionIdentity(recoveryState, agentActionKey(action))
      );
      if (repeatedActionIndex >= 0) {
        throw new AgentRecoveryPlanError(
          `Action ${repeatedActionIndex + 1} repeats work already completed in this Session's unfinished operation: ${summarizeAgentAction(plan.actions[repeatedActionIndex]!)} Continue with missing work only.`,
        );
      }
      if (!options.preflightActions) {
        throw new AgentActionPreflightError(
          "Action preflight is not configured; refusing to confirm or execute Live actions.",
          undefined,
          false,
        );
      }
      let revalidateActions: AgentActionPreflightGuard<unknown>;
      try {
        revalidateActions = await options.preflightActions(plan);
        if (typeof revalidateActions !== "function") {
          throw new AgentActionPreflightError(
            "Action preflight did not return a revalidation guard; refusing to confirm or execute Live actions.",
            undefined,
            false,
          );
        }
        applyActionKeys = revalidateActions.actionKeys;
        const repeatedSemanticActionIndex = applyActionKeys?.findIndex((keys) =>
          keys.some((key) => hasCompletedActionIdentity(recoveryState, key))
        ) ?? -1;
        if (repeatedSemanticActionIndex >= 0) {
          throw new AgentRecoveryPlanError(
            `Action ${repeatedSemanticActionIndex + 1} repeats work already completed in this Session's unfinished operation: ${summarizeAgentAction(plan.actions[repeatedSemanticActionIndex]!)} Continue with missing work only.`,
          );
        }
        throwIfAborted(options.signal);
      } catch (error) {
        throwIfAborted(options.signal);
        if (
          error instanceof AgentActionPreflightError ||
          error instanceof AgentRecoveryPlanError
        ) throw error;
        throw new AgentActionPreflightError(
          `Action preflight failed: ${errorMessage(error)}`,
          error,
          true,
        );
      }
      const summary = summarizeActionPlan(plan);
      await options.onProgress?.(progressLabelForActionPlan(plan));
      await emitTraceEvent(options, {
        kind: "apply_requested",
        content: summary,
      });
      if (options.hasPendingSteering?.()) {
        throw new AgentSteeringBeforeApplyError();
      }
      throwIfAborted(options.signal);
      const rawDecision = await options.confirmActions(plan);
      const decision: AgentConfirmationDecision = typeof rawDecision === "boolean"
        ? { confirmed: rawDecision, source: "user" }
        : rawDecision;
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        throw new AgentSteeringBeforeApplyError();
      }

      if (decision.confirmed && decision.source === "automatic") {
        const actionCount = plan.actions.length;
        const modeLabel = decision.mode === "everything"
          ? "Accept Everything"
          : "Low Risk";
        await emitTraceEvent(options, {
          kind: "apply_auto_approved",
          content: [
            `${actionCount} ${actionCount === 1 ? "change" : "changes"} · ${modeLabel}`,
            "Automatic approval. Standard safety checks completed.",
          ].join("\n"),
        });
        throwIfAborted(options.signal);
      }

      if (!decision.confirmed) {
        const content = "User cancelled the proposed Live actions. Do not claim they were applied.";
        await emitTraceEvent(options, {
          kind: "apply_result",
          content,
        });
        return {
          toolContent: content,
          userMessage: `${summary}\n\nActions were not applied.`,
          cancelled: true,
          failed: false,
          mutationProgress: false,
        };
      }

      const executeConfirmedActions = async () => {
        throwIfAborted(options.signal);
        if (options.hasPendingSteering?.()) {
          throw new AgentSteeringBeforeApplyError();
        }
        let bindings: unknown;
        try {
          bindings = await revalidateActions();
          throwIfAborted(options.signal);
          if (options.hasPendingSteering?.()) {
            throw new AgentSteeringBeforeApplyError();
          }
        } catch (error) {
          throwIfAborted(options.signal);
          if (error instanceof AgentSteeringBeforeApplyError) throw error;
          throw new AgentActionPreflightError(
            `Live state changed after confirmation; refusing to execute actions: ${errorMessage(error)}`,
            error,
            true,
          );
        }
        return options.executeActions(plan, bindings);
      };
      const outcome = options.withActionExecutionLock
        ? await options.withActionExecutionLock(executeConfirmedActions)
        : await executeConfirmedActions();
      if (outcome.incompleteRecovery) {
        const recovery = outcome.incompleteRecovery;
        const hasGranularCompletionKeys = recovery.completedActionKeys.some(
          (keys) => keys.some((key) => key.startsWith("live-action-step:")),
        );
        const completedActionCount = (recovery.failedActionIndex ?? 0) + (
          !hasGranularCompletionKeys &&
          outcome.results.length > (recovery.failedActionIndex ?? 0)
            ? 1
            : 0
        );
        for (const action of plan.actions.slice(0, completedActionCount)) {
          rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
        }
        for (const keys of recovery.completedActionKeys) {
          for (const key of keys) rememberCompletedActionIdentity(recoveryState, key);
        }
        const content = [
          `Live action plan partially completed after ${outcome.results.length} action(s).`,
          ...outcome.results.map((item) => `Completed: ${item}`),
          "The completed actions will not be retried automatically.",
          recovery.failureMessage,
        ].join("\n");
        recoveryState.unresolvedFailure = content;
        recoveryState.requiresExplicitResolution ||= outcome.mutationCount > 0;
        const recoveryUpdate = recoveryState.requiresExplicitResolution
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
        try {
          await emitTraceEvent(options, {
            kind: "apply_result",
            content,
            ...(recoveryUpdate ? { recovery: recoveryUpdate } : {}),
          });
        } catch (error) {
          throw new AgentApplyResultReportingError(outcome.results, error);
        }
        throwIfAborted(options.signal);
        return {
          toolContent: content,
          userMessage: content,
          cancelled: false,
          failed: true,
          mutationProgress: outcome.mutationCount > 0,
          failureKind: "host",
        };
      }
      const content = ["Applied:", ...outcome.results.map((item) => `- ${item}`)].join("\n");
      const recoveryActive = recoveryState.unresolvedFailure !== undefined;
      const clearsRecovery = recoveryActive && (
        plan.resolvesPriorFailure === true ||
        !recoveryState.requiresExplicitResolution
      );
      if (recoveryActive && !clearsRecovery) {
        for (const [index, action] of plan.actions.entries()) {
          rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
          for (const key of applyActionKeys?.[index] ?? []) {
            rememberCompletedActionIdentity(recoveryState, key);
          }
        }
      }
      const recoveryUpdate = clearsRecovery
        ? recoveryState.requiresExplicitResolution
          ? { active: false, completedActionDigests: [] }
          : undefined
        : recoveryActive
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
      try {
        await emitTraceEvent(options, {
          kind: "apply_result",
          content,
          ...(recoveryUpdate ? { recovery: recoveryUpdate } : {}),
        });
      } catch (error) {
        throw new AgentApplyResultReportingError(outcome.results, error);
      }
      throwIfAborted(options.signal);
      if (clearsRecovery) {
        recoveryState.unresolvedFailure = undefined;
        recoveryState.completedActionKeys.clear();
        recoveryState.completedActionDigests.clear();
        recoveryState.requiresExplicitResolution = false;
      }
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: false,
        mutationProgress: outcome.mutationCount > 0,
      };
    }

    throw new Error(`Unsupported model tool call: ${toolCall.name}`);
  } catch (error) {
    if (error instanceof AgentSteeringBeforeApplyError) {
      await emitTraceEvent(options, {
        kind: "apply_result",
        content: error.message,
      });
      return {
        toolContent: error.message,
        userMessage: error.message,
        cancelled: false,
        failed: false,
        mutationProgress: false,
      };
    }
    if (error instanceof AgentPartialCompletionError) {
      const failureContent = error.message;
      recoveryState.unresolvedFailure = failureContent;
      recoveryState.requiresExplicitResolution ||=
        error.completedMutationCount > 0;
      if (error.failedActionIndex !== undefined && error.failedActionIndex > 0) {
        const failedPlan = applyPlan ?? actionPlanFromToolCall(toolCall);
        const hasGranularCompletionKeys = error.completedActionKeys.some(
          (keys) => keys.some((key) => key.startsWith("live-action-step:")),
        );
        const completedActionCount = error.failedActionIndex + (
          !hasGranularCompletionKeys &&
          error.completedResults.length > error.failedActionIndex
            ? 1
            : 0
        );
        for (const action of failedPlan.actions.slice(0, completedActionCount)) {
          rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
        }
        const semanticKeys = error.completedActionKeys.length
          ? error.completedActionKeys
          : (applyActionKeys ?? []).slice(0, completedActionCount);
        for (const keys of semanticKeys) {
          for (const key of keys) rememberCompletedActionIdentity(recoveryState, key);
        }
      } else if (
        error.failedActionIndex === 0 &&
        error.completedResults.length > 0
      ) {
        const failedPlan = applyPlan ?? actionPlanFromToolCall(toolCall);
        const hasGranularCompletionKeys = error.completedActionKeys.some(
          (keys) => keys.some((key) => key.startsWith("live-action-step:")),
        );
        if (!hasGranularCompletionKeys) {
          rememberCompletedActionIdentity(
            recoveryState,
            agentActionKey(failedPlan.actions[0]!),
          );
        }
        const semanticKeys = error.completedActionKeys[0] ?? applyActionKeys?.[0] ?? [];
        for (const key of semanticKeys) {
          rememberCompletedActionIdentity(recoveryState, key);
        }
      }
      try {
        const recoveryUpdate = recoveryState.requiresExplicitResolution
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
        await emitTraceEvent(options, {
          kind: "apply_result",
          content: failureContent,
          ...(recoveryUpdate ? { recovery: recoveryUpdate } : {}),
        });
      } catch (reportingError) {
        throw new AgentApplyResultReportingError(
          error.completedResults,
          reportingError,
        );
      }
      throwIfAborted(options.signal);
      const requiredObservation = recoveryRequestForFailure(error);
      recoveryState.requiredObservation = requiredObservation;
      let recoveryObservation = "";
      let recoveryObservationAvailable = false;
      try {
        recoveryObservation = await options.observe(requiredObservation);
        throwIfAborted(options.signal);
        recoveryState.requiredObservation = undefined;
        recoveryObservationAvailable = true;
      } catch (observationError) {
        throwIfAborted(options.signal);
        recoveryObservation = `Automatic Live state refresh was unavailable: ${errorMessage(observationError)}`;
      }
      const content = [
        failureContent,
        "Current Live state after the failure:",
        recoveryObservation,
        recoveryObservationAvailable
          ? "Use this refreshed state or inspect a narrower target, keep every completed action, and continue only with missing work. The beta SDK did not identify the failure cause; do not infer that the device name is unavailable. Repair only what the observed state supports."
          : "Inspect the affected Live object successfully before applying anything else. Keep every completed action and continue only with missing work. The beta SDK did not identify the failure cause; do not infer that the device name is unavailable.",
      ].join("\n");
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: error.completedMutationCount > 0,
        ...(recoveryObservationAvailable
          ? { progressKey: recoveryProgressKey(error, requiredObservation) }
          : {}),
        failureKind: "host",
      };
    }
    if (error instanceof AgentRecoveryPlanError) {
      const content = error.message;
      await emitTraceEvent(options, {
        kind: "tool_result",
        name: toolCall.name,
        content,
      });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "host",
      };
    }
    if (error instanceof AgentToolArgumentsError) {
      throwIfAborted(options.signal);
      const content = [
        `Tool call "${toolCall.name}" has invalid arguments: ${error.message}`,
        "Correct the tool fields and types, then retry. Do not change the musical request or split valid work solely because of this argument error.",
      ].join("\n");
      await emitTraceEvent(options, {
        kind: "tool_result",
        name: toolCall.name,
        content,
      });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "arguments",
      };
    }
    if (error instanceof AgentObservationError) {
      throwIfAborted(options.signal);
      const content = [
        `Live observation "${error.request.type}" failed: ${error.message}`,
        "The tool arguments were accepted. Reinspect the current object or a narrower target; do not infer missing Live state and do not split the requested edit solely because of this observation failure.",
      ].join("\n");
      await emitTraceEvent(options, { kind: "error", content });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "observation",
      };
    }
    if (
      (error instanceof AgentActionPreflightError && !error.recoverable) ||
      error instanceof AgentApplyResultReportingError
    ) {
      throw error;
    }
    if (error instanceof AgentActionPreflightError) {
      throwIfAborted(options.signal);
      const content = [
        `Live Smith could not verify current Live state for this action plan: ${error.message}`,
        "This is a Live-state preflight failure, not evidence that the JSON arguments are invalid or that the payload is too large. Inspect the relevant Live object and repair its target or state assumptions. Do not split or simplify the requested work solely because of this error.",
      ].join("\n");
      await emitTraceEvent(options, { kind: "error", content });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "host",
      };
    }
    throwIfAborted(options.signal);
    const message = errorMessage(error);
    const content = [
      `Tool call "${toolCall.name}" failed: ${message}`,
      "The failure category is unknown. Preserve completed actions, inspect relevant Live state when possible, and retry only a repair supported by evidence.",
    ].join("\n");
    await emitTraceEvent(options, { kind: "error", content });
    return {
      toolContent: content,
      userMessage: content,
      cancelled: false,
      failed: true,
      mutationProgress: false,
      failureKind: "internal",
    };
  }
}

function recoveryRequestForFailure(
  error: AgentPartialCompletionError,
): AgentObservationRequest {
  const action = error.failedAction;
  if (!action) return { type: "inspect_live_set" };
  return observationRequestForAction(action, error.failedTrackName);
}

function recoveryProgressKey(
  error: AgentPartialCompletionError,
  request: AgentObservationRequest,
): string {
  return `automatic-recovery:${JSON.stringify({
    request,
    failedActionIndex: error.failedActionIndex,
    failedAction: error.failedAction,
    completedActionKeys: error.completedActionKeys,
    completedMutationCount: error.completedMutationCount,
    cause: errorMessage(error.cause),
  })}`;
}

function agentActionKey(action: AgentAction): string {
  return JSON.stringify(action);
}

export function digestActionIdentity(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function hasCompletedActionIdentity(
  recoveryState: AgentRecoveryState,
  identity: string,
): boolean {
  return recoveryState.completedActionKeys.has(identity) ||
    recoveryState.completedActionDigests.has(digestActionIdentity(identity));
}

function rememberCompletedActionIdentity(
  recoveryState: AgentRecoveryState,
  identity: string,
): void {
  recoveryState.completedActionKeys.add(identity);
  recoveryState.completedActionDigests.add(digestActionIdentity(identity));
}

function recoveryLedgerUpdate(
  recoveryState: AgentRecoveryState,
): AgentRecoveryLedgerUpdate {
  return {
    active: true,
    completedActionDigests: [...recoveryState.completedActionDigests].sort(),
  };
}

function observationCoversRecovery(
  actual: AgentObservationRequest,
  required: AgentObservationRequest,
): boolean {
  if (actual.type !== required.type) return false;
  switch (required.type) {
    case "inspect_live_set":
    case "inspect_current_object":
      return true;
    case "inspect_song_info":
      return actual.type === "inspect_song_info" && (
        required.itemOffset === undefined ||
        (actual.itemOffset ?? 0) === required.itemOffset
      );
    case "inspect_track":
      return actual.type === "inspect_track" &&
        optionalTextMatches(actual.trackName, required.trackName);
    case "inspect_device":
      return actual.type === "inspect_device" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        normalizedText(actual.deviceName) === normalizedText(required.deviceName) &&
        actual.deviceIndex === required.deviceIndex;
    case "inspect_device_tree":
      return actual.type === "inspect_device_tree" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.deviceName, required.deviceName) &&
        JSON.stringify(actual.devicePath) === JSON.stringify(required.devicePath);
    case "inspect_mixer":
      return actual.type === "inspect_mixer" &&
        optionalTextMatches(actual.trackName, required.trackName);
    case "inspect_clip":
      return actual.type === "inspect_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat &&
        actual.slotIndex === required.slotIndex;
    case "inspect_midi_clip":
      return actual.type === "inspect_midi_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat &&
        actual.slotIndex === required.slotIndex;
    case "analyze_audio_clip":
      return actual.type === "analyze_audio_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat;
  }
}

function optionalTextMatches(actual?: string, required?: string): boolean {
  return required === undefined
    ? actual === undefined
    : actual !== undefined && normalizedText(actual) === normalizedText(required);
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitTraceEvent(
  options: AgentLoopOptions<unknown>,
  event: AgentLoopTraceEvent,
): Promise<void> {
  await options.onEvent?.(event);
}

function observationRequestFromToolCall(
  toolCall: ModelToolCall,
): AgentObservationRequest {
  const args = parseToolArguments(toolCall.arguments);
  switch (toolCall.name) {
    case "inspect_live_set":
      assertOnlyKeys(args, [], `${toolCall.name} arguments`);
      return { type: "inspect_live_set" };
    case "inspect_current_object":
      assertOnlyKeys(
        args,
        [...observationItemPageKeys, ...observationParameterPageKeys],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_current_object",
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_track":
      assertOnlyKeys(
        args,
        ["trackName", ...observationItemPageKeys, ...observationParameterPageKeys],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_track",
        ...optionalStringProp(args.trackName, "trackName"),
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_device":
      assertOnlyKeys(
        args,
        ["trackName", "deviceName", "deviceIndex", ...observationParameterPageKeys],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_device",
        ...optionalStringProp(args.trackName, "trackName"),
        deviceName: requiredString(args.deviceName, "deviceName"),
        ...optionalIntegerProp(args.deviceIndex, "deviceIndex", 0),
        ...observationParameterPageProps(args),
      };
    case "inspect_device_tree":
      assertOnlyKeys(
        args,
        [
          "trackName",
          "deviceName",
          "devicePath",
          ...observationItemPageKeys,
          ...observationParameterPageKeys,
        ],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_device_tree",
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.deviceName, "deviceName"),
        ...optionalDevicePathProp(args.devicePath),
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_mixer":
      assertOnlyKeys(args, ["trackName"], `${toolCall.name} arguments`);
      return {
        type: "inspect_mixer",
        ...optionalStringProp(args.trackName, "trackName"),
      };
    case "inspect_clip": {
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat", "slotIndex"],
        `${toolCall.name} arguments`,
      );
      const request = {
        type: "inspect_clip" as const,
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
        ...optionalIntegerProp(args.slotIndex, "slotIndex", 0),
      } as Extract<AgentObservationRequest, { type: "inspect_clip" }>;
      if (request.startBeat !== undefined && request.slotIndex !== undefined) {
        throw new Error("inspect_clip uses either startBeat or slotIndex, not both.");
      }
      return request;
    }
    case "inspect_midi_clip":
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat", "slotIndex", "noteOffset", "noteLimit"],
        `${toolCall.name} arguments`,
      );
      {
        const request = {
          type: "inspect_midi_clip",
          ...optionalStringProp(args.trackName, "trackName"),
          ...optionalStringProp(args.clipName, "clipName"),
          ...optionalNumberProp(args.startBeat, "startBeat"),
          ...optionalIntegerProp(args.slotIndex, "slotIndex", 0),
          ...optionalIntegerProp(args.noteOffset, "noteOffset", 0),
          ...optionalIntegerProp(args.noteLimit, "noteLimit", 1, 256),
        } as Extract<AgentObservationRequest, { type: "inspect_midi_clip" }>;
        if (request.startBeat !== undefined && request.slotIndex !== undefined) {
          throw new Error("inspect_midi_clip uses either startBeat or slotIndex, not both.");
        }
        return request;
      }
    case "analyze_audio_clip":
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat"],
        `${toolCall.name} arguments`,
      );
      return {
        type: "analyze_audio_clip",
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
      };
    case "inspect_song_info":
      assertOnlyKeys(args, observationItemPageKeys, `${toolCall.name} arguments`);
      return { type: "inspect_song_info", ...observationItemPageProps(args) };
    default:
      throw new Error(`Unsupported observation tool: ${toolCall.name}`);
  }
}

const observationItemPageKeys = ["itemOffset", "itemLimit"] as const;
const observationParameterPageKeys = [
  "parameterOffset",
  "parameterLimit",
  "valueItemOffset",
  "valueItemLimit",
] as const;

function observationItemPageProps(args: Record<string, unknown>): {
  itemOffset?: number;
  itemLimit?: number;
} {
  return {
    ...optionalIntegerProp(args.itemOffset, "itemOffset", 0),
    ...optionalIntegerProp(args.itemLimit, "itemLimit", 1, 100),
  };
}

function observationParameterPageProps(args: Record<string, unknown>): {
  parameterOffset?: number;
  parameterLimit?: number;
  valueItemOffset?: number;
  valueItemLimit?: number;
} {
  return {
    ...optionalIntegerProp(args.parameterOffset, "parameterOffset", 0),
    ...optionalIntegerProp(args.parameterLimit, "parameterLimit", 1, 100),
    ...optionalIntegerProp(args.valueItemOffset, "valueItemOffset", 0),
    ...optionalIntegerProp(args.valueItemLimit, "valueItemLimit", 1, 100),
  };
}

function actionPlanFromToolCall(toolCall: ModelToolCall): AgentPlan {
  return validateAgentPlan(parseToolArguments(toolCall.arguments));
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }

  throw new Error("Invalid JSON arguments for tool call.");
}

function isObservationTool(name: string): boolean {
  return (
    name === "inspect_live_set" ||
    name === "inspect_current_object" ||
    name === "inspect_track" ||
    name === "inspect_device" ||
    name === "inspect_device_tree" ||
    name === "inspect_mixer" ||
    name === "inspect_clip" ||
    name === "inspect_midi_clip" ||
    name === "analyze_audio_clip" ||
    name === "inspect_song_info"
  );
}

function optionalDevicePathProp(
  value: unknown,
): { devicePath?: import("../live/device-tree.js").DevicePath } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("devicePath must be an object.");
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["deviceIndex", "nested"], "devicePath");
  const deviceIndex = requiredNonNegativeInteger(record.deviceIndex, "devicePath.deviceIndex");
  if (record.nested !== undefined && !Array.isArray(record.nested)) {
    throw new Error("devicePath.nested must be an array.");
  }
  const nested = (record.nested ?? []).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`devicePath.nested[${index}] must be an object.`);
    }
    const segment = item as Record<string, unknown>;
    assertOnlyKeys(segment, ["chainIndex", "deviceIndex"], `devicePath.nested[${index}]`);
    return {
      chainIndex: requiredNonNegativeInteger(
        segment.chainIndex,
        `devicePath.nested[${index}].chainIndex`,
      ),
      deviceIndex: requiredNonNegativeInteger(
        segment.deviceIndex,
        `devicePath.nested[${index}].deviceIndex`,
      ),
    };
  });
  return {
    devicePath: {
      deviceIndex,
      ...(nested.length ? { nested } : {}),
    },
  };
}

function requiredNonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} does not support property ${unknown}.`);
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool call requires string ${key}.`);
  }
  return value.trim();
}

function optionalStringProp(value: unknown, key: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool call ${key} must be a non-empty string when provided.`);
  }
  return { [key]: value.trim() };
}

function optionalNumberProp(value: unknown, key: string): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool call ${key} must be a finite number when provided.`);
  }
  return { [key]: value };
}

function optionalIntegerProp(
  value: unknown,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): Record<string, number> {
  if (value === undefined) return {};
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Tool call ${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return { [key]: value };
}
