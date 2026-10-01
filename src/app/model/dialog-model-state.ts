import { createDialogModelBackends, oauthSubscriptionProviders, type DialogModelBackendDependencies } from "./dialog-model-backends.js";
import { modelAuthSendFenceForStorage, type ModelAuthSendFence } from "./model-auth-send-fence.js";
import { requestModelTurn, runtimeProfileForSavedProfile } from "./model-request.js";
import { createHostAbortController, throwIfAborted, waitForPromiseWithSignal } from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import { decodeDiscoveredModelCatalog } from "../../model/catalog.js";
import { validateGenerationParameters } from "../../model/capabilities.js";
import type { DraftProfile, SavedProfile, OAuthSubscriptionProvider } from "../../model/profile.js";
import type { DiscoveredModelInfo, OAuthAuthReadOptions, OAuthAuthState, OAuthSubscriptionBackend, RuntimeProfile } from "../../model/provider.js";
import { connectionFingerprint, loadModelCache, saveModelCache } from "../../storage/model-cache.js";
import { storageScopeKey, type StorageScopeKey } from "../../storage/scope.js";
import { prepareOAuthCredentialStoreForSavedProfiles, loadAgentSettings, requireActiveSavedProfile, type AgentSettings } from "../../storage/settings.js";
import { deleteOAuthCredentialProfile, retainOAuthCredentialForProfileProvider } from "../../storage/oauth-credentials.js";
import type { AgentSession } from "../../storage/sessions.js";
import type { AgentModelTurnRequester } from "../agent-request.js";
import { ChatBridgeConflictError, type ChatBridgeCommandInput } from "../chat/chat-bridge.js";

export interface DialogModelStateDependencies extends DialogModelBackendDependencies {
  modelAuthSendFence?: ModelAuthSendFence;
  requestModelTurn?: typeof requestModelTurn;
  listModels?(profile: DraftProfile, signal: AbortSignal): Promise<DiscoveredModelInfo[]>;
  openOAuthAuthorizationUrl?(url: string, signal?: AbortSignal): Promise<void>;
}

type OAuthAccountCommand = Extract<ChatBridgeCommandInput, {
  kind: "start_oauth_login" | "submit_oauth_authorization_code" | "open_oauth_authorization" | "logout_oauth";
}>;

interface DialogModelStateOptions {
  storageDirectory: string | undefined;
  dependencies: DialogModelStateDependencies;
  withRequestConfiguration<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
  notifyOAuthAuthStateChanged(scope: OAuthProfileScope, generation: number, auth: OAuthAuthState): void;
}

const pendingProfileOAuthLifecycleByStorage = new Map<
  StorageScopeKey,
  Set<string>
>();

function pendingProfileOAuthLifecycleForStorage(
  storageDirectory: string | undefined,
): Set<string> {
  const key = storageScopeKey(storageDirectory);
  let pending = pendingProfileOAuthLifecycleByStorage.get(key);
  if (!pending) {
    pending = new Set();
    pendingProfileOAuthLifecycleByStorage.set(key, pending);
  }
  return pending;
}

