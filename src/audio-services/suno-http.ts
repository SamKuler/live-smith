import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../runtime/host.js";
import { AudioSubmissionNotStartedError, MAX_AUDIO_ASSET_BYTES } from "./contracts.js";
import { readAudioResponseBytes } from "./response-bytes.js";
import { sunoErrorDiagnostic } from "./suno-errors.js";
import { createSunoSessionResolver, normalizeSunoSessionIdentity, normalizeSunoSessionValue, sunoSessionSecrets,
  SunoSessionExpiredError, SunoSessionTimeoutError } from "./suno-session.js";

const API_BASE = "https://studio-api-prod.suno.com";
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MEDIA_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_STOP_GRACE_MS = 3_000;
const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const FEED_IDS = new RegExp(`^/api/feed/\\?ids=${UUID}(?:,${UUID}){0,49}$`, "u");
const PERSONA = new RegExp(`^/api/persona/get-persona-paginated/${UUID}/\\?page=(?:0|[1-9][0-9]{0,3})$`, "u");
const DOWNLOAD = new RegExp(`^/api/download/clip/${UUID}\\?format=mp3$`, "u");
const DOWNLOAD_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Public response examples: https://github.com/serkansmg/SunoApiManager/blob/main/API.md
// The authorized MP3 preparation endpoint also returns signed URLs on this exact
// Suno bucket. No wildcard S3 hosts, playback endpoints or caller-selected APIs.
const AUDIO_HOSTS = new Set(["cdn1.suno.ai", "cdn2.suno.ai", "cdn.suno.ai", "suno-data-uploads.s3.amazonaws.com"]);

class SunoHttpError extends Error {}
export type SunoSessionRefreshHandler = (
  previousSessionValue: string, nextSessionValue: string, signal: AbortSignal,
) => void | Promise<void>;

/** Trusted local diagnostics only; network failures never supply their messages. */
function fail(detail: string): Error {
  return new SunoHttpError(`Suno.com audio service: ${detail}`);
}

function active(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = fail("request cancelled; remote generation may still complete.");
  error.name = "AbortError";
  throw error;
}

function browserToken(): string {
  const token = Buffer.from(JSON.stringify({ timestamp: Date.now() }), "utf8").toString("base64url");
  return JSON.stringify({ token });
}

function validateJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 32_768 || entry.depth > 32) throw fail("invalid protocol response.");
    if (entry.value === null || typeof entry.value === "string" || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) continue;
    if (typeof entry.value !== "object") throw fail("invalid protocol response.");
    const prototype = Object.getPrototypeOf(entry.value);
    if (!Array.isArray(entry.value) && prototype !== Object.prototype && prototype !== null) throw fail("invalid protocol response.");
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw fail("invalid protocol response.");
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateJson(value);
    return value;
  } catch { throw fail("invalid protocol response."); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid protocol response.");
  return value as Record<string, unknown>;
}

function allowedRoute(method: string, path: string): boolean {
  if (typeof path !== "string" || path.length > 4096 || /[\s\\]/u.test(path)) return false;
  if (method === "GET") return path === "/api/billing/info/" || FEED_IDS.test(path) || PERSONA.test(path) || DOWNLOAD.test(path);
  return method === "POST" && ["/api/feed/v3", "/api/c/check", "/api/generate/v2-web/", "/api/generate/concat/v2/",
    "/api/download/authorize"].includes(path);
}

