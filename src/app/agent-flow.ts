import { ModelInputTooLargeError } from "../model/connection-error.js";
import {
  createDialogModelState,
  effectiveSessionModelSelection,
  oauthProfileScope,
  oauthAuthStatusMessage,
  oauthProviderLabel,
  type OAuthProfileScope,
  type DialogModelStateDependencies,
} from "./model/dialog-model-state.js";
import {
  oauthSubscriptionProviders,
} from "./model/dialog-model-backends.js";
import { createPluginLifecycle, inspectPluginPackage } from "./plugins/plugin-lifecycle.js";
import { createUserSkillLifecycle } from "./plugins/user-skill-lifecycle.js";
import { createSessionLifecycle } from "./session/session-lifecycle.js";
import { importMidiArtifact } from "./midi-artifact-import.js";
import { prepareMidiArtifactImport } from "./midi-artifact-preview.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";

import { audioJobViews, resumeAudioJob } from "./audio/audio-processing.js";
import { downloadAudioOutput } from "./audio/audio-generation.js";
import { audioMessage as m } from "./audio/audio-messages.js";
import { uiMessage, type UiMessage } from "../i18n/ui-message.js";
import { SunoSessionManager } from "./audio/suno/suno-session-manager.js";
import { SunoModelCatalog } from "./audio/suno/suno-model-catalog.js";
import type { readSunoMusicService } from "../audio-services/suno/suno-catalog.js";
import { createSunoSessionVerifier } from "../audio-services/suno/suno-session.js";
import type { SunoSessionVerifier } from "../audio-services/suno/suno-session-contracts.js";
import { openSunoPlatform, openSunoWebsite } from "../runtime/suno-website.js";
import { openAudioDownload } from "../runtime/audio-download-browser.js";
import { createAttachmentOpener } from "./attachments/attachment-opener.js";
import { integrationConnectionsView } from "../storage/settings.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import {
  type AgentConfirmationDecision,
} from "../agent/loop.js";
import {
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";
import { requiresExplicitConfirmation, type AgentPlan } from "../agent/actions.js";
import { EDIT_SCOPES, resolveEditScopes } from "../agent/edit-scopes.js";
import {
  interactionContextForScope,
  type LiveInteractionContext,
} from "../live/context.js";
import {
  defaultModelCapabilities,
  defaultModelCapabilityEvidence,
  validateGenerationParameters,
} from "../model/capabilities.js";
import type {
  DiscoveredModelInfo,
  OAuthAuthState,
} from "../model/provider.js";
import {
  ProfileValidationError,
  validateDraftProfileForDiscovery,
  validateDraftProfileForSave,
  type DraftProfile,
} from "../model/profile.js";
import {
  AttachmentProcessingError,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
} from "../attachments/contracts.js";
import {
  availableSkillSummaries,
} from "../skills/builtins.js";
import { pluginSkillsFromPackages } from "../skills/plugin-package.js";
import { installedPluginViews } from "../plugins/view.js";
import { createPluginAppSessions } from "./plugins/plugin-apps.js";
import {
  canonicalStorageDirectory,
} from "../storage/scope.js";
import {
  connectionFingerprint,
} from "../storage/model-cache.js";
import {
  AttachmentNotFoundError,
  AttachmentPendingQuotaError,
  AttachmentTooLargeError,
  deleteSessionAttachment,
  listPendingSessionAttachments,
  readSessionAttachment,
  saveSessionAttachment,
  sessionAttachmentRefFromStored,
  UnsupportedAttachmentError,
} from "../storage/attachments.js";
import {
  appendSessionEvent,
  loadSessionEvents,
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
  sessionScopeKey,
  setSessionArchived,
  updateSession,
  updateSessionInTransaction,
  type AgentSession,
} from "../storage/sessions.js";
import {
  listInstalledSkillsInTransaction,
} from "../storage/skills.js";
import {
  readEnabledPluginPackagesInTransaction,
  readInstalledPluginPackagesInTransaction,
} from "../storage/plugins.js";
import {
  activeSavedProfile,
  activateSavedProfile,
  deleteSavedProfile,
  loadAgentSettings,
  prepareOAuthCredentialStoreForSavedProfiles,
  requireActiveSavedProfile,
  SavedProfileConflictError,
  saveGlobalSettings,
  saveSavedProfile,
  savedProfileRevision,
  type AgentSettings,
} from "../storage/settings.js";
import { actionDiffGroups } from "../ui/action-diff.js";
import {
  chatConfiguredModels,
  chatRuntimeSummary,
  modelStateSourceForProfile,
  type ChatBridgeState,
  type ChatDialogState,
} from "../ui/chat-state.js";
import { shouldOpenSettingsForAgentError } from "./chat/error-routing.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
  ChatBridgeCommandStoppedError,
  ChatBridgeAttachmentValidationError,
  ChatBridgeConflictError,
  ChatBridgePayloadTooLargeError,
  ChatBridgeResourceNotFoundError,
  ChatBridgeSendFailureError,
  ChatBridgeSkillValidationError,
  createChatBridge,
  type ChatBridgeCommandContext,
  type ChatBridgeCommandInput,
  type ChatBridgeAttachmentDeleteInput,
  type ChatBridgeAttachmentInput,
  type ChatBridgeSendInput,
  type ChatBridgeSendContext,
  type ChatBridgeSendFailureKind,
  type ChatBridgeSkillDeleteInput,
  type ChatBridgeSkillInstallInput,
  type ChatBridgeSkillInstallResult,
  type ChatBridgePluginInstallInput,
  type ChatBridgePluginInstallResult,
  type ChatBridgeSteeringReceiptLookupInput,
  type ChatBridgeSteeringReceiptLookupResult,
  type ChatBridgeStream,
} from "./chat/chat-bridge.js";
import type {
  RawAttachmentBodyReadOptions,
  RawPluginBodyReadOptions,
  RawSkillBodyReadOptions,
} from "./chat/chat-bridge-http.js";
import {
  publishSessionApprovalModeChange,
  subscribeSessionApprovalModeChanges,
} from "./session/session-approval-events.js";
import {
  invalidateSessionEditScopes,
  publishSessionEditScopesChange,
  subscribeSessionEditScopesChanges,
} from "./session/session-edit-scope-events.js";
import {
  publishSessionModelSelectionChange,
  subscribeSessionModelSelectionChanges,
} from "./session/session-model-selection-events.js";
import {
  publishGlobalSettingsChange,
  subscribeGlobalSettingsChanges,
} from "./chat/global-settings-events.js";
import {
  publishProfileSettingsChange,
  subscribeProfileSettingsChanges,
  type ProfileSettingsChange,
} from "./model/profile-settings-events.js";
import {
  capabilityPreviewForProfile, resolveDiscoveredModels,
  runtimeProfileForSavedProfile,
} from "./model/model-request.js";
import {
  recoveryContextFromEvents,
  getOrCreateDefaultSession,
  isReusableEmptySessionMetadata,
  sessionSummaries,
  projectKeyForContext,
  continuableSessionsForScope,
  withSessionCreationScope,
} from "./context/session-context.js";
import {
  claimSession,
  releaseSessionClaims,
  sessionIsClaimedByAnotherOwner,
} from "./session/session-claims.js";
import { resolveSkillContextInTransaction, sessionSkillIdsForEnabledPlugins } from "./context/skill-context.js";
import {
  invalidateGlobalState,
  invalidateSessionState,
  subscribeGlobalStateInvalidations,
  subscribeSessionStateInvalidations,
} from "./session/session-state-events.js";
import { LiveMutationQueue } from "./live-mutation-queue.js";
import {
  SessionMutationFence,
  sessionMutationFenceKey,
} from "./session/session-mutation-fence.js";
import {
  modelAuthSendFenceForStorage,
  type ModelAuthSendFence,
} from "./model/model-auth-send-fence.js";
import {
  SteeringClosedError,
  type SteeringChannel,
} from "./chat/steering.js";
import {
  consumedAttachmentIds,
  handleAgentRequest,
  steeringReceiptFor,
} from "./agent-request.js";
import { closeActiveMcpConnection } from "./plugins/request-plugin-tools.js";
import { loadSessionToolCatalog, sessionToolCatalogOwner } from "./session/session-tool-catalog.js";
import { runPluginParameterTool } from "./plugins/plugin-parameter-tool.js";
import { runAudioParameterTool } from "./audio/audio-parameter-tool.js";
import { providerFetchForStorage } from "./network.js";
import { resolveConversationHistory } from "./context/attachment-context.js";
import { createConversationCheckpoint } from "./context/context-compaction.js";
import { requestModelWithReconnect } from "./model/model-reconnect.js";

type Api = ExtensionContext<"1.0.0">;
const sessionMutationFence = new SessionMutationFence();
const attachmentMutationFence = new SessionMutationFence();
const sessionIntentFence = new SessionMutationFence();
const globalSettingsMutationFence = new SessionMutationFence();
const requestConfigurationFence = new SessionMutationFence();
export interface AgentFlowDependencies extends DialogModelStateDependencies {
  /** Test seams; production uses the OS default browser and a Suno-only verifier. */
  openSunoWebsite?: typeof openSunoWebsite;
  openSunoPlatform?: typeof openSunoPlatform;
  openAudioDownload?: typeof openAudioDownload;
  openAttachment?: (file: Awaited<ReturnType<typeof readSessionAttachment>>, signal: AbortSignal) => Promise<void>;
  verifySunoSession?: SunoSessionVerifier;
  readSunoMusicService?: typeof readSunoMusicService;
  downloadAudioOutput?: typeof downloadAudioOutput;
  appendSessionEvent?: typeof appendSessionEvent;
  deleteSession?: typeof deleteSession;
  getOrCreateDefaultSession?: typeof getOrCreateDefaultSession;
  loadSessionEvents?: typeof loadSessionEvents;
  saveGlobalSettings?: typeof saveGlobalSettings;
  saveSavedProfile?: typeof saveSavedProfile;
  deleteSavedProfile?: typeof deleteSavedProfile;
  updateSessionInTransaction?: typeof updateSessionInTransaction;
  renderHtml?(
    state: ChatBridgeState,
    bridge: { baseUrl: string; token: string },
  ): string;
  /** Shared by every dialog opened from one extension activation. */
  liveMutationQueue?: LiveMutationQueue;
  /** Test-only bridge body-reader instrumentation. */
  attachmentBodyReadOptions?: RawAttachmentBodyReadOptions;
  /** Test-only Skill body-reader instrumentation. */
  skillBodyReadOptions?: RawSkillBodyReadOptions;
  /** Test-only Plugin body-reader instrumentation. */
  pluginBodyReadOptions?: RawPluginBodyReadOptions;
  /** Test-only synchronization point for a concurrent Profile save. */
  beforeSessionModelSelectionCommit?(): Promise<void> | void;
  /** Test-only synchronization point for a concurrent Session approval write. */
  beforeSessionApprovalCommit?(): Promise<void> | void;
  /** Test-only synchronization point for a concurrent Session scope write. */
  beforeSessionEditScopesCommit?(): Promise<void> | void;
}

