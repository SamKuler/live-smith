import type { ExtensionContext } from "@ableton-extensions/sdk";

import {
  AgentPartialCompletionError,
  runAgentLoop,
  type AgentActionExecutionOutcome,
  type AgentActionPreflightGuard,
  type AgentConfirmationDecision,
  type AgentLoopTraceEvent,
} from "../agent/loop.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  observationRequestForAction,
  requiresExplicitConfirmation,
  type AgentPlan,
} from "../agent/actions.js";
import { liveSmithTools } from "../agent/tool-definitions.js";
import {
  AgentPlanExecutionError,
  executeAgentPlanWithProgress,
} from "../live/executor.js";
import {
  interactionContextForScope,
  type LiveInteractionContext,
} from "../live/context.js";
import { observeLive } from "../live/observer.js";
import { captureLiveActionPreflightSnapshot } from "../live/preflight.js";
import {
  assertSameExistingPlanTargets,
  bindAgentPlanTargets,
  boundTrackForAction,
  liveActionIdentityKeys,
  type AgentPlanBindings,
} from "../live/action-bindings.js";
import {
  defaultModelCapabilities,
  resolveModelCapabilities,
  validateGenerationParameters,
} from "../model/capabilities.js";
import type {
  DiscoveredModelInfo,
  RuntimeProfile,
} from "../model/provider.js";
import {
  validateDraftProfileForDiscovery,
  validateDraftProfileForSave,
  type DraftProfile,
  type SavedProfile,
} from "../model/profile.js";
import { transportForProfile } from "../model/registry.js";
import {
  connectionFingerprint,
  loadModelCache,
  saveModelCache,
} from "../storage/model-cache.js";
import {
  appendSessionEvent,
  deleteSessionEvents,
  loadSessionEvents,
  type SessionEvent,
} from "../storage/events.js";
import { isStorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import {
  createSession,
  deleteSession,
  listSessions,
  restoreSession,
  setSessionArchived,
  updateSession,
} from "../storage/sessions.js";
import {
  activeSavedProfile,
  activateSavedProfile,
  deleteSavedProfile,
  loadAgentSettings,
  requireActiveSavedProfile,
  saveSavedProfile,
  saveGlobalSettings,
} from "../storage/settings.js";
import { actionDiffGroups } from "../ui/action-diff.js";
import {
  chatRuntimeSummary,
  modelStateSourceForProfile,
  type ChatDialogState,
} from "../ui/chat-state.js";
import {
  sessionErrorMessage,
  shouldOpenSettingsForAgentError,
} from "./error-routing.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
  ChatBridgePromptPersistenceUnknownError,
  createChatBridge,
  type ChatBridgeCommandInput,
  type ChatBridgeSendInput,
  type ChatBridgeStream,
} from "./chat-bridge.js";
import {
  capabilitiesForProfilePreview,
  requestModelTurn,
  resolveDiscoveredModels,
  runtimeProfileForSavedProfile,
} from "./model-request.js";
import {
  activeRecoveryLedgerFromEvents,
  conversationHistoryFromEvents,
  getOrCreateDefaultSession,
  previousSessionsForProject,
  projectKeyForContext,
  recoveryContextFromEvents,
  continuableSessionsForScope,
  sessionTitleForPrompt,
} from "./session-context.js";
import { LiveMutationQueue } from "./live-mutation-queue.js";

type Api = ExtensionContext<"1.0.0">;
const maxConsecutiveInvalidToolCalls = 3;

export interface AgentFlowDependencies {
  getOrCreateDefaultSession?: typeof getOrCreateDefaultSession;
  loadSessionEvents?: typeof loadSessionEvents;
  listModels?(
    profile: DraftProfile,
    signal: AbortSignal,
  ): Promise<DiscoveredModelInfo[]>;
  renderHtml?(
    state: ChatDialogState,
    bridge: { baseUrl: string; token: string },
  ): string;
  /** Shared by every dialog opened from one extension activation. */
  liveMutationQueue?: LiveMutationQueue;
}

