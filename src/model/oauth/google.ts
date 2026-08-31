import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import {
  createHostAbortController,
  resolveFetchImplementation,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import {
  OAuthLoginError,
  type OAuthLoginAttempt,
  type OAuthProviderAdapter,
} from "./credential-manager.js";
import {
  formBody,
  generatePkce,
  isRecord,
  requireOAuthJson,
  startLoopbackAuthorization,
  tokensFromResponse,
  type LoopbackAuthorization,
} from "./oauth-utils.js";

const clientId = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Google's installed-app registration publishes this value with Gemini CLI;
// installed-app client credentials are identifiers, not confidential user keys.
const clientSecret = "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";
const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const userInfoUrl = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const codeAssistBaseUrl = "https://cloudcode-pa.googleapis.com";
const callbackPort = 0;
const callbackPath = "/oauth2callback";
const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
const maximumOnboardingPolls = 60;

type StartLoopback = (
  options: Parameters<typeof startLoopbackAuthorization>[0],
) => Promise<LoopbackAuthorization>;

export interface GoogleOAuthAdapterOptions {
  fetchImpl?: typeof fetch;
  startLoopback?: StartLoopback;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createGoogleOAuthAdapter(
  options: GoogleOAuthAdapterOptions = {},
): OAuthProviderAdapter {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  const startLoopback = options.startLoopback ?? startLoopbackAuthorization;
  const wait = options.wait ?? ((milliseconds, signal) =>
    waitForPromiseWithSignal(delay(milliseconds), signal));
  return {
    provider: "google",
    displayName: "Gemini",
    beginLogin(signal) {
      return beginGoogleLogin(fetchImpl, startLoopback, wait, signal);
    },
    async refresh(credential, signal) {
      if (credential.provider !== "google") {
        throw new Error("Google OAuth received another provider's credential.");
      }
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: credential.refreshToken,
          grant_type: "refresh_token",
        }),
        signal,
      });
      const value = await requireOAuthJson(response, "Google OAuth refresh", signal);
      if (typeof value.access_token !== "string" || !value.access_token ||
        typeof value.expires_in !== "number" || value.expires_in <= 0 ||
        (value.refresh_token !== undefined && typeof value.refresh_token !== "string")) {
        throw new Error("Google OAuth refresh returned an invalid token response.");
      }
      return {
        ...credential,
        accessToken: value.access_token,
        refreshToken: value.refresh_token || credential.refreshToken,
        expiresAt: Date.now() + Math.floor(value.expires_in * 1_000),
      };
    },
    authState(credential) {
      if (credential.provider !== "google") {
        throw new Error("Google OAuth received another provider's credential.");
      }
      return {
        status: "signed-in",
        accountLabel: credential.accountLabel,
        planType: "Google Cloud Code Assist",
        subscriptionEligible: true,
      };
    },
  };
}

async function beginGoogleLogin(
  fetchImpl: typeof fetch,
  startLoopback: StartLoopback,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
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
    successMessage: "Google authorization was received. Return to Live Smith while Gemini account setup finishes.",
    listenHost: "127.0.0.1",
    redirectHost: "127.0.0.1",
  });
  const authorization = new URL(authorizeUrl);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("redirect_uri", loopback.redirectUri);
  authorization.searchParams.set("scope", scopes);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("access_type", "offline");
  authorization.searchParams.set("prompt", "consent");
  const authorizationCode = loopback.completion.catch((error: unknown) => {
    throwIfAborted(controller.signal);
    if (error instanceof OAuthLoginError || error instanceof NetworkProxyError) {
      throw error;
    }
    throw new OAuthLoginError(
      "Google sign-in did not return to Live Smith. Keep the Live Smith window open and try again.",
    );
  });
  const completion = authorizationCode.then(async (code): Promise<OAuthCredential> => {
    let tokens: ReturnType<typeof tokensFromResponse>;
    try {
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: loopback.redirectUri,
          code_verifier: verifier,
        }),
        signal: controller.signal,
      });
      tokens = tokensFromResponse(
        await requireOAuthJson(response, "Google token exchange", controller.signal),
        "Google token exchange",
      );
    } catch (error) {
      throwIfAborted(controller.signal);
      if (error instanceof NetworkProxyError) throw error;
      throw new OAuthLoginError(
        "Google authorized the account, but Live Smith could not finish the token exchange. Check the network proxy and try again.",
      );
    }
    let projectId: string;
    try {
      projectId = await discoverCodeAssistProject(
        fetchImpl,
        wait,
        tokens.accessToken,
        controller.signal,
      );
    } catch (error) {
      throwIfAborted(controller.signal);
      if (error instanceof NetworkProxyError || error instanceof OAuthLoginError) {
        throw error;
      }
      throw new OAuthLoginError(
        "Google authorization succeeded, but Cloud Code Assist account setup failed. Try sign-in again.",
      );
    }
    const accountLabel = await readAccountLabel(
      fetchImpl,
      tokens.accessToken,
      controller.signal,
    );
    return { provider: "google", ...tokens, projectId, accountLabel };
  }).finally(() => signal.removeEventListener("abort", relayAbort));
  return {
    pending: {
      status: "pending",
      verificationUrl: authorization.toString(),
    },
    completion,
    cancel(reason) {
      loopback.cancel(reason);
      controller.abort(reason ?? new Error("Gemini sign-in was canceled."));
    },
  };
}

