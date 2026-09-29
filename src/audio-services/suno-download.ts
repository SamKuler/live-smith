import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { createHostAbortController } from "../runtime/host.js";
import type { AudioDownloadAuthorization } from "./contracts.js";
import type { createSunoHttp } from "./suno-http.js";
import { sunoActive, sunoObject, sunoUuid } from "./suno-catalog.js";

type SunoHttp = ReturnType<typeof createSunoHttp>;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Private preparation locator, never a playable URL or a download authorization. */
export function sunoDownloadPath(clipId: string): string {
  return `/api/download/clip/${clipId}?format=mp3`;
}

async function downloadUnlocked(http: SunoHttp, clipId: string, signal: AbortSignal): Promise<boolean> {
  const clips = await http.request("GET", `/api/feed/?ids=${clipId}`, undefined, signal);
  if (!Array.isArray(clips) || clips.length !== 1) throw http.fail("download source is unavailable.");
  const clip = sunoObject(clips[0], http);
  if (sunoUuid(clip.id, http) !== clipId || clip.status !== "complete") {
    throw http.fail("download source is not complete or does not match.");
  }
  if (typeof clip.is_download_unlocked !== "boolean") {
    throw http.fail("song download permission is unavailable. Check its download access on Suno.com, then retry Download for this song.");
  }
  return clip.is_download_unlocked;
}

/** Download permission is separate from generation completion and credits. */
export async function downloadSunoClip(
  http: SunoHttp, clipId: string, signal: AbortSignal, authorizeDownload = false,
  authorization?: AudioDownloadAuthorization,
  authorizationClipId = clipId,
): Promise<Uint8Array> {
  sunoActive(signal, http);
  sunoUuid(clipId, http);
  sunoUuid(authorizationClipId, http);
  const controller = createHostAbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DOWNLOAD_TIMEOUT_MS);
  try {
    sunoActive(signal, http);
    if (!await downloadUnlocked(http, authorizationClipId, controller.signal)) {
      if (authorizeDownload !== true) {
        throw http.fail("song download is locked. Use Download for this song and confirm its download allowance use.");
      }
      // One explicit allowance use, outside the preparation polling loop. An
      // absent/failed receipt or unconfirmed permission must never replay it.
      const authorize = () => http.request("POST", "/api/download/authorize", {
        item_id: authorizationClipId, item_type: "clip",
      }, controller.signal);
      const receipt = sunoObject(await (authorization ? authorization(controller.signal, authorize) : authorize()), http);
      if (receipt.ok !== true) throw http.fail("song download authorization was not confirmed. Check its download access on Suno.com before explicitly retrying Download for this song; no automatic retry was attempted.");
      if (!await downloadUnlocked(http, authorizationClipId, controller.signal)) {
        throw http.fail("song download remains locked after authorization. Check its download access on Suno.com before explicitly retrying Download for this song; no automatic retry was attempted.");
      }
    }
    // Suno's web downloader resolves an authorized MP3 through this exact route.
    // Never use the playback URL or start a conversion.
    for (;;) {
      const prepared = sunoObject(await http.request("GET", sunoDownloadPath(clipId), undefined, controller.signal), http);
      if (prepared.ok !== true) throw http.fail("song download preparation was rejected. Check its download access on Suno.com, then retry Download for this song.");
      if (prepared.status === "ready") return await http.download(http.outputUrl(prepared.download_url), controller.signal);
      if (prepared.status !== "processing") throw http.fail("song download preparation failed or returned an unsupported status. Retry Download for this song.");
      await delay(2_000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    sunoActive(signal, http);
    if (timedOut) throw http.fail("song download timed out; its authorization outcome may be unknown. Retry Download for this song to recheck access without generating again.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