export async function runAgentFlow(
  context: Api,
  interaction: LiveInteractionContext,
  dependencies: AgentFlowDependencies = {},
): Promise<void> {
  let status: string | undefined;
  let openSettingsOnLoad = false;
  let activeSessionId: string | undefined;
  const modelsByConnection = new Map<string, DiscoveredModelInfo[]>();
  const projectKey = projectKeyForContext(context);
  const liveMutationQueue = dependencies.liveMutationQueue ?? new LiveMutationQueue();
  const rememberedInteractions = new Map<string, LiveInteractionContext>([
    [interactionScopeKey(interaction), interaction],
  ]);

  const resolveSessionInteraction = (
    session: { scope: LiveInteractionContext["scope"] },
  ): LiveInteractionContext | undefined => {
    const resolved = interactionContextForScope(context, session.scope);
    if (resolved) {
      rememberedInteractions.set(interactionScopeKey(resolved), resolved);
      return resolved;
    }
    return session.scope.kind === "selection"
      ? rememberedInteractions.get(scopeKey(session.scope))
      : undefined;
  };

  const resolveContinueInteraction = (): LiveInteractionContext =>
    resolveSessionInteraction({ scope: interaction.scope }) ?? interaction;

  const resolveActiveSession = async () => {
    for (;;) {
      const requestedSessionId = activeSessionId;
      const activeSession = await (
        dependencies.getOrCreateDefaultSession ?? getOrCreateDefaultSession
      )(
        context.environment.storageDirectory,
        interaction,
        projectKey,
        requestedSessionId,
      );
      if (activeSessionId !== requestedSessionId) continue;
      activeSessionId = activeSession.id;
      return activeSession;
    }
  };

  const modelsForProfile = async (profile: DraftProfile | SavedProfile) => {
    const fingerprint = connectionFingerprint(profile);
    const cachedModels = modelsByConnection.get(fingerprint);
    if (cachedModels) return cachedModels;
    const models = await loadModelCache(
      context.environment.storageDirectory,
      profile,
    );
    modelsByConnection.set(fingerprint, models);
    return models;
  };

  const buildState = async (previewProfile?: DraftProfile) => {
    const settings = await loadAgentSettings(context.environment.storageDirectory);
    const activeProfile = activeSavedProfile(settings);
    const modelProfile = previewProfile ?? activeProfile;
    const models = modelProfile ? await modelsForProfile(modelProfile) : [];
    const runtimeProfile = activeProfile
      ? runtimeProfileForSavedProfile(
          activeProfile,
          modelProfile?.id === activeProfile.id &&
              connectionFingerprint(modelProfile) === connectionFingerprint(activeProfile)
            ? models
            : await modelsForProfile(activeProfile),
        )
      : null;
    const capabilities = modelProfile
      ? capabilitiesForProfilePreview(modelProfile, models)
      : defaultModelCapabilities();
    for (;;) {
      const activeSession = await resolveActiveSession();
      const allSessions = await listSessions(context.environment.storageDirectory);
      const sessions = allSessions.filter(
        (session) => session.projectKey === projectKey && !session.archivedAt,
      );
      const previousSessions = previousSessionsForProject(allSessions, projectKey);
      const archivedSessions = allSessions.filter((session) => session.archivedAt);
      const continueInteraction = resolveContinueInteraction();
      const events = await (
        dependencies.loadSessionEvents ?? loadSessionEvents
      )(
        context.environment.storageDirectory,
        activeSession.id,
      );
      if (activeSessionId !== activeSession.id) continue;
      const activeInteraction = resolveSessionInteraction(activeSession);
      return {
        defaultPrompt: activeInteraction?.defaultPrompt ?? "",
        contextSummary: activeInteraction?.summary ??
          `The Live object for this session is unavailable: ${activeSession.scope.label}`,
        sessionContinueTarget: {
          kind: continueInteraction.scope.kind,
          label: continueInteraction.scope.label,
        },
        sessions,
        previousSessions,
        archivedSessions,
        activeSessionId: activeSession.id,
        events,
        capabilities,
        availableModels: modelProfile
          ? resolveDiscoveredModels(modelProfile, models)
          : [],
        modelStateSource: modelProfile
          ? modelStateSourceForProfile(modelProfile)
          : null,
        runtimeProfile: runtimeProfile
          ? chatRuntimeSummary(runtimeProfile)
          : null,
        settings,
        status,
        openSettingsOnLoad: activeProfile ? openSettingsOnLoad : true,
      };
    }
  };

  const buildStateAfterCommandMutation = async (
    previewProfile?: DraftProfile,
  ) => {
    try {
      return await buildState(previewProfile);
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "Command completed, but the resulting Live Smith state could not be confirmed.",
        { cause },
      );
    }
  };

  const handleCommand = async (
    commandInput: ChatBridgeCommandInput,
    signal: AbortSignal,
  ) => {
    throwIfAborted(signal);
    if (commandInput.kind === "save_profile") {
      const settings = await loadAgentSettings(context.environment.storageDirectory);
      const otherProfiles = settings.profiles.filter(
        (profile) => profile.id !== commandInput.profile.id,
      );
      const profile = validateDraftProfileForSave(commandInput.profile, otherProfiles);
      const profileFingerprint = connectionFingerprint(profile);
      const cachedModels = modelsByConnection.get(profileFingerprint) ?? [];
      const capabilities = resolveModelCapabilities(
        profile,
        cachedModels.find((model) => model.id === profile.model)?.capabilities,
      );
      validateGenerationParameters(profile, capabilities);
      throwIfAborted(signal);
      await saveSavedProfile(context.environment.storageDirectory, profile);
      modelsByConnection.delete(profileFingerprint);
      status = `Profile ${profile.name} saved.`;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation(profile);
    }

    if (commandInput.kind === "delete_profile") {
      throwIfAborted(signal);
      await deleteSavedProfile(
        context.environment.storageDirectory,
        commandInput.profileId,
      );
      modelsByConnection.clear();
      status = "Profile deleted.";
      openSettingsOnLoad = true;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "activate_profile") {
      throwIfAborted(signal);
      await activateSavedProfile(
        context.environment.storageDirectory,
        commandInput.profileId,
      );
      modelsByConnection.clear();
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "save_global_settings") {
      throwIfAborted(signal);
      await saveGlobalSettings(context.environment.storageDirectory, {
        approvalMode: commandInput.approvalMode,
      });
      status = "Global settings saved.";
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "new_session") {
      const sessions = await listSessions(
        context.environment.storageDirectory,
        projectKey,
      );
      const activeSession = sessions.find((session) => session.id === activeSessionId);
      const activeInteraction = activeSession
        ? resolveSessionInteraction(activeSession)
        : interaction;
      throwIfAborted(signal);
      const session = await createSession(context.environment.storageDirectory, {
        title: "",
        projectKey,
        scope: activeInteraction?.scope ?? interaction.scope,
      });
      activeSessionId = session.id;
      status = "New session created.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "select_session") {
      if (!(await sessionBelongsToProject(commandInput.sessionId))) {
        status = "That session is not available in this Live Set.";
        return buildState();
      }
      throwIfAborted(signal);
      activeSessionId = commandInput.sessionId;
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "restore_session") {
      const allSessions = await listSessions(context.environment.storageDirectory);
      const continueInteraction = resolveContinueInteraction();
      const candidate = continuableSessionsForScope(
        allSessions,
        projectKey,
        continueInteraction.scope,
      ).find((session) => session.id === commandInput.sessionId);
      if (!candidate) {
        status = "That historical Session cannot continue on the current Live object.";
        return buildState();
      }
      throwIfAborted(signal);
      const restored = await restoreSession(
        context.environment.storageDirectory,
        candidate.id,
        { projectKey, scope: continueInteraction.scope },
      );
      activeSessionId = restored.id;
      rememberedInteractions.set(
        interactionScopeKey(continueInteraction),
        continueInteraction,
      );
      const restoredTitle = restored.title || restored.scope.label;
      status =
        `Session ${restoredTitle} is ready on the current ${continueInteraction.scope.kind} “${continueInteraction.scope.label}”.`;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "delete_session") {
      if (!(await sessionExists(commandInput.sessionId))) {
        status = "That Session no longer exists.";
        return buildState();
      }
      throwIfAborted(signal);
      await deleteSessionEvents(context.environment.storageDirectory, commandInput.sessionId);
      await deleteSession(context.environment.storageDirectory, commandInput.sessionId);
      if (activeSessionId === commandInput.sessionId) activeSessionId = undefined;
      status = "Session deleted.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "rename_session") {
      if (!(await sessionExists(commandInput.sessionId))) {
        status = "That Session no longer exists.";
        return buildState();
      }
      throwIfAborted(signal);
      await updateSession(
        context.environment.storageDirectory,
        commandInput.sessionId,
        { title: commandInput.title },
      );
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (
      commandInput.kind === "archive_session" ||
      commandInput.kind === "unarchive_session"
    ) {
      if (!(await sessionExists(commandInput.sessionId))) {
        status = "That Session no longer exists.";
        return buildState();
      }
      throwIfAborted(signal);
      const archived = commandInput.kind === "archive_session";
      await setSessionArchived(
        context.environment.storageDirectory,
        commandInput.sessionId,
        archived,
      );
      if (archived && activeSessionId === commandInput.sessionId) {
        activeSessionId = undefined;
      }
      status = archived ? "Session archived." : "Session returned to the list.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "discover_models") {
      const profile = validateDraftProfileForDiscovery(commandInput.profile);
      let cacheMutationCompleted = false;
      try {
        const discovered = await (
          dependencies.listModels ??
          ((targetProfile, targetSignal) =>
            transportForProfile(targetProfile).listModels(targetProfile, targetSignal))
        )(profile, signal);
        throwIfAborted(signal);
        await saveModelCache(
          context.environment.storageDirectory,
          profile,
          discovered,
        );
        cacheMutationCompleted = true;
        throwIfAborted(signal);
        modelsByConnection.set(connectionFingerprint(profile), discovered);
        status = discovered.length
          ? `Discovered ${discovered.length} model${discovered.length === 1 ? "" : "s"}.`
          : "No models returned by this provider.";
      } catch (error) {
        throwIfAborted(signal);
        status = error instanceof Error ? error.message : String(error);
      }
      openSettingsOnLoad = true;
      return cacheMutationCompleted
        ? buildStateAfterCommandMutation(profile)
        : buildState(profile);
    }

    return assertNeverCommand(commandInput);
  };

  const sessionBelongsToProject = async (sessionId: string): Promise<boolean> =>
    (await listSessions(context.environment.storageDirectory, projectKey)).some(
      (session) => session.id === sessionId && !session.archivedAt,
    );

  const sessionExists = async (sessionId: string): Promise<boolean> =>
    (await listSessions(context.environment.storageDirectory)).some(
      (session) => session.id === sessionId,
    );

  const handleSend = async (
    sendInput: ChatBridgeSendInput,
    stream: ChatBridgeStream,
    signal: AbortSignal,
  ) => {
    const prompt = sendInput.prompt.trim();
    if (!prompt) {
      throw new Error("Prompt is empty.");
    }

    try {
      const sessions = await listSessions(
        context.environment.storageDirectory,
        projectKey,
      );
      const session = sessions.find((entry) => entry.id === sendInput.sessionId);
      if (!session) {
        throw new Error("That session is not available in this Live Set.");
      }
      const sessionInteraction = resolveSessionInteraction(session);
      if (!sessionInteraction) {
        throw new Error(
          `The Live object for this session is no longer available: ${session.scope.label}.`,
        );
      }
      const settingsForRequest = await loadAgentSettings(
        context.environment.storageDirectory,
      );
      const profile = requireActiveSavedProfile(settingsForRequest);
      const fingerprint = connectionFingerprint(profile);
      let models = modelsByConnection.get(fingerprint);
      if (models === undefined) {
        models = await loadModelCache(context.environment.storageDirectory, profile);
        modelsByConnection.set(fingerprint, models);
      }
      const runtimeProfile = runtimeProfileForSavedProfile(profile, models);
      validateGenerationParameters(
        runtimeProfile.profile,
        runtimeProfile.capabilities,
      );
      await handleAgentRequest(
        context,
        sessionInteraction,
        prompt,
        runtimeProfile,
        projectKey,
        sendInput.sessionId,
        {
          signal,
          onDelta: (delta) => stream.assistantDelta(delta),
          onProgress: (message) => stream.progress(message),
          onSessionEvent: (event) => stream.sessionEvent(event),
          withActionExecutionLock: (operation) =>
            liveMutationQueue.run(signal, operation),
          confirmActions: (plan) => decidePlanApproval(
            context.environment.storageDirectory,
            plan,
            () => stream.requestConfirmation({
              message: plan.message,
              groups: actionDiffGroups(plan.actions, plan.targets),
            }),
          ),
        },
      );
    } catch (error) {
      if (shouldOpenSettingsForAgentError(error)) openSettingsOnLoad = true;
      throw error;
    }
  };

  const renderHtml = dependencies.renderHtml ??
    (await import("../ui/dialogs.js")).chatHtml;
  const bridge = await createChatBridge({
    buildState,
    renderHtml,
    handleCommand,
    handleSend,
  });

  try {
    await context.ui.showModalDialog(bridge.url, 1040, 720);
  } finally {
    await bridge.close();
  }
}

