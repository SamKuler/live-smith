import type { OAuthAuthState } from "../model/provider.js";
import {
  isProfileId,
  type OAuthSubscriptionProvider,
} from "../model/profile.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";
import {
  storageScopeKey,
  type StorageScopeKey,
} from "../storage/scope.js";

type OAuthAuthStatus = "unavailable" | "signed-out" | "pending" | "signed-in";

export interface ModelAuthSendFence {
  enterRead(signal?: AbortSignal): Promise<() => void>;
  /** Admit one OAuth subscription discovery or send; Direct API bypasses it. */
  enterOAuthUse(signal?: AbortSignal): Promise<(() => void) | null>;
  enterAuth(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
    allowPendingOwner?: boolean,
  ): Promise<(() => void) | null>;
  enterPendingOwnerCleanup(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<(() => void) | null>;
  hasPendingLogin(provider?: OAuthSubscriptionProvider): boolean;
  pendingLoginProvider(): OAuthSubscriptionProvider | undefined;
  hasAuthActivity(provider: OAuthSubscriptionProvider): boolean;
  reconcilePendingAuthState(
    provider: OAuthSubscriptionProvider,
    readAuthState: (signal: AbortSignal) => Promise<OAuthAuthState>,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState | undefined>;
  updateAuthState(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    status: OAuthAuthStatus,
    mutationAttempted?: boolean,
  ): void;
  /** Read the credential-free epoch for UI projection without admitting OAuth use. */
  peekAuthGeneration(provider: OAuthSubscriptionProvider): number;
  authGeneration(provider: OAuthSubscriptionProvider): number;
  poison(cause: unknown): void;
  releaseOwner(owner: symbol): void;
}

interface ActiveAuthMutation {
  readonly owner: symbol;
  readonly settled: Promise<void>;
  settle(): void;
}

interface PendingAuthReconciliation {
  readonly controller: ReturnType<typeof createHostAbortController>;
  readonly settled: Promise<OAuthAuthState>;
}

interface PendingLoginOwner {
  readonly owner: symbol;
  readonly provider: OAuthSubscriptionProvider;
}

class ProcessModelAuthSendFence implements ModelAuthSendFence {
  private activeOperations = 0;
  private authMutation: ActiveAuthMutation | null = null;
  private pendingLoginOwner: PendingLoginOwner | null = null;
  private pendingAuthReconciliation: PendingAuthReconciliation | null = null;
  private readonly generations = new Map<OAuthSubscriptionProvider, number>();
  private readonly authActivity = new Set<OAuthSubscriptionProvider>();
  private poisonError: Error | undefined;
  private readonly stateChangeWaiters = new Set<() => void>();

  async enterRead(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      throwIfAborted(signal);
      this.assertHealthy();
      const mutation = this.authMutation;
      if (mutation) {
        await waitForPromiseWithSignal(mutation.settled, signal);
        continue;
      }
      this.activeOperations += 1;
      return once(() => {
        this.activeOperations -= 1;
        this.signalStateChange();
      });
    }
  }

  async enterOAuthUse(signal?: AbortSignal): Promise<(() => void) | null> {
    for (;;) {
      throwIfAborted(signal);
      this.assertHealthy();
      const mutation = this.authMutation;
      if (mutation) {
        await waitForPromiseWithSignal(mutation.settled, signal);
        continue;
      }
      if (this.pendingLoginOwner || this.pendingAuthReconciliation) return null;
      this.activeOperations += 1;
      return once(() => {
        this.activeOperations -= 1;
        this.signalStateChange();
      });
    }
  }

  async enterAuth(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
    allowPendingOwner = false,
  ): Promise<(() => void) | null> {
    for (;;) {
      throwIfAborted(signal);
      this.assertHealthy();
      const activeMutation = this.authMutation;
      if (activeMutation) {
        await waitForPromiseWithSignal(activeMutation.settled, signal);
        continue;
      }
      if (this.pendingAuthReconciliation) {
        await this.waitForStateChange(signal);
        continue;
      }
      if (
        this.activeOperations > 0 ||
        this.pendingLoginOwner &&
          (
            this.pendingLoginOwner.owner !== owner ||
            this.pendingLoginOwner.provider !== provider ||
            !allowPendingOwner
          )
      ) return null;

      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const mutation = { owner, settled, settle };
      this.authMutation = mutation;
      return once(() => {
        if (this.authMutation !== mutation) return;
        this.authMutation = null;
        mutation.settle();
        this.signalStateChange();
      });
    }
  }

  async enterPendingOwnerCleanup(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<(() => void) | null> {
    for (;;) {
      throwIfAborted(signal);
      this.assertHealthy();
      if (
        this.pendingLoginOwner?.owner !== owner ||
        this.pendingLoginOwner.provider !== provider
      ) return null;
      const activeMutation = this.authMutation;
      if (activeMutation) {
        await waitForPromiseWithSignal(activeMutation.settled, signal);
        continue;
      }
      if (this.pendingAuthReconciliation) {
        this.pendingAuthReconciliation.controller.abort(
          new Error("The OAuth sign-in owner closed."),
        );
        await this.waitForStateChange(signal);
        continue;
      }
      if (this.activeOperations > 0) {
        await this.waitForStateChange(signal);
        continue;
      }

      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const mutation = { owner, settled, settle };
      this.authMutation = mutation;
      return once(() => {
        if (this.authMutation !== mutation) return;
        this.authMutation = null;
        mutation.settle();
        this.signalStateChange();
      });
    }
  }

  hasPendingLogin(provider?: OAuthSubscriptionProvider): boolean {
    return this.pendingLoginOwner !== null &&
      (provider === undefined || this.pendingLoginOwner.provider === provider);
  }

  pendingLoginProvider(): OAuthSubscriptionProvider | undefined {
    return this.pendingLoginOwner?.provider;
  }

  hasAuthActivity(provider: OAuthSubscriptionProvider): boolean {
    return this.authActivity.has(provider);
  }

  async reconcilePendingAuthState(
    provider: OAuthSubscriptionProvider,
    readAuthState: (signal: AbortSignal) => Promise<OAuthAuthState>,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState | undefined> {
    throwIfAborted(signal);
    this.assertHealthy();
    if (this.pendingLoginOwner?.provider !== provider) return undefined;
    if (this.authMutation || this.activeOperations === 0) {
      throw new Error(
        "Pending OAuth sign-in reconciliation requires a shared auth read.",
      );
    }
    if (this.pendingAuthReconciliation === null) {
      const controller = createHostAbortController();
      this.pendingAuthReconciliation = {
        controller,
        settled: this.performPendingAuthReconciliation(
          provider,
          readAuthState,
          controller.signal,
        ),
      };
    }
    return waitForPromiseWithSignal(
      this.pendingAuthReconciliation.settled,
      signal,
    );
  }

  private async performPendingAuthReconciliation(
    provider: OAuthSubscriptionProvider,
    readAuthState: (signal: AbortSignal) => Promise<OAuthAuthState>,
    signal: AbortSignal,
  ): Promise<OAuthAuthState> {
    try {
      const auth = await readAuthState(signal);
      throwIfAborted(signal);
      this.assertHealthy();
      if (
        this.pendingLoginOwner?.provider === provider &&
        auth.status !== "pending" &&
        (auth.status !== "unavailable" || auth.definitive === true)
      ) {
        this.pendingLoginOwner = null;
        this.incrementGeneration(provider);
      }
      return auth;
    } finally {
      this.pendingAuthReconciliation = null;
      this.signalStateChange();
    }
  }

  updateAuthState(
    owner: symbol,
    provider: OAuthSubscriptionProvider,
    status: OAuthAuthStatus,
    mutationAttempted = false,
  ): void {
    this.assertHealthy();
    if (status === "unavailable" && !mutationAttempted) return;
    if (status === "pending") {
      this.pendingLoginOwner = { owner, provider };
    } else if (
      this.pendingLoginOwner?.owner === owner &&
      this.pendingLoginOwner.provider === provider
    ) {
      this.pendingLoginOwner = null;
    }
    if (status === "signed-out") this.authActivity.delete(provider);
    else this.authActivity.add(provider);
    this.incrementGeneration(provider);
    this.signalStateChange();
  }

  peekAuthGeneration(provider: OAuthSubscriptionProvider): number {
    return this.generations.get(provider) ?? 0;
  }

  authGeneration(provider: OAuthSubscriptionProvider): number {
    this.assertHealthy();
    return this.peekAuthGeneration(provider);
  }

  poison(cause: unknown): void {
    if (this.poisonError) return;
    this.poisonError = new Error(
      "The shared OAuth subscription backend could not be shut down safely. Restart the Live Smith extension before continuing.",
      { cause },
    );
    this.pendingAuthReconciliation?.controller.abort(this.poisonError);
    this.authMutation?.settle();
    this.signalStateChange();
  }

  releaseOwner(owner: symbol): void {
    const mutation = this.authMutation;
    if (mutation?.owner === owner) {
      this.authMutation = null;
      mutation.settle();
    }
    if (this.pendingLoginOwner?.owner === owner) {
      const provider = this.pendingLoginOwner.provider;
      this.pendingAuthReconciliation?.controller.abort(
        new Error("The OAuth sign-in owner closed."),
      );
      this.pendingLoginOwner = null;
      this.incrementGeneration(provider);
    }
    this.signalStateChange();
  }

  private waitForStateChange(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      const cleanup = (): void => {
        this.stateChangeWaiters.delete(settle);
        signal?.removeEventListener("abort", onAbort);
      };
      this.stateChangeWaiters.add(settle);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private signalStateChange(): void {
    for (const waiter of [...this.stateChangeWaiters]) waiter();
  }

  private incrementGeneration(provider: OAuthSubscriptionProvider): void {
    this.generations.set(provider, this.peekAuthGeneration(provider) + 1);
  }

  private assertHealthy(): void {
    if (this.poisonError) throw this.poisonError;
  }
}

const fencesByStorageDirectory = new Map<
  StorageScopeKey,
  Map<string, ModelAuthSendFence>
>();

export function modelAuthSendFenceForStorage(
  storageDirectory: string | undefined,
  profileId: string,
): ModelAuthSendFence {
  if (!isProfileId(profileId)) {
    throw new TypeError("A valid OAuth Profile ID is required.");
  }
  if (storageDirectory === undefined) return new ProcessModelAuthSendFence();
  const key = storageScopeKey(storageDirectory);
  let profileFences = fencesByStorageDirectory.get(key);
  if (!profileFences) {
    profileFences = new Map();
    fencesByStorageDirectory.set(key, profileFences);
  }
  let fence = profileFences.get(profileId);
  if (!fence) {
    fence = new ProcessModelAuthSendFence();
    profileFences.set(profileId, fence);
  }
  return fence;
}

function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
