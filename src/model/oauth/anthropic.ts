import { URL } from "node:url";

import {
  createHostAbortController,
  resolveFetchImplementation,
} from "../../runtime/host.js";
import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import type {
  OAuthLoginAttempt,
  OAuthProviderAdapter,
} from "./credential-manager.js";
import {
  generatePkce,
  requireOAuthJson,
  startLoopbackAuthorization,
  tokensFromResponse,
  type LoopbackAuthorization,
} from "./oauth-utils.js";

const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const authorizeUrl = "https://claude.ai/oauth/authorize";
const tokenUrl = "https://platform.claude.com/v1/oauth/token";
const callbackPort = 53_692;
const callbackPath = "/callback";
const scopes = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

type StartLoopback = (
  options: Parameters<typeof startLoopbackAuthorization>[0],
) => Promise<LoopbackAuthorization>;

export interface AnthropicOAuthAdapterOptions {
  fetchImpl?: typeof fetch;
  startLoopback?: StartLoopback;
}

export function createAnthropicOAuthAdapter(
  options: AnthropicOAuthAdapterOptions = {},
): OAuthProviderAdapter {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  const startLoopback = options.startLoopback ?? startLoopbackAuthorization;
  return {
    provider: "anthropic",
    displayName: "Claude",
    beginLogin(signal) {
      return beginAnthropicLogin(fetchImpl, startLoopback, signal);
    },
    async refresh(credential, signal) {
      if (credential.provider !== "anthropic") {
        throw new Error("Anthropic OAuth received another provider's credential.");
      }
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refreshToken,
        }),
        signal,
      });
      return {
        provider: "anthropic",
        ...tokensFromResponse(
          await requireOAuthJson(response, "Anthropic OAuth refresh", signal),
          "Anthropic OAuth refresh",
        ),
      };
    },
    authState(credential) {
      if (credential.provider !== "anthropic") {
        throw new Error("Anthropic OAuth received another provider's credential.");
      }
      return {
        status: "signed-in",
        accountLabel: null,
        planType: "Claude subscription OAuth",
        subscriptionEligible: true,
      };
    },
  };
}

async function beginAnthropicLogin(
  fetchImpl: typeof fetch,
  startLoopback: StartLoopback,
  signal: AbortSignal,
): Promise<OAuthLoginAttempt> {
  const controller = createHostAbortController();
  const relayAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", relayAbort, { once: true });
  if (signal.aborted) relayAbort();
  const { verifier, challenge, state } = generatePkce();
  const loopback = await startLoopback({
    port: callbackPort,
    path: callbackPath,
    expectedState: state,
    signal: controller.signal,
    successMessage: "Claude sign-in completed. You can close this window.",
  });
  const authorization = new URL(authorizeUrl);
  authorization.searchParams.set("code", "true");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("redirect_uri", loopback.redirectUri);
  authorization.searchParams.set("scope", scopes);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  const completion = loopback.completion.then(async (code): Promise<OAuthCredential> => {
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        state,
        redirect_uri: loopback.redirectUri,
        code_verifier: verifier,
      }),
      signal: controller.signal,
    });
    return {
      provider: "anthropic",
      ...tokensFromResponse(
        await requireOAuthJson(response, "Anthropic token exchange", controller.signal),
        "Anthropic token exchange",
      ),
    };
  }).finally(() => signal.removeEventListener("abort", relayAbort));
  return {
    pending: {
      status: "pending",
      verificationUrl: authorization.toString(),
    },
    completion,
    cancel(reason) {
      loopback.cancel(reason);
      controller.abort(reason ?? new Error("Claude sign-in was canceled."));
    },
  };
}
