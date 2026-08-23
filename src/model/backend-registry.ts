import {
  ModelBackendShutdownError,
  type CodexSubscriptionBackend,
  type DirectApiBackend,
  type ModelBackend,
  type TransportFactoryOptions,
} from "./provider.js";
import type { DraftProfile, SavedProfile } from "./profile.js";
import { transportForProfile } from "./registry.js";
import {
  startCodexAppServerBackend,
} from "./backends/codex-app-server.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";

export interface ModelBackendManagerOptions extends TransportFactoryOptions {
  startCodexBackend?: (
    storageDirectory: string,
    signal: AbortSignal,
  ) => Promise<CodexSubscriptionBackend>;
  onPoison?(error: Error): void;
}

export async function createDirectApiBackend(
  profile: DraftProfile | SavedProfile,
  options: TransportFactoryOptions = {},
): Promise<DirectApiBackend> {
  if (profile.connection.kind !== "direct-api") {
    throw new TypeError("A Direct API Profile is required.");
  }
  const transport = transportForProfile(profile, options);
  return {
    ...transport,
    kind: "direct-api",
    async close() {},
  };
}

export class ModelBackendManager {
  private codexSlot: CodexBackendSlot | undefined;
  private codexInvalidationPromise: Promise<void> | undefined;
  private poisonError: Error | undefined;
  private closed = false;
  private readonly options: Omit<
    ModelBackendManagerOptions,
    "onPoison"
  >;
  private readonly onPoison: ((error: Error) => void) | undefined;

  constructor(
    private readonly storageDirectory: string | undefined,
    options: ModelBackendManagerOptions = {},
  ) {
    const { onPoison, ...factoryOptions } = options;
    this.options = factoryOptions;
    this.onPoison = onPoison;
  }

  async forProfile(
    profile: DraftProfile | SavedProfile,
    signal?: AbortSignal,
  ): Promise<ModelBackend> {
    this.assertOpen();
    if (profile.connection.kind === "direct-api") {
      return createDirectApiBackend(profile, this.options);
    }
    return this.codex(signal);
  }

  async codex(signal?: AbortSignal): Promise<CodexSubscriptionBackend> {
    return (await this.codexLease(signal)).backend;
  }

  async codexLease(signal?: AbortSignal): Promise<CodexBackendLease> {
    for (;;) {
      throwIfAborted(signal);
      this.assertOpen();
      this.assertHealthy();
      const invalidation = this.codexInvalidationPromise;
      if (invalidation) {
        await waitForPromiseWithSignal(invalidation, signal);
        continue;
      }
      const storageDirectory = this.storageDirectory;
      if (!storageDirectory) {
        throw new Error(
          "The Codex subscription backend requires the Ableton storage directory.",
        );
      }
      let slot = this.codexSlot;
      if (!slot) {
        const startupController = createHostAbortController();
        let nextSlot!: CodexBackendSlot;
        const promise = Promise.resolve().then(() =>
          (this.options.startCodexBackend ?? startCodexAppServerBackend)(
            storageDirectory,
            startupController.signal,
          )
        ).catch((error: unknown) => {
          if (this.codexSlot === nextSlot) this.codexSlot = undefined;
          if (error instanceof ModelBackendShutdownError) this.poison(error);
          throw error;
        });
        slot = {
          startupController,
          terminalUnsubscribe: undefined,
          promise,
        };
        nextSlot = slot;
        this.codexSlot = slot;
      }
      const backend = await waitForPromiseWithSignal(slot.promise, signal);
      throwIfAborted(signal);
      this.assertOpen();
      this.assertHealthy();
      if (this.codexSlot !== slot) {
        const retiring = this.codexInvalidationPromise;
        if (retiring) await waitForPromiseWithSignal(retiring, signal);
        continue;
      }
      if (!slot.backend) {
        slot.backend = backend;
        slot.terminalUnsubscribe = backend.onTerminal(() => {
          void this.retireSlot(slot).catch(() => undefined);
        });
      }
      if (this.codexSlot !== slot) {
        const retiring = this.codexInvalidationPromise;
        if (retiring) await waitForPromiseWithSignal(retiring, signal);
        continue;
      }
      return {
        backend,
        retire: () => this.retireSlot(slot),
      };
    }
  }

  async invalidateCodex(): Promise<void> {
    this.assertOpen();
    this.assertHealthy();
    if (this.codexInvalidationPromise) {
      await this.codexInvalidationPromise;
      return;
    }
    const slot = this.codexSlot;
    if (!slot) return;
    await this.retireSlot(slot);
  }

  private retireSlot(slot: CodexBackendSlot): Promise<boolean> {
    if (slot.retirementPromise) {
      return slot.retirementPromise.then(() => false);
    }
    if (this.codexSlot !== slot) return Promise.resolve(false);
    this.codexSlot = undefined;
    slot.terminalUnsubscribe?.();
    slot.terminalUnsubscribe = undefined;
    const invalidation = this.closeDetachedSlot(slot);
    slot.retirementPromise = invalidation;
    this.codexInvalidationPromise = invalidation;
    return (async () => {
      try {
        await invalidation;
        return true;
      } finally {
        if (this.codexInvalidationPromise === invalidation) {
          this.codexInvalidationPromise = undefined;
        }
      }
    })();
  }

  private async closeDetachedSlot(slot: CodexBackendSlot): Promise<void> {
    slot.startupController.abort(
      new Error("The Codex backend startup was canceled."),
    );
    const result = await Promise.allSettled([slot.promise]);
    const backend = result[0]?.status === "fulfilled"
      ? result[0].value
      : undefined;
    if (!backend) return;
    try {
      await backend.close();
    } catch (error) {
      const poison = error instanceof Error
        ? error
        : new Error("The Codex backend could not be stopped.");
      this.poison(poison);
      throw poison;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const invalidation = this.codexInvalidationPromise;
    this.codexInvalidationPromise = undefined;
    const slot = this.codexSlot;
    this.codexSlot = undefined;
    slot?.terminalUnsubscribe?.();
    if (invalidation) await invalidation;
    if (slot) await this.closeDetachedSlot(slot);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The model backend manager is closed.");
  }

  private assertHealthy(): void {
    if (this.poisonError) throw this.poisonError;
  }

  private poison(error: Error): void {
    if (this.poisonError) return;
    this.poisonError = error;
    try {
      this.onPoison?.(error);
    } catch {
      // A storage-wide observer cannot replace the shutdown failure.
    }
  }
}

export interface CodexBackendLease {
  readonly backend: CodexSubscriptionBackend;
  retire(): Promise<boolean>;
}

interface CodexBackendSlot {
  readonly startupController: ReturnType<typeof createHostAbortController>;
  readonly promise: Promise<CodexSubscriptionBackend>;
  backend?: CodexSubscriptionBackend;
  retirementPromise?: Promise<void>;
  terminalUnsubscribe: (() => void) | undefined;
}
