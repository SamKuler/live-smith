import { createDirectApiBackend, type ModelBackendManager } from "../../model/backend-registry.js";
import type { DraftProfile, OAuthSubscriptionProvider, SavedProfile } from "../../model/profile.js";
import {
  acquireSharedModelBackendManager,
  type SharedModelBackendManagerLease,
} from "../../model/shared-backend-manager.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import { providerFetchForStorage } from "../network.js";

export const oauthSubscriptionProviders: readonly OAuthSubscriptionProvider[] = ["openai", "anthropic", "google"];

export interface DialogModelBackendDependencies {
  /** Test-only manager; production creates Direct backends per use and shares OAuth. */
  modelBackendManager?: Pick<ModelBackendManager, "forProfile" | "oauth" | "oauthLease" | "invalidateOAuth" | "close">;
  /** Test-only shared-manager acquisition; production uses the process-wide registry. */
  acquireSharedModelBackendManager?: typeof acquireSharedModelBackendManager;
}

/** Owns a dialog's lazy shared OAuth lease and its cancellable acquisition. */
export function createDialogModelBackends(
  storageDirectory: string | undefined,
  dependencies: DialogModelBackendDependencies = {},
) {
  const providerFetch = providerFetchForStorage(storageDirectory);
  let sharedBackendManagerLeasePromise:
    | Promise<SharedModelBackendManagerLease>
    | undefined;
  let sharedBackendManagerLease: SharedModelBackendManagerLease | undefined;
  let sharedBackendManagerAcquisitionController:
    | ReturnType<typeof createHostAbortController>
    | undefined;
  const oauthBackendAcquisitionClosedError = new Error(
    "The OAuth model backend acquisition was closed.",
  );
  let oauthBackendLeaseClosing = false;
  const oauthBackendManager = async (signal?: AbortSignal) => {
    if (dependencies.modelBackendManager) return dependencies.modelBackendManager;
    throwIfAborted(signal);
    if (
      sharedBackendManagerLeasePromise === undefined &&
      oauthBackendLeaseClosing
    ) {
      throw new Error("The OAuth model backend is closing.");
    }
    if (sharedBackendManagerLeasePromise === undefined) {
      sharedBackendManagerAcquisitionController = createHostAbortController();
      const acquireSharedManager =
        dependencies.acquireSharedModelBackendManager ??
        acquireSharedModelBackendManager;
      sharedBackendManagerLeasePromise = acquireSharedManager(
        storageDirectory,
        { fetchImpl: providerFetch },
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
  const manager = {
    async forProfile(
      profile: DraftProfile | SavedProfile,
      signal?: AbortSignal,
    ) {
      if (
        profile.connection.kind === "direct-api" &&
        dependencies.modelBackendManager === undefined
      ) {
        return createDirectApiBackend(profile, { fetchImpl: providerFetch });
      }
      return (await oauthBackendManager(signal)).forProfile(profile, signal);
    },
    async oauth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      signal?: AbortSignal,
    ) {
      return (await oauthBackendManager(signal)).oauth(
        profileId,
        provider,
        signal,
      );
    },
    async oauthLease(
      profileId: string,
      provider: OAuthSubscriptionProvider,
      signal?: AbortSignal,
    ) {
      return (await oauthBackendManager(signal)).oauthLease(
        profileId,
        provider,
        signal,
      );
    },
    async invalidateOAuth(
      profileId: string,
      provider: OAuthSubscriptionProvider,
    ) {
      return (await oauthBackendManager()).invalidateOAuth(profileId, provider);
    },
    async invalidateOAuthProfile(profileId: string) {
      const manager = await oauthBackendManager();
      if (dependencies.modelBackendManager === undefined) {
        return (manager as ModelBackendManager).invalidateOAuthProfile(profileId);
      }
      const results = await Promise.allSettled(
        oauthSubscriptionProviders.map((provider) =>
          manager.invalidateOAuth(profileId, provider)
        ),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    },
  };
  return {
    ...manager,
    hasAcquiredOAuth(): boolean {
      return dependencies.modelBackendManager !== undefined || sharedBackendManagerLease !== undefined;
    },
    // Bridge shutdown precedes auth cleanup and release of any acquired lease.
    stopAcquisition(): void {
      oauthBackendLeaseClosing = true;
      sharedBackendManagerAcquisitionController?.abort(oauthBackendAcquisitionClosedError);
    },
    async close(): Promise<void> {
      if (dependencies.modelBackendManager) {
        await dependencies.modelBackendManager.close();
      } else if (sharedBackendManagerLeasePromise) {
        try {
          await sharedBackendManagerLeasePromise;
        } catch (error) {
          if (error !== oauthBackendAcquisitionClosedError) throw error;
        }
        await sharedBackendManagerLease?.release();
      }
    },
  };
}
