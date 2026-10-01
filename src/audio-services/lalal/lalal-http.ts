import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  createHostAbortController,
  resolveFetchImplementation,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import { cancelStreamBestEffort } from "../../model/transports/stream-cancel.js";
import { MAX_AUDIO_ASSET_BYTES } from "../contracts.js";
import { readAudioResponseBytes } from "../response-bytes.js";

const API_BASE = "https://www.lalal.ai/api/v1/";
const MAX_JSON_BYTES = 64 * 1024;
const JSON_REQUEST_TIMEOUT_MS = 120_000;
const MEDIA_REQUEST_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_STOP_GRACE_MS = 3_000;

class LalalError extends Error {}

export function lalalError(message: string): Error {
  return new LalalError(`LALAL.AI audio service: ${message}`);
}

function abortedError(): Error {
  const error = lalalError("request cancelled.");
  error.name = "AbortError";
  return error;
}

export function assertLalalActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

/** This CDN is the output host in the official v1 OpenAPI examples. */
export function lalalOutputUrl(value: unknown, apiKey: string): string {
  if (typeof value !== "string" || value.length > 2048 ||
      /[\s\\]/u.test(value)) {
    throw lalalError("invalid output download URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
    const decoded = decodeURIComponent(value);
    if (decoded.toLowerCase().includes(apiKey.toLowerCase()) ||
        /[\u0000-\u001f\u007f]/u.test(decoded)) throw new Error();
  } catch {
    throw lalalError("invalid output download URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) ||
      url.hostname !== "d.lalal.ai" || url.port || url.username ||
      url.password || url.search || url.hash || url.pathname === "/") {
    throw lalalError("untrusted output download URL.");
  }
  // The official example uses HTTP. Never send even a first request in cleartext.
  url.protocol = "https:";
  return url.href;
}

export function createLalalHttp(apiKey: string, injected?: typeof fetch) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
    throw lalalError("a valid saved API key is required.");
  }
  // Resolve lazily: importing the extension must not require host Fetch/Abort.
  const request = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    maximumBytes: number,
    timeoutMs: number,
    preserveSubmitReceipt = false,
  ): Promise<Uint8Array> => {
    assertLalalActive(signal);
    const controller = createHostAbortController();
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // An accepted submit receipt lets the caller persist and cancel that task.
      // Stop bounds this last read without extending the original hard deadline.
      if (preserveSubmitReceipt) {
        stopTimer = setTimeout(() => controller.abort(), SUBMIT_STOP_GRACE_MS);
      } else {
        controller.abort();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response: Response | undefined;
    try {
      const pending = Promise.resolve(resolveFetchImplementation(injected)(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }));
      // A host/injected Fetch that settles after cancellation still owns a body.
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      if (response.redirected || (response.url && response.url !== url)) {
        throw lalalError("unexpected response redirect.");
      }
      if (response.status !== 200) {
        throw lalalError(`request failed (HTTP ${response.status}).`);
      }
      const bytes = await readAudioResponseBytes(response, {
        maximumBytes, signal: controller.signal, active: assertLalalActive, fail: lalalError,
      });
      assertLalalActive(controller.signal);
      return bytes;
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      if (signal.aborted) throw abortedError();
      if (timedOut) throw lalalError("request timed out; its remote outcome may be unknown.");
      if (error instanceof LalalError) throw error;
      // No reason phrase, response body, Fetch cause or abort reason crosses here.
      throw lalalError("request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
    }
  };

  return {
    async post(
      route: "upload/" | "split/multistem/" | "check/" | "cancel/",
      body: string | Uint8Array,
      signal: AbortSignal,
      filename?: "audio.wav" | "audio.mp3",
    ): Promise<Record<string, unknown>> {
      const preserveSubmitReceipt = route === "split/multistem/";
      const bytes = await request(`${API_BASE}${route}`, {
        method: "POST",
        headers: {
          "X-License-Key": apiKey,
          "Content-Type": filename ? "application/octet-stream" : "application/json",
          Accept: "application/json",
          ...(filename ? { "Content-Disposition": `attachment; filename=${filename}` } : {}),
        },
        body: typeof body === "string" ? body : Buffer.from(body),
      }, signal, MAX_JSON_BYTES, filename ? MEDIA_REQUEST_TIMEOUT_MS : JSON_REQUEST_TIMEOUT_MS, preserveSubmitReceipt);
      if (!preserveSubmitReceipt) assertLalalActive(signal);
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        validateJson(value);
        return lalalObject(value);
      } catch {
        throw lalalError("invalid JSON response.");
      }
    },
    async download(url: string, signal: AbortSignal): Promise<Uint8Array> {
      return request(lalalOutputUrl(url, apiKey), {
        method: "GET",
        headers: { Accept: "audio/wav, audio/mpeg, application/octet-stream" },
      }, signal, MAX_AUDIO_ASSET_BYTES, MEDIA_REQUEST_TIMEOUT_MS);
    },
  };
}

export function lalalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lalalError("invalid protocol response.");
  }
  return value as Record<string, unknown>;
}

/** Bound nested metadata too, even though only known fields leave this module. */
function validateJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || entry.depth > 16) throw new Error();
    if (typeof entry.value === "number" && !Number.isFinite(entry.value)) throw new Error();
    if (!entry.value || typeof entry.value !== "object") continue;
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
