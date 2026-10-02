import { clearTimeout, setTimeout } from "node:timers";

import {
  createHostAbortController,
  resolveFetchImplementation,
  waitForPromiseWithSignal,
} from "../../runtime/host.js";
import { cancelStreamBestEffort } from "../../model/transports/stream-cancel.js";
import { NetworkProxyError } from "../../runtime/network-proxy-error.js";
import { MAX_AUDIO_ASSET_BYTES } from "../contracts.js";
import { readAudioResponseBytes } from "../response-bytes.js";

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
// Music auto-selects the format appropriate for its configured model. Sound
// effects retain the broadly available MP3 format accepted by the local parser.
const OUTPUT_FORMATS = { music: "auto", "sound-generation": "mp3_44100_128" } as const;

class ElevenLabsError extends Error {}

export function elevenLabsError(message: string): Error {
  return new ElevenLabsError(`ElevenLabs audio service: ${message}`);
}

export function assertElevenLabsActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = elevenLabsError("request cancelled; remote generation may still complete.");
  error.name = "AbortError";
  throw error;
}

export function createElevenLabsHttp(apiKey: string, injected?: typeof fetch) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
    throw elevenLabsError("a valid saved API key is required.");
  }
  return async (
    route: "music" | "sound-generation",
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    assertElevenLabsActive(signal);
    const controller = createHostAbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    const url = `https://api.elevenlabs.io/v1/${route}?output_format=${OUTPUT_FORMATS[route]}`;
    try {
      // Resolve only on submit: loading the extension needs no ambient Web APIs.
      // A paid POST is issued exactly once, including on an unknown remote outcome.
      const pending = Promise.resolve(resolveFetchImplementation(injected)(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }));
      // Even a Fetch that ignores abort may later return a response owning a body.
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      assertElevenLabsActive(controller.signal);
      if (response.redirected || (response.url && response.url !== url)) {
        throw elevenLabsError("unexpected response redirect.");
      }
      if (response.status !== 200) {
        throw elevenLabsError(`generation failed (HTTP ${response.status}).`);
      }
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mime !== "audio/mpeg") throw elevenLabsError("expected an MP3 audio response.");
      // The caller persists complete paid audio before honoring Stop at EOF.
      return await readAudioResponseBytes(response, {
        maximumBytes: MAX_AUDIO_ASSET_BYTES, signal: controller.signal,
        active: assertElevenLabsActive, fail: elevenLabsError, preserveCompletedOnAbort: true,
      });
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      assertElevenLabsActive(signal);
      if (timedOut) throw elevenLabsError("generation timed out; its remote outcome may be unknown.");
      if (error instanceof ElevenLabsError || error instanceof NetworkProxyError) throw error;
      // No response text, status phrase, transport cause or caller abort reason.
      throw elevenLabsError("generation request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}
