import type { ExtensionContext } from "@ableton-extensions/sdk";
import { createHash } from "node:crypto";

import {
  type AgentConfirmationDecision,
} from "../agent/loop.js";
import {
  createHostAbortController,
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
import { decodeDiscoveredModelCatalog } from "../model/catalog.js";
import type {
  DiscoveredModelInfo,
  CodexSubscriptionBackend,
  ManagedAuthReadOptions,
  ManagedAuthState,
} from "../model/provider.js";
import {
  ProfileValidationError,
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
import {
  availableSkillSummaries,
  isBuiltInSkillId,
} from "../skills/builtins.js";
import {
  createDirectApiBackend,
  type ModelBackendManager,
} from "../model/backend-registry.js";
import {
  acquireSharedModelBackendManager,
  type SharedModelBackendManagerLease,
} from "../model/shared-backend-manager.js";
import { canonicalStorageDirectory } from "../storage/scope.js";
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
  deleteSessionEvents,
  listSessionEventLogIds,
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
import { shouldOpenSettingsForAgentError } from "./error-routing.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
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
  type ChatBridgeSteeringReceiptLookupInput,
  type ChatBridgeSteeringReceiptLookupResult,
  type ChatBridgeStream,
} from "./chat-bridge.js";
import type {
  RawAttachmentBodyReadOptions,
  RawSkillBodyReadOptions,
} from "./chat-bridge-http.js";
import {
  publishSessionApprovalModeChange,
  subscribeSessionApprovalModeChanges,
} from "./session-approval-events.js";
import {
  invalidateSessionEditScopes,
  publishSessionEditScopesChange,
  subscribeSessionEditScopesChanges,
} from "./session-edit-scope-events.js";
import {
  publishSessionModelSelectionChange,
  subscribeSessionModelSelectionChanges,
} from "./session-model-selection-events.js";
import {
  publishGlobalSettingsChange,
  subscribeGlobalSettingsChanges,
} from "./global-settings-events.js";
import {
  publishProfileSettingsChange,
  subscribeProfileSettingsChanges,
  type ProfileSettingsChange,
} from "./profile-settings-events.js";
import {
  capabilityPreviewForProfile,
  requestModelTurn,
  resolveDiscoveredModels,
  runtimeProfileForSavedProfile,
} from "./model-request.js";
import {
  getOrCreateDefaultSession,
  isReusableEmptySessionMetadata,
  sessionSummaries,
  projectKeyForContext,
  continuableSessionsForScope,
  withSessionCreationScope,
} from "./session-context.js";
import {
  claimSession,
  releaseSessionClaims,
  sessionIsClaimedByAnotherOwner,
} from "./session-claims.js";
import { resolveSkillContextInTransaction } from "./skill-context.js";
import {
  invalidateGlobalState,
  invalidateSessionState,
  subscribeGlobalStateInvalidations,
  subscribeSessionStateInvalidations,
} from "./session-state-events.js";
import { LiveMutationQueue } from "./live-mutation-queue.js";
import {
  SessionMutationFence,
  sessionMutationFenceKey,
} from "./session-mutation-fence.js";
import {
  modelAuthSendFenceForStorage,
  type ModelAuthSendFence,
} from "./model-auth-send-fence.js";
import {
  SteeringClosedError,
  type SteeringChannel,
} from "./steering.js";
import {
  consumedAttachmentIds,
  handleAgentRequest,
  steeringReceiptFor,
  type AgentModelTurnRequester,
} from "./agent-request.js";

type Api = ExtensionContext<"1.0.0">;
const sessionMutationFence = new SessionMutationFence();
const sessionIntentFence = new SessionMutationFence();
const globalSettingsMutationFence = new SessionMutationFence();
const requestConfigurationFence = new SessionMutationFence();

function effectiveSessionModelSelection(
  profile: SavedProfile,
  session: AgentSession,
): { model: string; reasoningEffort?: NonNullable<AgentSession["modelSelection"]>["reasoningEffort"] } {
  const selection = session.modelSelection;
  if (
    !selection ||
    selection.profileId !== profile.id ||
    !profile.models.some((model) => model.model === selection.model)
  ) {
    return { model: profile.defaultModel };
  }
  return {
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  };
}

export interface AgentFlowDependencies {
  deleteSession?: typeof deleteSession;
  getOrCreateDefaultSession?: typeof getOrCreateDefaultSession;
  loadSessionEvents?: typeof loadSessionEvents;
  requestModelTurn?: typeof requestModelTurn;
  saveGlobalSettings?: typeof saveGlobalSettings;
  updateSessionInTransaction?: typeof updateSessionInTransaction;
  listModels?(
    profile: DraftProfile,
    signal: AbortSignal,
  ): Promise<DiscoveredModelInfo[]>;
  /** Test-only manager; production creates Direct backends per use and shares managed. */
  modelBackendManager?: Pick<
    ModelBackendManager,
    "forProfile" | "codex" | "codexLease" | "invalidateCodex" | "close"
  >;
  /** Process-wide in production; injectable only for isolated tests. */
  modelAuthSendFence?: ModelAuthSendFence;
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
  let status: string | undefined;
  let openSettingsOnLoad = false;
  let activeSessionId: string | undefined;
  const modalSessionOwner = Symbol("Live Smith modal Session owner");
  const modelsByConnection = new Map<string, DiscoveredModelInfo[]>();
  const modelCatalogLoadReceiptByConnection = new Map<string, string>();
  const codexCatalogGenerationByConnection = new Map<string, number>();
  const storageDirectory = context.environment.storageDirectory === undefined
    ? undefined
    : await canonicalStorageDirectory(context.environment.storageDirectory);
  const modelAuthSendFence = dependencies.modelAuthSendFence ??
    modelAuthSendFenceForStorage(storageDirectory);
  let sharedBackendManagerLeasePromise:
    | Promise<SharedModelBackendManagerLease>
    | undefined;
  let sharedBackendManagerLease: SharedModelBackendManagerLease | undefined;
  let sharedBackendManagerAcquisitionController:
    | ReturnType<typeof createHostAbortController>
    | undefined;
  const managedBackendAcquisitionClosedError = new Error(
    "The managed model backend acquisition was closed.",
  );
  let managedBackendLeaseClosing = false;
  const managedBackendManager = async (signal?: AbortSignal) => {
    if (dependencies.modelBackendManager) return dependencies.modelBackendManager;
    throwIfAborted(signal);
    if (
      sharedBackendManagerLeasePromise === undefined &&
      managedBackendLeaseClosing
    ) {
      throw new Error("The managed model backend is closing.");
    }
    if (sharedBackendManagerLeasePromise === undefined) {
      sharedBackendManagerAcquisitionController = createHostAbortController();
      sharedBackendManagerLeasePromise = acquireSharedModelBackendManager(
        storageDirectory,
        { onPoison: (error) => modelAuthSendFence.poison(error) },
        sharedBackendManagerAcquisitionController.signal,
      ).then((lease) => {
        sharedBackendManagerLease = lease;
        return lease;
      });
    }
    return (await waitForPromiseWithSignal(
      sharedBackendManagerLeasePromise,
      signal,
    )).manager;
  };
  const modelBackendManager = {
    async forProfile(
      profile: DraftProfile | SavedProfile,
      signal?: AbortSignal,
    ) {
      if (
        profile.connection.kind === "direct-api" &&
        dependencies.modelBackendManager === undefined
      ) {
        return createDirectApiBackend(profile);
      }
      return (await managedBackendManager(signal)).forProfile(profile, signal);
    },
    async codex(signal?: AbortSignal) {
      return (await managedBackendManager(signal)).codex(signal);
    },
    async codexLease(signal?: AbortSignal) {
      return (await managedBackendManager(signal)).codexLease(signal);
    },
    async invalidateCodex() {
      return (await managedBackendManager()).invalidateCodex();
    },
  };
  const modelAuthOwner = Symbol("Live Smith modal auth owner");
  let managedBoundaryUsed = false;
  let observedAuthGeneration: number | undefined;
  let codexAuth: ManagedAuthState | undefined;
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
    sessionMutationFenceKey(storageDirectory, sessionId),
    signal,
    operation,
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
    operation,
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
  const notifySessionStateChanged = (sessionId: string): void => {
    invalidateSessionState(storageDirectory, {
      sessionId,
      source: modalSessionOwner,
    });
  };
  const notifyGlobalStateChanged = (): void => {
    invalidateGlobalState(storageDirectory, { source: modalSessionOwner });
  };
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

  const modelProjectionForProfile = async (
    profile: DraftProfile | SavedProfile,
    signal?: AbortSignal,
  ) => {
    throwIfAborted(signal);
    const fingerprint = connectionFingerprint(profile);
    if (profile.connection.kind === "direct-api") {
      const cachedModels = modelsByConnection.get(fingerprint);
      if (cachedModels) return { models: cachedModels, ready: true };
      const models = await loadModelCache(
        storageDirectory,
        profile,
      );
      throwIfAborted(signal);
      modelsByConnection.set(fingerprint, models);
      return { models, ready: true };
    }
    const generation = await synchronizeAuthGeneration(signal);
    const models = modelsByConnection.get(fingerprint);
    const ready = models !== undefined &&
      codexCatalogGenerationByConnection.get(fingerprint) === generation;
    return { models: ready ? models : [], ready };
  };

  const requireDiscoveredModelCatalog = (
    value: unknown,
  ): DiscoveredModelInfo[] => {
    const models = decodeDiscoveredModelCatalog(value);
    if (!models) {
      throw new Error(
        "Model discovery returned an invalid or ambiguous catalog.",
      );
    }
    return models;
  };

  const clearCodexCatalogs = (): void => {
    for (const fingerprint of codexCatalogGenerationByConnection.keys()) {
      modelsByConnection.delete(fingerprint);
      modelCatalogLoadReceiptByConnection.delete(fingerprint);
    }
    codexCatalogGenerationByConnection.clear();
  };

  async function synchronizeAuthGeneration(
    signal?: AbortSignal,
  ): Promise<number> {
    managedBoundaryUsed = true;
    for (;;) {
      throwIfAborted(signal);
      const generation = modelAuthSendFence.authGeneration();
      if (observedAuthGeneration === undefined) {
        observedAuthGeneration = generation;
        return generation;
      }
      if (generation === observedAuthGeneration) return generation;
      if (dependencies.modelBackendManager !== undefined) {
        try {
          await modelBackendManager.invalidateCodex();
        } catch (error) {
          modelAuthSendFence.poison(error);
          throw error;
        }
        throwIfAborted(signal);
      }
      clearCodexCatalogs();
      codexAuth = undefined;
      observedAuthGeneration = generation;
    }
  }

  function recordOwnedAuthState(auth: ManagedAuthState): void {
    modelAuthSendFence.updateAuthState(
      modelAuthOwner,
      auth.status,
      auth.status === "unavailable" && auth.definitive === true,
    );
    observedAuthGeneration = modelAuthSendFence.authGeneration();
    clearCodexCatalogs();
  }

  function recordOwnedAuthMutation(auth: ManagedAuthState): void {
    if (auth.status === "unavailable") codexAuth = undefined;
    modelAuthSendFence.updateAuthState(modelAuthOwner, auth.status, true);
    observedAuthGeneration = modelAuthSendFence.authGeneration();
    clearCodexCatalogs();
  }

  const unavailableCodexAuth = (): ManagedAuthState => ({
    status: "unavailable",
    message:
      "Codex CLI 0.148.x could not provide a valid ChatGPT subscription session.",
  });

  const readCodexAuth = async (
    signal?: AbortSignal,
    options: ManagedAuthReadOptions = {},
  ): Promise<ManagedAuthState> => {
    for (;;) {
      const generation = await synchronizeAuthGeneration(signal);
      let auth: ManagedAuthState;
      try {
        const backend = await modelBackendManager.codex(signal);
        throwIfAborted(signal);
        auth = await backend.readAuthState(signal, options);
      } catch (error) {
        throwIfAborted(signal);
        auth = unavailableCodexAuth();
      }
      if (modelAuthSendFence.authGeneration() !== generation) continue;
      codexAuth = auth;
      return auth;
    }
  };

  const reconcilePendingCodexAuthWhileReading = async (
    signal?: AbortSignal,
  ): Promise<ManagedAuthState | undefined> => {
    if (!modelAuthSendFence.hasPendingLogin()) return undefined;
    const auth = await modelAuthSendFence.reconcilePendingAuthState(
      (reconciliationSignal) =>
        readCodexAuth(reconciliationSignal, { readiness: true }),
      signal,
    );
    if (auth === undefined) return undefined;
    await synchronizeAuthGeneration(signal);
    codexAuth = auth;
    return auth;
  };

  const withPendingCodexAuthReconciliation = async <T>(
    signal: AbortSignal | undefined,
    operation: (auth: ManagedAuthState) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!modelAuthSendFence.hasPendingLogin()) return undefined;
    const release = await modelAuthSendFence.enterRead(signal);
    try {
      const auth = await reconcilePendingCodexAuthWhileReading(signal);
      return auth === undefined ? undefined : await operation(auth);
    } finally {
      release();
    }
  };

  const runCodexAuthOperation = async (
    operation: "beginLogin" | "logout",
    signal: AbortSignal,
  ): Promise<ManagedAuthState> => {
    let mutationAttempted = false;
    let retireBackend: (() => Promise<boolean>) | undefined;
    let retirementPromise: Promise<void> | undefined;
    const confirmUnknownMutationRetirement = (): Promise<void> => {
      retirementPromise ??= (async () => {
        try {
          if (retireBackend) await retireBackend();
          else await modelBackendManager.invalidateCodex();
        } catch (error) {
          modelAuthSendFence.poison(error);
          throw error;
        }
      })();
      return retirementPromise;
    };
    try {
      const lease = await modelBackendManager.codexLease(signal);
      const backend = lease.backend;
      retireBackend = lease.retire;
      mutationAttempted = true;
      const invoke = backend[operation];
      const auth = await invoke.call(backend, signal);
      if (auth.status === "unavailable" && auth.definitive !== true) {
        await confirmUnknownMutationRetirement();
      }
      codexAuth = auth;
      recordOwnedAuthMutation(auth);
      return auth;
    } catch (error) {
      const auth = unavailableCodexAuth();
      let retirementError: unknown;
      if (mutationAttempted) {
        try {
          await confirmUnknownMutationRetirement();
          recordOwnedAuthMutation(auth);
        } catch (retirementFailure) {
          retirementError = retirementFailure;
        }
      } else {
        codexAuth = auth;
      }
      try {
        throwIfAborted(signal);
      } catch (abortError) {
        throw abortError;
      }
      if (retirementError !== undefined) throw retirementError;
      return auth;
    }
  };

  const withExclusiveCodexAuth = async <T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const release = await modelAuthSendFence.enterAuth(modelAuthOwner, signal);
    if (!release) {
      throw new ChatBridgeConflictError(
        "Stop every active agent request before changing ChatGPT sign-in.",
      );
    }
    try {
      await synchronizeAuthGeneration(signal);
      return await operation();
    } finally {
      release();
    }
  };

  type BuildStateOptions = {
    heldSessionId?: string;
    sessionMutationHeld?: boolean;
    codexAuthAlreadyResolved?: boolean;
    signal?: AbortSignal;
  };

  const prepareBuildStateSettings = async (
    options: BuildStateOptions,
  ): Promise<AgentSettings> => {
    throwIfAborted(options.signal);
    if (!options.sessionMutationHeld) {
      await retryPendingSessionCleanup();
      throwIfAborted(options.signal);
    }
    const settings = await loadAgentSettings(storageDirectory);
    throwIfAborted(options.signal);
    return settings;
  };

  const stateRequiresManagedProjection = (
    previewProfile: DraftProfile | undefined,
    settings: AgentSettings,
  ): boolean =>
    previewProfile?.connection.kind === "codex-subscription" ||
    activeSavedProfile(settings)?.connection.kind === "codex-subscription";

  const buildStateFromSettings = async (
    settings: AgentSettings,
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => {
    const signal = options.signal;
    throwIfAborted(signal);
    if (stateRequiresManagedProjection(previewProfile, settings)) {
      await synchronizeAuthGeneration(signal);
    }
    const activeProfile = activeSavedProfile(settings);
    const modelProfile = previewProfile ?? activeProfile;
    if (
      modelProfile?.connection.kind === "codex-subscription" &&
      !options.codexAuthAlreadyResolved
    ) {
      if (modelAuthSendFence.hasPendingLogin()) {
        await reconcilePendingCodexAuthWhileReading(signal);
      } else if (codexAuth === undefined) {
        await readCodexAuth(signal);
      }
    }
    const modelProjection = modelProfile
      ? await modelProjectionForProfile(modelProfile, signal)
      : { models: [], ready: true };
    const activeProfileProjection = activeProfile
      ? modelProfile?.id === activeProfile.id &&
          connectionFingerprint(modelProfile) === connectionFingerprint(activeProfile)
        ? modelProjection
        : await modelProjectionForProfile(activeProfile, signal)
      : { models: [], ready: true };
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
            const allSessions = await sessionSummaries(
              storageDirectory,
              await listSessionsInTransaction(transaction, storageDirectory),
            );
            const installedSkills = await listInstalledSkillsInTransaction(
              transaction,
              storageDirectory,
            );
            const availableSkills = availableSkillSummaries(installedSkills);
            return { allSessions, availableSkills };
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
      const projectedAuthGeneration =
        modelAuthSendFence.peekAuthGeneration();
      return {
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
        approvalMode: activeSession.approvalMode ?? "manual",
        events,
        pendingAttachments,
        availableSkills: storageSnapshot.availableSkills,
        activeSkillIds: [...(activeSession.activeSkillIds ?? [])],
        capabilities: capabilityPreview.capabilities,
        capabilityEvidence: capabilityPreview.capabilityEvidence,
        availableModels: modelProfile
          ? resolveDiscoveredModels(modelProfile, models)
          : [],
        ...(modelProfile && modelCatalogLoadReceiptByConnection.has(
          connectionFingerprint(modelProfile),
        )
          ? {
              modelCatalogLoadReceipt: modelCatalogLoadReceiptByConnection.get(
                connectionFingerprint(modelProfile),
              )!,
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
        ...(codexAuth === undefined ||
            observedAuthGeneration !== projectedAuthGeneration
          ? {}
          : { codexAuth }),
        codexAuthGeneration: projectedAuthGeneration,
        status,
        openSettingsOnLoad: activeProfile ? openSettingsOnLoad : true,
      };
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

  const buildState = async (
    previewProfile?: DraftProfile,
    options: BuildStateOptions = {},
  ) => {
    const signal = options.signal;
    const settings = await prepareBuildStateSettings(options);
    if (!stateRequiresManagedProjection(previewProfile, settings)) {
      return buildStateFromSettings(settings, previewProfile, options);
    }
    const releaseAuthRead = await modelAuthSendFence.enterRead(signal);
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
    if (commandInput.kind === "save_profile") {
      const settings = await loadAgentSettings(storageDirectory);
      const otherProfiles = settings.profiles.filter(
        (profile) => profile.id !== commandInput.profile.id,
      );
      const profile = validateDraftProfileForSave(commandInput.profile, otherProfiles);
      const previousProfile = settings.profiles.find(
        (entry) => entry.id === profile.id,
      );
      const profileFingerprint = connectionFingerprint(profile);
      const saveWithCatalog = async (
        cachedModels: DiscoveredModelInfo[],
        subscriptionCatalogReady = false,
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
                if (previousProfile?.connection.kind !== "codex-subscription") {
                  return true;
                }
                const previous = previousModelsById.get(model.model);
                return !previous || JSON.stringify(previous) !== JSON.stringify(model);
              });
        const subscriptionDefaultChanged =
          profile.connection.kind === "codex-subscription" &&
          previousProfile?.connection.kind === "codex-subscription" &&
          profile.defaultModel !== previousProfile.defaultModel;
        if (
          profile.connection.kind === "codex-subscription" &&
          (modelConfigsToValidate.length > 0 || subscriptionDefaultChanged) &&
          !subscriptionCatalogReady
        ) {
          throw new ChatBridgeConflictError(
            "Load the current ChatGPT model catalog before changing subscription model settings.",
          );
        }
        for (const model of modelConfigsToValidate) {
          if (
            profile.connection.kind === "codex-subscription" &&
            !cachedModelsById.has(model.model)
          ) {
            throw new ProfileValidationError(
              "models",
              `Model ${model.model} is not available for the signed-in ChatGPT account.`,
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
        try {
          await runProfileSettingsMutation(() =>
            saveSavedProfile(storageDirectory, profile, {
              expectedCurrentProfileRevision:
                commandInput.expectedProfileRevision,
            })
          );
        } catch (error) {
          if (error instanceof SavedProfileConflictError) {
            throw new ChatBridgeConflictError(error.message);
          }
          throw error;
        }
        if (profile.connection.kind === "direct-api") {
          // Direct API catalogs are durable and are reloaded from storage after
          // Save. Subscription catalogs are modal-only and remain valid until
          // the shared auth generation changes.
          modelsByConnection.delete(profileFingerprint);
        }
        status = `Profile ${profile.name} saved.`;
        openSettingsOnLoad = false;
        return buildStateAfterCommandMutation(profile, { signal });
      };

      if (profile.connection.kind === "direct-api") {
        return saveWithCatalog(
          modelsByConnection.get(profileFingerprint) ?? [],
        );
      }

      const releaseManagedSave = await modelAuthSendFence.enterManagedUse(signal);
      if (!releaseManagedSave) {
        throw new ChatBridgeConflictError(
          "Wait for the ChatGPT sign-in operation to finish before saving this Profile.",
        );
      }
      try {
        const generation = await synchronizeAuthGeneration(signal);
        const subscriptionCatalogReady =
          codexCatalogGenerationByConnection.get(profileFingerprint) === generation &&
          modelsByConnection.has(profileFingerprint);
        const cachedModels = subscriptionCatalogReady
          ? modelsByConnection.get(profileFingerprint) ?? []
          : [];
        return await saveWithCatalog(cachedModels, subscriptionCatalogReady);
      } finally {
        releaseManagedSave();
      }
    }

    if (commandInput.kind === "delete_profile") {
      throwIfAborted(signal);
      await runProfileSettingsMutation(() =>
        deleteSavedProfile(
          storageDirectory,
          commandInput.profileId,
        )
      );
      modelsByConnection.clear();
      modelCatalogLoadReceiptByConnection.clear();
      status = "Profile deleted.";
      openSettingsOnLoad = true;
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
      modelsByConnection.clear();
      modelCatalogLoadReceiptByConnection.clear();
      status = undefined;
      openSettingsOnLoad = false;
      return buildStateAfterCommandMutation();
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
            const settings = await (
              dependencies.saveGlobalSettings ?? saveGlobalSettings
            )(storageDirectory, {
              defaultFollowUpBehavior: commandInput.defaultFollowUpBehavior,
            });
            publishGlobalSettingsChange(storageDirectory, {
              defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
              defaultFollowUpBehaviorRevision:
                settings.defaultFollowUpBehaviorRevision,
              commandId: commandContext.commandId,
            });
            status = "Default follow-up behavior saved.";
            return buildStateAfterCommandMutation();
          } catch (cause) {
            if (!isStorageCommitOutcomeUnknownError(cause)) throw cause;

            try {
              const settings = await loadAgentSettings(
                storageDirectory,
              );
              publishGlobalSettingsChange(storageDirectory, {
                defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
                defaultFollowUpBehaviorRevision:
                  settings.defaultFollowUpBehaviorRevision,
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
              "Default follow-up behavior storage could not be confirmed.",
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

      const releaseManagedLoad = await modelAuthSendFence.enterManagedUse(signal);
      if (!releaseManagedLoad) {
        throw new ChatBridgeConflictError(
          "Wait for the ChatGPT sign-in operation to finish before loading model capabilities.",
        );
      }
      try {
        const generation = await synchronizeAuthGeneration(signal);
        const fingerprint = connectionFingerprint(profile);
        if (
          codexCatalogGenerationByConnection.get(fingerprint) !== generation ||
          !modelsByConnection.has(fingerprint)
        ) {
          const backend = await modelBackendManager.codex(signal);
          const models = requireDiscoveredModelCatalog(
            await backend.listModels(profile, signal),
          );
          const auth = await backend.readAuthState(signal, { readiness: true });
          codexAuth = auth;
          const authError = subscriptionSendAuthError(auth);
          if (authError) throw new ChatBridgeConflictError(authError);
          throwIfAborted(signal);
          if (modelAuthSendFence.authGeneration() !== generation) {
            throw new ChatBridgeConflictError(
              "ChatGPT sign-in changed before model capabilities finished loading.",
            );
          }
          modelsByConnection.set(fingerprint, models);
          codexCatalogGenerationByConnection.set(fingerprint, generation);
        }
        status = undefined;
        openSettingsOnLoad = false;
        return await buildStateAfterCommandMutation(undefined, { signal });
      } finally {
        releaseManagedLoad();
      }
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
        let releaseManagedSelection: (() => void) | undefined;
        try {
          throwIfAborted(signal);
          const initialSettings = await loadAgentSettings(storageDirectory);
          const initialProfile = requireActiveSavedProfile(initialSettings);
          if (initialProfile.id !== commandInput.profileId) {
            throw new ChatBridgeConflictError(
              "The active Profile changed. Choose the model again.",
            );
          }
          let managedGeneration: number | undefined;
          if (initialProfile.connection.kind === "codex-subscription") {
            releaseManagedSelection = await modelAuthSendFence.enterManagedUse(
              signal,
            ) ?? undefined;
            if (!releaseManagedSelection) {
              throw new ChatBridgeConflictError(
                "Wait for the ChatGPT sign-in operation to finish before changing this Session's model.",
              );
            }
            managedGeneration = await synchronizeAuthGeneration(signal);
          }

          const { models } = await modelProjectionForProfile(initialProfile, signal);
          if (
            initialProfile.connection.kind === "codex-subscription" &&
            !models.some((model) => model.id === commandInput.model)
          ) {
            throw new ChatBridgeConflictError(
              models.length === 0
                ? "Load the current ChatGPT model catalog before changing this Session's model."
                : "That model is not available for the signed-in ChatGPT account.",
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
                  managedGeneration !== undefined &&
                  modelAuthSendFence.authGeneration() !== managedGeneration
                ) {
                  throw new ChatBridgeConflictError(
                    "ChatGPT sign-in changed. Choose the model again.",
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
          releaseManagedSelection?.();
        }
      });
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

    if (commandInput.kind === "delete_session") {
      let existed = false;
      await withSessionMutation(commandInput.sessionId, signal, async () => {
        existed = await sessionExists(commandInput.sessionId);
        throwIfAborted(signal);
        if (existed) {
          try {
            await (dependencies.deleteSession ?? deleteSession)(
              storageDirectory,
              commandInput.sessionId,
            );
          } catch (cause) {
            if (isStorageCommitOutcomeUnknownError(cause)) {
              pendingSessionCleanup.add(commandInput.sessionId);
              notifySessionStateChanged(commandInput.sessionId);
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
            storageDirectory,
            commandInput.sessionId,
          );
          await deleteSessionAttachments(
            storageDirectory,
            commandInput.sessionId,
          );
          pendingSessionCleanup.delete(commandInput.sessionId);
        } catch (cause) {
          pendingSessionCleanup.add(commandInput.sessionId);
          notifySessionStateChanged(commandInput.sessionId);
          throw new ChatBridgeCommandOutcomeUnknownError(
            "The Session was deleted, but associated data cleanup could not be confirmed.",
            { cause },
          );
        }
        notifySessionStateChanged(commandInput.sessionId);
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
                    const availableIds = new Set(
                      availableSkillSummaries(installed).map(
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
      const releaseManagedDiscovery = profile.connection.kind === "codex-subscription"
        ? await modelAuthSendFence.enterManagedUse(signal)
        : () => undefined;
      if (!releaseManagedDiscovery) {
        throw new ChatBridgeConflictError(
          "Wait for the ChatGPT sign-in operation to finish before loading models.",
        );
      }
      let cacheMutationCompleted = false;
      try {
        const managedGeneration = profile.connection.kind === "codex-subscription"
          ? await synchronizeAuthGeneration(signal)
          : undefined;
        const discovered = requireDiscoveredModelCatalog(await (
          dependencies.listModels ??
          (async (targetProfile, targetSignal) => {
            const backend = await modelBackendManager.forProfile(
              targetProfile,
              targetSignal,
            );
            try {
              return await backend.listModels(targetProfile, targetSignal);
            } finally {
              if (backend.kind === "direct-api") await backend.close();
            }
          })
        )(profile, signal));
        throwIfAborted(signal);
        if (profile.connection.kind === "direct-api") {
          await saveModelCache(
            storageDirectory,
            profile,
            discovered,
          );
        }
        cacheMutationCompleted = true;
        throwIfAborted(signal);
        const fingerprint = connectionFingerprint(profile);
        modelsByConnection.set(fingerprint, discovered);
        modelCatalogLoadReceiptByConnection.set(
          fingerprint,
          commandContext.commandId,
        );
        if (profile.connection.kind === "codex-subscription") {
          codexCatalogGenerationByConnection.set(
            fingerprint,
            managedGeneration!,
          );
        }
        status = discovered.length
          ? `Discovered ${discovered.length} model${discovered.length === 1 ? "" : "s"}.`
          : "No models returned by this provider.";
      } catch (error) {
        throwIfAborted(signal);
        status = error instanceof Error ? error.message : String(error);
      } finally {
        releaseManagedDiscovery();
      }
      openSettingsOnLoad = true;
      return cacheMutationCompleted
        ? buildStateAfterCommandMutation(profile, { signal })
        : buildState(profile, { signal });
    }

    if (commandInput.kind === "start_codex_login") {
      await withExclusiveCodexAuth(async () => {
        const auth = await runCodexAuthOperation("beginLogin", signal);
        status = codexAuthStatusMessage(auth);
        openSettingsOnLoad = true;
      }, signal);
      return buildStateAfterCommandMutation(undefined, { signal });
    }

    if (commandInput.kind === "refresh_codex_account") {
      const pendingState = await withPendingCodexAuthReconciliation(
        signal,
        async (pendingAuth) => {
          status = codexAuthStatusMessage(pendingAuth);
          openSettingsOnLoad = true;
          return confirmCommandState(() =>
            buildStateWithAuthReadHeld(undefined, {
              codexAuthAlreadyResolved: true,
              signal,
            })
          );
        },
      );
      if (pendingState) return pendingState;
      await withExclusiveCodexAuth(async () => {
        codexAuth = undefined;
        const auth = await readCodexAuth(signal, { readiness: true });
        recordOwnedAuthState(auth);
        status = codexAuthStatusMessage(auth);
        openSettingsOnLoad = true;
      }, signal);
      return buildStateAfterCommandMutation(undefined, { signal });
    }

    if (commandInput.kind === "logout_codex") {
      await withExclusiveCodexAuth(async () => {
        const auth = await runCodexAuthOperation("logout", signal);
        status = codexAuthStatusMessage(auth);
        openSettingsOnLoad = true;
      }, signal);
      return buildStateAfterCommandMutation(undefined, { signal });
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

  async function retryPendingSessionCleanup(): Promise<void> {
    for (const sessionId of [...pendingSessionCleanup]) {
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) {
          pendingSessionCleanup.delete(sessionId);
          return;
        }
        await deleteSessionEvents(
          storageDirectory,
          sessionId,
        );
        await deleteSessionAttachments(
          storageDirectory,
          sessionId,
        );
        pendingSessionCleanup.delete(sessionId);
      });
    }
  }

  async function reconcileStartupSessionOrphans(): Promise<void> {
    const existingSessionIds = new Set(
      (await listSessions(storageDirectory)).map(
        (session) => session.id,
      ),
    );
    const orphanCandidates = new Set([
      ...await listSessionAttachmentDirectoryIds(
        storageDirectory,
      ),
      ...await listSessionEventLogIds(
        storageDirectory,
      ),
    ]);
    for (const sessionId of [...orphanCandidates].sort()) {
      if (existingSessionIds.has(sessionId)) continue;
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) return;
        await deleteSessionEvents(
          storageDirectory,
          sessionId,
        );
        await deleteSessionAttachments(
          storageDirectory,
          sessionId,
        );
      });
    }
  }

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
    await withSessionMutation(input.sessionId, signal, async () => {
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
    await withSessionMutation(input.sessionId, signal, async () => {
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
    let catalogChanged = false;
    await requestConfigurationFence.run(
      requestConfigurationFenceKey,
      signal,
      async () => {
        let invalidationPublished = false;
        const publishInvalidation = () => {
          if (invalidationPublished) return;
          invalidationPublished = true;
          notifyGlobalStateChanged();
        };
        try {
          installed = await withStorageTransaction(
            storageDirectory,
            async (transaction) => {
              throwIfAborted(signal);
              const existing = (await listInstalledSkillsInTransaction(
                transaction,
                storageDirectory,
              )).find((skill) => skill.id === definition.id);
              if (existing === undefined && isBuiltInSkillId(definition.id)) {
                throw new ChatBridgeSkillValidationError(
                  `Built-in Skill ${definition.id} is read-only and cannot be installed or replaced.`,
                );
              }
              if (existing?.sha256 === expectedSha256) return existing;
              if (existing !== undefined && !input.replace) {
                throw new ChatBridgeConflictError(
                  `Skill ${definition.id} is already installed. Confirm replacement to change it.`,
                );
              }
              throwIfAborted(signal);
              const next = await installSkillInTransaction(
                transaction,
                storageDirectory,
                bytes,
                { replace: input.replace },
              );
              catalogChanged = true;
              return next;
            },
          );
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            publishInvalidation();
            try {
              installed = (await listInstalledSkills(
                storageDirectory,
              )).find((skill) =>
                skill.id === definition.id && skill.sha256 === expectedSha256
              );
            } catch {
              installed = undefined;
            }
            if (installed === undefined) {
              throw new ChatBridgeCommandOutcomeUnknownError(
                "The Skill may have been installed, but its final state could not be confirmed.",
                { cause: error },
              );
            }
          } else if (
            error instanceof ChatBridgeConflictError ||
            error instanceof ChatBridgeSkillValidationError
          ) {
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
        if (catalogChanged) publishInvalidation();
      },
    );
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
    await requestConfigurationFence.run(
      requestConfigurationFenceKey,
      signal,
      async () => {
        let invalidationPublished = false;
        const publishInvalidation = () => {
          if (invalidationPublished) return;
          invalidationPublished = true;
          notifyGlobalStateChanged();
        };
        try {
          await withStorageTransaction(
            storageDirectory,
            async (transaction) => {
              throwIfAborted(signal);
              const existing = (await listInstalledSkillsInTransaction(
                transaction,
                storageDirectory,
              )).some((skill) => skill.id === input.skillId);
              if (!existing) return;
              const sessions = await listSessionsInTransaction(
                transaction,
                storageDirectory,
              );
              if (sessions.some((session) =>
                session.activeSkillIds?.includes(input.skillId)
              )) {
                throw new ChatBridgeConflictError(
                  "Remove this Skill from every Session before deleting it.",
                );
              }
              throwIfAborted(signal);
              await deleteInstalledSkillInTransaction(
                transaction,
                storageDirectory,
                input.skillId,
              );
              deleted = true;
            },
          );
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            publishInvalidation();
            try {
              const stillInstalled = (await listInstalledSkills(
                storageDirectory,
              )).some((skill) => skill.id === input.skillId);
              if (!stillInstalled) deleted = true;
              else throw error;
            } catch (reconciliationError) {
              throw new ChatBridgeCommandOutcomeUnknownError(
                "The Skill may have been deleted, but its final state could not be confirmed.",
                { cause: reconciliationError },
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
        if (deleted) publishInvalidation();
      },
    );
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
        const profile = requireActiveSavedProfile(requestSnapshot.settings);
        const modelSelection = effectiveSessionModelSelection(profile, session);
        const fingerprint = connectionFingerprint(profile);
        let requestBackend: CodexSubscriptionBackend | undefined;
        let models: DiscoveredModelInfo[] | undefined;
        if (profile.connection.kind === "codex-subscription") {
          releaseModelAuthFence = await modelAuthSendFence.enterManagedUse(signal) ??
            undefined;
          if (!releaseModelAuthFence) {
            throw new ChatBridgeConflictError(
              "Wait for the ChatGPT sign-in operation to finish before sending.",
            );
          }
          const generation = await synchronizeAuthGeneration(signal);
          const lease = await modelBackendManager.codexLease(signal);
          requestBackend = lease.backend;
          let auth: ManagedAuthState;
          try {
            models = requireDiscoveredModelCatalog(
              await requestBackend.listModels(profile, signal),
            );
            auth = await requestBackend.readAuthState(signal);
          } catch (error) {
            throwIfAborted(signal);
            auth = unavailableCodexAuth();
          }
          codexAuth = auth;
          const authError = subscriptionSendAuthError(auth);
          if (authError) throw new ChatBridgeConflictError(authError);
          if (models === undefined) {
            throw new ChatBridgeConflictError(
              "The ChatGPT subscription model catalog is unavailable.",
            );
          }
          throwIfAborted(signal);
          if (modelAuthSendFence.authGeneration() !== generation) {
            throw new ChatBridgeConflictError(
              "ChatGPT sign-in changed before the subscription request could start.",
            );
          }
          modelsByConnection.set(fingerprint, models);
          codexCatalogGenerationByConnection.set(fingerprint, generation);
        } else {
          models = modelsByConnection.get(fingerprint);
          if (models === undefined) {
            models = await loadModelCache(
              storageDirectory,
              profile,
            );
            modelsByConnection.set(fingerprint, models);
          }
        }
        if (models === undefined) {
          throw new Error("The active model catalog is unavailable.");
        }
        if (
          profile.connection.kind === "codex-subscription" &&
          !models.some((model) => model.id === modelSelection.model)
        ) {
          throw new ChatBridgeConflictError(
            "The selected subscription model is not available for the signed-in ChatGPT account. Choose an available model before sending.",
          );
        }
        const runtimeProfile = runtimeProfileForSavedProfile(
          profile,
          models,
          modelSelection,
        );
        validateGenerationParameters(
          runtimeProfile,
          runtimeProfile.capabilities,
        );
        const requestTurnImplementation = dependencies.requestModelTurn ??
          requestModelTurn;
        let preflightBackendForFirstTurn = requestBackend;
        const firstTurnReservation = requestBackend?.reserveToolTurn();
        const requestTurn = async (
          input: Parameters<AgentModelTurnRequester>[0],
        ) => {
          const turnReservation = preflightBackendForFirstTurn === undefined
            ? undefined
            : firstTurnReservation;
          const backend = preflightBackendForFirstTurn ??
            await modelBackendManager.forProfile(profile, input.signal);
          preflightBackendForFirstTurn = undefined;
          try {
            return await requestTurnImplementation({
              ...input,
              turnExecutor: turnReservation ?? backend,
            });
          } finally {
            if (backend.kind === "direct-api") await backend.close();
          }
        };
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
              steering,
              steeringSendId: sendContext.sendId,
              onDelta: (delta) => stream.assistantDelta(delta),
              onAssistantReset: () => stream.assistantReset(),
              onModelTurnAccepted: (usage) => stream.modelTurnAccepted(usage),
              onProgress: (message) => stream.progress(message),
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
              confirmActions: (plan) => decidePlanApproval(
                storageDirectory,
                session.id,
                plan,
                () => stream.requestConfirmation({
                  kind: "apply",
                  message: plan.message,
                  groups: actionDiffGroups(plan.actions, plan.targets),
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
        let reservationReleaseFailed = false;
        let reservationReleaseError: unknown;
        try {
          await firstTurnReservation?.release();
        } catch (error) {
          reservationReleaseFailed = true;
          reservationReleaseError = error;
          modelAuthSendFence.poison(error);
        }
        if (requestFailed) throw requestError;
        if (reservationReleaseFailed) throw reservationReleaseError;
        steering.close();
        return buildStateWhileHoldingSessionMutation(sendInput.sessionId);
      } catch (error) {
        steering.close(new SteeringClosedError(
          "The active send ended before steering was accepted.",
        ));
        if (error instanceof ChatBridgeSendFailureError) throw error;
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
  let bridge: Awaited<ReturnType<typeof createChatBridge>> | undefined;
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
      ({ source }) => {
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
    await reconcileStartupSessionOrphans();
    bridge = await createChatBridge({
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
      ...(dependencies.attachmentBodyReadOptions === undefined
        ? {}
        : { attachmentBodyReadOptions: dependencies.attachmentBodyReadOptions }),
      ...(dependencies.skillBodyReadOptions === undefined
        ? {}
        : { skillBodyReadOptions: dependencies.skillBodyReadOptions }),
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
        bridge?.publishDefaultFollowUpBehavior(change);
      },
    );
    await context.ui.showModalDialog(bridge.url, 1040, 720);
  } finally {
    unsubscribeApprovalModes?.();
    unsubscribeEditScopes?.();
    unsubscribeModelSelections?.();
    unsubscribeGlobalSettings?.();
    unsubscribeProfileSettings?.();
    unsubscribeSessionState?.();
    unsubscribeGlobalState?.();
    releaseSessionClaims(storageDirectory, modalSessionOwner);
    managedBackendLeaseClosing = true;
    sharedBackendManagerAcquisitionController?.abort(
      managedBackendAcquisitionClosedError,
    );
    try {
      await bridge?.close();
    } finally {
      let backendCleanupError: unknown;
      try {
        if (
          managedBoundaryUsed &&
          (dependencies.modelBackendManager !== undefined ||
            sharedBackendManagerLease !== undefined)
        ) {
          const releasePendingCleanup = await modelAuthSendFence
            .enterPendingOwnerCleanup(modelAuthOwner);
          if (releasePendingCleanup) try {
            await modelBackendManager.invalidateCodex();
          } finally {
            releasePendingCleanup();
          }
        }
      } catch (error) {
        modelAuthSendFence.poison(error);
        backendCleanupError = error;
      }
      modelAuthSendFence.releaseOwner(modelAuthOwner);
      try {
        if (dependencies.modelBackendManager) {
          await dependencies.modelBackendManager.close();
        } else if (sharedBackendManagerLeasePromise) {
          try {
            await sharedBackendManagerLeasePromise;
          } catch (error) {
            if (error !== managedBackendAcquisitionClosedError) throw error;
          }
          await sharedBackendManagerLease?.release();
        }
      } catch (error) {
        modelAuthSendFence.poison(error);
        backendCleanupError ??= error;
      }
      if (backendCleanupError !== undefined) throw backendCleanupError;
    }
  }
}

function codexAuthStatusMessage(state: ManagedAuthState): string {
  switch (state.status) {
    case "unavailable":
      return state.message;
    case "signed-out":
      return "Signed out of ChatGPT.";
    case "pending":
      return "Complete ChatGPT sign-in in your browser, then check again.";
    case "signed-in":
      return state.subscriptionEligible
        ? "Signed in with ChatGPT."
        : ineligibleCodexSubscriptionMessage;
  }
}

const ineligibleCodexSubscriptionMessage =
  "This workspace-managed ChatGPT account is not eligible for subscription requests in Live Smith. Use Check after changing accounts, or Logout.";

function subscriptionSendAuthError(
  state: ManagedAuthState,
): string | undefined {
  switch (state.status) {
    case "signed-in":
      return state.subscriptionEligible
        ? undefined
        : ineligibleCodexSubscriptionMessage;
    case "pending":
      return "Complete ChatGPT sign-in before sending a subscription request.";
    case "signed-out":
      return "Sign in to ChatGPT before sending a subscription request.";
    case "unavailable":
      return "The ChatGPT subscription is unavailable. Check the account status before sending.";
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
