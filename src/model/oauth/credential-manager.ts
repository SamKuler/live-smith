import {
  deleteOAuthCredential,
  loadOAuthCredential,
  saveOAuthCredential,
  type OAuthCredential,
  type OAuthProvider,
} from "../../storage/oauth-credentials.js";
import type {
  OAuthAuthReadOptions,
  OAuthAuthState,
} from "../provider.js";
import { isProfileId } from "../profile.js";
import {
  createHostAbortController,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";

const refreshSkewMs = 5 * 60 * 1_000;

export interface OAuthLoginAttempt {
  pending: Extract<OAuthAuthState, { status: "pending" }>;
  completion: Promise<OAuthCredential>;
  cancel(reason?: unknown): void;
}

export class OAuthLoginError extends Error {
  readonly verificationUrl: string | undefined;
  readonly verificationLabel: string | undefined;

  constructor(
    message: string,
    options: {
      verificationUrl?: string;
      verificationLabel?: string;
    } = {},
  ) {
    super(message);
    this.name = "OAuthLoginError";
    this.verificationUrl = options.verificationUrl;
    this.verificationLabel = options.verificationLabel;
  }
}

export interface OAuthProviderAdapter {
  readonly provider: OAuthProvider;
  readonly displayName: string;
  beginLogin(signal: AbortSignal): Promise<OAuthLoginAttempt>;
  refresh(
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<OAuthCredential>;
  authState(
    credential: OAuthCredential,
  ): Extract<OAuthAuthState, { status: "signed-in" }>;
}

interface ActiveLogin {
  controller: ReturnType<typeof createHostAbortController>;
  attempt?: OAuthLoginAttempt;
  failure?: Extract<OAuthAuthState, { status: "unavailable" }>;
  cancelAttempt?: () => void;
  acquired: Promise<OAuthLoginAttempt>;
  settled: Promise<void>;
}

interface ActiveRefresh {
  controller: ReturnType<typeof createHostAbortController>;
  generation: number;
  promise: Promise<OAuthCredential>;
}

export class OAuthCredentialManager {
  private activeLogin: ActiveLogin | undefined;
  private activeRefresh: ActiveRefresh | undefined;
  private credentialGeneration = 0;
  private loginFailure: Extract<OAuthAuthState, { status: "unavailable" }> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private logoutPromise: Promise<void> | undefined;

  constructor(
    private readonly storageDirectory: string | undefined,
    private readonly profileId: string,
    private readonly adapter: OAuthProviderAdapter,
  ) {
    if (!isProfileId(profileId)) {
      throw new TypeError("A valid OAuth Profile ID is required.");
    }
  }

  async readAuthState(
    signal?: AbortSignal,
    options: OAuthAuthReadOptions = {},
  ): Promise<OAuthAuthState> {
    throwIfAborted(signal);
    this.assertOpen();
    while (this.logoutPromise) await this.waitForLogout(signal);
    throwIfAborted(signal);
    this.assertOpen();
    if (this.activeLogin) {
      return this.pendingLoginState(this.activeLogin, signal);
    }
    const generation = this.credentialGeneration;
    let credential = await loadOAuthCredential(
      this.storageDirectory,
      this.profileId,
      this.adapter.provider,
    );
    throwIfAborted(signal);
    this.assertCredentialGeneration(generation);
    if (credential && options.readiness && shouldRefresh(credential)) {
      credential = await this.refreshCredential(credential, generation, signal);
    }
    if (credential) return this.adapter.authState(credential);
    if (this.loginFailure) return { ...this.loginFailure };
    return { status: "signed-out" };
  }

  async beginLogin(signal?: AbortSignal): Promise<OAuthAuthState> {
    throwIfAborted(signal);
    this.assertOpen();
    while (this.logoutPromise) await this.waitForLogout(signal);
    throwIfAborted(signal);
    this.assertOpen();
    if (this.activeLogin) return this.pendingLoginState(this.activeLogin, signal);
    this.loginFailure = undefined;
    const controller = createHostAbortController();
    const relayAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relayAbort, { once: true });
    let active!: ActiveLogin;
    const acquired = Promise.resolve().then(() => this.acquireLogin(active));
    const settled = Promise.resolve().then(() => this.completeLogin(active)).finally(() => {
      signal?.removeEventListener("abort", relayAbort);
      if (active.cancelAttempt) {
        active.controller.signal.removeEventListener("abort", active.cancelAttempt);
      }
      if (this.activeLogin === active) this.activeLogin = undefined;
    });
    active = { controller, acquired, settled };
    this.activeLogin = active;
    void settled.catch(() => undefined);
    return this.pendingLoginState(active, signal);
  }

  async setPendingLoginBrowserLaunchFailed(
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState> {
    throwIfAborted(signal);
    this.assertOpen();
    const active = this.activeLogin;
    if (!active) return this.readAuthState(signal);
    const attempt = active.attempt ?? await waitForPromiseWithSignal(
      active.acquired,
      signal,
    );
    throwIfAborted(signal);
    if (!this.ownsLogin(active)) return this.readAuthState(signal);
    if (failed) attempt.pending.browserLaunchFailed = true;
    else delete attempt.pending.browserLaunchFailed;
    return { ...attempt.pending };
  }

  async requireCredential(signal?: AbortSignal): Promise<OAuthCredential> {
    throwIfAborted(signal);
    this.assertOpen();
    while (this.logoutPromise) await this.waitForLogout(signal);
    throwIfAborted(signal);
    this.assertOpen();
    if (this.activeLogin) {
      throw new Error(`${this.adapter.displayName} sign-in is still pending.`);
    }
    const generation = this.credentialGeneration;
    const credential = await loadOAuthCredential(
      this.storageDirectory,
      this.profileId,
      this.adapter.provider,
    );
    throwIfAborted(signal);
    this.assertCredentialGeneration(generation);
    if (!credential) {
      throw new Error(`Sign in to ${this.adapter.displayName} before sending.`);
    }
    return shouldRefresh(credential)
      ? this.refreshCredential(credential, generation, signal)
      : credential;
  }

  async refreshAfterUnauthorized(
    rejected: OAuthCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    throwIfAborted(signal);
    this.assertOpen();
    while (this.logoutPromise) await this.waitForLogout(signal);
    throwIfAborted(signal);
    this.assertOpen();
    const generation = this.credentialGeneration;
    const current = await loadOAuthCredential(
      this.storageDirectory,
      this.profileId,
      this.adapter.provider,
    );
    throwIfAborted(signal);
    this.assertCredentialGeneration(generation);
    if (!current) {
      throw new Error(`Sign in to ${this.adapter.displayName} before retrying.`);
    }
    if (current.accessToken !== rejected.accessToken) return current;
    return this.refreshCredential(current, generation, signal);
  }

  async logout(signal?: AbortSignal): Promise<OAuthAuthState> {
    throwIfAborted(signal);
    this.assertOpen();
    const cleanup = this.logoutPromise ?? this.startLogoutCleanup();
    await waitForPromiseWithSignal(cleanup, signal);
    if (this.logoutPromise === cleanup) this.logoutPromise = undefined;
    return { status: "signed-out" };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const reason = new Error(`${this.adapter.displayName} backend closed.`);
    const login = this.retireLogin(reason);
    const refresh = this.retireCredentialGeneration(
      reason,
    );
    const logout = this.logoutPromise;
    const pending: Promise<unknown>[] = [];
    if (login) pending.push(login.settled);
    if (refresh) pending.push(refresh);
    this.closePromise = Promise.allSettled(pending).then(async () => {
      if (logout) await logout;
    });
    return this.closePromise;
  }

  private async pendingLoginState(
    active: ActiveLogin,
    signal?: AbortSignal,
  ): Promise<OAuthAuthState> {
    let attempt: OAuthLoginAttempt;
    try {
      attempt = active.attempt ?? await waitForPromiseWithSignal(
        active.acquired,
        signal,
      );
    } catch {
      throwIfAborted(signal);
      if (active.controller.signal.aborted) {
        throwIfAborted(active.controller.signal);
      }
      const failure = active.failure;
      if (!failure) throw this.loginOwnershipError();
      await waitForPromiseWithSignal(
        active.settled.catch(() => undefined),
        signal,
      );
      throwIfAborted(signal);
      if (active.controller.signal.aborted) {
        throwIfAborted(active.controller.signal);
      }
      this.assertOpen();
      return { ...failure };
    }
    throwIfAborted(signal);
    if (!this.ownsLogin(active)) throw this.loginOwnershipError();
    return { ...attempt.pending };
  }

  private async acquireLogin(active: ActiveLogin): Promise<OAuthLoginAttempt> {
    const signal = active.controller.signal;
    await this.retireCredentialGeneration(
      new Error(`${this.adapter.displayName} credential refresh was superseded by sign-in.`),
      signal,
    );
    throwIfAborted(signal);
    if (!this.ownsLogin(active)) throw this.loginOwnershipError();
    let attempt: OAuthLoginAttempt;
    try {
      attempt = await this.adapter.beginLogin(signal);
    } catch (error) {
      throwIfAborted(signal);
      if (!this.ownsLogin(active)) throw this.loginOwnershipError();
      active.failure = this.loginFailureState(error);
      this.loginFailure = active.failure;
      throw new Error(active.failure.message);
    }
    active.attempt = attempt;
    let canceled = false;
    active.cancelAttempt = () => {
      if (canceled) return;
      canceled = true;
      attempt.cancel(signal.reason ?? this.loginOwnershipError());
    };
    signal.addEventListener("abort", active.cancelAttempt, { once: true });
    if (signal.aborted || !this.ownsLogin(active)) {
      active.cancelAttempt();
      await attempt.completion.catch(() => undefined);
      throwIfAborted(signal);
      throw this.loginOwnershipError();
    }
    return attempt;
  }

  private async completeLogin(active: ActiveLogin): Promise<void> {
    try {
      const attempt = await active.acquired;
      const credential = await attempt.completion;
      if (credential.provider !== this.adapter.provider) {
        throw new Error("OAuth login returned a credential for another provider.");
      }
      if (!this.ownsLogin(active)) throw this.loginOwnershipError();
      const committed = await saveOAuthCredential(
        this.storageDirectory,
        this.profileId,
        credential,
        { shouldCommit: () => this.ownsLogin(active) },
      );
      if (!committed) throw this.loginOwnershipError();
      this.loginFailure = undefined;
    } catch (error) {
      if (this.ownsLogin(active) && !active.controller.signal.aborted) {
        this.loginFailure = active.failure ?? this.loginFailureState(error);
      }
      throw error;
    }
  }

  private loginFailureState(
    error?: unknown,
  ): Extract<OAuthAuthState, { status: "unavailable" }> {
    if (error instanceof NetworkProxyError) {
      return {
        status: "unavailable",
        message: error.message,
        definitive: true,
      };
    }
    if (error instanceof OAuthLoginError) {
      return {
        status: "unavailable",
        message: error.message,
        definitive: true,
        ...(error.verificationUrl
          ? { verificationUrl: error.verificationUrl }
          : {}),
        ...(error.verificationLabel
          ? { verificationLabel: error.verificationLabel }
          : {}),
      };
    }
    return {
      status: "unavailable",
      message: `${this.adapter.displayName} sign-in did not complete.`,
      definitive: true,
    };
  }

  private retireLogin(reason: Error): ActiveLogin | undefined {
    const active = this.activeLogin;
    if (!active) return undefined;
    this.activeLogin = undefined;
    active.controller.abort(reason);
    return active;
  }

  private ownsLogin(active: ActiveLogin): boolean {
    return !this.closed && this.activeLogin === active;
  }

  private loginOwnershipError(): Error {
    return new Error(
      `${this.adapter.displayName} OAuth ownership ended before login completed.`,
    );
  }

  private startLogoutCleanup(): Promise<void> {
    const login = this.retireLogin(
      new Error(`${this.adapter.displayName} sign-in was canceled.`),
    );
    const refresh = this.retireCredentialGeneration(
      new Error(`${this.adapter.displayName} credential refresh was canceled by logout.`),
    );
    const pending = [login?.settled, refresh].filter(
      (operation): operation is Promise<void> => operation !== undefined,
    );
    const cleanup = Promise.allSettled(pending).then(async () => {
      await deleteOAuthCredential(
        this.storageDirectory,
        this.profileId,
        this.adapter.provider,
      );
      this.loginFailure = undefined;
    });
    this.logoutPromise = cleanup;
    void cleanup.catch(() => undefined);
    return cleanup;
  }

  private async waitForLogout(signal?: AbortSignal): Promise<void> {
    const cleanup = this.logoutPromise;
    if (!cleanup) return;
    await waitForPromiseWithSignal(cleanup, signal);
    if (this.logoutPromise === cleanup) this.logoutPromise = undefined;
  }

  private refreshCredential(
    credential: OAuthCredential,
    generation: number,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    this.assertCredentialGeneration(generation);
    if (!this.activeRefresh) {
      const controller = createHostAbortController();
      let active!: ActiveRefresh;
      const operation = this.refreshWithAdapter(credential, controller.signal)
        .then(async (refreshed) => {
          if (refreshed.provider !== this.adapter.provider) {
            throw new Error("OAuth refresh returned a credential for another provider.");
          }
          if (
            this.closed ||
            this.activeRefresh !== active ||
            this.credentialGeneration !== generation
          ) {
            throw new Error(
              `${this.adapter.displayName} OAuth ownership ended before refresh completed.`,
            );
          }
          const committed = await saveOAuthCredential(
            this.storageDirectory,
            this.profileId,
            refreshed,
            {
              shouldCommit: () =>
                !this.closed &&
                this.activeRefresh === active &&
                this.credentialGeneration === generation,
            },
          );
          if (!committed) {
            throw new Error(
              `${this.adapter.displayName} OAuth ownership ended before refresh completed.`,
            );
          }
          return refreshed;
        })
        .finally(() => {
          if (this.activeRefresh === active) this.activeRefresh = undefined;
        });
      active = { controller, generation, promise: operation };
      this.activeRefresh = active;
    }
    if (this.activeRefresh.generation !== generation) {
      throw new Error(`${this.adapter.displayName} OAuth credential changed during refresh.`);
    }
    return waitForPromiseWithSignal(this.activeRefresh.promise, signal);
  }

  private async refreshWithAdapter(
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<OAuthCredential> {
    try {
      return await this.adapter.refresh(credential, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof NetworkProxyError) throw error;
      throw new Error(`${this.adapter.displayName} OAuth credential refresh failed.`);
    }
  }

  private retireCredentialGeneration(
    reason: Error,
    signal?: AbortSignal,
  ): Promise<void> | undefined {
    this.credentialGeneration += 1;
    const refresh = this.activeRefresh;
    if (!refresh) return undefined;
    refresh.controller.abort(reason);
    const settled = refresh.promise.then(
      () => undefined,
      () => undefined,
    );
    return signal ? waitForPromiseWithSignal(settled, signal) : settled;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`${this.adapter.displayName} OAuth backend is closed.`);
  }

  private assertCredentialGeneration(generation: number): void {
    this.assertOpen();
    if (this.credentialGeneration !== generation) {
      throw new Error(`${this.adapter.displayName} OAuth credential changed during use.`);
    }
  }
}

function shouldRefresh(credential: OAuthCredential): boolean {
  return credential.expiresAt <= Date.now() + refreshSkewMs;
}