export function createSunoHttp(
  session: { clientToken: string; accountId: string }, injected?: typeof fetch,
  onSessionRefresh?: SunoSessionRefreshHandler,
) {
  // Snapshot the exact admitted connection; never reload mutable settings here.
  let sessionValue: string;
  let accountId: string;
  try {
    sessionValue = normalizeSunoSessionValue(session.clientToken);
    accountId = normalizeSunoSessionIdentity({ accountId: session.accountId }, sessionValue).accountId;
    if (/[^A-Za-z0-9_-]/u.test(accountId)) throw new Error();
  } catch { throw fail("invalid saved session."); }
  const resolveSession = createSunoSessionResolver(injected);
  const credentialSecrets = new Set(sunoSessionSecrets(sessionValue));
  let boundSessionId: string | undefined;
  let deviceId = "00000000-0000-0000-0000-000000000000";
  let cached: { jwt: string; expiresAt: number } | undefined;

  const read = async (
    url: string, init: RequestInit, signal: AbortSignal, maximumBytes: number, timeoutMs: number, audio = false,
    preserveReceipt = false,
  ): Promise<Uint8Array> => {
    active(signal);
    let controller: AbortController;
    try { controller = createHostAbortController(); }
    catch { throw fail("request or response read failed; its remote outcome may be unknown."); }
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Once paid work is submitted, briefly retain its bounded receipt so the
      // caller can persist acknowledged IDs. Never extend the original deadline.
      if (preserveReceipt) stopTimer = setTimeout(() => controller.abort(), SUBMIT_STOP_GRACE_MS);
      else controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response: Response | undefined;
    let rejection: Error | undefined;
    try {
      const pending = Promise.resolve(resolveFetchImplementation(injected)(url, {
        ...init, signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      }));
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      active(controller.signal);
      if (response.redirected || (response.url && response.url !== url)) throw fail("unexpected response redirect.");
      if (response.status !== 200) {
        const summary = response.status === 401 ? "session expired; import a current Suno session."
          : response.status === 403 ? audio
          ? "audio download was denied. Retry Download for this song to request a fresh authorized download URL."
          : url.startsWith(`${API_BASE}/api/download/clip/`)
          ? "song download is not authorized. Check its download access on Suno.com, then retry Download for this song."
          : "access denied or verification required."
          : "request rejected.";
        const detail = `${summary} (HTTP ${response.status}); no automatic retry was attempted.`;
        // The rejection is already known. Optional diagnostics and cancellation
        // cannot replace it with a transport/unknown-outcome failure.
        rejection = fail(detail);
        const diagnostic = url.startsWith(`${API_BASE}/`) && !audio
          ? await sunoErrorDiagnostic(response, controller.signal, [...credentialSecrets, ...(cached ? [cached.jwt] : [])], init.body) : "";
        if (diagnostic) rejection = fail(`${detail} Provider diagnostic: ${diagnostic}`);
        throw rejection;
      }
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (audio ? !["audio/mpeg", "audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime ?? "") : mime !== "application/json") {
        throw fail("invalid protocol response.");
      }
      const bytes = await readAudioResponseBytes(response, {
        maximumBytes, signal: controller.signal, active, fail,
      });
      active(controller.signal);
      return bytes;
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      if (rejection) throw rejection;
      if (error instanceof AudioSubmissionNotStartedError) throw error;
      active(signal);
      if (timedOut) throw fail("request timed out; its remote outcome may be unknown.");
      if (error instanceof SunoHttpError) throw error;
      throw fail("request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
    }
  };

  const accessToken = async (signal: AbortSignal): Promise<string> => {
    active(signal);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return cached.jwt;
    cached = undefined;
    let identity: Awaited<ReturnType<typeof resolveSession>>;
    try { identity = await resolveSession(sessionValue, signal); }
    catch (error) {
      active(signal);
      if (error instanceof SunoSessionExpiredError) throw fail("session expired; import a current Suno session.");
      if (error instanceof SunoSessionTimeoutError) throw fail("session verification timed out.");
      throw fail("session verification failed.");
    }
    active(signal);
    if (identity.accountId !== accountId || /[^A-Za-z0-9_-]/u.test(identity.sessionId) ||
        (boundSessionId !== undefined && identity.sessionId !== boundSessionId)) {
      throw fail("active account or session changed; reconnect Suno.");
    }
    boundSessionId = identity.sessionId;
    const previousSessionValue = sessionValue;
    if (identity.sessionValue !== previousSessionValue && onSessionRefresh) {
      try { await onSessionRefresh(previousSessionValue, identity.sessionValue, signal); }
      catch {
        active(signal);
        throw fail("the refreshed session could not be saved; reconnect Suno.");
      }
    }
    sessionValue = identity.sessionValue;
    deviceId = identity.deviceId;
    for (const secret of [...sunoSessionSecrets(sessionValue), identity.accessToken]) credentialSecrets.add(secret);
    active(signal);
    cached = { jwt: identity.accessToken, expiresAt: identity.expiresAt };
    return identity.accessToken;
  };

  const outputUrl = (value: unknown): string => {
    try {
      if (typeof value !== "string" || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error();
      const url = new URL(value);
      const decoded = decodeURIComponent(value);
      if (url.protocol !== "https:" || !AUDIO_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash ||
          !value.startsWith(`https://${url.hostname}/`) || url.pathname === "/" ||
          /[\s\\\u0000-\u001f\u007f]/u.test(decoded) || [...credentialSecrets].some((secret) => decoded.includes(secret)) ||
          (cached && decoded.includes(cached.jwt))) throw new Error();
      return url.href;
    } catch { throw fail("untrusted audio URL."); }
  };

  return {
    fail,
    protectPrivateValue(value: string): void { credentialSecrets.add(value); },
    outputUrl,
    /** Validate the final bounded public projection while both credentials are private here. */
    publicResult<T>(value: T): T {
      const text = JSON.stringify(value);
      if ([...credentialSecrets].some((secret) => text.includes(secret)) || (cached && text.includes(cached.jwt))) {
        throw fail("credential-bearing public response.");
      }
      return value;
    },
    async request(method: "GET" | "POST", path: string, body: unknown | undefined, signal: AbortSignal,
      beforeSend?: () => void): Promise<unknown> {
      active(signal);
      if (!allowedRoute(method, path) || (method === "GET" && body !== undefined)) throw fail("request route or body is not allowed.");
      let encoded: string | undefined;
      try {
        if (body !== undefined) {
          validateJson(body);
          encoded = JSON.stringify(body);
          if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error();
        }
        if (path === "/api/download/authorize") {
          const item = object(encoded === undefined ? undefined : JSON.parse(encoded));
          if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "item_id") || !Object.hasOwn(item, "item_type") ||
              item.item_type !== "clip" || typeof item.item_id !== "string" || !DOWNLOAD_ITEM_ID.test(item.item_id)) throw new Error();
        }
      } catch { throw fail("request route or body is not allowed."); }
      const preserveReceipt = method === "POST" && ["/api/generate/v2-web/", "/api/generate/concat/v2/"].includes(path);
      let jwt: string;
      try {
        jwt = await accessToken(signal);
        active(signal);
        beforeSend?.();
      } catch (error) {
        if (preserveReceipt && !(error instanceof AudioSubmissionNotStartedError)) {
          const notStarted = new AudioSubmissionNotStartedError(error instanceof SunoHttpError ? error.message
            : "Suno.com audio service: preparation failed. No generation was submitted.");
          if (error instanceof SunoHttpError && error.name === "AbortError") notStarted.name = "AbortError";
          throw notStarted;
        }
        throw error;
      }
      try {
        return parseJson(await read(`${API_BASE}${path}`, {
          method, headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json",
            "Device-Id": deviceId, "Browser-Token": browserToken(), Origin: "https://suno.com", Referer: "https://suno.com/",
            ...(encoded !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(encoded !== undefined ? { body: encoded } : {}),
        }, signal, MAX_JSON_BYTES, REQUEST_TIMEOUT_MS, false, preserveReceipt));
      } catch (error) {
        // No automatic retry, even for auth failures or uncertain paid submissions.
        if (cached?.jwt === jwt) cached = undefined;
        throw error;
      }
    },
    async download(value: string, signal: AbortSignal): Promise<Uint8Array> {
      active(signal);
      return read(outputUrl(value), { method: "GET", headers: { Accept: "audio/mpeg, audio/wav, application/octet-stream" } },
        signal, MAX_AUDIO_ASSET_BYTES, MEDIA_TIMEOUT_MS, true);
    },
  };
}
