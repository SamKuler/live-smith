import type { ExtensionContext } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";

import {
  AgentPartialCompletionError,
  AgentSteeringBeforeApplyError,
  AgentSteeringInterruptError,
  runAgentLoop,
  webSearchSummary,
  type AgentActionExecutionOutcome,
  type AgentActionPreflightGuard,
  type AgentConfirmationDecision,
  type AgentLoopTraceEvent,
} from "../agent/loop.js";
import {
  observationRequestForAction,
  type AgentPlan,
} from "../agent/actions.js";
import { liveSmithTools } from "../agent/tool-definitions.js";
import {
  HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND,
  HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
  modelToolsForProfile,
} from "../model/tools.js";
import type {
  ModelContextUsage,
  ModelHostedWebSearch,
  ModelTurn,
} from "../model/contracts.js";
import type { RuntimeProfile } from "../model/provider.js";
import { profileSecrets } from "../model/profile.js";
import {
  AgentPlanExecutionError,
  executeAgentPlanWithProgress,
} from "../live/executor.js";
import type { LiveInteractionContext } from "../live/context.js";
import { observeLive } from "../live/observer.js";
import { captureLiveActionPreflightSnapshot } from "../live/preflight.js";
import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
  boundTrackForAction,
  liveActionIdentityKeys,
  type AgentPlanBindings,
} from "../live/action-bindings.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  listPendingSessionAttachments,
  sessionAttachmentRefFromStored,
} from "../storage/attachments.js";
import {
  appendSessionEvent,
  loadSessionEvents,
  SessionSteeringReceiptConflictError,
  type SessionEvent,
  type SessionEventInput,
  type SessionSteeringReceipt,
} from "../storage/events.js";
import { isStorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import { listSessions, updateSession } from "../storage/sessions.js";
import {
  resolveConversationHistory,
  resolveCurrentAttachmentParts,
} from "./attachment-context.js";
import {
  ChatBridgePromptPersistenceUnknownError,
} from "./chat-bridge.js";
import { sessionErrorMessage } from "./error-routing.js";
import {
  requestModelTurn,
  type ModelTurnRequestInput,
} from "./model-request.js";
import {
  requestModelWithReconnect,
  type ModelReconnectWait,
} from "./model-reconnect.js";
import {
  activeRecoveryLedgerFromEvents,
  getOrCreateDefaultSession,
  recoveryContextFromEvents,
  sessionTitleForPrompt,
} from "./session-context.js";
import { resolveSkillContext } from "./skill-context.js";
import {
  SteeringPersistenceOutcomeUnknownError,
  type SteeringChannel,
} from "./steering.js";

type Api = ExtensionContext<"1.0.0">;
const maxConsecutiveInvalidToolCalls = 3;

export async function handleAgentRequest(
  context: Api,
  storageDirectory: string | undefined,
  interaction: LiveInteractionContext,
  prompt: string,
  runtimeProfile: RuntimeProfile,
  projectKey: string,
  sessionId: string | undefined,
  callbacks: AgentRequestCallbacks,
  requestTurn: AgentModelTurnRequester,
  appendUserEvent: typeof appendSessionEvent = appendSessionEvent,
  appendTraceEvent: typeof appendSessionEvent = appendSessionEvent,
  loadEventsForSearchReconciliation: typeof loadSessionEvents = loadSessionEvents,
  waitForReconnectDelay?: ModelReconnectWait,
): Promise<string> {
  const { profile } = runtimeProfile;
  const session = sessionId === undefined
    ? await getOrCreateDefaultSession(
        storageDirectory,
        interaction,
        projectKey,
        undefined,
        callbacks.signal,
      )
    : (await listSessions(storageDirectory, projectKey)).find(
        (entry) => entry.id === sessionId && !entry.archivedAt,
      );
  if (!session) {
    throw new Error("That Session is not available in this Live Set.");
  }
  const prepareRequest = async () => {
    const priorEvents = await loadSessionEvents(
      storageDirectory,
      session.id,
    );
    const skillContext = await resolveSkillContext({
      storageDirectory: storageDirectory,
      sessionSkillIds: session.activeSkillIds ?? [],
      prompt,
    });
    const currentAttachments = await listPendingSessionAttachments(
      storageDirectory,
      session.id,
      consumedAttachmentIds(priorEvents),
    );
    const attachmentRefs = currentAttachments.map(sessionAttachmentRefFromStored);
    const resolvedAttachments = await resolveCurrentAttachmentParts({
      storageDirectory: storageDirectory,
      sessionId: session.id,
      refs: attachmentRefs,
      runtimeProfile,
      signal: callbacks.signal,
    });
    const history = await resolveConversationHistory({
      storageDirectory: storageDirectory,
      sessionId: session.id,
      events: priorEvents,
      currentAttachmentRefs: attachmentRefs,
      currentDocumentTextCharacters:
        resolvedAttachments.documentTextCharacters,
      runtimeProfile,
      signal: callbacks.signal,
    });
    let userEvent: SessionEvent;
    try {
      userEvent = await appendUserEvent(
        storageDirectory,
        session.id,
        {
          kind: "user",
          content: prompt,
          ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
        },
      );
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        throw new ChatBridgePromptPersistenceUnknownError(
          "Prompt storage commit could not be confirmed.",
          { cause: error },
        );
      }
      throw error;
    }
    return {
      attachmentParts: resolvedAttachments.parts,
      history,
      initialRecoveryState: activeRecoveryLedgerFromEvents(priorEvents),
      recoveryContext: recoveryContextFromEvents(priorEvents),
      skillContext,
      userEvent,
      priorEventIds: priorEvents.map((event) => event.id),
    };
  };
  const prepared = await prepareRequest();
  const knownEventIds = new Set([
    ...prepared.priorEventIds,
    prepared.userEvent.id,
  ]);
  const observedWebSearchIds = new Set<string>();
  const persistedWebSearches = new Map<string, Promise<SessionEvent>>();
  const observeWebSearchId = (webSearch: ModelHostedWebSearch): boolean => {
    if (observedWebSearchIds.has(webSearch.id)) return true;
    if (observedWebSearchIds.size >= HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND) {
      return false;
    }
    observedWebSearchIds.add(webSearch.id);
    return true;
  };
  const ensureTerminalWebSearchEvent = async (
    webSearch: ModelHostedWebSearch,
    content = webSearchSummary(webSearch),
  ): Promise<{ event: SessionEvent; first: boolean } | undefined> => {
    if (!observeWebSearchId(webSearch)) return undefined;
    const existing = persistedWebSearches.get(webSearch.id);
    if (existing) {
      const event = await existing;
      if (
        event.content !== content ||
        event.webSearch === undefined ||
        !sameHostedWebSearch(event.webSearch, webSearch)
      ) {
        throw new TypeError(
          "Hosted Web Search ID has conflicting terminal activity.",
        );
      }
      return { event, first: false };
    }

    const pending = appendTerminalWebSearchEvent(
      storageDirectory,
      session.id,
      { kind: "web_search", content, webSearch },
      knownEventIds,
      appendTraceEvent,
      loadEventsForSearchReconciliation,
    );
    persistedWebSearches.set(webSearch.id, pending);
    try {
      const event = await pending;
      knownEventIds.add(event.id);
      return { event, first: true };
    } catch (error) {
      if (persistedWebSearches.get(webSearch.id) === pending) {
        persistedWebSearches.delete(webSearch.id);
      }
      throw error;
    }
  };
  await callbacks.onSessionEvent(prepared.userEvent);
  if (!session.title.trim()) {
    await updateSession(storageDirectory, session.id, {
      title: sessionTitleForPrompt(prompt, session.scope.label),
    });
  }
  const requestLiveContext = prepared.recoveryContext
    ? `${interaction.summary}\n\n${prepared.recoveryContext}`
    : interaction.summary;
  try {
    await callbacks.onProgress("Starting agent loop");
    const loopResult = await runAgentLoop({
      maxConsecutiveFailures: maxConsecutiveInvalidToolCalls,
      maxIterations: 12,
      maxToolCallsPerTurn: 32,
      maxModelContinuations: 2,
      maxHostFailuresWithoutMutation: 6,
      ...(prepared.initialRecoveryState
        ? { initialRecoveryState: prepared.initialRecoveryState }
        : {}),
      signal: callbacks.signal,
      ...(callbacks.steering
        ? {
          consumeSteering: async () => {
            const entries = callbacks.steering?.takePending(1) ?? [];
            const acceptedPrompts: string[] = [];
            let acceptedCount = 0;
            try {
              for (const entry of entries) {
                if (!callbacks.steeringSendId) {
                  throw new Error(
                    "The active send is missing its steering correlation ID.",
                  );
                }
                const event = await appendSteeringUserEvent(
                  storageDirectory,
                  session.id,
                  callbacks.steeringSendId,
                  entry.id,
                  entry.prompt,
                  appendUserEvent,
                  loadEventsForSearchReconciliation,
                );
                knownEventIds.add(event.id);
                entry.accept();
                acceptedCount += 1;
                acceptedPrompts.push(entry.prompt);
                await callbacks.onSessionEvent(event);
              }
              return acceptedPrompts;
            } catch (error) {
              const rejection = error instanceof SteeringPersistenceOutcomeUnknownError
                ? error
                : new Error(
                  "The steering message could not be persisted.",
                  { cause: error },
                );
              for (const entry of entries.slice(acceptedCount)) {
                try {
                  entry.reject(rejection);
                } catch {
                  // Stop may have closed and rejected the entry concurrently.
                }
              }
              throwIfAborted(callbacks.signal);
              throw error;
            }
          },
          hasPendingSteering: () => callbacks.steering?.hasPending() ?? false,
          onSteeringApplied: async (messageCount: number) => {
            await callbacks.onAssistantReset?.();
            await callbacks.onProgress(
              messageCount === 1
                ? "Replanning with new guidance"
                : `Replanning with ${messageCount} new guidance messages`,
            );
          },
        }
        : {}),
      ...(callbacks.onModelTurnAccepted
        ? { onModelTurnAccepted: callbacks.onModelTurnAccepted }
        : {}),
      askModel: async (input) => {
        await callbacks.onProgress(
          `Thinking with ${profile.name} / ${runtimeProfile.model.model}`,
        );
        const modelTurn = callbacks.steering?.beginModelTurn(callbacks.signal);
        const turnSignal = modelTurn?.signal ?? callbacks.signal;
        let turn: ModelTurn;
        let reconnected = false;
        try {
          const result = await requestModelWithReconnect({
            signal: turnSignal,
            resetTransient: () => callbacks.onAssistantReset?.(),
            onProgress: callbacks.onProgress,
            ...(waitForReconnectDelay
              ? { waitForDelay: waitForReconnectDelay }
              : {}),
            request: async ({ markResponseStarted }) => {
              const remainingWebSearchEvents = Math.max(
                0,
                HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND - observedWebSearchIds.size,
              );
              return requestTurn({
                prompt,
                liveContext: requestLiveContext,
                runtimeProfile,
                history: prepared.history,
                attachmentParts: prepared.attachmentParts,
                skillContext: prepared.skillContext,
                agentMessages: input.messages,
                tools: modelToolsForProfile(
                  runtimeProfile,
                  liveSmithTools(),
                  Math.min(
                    HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
                    remainingWebSearchEvents,
                  ),
                ),
                signal: turnSignal,
                onDelta: async (delta) => {
                  await markResponseStarted();
                  await callbacks.onDelta(delta);
                },
                onHostedWebSearch: async (update) => {
                  await markResponseStarted();
                  if (update.status !== "searching") {
                    const persisted = await ensureTerminalWebSearchEvent(update);
                    if (persisted?.first) {
                      await callbacks.onSessionEvent(persisted.event);
                    }
                  } else {
                    if (!observeWebSearchId(update)) return;
                    if (persistedWebSearches.has(update.id)) {
                      throw new TypeError(
                        "Hosted Web Search reported in-flight activity after its terminal event.",
                      );
                    }
                    await callbacks.onWebSearchUpdate?.(update);
                  }
                  await callbacks.onProgress(webSearchProgressMessage(update));
                },
              });
            },
          });
          turn = result.value;
          reconnected = result.reconnected;
        } catch (error) {
          throwIfAborted(callbacks.signal);
          if (modelTurn?.wasInterrupted()) {
            throw new AgentSteeringInterruptError();
          }
          throw error;
        } finally {
          modelTurn?.dispose();
        }
        throwIfAborted(callbacks.signal);
        if (modelTurn?.wasInterrupted()) {
          throw new AgentSteeringInterruptError();
        }
        if (!reconnected) {
          await callbacks.onProgress("Reading model response");
        }
        return turn;
      },
      observe: async (request) => {
        const observation = await observeLive(
          context,
          request,
          interaction.target,
          callbacks.signal,
        );
        throwIfAborted(callbacks.signal);
        return observation;
      },
      preflightActions: (plan) =>
        preflightAgentPlan(context, interaction, plan, callbacks.signal),
      confirmActions: callbacks.confirmActions,
      executeActions: async (plan, rawBindings) => {
        const bindings = rawBindings as AgentPlanBindings;
        let outcome: AgentActionExecutionOutcome;
        try {
          outcome = await executeAgentPlanWithProgress(
            context,
            plan,
            interaction.target,
            callbacks.signal,
            bindings,
            () => {
              if (callbacks.steering?.hasPending()) {
                throw new AgentSteeringBeforeApplyError(
                  "Newer user guidance arrived before the next Live action began. " +
                    "The remaining actions in this plan were not executed.",
                );
              }
            },
          );
        } catch (error) {
          if (
            error instanceof AgentPlanExecutionError &&
            error.cause instanceof AgentSteeringBeforeApplyError &&
            error.failedActionIndex === 0 &&
            error.completedResults.length === 0 &&
            error.completedMutationCount === 0
          ) {
            throwIfAborted(callbacks.signal);
            throw error.cause;
          }
          if (
            callbacks.signal.aborted &&
            error instanceof AgentPlanExecutionError &&
            error.completedResults.length &&
            isAbortCause(error.cause, callbacks.signal)
          ) {
            outcome = {
              results: error.completedResults,
              mutationCount: error.completedMutationCount,
              incompleteRecovery: {
                completedActionKeys: error.completedActionKeys,
                ...(error.failedActionIndex === undefined
                  ? {}
                  : { failedActionIndex: error.failedActionIndex }),
                failureMessage:
                  "The request was stopped before every confirmed Live action completed.",
              },
            };
          } else if (error instanceof AgentPlanExecutionError) {
            throw new AgentPartialCompletionError(
              error.completedResults,
              error.cause,
              error.failedActionIndex,
              error.failedAction,
              error.failedTrackName,
              error.completedActionKeys,
              error.completedMutationCount,
            );
          } else {
            throw error;
          }
        }
        await callbacks.onProgress("Updating chat history");
        return outcome;
      },
      ...(callbacks.withActionExecutionLock
        ? { withActionExecutionLock: callbacks.withActionExecutionLock }
        : {}),
      onEvent: async (event) => {
        if (event.kind === "web_search") {
          const persisted = await ensureTerminalWebSearchEvent(
            event.webSearch,
            event.content,
          );
          if (persisted?.first) {
            await callbacks.onSessionEvent(persisted.event);
          }
          return;
        }
        const sessionEvent = await appendAgentLoopTraceEvent(
          storageDirectory,
          session.id,
          event,
          appendTraceEvent,
        );
        knownEventIds.add(sessionEvent.id);
        await callbacks.onSessionEvent(sessionEvent);
      },
      onProgress: callbacks.onProgress,
    });
    return loopResult.message;
  } catch (error) {
    try {
      const errorEvent = await appendSessionEvent(
        storageDirectory,
        session.id,
        {
          kind: "error",
          content: sessionErrorMessage(error, profileSecrets(profile)),
        },
      );
      await callbacks.onSessionEvent(errorEvent);
    } catch (persistenceError) {
      console.error("Failed to persist the agent request error.", persistenceError);
    }
    throw error;
  }
}

