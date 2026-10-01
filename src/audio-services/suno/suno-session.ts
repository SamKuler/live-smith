import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../../runtime/host.js";
import { readAudioResponseBytes } from "../response-bytes.js";
import type { SunoSessionIdentity, SunoSessionVerifier } from "./suno-session-contracts.js";

const CLERK_BASE = "https://auth.suno.com/v1/client";
const CLERK_QUERY = "?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const LEGACY_TOUCH_BASE = "https://clerk.suno.com/v1/client";
const LEGACY_TOUCH_QUERY = "?__clerk_api_version=2025-04-10&_clerk_js_version=5.103.1";
const CLIENT_URL = `${CLERK_BASE}${CLERK_QUERY}`;
const MAX_INPUT_LENGTH = 16_384;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TOKEN_LIFETIME_MS = 65 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COOKIE_NAME = /^(?:__client|__session|__client_uat(?:_[A-Za-z0-9_-]{1,64})?|ajs_anonymous_id)$/u;
const UAT_NAME = /^__client_uat(?:_[A-Za-z0-9_-]{1,64})?$/u;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ParsedSunoCredential {
  sessionValue: string;
  cookieHeader: string;
  clientToken?: string;
  sessionToken?: string;
  deviceId?: string;
}

export interface ResolvedSunoSession extends SunoSessionIdentity {
  sessionId: string;
  accessToken: string;
  sessionValue: string;
  deviceId: string;
  expiresAt: number;
}

export class SunoSessionExpiredError extends Error {
  constructor() {
    super("The Suno session has expired or signed out. Import a current Suno session again.");
    this.name = "SunoSessionExpiredError";
  }
}

export class SunoSessionUnavailableError extends Error {
  constructor() {
    super("Suno session verification is unavailable. Try again or import a current Suno session.");
    this.name = "SunoSessionUnavailableError";
  }
}

export class SunoSessionTimeoutError extends Error {
  constructor() {
    super("Suno session verification timed out.");
    this.name = "SunoSessionTimeoutError";
  }
}

/** Keeps only the Suno/Clerk fields required by either supported session flow. */
export function normalizeSunoSessionValue(value: unknown): string {
  return parseCredential(value).sessionValue;
}

/** Individual values are private redaction inputs; never expose this list to UI state. */
export function sunoSessionSecrets(value: unknown): string[] {
  const parsed = parseCredential(value);
  return [parsed.sessionValue, parsed.clientToken, parsed.sessionToken, parsed.deviceId]
    .filter((entry): entry is string => Boolean(entry));
}

/** Shared private-record boundary: copy only bounded, credential-free identity. */
export function normalizeSunoSessionIdentity(value: unknown, secret: string): SunoSessionIdentity {
  const input = object(value);
  const secrets = sunoSessionSecrets(secret);
  const accountId = identifier(input.accountId);
  const accountName = name(input.accountName, secrets);
  if (secrets.some((value) => accountId.includes(value))) {
    throw new SunoSessionUnavailableError();
  }
  return { accountId, ...(accountName ? { accountName } : {}) };
}

export function createSunoSessionVerifier(injected?: typeof fetch): SunoSessionVerifier {
  const resolve = createSunoSessionResolver(injected);
  return async (sessionValue, signal) => {
    const normalized = normalizeSunoSessionValue(sessionValue);
    const { sessionId: _sessionId, accessToken: _accessToken, deviceId: _deviceId, expiresAt: _expiresAt,
      sessionValue: refreshed, ...identity } =
      await resolve(normalized, signal);
    return { ...identity, ...(refreshed === normalized ? {} : { sessionValue: refreshed }) };
  };
}

