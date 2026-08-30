import { setTimeout as delay } from "node:timers/promises";

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
  decodeJwtPayload,
  formBody,
  isRecord,
  requireOAuthJson,
} from "./oauth-utils.js";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const authBaseUrl = "https://auth.openai.com";
const deviceUserCodeUrl = `${authBaseUrl}/api/accounts/deviceauth/usercode`;
const deviceTokenUrl = `${authBaseUrl}/api/accounts/deviceauth/token`;
const deviceVerificationUrl = `${authBaseUrl}/codex/device`;
const tokenUrl = `${authBaseUrl}/oauth/token`;
const deviceRedirectUri = `${authBaseUrl}/deviceauth/callback`;
const deviceTimeoutMs = 15 * 60 * 1_000;
const jwtAuthClaim = "https://api.openai.com/auth";

export interface OpenAIOAuthAdapterOptions {
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createOpenAIOAuthAdapter(
  options: OpenAIOAuthAdapterOptions = {},
): OAuthProviderAdapter {
  const fetchImpl = resolveFetchImplementation(options.fetchImpl);
  const wait = options.wait ?? ((milliseconds, signal) =>
    waitForPromiseWithSignal(delay(milliseconds), signal));
  return {
    provider: "openai",
    displayName: "ChatGPT",
    beginLogin: (signal) => beginDeviceLogin(fetchImpl, wait, signal),
    async refresh(credential, signal) {
      if (credential.provider !== "openai") {
        throw new Error("OpenAI OAuth received another provider's credential.");
      }
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: clientId,
        }),
        signal,
      });
      const value = await requireOAuthJson(response, "OpenAI OAuth refresh", signal);
      return refreshedOpenAICredential(value, credential);
    },
    authState(credential) {
      if (credential.provider !== "openai") {
        throw new Error("OpenAI OAuth received another provider's credential.");
      }
      return {
        status: "signed-in",
        accountLabel: accountLabel(credential.accessToken) ?? credential.accountId,
        planType: "ChatGPT subscription",
        subscriptionEligible: true,
      };
    },
  };
}

function refreshedOpenAICredential(
  value: Record<string, unknown>,
  previous: Extract<OAuthCredential, { provider: "openai" }>,
): OAuthCredential {
  return openAICredentialFromResponse(value, "OpenAI OAuth refresh", previous);
}

function openAITokenExpiry(
  accessToken: string,
  idToken: string | undefined,
  expiresIn: unknown,
): number {
  if (typeof expiresIn === "number") {
    return Date.now() + Math.floor(expiresIn * 1_000);
  }
  for (const token of [accessToken, idToken]) {
    if (!token) continue;
    const expirationSeconds = decodeJwtPayload(token)?.exp;
    if (typeof expirationSeconds === "number" &&
      Number.isSafeInteger(expirationSeconds) && expirationSeconds > 0) {
      return expirationSeconds * 1_000;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

async function beginDeviceLogin(
  fetchImpl: typeof fetch,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<OAuthLoginAttempt> {
  const controller = createHostAbortController();
  const relayAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", relayAbort, { once: true });
  if (signal.aborted) relayAbort();
  const response = await fetchImpl(deviceUserCodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
    signal: controller.signal,
  });
  const value = await requireOAuthJson(
    response,
    "OpenAI device authorization",
    controller.signal,
  );
  const deviceAuthId = value.device_auth_id;
  const userCode = value.user_code;
  const intervalSeconds = typeof value.interval === "string"
    ? Number(value.interval)
    : value.interval;
  if (typeof deviceAuthId !== "string" || !deviceAuthId ||
    typeof userCode !== "string" || !userCode ||
    typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 0) {
    throw new Error("OpenAI device authorization returned invalid data.");
  }
  const completion = completeDeviceLogin(
    fetchImpl,
    wait,
    { deviceAuthId, userCode, intervalMilliseconds: intervalSeconds * 1_000 },
    controller.signal,
  ).finally(() => signal.removeEventListener("abort", relayAbort));
  return {
    pending: {
      status: "pending",
      verificationUrl: deviceVerificationUrl,
      userCode,
    },
    completion,
    cancel(reason) {
      controller.abort(reason ?? new Error("OpenAI sign-in was canceled."));
    },
  };
}

async function completeDeviceLogin(
  fetchImpl: typeof fetch,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  device: {
    deviceAuthId: string;
    userCode: string;
    intervalMilliseconds: number;
  },
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const deadline = Date.now() + deviceTimeoutMs;
  for (;;) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      throw new Error("OpenAI device authorization expired.");
    }
    if (device.intervalMilliseconds > 0) {
      await wait(device.intervalMilliseconds, signal);
    }
    const response = await fetchImpl(deviceTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
      signal,
    });
    if (response.status === 403 || response.status === 404) {
      response.body?.cancel().catch(() => undefined);
      continue;
    }
    const value = await requireOAuthJson(response, "OpenAI device authorization", signal);
    if (typeof value.authorization_code !== "string" ||
      typeof value.code_verifier !== "string") {
      throw new Error("OpenAI device authorization returned invalid completion data.");
    }
    const tokenResponse = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        client_id: clientId,
        code: value.authorization_code,
        code_verifier: value.code_verifier,
        redirect_uri: deviceRedirectUri,
      }),
      signal,
    });
    return openAICredentialFromResponse(
      await requireOAuthJson(tokenResponse, "OpenAI token exchange", signal),
      "OpenAI token exchange",
    );
  }
}

function openAICredentialFromResponse(
  value: Record<string, unknown>,
  label: string,
  previous?: Extract<OAuthCredential, { provider: "openai" }>,
): OAuthCredential {
  if (typeof value.access_token !== "string" || !value.access_token ||
    (value.refresh_token !== undefined &&
      (typeof value.refresh_token !== "string" || !value.refresh_token)) ||
    (value.id_token !== undefined &&
      (typeof value.id_token !== "string" || !value.id_token)) ||
    (value.expires_in !== undefined &&
      (typeof value.expires_in !== "number" ||
        !Number.isFinite(value.expires_in) || value.expires_in <= 0))) {
    throw new Error(`${label} returned an invalid token response.`);
  }
  const refreshToken = typeof value.refresh_token === "string"
    ? value.refresh_token
    : previous?.refreshToken;
  if (!refreshToken) throw new Error(`${label} returned an invalid token response.`);
  const idToken = typeof value.id_token === "string" ? value.id_token : undefined;
  const accountId = openAIAccountId(idToken) ??
    openAIAccountId(value.access_token) ??
    previous?.accountId;
  if (!accountId) {
    throw new Error("OpenAI OAuth token did not contain a ChatGPT account identity.");
  }
  return {
    provider: "openai",
    accessToken: value.access_token,
    refreshToken,
    expiresAt: openAITokenExpiry(value.access_token, idToken, value.expires_in),
    accountId,
  };
}

function openAIAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const payload = decodeJwtPayload(token);
  const auth = isRecord(payload?.[jwtAuthClaim]) ? payload[jwtAuthClaim] : undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

function accountLabel(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  return typeof payload?.email === "string" && payload.email
    ? payload.email
    : null;
}