function isAbortCause(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if ("reason" in signal) return error === signal.reason;
  return error instanceof Error && /abort/i.test(error.message);
}

export async function preflightAgentPlan(
  context: Api,
  interaction: LiveInteractionContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive = observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveInteractionContext["target"],
  ) => string | Promise<string> = captureLiveActionPreflightSnapshot,
): Promise<AgentActionPreflightGuard<AgentPlanBindings>> {
  const initialBindings = bindAgentPlanTargets(
    context,
    plan,
    interaction.target,
  );
  const initialSnapshots = await captureAgentPlanPreflightSnapshots(
    context,
    interaction,
    plan,
    signal,
    observer,
    snapshotter,
    initialBindings,
  );

  const guard: AgentActionPreflightGuard<AgentPlanBindings> = async () => {
    const currentBindings = bindAgentPlanTargets(
      context,
      plan,
      interaction.target,
    );
    assertSameExistingPlanTargets(initialBindings, currentBindings);
    const currentSnapshots = await captureAgentPlanPreflightSnapshots(
      context,
      interaction,
      plan,
      signal,
      observer,
      snapshotter,
      currentBindings,
    );
    const changedIndex = currentSnapshots.findIndex(
      (snapshot, index) => snapshot !== initialSnapshots[index],
    );
    if (
      changedIndex !== -1 ||
      currentSnapshots.length !== initialSnapshots.length
    ) {
      const actionNumber = changedIndex === -1 ? 1 : changedIndex + 1;
      throw new Error(
        `Live target or relevant state changed for action ${actionNumber} while confirmation was open. Inspect the current Live state and try again.`,
      );
    }
    return currentBindings;
  };
  Object.defineProperty(guard, "actionKeys", {
    enumerable: true,
    value: planActionIdentityKeys(plan, initialBindings),
  });
  return guard;
}

