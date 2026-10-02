import { Blob, Buffer } from "node:buffer";
import { URL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { types } from "node:util";
import { MAX_AUDIO_ASSET_BYTES, type AudioAsset } from "../contracts.js";
import { createSunoHttp, type SunoSessionRefreshHandler } from "./suno-http.js";
import { createHostAbortController, resolveFetchImplementation, resolveHostFormData, throwIfAborted, waitForPromiseWithSignal } from "../../runtime/host.js";
import { cancelStreamBestEffort } from "../../model/transports/stream-cancel.js";

export interface SunoUploadSpec { uploadId: string; url: string; fields: Record<string, string> }
export interface SunoUploadAdapter {
  limits(signal: AbortSignal): Promise<{ minimumSeconds: number; maximumSeconds: number }>;
  create(mediaType: AudioAsset["mediaType"], signal: AbortSignal): Promise<SunoUploadSpec>;
  upload(spec: SunoUploadSpec, bytes: Uint8Array, mediaType: AudioAsset["mediaType"], signal: AbortSignal): Promise<void>;
  finish(uploadId: string, mediaType: AudioAsset["mediaType"], signal: AbortSignal): Promise<void>;
  inspect(uploadId: string, signal: AbortSignal): Promise<{ status: "processing" | "complete" | "failed" }>;
  initialize(uploadId: string, signal: AbortSignal): Promise<string>;
}

const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)) {
    throw new Error("Suno.com upload returned an invalid identifier.");
  }
  return value.toLowerCase();
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Suno.com upload returned an invalid response.");
  return value as Record<string, unknown>;
};
const extension = (mediaType: AudioAsset["mediaType"]) => mediaType === "audio/wav" ? "wav" : "mp3";

/** Website upload protocol; presigned transport values remain private to this adapter. */
export function createSunoUploadAdapter(session: { clientToken: string; accountId: string }, options: {
  fetchImpl?: typeof fetch; onSessionRefresh?: SunoSessionRefreshHandler;
} = {}): SunoUploadAdapter {
  const HostFormData = resolveHostFormData();
  const http = createSunoHttp(session, options.fetchImpl, options.onSessionRefresh);
  const route = (id: string, suffix = "") => `/api/uploads/audio/${identifier(id)}/${suffix}`;
  return {
    async limits(signal) {
      const body = record(await http.request("GET", "/api/billing/info/", undefined, signal));
      const limits = record(body.audio_upload_limits);
      if (typeof limits.min !== "number" || !Number.isFinite(limits.min) || limits.min < 0 ||
          typeof limits.max !== "number" || !Number.isFinite(limits.max) || limits.max <= 0 || limits.min > limits.max) {
        throw http.fail("audio upload limits are unavailable.");
      }
      return { minimumSeconds: limits.min, maximumSeconds: limits.max };
    },
    async create(mediaType, signal) {
      const value = record(await http.request("POST", "/api/uploads/audio/", {
        extension: extension(mediaType), is_stem_mix: false, upload_type: "file_upload",
      }, signal));
      const uploadId = identifier(value.id);
      const url = uploadUrl(value.url);
      const rawFields = record(value.fields);
      if (!Object.keys(rawFields).length || Object.keys(rawFields).length > 64 ||
          Buffer.byteLength(JSON.stringify(rawFields), "utf8") > 64 * 1024 ||
          Object.entries(rawFields).some(([name, value]) => !/^[A-Za-z0-9_.-]{1,128}$/u.test(name) ||
            typeof value !== "string" || /[\0\r\n]/u.test(value))) throw http.fail("invalid upload authorization.");
      http.protectPrivateValue(url);
      for (const value of Object.values(rawFields)) if (typeof value === "string" && value.length > 12) http.protectPrivateValue(value);
      return { uploadId: http.publicResult(uploadId), url, fields: rawFields as Record<string, string> };
    },
    async upload(spec, bytes, mediaType, signal) {
      if (!types.isUint8Array(bytes) || !bytes.byteLength || bytes.byteLength > MAX_AUDIO_ASSET_BYTES) throw http.fail("upload exceeds the host audio limit.");
      const url = uploadUrl(spec.url);
      const body = new HostFormData();
      for (const [name, value] of Object.entries(spec.fields)) body.append(name, value);
      // The host accepts Node Blobs; Node and DOM declarations differ on bytes().
      body.append("file", new Blob([bytes], { type: mediaType }) as globalThis.Blob, `audio.${extension(mediaType)}`);
      const controller = createHostAbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 10 * 60_000);
      signal.addEventListener("abort", abort, { once: true });
      let response: Response | undefined;
      try {
        throwIfAborted(signal);
        const pending = Promise.resolve(resolveFetchImplementation(options.fetchImpl)(url, {
          method: "POST", body, signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
        }));
        void pending.then((late) => { if (controller.signal.aborted) cancelStreamBestEffort(late.body); }, () => undefined);
        response = await waitForPromiseWithSignal(pending, controller.signal);
        if (response.redirected || response.url && response.url !== url || !response.ok) throw new Error();
      } catch { throw http.fail("storage upload did not return a confirmed result."); }
      finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort); cancelStreamBestEffort(response?.body);
      }
    },
    async finish(uploadId, mediaType, signal) {
      await http.request("POST", route(uploadId, "upload-finish/"), {
        upload_type: "file_upload", upload_filename: `audio.${extension(mediaType)}`,
      }, signal);
    },
    async inspect(uploadId, signal) {
      const value = record(await http.request("GET", route(uploadId), undefined, signal));
      if (value.status === "error" || value.copyright_muted === true) return { status: "failed" };
      if (value.status === "complete") return { status: "complete" };
      if (typeof value.status !== "string" || !value.status.length || value.status.length > 64) throw http.fail("invalid audio upload status.");
      return { status: "processing" };
    },
    async initialize(uploadId, signal) {
      const value = record(await http.request("POST", route(uploadId, "initialize-clip/"), {}, signal));
      return http.publicResult(identifier(value.clip_id));
    },
  };
}

function uploadUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error("Suno.com upload destination is unavailable.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Suno.com upload destination is unavailable."); }
  if (url.protocol !== "https:" || url.hostname !== "suno-data-uploads.s3.amazonaws.com" ||
      url.username || url.password || url.port || url.hash) throw new Error("Suno.com upload destination is unavailable.");
  return url.href;
}
