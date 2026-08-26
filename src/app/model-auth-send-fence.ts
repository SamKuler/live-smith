import type { ManagedAuthState } from "../model/provider.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";
import {
  storageScopeKey,
  type StorageScopeKey,
} from "../storage/scope.js";

type ManagedAuthStatus = "unavailable" | "signed-out" | "pending" | "signed-in";

export interface ModelAuthSendFence {
  enterRead(signal?: AbortSignal): Promise<() => void>;
  /** Admit one managed subscription discovery or send; Direct API bypasses it. */
  enterManagedUse(signal?: AbortSignal): Promise<(() => void) | null>;
  enterAuth(owner: symbol, signal?: AbortSignal): Promise<(() => void) | null>;
  enterPendingOwnerCleanup(
    owner: symbol,
    signal?: AbortSignal,
  ): Promise<(() => void) | null>;
  hasPendingLogin(): boolean;
  reconcilePendingAuthState(
    readAuthState: (signal: AbortSignal) => Promise<ManagedAuthState>,
    signal?: AbortSignal,
  ): Promise<ManagedAuthState | undefined>;
  updateAuthState(
    owner: symbol,
    status: ManagedAuthStatus,
    mutationAttempted?: boolean,
  ): void;
  /** Read the credential-free epoch for UI projection without admitting managed use. */
  peekAuthGeneration(): number;
  authGeneration(): number;
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
  readonly settled: Promise<ManagedAuthState>;
}

class ProcessModelAuthSendFence implements ModelAuthSendFence {
  private activeOperations = 0;
  private authMutation: ActiveAuthMutation | null = null;
  private pendingLoginOwner: symbol | null = null;
  private pendingAuthReconciliation: PendingAuthReconciliation | null = null;
  private generation = 0;
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

  async enterManagedUse(signal?: AbortSignal): Promise<(() => void) | null> {
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
    signal?: AbortSignal,
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
        (this.pendingLoginOwner && this.pendingLoginOwner !== owner)
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
    signal?: AbortSignal,
  ): Promise<(() => void) | null> {
    for (;;) {
      throwIfAborted(signal);
      this.assertHealthy();
      if (this.pendingLoginOwner !== owner) return null;
      const activeMutation = this.authMutation;
      if (activeMutation) {
        await waitForPromiseWithSignal(activeMutation.settled, signal);
        continue;
      }
      if (this.pendingAuthReconciliation) {
        this.pendingAuthReconciliation.controller.abort(
          new Error("The ChatGPT sign-in owner closed."),
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

  hasPendingLogin(): boolean {
    return this.pendingLoginOwner !== null;
  }

  async reconcilePendingAuthState(
    readAuthState: (signal: AbortSignal) => Promise<ManagedAuthState>,
    signal?: AbortSignal,
  ): Promise<ManagedAuthState | undefined> {
    throwIfAborted(signal);
    this.assertHealthy();
    if (this.pendingLoginOwner === null) return undefined;
    if (this.authMutation || this.activeOperations === 0) {
      throw new Error(
        "Pending ChatGPT sign-in reconciliation requires a shared auth read.",
      );
    }
    if (this.pendingAuthReconciliation === null) {
      const controller = createHostAbortController();
      this.pendingAuthReconciliation = {
        controller,
        settled: this.performPendingAuthReconciliation(
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
    readAuthState: (signal: AbortSignal) => Promise<ManagedAuthState>,
    signal: AbortSignal,
  ): Promise<ManagedAuthState> {
    try {
      const auth = await readAuthState(signal);
      throwIfAborted(signal);
      this.assertHealthy();
      if (
        this.pendingLoginOwner !== null &&
        auth.status !== "pending" &&
        (auth.status !== "unavailable" || auth.definitive === true)
      ) {
        this.pendingLoginOwner = null;
        this.generation += 1;
      }
      return auth;
    } finally {
      this.pendingAuthReconciliation = null;
      this.signalStateChange();
    }
  }

  updateAuthState(
    owner: symbol,
    status: ManagedAuthStatus,
    mutationAttempted = false,
  ): void {
    this.assertHealthy();
    if (status === "unavailable" && !mutationAttempted) return;
    if (status === "pending") {
      this.pendingLoginOwner = owner;
    } else if (this.pendingLoginOwner === owner) {
      this.pendingLoginOwner = null;
    }
    this.generation += 1;
    this.signalStateChange();
  }

  peekAuthGeneration(): number {
    return this.generation;
  }

  authGeneration(): number {
    this.assertHealthy();
    return this.generation;
  }

  poison(cause: unknown): void {
    if (this.poisonError) return;
    this.poisonError = new Error(
      "The shared ChatGPT subscription runtime could not be shut down safely. Restart the Live Smith extension before continuing.",
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
    if (this.pendingLoginOwner === owner) {
      this.pendingAuthReconciliation?.controller.abort(
        new Error("The ChatGPT sign-in owner closed."),
      );
      this.pendingLoginOwner = null;
      this.generation += 1;
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

  private assertHealthy(): void {
    if (this.poisonError) throw this.poisonError;
  }
}

const fencesByStorageDirectory = new Map<StorageScopeKey, ModelAuthSendFence>();

export function modelAuthSendFenceForStorage(
  storageDirectory: string | undefined,
): ModelAuthSendFence {
  if (storageDirectory === undefined) return new ProcessModelAuthSendFence();
  const key = storageScopeKey(storageDirectory);
  let fence = fencesByStorageDirectory.get(key);
  if (!fence) {
    fence = new ProcessModelAuthSendFence();
    fencesByStorageDirectory.set(key, fence);
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