export function effectiveSessionModelSelection(
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

export interface OAuthProfileScope {
  profileId: string;
  provider: OAuthSubscriptionProvider;
}

export function oauthProfileScope(
  profile: DraftProfile | SavedProfile,
): OAuthProfileScope {
  if (profile.connection.kind !== "oauth-subscription") {
    throw new TypeError("An OAuth subscription Profile is required.");
  }
  return {
    profileId: profile.id,
    provider: profile.connection.provider,
  };
}

function oauthScopeKey(scope: OAuthProfileScope): string {
  return `${scope.profileId}:${scope.provider}`;
}

/** Owns dialog model catalogs, OAuth state and backend/browser lifetimes. */
export function createDialogModelState(options: DialogModelStateOptions) {
  const { storageDirectory, dependencies, withRequestConfiguration, notifyOAuthAuthStateChanged } = options;
  const modelsByConnection = new Map<string, DiscoveredModelInfo[]>();
  const modelCatalogLoadReceiptByConnection = new Map<string, string>();
  const oauthCatalogOwnershipByConnection = new Map<
    string,
    { generation: number; scopeKey: string }
  >();
  const modelAuthSendFenceFor = (
    profileId: string,
  ): ModelAuthSendFence => dependencies.modelAuthSendFence ??
    modelAuthSendFenceForStorage(storageDirectory, profileId);
  const oauthScopesUsed = new Map<string, OAuthProfileScope>();
  const pendingProfileOAuthLifecycleReconciliation =
    pendingProfileOAuthLifecycleForStorage(storageDirectory);
  void prepareOAuthCredentialStoreForSavedProfiles(storageDirectory).catch(
    () => undefined,
  );
  const modelBackendManager = createDialogModelBackends(storageDirectory, dependencies);
  const modelAuthOwner = Symbol("Live Smith modal auth owner");
  const oauthAuthByScope = new Map<
    string,
    { generation: number; auth?: OAuthAuthState }
  >();
  interface OAuthBrowserLaunch {
    controller: ReturnType<typeof createHostAbortController>;
  }
  const oauthBrowserLaunchByScope = new Map<
    string,
    OAuthBrowserLaunch
  >();
  const oauthBrowserLaunches = new Set<Promise<boolean>>();
  let oauthBrowserLaunchesClosing = false;
  const cancelOAuthBrowserLaunch = (
    scope: OAuthProfileScope,
    reason: Error,
  ): void => {
    oauthBrowserLaunchByScope.get(oauthScopeKey(scope))?.controller.abort(reason);
  };
  const launchPendingOAuthBrowser = (
    scope: OAuthProfileScope,
    url: string,
    onFailure?: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> => {
    const open = dependencies.openOAuthAuthorizationUrl;
    if (!open || oauthBrowserLaunchesClosing) {
      return Promise.resolve(false);
    }
    cancelOAuthBrowserLaunch(
      scope,
      new Error(`${oauthProviderLabel(scope.provider)} OAuth browser launch was replaced.`),
    );
    const controller = createHostAbortController();
    let active!: OAuthBrowserLaunch;
    let launch!: Promise<boolean>;
    launch = Promise.resolve()
      .then(() => open(url, controller.signal))
      .then(
        () => true,
        async () => {
          if (!controller.signal.aborted && !oauthBrowserLaunchesClosing) {
            await onFailure?.(controller.signal);
          }
          return false;
        },
      )
      .catch(() => false)
      .finally(() => {
        oauthBrowserLaunches.delete(launch);
        const key = oauthScopeKey(scope);
        if (oauthBrowserLaunchByScope.get(key) === active) {
          oauthBrowserLaunchByScope.delete(key);
        }
      });
    active = { controller };
    oauthBrowserLaunchByScope.set(oauthScopeKey(scope), active);
    oauthBrowserLaunches.add(launch);
    return launch;
  };
  function cachedCatalog(profile: DraftProfile | SavedProfile, generation?: number) {
    const key = connectionFingerprint(profile);
    const ready = modelsByConnection.has(key) && (profile.connection.kind === "direct-api" ||
      oauthCatalogOwnershipByConnection.get(key)?.generation === generation);
    return { ready, models: ready ? modelsByConnection.get(key)! : [] };
  }

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
    const generation = await synchronizeAuthGeneration(
      oauthProfileScope(profile),
      signal,
    );
    return cachedCatalog(profile, generation);
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

  const clearOAuthCatalogs = (scope: OAuthProfileScope): void => {
    const expectedScopeKey = oauthScopeKey(scope);
    for (const [fingerprint, ownership] of oauthCatalogOwnershipByConnection) {
      if (ownership.scopeKey !== expectedScopeKey) continue;
      modelsByConnection.delete(fingerprint);
      modelCatalogLoadReceiptByConnection.delete(fingerprint);
      oauthCatalogOwnershipByConnection.delete(fingerprint);
    }
  };

  async function synchronizeAuthGeneration(
    scope: OAuthProfileScope,
    signal?: AbortSignal,
  ): Promise<number> {
    await waitForPromiseWithSignal(
      prepareOAuthCredentialStoreForSavedProfiles(storageDirectory),
      signal,
    );
    oauthScopesUsed.set(oauthScopeKey(scope), scope);
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    const scopeKey = oauthScopeKey(scope);
    for (;;) {
      throwIfAborted(signal);
      const generation = modelAuthSendFence.authGeneration(scope.provider);
      const cached = oauthAuthByScope.get(scopeKey);
      if (cached === undefined) {
        oauthAuthByScope.set(scopeKey, { generation });
        return generation;
      }
      if (generation === cached.generation) return generation;
      if (dependencies.modelBackendManager !== undefined) {
        try {
          await modelBackendManager.invalidateOAuth(
            scope.profileId,
            scope.provider,
          );
        } catch (error) {
          modelAuthSendFence.poison(error);
          throw error;
        }
        throwIfAborted(signal);
      }
      clearOAuthCatalogs(scope);
      oauthAuthByScope.set(scopeKey, { generation });
    }
  }

  function cacheOAuthAuth(
    scope: OAuthProfileScope,
    generation: number,
    auth?: OAuthAuthState,
  ): void {
    oauthAuthByScope.set(
      oauthScopeKey(scope),
      auth === undefined ? { generation } : { generation, auth },
    );
  }

  function recordOwnedAuthState(
    scope: OAuthProfileScope,
    auth: OAuthAuthState,
  ): void {
    if (auth.status !== "pending") {
      cancelOAuthBrowserLaunch(
        scope,
        new Error(
          `${oauthProviderLabel(scope.provider)} OAuth authorization settled.`,
        ),
      );
    }
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    modelAuthSendFence.updateAuthState(
      modelAuthOwner,
      scope.provider,
      auth.status,
      auth.status === "unavailable" && auth.definitive === true,
    );
    cacheOAuthAuth(
      scope,
      modelAuthSendFence.authGeneration(scope.provider),
      auth,
    );
    clearOAuthCatalogs(scope);
  }

  function recordOwnedAuthMutation(
    scope: OAuthProfileScope,
    auth: OAuthAuthState,
  ): void {
    if (auth.status !== "pending") {
      cancelOAuthBrowserLaunch(
        scope,
        new Error(
          `${oauthProviderLabel(scope.provider)} OAuth authorization changed.`,
        ),
      );
    }
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    modelAuthSendFence.updateAuthState(
      modelAuthOwner,
      scope.provider,
      auth.status,
      true,
    );
    cacheOAuthAuth(
      scope,
      modelAuthSendFence.authGeneration(scope.provider),
      auth.status === "unavailable" && auth.definitive !== true
        ? undefined
        : auth,
    );
    clearOAuthCatalogs(scope);
  }

  const reconcileSavedProfileOAuthLifecycle = async (
    profileId: string,
    provider: OAuthSubscriptionProvider | undefined,
  ): Promise<void> => {
    const modelAuthSendFence = modelAuthSendFenceFor(profileId);
    try {
      await modelBackendManager.invalidateOAuthProfile(profileId);
    } catch (error) {
      modelAuthSendFence.poison(error);
      throw error;
    }
    if (storageDirectory !== undefined) {
      if (provider === undefined) {
        await deleteOAuthCredentialProfile(storageDirectory, profileId);
      } else {
        await retainOAuthCredentialForProfileProvider(
          storageDirectory,
          profileId,
          provider,
        );
      }
    }
    const resetProviders = new Set(
      provider === undefined
        ? oauthSubscriptionProviders
        : oauthSubscriptionProviders.filter((candidate) => candidate !== provider),
    );
    for (const resetProvider of resetProviders) {
      const scope = { profileId, provider: resetProvider };
      cancelOAuthBrowserLaunch(
        scope,
        new Error(
          `${oauthProviderLabel(resetProvider)} Profile authorization retired.`,
        ),
      );
      recordOwnedAuthMutation(scope, { status: "signed-out" });
      oauthScopesUsed.delete(oauthScopeKey(scope));
    }
  };

  const oauthProviderForSavedProfile = (
    settings: AgentSettings,
    profileId: string,
  ): OAuthSubscriptionProvider | undefined => {
    const profile = settings.profiles.find((candidate) => candidate.id === profileId);
    return profile?.connection.kind === "oauth-subscription"
      ? profile.connection.provider
      : undefined;
  };

  const reconcileUnknownProfileOAuthLifecycle = async (
    profileId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    pendingProfileOAuthLifecycleReconciliation.add(profileId);
    try {
      await withRequestConfiguration(
        signal,
        async () => {
          const current = await loadAgentSettings(storageDirectory);
          await reconcileSavedProfileOAuthLifecycle(
            profileId,
            oauthProviderForSavedProfile(current, profileId),
          );
          pendingProfileOAuthLifecycleReconciliation.delete(profileId);
        },
      );
    } catch {
      // The unknown settings outcome remains pending for a later state read.
    }
  };

  const retryPendingProfileOAuthLifecycle = async (
    signal?: AbortSignal,
  ): Promise<void> => {
    let firstFailure: unknown;
    for (const profileId of [...pendingProfileOAuthLifecycleReconciliation]) {
      const fence = modelAuthSendFenceFor(profileId);
      let release: (() => void) | null = null;
      try {
        release = await fence.enterAuth(
          modelAuthOwner,
          fence.pendingLoginProvider() ?? "openai",
          signal,
          true,
        );
        if (!release) continue;
        await withRequestConfiguration(
          signal,
          async () => {
            const current = await loadAgentSettings(storageDirectory);
            await reconcileSavedProfileOAuthLifecycle(
              profileId,
              oauthProviderForSavedProfile(current, profileId),
            );
            pendingProfileOAuthLifecycleReconciliation.delete(profileId);
          },
        );
      } catch (error) {
        throwIfAborted(signal);
        firstFailure ??= error;
      } finally {
        release?.();
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  };

  const unavailableOAuthAuth = (
    provider: OAuthSubscriptionProvider,
    error?: unknown,
  ): OAuthAuthState => error instanceof NetworkProxyError
      ? {
        status: "unavailable",
        message: error.message,
        definitive: true,
      }
      : {
        status: "unavailable",
        message: `${oauthProviderLabel(provider)} OAuth session is unavailable.`,
      };

  const readOAuthAuth = async (
    scope: OAuthProfileScope,
    signal?: AbortSignal,
    options: OAuthAuthReadOptions = {},
  ): Promise<OAuthAuthState> => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    for (;;) {
      const generation = await synchronizeAuthGeneration(scope, signal);
      let auth: OAuthAuthState;
      try {
        const backend = await modelBackendManager.oauth(
          scope.profileId,
          scope.provider,
          signal,
        );
        throwIfAborted(signal);
        auth = await backend.readAuthState(signal, options);
      } catch (error) {
        throwIfAborted(signal);
        auth = unavailableOAuthAuth(scope.provider, error);
      }
      if (modelAuthSendFence.authGeneration(scope.provider) !== generation) continue;
      cacheOAuthAuth(scope, generation, auth);
      if (auth.status !== "pending") {
        cancelOAuthBrowserLaunch(
          scope,
          new Error(
            `${oauthProviderLabel(scope.provider)} OAuth authorization settled.`,
          ),
        );
      }
      return auth;
    }
  };

  const reconcilePendingOAuthAuthWhileReading = async (
    scope: OAuthProfileScope,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState | undefined> => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    if (!modelAuthSendFence.hasPendingLogin(scope.provider)) return undefined;
    const auth = await modelAuthSendFence.reconcilePendingAuthState(
      scope.provider,
      (reconciliationSignal) =>
        readOAuthAuth(scope, reconciliationSignal, { readiness: true }),
      signal,
    );
    if (auth === undefined) return undefined;
    const generation = await synchronizeAuthGeneration(scope, signal);
    cacheOAuthAuth(scope, generation, auth);
    return auth;
  };

  const withPendingOAuthAuthReconciliation = async <T>(
    scope: OAuthProfileScope,
    signal: AbortSignal | undefined,
    operation: (auth: OAuthAuthState) => Promise<T>,
  ): Promise<T | undefined> => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    if (!modelAuthSendFence.hasPendingLogin(scope.provider)) return undefined;
    const release = await modelAuthSendFence.enterRead(signal);
    try {
      const auth = await reconcilePendingOAuthAuthWhileReading(scope, signal);
      return auth === undefined ? undefined : await operation(auth);
    } finally {
      release();
    }
  };

  const runOAuthAuthOperation = async (
    scope: OAuthProfileScope,
    operation: "beginLogin" | "logout",
    signal: AbortSignal,
  ): Promise<OAuthAuthState> => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    if (operation === "logout") {
      cancelOAuthBrowserLaunch(
        scope,
        new Error(
          `${oauthProviderLabel(scope.provider)} sign-in was canceled.`,
        ),
      );
    }
    let mutationAttempted = false;
    let retireBackend: (() => Promise<boolean>) | undefined;
    let retirementPromise: Promise<void> | undefined;
    const confirmUnknownMutationRetirement = (): Promise<void> => {
      retirementPromise ??= (async () => {
        try {
          if (retireBackend) await retireBackend();
          else {
            await modelBackendManager.invalidateOAuth(
              scope.profileId,
              scope.provider,
            );
          }
        } catch (error) {
          modelAuthSendFence.poison(error);
          throw error;
        }
      })();
      return retirementPromise;
    };
    try {
      const lease = await modelBackendManager.oauthLease(
        scope.profileId,
        scope.provider,
        signal,
      );
      const backend = lease.backend;
      retireBackend = lease.retire;
      mutationAttempted = true;
      const invoke = backend[operation];
      const auth = await invoke.call(backend, signal);
      if (auth.status === "unavailable" && auth.definitive !== true) {
        await confirmUnknownMutationRetirement();
      }
      recordOwnedAuthMutation(scope, auth);
      return auth;
    } catch (error) {
      const auth = unavailableOAuthAuth(scope.provider, error);
      let retirementError: unknown;
      if (mutationAttempted) {
        try {
          await confirmUnknownMutationRetirement();
          recordOwnedAuthMutation(scope, auth);
        } catch (retirementFailure) {
          retirementError = retirementFailure;
        }
      } else {
        cacheOAuthAuth(
          scope,
          modelAuthSendFence.authGeneration(scope.provider),
          auth,
        );
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

  const withExclusiveOAuthAuth = async <T>(
    scope: OAuthProfileScope,
    operation: () => Promise<T>,
    signal: AbortSignal,
    allowPendingOwner = false,
  ): Promise<T> => {
    const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
    const release = await modelAuthSendFence.enterAuth(
      modelAuthOwner,
      scope.provider,
      signal,
      allowPendingOwner,
    );
    if (!release) {
      throw new ChatBridgeConflictError(
        modelAuthSendFence.hasPendingLogin()
          ? "Cancel or finish this Profile's pending sign-in before starting another account operation."
          : `Stop every active agent request before changing ${oauthProviderLabel(scope.provider)} sign-in for this Profile.`,
      );
    }
    try {
      await synchronizeAuthGeneration(scope, signal);
      return await operation();
    } finally {
      release();
    }
  };

  const setPendingOAuthBrowserLaunchFailed = async (
    scope: OAuthProfileScope,
    failed: boolean,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<Extract<OAuthAuthState, { status: "pending" }> | undefined> => {
    try {
      throwIfAborted(signal);
      const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
      if (
        !modelAuthSendFence.hasPendingLogin(scope.provider) ||
        modelAuthSendFence.authGeneration(scope.provider) !== expectedGeneration
      ) return;
      const lease = await modelBackendManager.oauthLease(
        scope.profileId,
        scope.provider,
        signal,
      );
      const auth = lease.backend.setPendingLoginBrowserLaunchFailed
        ? await lease.backend.setPendingLoginBrowserLaunchFailed(
          failed,
          signal,
        )
        : await lease.backend.readAuthState(signal);
      throwIfAborted(signal);
      if (
        auth.status === "pending" &&
        modelAuthSendFence.hasPendingLogin(scope.provider) &&
        modelAuthSendFence.authGeneration(scope.provider) === expectedGeneration
      ) {
        cacheOAuthAuth(scope, expectedGeneration, auth);
        notifyOAuthAuthStateChanged(scope, expectedGeneration, auth);
        return auth;
      }
    } catch {
      // Closing or a concurrent terminal auth result owns the final state.
    }
    return undefined;
  };

  const admitOAuthCatalog = (
    profile: DraftProfile | SavedProfile,
    models: DiscoveredModelInfo[],
    generation: number,
    signal: AbortSignal,
    changedMessage: string,
  ): DiscoveredModelInfo[] => {
    throwIfAborted(signal);
    const scope = oauthProfileScope(profile);
    if (modelAuthSendFenceFor(scope.profileId).authGeneration(scope.provider) !== generation) {
      throw new ChatBridgeConflictError(changedMessage);
    }
    const fingerprint = connectionFingerprint(profile);
    modelsByConnection.set(fingerprint, models);
    oauthCatalogOwnershipByConnection.set(fingerprint, { generation, scopeKey: oauthScopeKey(scope) });
    return models;
  };

  const acquireSessionModelRequester = async (
    session: AgentSession,
    settings: AgentSettings,
    signal: AbortSignal,
    activity: "sending" | "compacting",
  ): Promise<{
    runtimeProfile: RuntimeProfile;
    requestTurn: AgentModelTurnRequester;
    release(): void;
  }> => {
    const profile = requireActiveSavedProfile(settings);
    const modelSelection = effectiveSessionModelSelection(profile, session);
    let releaseModelAuthFence: (() => void) | undefined;
    let requestBackend: OAuthSubscriptionBackend | undefined;
    try {
      let models: DiscoveredModelInfo[];
      if (profile.connection.kind === "oauth-subscription") {
        const profileAuthScope = oauthProfileScope(profile);
        const modelAuthSendFence = modelAuthSendFenceFor(
          profileAuthScope.profileId,
        );
        releaseModelAuthFence = await modelAuthSendFence.enterOAuthUse(signal) ??
          undefined;
        if (!releaseModelAuthFence) {
          throw new ChatBridgeConflictError(
            `Wait for the ${oauthProviderLabel(profile.connection.provider)} sign-in operation to finish before ${activity}.`,
          );
        }
        const generation = await synchronizeAuthGeneration(
          profileAuthScope,
          signal,
        );
        const lease = await modelBackendManager.oauthLease(
          profileAuthScope.profileId,
          profileAuthScope.provider,
          signal,
        );
        const oauthBackend = lease.backend;
        requestBackend = oauthBackend;
        let auth: OAuthAuthState;
        try {
          auth = await oauthBackend.readAuthState(signal, { readiness: true });
        } catch (error) {
          throwIfAborted(signal);
          auth = unavailableOAuthAuth(profile.connection.provider, error);
        }
        cacheOAuthAuth(profileAuthScope, generation, auth);
        const authError = subscriptionSendAuthError(
          auth,
          profile.connection.provider,
        );
        if (authError) throw new ChatBridgeConflictError(authError);
        models = admitOAuthCatalog(profile, requireDiscoveredModelCatalog(await oauthBackend.listModels(profile, signal)), generation, signal,
          `${oauthProviderLabel(profile.connection.provider)} sign-in changed before the subscription request could start.`);
      } else {
        models = (await modelProjectionForProfile(profile, signal)).models;
      }
      if (
        profile.connection.kind === "oauth-subscription" &&
        !models.some((model) => model.id === modelSelection.model)
      ) {
        throw new ChatBridgeConflictError(
          `The selected subscription model is not available for the signed-in ${oauthProviderLabel(profile.connection.provider)} account. Choose an available model before ${activity}.`,
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
      const requestTurn: AgentModelTurnRequester = async (input) => {
        const backend = preflightBackendForFirstTurn ??
          await modelBackendManager.forProfile(profile, input.signal);
        preflightBackendForFirstTurn = undefined;
        try {
          return await requestTurnImplementation({
            ...input,
            turnExecutor: backend,
          });
        } finally {
          if (backend.kind === "direct-api") await backend.close();
        }
      };
      return {
        runtimeProfile,
        requestTurn,
        release() {
          releaseModelAuthFence?.();
          releaseModelAuthFence = undefined;
        },
      };
    } catch (error) {
      releaseModelAuthFence?.();
      throw error;
    }
  };

  async function withSubscriptionCapabilities<T>(
    profile: SavedProfile,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const profileAuthScope = oauthProfileScope(profile);
    const modelAuthSendFence = modelAuthSendFenceFor(profileAuthScope.profileId);
    const releaseOAuthLoad = await modelAuthSendFence.enterOAuthUse(signal);
    if (!releaseOAuthLoad) {
      throw new ChatBridgeConflictError(
        `Wait for the ${oauthProviderLabel(profileAuthScope.provider)} sign-in operation to finish before loading model capabilities.`,
      );
    }
    try {
      const generation = await synchronizeAuthGeneration(
        profileAuthScope,
        signal,
      );
      if (!cachedCatalog(profile, generation).ready) {
        const backend = await modelBackendManager.oauth(
          profileAuthScope.profileId,
          profileAuthScope.provider,
          signal,
        );
        const models = requireDiscoveredModelCatalog(
          await backend.listModels(profile, signal),
        );
        const auth = await backend.readAuthState(signal, { readiness: true });
        cacheOAuthAuth(profileAuthScope, generation, auth);
        const authError = subscriptionSendAuthError(
          auth,
          profileAuthScope.provider,
        );
        if (authError) throw new ChatBridgeConflictError(authError);
        admitOAuthCatalog(profile, models, generation, signal,
          `${oauthProviderLabel(profileAuthScope.provider)} sign-in changed before model capabilities finished loading.`);
      }

      return await operation();
    } finally {
      releaseOAuthLoad();
    }
  }
  async function discoverModels(profile: DraftProfile, commandId: string, signal: AbortSignal): Promise<DiscoveredModelInfo[]> {
    const profileAuthScope = profile.connection.kind === "oauth-subscription"
      ? oauthProfileScope(profile)
      : undefined;
    const releaseOAuthDiscovery = profile.connection.kind === "oauth-subscription"
      ? await modelAuthSendFenceFor(profile.id).enterOAuthUse(signal)
      : () => undefined;
    if (!releaseOAuthDiscovery) {
      throw new ChatBridgeConflictError(
        `Wait for the ${profile.connection.kind === "oauth-subscription" ? oauthProviderLabel(profile.connection.provider) : "provider"} sign-in operation to finish before loading models.`,
      );
    }
    try {
      const oauthGeneration = profileAuthScope
        ? await synchronizeAuthGeneration(profileAuthScope, signal)
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
      throwIfAborted(signal);
      const fingerprint = connectionFingerprint(profile);
      if (profile.connection.kind === "oauth-subscription") {
        admitOAuthCatalog(profile, discovered, oauthGeneration!, signal,
          `${oauthProviderLabel(profile.connection.provider)} sign-in changed before model discovery finished.`);
      } else modelsByConnection.set(fingerprint, discovered);
      modelCatalogLoadReceiptByConnection.set(fingerprint, commandId);
      return discovered;
    } finally {
      releaseOAuthDiscovery();
    }
  }
  async function runAccountCommand(commandInput: OAuthAccountCommand, signal: AbortSignal) {
    let status: string | undefined;
    switch (commandInput.kind) {
      case "start_oauth_login": {
        const provider = commandInput.provider;
        const scope = { profileId: commandInput.profileId, provider };
        let resultAuth!: OAuthAuthState;
        await withExclusiveOAuthAuth(scope, async () => {
          const auth = await runOAuthAuthOperation(scope, "beginLogin", signal);
          resultAuth = auth;
          if (resultAuth.status === "pending") {
            const verificationUrl = resultAuth.verificationUrl;
            const generation = modelAuthSendFenceFor(scope.profileId)
              .authGeneration(provider);
            void launchPendingOAuthBrowser(
              scope,
              verificationUrl,
              async (launchSignal) => {
                const failedAuth = await setPendingOAuthBrowserLaunchFailed(
                  scope,
                  true,
                  generation,
                  launchSignal,
                );
                if (failedAuth) resultAuth = failedAuth;
              },
            );
          }
          status = oauthAuthStatusMessage(resultAuth, provider);
        }, signal);
        // Browser launch may settle while the caller assembles its command state.
        return { scope, get auth() { return resultAuth; }, status: status! };
      }
      case "submit_oauth_authorization_code": {
        const scope = {
          profileId: commandInput.profileId,
          provider: commandInput.provider,
        };
        let resultAuth!: OAuthAuthState;
        await withExclusiveOAuthAuth(scope, async () => {
          const lease = await modelBackendManager.oauthLease(
            scope.profileId,
            scope.provider,
            signal,
          );
          if (!lease.backend.submitLoginCode) {
            throw new Error("Antigravity sign-in cannot accept an authorization code.");
          }
          cancelOAuthBrowserLaunch(
            scope,
            new Error("Antigravity authorization code was submitted."),
          );
          resultAuth = await lease.backend.submitLoginCode(
            commandInput.authorizationCode,
            signal,
          );
          recordOwnedAuthMutation(scope, resultAuth);
          notifyOAuthAuthStateChanged(scope,
            modelAuthSendFenceFor(scope.profileId).authGeneration(scope.provider), resultAuth);
          status = "Antigravity authorization code submitted.";
        }, signal, true);
        return { scope, auth: resultAuth, status: status! };
      }
      case "open_oauth_authorization": {
        const provider = commandInput.provider;
        const scope = { profileId: commandInput.profileId, provider };
        let resultAuth!: OAuthAuthState;
        await withExclusiveOAuthAuth(scope, async () => {
          const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
          const pendingBeforeRead = modelAuthSendFence.hasPendingLogin(provider);
          const lease = await modelBackendManager.oauthLease(
            scope.profileId,
            scope.provider,
            signal,
          );
          try {
            resultAuth = await lease.backend.readAuthState(signal, {
              readiness: true,
            });
          } catch (error) {
            throwIfAborted(signal);
            resultAuth = unavailableOAuthAuth(scope.provider, error);
          }
          if (resultAuth.status !== "pending") {
            if (pendingBeforeRead) recordOwnedAuthState(scope, resultAuth);
            else {
              cacheOAuthAuth(
                scope,
                modelAuthSendFence.authGeneration(provider),
                resultAuth,
              );
            }
          }
          const verificationUrl = resultAuth.status === "pending"
            ? resultAuth.verificationUrl
            : resultAuth.status === "unavailable"
              ? resultAuth.verificationUrl
              : undefined;
          if (!verificationUrl) {
            status = oauthAuthStatusMessage(resultAuth, provider);
            return;
          }
          if (!(await launchPendingOAuthBrowser(scope, verificationUrl))) {
            if (
              resultAuth.status === "pending" &&
              lease.backend.setPendingLoginBrowserLaunchFailed
            ) {
              resultAuth = await lease.backend.setPendingLoginBrowserLaunchFailed(
                true,
                signal,
              );
              cacheOAuthAuth(
                scope,
                modelAuthSendFence.authGeneration(provider),
                resultAuth,
              );
              notifyOAuthAuthStateChanged(
                scope,
                modelAuthSendFence.authGeneration(provider),
                resultAuth,
              );
            }
            throw new Error(
              "Live Smith could not open the system browser. Copy the account link and open it in a browser, then check sign-in again.",
            );
          }
          throwIfAborted(signal);
          if (
            resultAuth.status === "pending" &&
            resultAuth.browserLaunchFailed &&
            lease.backend.setPendingLoginBrowserLaunchFailed
          ) {
            resultAuth = await lease.backend.setPendingLoginBrowserLaunchFailed(
              false,
              signal,
            );
            cacheOAuthAuth(
              scope,
              modelAuthSendFence.authGeneration(provider),
              resultAuth,
            );
            notifyOAuthAuthStateChanged(
              scope,
              modelAuthSendFence.authGeneration(provider),
              resultAuth,
            );
          }
          status = `Opened the ${oauthProviderLabel(provider)} account page.`;
        }, signal, true);
        return { scope, auth: resultAuth, status: status! };
      }
      case "logout_oauth": {
        const provider = commandInput.provider;
        const scope = { profileId: commandInput.profileId, provider };
        let resultAuth!: OAuthAuthState;
        await withExclusiveOAuthAuth(scope, async () => {
          const auth = await runOAuthAuthOperation(scope, "logout", signal);
          resultAuth = auth;
          status = oauthAuthStatusMessage(auth, provider);
        }, signal, true);
        return { scope, auth: resultAuth, status: status! };
      }
    }
  }

  async function refreshAccount(scope: OAuthProfileScope, signal: AbortSignal): Promise<OAuthAuthState> {
    return withExclusiveOAuthAuth(scope, async () => {
      cacheOAuthAuth(scope, modelAuthSendFenceFor(scope.profileId).authGeneration(scope.provider));
      const auth = await readOAuthAuth(scope, signal, { readiness: true });
      recordOwnedAuthState(scope, auth);
      return auth;
    }, signal);
  }

  async function stopBrowserLaunches(): Promise<void> {
    oauthBrowserLaunchesClosing = true;
    for (const launch of oauthBrowserLaunchByScope.values()) {
      launch.controller.abort(new Error("Live Smith closed before the OAuth browser finished opening."));
    }
    await Promise.allSettled([...oauthBrowserLaunches]);
    modelBackendManager.stopAcquisition();
  }
  async function close(): Promise<void> {
    let backendCleanupError: unknown;
    const discardedOAuthProfiles = new Set<string>();
    try {
      const settings = await loadAgentSettings(storageDirectory);
      for (const scope of oauthScopesUsed.values()) {
        if (
          oauthProviderForSavedProfile(settings, scope.profileId) !==
          scope.provider
        ) discardedOAuthProfiles.add(scope.profileId);
      }
    } catch {
      for (const scope of oauthScopesUsed.values()) {
        discardedOAuthProfiles.add(scope.profileId);
      }
    }
    if (
      oauthScopesUsed.size > 0 &&
      modelBackendManager.hasAcquiredOAuth()
    ) {
      const scopes = [...oauthScopesUsed.values()].filter(
        (scope) => !discardedOAuthProfiles.has(scope.profileId),
      );
      const cleanupResults = await Promise.allSettled(
        scopes.map(async (scope) => {
          const modelAuthSendFence = modelAuthSendFenceFor(scope.profileId);
          const releasePendingCleanup = await modelAuthSendFence
            .enterPendingOwnerCleanup(modelAuthOwner, scope.provider);
          if (releasePendingCleanup) try {
            await modelBackendManager.invalidateOAuth(
              scope.profileId,
              scope.provider,
            );
          } finally {
            releasePendingCleanup();
          }
        }),
      );
      for (const [index, result] of cleanupResults.entries()) {
        if (result.status === "fulfilled") continue;
        const scope = scopes[index]!;
        modelAuthSendFenceFor(scope.profileId).poison(result.reason);
        backendCleanupError ??= result.reason;
      }
    }
    for (const profileId of discardedOAuthProfiles) {
      pendingProfileOAuthLifecycleReconciliation.add(profileId);
    }
    if (discardedOAuthProfiles.size > 0) {
      try {
        await retryPendingProfileOAuthLifecycle();
      } catch (error) {
        backendCleanupError ??= error;
      }
    }
    for (const scope of oauthScopesUsed.values()) {
      modelAuthSendFenceFor(scope.profileId).releaseOwner(modelAuthOwner);
    }
    try {
      await modelBackendManager.close();
    } catch (error) {
      for (const scope of oauthScopesUsed.values()) {
        modelAuthSendFenceFor(scope.profileId).poison(error);
      }
      backendCleanupError ??= error;
    }
    if (backendCleanupError !== undefined) throw backendCleanupError;
  }
  return {
    modelProjectionForProfile, synchronizeAuthGeneration, readOAuthAuth,
    reconcilePendingOAuthAuthWhileReading, withPendingOAuthAuthReconciliation,
    runAccountCommand, refreshAccount,
    reconcileSavedProfileOAuthLifecycle, reconcileUnknownProfileOAuthLifecycle,
    retryPendingProfileOAuthLifecycle, oauthProviderForSavedProfile,
    acquireSessionModelRequester, discoverModels, withSubscriptionCapabilities,
    stopBrowserLaunches, close,
    authProjection(scope: OAuthProfileScope) { return oauthAuthByScope.get(oauthScopeKey(scope)); },
    catalogReceipt(profile: DraftProfile | SavedProfile) { return modelCatalogLoadReceiptByConnection.get(connectionFingerprint(profile)); },
    cachedCatalog,
    invalidateDirectCatalog(profile: SavedProfile) { modelsByConnection.delete(connectionFingerprint(profile)); },
    clearCatalogs() { modelsByConnection.clear(); modelCatalogLoadReceiptByConnection.clear(); },
    hasUsedOAuth(profileId: string, provider?: OAuthSubscriptionProvider) {
      return [...oauthScopesUsed.values()].some((scope) => scope.profileId === profileId &&
        (provider === undefined || scope.provider === provider));
    },
    hasPendingCleanup(profileId?: string) {
      return profileId === undefined ? pendingProfileOAuthLifecycleReconciliation.size > 0 : pendingProfileOAuthLifecycleReconciliation.has(profileId);
    },
    markPendingCleanup(profileId: string) { pendingProfileOAuthLifecycleReconciliation.add(profileId); },
    clearPendingCleanup(profileId: string) { pendingProfileOAuthLifecycleReconciliation.delete(profileId); },
    enterProfileMutation(profileId: string, provider: OAuthSubscriptionProvider, signal: AbortSignal) {
      return modelAuthSendFenceFor(profileId).enterAuth(modelAuthOwner, provider, signal, true);
    },
  };
}

export function oauthAuthStatusMessage(
  state: OAuthAuthState,
  provider: OAuthSubscriptionProvider,
): string {
  const label = oauthProviderLabel(provider);
  switch (state.status) {
    case "unavailable":
      return state.message;
    case "signed-out":
      return `Signed out of ${label}.`;
    case "pending":
      if (state.browserLaunchFailed) {
        return `Live Smith could not open the ${label} sign-in page in the system browser. Retry the account link below or copy it into a browser.`;
      }
      if (state.authorizationCodeInput) {
        return `Complete ${label} sign-in in your browser, then paste the authorization code below.`;
      }
      return `Complete ${label} sign-in in your browser, then check again. ` +
        "If the browser did not open, use the sign-in link below.";
    case "signed-in":
      return state.subscriptionEligible
        ? `Signed in with ${label}.`
        : `This ${label} account is not eligible for subscription requests.`;
  }
}

function subscriptionSendAuthError(
  state: OAuthAuthState,
  provider: OAuthSubscriptionProvider,
): string | undefined {
  const label = oauthProviderLabel(provider);
  switch (state.status) {
    case "signed-in":
      return state.subscriptionEligible
        ? undefined
        : `This ${label} account is not eligible for subscription requests.`;
    case "pending":
      return `Complete ${label} sign-in before sending a subscription request.`;
    case "signed-out":
      return `Sign in to ${label} before sending a subscription request.`;
    case "unavailable":
      return state.message;
  }
}

export function oauthProviderLabel(provider: OAuthSubscriptionProvider): string {
  switch (provider) {
    case "openai":
      return "ChatGPT";
    case "anthropic":
      return "Claude";
    case "google":
      return "Antigravity";
  }
}
