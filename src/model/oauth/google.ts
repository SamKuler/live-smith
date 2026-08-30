import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import {
  createHostAbortController,
  resolveFetchImplementation,
  throwIfAborted,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import type {
  OAuthLoginAttempt,
  OAuthProviderAdapter,
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
    successMessage: "Gemini sign-in completed. You can close this window.",
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
  const completion = loopback.completion.then(async (code): Promise<OAuthCredential> => {
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
    const tokens = tokensFromResponse(
      await requireOAuthJson(response, "Google token exchange", controller.signal),
      "Google token exchange",
    );
    const projectId = await discoverCodeAssistProject(
      fetchImpl,
      wait,
      tokens.accessToken,
      controller.signal,
    );
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
  if (isRecord(load.currentTier)) {
    if (typeof load.cloudaicompanionProject === "string" && load.cloudaicompanionProject) {
      return load.cloudaicompanionProject;
    }
    throw new Error(
      "This Google account requires an explicit Google Cloud project, which is not configured in the subscription Profile.",
    );
  }
  const allowedTiers = Array.isArray(load.allowedTiers)
    ? load.allowedTiers.filter(isRecord)
    : [];
  const tier = allowedTiers.find((entry) => entry.isDefault === true) ??
    allowedTiers[0] ?? { id: "legacy-tier" };
  if (tier.id !== "free-tier") {
    throw new Error(
      "This Google account requires an explicit Google Cloud project, which is not configured in the subscription Profile.",
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
  throw new Error("Google Cloud Code Assist did not provide a project.");
}

function projectIdFromOperation(operation: Record<string, unknown>): string | undefined {
  const response = isRecord(operation.response) ? operation.response : undefined;
  const project = isRecord(response?.cloudaicompanionProject)
    ? response.cloudaicompanionProject
    : undefined;
  return typeof project?.id === "string" && project.id ? project.id : undefined;
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": "google-api-nodejs-client/9.15.1",
    "x-goog-api-client": "gl-node/24",
  };
}
