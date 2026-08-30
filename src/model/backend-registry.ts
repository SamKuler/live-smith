import {
  type DirectApiBackend,
  type ModelBackend,
  type OAuthSubscriptionBackend,
  type TransportFactoryOptions,
} from "./provider.js";
import type {
  DraftProfile,
  OAuthSubscriptionProvider,
  SavedProfile,
} from "./profile.js";
import { transportForProfile } from "./registry.js";
import { createNativeOAuthBackend } from "./oauth/native-backend.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../runtime/host.js";

export interface ModelBackendManagerOptions extends TransportFactoryOptions {
  startOAuthBackend?: (
    storageDirectory: string,
    provider: OAuthSubscriptionProvider,
    signal: AbortSignal,
  ) => Promise<OAuthSubscriptionBackend>;
}

export interface OAuthBackendLease {
  readonly backend: OAuthSubscriptionBackend;
  retire(): Promise<boolean>;
}

interface OAuthBackendSlot {
  readonly startupController: ReturnType<typeof createHostAbortController>;
  readonly promise: Promise<OAuthSubscriptionBackend>;
  retirementPromise?: Promise<void>;
}

export async function createDirectApiBackend(
  profile: DraftProfile | SavedProfile,
  options: TransportFactoryOptions = {},
): Promise<DirectApiBackend> {
  if (profile.connection.kind !== "direct-api") {
    throw new TypeError("A Direct API Profile is required.");
  }
  const transport = transportForProfile(profile, options);
  return { ...transport, kind: "direct-api", async close() {} };
}

export class ModelBackendManager {
  private readonly oauthSlots = new Map<OAuthSubscriptionProvider, OAuthBackendSlot>();
  private readonly invalidations = new Map<OAuthSubscriptionProvider, Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly options: ModelBackendManagerOptions;

  constructor(
    private readonly storageDirectory: string | undefined,
    options: ModelBackendManagerOptions = {},
  ) {
    this.options = options;
  }

  async forProfile(
    profile: DraftProfile | SavedProfile,
    signal?: AbortSignal,
  ): Promise<ModelBackend> {
    this.assertOpen();
    return profile.connection.kind === "direct-api"
      ? createDirectApiBackend(profile, this.options)
      : this.oauth(profile.connection.provider, signal);
  }

  async oauth(
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<OAuthSubscriptionBackend> {
    return (await this.oauthLease(provider, signal)).backend;
  }

  async oauthLease(
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<OAuthBackendLease> {
    for (;;) {
      throwIfAborted(signal);
      this.assertOpen();
      const invalidation = this.invalidations.get(provider);
      if (invalidation) {
        await waitForPromiseWithSignal(invalidation, signal);
        continue;
      }
      const storageDirectory = this.storageDirectory;
      if (!storageDirectory) {
        throw new Error("OAuth subscription backends require the Ableton storage directory.");
      }
      let slot = this.oauthSlots.get(provider);
      if (!slot) {
        const startupController = createHostAbortController();
        const start = this.options.startOAuthBackend ??
          ((directory, selectedProvider, _signal) => Promise.resolve(
            createNativeOAuthBackend(directory, selectedProvider, this.options),
          ));
        let created!: OAuthBackendSlot;
        const promise = Promise.resolve().then(() =>
          start(storageDirectory, provider, startupController.signal)
        ).catch((error: unknown) => {
          if (this.oauthSlots.get(provider) === created) {
            this.oauthSlots.delete(provider);
          }
          throw error;
        });
        created = { startupController, promise };
        slot = created;
        this.oauthSlots.set(provider, slot);
      }
      const backend = await waitForPromiseWithSignal(slot.promise, signal);
      throwIfAborted(signal);
      this.assertOpen();
      if (this.oauthSlots.get(provider) !== slot) continue;
      return {
        backend,
        retire: () => this.retireSlot(provider, slot!),
      };
    }
  }

  async invalidateOAuth(provider: OAuthSubscriptionProvider): Promise<void> {
    this.assertOpen();
    const invalidation = this.invalidations.get(provider);
    if (invalidation) return invalidation;
    const slot = this.oauthSlots.get(provider);
    if (slot) await this.retireSlot(provider, slot);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const invalidations = [...this.invalidations.values()];
    const slots = [...this.oauthSlots.entries()];
    this.oauthSlots.clear();
    const cleanup = [
      ...invalidations,
      ...slots.map(async ([provider, slot]) => {
        slot.startupController.abort(new Error(`${provider} OAuth backend manager closed.`));
        const result = await Promise.allSettled([slot.promise]);
        const backend = result[0]?.status === "fulfilled" ? result[0].value : undefined;
        if (backend) await backend.close();
      }),
    ];
    this.closePromise = Promise.allSettled(cleanup).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
    return this.closePromise;
  }

  private retireSlot(
    provider: OAuthSubscriptionProvider,
    slot: OAuthBackendSlot,
  ): Promise<boolean> {
    if (slot.retirementPromise) return slot.retirementPromise.then(() => false);
    if (this.oauthSlots.get(provider) !== slot) return Promise.resolve(false);
    this.oauthSlots.delete(provider);
    slot.startupController.abort(new Error(`${provider} OAuth backend was invalidated.`));
    const retirement = slot.promise.then(
      (backend) => backend.close(),
      () => undefined,
    );
    slot.retirementPromise = retirement;
    this.invalidations.set(provider, retirement);
    return retirement.then(() => true).finally(() => {
      if (this.invalidations.get(provider) === retirement) {
        this.invalidations.delete(provider);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The model backend manager is closed.");
  }
}
