import {
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
  ModelConversationMessage,
  ModelToolCall,
  ModelTurn,
} from "../model/contracts.js";
import { throwIfAborted } from "../runtime/host.js";

export type AgentLoopTraceEvent =
  | { kind: "assistant"; content: string }
  | { kind: "tool_call"; name: string; content: string }
  | { kind: "tool_result"; name: string; content: string }
  | { kind: "apply_requested"; content: string }
  | { kind: "apply_result"; content: string }
  | { kind: "error"; content: string };

export interface AgentLoopModelInput {
  messages: ModelConversationMessage[];
  iteration: number;
}

export interface AgentLoopResult {
  message: string;
}

export interface AgentActionPreflightGuard<ExecutionBindings = undefined> {
  (): Promise<ExecutionBindings>;
  readonly actionKeys?: readonly (readonly string[])[];
}

export interface AgentLoopOptions<ExecutionBindings = undefined> {
  maxConsecutiveFailures: number;
  /** Rolling number of planning steps allowed without a completed Live mutation. */
  maxIterations?: number;
  /** Broad runaway guard; this is not renewed by progress. */
  maxTotalIterations?: number;
  /** Protocol guard for one assistant turn, not an accumulated request budget. */
  maxToolCallsPerTurn?: number;
  signal?: AbortSignal;
  askModel(input: AgentLoopModelInput): Promise<ModelTurn>;
  observe(request: AgentObservationRequest): Promise<string>;
  preflightActions?(
    plan: AgentPlan,
  ): Promise<AgentActionPreflightGuard<ExecutionBindings>>;
  confirmActions(plan: AgentPlan): Promise<boolean>;
  withActionExecutionLock?(
    operation: () => Promise<string[]>,
  ): Promise<string[]>;
  executeActions(
    plan: AgentPlan,
    bindings: ExecutionBindings,
  ): Promise<string[]>;
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
  readonly rejectedActionKeys: Set<string>;
  requiredObservation: AgentObservationRequest | undefined;
  unresolvedFailure: string | undefined;
}

interface ToolCallExecutionResult {
  toolContent: string;
  userMessage: string;
  cancelled: boolean;
  failed: boolean;
  mutationProgress: boolean;
}

class AgentRecoveryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRecoveryPlanError";
  }
}

