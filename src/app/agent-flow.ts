import type { ExtensionContext } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";

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
import { copySelectedAudioAttachmentSource } from "../live/audio-attachment-source.js";
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
import {
  AttachmentProcessingError,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
} from "../attachments/contracts.js";
import {
  isSafeSkillId,
  parseSkillMarkdown,
  SkillFormatError,
} from "../skills/format.js";
import { transportForProfile } from "../model/registry.js";
import {
  connectionFingerprint,
  loadModelCache,
  saveModelCache,
} from "../storage/model-cache.js";
import {
  AttachmentNotFoundError,
  AttachmentPendingQuotaError,
  AttachmentTooLargeError,
  deleteSessionAttachment,
  deleteSessionAttachments,
  listSessionAttachmentDirectoryIds,
  listPendingSessionAttachments,
  saveSessionAttachment,
  sessionAttachmentRefFromStored,
  UnsupportedAttachmentError,
} from "../storage/attachments.js";
import {
  appendSessionEvent,
  deleteSessionEvents,
  listSessionEventLogIds,
  loadSessionEvents,
  type SessionEvent,
} from "../storage/events.js";
import {
  isStorageCommitOutcomeUnknownError,
  withStorageTransaction,
} from "../storage/persistence.js";
import {
  createSession,
  deleteSession,
  listSessions,
  listSessionsInTransaction,
  restoreSession,
  setSessionArchived,
  updateSession,
  updateSessionInTransaction,
} from "../storage/sessions.js";
import {
  deleteInstalledSkillInTransaction,
  installSkillInTransaction,
  listInstalledSkills,
  listInstalledSkillsInTransaction,
  SkillStorageCorruptionError,
  type InstalledSkill,
} from "../storage/skills.js";
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
  ChatBridgeAttachmentValidationError,
  ChatBridgeConflictError,
  ChatBridgePayloadTooLargeError,
  ChatBridgePromptPersistenceUnknownError,
  ChatBridgeResourceNotFoundError,
  ChatBridgeSendFailureError,
  ChatBridgeSkillValidationError,
  createChatBridge,
  type ChatBridgeCommandInput,
  type ChatBridgeAttachmentDeleteInput,
  type ChatBridgeAttachmentInput,
  type ChatBridgeSendInput,
  type ChatBridgeSkillDeleteInput,
  type ChatBridgeSkillInstallInput,
  type ChatBridgeSkillInstallResult,
  type ChatBridgeStream,
  type RawAttachmentBodyReadOptions,
  type RawSkillBodyReadOptions,
} from "./chat-bridge.js";
import {
  resolveConversationHistory,
  resolveCurrentAttachmentParts,
} from "./attachment-context.js";
import {
  capabilitiesForProfilePreview,
  requestModelTurn,
  resolveDiscoveredModels,
  runtimeProfileForSavedProfile,
} from "./model-request.js";
import {
  activeRecoveryLedgerFromEvents,
  getOrCreateDefaultSession,
  previousSessionsForProject,
  projectKeyForContext,
  recoveryContextFromEvents,
  continuableSessionsForScope,
  sessionTitleForPrompt,
} from "./session-context.js";
import { LiveMutationQueue } from "./live-mutation-queue.js";
import {
  SessionMutationFence,
  sessionMutationFenceKey,
} from "./session-mutation-fence.js";
import { resolveSkillContext } from "./skill-context.js";

type Api = ExtensionContext<"1.0.0">;
const maxConsecutiveInvalidToolCalls = 3;
const sessionMutationFence = new SessionMutationFence();

