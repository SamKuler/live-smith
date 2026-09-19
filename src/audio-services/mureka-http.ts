import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../runtime/host.js";
import { MAX_AUDIO_ASSET_BYTES } from "./contracts.js";
import { readAudioResponseBytes } from "./response-bytes.js";

const API_BASE = "https://api.mureka.ai";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_REQUEST_JSON_NODES = 4096;
const JSON_TIMEOUT_MS = 120_000;
const MEDIA_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_STOP_GRACE_MS = 3_000;

class MurekaError extends Error {}

export type MurekaTaskKind = "song" | "instrumental";
export type MurekaSubmitKind = "prompt-song" | "lyrics-song" | "instrumental" | "lyrics";
const MUREKA_SUBMIT_PATHS: Readonly<Record<MurekaSubmitKind, string>> = {
  "prompt-song": "/v1/song/easy-generate",
  "lyrics-song": "/v1/song/generate",
  instrumental: "/v1/instrumental/generate",
  lyrics: "/v1/lyrics/generate",
};

export function createMurekaHttp(apiKey: string, injected?: typeof fetch) {
  const fail = (detail: string): Error => {
    // Every caller supplies fixed local text or a validated numeric status;
    // remote bodies, URLs, request data and transport causes never enter here.
    return new MurekaError(`Mureka audio service: ${detail}`);
  };
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
    throw fail("a valid saved API key is required.");
  }

  const active = (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    const error = fail("request cancelled; the remote task may still complete.");
    error.name = "AbortError";
    throw error;
  };

  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid protocol response.");
    return value as Record<string, unknown>;
  };

  const identifier = (value: unknown): string => {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) ||
        value.toLowerCase().includes(apiKey.toLowerCase())) {
      throw fail("invalid or credential-bearing task/audio identifier.");
    }
    return value;
  };

  const outputUrl = (value: unknown): string => {
    try {
      if (typeof value !== "string" || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error();
      const url = new URL(value);
      const decoded = decodeURIComponent(value);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash ||
          /[\s\\\u0000-\u001f\u007f]/u.test(decoded) || decoded.toLowerCase().includes(apiKey.toLowerCase())) throw new Error();
      return url.href;
    } catch { throw fail("invalid or credential-bearing output URL."); }
  };

  const request = async (
    url: string, init: RequestInit, signal: AbortSignal, maximumBytes: number, timeoutMs: number,
    acceptedStatuses: readonly number[], preserveReceipt = false,
  ): Promise<Uint8Array> => {
    active(signal);
    const controller = createHostAbortController();
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (preserveReceipt) stopTimer = setTimeout(() => controller.abort(), SUBMIT_STOP_GRACE_MS);
      else controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response: Response | undefined;
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
      if (!acceptedStatuses.includes(response.status)) throw fail(`request failed (HTTP ${response.status}).`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (maximumBytes === MAX_JSON_BYTES ? mime !== "application/json" :
          !["audio/mpeg", "audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime ?? "")) {
        throw fail("unexpected response media type.");
      }
      return await readAudioResponseBytes(response, {
        maximumBytes, signal: controller.signal, active, fail,
        ...(preserveReceipt ? { preserveCompletedOnAbort: true } : {}),
      });
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      active(signal);
      if (timedOut) throw fail("request timed out; its remote outcome may be unknown.");
      if (error instanceof MurekaError) throw error;
      throw fail("request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
    }
  };

  const json = async (
    method: "GET" | "POST", kind: MurekaTaskKind | MurekaSubmitKind, taskId: string | undefined,
    body: Record<string, unknown> | undefined, signal: AbortSignal, preserveReceipt = false,
  ): Promise<Record<string, unknown>> => {
    let encoded: string | undefined;
    let path: string;
    try {
      if (method === "POST") {
        if (taskId !== undefined || body === undefined) throw new Error();
        path = MUREKA_SUBMIT_PATHS[kind as MurekaSubmitKind];
        if (!path) throw new Error();
        validateJson(body, MAX_REQUEST_JSON_NODES);
        encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) throw new Error();
      } else {
        if (body !== undefined || taskId === undefined || kind !== "song" && kind !== "instrumental") {
          throw new Error();
        }
        path = `/v1/${kind}/query/${identifier(taskId)}`;
      }
    } catch { throw fail("request route or body is not allowed."); }
    const bytes = await request(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json",
        ...(encoded === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(encoded === undefined ? {} : { body: encoded }),
    }, signal, MAX_JSON_BYTES, JSON_TIMEOUT_MS, [200], preserveReceipt);
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(decoded);
      // Every traversed JSON value requires source text, so the decoded length
      // is a shape-independent upper bound that still admits word timestamps.
      validateJson(value, decoded.length);
      return object(value);
    } catch (error) {
      if (error instanceof MurekaError) throw error;
      throw fail("invalid JSON response.");
    }
  };

  return {
    fail, active, object, identifier, outputUrl,
    submit: (kind: MurekaSubmitKind, body: Record<string, unknown>, signal: AbortSignal) =>
      json("POST", kind, undefined, body, signal, true),
    inspect: (kind: MurekaTaskKind, taskId: string, signal: AbortSignal) =>
      json("GET", kind, taskId, undefined, signal),
    download: (url: string, signal: AbortSignal) => request(outputUrl(url), {
      method: "GET", headers: { Accept: "audio/mpeg, audio/wav, application/octet-stream" },
    }, signal, MAX_AUDIO_ASSET_BYTES, MEDIA_TIMEOUT_MS, [200]),
  };
}

function validateJson(value: unknown, maximumNodes: number): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > maximumNodes || entry.depth > 16) throw new Error();
    if (entry.value === null || typeof entry.value === "string" || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) continue;
    if (typeof entry.value !== "object") throw new Error();
    const prototype = Object.getPrototypeOf(entry.value);
    if (!Array.isArray(entry.value) && prototype !== Object.prototype && prototype !== null) throw new Error();
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