export async function decidePlanApproval(
  storageDirectory: string | undefined,
  plan: AgentPlan,
  requestConfirmation: () => Promise<boolean>,
): Promise<AgentConfirmationDecision> {
  const { approvalMode } = await loadAgentSettings(storageDirectory);
  if (
    approvalMode === "everything" ||
    (approvalMode === "low-risk" && !requiresExplicitConfirmation(plan))
  ) {
    return {
      confirmed: true,
      source: "automatic",
      mode: approvalMode,
    };
  }
  return {
    confirmed: await requestConfirmation(),
    source: "user",
  };
}

export async function handleAgentRequest(
  context: Api,
  interaction: LiveInteractionContext,
  prompt: string,
  runtimeProfile: RuntimeProfile,
  projectKey: string,
  sessionId: string | undefined,
  callbacks: AgentRequestCallbacks,
  requestTurn: typeof requestModelTurn = requestModelTurn,
  appendUserEvent: typeof appendSessionEvent = appendSessionEvent,
): Promise<string> {
  const { profile } = runtimeProfile;
  const session = await getOrCreateDefaultSession(
    context.environment.storageDirectory,
    interaction,
    projectKey,
    sessionId,
  );
  const priorEvents = await loadSessionEvents(
    context.environment.storageDirectory,
    session.id,
  );
  const history = conversationHistoryFromEvents(priorEvents);
  const recoveryContext = recoveryContextFromEvents(priorEvents);
  const initialRecoveryState = activeRecoveryLedgerFromEvents(priorEvents);
  if (!session.title.trim()) {
    await updateSession(context.environment.storageDirectory, session.id, {
      title: sessionTitleForPrompt(prompt, session.scope.label),
    });
  }
  const requestLiveContext = recoveryContext
    ? `${interaction.summary}\n\n${recoveryContext}`
    : interaction.summary;
  let userEvent: SessionEvent;
  try {
    userEvent = await appendUserEvent(
      context.environment.storageDirectory,
      session.id,
      {
        kind: "user",
        content: prompt,
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
  await callbacks.onSessionEvent(userEvent);
  try {
    await callbacks.onProgress("Starting agent loop");
    const loopResult = await runAgentLoop({
      maxConsecutiveFailures: maxConsecutiveInvalidToolCalls,
      maxIterations: 12,
      maxToolCallsPerTurn: 32,
      maxHostFailuresWithoutMutation: 6,
      ...(initialRecoveryState ? { initialRecoveryState } : {}),
      signal: callbacks.signal,
      askModel: async (input) => {
        await callbacks.onProgress(`Thinking with ${profile.name} / ${profile.model}`);
        const turn = await requestTurn({
          prompt,
          liveContext: requestLiveContext,
          runtimeProfile,
          history,
          agentMessages: input.messages,
          tools: liveSmithTools(),
          signal: callbacks.signal,
          onDelta: callbacks.onDelta,
        });
        throwIfAborted(callbacks.signal);
        await callbacks.onProgress("Reading model response");
        return turn;
      },
      observe: async (request) => {
        const observation = await observeLive(context, request, interaction.target);
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
          );
        } catch (error) {
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
        const sessionEvent = await appendAgentLoopTraceEvent(
          context.environment.storageDirectory,
          session.id,
          event,
        );
        await callbacks.onSessionEvent(sessionEvent);
      },
      onProgress: callbacks.onProgress,
    });
    return loopResult.message;
  } catch (error) {
    try {
      const errorEvent = await appendSessionEvent(
        context.environment.storageDirectory,
        session.id,
        {
          kind: "error",
          content: sessionErrorMessage(error, [profile.apiKey]),
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
  onDelta(delta: string): Promise<void> | void;
  onProgress(message: string): Promise<void> | void;
  onSessionEvent(event: SessionEvent): Promise<void> | void;
  confirmActions(
    plan: AgentPlan,
  ): Promise<boolean | AgentConfirmationDecision>;
  withActionExecutionLock?(
    operation: () => Promise<AgentActionExecutionOutcome>,
  ): Promise<AgentActionExecutionOutcome>;
}

function scopeKey(scope: LiveInteractionContext["scope"]): string {
  return `${scope.kind}:${scope.identity}`;
}

function interactionScopeKey(interaction: LiveInteractionContext): string {
  return scopeKey(interaction.scope);
}

function assertNeverCommand(commandInput: never): never {
  throw new Error(`Unsupported bridge command: ${JSON.stringify(commandInput)}`);
}

async function appendAgentLoopTraceEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  event: AgentLoopTraceEvent,
): Promise<SessionEvent> {
  if ("name" in event) {
    return appendSessionEvent(storageDirectory, sessionId, {
      kind: event.kind,
      name: event.name,
      content: event.content,
    });
  }

  return appendSessionEvent(storageDirectory, sessionId, {
    kind: event.kind,
    content: event.content,
    ...(event.kind === "apply_result" && event.recovery
      ? { recovery: event.recovery }
      : {}),
  });
}

export function showAgentError(context: Api, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  void import("../ui/dialogs.js").then(({ resultUrl }) =>
    context.ui.showModalDialog(resultUrl("Live Smith Error", message), 560, 240),
  );
}