export interface AgentFlowDependencies {
  copySelectedAudioAttachmentSource?: typeof copySelectedAudioAttachmentSource;
  deleteSession?: typeof deleteSession;
  getOrCreateDefaultSession?: typeof getOrCreateDefaultSession;
  loadSessionEvents?: typeof loadSessionEvents;
  requestModelTurn?: typeof requestModelTurn;
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
  /** Test-only bridge body-reader instrumentation. */
  attachmentBodyReadOptions?: RawAttachmentBodyReadOptions;
  /** Test-only Skill body-reader instrumentation. */
  skillBodyReadOptions?: RawSkillBodyReadOptions;
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
  const selectionInteractionsBySessionId = new Map<
    string,
    LiveInteractionContext
  >();
  let bindInvocationSelectionToNextSession = Boolean(
    interaction.selectionContext,
  );
  const pendingSessionCleanup = new Set<string>();
  const withSessionMutation = <T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => sessionMutationFence.run(
    sessionMutationFenceKey(context.environment.storageDirectory, sessionId),
    signal,
    operation,
  );
  const withNamedSessionMutation = <T>(
    sessionId: string,
    kind: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => sessionMutationFence.runNamed(
    sessionMutationFenceKey(context.environment.storageDirectory, sessionId),
    kind,
    signal,
    operation,
  );

  const resolveSessionInteraction = (
    session: { id: string; scope: LiveInteractionContext["scope"] },
  ): LiveInteractionContext | undefined => {
    const remembered = selectionInteractionsBySessionId.get(session.id);
    if (remembered?.selectionContext) {
      const refreshed = remembered.selectionContext.refresh(context);
      if (
        !refreshed ||
        scopeKey(refreshed.scope) !== scopeKey(session.scope)
      ) return undefined;
      const rebound = { ...refreshed, scope: session.scope };
      selectionInteractionsBySessionId.set(session.id, rebound);
      return rebound;
    }
    return interactionContextForScope(context, session.scope);
  };

  const resolveContinueInteraction = (): LiveInteractionContext | undefined => {
    if (interaction.selectionContext) {
      const refreshed = interaction.selectionContext.refresh(context);
      return refreshed &&
          scopeKey(refreshed.scope) === scopeKey(interaction.scope)
        ? { ...refreshed, scope: interaction.scope }
        : undefined;
    }
    return interactionContextForScope(context, interaction.scope);
  };

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
      if (
        requestedSessionId === undefined &&
        bindInvocationSelectionToNextSession &&
        interaction.selectionContext
      ) {
        selectionInteractionsBySessionId.set(activeSession.id, interaction);
        bindInvocationSelectionToNextSession = false;
      }
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

  const buildState = async (
    previewProfile?: DraftProfile,
    options: { heldSessionId?: string } = {},
  ) => {
    if (options.heldSessionId === undefined) {
      await retryPendingSessionCleanup();
    }
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
      const heldSessionId = options.heldSessionId;
      const resolvedActiveSession = heldSessionId === undefined
        ? await resolveActiveSession()
        : undefined;
      const stateSessionId = heldSessionId ?? resolvedActiveSession?.id;
      if (stateSessionId === undefined) {
        throw new Error("A Session is required to build state.");
      }
      const readSessionStateSnapshot = async () => {
        const storageSnapshot = await withStorageTransaction(
          context.environment.storageDirectory,
          async (transaction) => {
            const allSessions = await listSessionsInTransaction(
              transaction,
              context.environment.storageDirectory,
            );
            const availableSkills = (await listInstalledSkillsInTransaction(
              transaction,
              context.environment.storageDirectory,
            )).map(({ id, description }) => ({ id, description }));
            return { allSessions, availableSkills };
          },
        );
        const activeSession = storageSnapshot.allSessions.find(
          (session) =>
            session.id === stateSessionId &&
            session.projectKey === projectKey &&
            !session.archivedAt,
        );
        if (!activeSession) {
          return { kind: "missing" as const };
        }
        const events = await (
          dependencies.loadSessionEvents ?? loadSessionEvents
        )(
          context.environment.storageDirectory,
          activeSession.id,
        );
        const pendingAttachments = (await listPendingSessionAttachments(
          context.environment.storageDirectory,
          activeSession.id,
          consumedAttachmentIds(events),
        )).map(sessionAttachmentRefFromStored);
        return {
          kind: "available" as const,
          activeSession,
          events,
          pendingAttachments,
          signature: JSON.stringify([
            storageSnapshot.allSessions,
            storageSnapshot.availableSkills,
            events,
            pendingAttachments,
          ]),
          storageSnapshot,
        };
      };
      let sessionStateSnapshot = await readSessionStateSnapshot();
      if (
        heldSessionId === undefined &&
        activeSessionId !== stateSessionId
      ) continue;
      if (sessionStateSnapshot.kind === "missing") {
        if (heldSessionId !== undefined) {
          throw new Error("The held Session is no longer available for state.");
        }
        if (activeSessionId === stateSessionId) {
          activeSessionId = undefined;
        }
        continue;
      }
      if (heldSessionId === undefined) {
        const confirmedSnapshot = await readSessionStateSnapshot();
        if (activeSessionId !== stateSessionId) continue;
        if (
          confirmedSnapshot.kind !== "available" ||
          confirmedSnapshot.signature !== sessionStateSnapshot.signature
        ) continue;
        sessionStateSnapshot = confirmedSnapshot;
      }
      const {
        activeSession,
        events,
        pendingAttachments,
        storageSnapshot,
      } = sessionStateSnapshot;
      const allSessions = storageSnapshot.allSessions;
      const sessions = allSessions.filter(
        (session) => session.projectKey === projectKey && !session.archivedAt,
      );
      const previousSessions = previousSessionsForProject(allSessions, projectKey);
      const archivedSessions = allSessions.filter((session) => session.archivedAt);
      const continueInteraction = resolveContinueInteraction();
      if (
        heldSessionId === undefined &&
        activeSessionId !== activeSession.id
      ) continue;
      const activeInteraction = resolveSessionInteraction(activeSession);
      return {
        defaultPrompt: activeInteraction?.defaultPrompt ?? "",
        contextSummary: activeInteraction?.summary ??
          `The Live object for this session is unavailable: ${activeSession.scope.label}`,
        sessionContinueTarget: {
          kind: continueInteraction?.scope.kind ?? interaction.scope.kind,
          label: continueInteraction?.scope.label ?? interaction.scope.label,
        },
        sessions,
        previousSessions,
        archivedSessions,
        activeSessionId: activeSession.id,
        events,
        pendingAttachments,
        availableSkills: storageSnapshot.availableSkills,
        activeSkillIds: [...(activeSession.activeSkillIds ?? [])],
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

  const buildStateWhileHoldingSessionMutation = (
    heldSessionId: string,
    previewProfile?: DraftProfile,
  ) => buildState(previewProfile, {
    heldSessionId,
  });

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
      if (activeInteraction?.selectionContext) {
        selectionInteractionsBySessionId.set(session.id, activeInteraction);
        bindInvocationSelectionToNextSession = false;
      }
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
      const continueInteraction = resolveContinueInteraction();
      if (!continueInteraction) {
        status = "The current Live object or selection is no longer available.";
        return buildState();
      }
      const restored = await withSessionMutation(commandInput.sessionId, signal, async () => {
        const candidate = continuableSessionsForScope(
          await listSessions(context.environment.storageDirectory),
          projectKey,
          continueInteraction.scope,
        ).find((session) => session.id === commandInput.sessionId);
        if (!candidate) return null;
        throwIfAborted(signal);
        return restoreSession(
          context.environment.storageDirectory,
          candidate.id,
          { projectKey, scope: continueInteraction.scope },
        );
      });
      if (!restored) {
        status = "That historical Session cannot continue on the current Live object.";
        return buildState();
      }
      activeSessionId = restored.id;
      if (continueInteraction.selectionContext) {
        selectionInteractionsBySessionId.set(restored.id, continueInteraction);
        bindInvocationSelectionToNextSession = false;
      }
      const restoredTitle = restored.title || restored.scope.label;
      status =
        `Session ${restoredTitle} is ready on the current ${continueInteraction.scope.kind} “${continueInteraction.scope.label}”.`;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "delete_session") {
      let existed = false;
      await withSessionMutation(commandInput.sessionId, signal, async () => {
        existed = await sessionExists(commandInput.sessionId);
        throwIfAborted(signal);
        if (existed) {
          try {
            await (dependencies.deleteSession ?? deleteSession)(
              context.environment.storageDirectory,
              commandInput.sessionId,
            );
          } catch (cause) {
            if (isStorageCommitOutcomeUnknownError(cause)) {
              pendingSessionCleanup.add(commandInput.sessionId);
              throw new ChatBridgeCommandOutcomeUnknownError(
                "Session deletion storage could not be confirmed.",
                { cause },
              );
            }
            throw cause;
          }
          selectionInteractionsBySessionId.delete(commandInput.sessionId);
          if (activeSessionId === commandInput.sessionId) activeSessionId = undefined;
        }
        try {
          await deleteSessionEvents(
            context.environment.storageDirectory,
            commandInput.sessionId,
          );
          await deleteSessionAttachments(
            context.environment.storageDirectory,
            commandInput.sessionId,
          );
          pendingSessionCleanup.delete(commandInput.sessionId);
        } catch (cause) {
          pendingSessionCleanup.add(commandInput.sessionId);
          throw new ChatBridgeCommandOutcomeUnknownError(
            "The Session was deleted, but associated data cleanup could not be confirmed.",
            { cause },
          );
        }
      });
      if (!existed) {
        status = "That Session no longer exists.";
        return buildState();
      }
      status = "Session deleted.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "rename_session") {
      const renamed = await withSessionMutation(commandInput.sessionId, signal, async () => {
        if (!(await sessionExists(commandInput.sessionId))) return false;
        throwIfAborted(signal);
        await updateSession(
          context.environment.storageDirectory,
          commandInput.sessionId,
          { title: commandInput.title },
        );
        return true;
      });
      if (!renamed) {
        status = "That Session no longer exists.";
        return buildState();
      }
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (
      commandInput.kind === "archive_session" ||
      commandInput.kind === "unarchive_session"
    ) {
      const archived = commandInput.kind === "archive_session";
      const changed = await withSessionMutation(commandInput.sessionId, signal, async () => {
        if (!(await sessionExists(commandInput.sessionId))) return false;
        throwIfAborted(signal);
        await setSessionArchived(
          context.environment.storageDirectory,
          commandInput.sessionId,
          archived,
        );
        return true;
      });
      if (!changed) {
        status = "That Session no longer exists.";
        return buildState();
      }
      if (archived && activeSessionId === commandInput.sessionId) {
        activeSessionId = undefined;
      }
      status = archived ? "Session archived." : "Session returned to the list.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "attach_selected_audio_source") {
      return withSessionMutation(commandInput.sessionId, signal, async () => {
        try {
          throwIfAborted(signal);
          const session = await attachmentSession(commandInput.sessionId);
          const sessionInteraction = resolveSessionInteraction(session);
          if (!sessionInteraction) {
            throw new ChatBridgeResourceNotFoundError(
              "The current Live source for this Session is unavailable.",
            );
          }
          const events = await loadSessionEvents(
            context.environment.storageDirectory,
            commandInput.sessionId,
          );
          const pending = await listPendingSessionAttachments(
            context.environment.storageDirectory,
            commandInput.sessionId,
            consumedAttachmentIds(events),
          );
          const source = await (
            dependencies.copySelectedAudioAttachmentSource ??
            copySelectedAudioAttachmentSource
          )({
            context,
            target: sessionInteraction.target,
            signal,
          });
          throwIfAborted(signal);
          await saveSessionAttachment(
            context.environment.storageDirectory,
            commandInput.sessionId,
            {
              fileName: source.fileName,
              bytes: source.bytes,
              claimedMediaType: source.inspection.mediaType,
              signal,
            },
            {
              preSavePendingAttachmentRefs: pending.map(
                sessionAttachmentRefFromStored,
              ),
            },
          );
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            status = "Selected audio source attachment requires verification.";
            openSettingsOnLoad = false;
            let authoritativeState: ChatDialogState | undefined;
            try {
              authoritativeState = await buildStateWhileHoldingSessionMutation(
                commandInput.sessionId,
              );
            } catch {
              authoritativeState = undefined;
            }
            throw new ChatBridgeCommandOutcomeUnknownError(
              "The selected audio source may have been attached, but its final state could not be confirmed.",
              { cause: error, authoritativeState },
            );
          }
          throwIfAborted(signal);
          throwMappedSelectedAudioSourceError(error);
        }
        status = "Selected audio source attached.";
        openSettingsOnLoad = false;
        try {
          return await buildStateWhileHoldingSessionMutation(
            commandInput.sessionId,
          );
        } catch (cause) {
          throw new ChatBridgeCommandOutcomeUnknownError(
            "The selected audio source was attached, but the resulting Live Smith state could not be confirmed.",
            { cause, authoritativeState: undefined },
          );
        }
      });
    }

    if (commandInput.kind === "set_session_skills") {
      const mutationKey = sessionMutationFenceKey(
        context.environment.storageDirectory,
        commandInput.sessionId,
      );
      if (sessionMutationFence.hasQueuedOrActive(mutationKey, "send")) {
        throw new ChatBridgeConflictError(
          "Stop this Session's active request before changing its Skills.",
        );
      }
      const requestedSkillIds = [...commandInput.skillIds].sort();
      await withNamedSessionMutation(
        commandInput.sessionId,
        "skills",
        signal,
        async () => {
          try {
            await withStorageTransaction(
              context.environment.storageDirectory,
              async (transaction) => {
                throwIfAborted(signal);
                const sessions = await listSessionsInTransaction(
                  transaction,
                  context.environment.storageDirectory,
                );
                const session = sessions.find(
                  (candidate) => candidate.id === commandInput.sessionId,
                );
                if (!session) {
                  throw new ChatBridgeResourceNotFoundError(
                    "That Session does not exist.",
                  );
                }
                const installed = await listInstalledSkillsInTransaction(
                  transaction,
                  context.environment.storageDirectory,
                );
                const installedIds = new Set(installed.map((skill) => skill.id));
                const unavailable = requestedSkillIds.find(
                  (skillId) => !installedIds.has(skillId),
                );
                if (unavailable !== undefined) {
                  throw new ChatBridgeSkillValidationError(
                    `Skill ${unavailable} is not installed.`,
                  );
                }

                const currentSkillIds = session.activeSkillIds ?? [];
                const removalOnly = requestedSkillIds.every(
                  (skillId) => currentSkillIds.includes(skillId),
                );
                if (
                  (session.archivedAt !== undefined ||
                    session.projectKey !== projectKey) &&
                  !removalOnly
                ) {
                  throw new ChatBridgeConflictError(
                    "Archived or historical Sessions only allow removing active Skills.",
                  );
                }
                throwIfAborted(signal);
                await updateSessionInTransaction(
                  transaction,
                  context.environment.storageDirectory,
                  session.id,
                  { activeSkillIds: requestedSkillIds },
                );
              },
            );
          } catch (error) {
            if (
              error instanceof ChatBridgeResourceNotFoundError ||
              error instanceof ChatBridgeConflictError ||
              error instanceof ChatBridgeSkillValidationError ||
              isStorageCommitOutcomeUnknownError(error)
            ) {
              throw error;
            }
            throw new ChatBridgeSkillValidationError(
              "Session Skills could not be validated or changed.",
            );
          }
        },
      );
      status = requestedSkillIds.length === 0
        ? "Session Skills cleared."
        : "Session Skills updated.";
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

  async function retryPendingSessionCleanup(): Promise<void> {
    for (const sessionId of [...pendingSessionCleanup]) {
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) {
          pendingSessionCleanup.delete(sessionId);
          return;
        }
        await deleteSessionEvents(
          context.environment.storageDirectory,
          sessionId,
        );
        await deleteSessionAttachments(
          context.environment.storageDirectory,
          sessionId,
        );
        pendingSessionCleanup.delete(sessionId);
      });
    }
  }

