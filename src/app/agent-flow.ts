import type { ExtensionContext } from "@ableton-extensions/sdk";

import {
  AgentPartialCompletionError,
  runAgentLoop,
  type AgentActionPreflightGuard,
  type AgentLoopTraceEvent,
} from "../agent/loop.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  requiresExplicitConfirmation,
  type AgentObservationRequest,
  type AgentPlan,
} from "../agent/actions.js";
import { liveSmithTools } from "../agent/tool-definitions.js";
import {
  AgentPlanExecutionError,
  executeAgentPlan,
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
  conversationHistoryFromEvents,
  getOrCreateDefaultSession,
  nextNewChatTitle,
  projectKeyForContext,
  recoverableSessionsForScope,
} from "./session-context.js";
import { LiveMutationQueue } from "./live-mutation-queue.js";

type Api = ExtensionContext<"1.0.0">;
const maxConsecutiveAgentFailures = 3;

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

  const resolveActiveSession = async () => {
    for (;;) {
      const requestedSessionId = activeSessionId;
      const activeSession = await (
        dependencies.getOrCreateDefaultSession ?? getOrCreateDefaultSession
      )(
        context.environment.storageDirectory,
        interaction,
        interaction.defaultPrompt,
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
      const sessions = allSessions.filter((session) => session.projectKey === projectKey);
      const recoverableSessions = recoverableSessionsForScope(
        allSessions,
        projectKey,
        interaction.scope,
      );
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
        sessions,
        recoverableSessions,
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
        autoApprove: commandInput.autoApprove,
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
        title: nextNewChatTitle(sessions, projectKey),
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
      const candidate = recoverableSessionsForScope(
        allSessions,
        projectKey,
        interaction.scope,
      ).find((session) => session.id === commandInput.sessionId);
      if (!candidate) {
        status = "That previous session cannot be restored to this Live object.";
        return buildState();
      }
      throwIfAborted(signal);
      const restored = await restoreSession(
        context.environment.storageDirectory,
        candidate.id,
        { projectKey, scope: interaction.scope },
      );
      activeSessionId = restored.id;
      rememberedInteractions.set(interactionScopeKey(interaction), interaction);
      status = `Session ${restored.title} restored to ${interaction.scope.label}.`;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "delete_session") {
      if (!(await sessionBelongsToProject(commandInput.sessionId))) {
        status = "That session is not available in this Live Set.";
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
      if (!(await sessionBelongsToProject(commandInput.sessionId))) {
        status = "That session is not available in this Live Set.";
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
          confirmActions: async (plan) => {
            if (await autoApproveEnabledForPlan(
              context.environment.storageDirectory,
              plan,
            )) return true;
            return stream.requestConfirmation({
              message: plan.message,
              groups: actionDiffGroups(plan.actions, plan.targets),
            });
          },
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

export async function autoApproveEnabledForPlan(
  storageDirectory: string | undefined,
  plan: AgentPlan,
): Promise<boolean> {
  if (requiresExplicitConfirmation(plan)) return false;
  return (await loadAgentSettings(storageDirectory)).autoApprove;
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
    prompt,
    projectKey,
    sessionId,
  );
  const history = conversationHistoryFromEvents(
    await loadSessionEvents(context.environment.storageDirectory, session.id),
  );
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
      maxConsecutiveFailures: maxConsecutiveAgentFailures,
      maxIterations: 12,
      maxTotalIterations: 64,
      maxToolCallsPerTurn: 32,
      signal: callbacks.signal,
      askModel: async (input) => {
        await callbacks.onProgress(`Thinking with ${profile.name} / ${profile.model}`);
        const turn = await requestTurn({
          prompt,
          liveContext: interaction.summary,
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
        let results: string[];
        try {
          results = await executeAgentPlan(
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
            results = error.completedResults;
          } else if (error instanceof AgentPlanExecutionError) {
            throw new AgentPartialCompletionError(
              error.completedResults,
              error.cause,
              error.failedActionIndex,
              error.failedAction,
              error.failedTrackName,
              error.completedActionKeys,
            );
          } else {
            throw error;
          }
        }
        await callbacks.onProgress("Updating chat history");
        return results;
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
      actionPreflightRequest(action),
      actionTarget,
    );
    throwIfAborted(signal);
    snapshots.push(await snapshotter(context, action, actionTarget));
    throwIfAborted(signal);
  }
  return snapshots;
}

function actionPreflightRequest(
  action: AgentPlan["actions"][number],
): AgentObservationRequest {
  switch (action.type) {
    case "create_midi_track":
    case "create_audio_track":
      return { type: "inspect_live_set" };
    case "create_scene":
    case "rename_scene":
    case "duplicate_scene":
    case "delete_scene":
    case "create_cue_point":
    case "rename_cue_point":
    case "delete_cue_point":
    case "set_tempo":
      return { type: "inspect_song_info" };
    case "create_midi_clip":
    case "insert_device":
    case "create_arrangement_audio_clip":
    case "clear_arrangement_range":
      return {
        type: "inspect_track",
        ...(action.trackName ? { trackName: action.trackName } : {}),
      };
    case "create_session_midi_clip":
    case "create_session_audio_clip":
    case "delete_session_clip":
      return {
        type: "inspect_clip",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        ...("clipName" in action && action.clipName
          ? { clipName: action.clipName }
          : {}),
        slotIndex: action.slotIndex,
      };
    case "replace_midi_clip_segment":
      return {
        type: "inspect_midi_clip",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        clipName: action.clipName,
        startBeat: action.startBeat,
      };
    case "set_device_parameter":
      if (!action.devicePath) {
        return {
          type: "inspect_device",
          ...(action.trackName ? { trackName: action.trackName } : {}),
          deviceName: action.deviceName,
          ...(action.deviceIndex !== undefined
            ? { deviceIndex: action.deviceIndex }
            : {}),
        };
      }
      return {
        type: "inspect_device_tree",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        deviceName: action.deviceName,
        ...(action.devicePath ? { devicePath: action.devicePath } : {}),
      };
    case "insert_chain_device":
      return {
        type: "inspect_device_tree",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        deviceName: action.rackName,
        ...(action.rackPath ? { devicePath: action.rackPath } : {}),
      };
    case "duplicate_device":
    case "delete_device":
      return {
        type: "inspect_device_tree",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        deviceName: action.deviceName,
        ...(action.devicePath ? { devicePath: action.devicePath } : {}),
      };
    case "replace_simpler_sample":
      return {
        type: "inspect_device_tree",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        deviceName: action.simplerName,
        ...(action.simplerPath ? { devicePath: action.simplerPath } : {}),
      };
    case "configure_drum_pad":
      return {
        type: "inspect_device_tree",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        deviceName: action.rackName,
        ...(action.rackPath ? { devicePath: action.rackPath } : {}),
      };
    case "rename_track":
    case "delete_track":
    case "duplicate_track":
    case "set_track_mute":
    case "set_track_solo":
    case "set_track_arm":
    case "create_take_lane":
    case "rename_take_lane":
      return {
        type: "inspect_track",
        ...(action.trackName ? { trackName: action.trackName } : {}),
      };
    case "set_track_mixer_parameter":
      return {
        type: "inspect_mixer",
        ...(action.trackName ? { trackName: action.trackName } : {}),
      };
    case "set_clip_properties":
    case "set_audio_clip_warp":
      return {
        type: "inspect_clip",
        ...(action.trackName ? { trackName: action.trackName } : {}),
        ...(action.clipName ? { clipName: action.clipName } : {}),
        ...(action.startBeat === undefined ? {} : { startBeat: action.startBeat }),
        ...(action.slotIndex === undefined ? {} : { slotIndex: action.slotIndex }),
      };
    case "delete_clip":
      return {
        type: "inspect_track",
        ...(action.trackName ? { trackName: action.trackName } : {}),
      };
  }
}

interface AgentRequestCallbacks {
  signal: AbortSignal;
  onDelta(delta: string): Promise<void> | void;
  onProgress(message: string): Promise<void> | void;
  onSessionEvent(event: SessionEvent): Promise<void> | void;
  confirmActions(plan: AgentPlan): Promise<boolean>;
  withActionExecutionLock?(
    operation: () => Promise<string[]>,
  ): Promise<string[]>;
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
  });
}

export function showAgentError(context: Api, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  void import("../ui/dialogs.js").then(({ resultUrl }) =>
    context.ui.showModalDialog(resultUrl("Live Smith Error", message), 560, 240),
  );
}