function planActionIdentityKeys(
  plan: AgentPlan,
  bindings: AgentPlanBindings,
): string[][] {
  const aliases = new Map(
    Object.entries(plan.targets ?? {}).map(([ref, target]) => [ref, target.trackName]),
  );
  return plan.actions.map((action, actionIndex) => {
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    const trackAliases: string[] = [];
    if ("trackRef" in action && action.trackRef) {
      const alias = aliases.get(action.trackRef);
      if (alias) trackAliases.push(alias);
    } else if ("trackName" in action && action.trackName) {
      trackAliases.push(action.trackName);
    }
    const keys = liveActionIdentityKeys(action, boundTrack, trackAliases);
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref &&
      action.name
    ) {
      aliases.set(action.ref, action.name);
    }
    if (action.type === "rename_track" && action.trackRef) {
      aliases.set(action.trackRef, action.newName);
    } else if (action.type === "rename_track" && action.trackName) {
      for (const [ref, name] of aliases) {
        if (normalizedIdentityText(name) === normalizedIdentityText(action.trackName)) {
          aliases.set(ref, action.newName);
        }
      }
    }
    return keys;
  });
}

function normalizedIdentityText(value: string): string {
  return value.trim().toLowerCase();
}

async function captureAgentPlanPreflightSnapshots(
  context: Api,
  interaction: LiveInteractionContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveInteractionContext["target"],
  ) => string | Promise<string>,
  bindings: AgentPlanBindings,
): Promise<string[]> {
  const snapshots: string[] = [];
  for (const [actionIndex, action] of plan.actions.entries()) {
    throwIfAborted(signal);
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    if ("trackRef" in action && action.trackRef && !boundTrack) {
      snapshots.push(`deferred:${action.type}:${action.trackRef}`);
      continue;
    }
    const actionTarget = boundTrack
      ? { ...interaction.target, track: boundTrack }
      : interaction.target;
    await observer(
      context,
      observationRequestForAction(action),
      actionTarget,
    );
    throwIfAborted(signal);
    snapshots.push(await snapshotter(context, action, actionTarget));
    throwIfAborted(signal);
  }
  return snapshots;
}