export async function runAgentLoop(
  options: AgentLoopOptions<unknown>,
): Promise<AgentLoopResult> {
  const messages: ModelConversationMessage[] = [];
  const maxIterations = options.maxIterations ?? 12;
  const maxTotalIterations = options.maxTotalIterations ?? 64;
  const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 32;
  let lastMessage = "";
  let consecutiveFailures = 0;
  let mutationProgressDeadline = Math.min(maxIterations, maxTotalIterations);
  const recoveryState: AgentRecoveryState = {
    completedActionKeys: new Set(),
    rejectedActionKeys: new Set(),
    requiredObservation: undefined,
    unresolvedFailure: undefined,
  };

  for (let iteration = 1; ; iteration += 1) {
    throwIfAborted(options.signal);
    if (iteration > maxTotalIterations) {
      return stopAtSafetyLimit(
        options,
        `Reached the hard safety limit of ${maxTotalIterations} planning steps in one request. Continue the project in this Session; completed Live work and conversation context are preserved.`,
      );
    }
    if (iteration > mutationProgressDeadline) {
      return stopAtSafetyLimit(
        options,
        `Stopped after ${maxIterations} planning steps without completing another Live mutation. Continue in this Session with the unfinished stage or inspect the latest error.`,
      );
    }

    await options.onProgress?.(`Planning step ${iteration}`);
    throwIfAborted(options.signal);

    const turn = await options.askModel({
      messages: [...messages],
      iteration,
    });
    throwIfAborted(options.signal);

    messages.push({
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls,
      ...(turn.providerState !== undefined
        ? { providerState: turn.providerState }
        : {}),
    });

    if (turn.content?.trim()) {
      lastMessage = turn.content.trim();
      await emitTraceEvent(options, { kind: "assistant", content: lastMessage });
    }

    if (!turn.toolCalls.length) {
      if (!turn.content?.trim() && recoveryState.unresolvedFailure) {
        return {
          message: [
            "Live Smith stopped with unfinished Live work.",
            recoveryState.unresolvedFailure,
            "Continue in this Session to choose an available alternative or finish the remaining stage.",
          ].join("\n"),
        };
      }
      return {
        message: lastMessage || "Done.",
      };
    }

    if (turn.toolCalls.length > maxToolCallsPerTurn) {
      const content = `This model turn returned ${turn.toolCalls.length} tool calls, exceeding the per-turn safety limit of ${maxToolCallsPerTurn}. None were executed. Regroup the same unfinished stage into fewer tool calls; completed Live work is preserved.`;
      answerToolCallsWithoutExecution(messages, turn.toolCalls, content);
      await emitTraceEvent(options, { kind: "error", content });
      consecutiveFailures += 1;
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        return {
          message: [
            content,
            "",
            `Stopped after ${consecutiveFailures} consecutive failed tool-call batches.`,
          ].join("\n"),
        };
      }
      continue;
    }

    for (const [toolCallIndex, toolCall] of turn.toolCalls.entries()) {
      throwIfAborted(options.signal);
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

      if (result.mutationProgress) {
        mutationProgressDeadline = Math.min(
          maxTotalIterations,
          iteration + maxIterations,
        );
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
        consecutiveFailures = result.mutationProgress
          ? 0
          : consecutiveFailures + 1;
        if (consecutiveFailures >= options.maxConsecutiveFailures) {
          return {
            message: [
              result.userMessage,
              "",
              `Stopped after ${consecutiveFailures} consecutive failed tool calls.`,
            ].join("\n"),
          };
        }
        break;
      }

      consecutiveFailures = 0;
    }
  }
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
): void {
  for (const toolCall of toolCalls.slice(startIndex)) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content: `Tool call "${toolCall.name}" was not executed because an earlier tool call in this turn did not complete.`,
    });
  }
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
      const request = observationRequestFromToolCall(toolCall);
      throwIfAborted(options.signal);
      const observation = await options.observe(request);
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
      };
    }

    if (toolCall.name === "apply_live_actions") {
      const plan = actionPlanFromToolCall(toolCall);
      applyPlan = plan;
      if (recoveryState.requiredObservation) {
        throw new AgentRecoveryPlanError(
          "Live state could not be refreshed after the previous partial apply. Inspect the affected Live object successfully before proposing another mutation.",
        );
      }
      const repeatedActionIndex = plan.actions.findIndex((action) =>
        recoveryState.completedActionKeys.has(agentActionKey(action))
      );
      if (repeatedActionIndex >= 0) {
        throw new AgentRecoveryPlanError(
          `Action ${repeatedActionIndex + 1} repeats work already completed earlier in this agent request: ${summarizeAgentAction(plan.actions[repeatedActionIndex]!)} Continue with missing work only.`,
        );
      }
      const rejectedActionIndex = plan.actions.findIndex((action) =>
        recoveryState.rejectedActionKeys.has(agentActionKey(action))
      );
      if (rejectedActionIndex >= 0) {
        throw rejectedDeviceInsertionError(plan, rejectedActionIndex);
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
          keys.some((key) => recoveryState.completedActionKeys.has(key))
        ) ?? -1;
        if (repeatedSemanticActionIndex >= 0) {
          throw new AgentRecoveryPlanError(
            `Action ${repeatedSemanticActionIndex + 1} repeats work already completed earlier in this agent request: ${summarizeAgentAction(plan.actions[repeatedSemanticActionIndex]!)} Continue with missing work only.`,
          );
        }
        const rejectedSemanticActionIndex = applyActionKeys?.findIndex((keys) =>
          keys.some((key) => recoveryState.rejectedActionKeys.has(key))
        ) ?? -1;
        if (rejectedSemanticActionIndex >= 0) {
          throw rejectedDeviceInsertionError(plan, rejectedSemanticActionIndex);
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
      throwIfAborted(options.signal);
      const confirmed = await options.confirmActions(plan);
      throwIfAborted(options.signal);

      if (!confirmed) {
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
        let bindings: unknown;
        try {
          bindings = await revalidateActions();
          throwIfAborted(options.signal);
        } catch (error) {
          throwIfAborted(options.signal);
          throw new AgentActionPreflightError(
            `Live state changed after confirmation; refusing to execute actions: ${errorMessage(error)}`,
            error,
            true,
          );
        }
        return options.executeActions(plan, bindings);
      };
      const results = options.withActionExecutionLock
        ? await options.withActionExecutionLock(executeConfirmedActions)
        : await executeConfirmedActions();
      const content = ["Applied:", ...results.map((item) => `- ${item}`)].join("\n");
      try {
        await emitTraceEvent(options, {
          kind: "apply_result",
          content,
        });
      } catch (error) {
        throw new AgentApplyResultReportingError(results, error);
      }
      throwIfAborted(options.signal);
      recoveryState.unresolvedFailure = undefined;
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: false,
        mutationProgress: plan.actions.length > 0,
      };
    }

    throw new Error(`Unsupported model tool call: ${toolCall.name}`);
  } catch (error) {
    if (error instanceof AgentPartialCompletionError) {
      const failureContent = error.message;
      try {
        await emitTraceEvent(options, {
          kind: "apply_result",
          content: failureContent,
        });
      } catch (reportingError) {
        throw new AgentApplyResultReportingError(
          error.completedResults,
          reportingError,
        );
      }
      throwIfAborted(options.signal);
      recoveryState.unresolvedFailure = failureContent;
      recordRejectedDeviceInsertion(
        recoveryState,
        error,
        applyActionKeys,
      );
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
          recoveryState.completedActionKeys.add(agentActionKey(action));
        }
        const semanticKeys = error.completedActionKeys.length
          ? error.completedActionKeys
          : (applyActionKeys ?? []).slice(0, completedActionCount);
        for (const keys of semanticKeys) {
          for (const key of keys) recoveryState.completedActionKeys.add(key);
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
          recoveryState.completedActionKeys.add(agentActionKey(failedPlan.actions[0]!));
        }
        const semanticKeys = error.completedActionKeys[0] ?? applyActionKeys?.[0] ?? [];
        for (const key of semanticKeys) {
          recoveryState.completedActionKeys.add(key);
        }
      }
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
          ? "Use this refreshed state or inspect a narrower target, keep every completed or reused action, and continue only with missing work. Treat an exact device name rejected by Live as unavailable in this host; choose a current alternative instead of retrying the same name."
          : "Inspect the affected Live object successfully before applying anything else. Keep every completed or reused action, and continue only with missing work. Treat an exact device name rejected by Live as unavailable in this host; choose a current alternative instead of retrying the same name.",
      ].join("\n");
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: error.completedResults.length > 0,
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
      };
    }
    throwIfAborted(options.signal);
    const message = errorMessage(error);
    const content = [
      `Tool call "${toolCall.name}" failed: ${message}`,
      "Retry with valid, complete JSON arguments. Do not repeat actions reported as completed or reused. If the planned edit is large, split it into smaller tool calls. If setting device parameters, inspect the device first and use exact observed parameter names.",
    ].join("\n");
    await emitTraceEvent(options, { kind: "error", content });
    return {
      toolContent: content,
      userMessage: content,
      cancelled: false,
      failed: true,
      mutationProgress: false,
    };
  }
}

