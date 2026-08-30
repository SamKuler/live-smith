import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { URL, URLSearchParams } from "node:url";

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

export async function startLoopbackAuthorization(options: {
  port: number;
  path: string;
  expectedState: string;
  signal: AbortSignal;
  successMessage: string;
}): Promise<LoopbackAuthorization> {
  let settle!: (value: string) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<string>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  let server!: Server;
  let boundPort = options.port;
  const finish = (operation: () => void): void => {
    if (settled) return;
    settled = true;
    options.signal.removeEventListener("abort", onAbort);
    server.close();
    operation();
  };
  const onAbort = (): void => finish(() => {
    try {
      throwIfAborted(options.signal);
    } catch (error) {
      reject(error);
    }
  });
  server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "", `http://localhost:${boundPort}`);
      if (url.pathname !== options.path) {
        sendHtml(response, 404, "OAuth callback route not found.");
        return;
      }
      if (url.searchParams.get("state") !== options.expectedState) {
        sendHtml(response, 400, "OAuth state did not match.");
        return;
      }
      if (url.searchParams.has("error")) {
        sendHtml(response, 400, "OAuth authorization did not complete.");
        finish(() => reject(new Error("OAuth authorization did not complete.")));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        sendHtml(response, 400, "OAuth callback did not contain a code.");
        return;
      }
      sendHtml(response, 200, options.successMessage);
      finish(() => settle(code));
    } catch {
      sendHtml(response, 500, "OAuth callback could not be processed.");
    }
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectListen(new Error("OAuth callback server did not expose a TCP port."));
        return;
      }
      boundPort = address.port;
      resolve();
    });
  });
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  return {
    redirectUri: `http://localhost:${boundPort}${options.path}`,
    completion,
    cancel(reason = new Error("OAuth sign-in was canceled.")) {
      finish(() => reject(reason));
    },
  };
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

function sendHtml(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><title>Live Smith</title><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}
