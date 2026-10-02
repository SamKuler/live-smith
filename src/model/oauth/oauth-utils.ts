import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";
import { startOAuthLoopbackCallback } from "../../runtime/oauth-loopback.js";

import { readBoundedJsonResponse } from "../transports/response-body.js";
import { cancelStreamBestEffort } from "../transports/stream-cancel.js";
import { throwIfAborted } from "../../runtime/host.js";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface LoopbackAuthorization {
  redirectUri: string;
  completion: Promise<string>;
  cancel(reason?: unknown): void;
}

export function generatePkce(): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    verifier,
    challenge,
    state: randomBytes(16).toString("hex"),
  };
}

export async function startLoopbackAuthorization(options: Parameters<typeof startOAuthLoopbackCallback>[0]): Promise<LoopbackAuthorization> {
  const callback = await startOAuthLoopbackCallback(options);
  return { ...callback, completion: callback.completion.then(({ code }) => code) };
}

export async function requireOAuthJson(
  response: Response,
  label: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    cancelStreamBestEffort(response.body, signal?.reason);
    throwIfAborted(signal);
    throw new Error(`${label} HTTP ${response.status}: request failed`);
  }
  const value = await readBoundedJsonResponse(response, { label, ...(signal ? { signal } : {}) });
  if (!isRecord(value)) throw new Error(`${label} returned invalid JSON.`);
  return value;
}

export function tokensFromResponse(
  value: Record<string, unknown>,
  label: string,
): OAuthTokens {
  if (typeof value.access_token !== "string" || !value.access_token ||
    typeof value.refresh_token !== "string" || !value.refresh_token ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new Error(`${label} returned an invalid token response.`);
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: Date.now() + Math.floor(value.expires_in * 1_000),
  };
}

export function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