function recordRejectedDeviceInsertion(
  recoveryState: AgentRecoveryState,
  error: AgentPartialCompletionError,
  applyActionKeys: readonly (readonly string[])[] | undefined,
): void {
  const failedAction = error.failedAction;
  const failedActionIndex = error.failedActionIndex;
  if (
    failedActionIndex === undefined ||
    !failedAction ||
    (failedAction.type !== "insert_device" &&
      failedAction.type !== "insert_chain_device")
  ) return;

  recoveryState.rejectedActionKeys.add(agentActionKey(failedAction));
  for (const key of applyActionKeys?.[failedActionIndex] ?? []) {
    recoveryState.rejectedActionKeys.add(key);
  }
}

function rejectedDeviceInsertionError(
  plan: AgentPlan,
  actionIndex: number,
): AgentRecoveryPlanError {
  return new AgentRecoveryPlanError(
    `Action ${actionIndex + 1} repeats an exact device insertion already rejected by Live in this agent request: ${summarizeAgentAction(plan.actions[actionIndex]!)} Choose an observed available alternative or continue with other missing work instead.`,
  );
}

function recoveryRequestForFailure(
  error: AgentPartialCompletionError,
): AgentObservationRequest {
  const action = error.failedAction;
  if (!action) return { type: "inspect_live_set" };
  if (
    action.type === "set_tempo" ||
    action.type === "create_scene" ||
    action.type === "rename_scene" ||
    action.type === "duplicate_scene" ||
    action.type === "delete_scene" ||
    action.type === "create_cue_point" ||
    action.type === "rename_cue_point" ||
    action.type === "delete_cue_point"
  ) {
    return { type: "inspect_song_info" };
  }
  const trackName = error.failedTrackName ?? (
    "trackName" in action ? action.trackName : undefined
  );
  if (action.type === "set_device_parameter" && !action.devicePath) {
    return {
      type: "inspect_device",
      ...(trackName ? { trackName } : {}),
      deviceName: action.deviceName,
      ...(action.deviceIndex === undefined
        ? {}
        : { deviceIndex: action.deviceIndex }),
    };
  }
  if (
    action.type === "set_device_parameter" ||
    action.type === "duplicate_device" ||
    action.type === "delete_device"
  ) {
    return {
      type: "inspect_device_tree",
      ...(trackName ? { trackName } : {}),
      deviceName: action.deviceName,
      ...(action.devicePath ? { devicePath: action.devicePath } : {}),
    };
  }
  if (action.type === "insert_chain_device") {
    return {
      type: "inspect_device_tree",
      ...(trackName ? { trackName } : {}),
      deviceName: action.rackName,
      ...(action.rackPath ? { devicePath: action.rackPath } : {}),
    };
  }
  if (action.type === "replace_simpler_sample") {
    return {
      type: "inspect_device_tree",
      ...(trackName ? { trackName } : {}),
      deviceName: action.simplerName,
      ...(action.simplerPath ? { devicePath: action.simplerPath } : {}),
    };
  }
  if (action.type === "configure_drum_pad") {
    return {
      type: "inspect_device_tree",
      ...(trackName ? { trackName } : {}),
      deviceName: action.rackName,
      ...(action.rackPath ? { devicePath: action.rackPath } : {}),
    };
  }
  if (action.type === "set_track_mixer_parameter") {
    return {
      type: "inspect_mixer",
      ...(trackName ? { trackName } : {}),
    };
  }
  if (
    action.type === "create_session_midi_clip" ||
    action.type === "create_session_audio_clip" ||
    action.type === "delete_session_clip"
  ) {
    return {
      type: "inspect_clip",
      ...(trackName ? { trackName } : {}),
      ...(action.type === "delete_session_clip" && action.clipName
        ? { clipName: action.clipName }
        : {}),
      slotIndex: action.slotIndex,
    };
  }
  if (action.type === "set_clip_properties" || action.type === "set_audio_clip_warp") {
    return {
      type: "inspect_clip",
      ...(trackName ? { trackName } : {}),
      ...(action.clipName ? { clipName: action.clipName } : {}),
      ...(action.startBeat === undefined ? {} : { startBeat: action.startBeat }),
      ...(action.slotIndex === undefined ? {} : { slotIndex: action.slotIndex }),
    };
  }
  if (action.type === "replace_midi_clip_segment") {
    return {
      type: "inspect_midi_clip",
      ...(trackName ? { trackName } : {}),
      clipName: action.clipName,
      startBeat: action.startBeat,
    };
  }
  if (trackName) {
    return { type: "inspect_track", trackName };
  }
  return { type: "inspect_live_set" };
}