export async function runAgentFlow(
  context: Api,
  interaction: LiveInteractionContext,
  dependencies: AgentFlowDependencies = {},
): Promise<void> {
  let status: UiMessage | undefined;
  let openSettingsOnLoad = false;
  let activeSessionId: string | undefined;
  let loadedSessionToolCatalog: {
    owner: string;
    value: NonNullable<ChatDialogState["sessionToolCatalog"]>;
  } | undefined;
  const modalSessionOwner = Symbol("Live Smith modal Session owner");
  const storageDirectory = context.environment.storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(context.environment.storageDirectory);
  const providerFetch = providerFetchForStorage(storageDirectory);
  const sunoSessions = new SunoSessionManager(storageDirectory,
    dependencies.verifySunoSession ?? createSunoSessionVerifier(providerFetch));
  const sunoModelCatalog = new SunoModelCatalog(storageDirectory, providerFetch, dependencies.readSunoMusicService);
  let bridge: Awaited<ReturnType<typeof createChatBridge>> | undefined;
  const attachmentOpener = createAttachmentOpener({
    ...(context.environment?.tempDirectory === undefined ? {} : { temporaryDirectory: context.environment.tempDirectory }),
  });
  const projectKey = projectKeyForContext(context);
  const liveMutationQueue = dependencies.liveMutationQueue ?? new LiveMutationQueue();
  const selectionInteractionsBySessionId = new Map<
    string,
    LiveInteractionContext
  >();
  let bindInvocationSelectionToNextSession = Boolean(
    interaction.selectionContext,
  );
  const withAttachmentMutation = <T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => attachmentMutationFence.run(
    sessionMutationFenceKey(storageDirectory, sessionId), signal, operation,
  );
  const withSessionMutation = <T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => sessionMutationFence.run(
    sessionMutationFenceKey(storageDirectory, sessionId),
    signal,
    () => withAttachmentMutation(sessionId, signal, operation),
  );
  const withNamedSessionMutation = <T>(
    sessionId: string,
    kind: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => sessionMutationFence.runNamed(
    sessionMutationFenceKey(storageDirectory, sessionId),
    kind,
    signal,
    kind === "send" ? operation : () => withAttachmentMutation(sessionId, signal, operation),
  );
  const withSessionIntent = <T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) => sessionIntentFence.run(
    sessionMutationFenceKey(storageDirectory, sessionId),
    signal,
    operation,
  );
  const requestConfigurationFenceKey = sessionMutationFenceKey(
    storageDirectory,
    "request-configuration",
  );
  const withRequestConfiguration = <T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => requestConfigurationFence.run(requestConfigurationFenceKey, signal, operation);
  const manualAudioObservations = new Map<string, Map<string, Set<string>>>();
  const notifySessionStateChanged = (sessionId: string): void => {
    invalidateSessionState(storageDirectory, {
      sessionId,
      source: modalSessionOwner,
    });
  };
  const notifyGlobalStateChanged = (sunoAuthServiceId?: string): void => {
    invalidateGlobalState(storageDirectory, { source: modalSessionOwner,
      ...(sunoAuthServiceId === undefined ? {} : { sunoAuthServiceId }),
    });
  };
  const sessionLifecycle = createSessionLifecycle({
    storageDirectory, withSessionMutation, notifySessionStateChanged,
    ...(dependencies.deleteSession === undefined ? {} : { deleteSession: dependencies.deleteSession }),
  });
  const pluginLifecycle = createPluginLifecycle({
    storageDirectory,
    withRequestConfiguration,
    notifyGlobalStateChanged,
    notifySessionStateChanged,
    ...(dependencies.updateSessionInTransaction === undefined ? {} : {
      updateSessionInTransaction: dependencies.updateSessionInTransaction,
    }),
  });
  const userSkillLifecycle = createUserSkillLifecycle({
    storageDirectory, withRequestConfiguration, notifyGlobalStateChanged,
  });
  const publishOAuthPendingState = (
    scope: OAuthProfileScope,
    generation: number,
    auth: OAuthAuthState,
  ): void => {
    if (auth.status !== "pending") return;
    bridge?.publishOAuthAuthState(
      scope.profileId,
      scope.provider,
      generation,
      auth,
    );
  };
  const notifyOAuthAuthStateChanged = (
    scope: OAuthProfileScope,
    generation: number,
    auth: OAuthAuthState,
  ): void => {
    publishOAuthPendingState(scope, generation, auth);
    notifyGlobalStateChanged();
  };
  const modelState = createDialogModelState({ storageDirectory, dependencies, withRequestConfiguration, notifyOAuthAuthStateChanged });
  const {
    modelProjectionForProfile,
    synchronizeAuthGeneration,
    readOAuthAuth,
    reconcilePendingOAuthAuthWhileReading,
    withPendingOAuthAuthReconciliation,
    reconcileSavedProfileOAuthLifecycle,
    reconcileUnknownProfileOAuthLifecycle,
    retryPendingProfileOAuthLifecycle,
    oauthProviderForSavedProfile,
    acquireSessionModelRequester,
  } = modelState;
  const modelAuthSendFenceFor = (profileId: string): ModelAuthSendFence => dependencies.modelAuthSendFence ??
    modelAuthSendFenceForStorage(storageDirectory, profileId);

  const runSessionStateChange = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await operation();
      notifySessionStateChanged(sessionId);
      return result;
    } catch (error) {
      if (isStorageCommitOutcomeUnknownError(error)) {
        notifySessionStateChanged(sessionId);
      }
      throw error;
    }
  };

  const resolveSessionInteraction = (
    session: { id: string; scope: LiveInteractionContext["scope"] },
  ): LiveInteractionContext | undefined => {
    const remembered = selectionInteractionsBySessionId.get(session.id);
    if (remembered?.selectionContext) {
      const refreshed = remembered.selectionContext.refresh(context);
      if (
        !refreshed ||
        sessionScopeKey(refreshed.scope) !== sessionScopeKey(session.scope)
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
          sessionScopeKey(refreshed.scope) === sessionScopeKey(interaction.scope)
        ? { ...refreshed, scope: interaction.scope }
        : undefined;
    }
    return interactionContextForScope(context, interaction.scope);
  };

  const resolveActiveSession = async (signal?: AbortSignal) => {
    for (;;) {
      throwIfAborted(signal);
      const requestedSessionId = activeSessionId;
      const activeSession = await (
        dependencies.getOrCreateDefaultSession ?? getOrCreateDefaultSession
      )(
        storageDirectory,
        interaction,
        projectKey,
        requestedSessionId,
        signal,
        modalSessionOwner,
      );
      throwIfAborted(signal);
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

  type BuildStateOptions = {
    heldSessionId?: string;
    sessionMutationHeld?: boolean;
    oauthAuthAlreadyResolved?: boolean;
    signal?: AbortSignal;
  };

  const prepareBuildStateSettings = async (
    options: BuildStateOptions,
  ): Promise<AgentSettings> => {
    throwIfAborted(options.signal);
    if (!options.sessionMutationHeld) {
      await sessionLifecycle.retryPendingCleanup();
      throwIfAborted(options.signal);
    }
    if (modelState.hasPendingCleanup()) {
      await retryPendingProfileOAuthLifecycle(options.signal);
    }
    const settings = await loadAgentSettings(storageDirectory);
    throwIfAborted(options.signal);
    return settings;
  };

  const buildStateFromSettings = async (
    settings: AgentSettings,
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => {
    const signal = options.signal;
    throwIfAborted(signal);
    const activeProfile = activeSavedProfile(settings);
    const modelProfile = previewProfile ?? activeProfile;
    const modelAuthScope = modelProfile?.connection.kind === "oauth-subscription"
      ? oauthProfileScope(modelProfile)
      : undefined;
    const modelIsActiveProfile = Boolean(
      activeProfile &&
      modelProfile?.id === activeProfile.id &&
      connectionFingerprint(modelProfile) === connectionFingerprint(activeProfile),
    );
    const separateActiveProfileProjection = activeProfile && !modelIsActiveProfile
      ? await modelProjectionForProfile(activeProfile, signal)
      : undefined;
    const modelProjection = modelProfile
      ? await modelProjectionForProfile(modelProfile, signal)
      : { models: [], ready: true };
    const activeProfileProjection = modelIsActiveProfile
      ? modelProjection
      : separateActiveProfileProjection ?? { models: [], ready: true };
    if (modelAuthScope) {
      await synchronizeAuthGeneration(modelAuthScope, signal);
      if (!options.oauthAuthAlreadyResolved) {
        if (
          modelAuthSendFenceFor(modelAuthScope.profileId).hasPendingLogin(
            modelAuthScope.provider,
          )
        ) {
          await reconcilePendingOAuthAuthWhileReading(modelAuthScope, signal);
        } else if (
          modelState.authProjection(modelAuthScope)?.auth === undefined
        ) {
          await readOAuthAuth(modelAuthScope, signal);
        }
      }
    }
    const models = modelProjection.models;
    const activeProfileModels = activeProfileProjection.models;
    const capabilityPreview = modelProfile
      ? capabilityPreviewForProfile(modelProfile, models)
      : {
          capabilities: defaultModelCapabilities(),
          capabilityEvidence: defaultModelCapabilityEvidence(),
        };
    for (;;) {
      const heldSessionId = options.heldSessionId;
      const resolvedActiveSession = heldSessionId === undefined
        ? await resolveActiveSession(signal)
        : undefined;
      const stateSessionId = heldSessionId ?? resolvedActiveSession?.id;
      if (stateSessionId === undefined) {
        throw new Error("A Session is required to build state.");
      }
      const readSessionStateSnapshot = async () => {
        throwIfAborted(signal);
        const storageSnapshot = await withStorageTransaction(
          storageDirectory,
          async (transaction) => {
            const savedSessions = await listSessionsInTransaction(transaction, storageDirectory);
            const installedSkills = await listInstalledSkillsInTransaction(
              transaction,
              storageDirectory,
            );
            const pluginPackages = await readInstalledPluginPackagesInTransaction(
              transaction,
              storageDirectory,
            );
            const allSessions = await sessionSummaries(
              storageDirectory,
              savedSessions.map((session) => ({
                ...session,
                activeSkillIds: sessionSkillIdsForEnabledPlugins(
                  session.activeSkillIds ?? [],
                  pluginPackages.map(({ plugin }) => plugin),
                ),
              })),
            );
            const pluginSkills = await pluginSkillsFromPackages(
              pluginPackages.filter((entry) => entry.plugin.enabled),
            );
            const availableSkills = availableSkillSummaries(installedSkills, pluginSkills);
            const plugins = await installedPluginViews(pluginPackages);
            return { allSessions, availableSkills, plugins };
          },
        );
        throwIfAborted(signal);
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
          storageDirectory,
          activeSession.id,
        );
        throwIfAborted(signal);
        const pendingAttachments = (await listPendingSessionAttachments(
          storageDirectory,
          activeSession.id,
          consumedAttachmentIds(events),
        )).map(sessionAttachmentRefFromStored);
        throwIfAborted(signal);
        return {
          kind: "available" as const,
          activeSession,
          events,
          pendingAttachments,
          signature: JSON.stringify([
            storageSnapshot.allSessions,
            storageSnapshot.availableSkills,
            storageSnapshot.plugins,
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
      const previousSessions = allSessions.filter(
        (session) => session.projectKey !== projectKey && !session.archivedAt,
      );
      const archivedSessions = allSessions.filter((session) => session.archivedAt);
      const continueInteraction = resolveContinueInteraction();
      if (
        heldSessionId === undefined &&
        activeSessionId !== activeSession.id
      ) continue;
      const activeInteraction = resolveSessionInteraction(activeSession);
      const runtimeProfile = activeProfile
        ? runtimeProfileForSavedProfile(
            activeProfile,
            activeProfileModels,
            effectiveSessionModelSelection(activeProfile, activeSession),
          )
        : null;
      const projectedAuthGeneration = modelAuthScope === undefined
        ? 0
        : modelAuthSendFenceFor(modelAuthScope.profileId).peekAuthGeneration(
            modelAuthScope.provider,
          );
      const authProjection = modelAuthScope === undefined
        ? undefined
        : modelState.authProjection(modelAuthScope);
      const audioJobs = await audioJobViews(storageDirectory, activeSession.id);
      const sunoAccounts = await sunoSessions.views(settings.integrationConnections?.connections ?? []);
      const catalog = await sunoModelCatalog.view(settings.integrationConnections?.revision);
      throwIfAborted(signal);
      const state: ChatDialogState = {
        contextSummary: activeInteraction?.summary ??
          `The Live object for this session is unavailable: ${activeSession.scope.label}`,
        liveContext: activeInteraction
          ? {
              sessionId: activeSession.id,
              availability: "available" as const,
              value: activeInteraction.presentation,
            }
          : {
              sessionId: activeSession.id,
              availability: "unavailable" as const,
              label: activeSession.scope.label,
            },
        sessionContinueTarget: {
          kind: continueInteraction?.scope.kind ?? interaction.scope.kind,
          label: continueInteraction?.scope.label ?? interaction.scope.label,
        },
        sessions,
        previousSessions,
        archivedSessions,
        activeSessionId: activeSession.id,
        approvalMode: activeSession.approvalMode ?? "manual",
        events,
        pendingAttachments,
        ...(settings.integrationConnections ? { integrationConnections: integrationConnectionsView(settings.integrationConnections) } : {}),
        audioJobs,
        sunoAccounts,
        ...(catalog === undefined ? {} : { sunoModelCatalog: catalog }),
        availableSkills: storageSnapshot.availableSkills,
        plugins: storageSnapshot.plugins,
        activeSkillIds: [...(activeSession.activeSkillIds ?? [])],
        capabilities: capabilityPreview.capabilities,
        capabilityEvidence: capabilityPreview.capabilityEvidence,
        availableModels: modelProfile
          ? resolveDiscoveredModels(modelProfile, models)
          : [],
        ...(modelProfile && modelState.catalogReceipt(modelProfile) !== undefined
          ? {
              modelCatalogLoadReceipt: modelState.catalogReceipt(modelProfile)!,
            }
          : {}),
        configuredModels: activeProfile
          ? chatConfiguredModels(activeProfile, activeProfileModels)
          : [],
        configuredModelsReady: activeProfileProjection.ready,
        modelStateSource: modelProfile
          ? modelStateSourceForProfile(modelProfile)
          : null,
        runtimeProfile: runtimeProfile
          ? chatRuntimeSummary(runtimeProfile)
          : null,
        activeProfileRevision: activeProfile === null
          ? null
          : savedProfileRevision(activeProfile),
        settings,
        ...(modelAuthScope === undefined ||
            authProjection?.auth === undefined ||
            authProjection.generation !== projectedAuthGeneration
          ? {}
          : {
              oauthAuth: authProjection.auth,
              oauthAuthProfileId: modelAuthScope.profileId,
              oauthAuthProvider: modelAuthScope.provider,
            }),
        oauthAuthGeneration: projectedAuthGeneration,
        status,
        openSettingsOnLoad: activeProfile ? openSettingsOnLoad : true,
      };
      if (loadedSessionToolCatalog) {
        const owner = sessionToolCatalogOwner(state);
        if (loadedSessionToolCatalog.owner === owner) {
          state.sessionToolCatalog = loadedSessionToolCatalog.value;
        } else if (options.heldSessionId === undefined) {
          loadedSessionToolCatalog = undefined;
        }
      }
      return state;
    }
  };

  const buildStateWithAuthReadHeld = async (
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => buildStateFromSettings(
    await prepareBuildStateSettings(options),
    previewProfile,
    options,
  );

  const stateOAuthScope = (
    previewProfile: DraftProfile | undefined,
    settings: AgentSettings,
  ): OAuthProfileScope | undefined => {
    const profile = previewProfile ?? activeSavedProfile(settings);
    return profile?.connection.kind === "oauth-subscription"
      ? oauthProfileScope(profile)
      : undefined;
  };

  const buildState = async (
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => {
    const signal = options.signal;
    const settings = await prepareBuildStateSettings(options);
    const scope = stateOAuthScope(previewProfile, settings);
    if (scope === undefined) {
      return buildStateFromSettings(settings, previewProfile, options);
    }
    const releaseAuthRead = await modelAuthSendFenceFor(scope.profileId)
      .enterRead(signal);
    try {
      return await buildStateFromSettings(settings, previewProfile, options);
    } finally {
      releaseAuthRead();
    }
  };

  const buildStateWhileHoldingSessionMutation = (
    heldSessionId: string,
    previewProfile?: DraftProfile,
  ) => buildState(previewProfile, {
    heldSessionId,
    sessionMutationHeld: true,
  });

  const confirmCommandState = async (
    build: () => Promise<ChatDialogState>,
  ): Promise<ChatDialogState> => {
    try {
      return await build();
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "Command completed, but the resulting Live Smith state could not be confirmed.",
        { cause },
      );
    }
  };

  const buildStateAfterCommandMutation = (
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => confirmCommandState(() => buildState(previewProfile, options));

  const resolveCommittedProfileLifecycleFailure = async (
    profileId: string,
    message: string,
    cause: unknown,
    previewProfile: DraftProfile | undefined,
    signal: AbortSignal,
  ): Promise<ChatDialogState> => {
    let authoritativeState: ChatDialogState | undefined;
    try {
      authoritativeState = await buildState(previewProfile, { signal });
      if (!modelState.hasPendingCleanup(profileId)) {
        return authoritativeState;
      }
    } catch {
      // The command remains explicit about the committed settings and asks the
      // client to reconcile when OAuth cleanup cannot be safely confirmed.
    }
    throw new ChatBridgeCommandOutcomeUnknownError(message, {
      cause,
      authoritativeState,
    });
  };

  const withOAuthAuthProjection = (
    state: ChatDialogState,
    scope: OAuthProfileScope,
    auth: OAuthAuthState,
  ): ChatDialogState => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    if (
      state.oauthAuthProfileId === scope.profileId &&
      state.oauthAuthProvider === scope.provider &&
      state.oauthAuth !== undefined &&
      state.oauthAuthGeneration ===
        modelAuthSendFence.peekAuthGeneration(scope.provider)
    ) {
      return state;
    }
    return {
      ...state,
      oauthAuth: auth,
      oauthAuthProfileId: scope.profileId,
      oauthAuthProvider: scope.provider,
      oauthAuthGeneration: modelAuthSendFence.peekAuthGeneration(scope.provider),
    };
  };

  const handleCommand = async (
    commandInput: ChatBridgeCommandInput,
    signal: AbortSignal,
    commandContext: ChatBridgeCommandContext,
  ) => {
    throwIfAborted(signal);
    const runProfileSettingsMutation = async (
      operation: () => Promise<unknown>,
    ): Promise<void> => requestConfigurationFence.run(
      requestConfigurationFenceKey,
      signal,
      async () => {
        try {
          await operation();
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            publishProfileSettingsChange(storageDirectory, {
              commandId: commandContext.commandId,
            });
          }
          throw error;
        }
        publishProfileSettingsChange(storageDirectory, {
          commandId: commandContext.commandId,
        });
      },
    );
    if (commandInput.kind === "discard_profile_oauth") {
      const profileId = commandInput.profileId;
      const profileFence = modelAuthSendFenceFor(profileId);
      const hasOAuthLifecycle =
        modelState.hasPendingCleanup(profileId) ||
        profileFence.hasPendingLogin() ||
        oauthSubscriptionProviders.some(
          (provider) => profileFence.hasAuthActivity(provider),
        ) ||
        modelState.hasUsedOAuth(profileId);
      if (!hasOAuthLifecycle) {
        status = undefined;
        return buildStateAfterCommandMutation(undefined, { signal });
      }
      let releaseProfileMutation: (() => void) | undefined;
      try {
        releaseProfileMutation = await modelState.enterProfileMutation(
          profileId,
          profileFence.pendingLoginProvider() ?? "openai",
          signal,
        ) ?? undefined;
      } catch (cause) {
        throw new Error(
          "OAuth cleanup for this discarded Profile draft could not be confirmed. Restart Live Smith before discarding it.",
          { cause },
        );
      }
      if (!releaseProfileMutation) {
        throw new ChatBridgeConflictError(
          "Stop active requests before discarding this Profile draft.",
        );
      }
      try {
        await requestConfigurationFence.run(
          requestConfigurationFenceKey,
          signal,
          async () => {
            try {
              await waitForPromiseWithSignal(
                prepareOAuthCredentialStoreForSavedProfiles(storageDirectory),
                signal,
              );
              const settings = await loadAgentSettings(storageDirectory);
              await reconcileSavedProfileOAuthLifecycle(
                profileId,
                oauthProviderForSavedProfile(settings, profileId),
              );
              modelState.clearPendingCleanup(profileId);
            } catch (cause) {
              modelState.markPendingCleanup(profileId);
              throw new Error(
                "OAuth cleanup for this discarded Profile draft could not be confirmed. Retry or restart Live Smith before discarding it.",
                { cause },
              );
            }
          },
        );
      } finally {
        releaseProfileMutation();
      }
      status = undefined;
      return buildStateAfterCommandMutation(undefined, { signal });
    }
    if (commandInput.kind === "save_profile") {
      const settings = await loadAgentSettings(storageDirectory);
      const otherProfiles = settings.profiles.filter(
        (profile) => profile.id !== commandInput.profile.id,
      );
      const profile = validateDraftProfileForSave(commandInput.profile, otherProfiles);
      const previousProfile = settings.profiles.find(
        (entry) => entry.id === profile.id,
      );
      const profileFence = modelAuthSendFenceFor(profile.id);
      const targetProvider = profile.connection.kind === "oauth-subscription"
        ? profile.connection.provider
        : undefined;
      const previousProvider = previousProfile?.connection.kind ===
          "oauth-subscription"
        ? previousProfile.connection.provider
        : undefined;
      const requiresOAuthLifecycleReconciliation = (): boolean => {
        const hasForeignOAuthActivity = oauthSubscriptionProviders.some(
          (provider) =>
            provider !== targetProvider &&
            (
              profileFence.hasAuthActivity(provider) ||
              modelState.hasUsedOAuth(profile.id, provider)
            ),
        );
        return targetProvider === undefined
          ? previousProvider !== undefined ||
            profileFence.hasPendingLogin() ||
            hasForeignOAuthActivity
          : previousProvider !== undefined && previousProvider !== targetProvider ||
            profileFence.pendingLoginProvider() !== undefined &&
              profileFence.pendingLoginProvider() !== targetProvider ||
            hasForeignOAuthActivity;
      };
      const saveWithCatalog = async (
        cachedModels: DiscoveredModelInfo[],
        subscriptionCatalogReady = false,
        expectedOAuthGeneration?: number,
        profileUseHeld = false,
      ): Promise<ChatDialogState> => {
        const previousModelsById = new Map(
          (previousProfile?.models ?? []).map((model) => [model.model, model]),
        );
        const cachedModelsById = new Map(
          cachedModels.map((model) => [model.id, model]),
        );
        const configuredModelIndexes = new Map(
          profile.models.map((model, index) => [model.model, index]),
        );
        const modelConfigsToValidate = profile.connection.kind === "direct-api"
          ? profile.models
          : subscriptionCatalogReady
            ? profile.models
            : profile.models.filter((model) => {
                if (previousProfile?.connection.kind !== "oauth-subscription") {
                  return true;
                }
                const previous = previousModelsById.get(model.model);
                return !previous || JSON.stringify(previous) !== JSON.stringify(model);
              });
        const subscriptionDefaultChanged =
          profile.connection.kind === "oauth-subscription" &&
          previousProfile?.connection.kind === "oauth-subscription" &&
          profile.defaultModel !== previousProfile.defaultModel;
        if (
          profile.connection.kind === "oauth-subscription" &&
          (modelConfigsToValidate.length > 0 || subscriptionDefaultChanged) &&
          !subscriptionCatalogReady
        ) {
          throw new ChatBridgeConflictError(
            `Load the current ${oauthProviderLabel(profile.connection.provider)} model catalog before changing subscription model settings.`,
          );
        }
        for (const model of modelConfigsToValidate) {
          if (
            profile.connection.kind === "oauth-subscription" &&
            !cachedModelsById.has(model.model)
          ) {
            throw new ProfileValidationError(
              "models",
              `Model ${model.model} is not available for the signed-in ${oauthProviderLabel(profile.connection.provider)} account.`,
            );
          }
          const runtimeProfile = runtimeProfileForSavedProfile(
            profile,
            cachedModels,
            { model: model.model },
            {
              configuredModelIndexes,
              discoveredModelsById: cachedModelsById,
            },
          );
          validateGenerationParameters(
            runtimeProfile,
            runtimeProfile.capabilities,
          );
        }
        throwIfAborted(signal);
        const fenceProvider = profileFence.pendingLoginProvider() ??
          (profile.connection.kind === "oauth-subscription"
            ? profile.connection.provider
            : previousProfile?.connection.kind === "oauth-subscription"
              ? previousProfile.connection.provider
              : "openai");
        const releaseProfileMutation = profileUseHeld
          ? undefined
          : await modelState.enterProfileMutation(
              profile.id,
              fenceProvider,
              signal,
            ) ?? undefined;
        if (!profileUseHeld && !releaseProfileMutation) {
          throw new ChatBridgeConflictError(
            "Stop active requests or finish the pending sign-in before saving this Profile.",
          );
        }
        const oauthLifecycleRequired = profileUseHeld
          ? false
          : requiresOAuthLifecycleReconciliation();
        let committedLifecycleFailure: { cause: unknown } | undefined;
        try {
          if (
            targetProvider !== undefined &&
            expectedOAuthGeneration !== undefined &&
            profileFence.authGeneration(targetProvider) !==
              expectedOAuthGeneration
          ) {
            throw new ChatBridgeConflictError(
              `${oauthProviderLabel(targetProvider)} sign-in changed before this Profile could be saved. Load models again.`,
            );
          }
          try {
            await runProfileSettingsMutation(async () => {
              if (oauthLifecycleRequired) {
                await waitForPromiseWithSignal(
                  prepareOAuthCredentialStoreForSavedProfiles(storageDirectory),
                  signal,
                );
              }
              return (dependencies.saveSavedProfile ?? saveSavedProfile)(
                storageDirectory,
                profile,
                {
                expectedCurrentProfileRevision:
                  commandInput.expectedProfileRevision,
                },
              );
            });
          } catch (error) {
            if (
              oauthLifecycleRequired &&
              isStorageCommitOutcomeUnknownError(error)
            ) {
              await reconcileUnknownProfileOAuthLifecycle(profile.id, signal);
            }
            throw error;
          }
          if (oauthLifecycleRequired) {
            try {
              await reconcileSavedProfileOAuthLifecycle(
                profile.id,
                targetProvider,
              );
            } catch (cause) {
              modelState.markPendingCleanup(profile.id);
              committedLifecycleFailure = { cause };
            }
          }
        } catch (error) {
          if (error instanceof SavedProfileConflictError) {
            throw new ChatBridgeConflictError(error.message);
          }
          throw error;
        } finally {
          releaseProfileMutation?.();
        }
        if (profile.connection.kind === "direct-api") {
          // Direct API catalogs are durable and are reloaded from storage after
          // Save. Subscription catalogs are modal-only and remain valid until
          // this Profile's auth generation changes.
          modelState.invalidateDirectCatalog(profile);
        }
        status = `Profile ${profile.name} saved.`;
        openSettingsOnLoad = false;
        if (committedLifecycleFailure) {
          return resolveCommittedProfileLifecycleFailure(
            profile.id,
            "The Profile was saved, but OAuth account cleanup could not be confirmed. Restart Live Smith before using subscription sign-in again.",
            committedLifecycleFailure.cause,
            profile,
            signal,
          );
        }
        return buildStateAfterCommandMutation(profile, { signal });
      };

      if (profile.connection.kind === "direct-api") {
        return saveWithCatalog(
          modelState.cachedCatalog(profile).models,
        );
      }

      const profileAuthScope = oauthProfileScope(profile);
      const releaseOAuthSave = await modelAuthSendFenceFor(
        profileAuthScope.profileId,
      ).enterOAuthUse(signal);
      if (!releaseOAuthSave) {
        throw new ChatBridgeConflictError(
          `Wait for the ${oauthProviderLabel(profile.connection.provider)} sign-in operation to finish before saving this Profile.`,
        );
      }
      try {
        const generation = await synchronizeAuthGeneration(
          profileAuthScope,
          signal,
        );
        const { ready: subscriptionCatalogReady, models: cachedModels } = modelState.cachedCatalog(profile, generation);
        const oauthLifecycleRequired = requiresOAuthLifecycleReconciliation();
        if (oauthLifecycleRequired) releaseOAuthSave();
        return await saveWithCatalog(
          cachedModels,
          subscriptionCatalogReady,
          generation,
          !oauthLifecycleRequired,
        );
      } finally {
        releaseOAuthSave();
      }
    }

    if (commandInput.kind === "delete_profile") {
      throwIfAborted(signal);
      const settings = await loadAgentSettings(storageDirectory);
      const initialDeletedProfile = settings.profiles.find(
        (profile) => profile.id === commandInput.profileId,
      );
      const profileFence = modelAuthSendFenceFor(commandInput.profileId);
      const releaseProfileMutation = await modelState.enterProfileMutation(
        commandInput.profileId,
        profileFence.pendingLoginProvider() ??
          (initialDeletedProfile?.connection.kind === "oauth-subscription"
            ? initialDeletedProfile.connection.provider
            : "openai"),
        signal,
      ) ?? undefined;
      if (!releaseProfileMutation) {
        throw new ChatBridgeConflictError(
          "Stop active requests before deleting this Profile.",
        );
      }
      let committedLifecycleFailure: { cause: unknown } | undefined;
      try {
        const currentSettings = await loadAgentSettings(storageDirectory);
        const deletedProfile = currentSettings.profiles.find(
          (profile) => profile.id === commandInput.profileId,
        );
        const oauthLifecycleRequired =
          deletedProfile?.connection.kind === "oauth-subscription" ||
          profileFence.hasPendingLogin() ||
          oauthSubscriptionProviders.some(
          (provider) => profileFence.hasAuthActivity(provider),
          ) ||
          modelState.hasUsedOAuth(commandInput.profileId);
        try {
          await runProfileSettingsMutation(async () => {
            if (oauthLifecycleRequired) {
              await waitForPromiseWithSignal(
                prepareOAuthCredentialStoreForSavedProfiles(storageDirectory),
                signal,
              );
            }
            return (dependencies.deleteSavedProfile ?? deleteSavedProfile)(
              storageDirectory,
              commandInput.profileId,
            );
          });
        } catch (error) {
          if (
            oauthLifecycleRequired &&
            isStorageCommitOutcomeUnknownError(error)
          ) {
            await reconcileUnknownProfileOAuthLifecycle(
              commandInput.profileId,
              signal,
            );
          }
          throw error;
        }
        if (oauthLifecycleRequired) {
          try {
            await reconcileSavedProfileOAuthLifecycle(
              commandInput.profileId,
              undefined,
            );
          } catch (cause) {
            modelState.markPendingCleanup(commandInput.profileId);
            committedLifecycleFailure = { cause };
          }
        }
      } finally {
        releaseProfileMutation?.();
      }
      modelState.clearCatalogs();
      status = "Profile deleted.";
      openSettingsOnLoad = true;
      if (committedLifecycleFailure) {
        return resolveCommittedProfileLifecycleFailure(
          commandInput.profileId,
          "The Profile was deleted, but OAuth account cleanup could not be confirmed. Restart Live Smith before using subscription sign-in again.",
          committedLifecycleFailure.cause,
          undefined,
          signal,
        );
      }
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "activate_profile") {
      throwIfAborted(signal);
      await runProfileSettingsMutation(() =>
        activateSavedProfile(
          storageDirectory,
          commandInput.profileId,
        )
      );
      modelState.clearCatalogs();
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "load_suno_models") {
      try {
        return await globalSettingsMutationFence.run(sessionMutationFenceKey(storageDirectory, "global-settings"), signal, async () => {
          await commandContext.progress("Loading Suno models…");
          await sunoModelCatalog.load(commandInput.serviceId, signal);
          status = "Suno models loaded.";
          return buildStateAfterCommandMutation(undefined, { signal });
        });
      } catch (error) {
        sunoModelCatalog.clear();
        if (!signal.aborted) throw error;
        throw new ChatBridgeCommandStoppedError(await buildStateAfterCommandMutation());
      }
    }

    if (commandInput.kind === "open_suno_website") {
      await (dependencies.openSunoWebsite ?? openSunoWebsite)(signal);
      status = undefined;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "open_suno_platform") {
      await (dependencies.openSunoPlatform ?? openSunoPlatform)(signal);
      status = undefined;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "import_suno_session" || commandInput.kind === "refresh_suno_login" || commandInput.kind === "logout_suno") {
      return globalSettingsMutationFence.run(sessionMutationFenceKey(storageDirectory, "global-settings"), signal, async () => {
        sunoModelCatalog.clear(commandInput.serviceId);
        try {
          if (commandInput.kind === "import_suno_session") {
            await sunoSessions.importSession(commandInput.serviceId, commandInput.sessionValue, signal);
          } else if (commandInput.kind === "refresh_suno_login") {
            await sunoSessions.refresh(commandInput.serviceId, signal);
          } else {
            await sunoSessions.clear(commandInput.serviceId);
          }
          status = undefined;
          return await buildStateAfterCommandMutation();
        } finally { notifyGlobalStateChanged(commandInput.serviceId); }
      });
    }

    if (commandInput.kind === "save_global_settings") {
      return globalSettingsMutationFence.run(
        sessionMutationFenceKey(
          storageDirectory,
          "global-settings",
        ),
        signal,
        async () => {
          throwIfAborted(signal);
          try {
            const patch = "defaultFollowUpBehavior" in commandInput
                ? {
                    defaultFollowUpBehavior:
                      commandInput.defaultFollowUpBehavior,
                  }
                : "showContextUsage" in commandInput
                ? { showContextUsage: commandInput.showContextUsage }
                : "uiLanguage" in commandInput
                ? { uiLanguage: commandInput.uiLanguage }
                : "integrationConnections" in commandInput
                ? { integrationConnections: commandInput.integrationConnections }
                : "customInstructions" in commandInput
                ? { customInstructions: commandInput.customInstructions }
                : { networkProxy: commandInput.networkProxy };
            const persist = async () => {
              const saved = await (dependencies.saveGlobalSettings ?? saveGlobalSettings)(storageDirectory, patch);
              if ("integrationConnections" in commandInput) {
                const changedId = commandInput.integrationConnections.action === "remove"
                  ? commandInput.integrationConnections.connectionId
                  : commandInput.integrationConnections.connection.id;
                await closeActiveMcpConnection(storageDirectory, changedId);
              }
              return saved;
            };
            const settings = "integrationConnections" in commandInput
              ? await requestConfigurationFence.run(requestConfigurationFenceKey, signal, persist)
              : await persist();
            publishGlobalSettingsChange(storageDirectory, {
              ...(settings.integrationConnections ? { integrationConnections: integrationConnectionsView(settings.integrationConnections) } : {}),
              defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
              defaultFollowUpBehaviorRevision:
                settings.defaultFollowUpBehaviorRevision,
              showContextUsage: settings.showContextUsage,
              contextUsageVisibilityRevision:
                settings.contextUsageVisibilityRevision,
              customInstructions: settings.customInstructions,
              customInstructionsRevision: settings.customInstructionsRevision,
              networkProxy: settings.networkProxy,
              networkProxyRevision: settings.networkProxyRevision,
              uiLanguage: settings.uiLanguage,
              uiLanguageRevision: settings.uiLanguageRevision,
              commandId: commandContext.commandId,
            });
            status = "Global settings saved.";
            if ("integrationConnections" in commandInput) notifyGlobalStateChanged();
            return buildStateAfterCommandMutation();
          } catch (cause) {
            if (!isStorageCommitOutcomeUnknownError(cause)) throw cause;

            if ("integrationConnections" in commandInput) notifyGlobalStateChanged();
            try {
              const settings = await loadAgentSettings(
                storageDirectory,
              );
              publishGlobalSettingsChange(storageDirectory, {
                ...(settings.integrationConnections ? { integrationConnections: integrationConnectionsView(settings.integrationConnections) } : {}),
                defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
                defaultFollowUpBehaviorRevision:
                  settings.defaultFollowUpBehaviorRevision,
                showContextUsage: settings.showContextUsage,
                contextUsageVisibilityRevision:
                  settings.contextUsageVisibilityRevision,
                customInstructions: settings.customInstructions,
                customInstructionsRevision: settings.customInstructionsRevision,
                networkProxy: settings.networkProxy,
                networkProxyRevision: settings.networkProxyRevision,
                uiLanguage: settings.uiLanguage,
                uiLanguageRevision: settings.uiLanguageRevision,
                commandId: commandContext.commandId,
              });
            } catch {
              // Preserve the unknown commit outcome when settings cannot be read.
            }
            let authoritativeState: ChatDialogState | undefined;
            try {
              authoritativeState = await buildState();
            } catch {
              // The bridge will require explicit reconciliation when unavailable.
            }
            throw new ChatBridgeCommandOutcomeUnknownError(
              "Global settings storage could not be confirmed.",
              { cause, authoritativeState },
            );
          }
        },
      );
    }

    if (
      commandInput.kind === "set_session_approval_mode" ||
      commandInput.kind === "set_session_edit_scopes"
    ) {
      const sessionCommand = commandInput;
      await withSessionIntent(sessionCommand.sessionId, signal, async () => {
        if (sessionCommand.kind === "set_session_approval_mode") {
          await dependencies.beforeSessionApprovalCommit?.();
        } else {
          await dependencies.beforeSessionEditScopesCommit?.();
        }
        await requestConfigurationFence.run(
          requestConfigurationFenceKey,
          signal,
          async () => {
            try {
              await withStorageTransaction(
                storageDirectory,
                async (transaction) => {
                  throwIfAborted(signal);
                  const session = (await listSessionsInTransaction(
                    transaction,
                    storageDirectory,
                    projectKey,
                  )).find(
                    (candidate) =>
                      candidate.id === sessionCommand.sessionId &&
                      !candidate.archivedAt,
                  );
                  if (!session) {
                    throw new ChatBridgeResourceNotFoundError(
                      "That Session is not available in this Live Set.",
                    );
                  }
                  const updatedSession = await (
                    dependencies.updateSessionInTransaction ??
                      updateSessionInTransaction
                  )(
                    transaction,
                    storageDirectory,
                    session.id,
                    sessionCommand.kind === "set_session_approval_mode"
                      ? { approvalMode: sessionCommand.approvalMode }
                      : { editScopes: sessionCommand.editScopes },
                  );
                  if (sessionCommand.kind === "set_session_approval_mode") {
                    publishSessionApprovalModeChange(storageDirectory, {
                      sessionId: sessionCommand.sessionId,
                      approvalMode: sessionCommand.approvalMode,
                      updatedAt: updatedSession.updatedAt,
                    });
                  } else {
                    publishSessionEditScopesChange(storageDirectory, {
                      sessionId: sessionCommand.sessionId,
                      editScopes: resolveEditScopes(updatedSession.editScopes),
                      updatedAt: updatedSession.updatedAt,
                    });
                  }
                },
              );
            } catch (error) {
              if (isStorageCommitOutcomeUnknownError(error)) {
                notifySessionStateChanged(sessionCommand.sessionId);
              }
              if (
                sessionCommand.kind === "set_session_edit_scopes" &&
                isStorageCommitOutcomeUnknownError(error)
              ) {
                invalidateSessionEditScopes(
                  storageDirectory,
                  sessionCommand.sessionId,
                );
                // Hold both fences through readback so a later permission
                // command cannot be attributed to this uncertain write.
                try {
                  const current = (
                    await listSessions(storageDirectory, projectKey)
                  ).find(
                    (candidate) =>
                      candidate.id === sessionCommand.sessionId &&
                      !candidate.archivedAt,
                  );
                  if (!current) {
                    throw new Error("Session permissions are unavailable.");
                  }
                  publishSessionEditScopesChange(storageDirectory, {
                    sessionId: current.id,
                    editScopes: resolveEditScopes(current.editScopes),
                    updatedAt: current.updatedAt,
                  });
                } catch {
                  // Keep active requests unauthorized until a later successful read.
                }
              }
              throw error;
            }
            notifySessionStateChanged(sessionCommand.sessionId);
          },
        );
      });
      status = undefined;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "import_midi_artifact") {
      if (commandInput.sessionId !== activeSessionId || sessionMutationFence.hasQueuedOrActive(
        sessionMutationFenceKey(storageDirectory, commandInput.sessionId), "send",
      )) throw new ChatBridgeConflictError("Choose an idle active Session before importing MIDI.");
      return withNamedSessionMutation(commandInput.sessionId, "send", signal, async () => {
        if (commandInput.sessionId !== activeSessionId) throw new ChatBridgeConflictError("The active Session changed before MIDI import.");
        const session = (await listSessions(storageDirectory, projectKey)).find((entry) =>
          entry.id === commandInput.sessionId && !entry.archivedAt);
        if (!session) throw new ChatBridgeResourceNotFoundError("That Session is not available in this Live Set.");
        const sessionInteraction = resolveSessionInteraction(session);
        if (!sessionInteraction) throw new ChatBridgeResourceNotFoundError("The Live object for this Session is no longer available.");
        try {
          await commandContext.progress(uiMessage("Preparing MIDI import…"));
          const applied = await importMidiArtifact({
            ...commandInput, context, storageDirectory, projectKey, interaction: sessionInteraction,
            signal, mutationQueue: liveMutationQueue,
            confirm: (plan, guard) => decidePlanApproval(storageDirectory, session.id, plan, async () => {
              if (!commandContext.requestConfirmation) throw new Error("MIDI import confirmation is unavailable.");
              return commandContext.requestConfirmation({ kind: "apply", message: plan.message,
                groups: actionDiffGroups(plan.actions, plan.targets),
                ...(guard.previews === undefined ? {} : { previews: guard.previews }),
              });
            }),
          });
          status = uiMessage(applied ? "MIDI imported into Live." : "MIDI import cancelled.");
        } finally {
          notifySessionStateChanged(session.id);
        }
        return buildStateAfterCommandMutation(undefined, { heldSessionId: session.id, sessionMutationHeld: true });
      });
    }

    if (commandInput.kind === "run_audio_tool") {
      if (commandInput.sessionId !== activeSessionId || sessionMutationFence.hasQueuedOrActive(
        sessionMutationFenceKey(storageDirectory, commandInput.sessionId), "send",
      )) throw new ChatBridgeConflictError("Choose an idle active Session before running an audio tool.");
      return withNamedSessionMutation(commandInput.sessionId, "send", signal, async () => {
        if (commandInput.sessionId !== activeSessionId) throw new ChatBridgeConflictError("The active Session changed before audio execution.");
        const session = (await listSessions(storageDirectory, projectKey)).find((entry) =>
          entry.id === commandInput.sessionId && !entry.archivedAt);
        if (!session) throw new ChatBridgeResourceNotFoundError("That Session is not available in this Live Set.");
        const sessionInteraction = resolveSessionInteraction(session);
        if (!sessionInteraction) throw new ChatBridgeResourceNotFoundError("The Live object for this Session is no longer available.");
        let observations = manualAudioObservations.get(session.id);
        if (!observations) { observations = new Map(); manualAudioObservations.set(session.id, observations); }
        try {
          await commandContext.progress(uiMessage("Running audio tool…"));
          const result = await runAudioParameterTool({
            ...commandInput, context, storageDirectory, signal, target: sessionInteraction.target,
            observedMusicClips: observations,
            onProgress: (message) => commandContext.progress(message),
            onAssets: () => { notifySessionStateChanged(session.id); },
            withAdmissionAuthorization: (authorizationSignal, operation) => globalSettingsMutationFence.run(
              sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal,
              () => requestConfigurationFence.run(requestConfigurationFenceKey, authorizationSignal, operation),
            ),
            withGenerationAuthorization: (authorizationSignal, operation) => globalSettingsMutationFence.run(
              sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal, operation,
            ),
          });
          status = uiMessage(result.failed ? "The audio tool reported a failure. Review its result and saved audio jobs before retrying." : "Audio tool completed.");
        } finally {
          loadedSessionToolCatalog = undefined;
          notifySessionStateChanged(session.id);
        }
        return buildStateAfterCommandMutation(undefined, { heldSessionId: session.id, sessionMutationHeld: true });
      });
    }

    if (commandInput.kind === "run_plugin_tool") {
      if (commandInput.sessionId !== activeSessionId || sessionMutationFence.hasQueuedOrActive(
        sessionMutationFenceKey(storageDirectory, commandInput.sessionId), "send",
      )) throw new ChatBridgeConflictError("Choose an idle active Session before running a Plugin tool.");
      return withNamedSessionMutation(commandInput.sessionId, "send", signal, async () => {
        const session = (await listSessions(storageDirectory, projectKey)).find((entry) =>
          entry.id === commandInput.sessionId && !entry.archivedAt);
        if (!session) throw new ChatBridgeResourceNotFoundError("That Session is not available in this Live Set.");
        try {
          await commandContext.progress(uiMessage("Running Plugin tool…"));
          const result = await runPluginParameterTool({
            ...commandInput, storageDirectory, signal, fetchImpl: providerFetch,
            withPluginAuthorization: (authorizationSignal, operation) => requestConfigurationFence.run(
              requestConfigurationFenceKey, authorizationSignal, operation,
            ),
          });
          status = uiMessage(result.failed ? "The Plugin tool reported a failure. Review its result before retrying." : "Plugin tool completed.");
        } finally {
          loadedSessionToolCatalog = undefined;
          notifySessionStateChanged(session.id);
        }
        return buildStateAfterCommandMutation(undefined, {
          heldSessionId: session.id, sessionMutationHeld: true,
        });
      });
    }

    if (commandInput.kind === "load_session_tools") {
      if (sessionMutationFence.hasQueuedOrActive(
        sessionMutationFenceKey(storageDirectory, commandInput.sessionId),
        "send",
      )) {
        throw new ChatBridgeConflictError(
          "Wait for this Session's active request to finish before loading tools.",
        );
      }
      loadedSessionToolCatalog = undefined;
      const before = await buildState(undefined, { signal });
      if (before.activeSessionId !== commandInput.sessionId) {
        throw new ChatBridgeConflictError("Choose the active Session before loading tools.");
      }
      const owner = sessionToolCatalogOwner(before);
      await commandContext.progress(uiMessage("Loading tool descriptions…"));
      const catalog = await loadSessionToolCatalog({
        storageDirectory,
        sessionId: commandInput.sessionId,
        state: before,
        signal,
        fetchImpl: providerFetch,
        withPluginAuthorization: (authorizationSignal, discover) => requestConfigurationFence.run(
          requestConfigurationFenceKey,
          authorizationSignal,
          discover,
        ),
      });
      const after = await buildState(undefined, { signal });
      if (sessionToolCatalogOwner(after) !== owner) {
        throw new ChatBridgeConflictError("Session tools changed while loading. Load them again.");
      }
      loadedSessionToolCatalog = { owner, value: catalog };
      return { ...after, sessionToolCatalog: catalog };
    }

    if (commandInput.kind === "load_session_model_capabilities") {
      if (
        sessionMutationFence.hasQueuedOrActive(
          sessionMutationFenceKey(storageDirectory, commandInput.sessionId),
          "send",
        )
      ) {
        throw new ChatBridgeConflictError(
          "Wait for this Session's active request to finish before loading model capabilities.",
        );
      }
      const session = (await listSessions(storageDirectory, projectKey)).find(
        (candidate) =>
          candidate.id === commandInput.sessionId && !candidate.archivedAt,
      );
      if (!session) {
        throw new ChatBridgeResourceNotFoundError(
          "That Session is not available in this Live Set.",
        );
      }
      const settings = await loadAgentSettings(storageDirectory);
      const profile = requireActiveSavedProfile(settings);
      if (profile.id !== commandInput.profileId) {
        throw new ChatBridgeConflictError(
          "The active Profile changed. Open the model selector again.",
        );
      }
      if (profile.connection.kind === "direct-api") {
        status = undefined;
        return buildStateAfterCommandMutation(undefined, { signal });
      }

      return modelState.withSubscriptionCapabilities(profile, signal, () => {
        status = undefined;
        openSettingsOnLoad = false;
        return buildStateAfterCommandMutation(undefined, { signal });
      });
    }
    if (commandInput.kind === "set_session_creative_brief") {
      if (sessionMutationFence.hasQueuedOrActive(
        sessionMutationFenceKey(storageDirectory, commandInput.sessionId), "send",
      )) {
        throw new ChatBridgeConflictError("Wait for this Session's active request to finish before saving its creative brief.");
      }
      await withSessionMutation(commandInput.sessionId, signal, async () => {
        try {
          await withStorageTransaction(storageDirectory, async (transaction) => {
            throwIfAborted(signal);
            const session = (await listSessionsInTransaction(transaction, storageDirectory, projectKey))
              .find((entry) => entry.id === commandInput.sessionId && !entry.archivedAt);
            if (!session) throw new ChatBridgeResourceNotFoundError("That Session is not available in this Live Set.");
            if ((session.creativeBrief ?? "") !== commandInput.expectedCreativeBrief) {
              throw new ChatBridgeConflictError("The creative brief changed in another window. Review the saved brief before saving your draft.");
            }
            throwIfAborted(signal);
            await (dependencies.updateSessionInTransaction ?? updateSessionInTransaction)(
              transaction, storageDirectory, session.id, { creativeBrief: commandInput.creativeBrief },
            );
          });
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) notifySessionStateChanged(commandInput.sessionId);
          throw error;
        }
        notifySessionStateChanged(commandInput.sessionId);
      });
      status = undefined;
      return buildStateAfterCommandMutation();
    }
    if (commandInput.kind === "set_session_model_selection") {
      if (
        sessionMutationFence.hasQueuedOrActive(
          sessionMutationFenceKey(storageDirectory, commandInput.sessionId),
          "send",
        )
      ) {
        throw new ChatBridgeConflictError(
          "Wait for this Session's active request to finish before changing its model.",
        );
      }
      return withSessionMutation(commandInput.sessionId, signal, async () => {
        let releaseOAuthSelection: (() => void) | undefined;
        try {
          throwIfAborted(signal);
          const initialSettings = await loadAgentSettings(storageDirectory);
          const initialProfile = requireActiveSavedProfile(initialSettings);
          if (initialProfile.id !== commandInput.profileId) {
            throw new ChatBridgeConflictError(
              "The active Profile changed. Choose the model again.",
            );
          }
          let oauthGeneration: number | undefined;
          const initialOAuthScope =
            initialProfile.connection.kind === "oauth-subscription"
              ? oauthProfileScope(initialProfile)
              : undefined;
          if (initialOAuthScope) {
            releaseOAuthSelection = await modelAuthSendFenceFor(
              initialOAuthScope.profileId,
            ).enterOAuthUse(
              signal,
            ) ?? undefined;
            if (!releaseOAuthSelection) {
              throw new ChatBridgeConflictError(
                `Wait for the ${oauthProviderLabel(initialOAuthScope.provider)} sign-in operation to finish before changing this Session's model.`,
              );
            }
            oauthGeneration = await synchronizeAuthGeneration(
              initialOAuthScope,
              signal,
            );
          }

          const { models } = await modelProjectionForProfile(initialProfile, signal);
          if (
            initialProfile.connection.kind === "oauth-subscription" &&
            !models.some((model) => model.id === commandInput.model)
          ) {
            throw new ChatBridgeConflictError(
              models.length === 0
                ? `Load the current ${oauthProviderLabel(initialProfile.connection.provider)} model catalog before changing this Session's model.`
                : `That model is not available for the signed-in ${oauthProviderLabel(initialProfile.connection.provider)} account.`,
            );
          }
          const savedSelection = {
            profileId: initialProfile.id,
            model: commandInput.model,
            ...(commandInput.reasoningEffort === null
              ? {}
              : { reasoningEffort: commandInput.reasoningEffort }),
          };

          if (dependencies.beforeSessionModelSelectionCommit) {
            await dependencies.beforeSessionModelSelectionCommit();
          }

          await requestConfigurationFence.run(
            requestConfigurationFenceKey,
            signal,
            () => withStorageTransaction(
              storageDirectory,
              async (transaction) => {
                throwIfAborted(signal);
                if (
                  oauthGeneration !== undefined &&
                  modelAuthSendFenceFor(initialOAuthScope!.profileId)
                      .authGeneration(initialOAuthScope!.provider) !==
                    oauthGeneration
                ) {
                  throw new ChatBridgeConflictError(
                    `${oauthProviderLabel(initialOAuthScope!.provider)} sign-in changed. Choose the model again.`,
                  );
                }
                const settings = await loadAgentSettings(storageDirectory);
                const profile = requireActiveSavedProfile(settings);
                if (
                  profile.id !== initialProfile.id ||
                  connectionFingerprint(profile) !==
                    connectionFingerprint(initialProfile) ||
                  !profile.models.some(
                    (model) => model.model === commandInput.model,
                  )
                ) {
                  throw new ChatBridgeConflictError(
                    "The active Profile changed. Choose the model again.",
                  );
                }
                const runtimeProfile = runtimeProfileForSavedProfile(
                  profile,
                  models,
                  {
                    model: commandInput.model,
                    reasoningEffort: commandInput.reasoningEffort,
                  },
                );
                if (
                  commandInput.reasoningEffort !== null &&
                  !runtimeProfile.capabilities.reasoning.efforts.includes(
                    commandInput.reasoningEffort,
                  )
                ) {
                  throw new ChatBridgeConflictError(
                    `Reasoning effort ${commandInput.reasoningEffort} is not supported by this model.`,
                  );
                }
                validateGenerationParameters(
                  runtimeProfile,
                  runtimeProfile.capabilities,
                );
                const session = (await listSessionsInTransaction(
                  transaction,
                  storageDirectory,
                  projectKey,
                )).find(
                  (candidate) =>
                    candidate.id === commandInput.sessionId &&
                    !candidate.archivedAt,
                );
                if (!session) {
                  throw new ChatBridgeResourceNotFoundError(
                    "That Session is not available in this Live Set.",
                  );
                }
                const updated = await updateSessionInTransaction(
                  transaction,
                  storageDirectory,
                  session.id,
                  { modelSelection: savedSelection },
                );
                publishSessionModelSelectionChange(storageDirectory, {
                  sessionId: commandInput.sessionId,
                  modelSelection: savedSelection,
                  updatedAt: updated.updatedAt,
                });
                notifySessionStateChanged(commandInput.sessionId);
                return updated;
              },
            ),
          );
          status = undefined;
          openSettingsOnLoad = false;
          return buildStateAfterCommandMutation(undefined, {
            heldSessionId: commandInput.sessionId,
            sessionMutationHeld: true,
          });
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            notifySessionStateChanged(commandInput.sessionId);
          }
          throw error;
        } finally {
          releaseOAuthSelection?.();
        }
      });
    }

    if (commandInput.kind === "compact_session") {
      if (
        sessionMutationFence.hasQueuedOrActive(
          sessionMutationFenceKey(storageDirectory, commandInput.sessionId),
          "send",
        )
      ) {
        throw new ChatBridgeConflictError(
          "Wait for this Session's active request to finish before compacting.",
        );
      }
      return withNamedSessionMutation(
        commandInput.sessionId,
        "compact",
        signal,
        async () => {
          const snapshot = await requestConfigurationFence.run(
            requestConfigurationFenceKey,
            signal,
            () => withStorageTransaction(
              storageDirectory,
              async (transaction) => {
                const session = (await listSessionsInTransaction(
                  transaction,
                  storageDirectory,
                  projectKey,
                )).find((entry) =>
                  entry.id === commandInput.sessionId && !entry.archivedAt
                );
                const settings = await loadAgentSettings(storageDirectory);
                const skillContext = session === undefined
                  ? undefined
                  : await resolveSkillContextInTransaction(transaction, {
                      storageDirectory,
                      sessionSkillIds: session.activeSkillIds ?? [],
                      prompt: "",
                    });
                return { session, settings, skillContext };
              },
            ),
          );
          const session = snapshot.session;
          if (!session) {
            throw new ChatBridgeResourceNotFoundError(
              "That Session is not available in this Live Set.",
            );
          }
          const sessionInteraction = resolveSessionInteraction(session);
          if (!sessionInteraction) {
            throw new ChatBridgeResourceNotFoundError(
              `The Live object for this Session is no longer available: ${session.scope.label}.`,
            );
          }
          const events = await (
            dependencies.loadSessionEvents ?? loadSessionEvents
          )(storageDirectory, session.id);
          const latestCompactionIndex = events.findLastIndex(
            (event) => event.kind === "compaction",
          );
          if (!events.slice(latestCompactionIndex + 1).some((event) =>
            event.kind === "user" ||
            event.kind === "assistant" ||
            event.kind === "tool_call" ||
            event.kind === "tool_result" ||
            event.kind === "apply_result"
          )) {
            throw new ChatBridgeConflictError(
              "This Session has no new conversation context to compact.",
            );
          }
          const modelRequest = await acquireSessionModelRequester(
            session,
            snapshot.settings,
            signal,
            "compacting",
          );
          try {
            const { runtimeProfile, requestTurn } = modelRequest;
            const history = await resolveConversationHistory({
              storageDirectory,
              sessionId: session.id,
              events,
              currentAttachmentRefs: [],
              currentDocumentTextCharacters: 0,
              runtimeProfile,
              signal,
            });
            const recoveryContext = recoveryContextFromEvents(events);
            const liveContext = recoveryContext
              ? `${sessionInteraction.summary}\n\n${recoveryContext}`
              : sessionInteraction.summary;
            const checkpoint = await createConversationCheckpoint({
              prompt: "Compact this Session for its next user request.",
              liveContext,
              runtimeProfile,
              history,
              attachmentParts: [],
              ...(snapshot.skillContext === undefined
                ? {}
                : { skillContext: snapshot.skillContext }),
              editScopes: resolveEditScopes(session.editScopes),
              creativeBrief: session.creativeBrief ?? "",
              agentMessages: [],
              ...(commandInput.instructions === undefined
                ? {}
                : { instructions: commandInput.instructions }),
              signal,
              requestTurn: async (input) => (
                await requestModelWithReconnect({
                  signal,
                  resetTransient: () => {},
                  onProgress: commandContext.progress,
                  request: ({ reconnectState }) => requestTurn({
                    ...input,
                    reconnectState,
                  }),
                })
              ).value,
            });
            throwIfAborted(signal);
            await (
              dependencies.appendSessionEvent ?? appendSessionEvent
            )(storageDirectory, session.id, {
              kind: "compaction",
              content: checkpoint,
            });
          } catch (error) {
            if (!isStorageCommitOutcomeUnknownError(error)) throw error;
            notifySessionStateChanged(session.id);
            let authoritativeState: ChatDialogState | undefined;
            try {
              authoritativeState = await buildStateAfterCommandMutation(undefined, {
                heldSessionId: session.id,
                sessionMutationHeld: true,
              });
            } catch {
              // The command remains unknown when its durable event cannot be read.
            }
            throw new ChatBridgeCommandOutcomeUnknownError(
              "The Session may have been compacted, but the saved checkpoint could not be confirmed.",
              { cause: error, authoritativeState },
            );
          } finally {
            modelRequest.release();
          }
          notifySessionStateChanged(session.id);
          status = "Session context compacted.";
          openSettingsOnLoad = false;
          try {
            return await buildStateAfterCommandMutation(undefined, {
              heldSessionId: session.id,
              sessionMutationHeld: true,
            });
          } catch (cause) {
            throw new ChatBridgeCommandOutcomeUnknownError(
              "The Session was compacted, but its current state could not be confirmed.",
              { cause },
            );
          }
        },
      );
    }

    if (commandInput.kind === "new_session") {
      const sessions = await listSessions(
        storageDirectory,
        projectKey,
      );
      const activeSession = sessions.find((session) => session.id === activeSessionId);
      const activeInteraction = activeSession
        ? resolveSessionInteraction(activeSession)
        : interaction;
      const targetScope = activeInteraction?.scope ?? interaction.scope;
      const { session, reused } = await withSessionCreationScope(
        storageDirectory,
        projectKey,
        targetScope,
        signal,
        async () => {
          const reusable = await findReusableEmptySession(targetScope, signal);
          if (reusable) return { session: reusable, reused: true };
          throwIfAborted(signal);
          return {
            session: await createSession(storageDirectory, {
              title: "",
              projectKey,
              scope: targetScope,
              approvalMode: "manual",
              editScopes: [...EDIT_SCOPES],
            }, { transient: true }),
            reused: false,
          };
        },
      );
      if (activeInteraction?.selectionContext) {
        selectionInteractionsBySessionId.set(session.id, activeInteraction);
        bindInvocationSelectionToNextSession = false;
      }
      claimSession(storageDirectory, session.id, modalSessionOwner);
      if (!reused) notifySessionStateChanged(session.id);
      activeSessionId = session.id;
      status = reused ? "Empty session ready." : "New session created.";
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "select_session") {
      const selectedState = await withSessionMutation(
        commandInput.sessionId,
        signal,
        async () => {
          if (!(await sessionBelongsToProject(commandInput.sessionId))) return undefined;
          throwIfAborted(signal);
          claimSession(storageDirectory, commandInput.sessionId, modalSessionOwner);
          activeSessionId = commandInput.sessionId;
          status = undefined;
          openSettingsOnLoad = false;
          const state = await buildStateWhileHoldingSessionMutation(
            commandInput.sessionId,
          );
          return state;
        },
      );
      if (!selectedState) {
        status = "That session is not available in this Live Set.";
        return buildState();
      }
      return selectedState;
    }

    if (commandInput.kind === "restore_session") {
      const continueInteraction = resolveContinueInteraction();
      if (!continueInteraction) {
        status = "The current Live object or selection is no longer available.";
        return buildState();
      }
      const restored = await withSessionMutation(commandInput.sessionId, signal, async () => {
        const candidate = continuableSessionsForScope(
          await listSessions(storageDirectory),
          projectKey,
          continueInteraction.scope,
        ).find((session) => session.id === commandInput.sessionId);
        if (!candidate) return null;
        throwIfAborted(signal);
        return runSessionStateChange(
          candidate.id,
          () => restoreSession(
            storageDirectory,
            candidate.id,
            { projectKey, scope: continueInteraction.scope },
          ),
        );
      });
      if (!restored) {
        status = "That historical Session cannot continue on the current Live object.";
        return buildState();
      }
      claimSession(storageDirectory, restored.id, modalSessionOwner);
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

    if (commandInput.kind === "open_attachment") {
      const file = await readAttachment(commandInput.sessionId, commandInput.attachmentId, signal);
      await (dependencies.openAttachment ?? attachmentOpener.open)(file, signal);
      status = uiMessage("The attachment was opened in its default application.");
      return buildStateAfterCommandMutation(undefined, { signal });
    }

    if (commandInput.kind === "open_audio_download") {
      await attachmentSession(commandInput.sessionId);
      if (!bridge) throw new Error("The audio download bridge is unavailable.");
      const target = await bridge.createAudioDownload(commandInput.sessionId, commandInput.assetId, signal);
      await (dependencies.openAudioDownload ?? openAudioDownload)(target, signal);
      status = m("The local audio file was sent to your default browser for export. Keep Live Smith open until it finishes.");
      return buildStateAfterCommandMutation(undefined, { signal });
    }

    if (commandInput.kind === "resume_audio_job" || commandInput.kind === "download_audio_output") {
      return withNamedSessionMutation(commandInput.sessionId, "audio-job", signal, async () => {
        try {
          await attachmentSession(commandInput.sessionId);
          const processing = {
            storageDirectory, sessionId: commandInput.sessionId, signal,
            onProgress: (message: UiMessage) => commandContext.progress(message),
          };
          let job;
          if (commandInput.kind === "download_audio_output") {
            job = await (dependencies.downloadAudioOutput ?? downloadAudioOutput)({ ...processing,
              withDownloadAuthorization: (authorizationSignal, authorize) => globalSettingsMutationFence.run(
                sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal, authorize,
              ),
            },
              commandInput.jobId, commandInput.outputKey);
          } else {
            job = await resumeAudioJob({ ...processing,
              withGenerationAuthorization: (authorizationSignal, operation) => globalSettingsMutationFence.run(
                sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal, operation,
              ),
            }, commandInput.jobId);
          }
          status = job.message;
        } catch (error) {
          if (!signal.aborted) throw error;
          const state = await buildStateAfterCommandMutation(undefined, {
            heldSessionId: commandInput.sessionId, sessionMutationHeld: true,
          });
          throw new ChatBridgeCommandStoppedError(state);
        } finally {
          notifySessionStateChanged(commandInput.sessionId);
        }
        return buildStateAfterCommandMutation(undefined, {
          heldSessionId: commandInput.sessionId, sessionMutationHeld: true,
        });
      });
    }

    if (commandInput.kind === "delete_session") {
      const existed = await sessionLifecycle.remove(commandInput.sessionId, signal, () => {
        selectionInteractionsBySessionId.delete(commandInput.sessionId);
        if (activeSessionId === commandInput.sessionId) activeSessionId = undefined;
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
        await runSessionStateChange(
          commandInput.sessionId,
          () => updateSession(
            storageDirectory,
            commandInput.sessionId,
            { title: commandInput.title },
          ),
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
        await runSessionStateChange(
          commandInput.sessionId,
          () => setSessionArchived(
            storageDirectory,
            commandInput.sessionId,
            archived,
          ),
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

    if (commandInput.kind === "set_plugin_user_config") {
      await pluginLifecycle.saveConfiguration(commandInput, signal);
      status = uiMessage("Plugin parameters saved.");
      return buildStateAfterCommandMutation();
    }

    if (
      commandInput.kind === "set_plugin_enabled" ||
      commandInput.kind === "set_plugin_mcp_server_approved" ||
      commandInput.kind === "set_plugin_artifact_permission" ||
      commandInput.kind === "delete_plugin"
    ) {
      status = await pluginLifecycle.change(commandInput, signal);
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
    }

    if (commandInput.kind === "set_session_skills") {
      const mutationKey = sessionMutationFenceKey(
        storageDirectory,
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
            await requestConfigurationFence.run(
              requestConfigurationFenceKey,
              signal,
              () => runSessionStateChange(
                commandInput.sessionId,
                () => withStorageTransaction(
                  storageDirectory,
                  async (transaction) => {
                    throwIfAborted(signal);
                    const sessions = await listSessionsInTransaction(
                      transaction,
                      storageDirectory,
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
                      storageDirectory,
                    );
                    const pluginSkills = await pluginSkillsFromPackages(
                      await readEnabledPluginPackagesInTransaction(transaction, storageDirectory),
                    );
                    const availableIds = new Set(
                      availableSkillSummaries(installed, pluginSkills).map(
                        (skill) => skill.id,
                      ),
                    );
                    const unavailable = requestedSkillIds.find(
                      (skillId) => !availableIds.has(skillId),
                    );
                    if (unavailable !== undefined) {
                      throw new ChatBridgeSkillValidationError(
                        `Skill ${unavailable} is not available.`,
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
                      storageDirectory,
                      session.id,
                      { activeSkillIds: requestedSkillIds },
                    );
                  },
                ),
              ),
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
        const discovered = await modelState.discoverModels(profile, commandContext.commandId, signal);
        cacheMutationCompleted = true;
        status = discovered.length
          ? `Discovered ${discovered.length} model${discovered.length === 1 ? "" : "s"}.`
          : "No models returned by this provider.";
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof ChatBridgeConflictError) throw error;
        status = error instanceof Error ? error.message : String(error);
      }
      openSettingsOnLoad = true;
      return cacheMutationCompleted
        ? buildStateAfterCommandMutation(profile, { signal })
        : buildState(profile, { signal });
    }





    if (commandInput.kind === "start_oauth_login" || commandInput.kind === "submit_oauth_authorization_code" ||
      commandInput.kind === "open_oauth_authorization" || commandInput.kind === "logout_oauth") {
      const result = await modelState.runAccountCommand(commandInput, signal);
      status = result.status;
      openSettingsOnLoad = true;
      return withOAuthAuthProjection(
        await buildStateAfterCommandMutation(undefined, { signal }), result.scope, result.auth,
      );
    }

    if (commandInput.kind === "refresh_oauth_account") {
      const provider = commandInput.provider;
      const scope = { profileId: commandInput.profileId, provider };
      const pendingState = await withPendingOAuthAuthReconciliation(
        scope,
        signal,
        async (pendingAuth) => {
          status = oauthAuthStatusMessage(pendingAuth, provider);
          openSettingsOnLoad = true;
          return withOAuthAuthProjection(await confirmCommandState(() =>
            buildStateWithAuthReadHeld(undefined, {
              oauthAuthAlreadyResolved: true,
              signal,
            })
          ), scope, pendingAuth);
        },
      );
      if (pendingState) return pendingState;
      const resultAuth = await modelState.refreshAccount(scope, signal);
      status = oauthAuthStatusMessage(resultAuth, provider);
      openSettingsOnLoad = true;
      return withOAuthAuthProjection(
        await buildStateAfterCommandMutation(undefined, { signal }),
        scope,
        resultAuth,
      );
    }


    return assertNeverCommand(commandInput);
  };

  const sessionBelongsToProject = async (sessionId: string): Promise<boolean> =>
    (await listSessions(storageDirectory, projectKey)).some(
      (session) => session.id === sessionId && !session.archivedAt,
    );

  const sessionExists = async (sessionId: string): Promise<boolean> =>
    (await listSessions(storageDirectory)).some(
      (session) => session.id === sessionId,
    );

  const findReusableEmptySession = async (
    scope: LiveInteractionContext["scope"],
    signal: AbortSignal,
  ): Promise<AgentSession | undefined> => {
    const sessions = await listSessions(storageDirectory, projectKey);
    const candidates = [
      ...sessions.filter((session) => session.id === activeSessionId),
      ...sessions.filter((session) => session.id !== activeSessionId),
    ].filter((session) =>
      session.projectKey === projectKey &&
      session.archivedAt === undefined &&
      sessionScopeKey(session.scope) === sessionScopeKey(scope)
    );
    for (const candidate of candidates) {
      if (sessionIsClaimedByAnotherOwner(
        storageDirectory,
        candidate.id,
        modalSessionOwner,
      )) continue;
      const mutationKey = sessionMutationFenceKey(
        storageDirectory,
        candidate.id,
      );
      if (sessionMutationFence.hasQueuedOrActive(mutationKey, "send")) continue;
      const reusable = await withSessionMutation(
        candidate.id,
        signal,
        () => withSessionIntent(
          candidate.id,
          signal,
          async () => {
            const current = (await listSessions(
              storageDirectory,
              projectKey,
            )).find((session) => session.id === candidate.id);
            if (
              !current ||
              !isReusableEmptySessionMetadata(current, projectKey, scope)
            ) return undefined;
            const events = await (
              dependencies.loadSessionEvents ?? loadSessionEvents
            )(storageDirectory, current.id);
            if (events.length) return undefined;
            if (storageDirectory !== undefined && (await listAudioJobs(storageDirectory, current.id)).length) return undefined;
            const attachments = await listPendingSessionAttachments(
              storageDirectory,
              current.id,
              [],
            );
            if (
              attachments.length > 0 ||
              sessionMutationFence.queuedOrActiveCount(mutationKey) > 1 ||
              sessionIntentFence.queuedOrActiveCount(mutationKey) > 1
            ) return undefined;
            return current;
          },
        ),
      );
      if (reusable) {
        claimSession(storageDirectory, reusable.id, modalSessionOwner);
        return reusable;
      }
    }
    return undefined;
  };

  const readAttachment = async (sessionId: string, attachmentId: string, signal: AbortSignal) => {
    throwIfAborted(signal);
    const session = (await listSessions(storageDirectory, projectKey)).find((entry) => entry.id === sessionId);
    if (!session) throw new ChatBridgeResourceNotFoundError("Attachment Session is unavailable in this Live Set.");
    try {
      return await readSessionAttachment(storageDirectory, sessionId, attachmentId, { signal });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof AttachmentNotFoundError) {
        throw new ChatBridgeResourceNotFoundError("This attachment is no longer available.");
      }
      throw new ChatBridgeAttachmentValidationError("This attachment could not be read or verified.");
    }
  };

  const attachmentSession = async (sessionId: string) => {
    const session = (await listSessions(
      storageDirectory,
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
    await withAttachmentMutation(input.sessionId, signal, async () => {
      throwIfAborted(signal);
      await attachmentSession(input.sessionId);
      const events = await loadSessionEvents(
        storageDirectory,
        input.sessionId,
      );
      const pending = await listPendingSessionAttachments(
        storageDirectory,
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
        await runSessionStateChange(
          input.sessionId,
          () => saveSessionAttachment(
            storageDirectory,
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
          ),
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
    await withAttachmentMutation(input.sessionId, signal, async () => {
      throwIfAborted(signal);
      await attachmentSession(input.sessionId);
      const events = await loadSessionEvents(
        storageDirectory,
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
        storageDirectory,
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
        await runSessionStateChange(
          input.sessionId,
          () => deleteSessionAttachment(
            storageDirectory,
            input.sessionId,
            input.attachmentId,
          ),
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

  const buildStateAfterPluginMutation = async () => {
    try {
      return await buildState();
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "The Plugin catalog changed, but the resulting Live Smith state could not be confirmed.",
        { cause, authoritativeState: undefined },
      );
    }
  };

  const handlePluginInstall = async (
    input: ChatBridgePluginInstallInput,
    signal: AbortSignal,
  ): Promise<ChatBridgePluginInstallResult> => {
    const receipt = await pluginLifecycle.install(input, signal);
    status = `Plugin ${receipt.id} installed.`;
    openSettingsOnLoad = false;
    return { state: await buildStateAfterPluginMutation(), receipt };
  };

  const handleSkillInstall = async (
    input: ChatBridgeSkillInstallInput,
    signal: AbortSignal,
  ): Promise<ChatBridgeSkillInstallResult> => {
    const receipt = await userSkillLifecycle.install(input, signal);
    status = `Skill ${receipt.id} installed.`;
    openSettingsOnLoad = false;
    return { state: await buildStateAfterSkillMutation(), receipt };
  };

  const handleSkillDelete = async (
    input: ChatBridgeSkillDeleteInput,
    signal: AbortSignal,
  ) => {
    const deleted = await userSkillLifecycle.remove(input, signal);
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
    steering: SteeringChannel,
    sendContext: ChatBridgeSendContext,
  ) => {
    const prompt = sendInput.prompt;
    if (!prompt.trim()) {
      throw new Error("Prompt is empty.");
    }
    return withNamedSessionMutation(sendInput.sessionId, "send", signal, async () => {
      let sendFailureKind: ChatBridgeSendFailureKind | undefined;
      let releaseModelAuthFence: (() => void) | undefined;
      try {
        throwIfAborted(signal);
        const requestSnapshot = await requestConfigurationFence.run(
          requestConfigurationFenceKey,
          signal,
          async () => {
            const snapshot = await withStorageTransaction(
              storageDirectory,
              async (transaction) => {
                const session = (await listSessionsInTransaction(
                  transaction,
                  storageDirectory,
                  projectKey,
                )).find((entry) =>
                  entry.id === sendInput.sessionId && !entry.archivedAt
                );
                const settings = await loadAgentSettings(storageDirectory);
                const skillContext = session === undefined
                  ? undefined
                  : await resolveSkillContextInTransaction(transaction, {
                      storageDirectory,
                      sessionSkillIds: session.activeSkillIds ?? [],
                      prompt,
                    });
                return { session, settings, skillContext };
              },
            );
            sendContext.assertStateCoverageCurrent();
            return snapshot;
          },
        );
        const session = requestSnapshot.session;
        if (!session) {
          sendFailureKind = "session_unavailable";
          throw new Error("That Session is not available in this Live Set.");
        }
        const sessionInteraction = resolveSessionInteraction(session);
        if (!sessionInteraction) {
          sendFailureKind = "session_unavailable";
          throw new Error(
            `The Live object for this Session is no longer available: ${session.scope.label}.`,
          );
        }
        const modelRequest = await acquireSessionModelRequester(
          session,
          requestSnapshot.settings,
          signal,
          "sending",
        );
        releaseModelAuthFence = modelRequest.release;
        const { runtimeProfile, requestTurn } = modelRequest;
        let requestFailed = false;
        let requestError: unknown;
        try {
          await handleAgentRequest(
            context,
            storageDirectory,
            sessionInteraction,
            prompt,
            runtimeProfile,
            projectKey,
            session.id,
            {
              signal,
              ...(requestSnapshot.skillContext === undefined
                ? {}
                : { skillContextSnapshot: requestSnapshot.skillContext }),
              customInstructionsSnapshot:
                requestSnapshot.settings.customInstructions,
              steering,
              ...(sendContext.attachmentIds === undefined ? {} : { attachmentIds: sendContext.attachmentIds }),
              withAttachmentMutation: (operation) => withAttachmentMutation(session.id, signal, operation),
              steeringSendId: sendContext.sendId,
              onDelta: (delta) => stream.assistantDelta(delta),
              onReasoningUpdate: (update) => stream.reasoningUpdate(update),
              onModelRequestStarted: () => stream.modelRequestStarted(),
              onModelRequestRetry: () => stream.modelRequestRetry(),
              onAssistantReset: () => stream.assistantReset(),
              onModelTurnAccepted: (usage) => stream.modelTurnAccepted(usage),
              onProgress: (message) => stream.progress(message),
              withGenerationAuthorization: (authorizationSignal, dispatch) => globalSettingsMutationFence.run(
                sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal, dispatch,
              ),
              withPluginAuthorization: (authorizationSignal, dispatch) => requestConfigurationFence.run(
                requestConfigurationFenceKey,
                authorizationSignal,
                dispatch,
              ),
              onWebSearchUpdate: (update) => stream.webSearchUpdate(update),
              onSessionEvent: (event) => {
                notifySessionStateChanged(session.id);
                return stream.sessionEvent(event);
              },
              onSessionStateInvalidated: () => {
                notifySessionStateChanged(session.id);
              },
              withActionExecutionLock: (operation) =>
                liveMutationQueue.run(signal, operation),
              confirmActions: (plan, guard) => decidePlanApproval(
                storageDirectory,
                session.id,
                plan,
                () => stream.requestConfirmation({
                  kind: "apply",
                  message: plan.message,
                  groups: actionDiffGroups(plan.actions, plan.targets),
                  ...(guard.previews === undefined ? {} : { previews: guard.previews }),
                }),
              ),
              confirmRecoveryResolution: (message) =>
                stream.requestConfirmation({
                  kind: "resolve_recovery",
                  message,
                  groups: [],
                }),
            },
            requestTurn,
          );
        } catch (error) {
          requestFailed = true;
          requestError = error;
        }
        if (requestFailed) throw requestError;
        steering.close();
        return buildStateWhileHoldingSessionMutation(sendInput.sessionId);
      } catch (error) {
        steering.close(new SteeringClosedError(
          "The active send ended before steering was accepted.",
        ));
        if (error instanceof ChatBridgeSendFailureError) throw error;
        if (error instanceof ModelInputTooLargeError) sendFailureKind = "input_too_large";
        if (shouldOpenSettingsForAgentError(error)) openSettingsOnLoad = true;
        let authoritativeState: ChatDialogState | undefined;
        try {
          authoritativeState = sendFailureKind === "session_unavailable"
            ? await buildState(undefined, { sessionMutationHeld: true })
            : await buildStateWhileHoldingSessionMutation(sendInput.sessionId);
        } catch {
          // Preserve the original failure. The client will reconcile explicitly.
        }
        throw new ChatBridgeSendFailureError(
          error,
          authoritativeState,
          sendFailureKind,
        );
      } finally {
        releaseModelAuthFence?.();
      }
    });
  };

  const lookupSteeringReceipt = async (
    input: ChatBridgeSteeringReceiptLookupInput,
  ): Promise<ChatBridgeSteeringReceiptLookupResult> => {
    const session = (await listSessions(
      storageDirectory,
      projectKey,
    )).find((entry) =>
      entry.id === input.sessionId && entry.projectKey === projectKey
    );
    if (!session) return "absent";
    const events = await (
      dependencies.loadSessionEvents ?? loadSessionEvents
    )(storageDirectory, session.id);
    const event = events.find((candidate) =>
      candidate.steeringReceipt?.sendId === input.sendId &&
      candidate.steeringReceipt.id === input.steerId
    );
    if (!event) return "absent";
    const expected = steeringReceiptFor(
      input.sendId,
      input.steerId,
      input.prompt,
      input.attachmentIds,
    );
    return event.kind === "user" &&
        event.content === input.prompt &&
        event.steeringReceipt?.sha256 === expected.sha256
      ? "accepted"
      : "conflict";
  };

  const buildInvalidatedSessionState = (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ChatDialogState> => withSessionMutation(
    sessionId,
    signal,
    async () => {
      const available = (await listSessions(storageDirectory, projectKey)).some(
        (candidate) => candidate.id === sessionId && !candidate.archivedAt,
      );
      if (!available) {
        if (activeSessionId === sessionId) activeSessionId = undefined;
        return buildState(undefined, {
          sessionMutationHeld: true,
          ...(signal === undefined ? {} : { signal }),
        });
      }
      return buildState(undefined, {
        heldSessionId: sessionId,
        sessionMutationHeld: true,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  );

  const renderHtml = dependencies.renderHtml ??
    (await import("../ui/dialogs.js")).chatHtml;
  let unsubscribeApprovalModes: (() => void) | undefined;
  let unsubscribeEditScopes: (() => void) | undefined;
  let unsubscribeModelSelections: (() => void) | undefined;
  let unsubscribeGlobalSettings: (() => void) | undefined;
  let unsubscribeProfileSettings: (() => void) | undefined;
  let unsubscribeSessionState: (() => void) | undefined;
  let unsubscribeGlobalState: (() => void) | undefined;
  const pendingSessionStateInvalidations = new Set<string>();
  let pendingGlobalStateInvalidation = false;
  let pendingProfileSettingsChange: ProfileSettingsChange | undefined;
  try {
    unsubscribeSessionState = subscribeSessionStateInvalidations(
      storageDirectory,
      ({ sessionId, source }) => {
        if (source === modalSessionOwner) return;
        if (bridge) bridge.publishSessionStateInvalidation(sessionId);
        else pendingSessionStateInvalidations.add(sessionId);
      },
    );
    unsubscribeGlobalState = subscribeGlobalStateInvalidations(
      storageDirectory,
      ({ source, sunoAuthServiceId }) => {
        if (sunoAuthServiceId !== undefined) sunoModelCatalog.clear(sunoAuthServiceId);
        if (source === modalSessionOwner) return;
        if (bridge) bridge.publishGlobalStateInvalidation();
        else pendingGlobalStateInvalidation = true;
      },
    );
    unsubscribeProfileSettings = subscribeProfileSettingsChanges(
      storageDirectory,
      (change) => {
        if (bridge) bridge.publishProfileSettingsChange(change);
        else pendingProfileSettingsChange = change;
      },
    );
    await sessionLifecycle.reconcileStartupOrphans();
    const pluginApps = createPluginAppSessions({
      storageDirectory, fetchImpl: providerFetch,
      withAuthorization: (signal, operation) => requestConfigurationFence.run(requestConfigurationFenceKey, signal, operation),
      validateSession: async (sessionId, signal) => {
        throwIfAborted(signal);
        if (sessionId !== activeSessionId) throw new ChatBridgeConflictError("Choose the Plugin app's active Session first.");
        const session = (await listSessions(storageDirectory, projectKey)).find((entry) => entry.id === sessionId && !entry.archivedAt);
        if (!session) throw new ChatBridgeResourceNotFoundError("That Session is not available in this Live Set.");
      },
      mutateSession: (sessionId, signal, operation) => {
        if (sessionMutationFence.hasQueuedOrActive(sessionMutationFenceKey(storageDirectory, sessionId), "send")) {
          throw new ChatBridgeConflictError("Wait for this Session's current operation before using the Plugin app.");
        }
        return withNamedSessionMutation(sessionId, "send", signal, operation);
      },
      sessionChanged: (sessionId) => {
        loadedSessionToolCatalog = undefined;
        notifySessionStateChanged(sessionId);
        bridge?.publishSessionStateInvalidation(sessionId);
      },
    });
    bridge = await createChatBridge({
      readAttachment,
      handlePluginAppRequest: (input, signal) => pluginApps.request(input, signal),
      prepareMidiImport: async (input, signal) => {
        if (input.sessionId !== activeSessionId) throw new ChatBridgeConflictError("Choose the active Session before preparing MIDI import.");
        const result = await prepareMidiArtifactImport({ ...input, context, storageDirectory, projectKey, signal });
        if (input.sessionId !== activeSessionId) throw new ChatBridgeConflictError("The active Session changed while preparing MIDI import.");
        return result;
      },
      closePluginApps: () => pluginApps.close(),
      readAudioAsset: async (sessionId, assetId, signal) => {
        const session = (await listSessions(storageDirectory, projectKey)).find((entry) => entry.id === sessionId);
        if (!session) throw new ChatBridgeResourceNotFoundError("Audio Session is unavailable in this Live Set.");
        const jobs = await listAudioJobs(storageDirectory, sessionId);
        if (!jobs.some((job) => job.outputAssets.some((asset) => asset.id === assetId))) {
          throw new ChatBridgeResourceNotFoundError("Audio result is unavailable in this Session.");
        }
        const value = await readAudioAsset(storageDirectory, sessionId, assetId, signal);
        return { bytes: value.bytes, mediaType: value.asset.mediaType };
      },
      buildState: (signal) => buildState(
        undefined,
        signal === undefined ? {} : { signal },
      ),
      buildInvalidatedSessionState,
      renderHtml,
      handleCommand,
      handleSend,
      lookupSteeringReceipt,
      preflightAttachmentUpload,
      handleAttachmentUpload,
      handleAttachmentDelete,
      handleSkillInstall,
      handleSkillDelete,
      handlePluginInspect: inspectPluginPackage,
      handlePluginInstall,
      ...(dependencies.attachmentBodyReadOptions === undefined
        ? {}
        : { attachmentBodyReadOptions: dependencies.attachmentBodyReadOptions }),
      ...(dependencies.skillBodyReadOptions === undefined
        ? {}
        : { skillBodyReadOptions: dependencies.skillBodyReadOptions }),
      ...(dependencies.pluginBodyReadOptions === undefined
        ? {}
        : { pluginBodyReadOptions: dependencies.pluginBodyReadOptions }),
    });
    if (pendingGlobalStateInvalidation) {
      bridge.publishGlobalStateInvalidation();
    }
    for (const sessionId of pendingSessionStateInvalidations) {
      bridge.publishSessionStateInvalidation(sessionId);
    }
    if (pendingProfileSettingsChange) {
      bridge.publishProfileSettingsChange(pendingProfileSettingsChange);
    }
    unsubscribeApprovalModes = subscribeSessionApprovalModeChanges(
      storageDirectory,
      ({ sessionId, approvalMode, updatedAt }) => {
        bridge?.publishSessionApprovalMode(sessionId, approvalMode, updatedAt);
      },
    );
    unsubscribeEditScopes = subscribeSessionEditScopesChanges(
      storageDirectory,
      ({ sessionId, editScopes, updatedAt }) => {
        bridge?.publishSessionEditScopes(sessionId, editScopes, updatedAt);
      },
    );
    unsubscribeModelSelections = subscribeSessionModelSelectionChanges(
      storageDirectory,
      ({ sessionId, modelSelection, updatedAt }) => {
        bridge?.publishSessionModelSelection(sessionId, modelSelection, updatedAt);
      },
    );
    unsubscribeGlobalSettings = subscribeGlobalSettingsChanges(
      storageDirectory,
      (change) => {
        bridge?.publishGlobalSettings(change);
      },
    );
    await context.ui.showModalDialog(bridge.url, 1040, 720);
  } finally {
    attachmentOpener.close();
    unsubscribeApprovalModes?.();
    unsubscribeEditScopes?.();
    unsubscribeModelSelections?.();
    unsubscribeGlobalSettings?.();
    unsubscribeProfileSettings?.();
    unsubscribeSessionState?.();
    unsubscribeGlobalState?.();
    releaseSessionClaims(storageDirectory, modalSessionOwner);
    await modelState.stopBrowserLaunches();
    try {
      await bridge?.close();
    } finally {
      await modelState.close();
    }
  }
}

export async function decidePlanApproval(
  storageDirectory: string | undefined,
  sessionId: string,
  plan: AgentPlan,
  requestConfirmation: () => Promise<boolean>,
): Promise<AgentConfirmationDecision> {
  const approvalMode = await withStorageTransaction(
    storageDirectory,
    async (transaction) => {
      const session = (await listSessionsInTransaction(
        transaction,
        storageDirectory,
      )).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session ${sessionId} does not exist.`);
      return session.approvalMode ?? "manual";
    },
  );
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

export function showAgentError(context: Api, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  void import("../ui/dialogs.js").then(({ resultUrl }) =>
    context.ui.showModalDialog(resultUrl("Live Smith Error", message), 560, 240),
  );
}
