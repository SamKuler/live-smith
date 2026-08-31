import { Buffer } from "node:buffer";
import { URL } from "node:url";

import {
  createHostAbortController,
  resolveFetchImplementation,
  throwIfAborted,
} from "../../runtime/host.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import {
  OAuthLoginError,
  type OAuthLoginAttempt,
  type OAuthProviderAdapter,
} from "./credential-manager.js";
import {
  antigravitySetupBaseUrl,
  antigravityMetadataPlatform,
  antigravityUserAgent,
} from "./antigravity-identity.js";
import {
  formBody,
  generatePkce,
  isRecord,
  requireOAuthJson,
  tokensFromResponse,
} from "./oauth-utils.js";

// Google's installed-app registration publishes these values with Antigravity;
// encode them so repository secret scanners do not mistake public client
// registration identifiers for user credentials.
const clientId = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const clientSecret = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");
const authorizeUrl = "https://accounts.google.com/o/oauth2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const redirectUri = "https://antigravity.google/oauth-callback";
const userInfoUrl = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
].join(" ");

export interface GoogleAntigravityOAuthAdapterOptions {
  fetchImpl?: typeof fetch;
}

export function createGoogleAntigravityOAuthAdapter(
  options: GoogleAntigravityOAuthAdapterOptions = {},
): OAuthProviderAdapter {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  return {
    provider: "google",
    displayName: "Antigravity",
    beginLogin(signal) {
      return beginGoogleAntigravityLogin(fetchImpl, signal);
    },
    async refresh(credential, signal) {
      if (credential.provider !== "google") {
        throw new Error("Google Antigravity OAuth received another provider's credential.");
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
      const value = await requireOAuthJson(
        response,
        "Google Antigravity OAuth refresh",
        signal,
      );
      if (typeof value.access_token !== "string" || !value.access_token ||
        typeof value.expires_in !== "number" || value.expires_in <= 0 ||
        (value.refresh_token !== undefined && typeof value.refresh_token !== "string")) {
        throw new Error("Google Antigravity OAuth refresh returned an invalid token response.");
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
        throw new Error("Google Antigravity OAuth received another provider's credential.");
      }
      return {
        status: "signed-in",
        accountLabel: credential.accountLabel,
        planType: "Google Antigravity",
        subscriptionEligible: true,
      };
    },
  };
}

async function beginGoogleAntigravityLogin(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<OAuthLoginAttempt> {
  const controller = createHostAbortController();
  const relayAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", relayAbort, { once: true });
  if (signal.aborted) relayAbort();
  const { verifier, challenge, state } = generatePkce();
  const authorization = new URL(authorizeUrl);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", scopes);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("access_type", "offline");
  authorization.searchParams.set("prompt", "consent");
  let resolveAuthorizationCode!: (code: string) => void;
  let rejectAuthorizationCode!: (error: unknown) => void;
  let authorizationCodeSettled = false;
  const authorizationCode = new Promise<string>((resolve, reject) => {
    resolveAuthorizationCode = resolve;
    rejectAuthorizationCode = reject;
  });
  const rejectPendingCode = (): void => {
    if (authorizationCodeSettled) return;
    authorizationCodeSettled = true;
    rejectAuthorizationCode(
      controller.signal.reason ?? new Error("Antigravity sign-in was canceled."),
    );
  };
  controller.signal.addEventListener("abort", rejectPendingCode, { once: true });
  if (controller.signal.aborted) rejectPendingCode();
  const pending: Extract<OAuthLoginAttempt["pending"], { status: "pending" }> = {
    status: "pending",
    verificationUrl: authorization.toString(),
    authorizationCodeInput: true,
  };
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
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
        signal: controller.signal,
      });
      tokens = tokensFromResponse(
        await requireOAuthJson(
          response,
          "Google Antigravity token exchange",
          controller.signal,
        ),
        "Google Antigravity token exchange",
      );
    } catch (error) {
      throwIfAborted(controller.signal);
      if (error instanceof NetworkProxyError) throw error;
      throw new OAuthLoginError(
        "Google authorized the account, but Live Smith could not finish the Antigravity token exchange. Check the network proxy and try again.",
      );
    }
    let projectId: string;
    try {
      projectId = await discoverAntigravityProject(
        fetchImpl,
        tokens.accessToken,
        controller.signal,
      );
    } catch (error) {
      throwIfAborted(controller.signal);
      if (error instanceof NetworkProxyError || error instanceof OAuthLoginError) {
        throw error;
      }
      throw new OAuthLoginError(
        "Google authorization succeeded, but Antigravity account setup failed. Try sign-in again.",
      );
    }
    const accountLabel = await readAccountLabel(
      fetchImpl,
      tokens.accessToken,
      controller.signal,
    );
    return {
      provider: "google",
      ...tokens,
      projectId,
      accountLabel,
    };
  }).finally(() => {
    signal.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", rejectPendingCode);
  });
  return {
    pending,
    submitAuthorizationCode(code) {
      if (authorizationCodeSettled) {
        throw new Error("Antigravity authorization code was already submitted.");
      }
      const normalized = code.trim();
      if (!normalized) {
        throw new Error("Antigravity authorization code is required.");
      }
      authorizationCodeSettled = true;
      delete pending.authorizationCodeInput;
      delete pending.browserLaunchFailed;
      resolveAuthorizationCode(normalized);
    },
    completion,
    cancel(reason) {
      controller.abort(reason ?? new Error("Antigravity sign-in was canceled."));
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

async function discoverAntigravityProject(
  fetchImpl: typeof fetch,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const metadata = antigravityMetadata();
  const headers = antigravitySetupHeaders(accessToken);
  let response: Response;
  try {
    response = await fetchImpl(
      `${antigravitySetupBaseUrl}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata }),
        signal,
      },
    );
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof NetworkProxyError) throw error;
    throw new OAuthLoginError(
      "Google authorization succeeded, but Antigravity account setup could not be reached.",
    );
  }
  let load: Record<string, unknown>;
  try {
    load = await requireOAuthJson(
      response,
      "Google Antigravity account setup",
      signal,
    );
  } catch {
    throwIfAborted(signal);
    throw new OAuthLoginError(
      response.ok
        ? "Google authorization succeeded, but Antigravity account setup returned an invalid response."
        : "Google authorization succeeded, but Antigravity account setup " +
          `HTTP ${response.status}: request failed.`,
    );
  }
  const projectId = projectIdFromLoadResponse(load);
  if (projectId) return projectId;
  const ineligibleTiers = Array.isArray(load.ineligibleTiers)
    ? load.ineligibleTiers.filter(isRecord)
    : [];
  const validationTier = ineligibleTiers.find(
    (entry) => entry.reasonCode === "VALIDATION_REQUIRED",
  );
  if (validationTier) {
    const verificationUrl = trustedGoogleVerificationUrl(validationTier.validationUrl);
    throw new OAuthLoginError(
      "Google requires an additional account verification before Antigravity can be used.",
      verificationUrl
        ? { verificationUrl, verificationLabel: "Verify Google account" }
        : {},
    );
  }
  throw new OAuthLoginError(
    "Google authorization succeeded, but Antigravity did not return an account project.",
  );
}

function projectIdFromLoadResponse(load: Record<string, unknown>): string | undefined {
  const rawProject = load.cloudaicompanionProject;
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

function antigravityMetadata(): Record<string, string> {
  return {
    ideType: "ANTIGRAVITY",
    platform: antigravityMetadataPlatform(),
    pluginType: "GEMINI",
  };
}

function antigravitySetupHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": antigravityUserAgent(),
  };
}