interface AgentRequestCallbacks {
  signal: AbortSignal;
  steering?: SteeringChannel;
  steeringSendId?: string;
  onDelta(delta: string): Promise<void> | void;
  onAssistantReset?(): Promise<void> | void;
  onModelTurnAccepted?(usage: ModelContextUsage | undefined): Promise<void> | void;
  onProgress(message: string): Promise<void> | void;
  onWebSearchUpdate?(
    update: ModelHostedWebSearch,
  ): Promise<void> | void;
  onSessionEvent(event: SessionEvent): Promise<void> | void;
  confirmActions(
    plan: AgentPlan,
  ): Promise<boolean | AgentConfirmationDecision>;
  withActionExecutionLock?(
    operation: () => Promise<AgentActionExecutionOutcome>,
  ): Promise<AgentActionExecutionOutcome>;
}

export type AgentModelTurnRequester = (
  input: Omit<ModelTurnRequestInput, "turnExecutor">,
) => ReturnType<typeof requestModelTurn>;

export function consumedAttachmentIds(events: readonly SessionEvent[]): string[] {
  return [...new Set(events.flatMap((event) =>
    event.attachments?.map((attachment) => attachment.id) ?? []
  ))];
}
async function appendAgentLoopTraceEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  event: AgentLoopTraceEvent,
  appendEvent: typeof appendSessionEvent = appendSessionEvent,
): Promise<SessionEvent> {
  if ("name" in event) {
    return appendEvent(storageDirectory, sessionId, {
      kind: event.kind,
      name: event.name,
      content: event.content,
    });
  }

  return appendEvent(storageDirectory, sessionId, {
    kind: event.kind,
    content: event.content,
    ...(event.kind === "web_search" ? { webSearch: event.webSearch } : {}),
    ...(event.kind === "assistant" && event.citations?.length
      ? { citations: event.citations }
      : {}),
    ...(event.kind === "apply_result" && event.recovery
      ? { recovery: event.recovery }
      : {}),
  });
}

