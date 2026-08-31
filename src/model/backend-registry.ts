import {
  type DirectApiBackend,
  type ModelBackend,
  type OAuthSubscriptionBackend,
  type TransportFactoryOptions,
} from "./provider.js";
import {
  isProfileId,
  type DraftProfile,
  type OAuthSubscriptionProvider,
  type SavedProfile,
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
    profileId: string,
    provider: OAuthSubscriptionProvider,
    signal: AbortSignal,
  ) => Promise<OAuthSubscriptionBackend>;
}

export interface OAuthBackendLease {
  readonly backend: OAuthSubscriptionBackend;
  retire(): Promise<boolean>;
}

interface OAuthBackendSlot {
  readonly profileId: string;
  readonly provider: OAuthSubscriptionProvider;
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
  private readonly oauthSlots = new Map<string, OAuthBackendSlot>();
  private readonly invalidations = new Map<string, Promise<void>>();
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
      : this.oauth(profile.id, profile.connection.provider, signal);
  }

  async oauth(
    profileId: string,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<OAuthSubscriptionBackend> {
    return (await this.oauthLease(profileId, provider, signal)).backend;
  }

  async oauthLease(
    profileId: string,
    provider: OAuthSubscriptionProvider,
    signal?: AbortSignal,
  ): Promise<OAuthBackendLease> {
    requireProfileId(profileId);
    const key = oauthBackendKey(profileId, provider);
    for (;;) {
      throwIfAborted(signal);
      this.assertOpen();
      const invalidation = this.invalidations.get(key);
      if (invalidation) {
        await waitForPromiseWithSignal(invalidation, signal);
        continue;
      }
      const storageDirectory = this.storageDirectory;
      if (!storageDirectory) {
        throw new Error("OAuth subscription backends require the Ableton storage directory.");
      }
      let slot = this.oauthSlots.get(key);
      if (!slot) {
        const startupController = createHostAbortController();
        const start = this.options.startOAuthBackend ??
          ((directory, selectedProfileId, selectedProvider, _signal) => Promise.resolve(
            createNativeOAuthBackend(
              directory,
              selectedProfileId,
              selectedProvider,
              this.options,
            ),
          ));
        let created!: OAuthBackendSlot;
        const promise = Promise.resolve().then(() =>
          start(storageDirectory, profileId, provider, startupController.signal)
        ).catch((error: unknown) => {
          if (this.oauthSlots.get(key) === created) {
            this.oauthSlots.delete(key);
          }
          throw error;
        });
        created = { profileId, provider, startupController, promise };
        slot = created;
        this.oauthSlots.set(key, slot);
      }
      const backend = await waitForPromiseWithSignal(slot.promise, signal);
      throwIfAborted(signal);
      this.assertOpen();
      if (this.oauthSlots.get(key) !== slot) continue;
      return {
        backend,
        retire: () => this.retireSlot(key, slot!),
      };
    }
  }

  async invalidateOAuth(
    profileId: string,
    provider: OAuthSubscriptionProvider,
  ): Promise<void> {
    requireProfileId(profileId);
    this.assertOpen();
    const key = oauthBackendKey(profileId, provider);
    const invalidation = this.invalidations.get(key);
    if (invalidation) return invalidation;
    const slot = this.oauthSlots.get(key);
    if (slot) await this.retireSlot(key, slot);
  }

  async invalidateOAuthProfile(profileId: string): Promise<void> {
    requireProfileId(profileId);
    this.assertOpen();
    const prefix = `${profileId}:`;
    const pending: Promise<unknown>[] = [];
    for (const [key, invalidation] of this.invalidations) {
      if (key.startsWith(prefix)) pending.push(invalidation);
    }
    for (const [key, slot] of this.oauthSlots) {
      if (slot.profileId === profileId) pending.push(this.retireSlot(key, slot));
    }
    const results = await Promise.allSettled(pending);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const invalidations = [...this.invalidations.values()];
    const slots = [...this.oauthSlots.entries()];
    this.oauthSlots.clear();
    const cleanup = [
      ...invalidations,
      ...slots.map(async ([_key, slot]) => {
        slot.startupController.abort(
          new Error(`${slot.provider} OAuth backend manager closed.`),
        );
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
    key: string,
    slot: OAuthBackendSlot,
  ): Promise<boolean> {
    if (slot.retirementPromise) return slot.retirementPromise.then(() => false);
    if (this.oauthSlots.get(key) !== slot) return Promise.resolve(false);
    this.oauthSlots.delete(key);
    slot.startupController.abort(
      new Error(`${slot.provider} OAuth backend was invalidated.`),
    );
    const retirement = slot.promise.then(
      (backend) => backend.close(),
      () => undefined,
    );
    slot.retirementPromise = retirement;
    this.invalidations.set(key, retirement);
    return retirement.then(() => true).finally(() => {
      if (this.invalidations.get(key) === retirement) {
        this.invalidations.delete(key);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The model backend manager is closed.");
  }
}

function oauthBackendKey(
  profileId: string,
  provider: OAuthSubscriptionProvider,
): string {
  return `${profileId}:${provider}`;
}

function requireProfileId(profileId: string): void {
  if (!isProfileId(profileId)) throw new TypeError("A valid OAuth Profile ID is required.");
}
