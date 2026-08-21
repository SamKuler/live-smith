import {
  ModelBackendShutdownError,
  type ModelBackend,
  type TransportFactoryOptions,
} from "./provider.js";
import type { DraftProfile, SavedProfile } from "./profile.js";
import { transportForProfile } from "./registry.js";
import {
  startCodexAppServerBackend,
  type CodexAppServerBackend,
} from "./backends/codex-app-server.js";

export interface ModelBackendFactoryOptions extends TransportFactoryOptions {
  storageDirectory?: string;
  startCodexBackend?: (
    storageDirectory: string,
  ) => Promise<CodexAppServerBackend | ModelBackend>;
}

export interface ModelBackendManagerOptions extends Omit<
  ModelBackendFactoryOptions,
  "storageDirectory"
> {
  onPoison?(error: Error): void;
}

export async function createModelBackend(
  profile: DraftProfile | SavedProfile,
  options: ModelBackendFactoryOptions = {},
): Promise<ModelBackend> {
  if (profile.connection.kind === "direct-api") {
    const transport = transportForProfile(profile, options);
    return {
      ...transport,
      kind: "direct-api",
      async close() {},
    };
  }
  if (!options.storageDirectory) {
    throw new Error(
      "The Codex subscription backend requires the Ableton storage directory.",
    );
  }
  return (options.startCodexBackend ?? startCodexAppServerBackend)(
    options.storageDirectory,
  );
}

export class ModelBackendManager {
  private codexSlot: CodexBackendSlot | undefined;
  private codexInvalidationPromise: Promise<void> | undefined;
  private poisonError: Error | undefined;
  private closed = false;
  private readonly options: Omit<
    ModelBackendFactoryOptions,
    "storageDirectory"
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
  ): Promise<ModelBackend> {
    this.assertOpen();
    if (profile.connection.kind === "direct-api") {
      return createModelBackend(profile, this.options);
    }
    return this.codex();
  }

  async codex(): Promise<ModelBackend> {
    return (await this.codexLease()).backend;
  }

  async codexLease(): Promise<CodexBackendLease> {
    for (;;) {
      this.assertOpen();
      this.assertHealthy();
      const invalidation = this.codexInvalidationPromise;
      if (invalidation) {
        await invalidation;
        continue;
      }
      if (!this.storageDirectory) {
        throw new Error(
          "The Codex subscription backend requires the Ableton storage directory.",
        );
      }
      let slot = this.codexSlot;
      if (!slot) {
        slot = {
          terminalUnsubscribe: undefined,
          promise: createModelBackend(
            subscriptionBackendProfile,
            {
              ...this.options,
              storageDirectory: this.storageDirectory,
            },
          ),
        };
        this.codexSlot = slot;
      }
      let backend: ModelBackend;
      try {
        backend = await slot.promise;
      } catch (error) {
        if (this.codexSlot === slot) this.codexSlot = undefined;
        if (error instanceof ModelBackendShutdownError) {
          this.poison(error);
        }
        throw error;
      }
      this.assertOpen();
      this.assertHealthy();
      if (this.codexSlot !== slot) {
        const retiring = this.codexInvalidationPromise;
        if (retiring) await retiring;
        continue;
      }
      if (!slot.backend) {
        slot.backend = backend;
        slot.terminalUnsubscribe = backend.onTerminal?.(() => {
          void this.retireSlot(slot).catch(() => undefined);
        });
      }
      if (this.codexSlot !== slot) {
        const retiring = this.codexInvalidationPromise;
        if (retiring) await retiring;
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
  readonly backend: ModelBackend;
  retire(): Promise<boolean>;
}

interface CodexBackendSlot {
  readonly promise: Promise<ModelBackend>;
  backend?: ModelBackend;
  retirementPromise?: Promise<void>;
  terminalUnsubscribe: (() => void) | undefined;
}

/** Only the connection branch is consumed while lazily creating Codex. */
const subscriptionBackendProfile = {
  id: "codex-subscription-runtime",
  name: "Codex subscription runtime",
  connection: { kind: "codex-subscription", provider: "openai" },
  model: "",
  parameters: { maxOutputTokens: 1, reasoning: { mode: "default" } },
  advanced: {},
} as const satisfies DraftProfile;