async function readAccountLabel(
  fetchImpl: typeof fetch,
  accessToken: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl(userInfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    const value = await requireOAuthJson(response, "Google account lookup", signal);
    return typeof value.email === "string" && value.email ? value.email : null;
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

async function discoverCodeAssistProject(
  fetchImpl: typeof fetch,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const headers = codeAssistHeaders(accessToken);
  const loadResponse = await fetchImpl(`${codeAssistBaseUrl}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
    signal,
  });
  const load = await requireOAuthJson(loadResponse, "Google Cloud Code Assist", signal);
  const ineligibleTiers = Array.isArray(load.ineligibleTiers)
    ? load.ineligibleTiers.filter(isRecord)
    : [];
  const currentTier = isRecord(load.currentTier) ? load.currentTier : undefined;
  const validationTier = currentTier === undefined
    ? ineligibleTiers.find(
        (entry) => entry.reasonCode === "VALIDATION_REQUIRED",
      )
    : undefined;
  if (validationTier !== undefined) {
    const verificationUrl = trustedGoogleVerificationUrl(validationTier.validationUrl);
    throw new OAuthLoginError(
      "Google requires an additional account verification before Gemini can be used.",
      verificationUrl
        ? { verificationUrl, verificationLabel: "Verify Google account" }
        : {},
    );
  }
  if (currentTier) {
    if (typeof load.cloudaicompanionProject === "string" && load.cloudaicompanionProject) {
      return load.cloudaicompanionProject;
    }
    throw new OAuthLoginError(
      "This Google account requires a Google Cloud project and cannot use the project-free Gemini subscription flow.",
    );
  }
  const allowedTiers = Array.isArray(load.allowedTiers)
    ? load.allowedTiers.filter(isRecord)
    : [];
  const tier = allowedTiers.find((entry) => entry.isDefault === true) ??
    { id: "legacy-tier" };
  if (tier.id !== "free-tier") {
    throw new OAuthLoginError(
      ineligibleTiers.length > 0
        ? "This Google account is not eligible for Gemini Code Assist subscription access."
        : "This Google account requires a Google Cloud project and cannot use the project-free Gemini subscription flow.",
    );
  }
  const onboardResponse = await fetchImpl(`${codeAssistBaseUrl}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tierId: "free-tier",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
    signal,
  });
  let operation = await requireOAuthJson(
    onboardResponse,
    "Google Cloud Code Assist onboarding",
    signal,
  );
  for (let attempt = 0; attempt < maximumOnboardingPolls; attempt += 1) {
    const projectId = projectIdFromOperation(operation);
    if (projectId) return projectId;
    if (operation.done === true || typeof operation.name !== "string" || !operation.name) break;
    await wait(5_000, signal);
    const pollResponse = await fetchImpl(
      `${codeAssistBaseUrl}/v1internal/${operation.name}`,
      { headers, signal },
    );
    operation = await requireOAuthJson(
      pollResponse,
      "Google Cloud Code Assist onboarding",
      signal,
    );
  }
  throw new OAuthLoginError(
    "Google authorization succeeded, but Gemini account setup did not finish. Try sign-in again.",
  );
}

function projectIdFromOperation(operation: Record<string, unknown>): string | undefined {
  const response = isRecord(operation.response) ? operation.response : undefined;
  const rawProject = response?.cloudaicompanionProject;
  if (typeof rawProject === "string" && rawProject) return rawProject;
  const project = isRecord(rawProject) ? rawProject : undefined;
  return typeof project?.id === "string" && project.id ? project.id : undefined;
}

function trustedGoogleVerificationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
        url.hostname === "accounts.google.com" &&
        !url.username &&
        !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": "google-api-nodejs-client/9.15.1",
    "x-goog-api-client": "gl-node/24",
  };
}