async function appendTerminalWebSearchEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  input: SessionEventInput & {
    kind: "web_search";
    webSearch: ModelHostedWebSearch;
  },
  knownEventIds: ReadonlySet<string>,
  appendEvent: typeof appendSessionEvent,
  loadEvents: typeof loadSessionEvents,
): Promise<SessionEvent> {
  let reconciledUnknownOutcome = false;
  for (;;) {
    try {
      return await appendEvent(storageDirectory, sessionId, input);
    } catch (error) {
      if (!isStorageCommitOutcomeUnknownError(error)) throw error;

      const authoritativeEvents = await loadEvents(storageDirectory, sessionId);
      const committed = authoritativeEvents.find((event) =>
        !knownEventIds.has(event.id) &&
        event.kind === "web_search" &&
        event.content === input.content &&
        event.webSearch !== undefined &&
        sameHostedWebSearch(event.webSearch, input.webSearch)
      );
      if (committed) return committed;
      if (reconciledUnknownOutcome) throw error;
      reconciledUnknownOutcome = true;
    }
  }
}

async function appendSteeringUserEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  sendId: string,
  steerId: string,
  content: string,
  appendEvent: typeof appendSessionEvent,
  loadEvents: typeof loadSessionEvents,
): Promise<SessionEvent> {
  const steeringReceipt = steeringReceiptFor(sendId, steerId, content);
  const input = {
    kind: "user" as const,
    content,
    steeringReceipt,
  };
  let reconciledUnknownOutcome = false;
  for (;;) {
    try {
      return await appendEvent(storageDirectory, sessionId, input);
    } catch (error) {
      if (!isStorageCommitOutcomeUnknownError(error)) throw error;

      let authoritativeEvents: SessionEvent[];
      try {
        authoritativeEvents = await loadEvents(storageDirectory, sessionId);
      } catch (cause) {
        throw new SteeringPersistenceOutcomeUnknownError(sendId, steerId, {
          cause,
        });
      }
      const committed = authoritativeEvents.find((event) =>
        event.steeringReceipt?.sendId === sendId &&
        event.steeringReceipt.id === steerId
      );
      if (committed) {
        if (
          committed.kind !== "user" ||
          committed.content !== content ||
          committed.steeringReceipt?.sha256 !== steeringReceipt.sha256
        ) {
          throw new SessionSteeringReceiptConflictError(sendId, steerId);
        }
        return committed;
      }
      if (reconciledUnknownOutcome) {
        throw new SteeringPersistenceOutcomeUnknownError(sendId, steerId, {
          cause: error,
        });
      }
      reconciledUnknownOutcome = true;
    }
  }
}

export function steeringReceiptFor(
  sendId: string,
  steerId: string,
  content: string,
): SessionSteeringReceipt {
  return {
    sendId,
    id: steerId,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function sameHostedWebSearch(
  left: ModelHostedWebSearch,
  right: ModelHostedWebSearch,
): boolean {
  return left.id === right.id &&
    left.status === right.status &&
    left.action === right.action &&
    left.queries.length === right.queries.length &&
    left.queries.every((query, index) => query === right.queries[index]) &&
    left.sources.length === right.sources.length &&
    left.sources.every((source, index) =>
      source.url === right.sources[index]?.url &&
      source.title === right.sources[index]?.title
    );
}

function webSearchProgressMessage(update: ModelHostedWebSearch): string {
  if (update.status === "searching") {
    return update.queries[0]
      ? `Searching for “${update.queries[0]}”…`
      : "Searching the web…";
  }
  if (update.status === "failed") return "Web Search failed.";
  const pages = update.sources.length;
  return pages > 0
    ? `Reviewing ${pages} web ${pages === 1 ? "page" : "pages"}…`
    : "Reading Web Search results…";
}