function agentActionKey(action: AgentAction): string {
  return JSON.stringify(action);
}

function observationCoversRecovery(
  actual: AgentObservationRequest,
  required: AgentObservationRequest,
): boolean {
  if (actual.type !== required.type) return false;
  switch (required.type) {
    case "inspect_live_set":
    case "inspect_current_object":
    case "inspect_song_info":
      return true;
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
      return { type: "inspect_live_set" };
    case "inspect_current_object":
      return { type: "inspect_current_object" };
    case "inspect_track":
      return {
        type: "inspect_track",
        ...optionalStringProp(args.trackName, "trackName"),
      };
    case "inspect_device":
      return {
        type: "inspect_device",
        ...optionalStringProp(args.trackName, "trackName"),
        deviceName: requiredString(args.deviceName, "deviceName"),
        ...optionalNumberProp(args.deviceIndex, "deviceIndex"),
      };
    case "inspect_device_tree":
      return {
        type: "inspect_device_tree",
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.deviceName, "deviceName"),
        ...optionalDevicePathProp(args.devicePath),
      };
    case "inspect_mixer":
      return {
        type: "inspect_mixer",
        ...optionalStringProp(args.trackName, "trackName"),
      };
    case "inspect_clip": {
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
      return {
        type: "inspect_midi_clip",
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
        ...optionalIntegerProp(args.noteOffset, "noteOffset", 0),
        ...optionalIntegerProp(args.noteLimit, "noteLimit", 1, 256),
      };
    case "inspect_song_info":
      return { type: "inspect_song_info" };
    default:
      throw new Error(`Unsupported observation tool: ${toolCall.name}`);
  }
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

  throw new Error(`Invalid JSON arguments for tool call: ${value}`);
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
  return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
}

function optionalNumberProp(value: unknown, key: string): Record<string, number> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
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
