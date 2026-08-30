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
import { createGoogleOAuthAdapter } from "./google.js";
import { createGoogleCloudCodeAssistProtocol } from "./google-protocol.js";
import { createOpenAIOAuthAdapter } from "./openai.js";
import { createOpenAICodexProtocol } from "./openai-codex-protocol.js";
import type { OAuthModelProtocol } from "./protocol.js";

export interface NativeOAuthBackendOptions extends TransportFactoryOptions {
  adapter?: OAuthProviderAdapter;
  protocol?: OAuthModelProtocol;
}

export function createNativeOAuthBackend(
  storageDirectory: string | undefined,
  provider: OAuthSubscriptionProvider,
  options: NativeOAuthBackendOptions = {},
): OAuthSubscriptionBackend {
  const adapter = options.adapter ?? adapterFor(provider, options);
  const protocol = options.protocol ?? protocolFor(provider, options);
  if (adapter.provider !== provider) {
    throw new Error("OAuth backend adapter provider does not match its slot.");
  }
  const credentials = new OAuthCredentialManager(storageDirectory, adapter);
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
    logout(signal) {
      assertOpen();
      return credentials.logout(signal);
    },
    async listModels(profile, signal) {
      assertOpen();
      requireProfileProvider(profile.connection, provider);
      return withAuthenticationRecovery(
        (credential) => protocol.listModels(profile, credential, signal),
        signal,
      );
    },
    async createToolTurn(request) {
      assertOpen();
      requireProfileProvider(request.runtimeProfile.profile.connection, provider);
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
      return createGoogleOAuthAdapter(options);
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
      return createGoogleCloudCodeAssistProtocol(options);
  }
}

function requireProfileProvider(
  connection: { kind: string; provider?: string },
  provider: OAuthSubscriptionProvider,
): void {
  if (connection.kind !== "oauth-subscription" || connection.provider !== provider) {
    throw new Error("OAuth backend received a Profile for another provider.");
  }
}