  async function reconcileStartupSessionOrphans(): Promise<void> {
    const existingSessionIds = new Set(
      (await listSessions(context.environment.storageDirectory)).map(
        (session) => session.id,
      ),
    );
    const orphanCandidates = new Set([
      ...await listSessionAttachmentDirectoryIds(
        context.environment.storageDirectory,
      ),
      ...await listSessionEventLogIds(
        context.environment.storageDirectory,
      ),
    ]);
    for (const sessionId of [...orphanCandidates].sort()) {
      if (existingSessionIds.has(sessionId)) continue;
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) return;
        await deleteSessionEvents(
          context.environment.storageDirectory,
          sessionId,
        );
        await deleteSessionAttachments(
          context.environment.storageDirectory,
          sessionId,
        );
      });
    }
  }

  const attachmentSession = async (sessionId: string) => {
    const session = (await listSessions(
      context.environment.storageDirectory,
      projectKey,
    )).find((entry) => entry.id === sessionId && !entry.archivedAt);
    if (!session) {
      throw new ChatBridgeResourceNotFoundError(
        "That Session is not available for attachments in this Live Set.",
      );
    }
    return session;
  };

  const buildStateAfterAttachmentMutation = async () => {
    try {
      return await buildState();
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "Attachment storage changed, but the resulting Live Smith state could not be confirmed.",
        { cause },
      );
    }
  };

  const preflightAttachmentUpload = async (
    input: { sessionId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    await attachmentSession(input.sessionId);
    throwIfAborted(signal);
  };

  const handleAttachmentUpload = async (
    input: ChatBridgeAttachmentInput,
    signal: AbortSignal,
  ) => {
    await withSessionMutation(input.sessionId, signal, async () => {
      throwIfAborted(signal);
      await attachmentSession(input.sessionId);
      const events = await loadSessionEvents(
        context.environment.storageDirectory,
        input.sessionId,
      );
      const pending = await listPendingSessionAttachments(
        context.environment.storageDirectory,
        input.sessionId,
        consumedAttachmentIds(events),
      );
      const pendingBytes = pending.reduce(
        (total, attachment) => total + attachment.byteLength,
        0,
      );
      if (
        pending.length >= MAX_PENDING_ATTACHMENT_COUNT ||
        pendingBytes + input.bytes.byteLength > MAX_PENDING_ATTACHMENT_BYTES
      ) {
        throw new ChatBridgePayloadTooLargeError(
          "Pending attachments exceed the per-Session attachment limit.",
        );
      }
      throwIfAborted(signal);
      try {
        await saveSessionAttachment(
          context.environment.storageDirectory,
          input.sessionId,
          {
            fileName: input.fileName,
            bytes: input.bytes,
            ...(input.claimedMediaType === undefined
              ? {}
              : { claimedMediaType: input.claimedMediaType }),
            signal,
          },
          {
            preSavePendingAttachmentRefs: pending.map(
              sessionAttachmentRefFromStored,
            ),
          },
        );
      } catch (error) {
        throwMappedAttachmentError(error);
      }
    });
    return buildStateAfterAttachmentMutation();
  };

  const handleAttachmentDelete = async (
    input: ChatBridgeAttachmentDeleteInput,
    signal: AbortSignal,
  ) => {
    await withSessionMutation(input.sessionId, signal, async () => {
      throwIfAborted(signal);
      await attachmentSession(input.sessionId);
      const events = await loadSessionEvents(
        context.environment.storageDirectory,
        input.sessionId,
      );
      if (events.some((event) =>
        event.attachments?.some((attachment) => attachment.id === input.attachmentId)
      )) {
        throw new ChatBridgeConflictError(
          "An attachment already referenced by a user event cannot be removed.",
        );
      }
      const exists = (await listPendingSessionAttachments(
        context.environment.storageDirectory,
        input.sessionId,
        consumedAttachmentIds(events),
      )).some((attachment) => attachment.id === input.attachmentId);
      if (!exists) {
        throw new ChatBridgeResourceNotFoundError(
          "The requested attachment does not exist in this Session.",
        );
      }
      throwIfAborted(signal);
      try {
        await deleteSessionAttachment(
          context.environment.storageDirectory,
          input.sessionId,
          input.attachmentId,
        );
      } catch (error) {
        if (error instanceof AttachmentNotFoundError) {
          throw new ChatBridgeResourceNotFoundError(error.message);
        }
        throw error;
      }
    });
    return buildStateAfterAttachmentMutation();
  };

  const buildStateAfterSkillMutation = async () => {
    try {
      return await buildState();
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "The Skill catalog changed, but the resulting Live Smith state could not be confirmed.",
        { cause, authoritativeState: undefined },
      );
    }
  };

  const handleSkillInstall = async (
    input: ChatBridgeSkillInstallInput,
    signal: AbortSignal,
  ): Promise<ChatBridgeSkillInstallResult> => {
    throwIfAborted(signal);
    const bytes = Uint8Array.from(input.bytes);
    let definition;
    try {
      definition = parseSkillMarkdown(bytes);
    } catch (error) {
      if (error instanceof SkillFormatError) {
        throw new ChatBridgeSkillValidationError(error.message);
      }
      throw new ChatBridgeSkillValidationError(
        "The uploaded SKILL.md is invalid.",
      );
    }
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    let installed: InstalledSkill | undefined;
    try {
      installed = await withStorageTransaction(
        context.environment.storageDirectory,
        async (transaction) => {
          throwIfAborted(signal);
          const existing = (await listInstalledSkillsInTransaction(
            transaction,
            context.environment.storageDirectory,
          )).find((skill) => skill.id === definition.id);
          if (existing?.sha256 === expectedSha256) return existing;
          if (existing !== undefined && !input.replace) {
            throw new ChatBridgeConflictError(
              `Skill ${definition.id} is already installed. Confirm replacement to change it.`,
            );
          }
          throwIfAborted(signal);
          return installSkillInTransaction(
            transaction,
            context.environment.storageDirectory,
            bytes,
            { replace: input.replace },
          );
        },
      );
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        try {
          installed = (await listInstalledSkills(
            context.environment.storageDirectory,
          )).find((skill) =>
            skill.id === definition.id && skill.sha256 === expectedSha256
          );
        } catch {
          installed = undefined;
        }
        if (installed === undefined) {
          let authoritativeState: ChatDialogState | undefined;
          try {
            authoritativeState = await buildState();
          } catch {
            authoritativeState = undefined;
          }
          throw new ChatBridgeCommandOutcomeUnknownError(
            "The Skill may have been installed, but its final state could not be confirmed.",
            { cause: error, authoritativeState },
          );
        }
      } else if (error instanceof ChatBridgeConflictError) {
        throw error;
      } else if (error instanceof SkillStorageCorruptionError) {
        throw new ChatBridgeSkillValidationError(
          "Installed Skill storage is invalid and was not changed.",
        );
      } else {
        throwIfAborted(signal);
        throw new ChatBridgeSkillValidationError(
          "The Skill could not be installed or replaced.",
        );
      }
    }
    if (installed === undefined) {
      throw new ChatBridgeSkillValidationError(
        "The Skill installation could not be confirmed.",
      );
    }
    status = `Skill ${installed.id} installed.`;
    openSettingsOnLoad = false;
    return {
      state: await buildStateAfterSkillMutation(),
      receipt: { id: installed.id, sha256: installed.sha256 },
    };
  };

  const handleSkillDelete = async (
    input: ChatBridgeSkillDeleteInput,
    signal: AbortSignal,
  ) => {
    if (!isSafeSkillId(input.skillId)) {
      throw new ChatBridgeSkillValidationError("Skill ID is invalid.");
    }
    let deleted = false;
    try {
      await withStorageTransaction(
        context.environment.storageDirectory,
        async (transaction) => {
          throwIfAborted(signal);
          const sessions = await listSessionsInTransaction(
            transaction,
            context.environment.storageDirectory,
          );
          if (sessions.some((session) =>
            session.activeSkillIds?.includes(input.skillId)
          )) {
            throw new ChatBridgeConflictError(
              "Remove this Skill from every Session before deleting it.",
            );
          }
          const existing = (await listInstalledSkillsInTransaction(
            transaction,
            context.environment.storageDirectory,
          )).some((skill) => skill.id === input.skillId);
          if (!existing) return;
          throwIfAborted(signal);
          await deleteInstalledSkillInTransaction(
            transaction,
            context.environment.storageDirectory,
            input.skillId,
          );
          deleted = true;
        },
      );
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        try {
          const stillInstalled = (await listInstalledSkills(
            context.environment.storageDirectory,
          )).some((skill) => skill.id === input.skillId);
          if (!stillInstalled) deleted = true;
          else throw error;
        } catch (reconciliationError) {
          let authoritativeState: ChatDialogState | undefined;
          try {
            authoritativeState = await buildState();
          } catch {
            authoritativeState = undefined;
          }
          throw new ChatBridgeCommandOutcomeUnknownError(
            "The Skill may have been deleted, but its final state could not be confirmed.",
            { cause: reconciliationError, authoritativeState },
          );
        }
      } else if (error instanceof ChatBridgeConflictError) {
        throw error;
      } else if (error instanceof SkillStorageCorruptionError) {
        throw new ChatBridgeSkillValidationError(
          "Installed Skill storage is invalid and was not changed.",
        );
      } else {
        throwIfAborted(signal);
        throw new ChatBridgeSkillValidationError(
          "The Skill could not be deleted.",
        );
      }
    }
    status = deleted
      ? `Skill ${input.skillId} deleted.`
      : `Skill ${input.skillId} is already absent.`;
    openSettingsOnLoad = false;
    return buildStateAfterSkillMutation();
  };

  const handleSend = async (
    sendInput: ChatBridgeSendInput,
    stream: ChatBridgeStream,
    signal: AbortSignal,
  ) => {
    const prompt = sendInput.prompt;
    if (!prompt.trim()) {
      throw new Error("Prompt is empty.");
    }

    return withNamedSessionMutation(sendInput.sessionId, "send", signal, async () => {
      try {
        throwIfAborted(signal);
        const session = (await listSessions(
          context.environment.storageDirectory,
          projectKey,
        )).find((entry) =>
          entry.id === sendInput.sessionId && !entry.archivedAt
        );
        if (!session) {
          throw new Error("That Session is not available in this Live Set.");
        }
        const sessionInteraction = resolveSessionInteraction(session);
        if (!sessionInteraction) {
          throw new Error(
            `The Live object for this Session is no longer available: ${session.scope.label}.`,
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
          session.id,
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
          dependencies.requestModelTurn ?? requestModelTurn,
        );
        return buildStateWhileHoldingSessionMutation(sendInput.sessionId);
      } catch (error) {
        if (shouldOpenSettingsForAgentError(error)) openSettingsOnLoad = true;
        let authoritativeState: ChatDialogState | undefined;
        try {
          authoritativeState = await buildStateWhileHoldingSessionMutation(
            sendInput.sessionId,
          );
        } catch {
          // Preserve the original failure. The client will reconcile explicitly.
        }
        throw new ChatBridgeSendFailureError(error, authoritativeState);
      }
    });
  };

  const renderHtml = dependencies.renderHtml ??
    (await import("../ui/dialogs.js")).chatHtml;
  await reconcileStartupSessionOrphans();
  const bridge = await createChatBridge({
    buildState,
    renderHtml,
    handleCommand,
    handleSend,
    preflightAttachmentUpload,
    handleAttachmentUpload,
    handleAttachmentDelete,
    handleSkillInstall,
    handleSkillDelete,
    ...(dependencies.attachmentBodyReadOptions === undefined
      ? {}
      : { attachmentBodyReadOptions: dependencies.attachmentBodyReadOptions }),
    ...(dependencies.skillBodyReadOptions === undefined
      ? {}
      : { skillBodyReadOptions: dependencies.skillBodyReadOptions }),
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
  const session = sessionId === undefined
    ? await getOrCreateDefaultSession(
        context.environment.storageDirectory,
        interaction,
        projectKey,
      )
    : (await listSessions(context.environment.storageDirectory, projectKey)).find(
        (entry) => entry.id === sessionId && !entry.archivedAt,
      );
  if (!session) {
    throw new Error("That Session is not available in this Live Set.");
  }
  const prepareRequest = async () => {
    const priorEvents = await loadSessionEvents(
      context.environment.storageDirectory,
      session.id,
    );
    const skillContext = await resolveSkillContext({
      storageDirectory: context.environment.storageDirectory,
      sessionSkillIds: session.activeSkillIds ?? [],
      prompt,
    });
    const currentAttachments = await listPendingSessionAttachments(
      context.environment.storageDirectory,
      session.id,
      consumedAttachmentIds(priorEvents),
    );
    const attachmentRefs = currentAttachments.map(sessionAttachmentRefFromStored);
    const resolvedAttachments = await resolveCurrentAttachmentParts({
      storageDirectory: context.environment.storageDirectory,
      sessionId: session.id,
      refs: attachmentRefs,
      runtimeProfile,
      signal: callbacks.signal,
    });
    const history = await resolveConversationHistory({
      storageDirectory: context.environment.storageDirectory,
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
        context.environment.storageDirectory,
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
    };
  };
  const prepared = await prepareRequest();
  await callbacks.onSessionEvent(prepared.userEvent);
  if (!session.title.trim()) {
    await updateSession(context.environment.storageDirectory, session.id, {
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
      maxHostFailuresWithoutMutation: 6,
      ...(prepared.initialRecoveryState
        ? { initialRecoveryState: prepared.initialRecoveryState }
        : {}),
      signal: callbacks.signal,
      askModel: async (input) => {
        await callbacks.onProgress(`Thinking with ${profile.name} / ${profile.model}`);
        const turn = await requestTurn({
          prompt,
          liveContext: requestLiveContext,
          runtimeProfile,
          history: prepared.history,
          attachmentParts: prepared.attachmentParts,
          skillContext: prepared.skillContext,
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

function consumedAttachmentIds(events: readonly SessionEvent[]): string[] {
  return [...new Set(events.flatMap((event) =>
    event.attachments?.map((attachment) => attachment.id) ?? []
  ))];
}

function scopeKey(scope: LiveInteractionContext["scope"]): string {
  return `${scope.kind}:${scope.identity}`;
}

function assertNeverCommand(commandInput: never): never {
  throw new Error(`Unsupported bridge command: ${JSON.stringify(commandInput)}`);
}

function throwMappedAttachmentError(error: unknown): never {
  if (
    error instanceof AttachmentTooLargeError ||
    error instanceof AttachmentPendingQuotaError ||
    (error instanceof AttachmentProcessingError && error.code === "archive_limit")
  ) {
    throw new ChatBridgePayloadTooLargeError(error.message);
  }
  if (
    error instanceof UnsupportedAttachmentError ||
    error instanceof AttachmentProcessingError
  ) {
    throw new ChatBridgeAttachmentValidationError(error.message);
  }
  throw error;
}

function throwMappedSelectedAudioSourceError(error: unknown): never {
  if (
    error instanceof ChatBridgeAttachmentValidationError ||
    error instanceof ChatBridgeConflictError ||
    error instanceof ChatBridgePayloadTooLargeError ||
    error instanceof ChatBridgeResourceNotFoundError ||
    error instanceof ChatBridgeCommandOutcomeUnknownError
  ) throw error;
  if (
    error instanceof AttachmentTooLargeError ||
    error instanceof AttachmentPendingQuotaError ||
    error instanceof UnsupportedAttachmentError ||
    error instanceof AttachmentProcessingError
  ) throwMappedAttachmentError(error);
  throw new ChatBridgeAttachmentValidationError(
    "The selected Live audio source is unavailable or could not be attached.",
  );
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
