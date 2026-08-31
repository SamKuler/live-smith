import type { OAuthSubscriptionProvider } from "../profile.js";
import { ModelAuthenticationError } from "../connection-error.js";
import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import type {
  OAuthSubscriptionBackend,
  TransportFactoryOptions,
} from "../provider.js";
import { createAnthropicOAuthAdapter } from "./anthropic.js";
import { OAuthCredentialManager, type OAuthProviderAdapter } from "./credential-manager.js";
import {
  createAnthropicOAuthProtocol,
} from "./anthropic-protocol.js";
import { createGoogleAntigravityOAuthAdapter } from "./google.js";
import { createGoogleAntigravityProtocol } from "./google-protocol.js";
import { createOpenAIOAuthAdapter } from "./openai.js";
import { createOpenAICodexProtocol } from "./openai-codex-protocol.js";
import type { OAuthModelProtocol } from "./protocol.js";

export interface NativeOAuthBackendOptions extends TransportFactoryOptions {
  adapter?: OAuthProviderAdapter;
  protocol?: OAuthModelProtocol;
}

export function createNativeOAuthBackend(
  storageDirectory: string | undefined,
  profileId: string,
  provider: OAuthSubscriptionProvider,
  options: NativeOAuthBackendOptions = {},
): OAuthSubscriptionBackend {
  const adapter = options.adapter ?? adapterFor(provider, options);
  const protocol = options.protocol ?? protocolFor(provider, options);
  if (adapter.provider !== provider) {
    throw new Error("OAuth backend adapter provider does not match its slot.");
  }
  const credentials = new OAuthCredentialManager(storageDirectory, profileId, adapter);
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const backend: OAuthSubscriptionBackend = {
    kind: "oauth-subscription",
    readAuthState(signal, readOptions) {
      assertOpen();
      return credentials.readAuthState(signal, readOptions);
    },
    beginLogin(signal) {
      assertOpen();
      return credentials.beginLogin(signal);
    },
    setPendingLoginBrowserLaunchFailed(failed, signal) {
      assertOpen();
      return credentials.setPendingLoginBrowserLaunchFailed(failed, signal);
    },
    submitLoginCode(code, signal) {
      assertOpen();
      return credentials.submitLoginCode(code, signal);
    },
    logout(signal) {
      assertOpen();
      return credentials.logout(signal);
    },
    async listModels(profile, signal) {
      assertOpen();
      requireProfileOwner(profile, profileId, provider);
      return withAuthenticationRecovery(
        (credential) => protocol.listModels(profile, credential, signal),
        signal,
      );
    },
    async createToolTurn(request) {
      assertOpen();
      requireProfileOwner(request.runtimeProfile.profile, profileId, provider);
      return withAuthenticationRecovery(
        (credential) => protocol.createToolTurn(request, credential),
        request.signal,
      );
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = credentials.close();
      return closePromise;
    },
  };
  return backend;

  function assertOpen(): void {
    if (closed) throw new Error(`${adapter.displayName} OAuth backend is closed.`);
  }

  async function withAuthenticationRecovery<T>(
    operation: (credential: OAuthCredential) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const credential = await credentials.requireCredential(signal);
    try {
      return await operation(credential);
    } catch (error) {
      if (!(error instanceof ModelAuthenticationError)) throw error;
      const refreshed = await credentials.refreshAfterUnauthorized(
        credential,
        signal,
      );
      return operation(refreshed);
    }
  }
}

function adapterFor(
  provider: OAuthSubscriptionProvider,
  options: TransportFactoryOptions,
): OAuthProviderAdapter {
  switch (provider) {
    case "openai":
      return createOpenAIOAuthAdapter(options);
    case "anthropic":
      return createAnthropicOAuthAdapter(options);
    case "google":
      return createGoogleAntigravityOAuthAdapter(options);
  }
}

function protocolFor(
  provider: OAuthSubscriptionProvider,
  options: TransportFactoryOptions,
): OAuthModelProtocol {
  switch (provider) {
    case "openai":
      return createOpenAICodexProtocol(options);
    case "anthropic":
      return createAnthropicOAuthProtocol(options);
    case "google":
      return createGoogleAntigravityProtocol(options);
  }
}

function requireProfileOwner(
  profile: {
    id: string;
    connection: { kind: string; provider?: string };
  },
  profileId: string,
  provider: OAuthSubscriptionProvider,
): void {
  if (profile.id !== profileId) {
    throw new Error("OAuth backend received a request for another Profile.");
  }
  if (
    profile.connection.kind !== "oauth-subscription" ||
    profile.connection.provider !== provider
  ) {
    throw new Error("OAuth backend received a Profile for another provider.");
  }
}