/** Private HTTP boundary used by connection verification and the website adapter. */
export function createSunoSessionResolver(injected?: typeof fetch): (
  sessionValue: string, signal: AbortSignal,
) => Promise<ResolvedSunoSession> {
  const fetchJson = createClerkJsonReader(injected);
  return async (sessionValue, signal) => {
    active(signal);
    const credential = parseCredential(sessionValue);
    if (credential.sessionToken) {
      const imported = sessionClaims(credential.sessionToken);
      const candidates = [
        { url: `${CLERK_BASE}/sessions/${imported.sessionId}/touch${CLERK_QUERY}`,
          body: "__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0&active_organization_id=" },
        { url: `${LEGACY_TOUCH_BASE}/sessions/${imported.sessionId}/touch${LEGACY_TOUCH_QUERY}`,
          body: "__clerk_api_version=2025-04-10&_clerk_js_version=5.103.1&active_organization_id=" },
      ];
      let result: Awaited<ReturnType<typeof fetchJson>> | undefined;
      for (const candidate of candidates) {
        try {
          result = await fetchJson(candidate.url, {
            method: "POST", body: candidate.body,
            headers: { Cookie: credential.cookieHeader, Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded", Origin: "https://suno.com", Referer: "https://suno.com/" },
          }, signal);
          break;
        } catch (error) {
          if (!(error instanceof SunoSessionUnavailableError) || candidate === candidates.at(-1)) throw error;
        }
      }
      if (!result) throw new SunoSessionUnavailableError();
      const response = optionalObject(result.body.response) ?? object(result.body);
      const token = object(response.last_active_token).jwt;
      if (typeof token !== "string") throw new SunoSessionUnavailableError();
      const claims = validatedAccessToken(token, imported.accountId, imported.sessionId);
      const identity = touchIdentity(response, claims.accountId, claims.sessionId, credential.sessionValue);
      const refreshed = ensureDeviceCredential(refreshSessionCredential(credential, token, result.response));
      return { ...identity, sessionId: claims.sessionId, accessToken: token,
        sessionValue: refreshed.sessionValue, deviceId: refreshed.deviceId!, expiresAt: claims.expiresAt };
    }

    const clientToken = credential.clientToken!;
    const clientResult = await fetchJson(CLIENT_URL, {
      method: "GET", headers: { Authorization: clientToken, Cookie: credential.cookieHeader,
        Accept: "application/json", Origin: "https://suno.com", Referer: "https://suno.com/" },
    }, signal);
    const identity = clientIdentity(clientResult.body, credential.sessionValue);
    const tokenUrl = `${CLERK_BASE}/sessions/${identity.sessionId}/tokens${CLERK_QUERY}`;
    const tokenResult = await fetchJson(tokenUrl, {
      method: "POST", body: "", headers: { Authorization: clientToken, Cookie: credential.cookieHeader,
        Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://suno.com", Referer: "https://suno.com/" },
    }, signal);
    const token = object(tokenResult.body).jwt;
    if (typeof token !== "string") throw new SunoSessionUnavailableError();
    const claims = validatedAccessToken(token, identity.accountId, identity.sessionId);
    const refreshed = ensureDeviceCredential(credential);
    return { ...identity, accessToken: token, sessionValue: refreshed.sessionValue,
      deviceId: refreshed.deviceId!, expiresAt: claims.expiresAt };
  };
}

function parseCredential(value: unknown): ParsedSunoCredential {
  const invalid = () => new Error("Enter a Suno __client or __session Cookie value, or a Suno Cookie header containing one of them.");
  if (typeof value !== "string" || !value.trim() || value.length > MAX_INPUT_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  let input = value.trim();
  if (/^cookie\s*:/iu.test(input)) input = input.replace(/^cookie\s*:/iu, "").trim();
  if (!input.includes("=") && isJwt(input)) {
    input = `${looksLikeSessionJwt(input) ? "__session" : "__client"}=${input}`;
  }
  const cookies = new Map<string, string>();
  for (const raw of input.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) throw invalid();
    const cookieName = part.slice(0, separator);
    const cookieValue = part.slice(separator + 1);
    if (cookieName !== cookieName.trim() || cookieValue !== cookieValue.trim()) throw invalid();
    if (!COOKIE_NAME.test(cookieName)) continue;
    if (!cookieValue || cookieValue.length > MAX_TOKEN_LENGTH || /[\s;,\u0000-\u001f\u007f]/u.test(cookieValue) || cookies.has(cookieName)) throw invalid();
    cookies.set(cookieName, cookieValue);
  }
  const clientToken = cookies.get("__client");
  const sessionToken = cookies.get("__session");
  if (!clientToken && !sessionToken) throw invalid();
  if (clientToken && !isJwt(clientToken)) throw invalid();
  if (sessionToken) sessionClaims(sessionToken, invalid);
  for (const [cookieName, cookieValue] of cookies) {
    if (UAT_NAME.test(cookieName) && !/^\d{1,20}$/u.test(cookieValue)) throw invalid();
  }
  const rawDevice = cookies.get("ajs_anonymous_id");
  const deviceId = rawDevice ? normalizeDeviceId(rawDevice) : undefined;
  if (rawDevice && !deviceId) cookies.delete("ajs_anonymous_id");
  const cookieHeader = canonicalCookieHeader(cookies);
  return { sessionValue: cookieHeader, cookieHeader, ...(clientToken ? { clientToken } : {}),
    ...(sessionToken ? { sessionToken } : {}), ...(deviceId ? { deviceId } : {}) };
}

function canonicalCookieHeader(cookies: ReadonlyMap<string, string>): string {
  const names = [...cookies.keys()].sort((left, right) => cookieOrder(left) - cookieOrder(right) || left.localeCompare(right));
  return names.map((cookieName) => `${cookieName}=${cookies.get(cookieName)}`).join("; ");
}

function cookieOrder(cookieName: string): number {
  return cookieName === "__session" ? 0 : cookieName === "__client" ? 1 : cookieName === "__client_uat" ? 2
    : cookieName.startsWith("__client_uat_") ? 3 : 4;
}

function normalizeDeviceId(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value).trim().replace(/^(["'])(.*)\1$/u, "$2");
    return DEVICE_ID.test(decoded) ? decoded.toLowerCase() : undefined;
  } catch { return undefined; }
}

function isJwt(value: string): boolean {
  if (value.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) return false;
  return value.split(".").every((part) => Buffer.from(part, "base64url").toString("base64url") === part);
}

function looksLikeSessionJwt(value: string): boolean {
  try {
    const payload = object(JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString("utf8")));
    return typeof payload.sid === "string" && typeof payload.sub === "string";
  } catch { return false; }
}

function sessionClaims(token: string, failure: () => Error = () => new SunoSessionUnavailableError()) {
  try {
    if (!isJwt(token)) throw new Error();
    const header = object(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")));
    const payload = object(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")));
    const accountId = identifier(payload.sub);
    const sessionId = identifier(payload.sid);
    if (header.alg !== "RS256" || !Number.isSafeInteger(payload.exp)) throw new Error();
    return { accountId, sessionId, expiresAt: (payload.exp as number) * 1000 };
  } catch { throw failure(); }
}

function validatedAccessToken(token: string, accountId: string, sessionId: string) {
  const claims = sessionClaims(token);
  const now = Date.now();
  if (claims.accountId !== accountId || claims.sessionId !== sessionId || claims.expiresAt <= now + 10_000 ||
      claims.expiresAt > now + MAX_TOKEN_LIFETIME_MS) throw new SunoSessionUnavailableError();
  return claims;
}

function refreshSessionCredential(credential: ParsedSunoCredential, token: string, response: Response): ParsedSunoCredential {
  const cookies = cookieMap(credential.cookieHeader);
  cookies.set("__session", token);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const matches = value.matchAll(/(?:^|,\s*)(__client_uat(?:_[A-Za-z0-9_-]{1,64})?|__client|__session)=([^;,\s]+)/gu);
    for (const match of matches) if (COOKIE_NAME.test(match[1]!)) cookies.set(match[1]!, match[2]!);
  }
  return parseCredential(canonicalCookieHeader(cookies));
}

function ensureDeviceCredential(credential: ParsedSunoCredential): ParsedSunoCredential & { deviceId: string } {
  if (credential.deviceId) return credential as ParsedSunoCredential & { deviceId: string };
  const cookies = cookieMap(credential.cookieHeader);
  cookies.set("ajs_anonymous_id", randomUUID());
  return parseCredential(canonicalCookieHeader(cookies)) as ParsedSunoCredential & { deviceId: string };
}

function cookieMap(cookieHeader: string): Map<string, string> {
  return new Map(cookieHeader.split("; ").map((part) => part.split(/=(.*)/su).slice(0, 2) as [string, string]));
}

function createClerkJsonReader(injected?: typeof fetch) {
  return async (url: string, init: RequestInit, signal: AbortSignal): Promise<{ body: Record<string, unknown>; response: Response }> => {
    active(signal);
    const controller = createHostAbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      const pending = Promise.resolve(resolveFetchImplementation(injected)(url, {
        ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
      }));
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      active(controller.signal);
      if (response.redirected || (response.url && response.url !== url)) throw new SunoSessionUnavailableError();
      if (response.status === 401) throw new SunoSessionExpiredError();
      if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new SunoSessionUnavailableError();
      }
      const bytes = await readAudioResponseBytes(response, {
        maximumBytes: 64 * 1024, signal: controller.signal, active, fail: () => new SunoSessionUnavailableError(),
      });
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateJson(parsed);
      const body = object(parsed);
      return { body, response };
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      active(signal);
      if (error instanceof SunoSessionExpiredError) throw new SunoSessionExpiredError();
      if (timedOut) throw new SunoSessionTimeoutError();
      throw new SunoSessionUnavailableError();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

function validateJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || entry.depth > 16) throw new SunoSessionUnavailableError();
    if (entry.value === null || typeof entry.value === "string" || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) continue;
    if (typeof entry.value !== "object") throw new SunoSessionUnavailableError();
    const prototype = Object.getPrototypeOf(entry.value);
    if (!Array.isArray(entry.value) && prototype !== Object.prototype && prototype !== null) throw new SunoSessionUnavailableError();
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new SunoSessionUnavailableError();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

function active(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Suno session verification was cancelled.");
  error.name = "AbortError";
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SunoSessionUnavailableError();
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : object(value);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new SunoSessionUnavailableError();
  return value;
}

function name(value: unknown, secrets: string | readonly string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const privateValues = typeof secrets === "string" ? [secrets] : secrets;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      privateValues.some((secret) => value.includes(secret))) throw new SunoSessionUnavailableError();
  return value.trim().slice(0, 160).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() || undefined;
}

function clientIdentity(value: unknown, secret: string): SunoSessionIdentity & { sessionId: string } {
  const client = object(object(value).response);
  if (client.object !== "client" || !Array.isArray(client.sessions)) throw new SunoSessionUnavailableError();
  if (client.last_active_session_id === null) throw new SunoSessionExpiredError();
  const selectedId = identifier(client.last_active_session_id);
  const matches = client.sessions.filter((entry: unknown) => object(entry).id === selectedId);
  if (!matches.length) throw new SunoSessionExpiredError();
  if (matches.length !== 1) throw new SunoSessionUnavailableError();
  const session = object(matches[0]);
  if (session.object !== "session") throw new SunoSessionUnavailableError();
  if (["expired", "revoked", "ended", "removed", "abandoned"].includes(String(session.status))) throw new SunoSessionExpiredError();
  if (session.status !== "active" || typeof session.expire_at !== "number" || !Number.isSafeInteger(session.expire_at)) {
    throw new SunoSessionUnavailableError();
  }
  if (session.expire_at <= Date.now()) throw new SunoSessionExpiredError();
  const user = object(session.user);
  if (user.object !== "user") throw new SunoSessionUnavailableError();
  const fullName = [name(user.first_name, secret), name(user.last_name, secret)].filter(Boolean).join(" ");
  const accountName = fullName || name(user.username, secret);
  return { ...normalizeSunoSessionIdentity({ accountId: user.id, accountName }, secret), sessionId: selectedId };
}

function touchIdentity(response: Record<string, unknown>, accountId: string, sessionId: string, secret: string): SunoSessionIdentity {
  if (response.object !== undefined && response.object !== "session") throw new SunoSessionUnavailableError();
  if (response.id !== undefined && response.id !== sessionId) throw new SunoSessionUnavailableError();
  if (["expired", "revoked", "ended", "removed", "abandoned"].includes(String(response.status))) throw new SunoSessionExpiredError();
  if (response.status !== undefined && response.status !== "active") throw new SunoSessionUnavailableError();
  const user = optionalObject(response.user);
  if (!user) return { accountId };
  if (user.object !== "user" || user.id !== accountId) throw new SunoSessionUnavailableError();
  const fullName = [name(user.first_name, secret), name(user.last_name, secret)].filter(Boolean).join(" ");
  const accountName = fullName || name(user.username, secret);
  return normalizeSunoSessionIdentity({ accountId, accountName }, secret);
}
