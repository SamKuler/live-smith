import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import {
  createHostAbortController,
  resolveFetchImplementation,
  waitForPromiseWithSignal,
  yieldToHost,
} from "../runtime/host.js";
import type { OpenProviderWebSocket, ProviderWebSocketConnection } from "../runtime/proxy-websocket.js";
import { NetworkProxyError } from "../runtime/network-proxy-error.js";
import {
  DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL,
  GOOGLE_LYRIA_MUSIC_MODELS,
} from "./capabilities.js";
import {
  AudioSubmissionNotStartedError,
  MAX_AUDIO_ASSET_BYTES,
  type AudioGenerationAdapter,
  type AudioGenerationRequest,
} from "./contracts.js";
import { exceedsAudioPromptLimit } from "./prompt.js";
import { readAudioResponseBytes } from "./response-bytes.js";

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const LIVE_MUSIC_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
const BATCH_TIMEOUT_MS = 10 * 60_000;
const LIVE_TIMEOUT_MS = 10 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_INTERACTION_JSON_BYTES = Math.ceil(MAX_AUDIO_ASSET_BYTES / 3) * 4 + 1024 * 1024;
const MAX_LIVE_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_MESSAGES = 100_000;
const LIVE_SAMPLE_RATE = 48_000;
const LIVE_CHANNELS = 2;
const LIVE_BITS_PER_SAMPLE = 16;
const LIVE_FRAME_BYTES = LIVE_CHANNELS * LIVE_BITS_PER_SAMPLE / 8;
const DEFAULT_LIVE_DURATION_SECONDS = 30;

class GoogleLyriaError extends Error {}

export function createGoogleLyriaAudioAdapter(
  apiKey: string,
  options: {
    fetchImpl?: typeof fetch | undefined;
    openWebSocket?: OpenProviderWebSocket | undefined;
    modelId?: string | undefined;
  } = {},
): AudioGenerationAdapter {
  const fail = (detail: string): GoogleLyriaError =>
    new GoogleLyriaError(`Google Lyria audio service: ${detail}`);
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
    throw fail("a valid saved Gemini API key is required.");
  }
  const selectedModel = options.modelId ?? DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL;
  if (!GOOGLE_LYRIA_MUSIC_MODELS.includes(selectedModel as (typeof GOOGLE_LYRIA_MUSIC_MODELS)[number])) {
    throw fail("unsupported music model identifier.");
  }
  const model = selectedModel as (typeof GOOGLE_LYRIA_MUSIC_MODELS)[number];

  return {
    provider: "google-lyria",
    async submit(request, signal) {
      assertActive(signal, fail);
      validateRequest(request, model, fail);
      if (model === "lyria-realtime-exp") {
        if (!options.openWebSocket) throw fail("realtime WebSocket transport is unavailable.");
        const bytes = await generateRealtime(apiKey, request, options.openWebSocket, signal, fail);
        return { kind: "audio", outputs: [{ role: "music", bytes }] };
      }
      const bytes = await generateBatch(apiKey, model, request, options.fetchImpl, signal, fail);
      return { kind: "audio", outputs: [{ role: "music", bytes }] };
    },
  };
}

function validateRequest(
  request: AudioGenerationRequest,
  model: string,
  fail: (detail: string) => GoogleLyriaError,
): asserts request is Extract<AudioGenerationRequest, { operation: "generate_music" }> {
  if (!request || request.operation !== "generate_music") throw fail("only music generation is supported.");
  if (request.options !== undefined) throw fail("custom music options are not supported.");
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.includes("\0") ||
      exceedsAudioPromptLimit(request.prompt, 4100)) {
    throw fail("music prompt must contain 1–4100 characters.");
  }
  if (typeof request.instrumental !== "boolean") throw fail("instrumental must be a boolean.");
  if (request.durationSeconds !== undefined &&
      (!Number.isFinite(request.durationSeconds) || request.durationSeconds < 3 || request.durationSeconds > 600)) {
    throw fail("music duration must be between 3 and 600 seconds.");
  }
  if (model === "lyria-3-clip-preview" && request.durationSeconds !== undefined && request.durationSeconds !== 30) {
    throw fail("lyria-3-clip-preview always generates 30 seconds.");
  }
  if (model === "lyria-realtime-exp" && !request.instrumental) {
    throw fail("lyria-realtime-exp supports instrumental generation only.");
  }
}

async function generateBatch(
  apiKey: string,
  model: "lyria-3.5" | "lyria-3-clip-preview",
  request: Extract<AudioGenerationRequest, { operation: "generate_music" }>,
  injected: typeof fetch | undefined,
  signal: AbortSignal,
  fail: (detail: string) => GoogleLyriaError,
): Promise<Uint8Array> {
  const controller = createHostAbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BATCH_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    const body = {
      model,
      input: batchPrompt(request, model),
      store: false,
      ...(model === "lyria-3.5" ? { response_format: { type: "audio" } } : {}),
    };
    const pending = Promise.resolve(resolveFetchImplementation(injected)(INTERACTIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }));
    void pending.then((late) => {
      if (controller.signal.aborted) cancelStreamBestEffort(late.body);
    }, () => undefined);
    response = await waitForPromiseWithSignal(pending, controller.signal);
    assertActive(controller.signal, fail);
    if (response.redirected || response.url && response.url !== INTERACTIONS_URL) {
      throw fail("unexpected response redirect.");
    }
    if (response.status !== 200) throw fail(`generation failed (HTTP ${response.status}).`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mime !== "application/json") throw fail("expected a JSON interaction response.");
    const bytes = await readAudioResponseBytes(response, {
      maximumBytes: MAX_INTERACTION_JSON_BYTES,
      signal: controller.signal,
      active: (activeSignal) => assertActive(activeSignal, fail),
      fail,
      preserveCompletedOnAbort: true,
    });
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return await interactionAudio(value, model, controller.signal, fail);
  } catch (error) {
    controller.abort();
    cancelStreamBestEffort(response?.body);
    assertActive(signal, fail);
    if (timedOut) throw fail("generation timed out; its remote outcome may be unknown.");
    if (error instanceof GoogleLyriaError || error instanceof NetworkProxyError) throw error;
    throw fail("generation request or response read failed; its remote outcome may be unknown.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function batchPrompt(
  request: Extract<AudioGenerationRequest, { operation: "generate_music" }>,
  model: "lyria-3.5" | "lyria-3-clip-preview",
): string {
  const guidance: string[] = [];
  if (request.instrumental) guidance.push("Instrumental only; do not include vocals.");
  if (model === "lyria-3.5" && request.durationSeconds !== undefined) {
    guidance.push(`Target duration: ${request.durationSeconds} seconds.`);
  }
  return guidance.length ? `${request.prompt}\n\n${guidance.join(" ")}` : request.prompt;
}

async function interactionAudio(
  value: unknown,
  model: "lyria-3.5" | "lyria-3-clip-preview",
  signal: AbortSignal,
  fail: (detail: string) => GoogleLyriaError,
): Promise<Uint8Array> {
  const interaction = protocolObject(value, fail);
  if (!Array.isArray(interaction.steps) || interaction.steps.length > 256) {
    throw fail("invalid interaction response.");
  }
  let selected: Record<string, unknown> | undefined;
  for (const rawStep of interaction.steps) {
    const step = protocolObject(rawStep, fail);
    if (step.type !== "model_output") continue;
    if (!Array.isArray(step.content) || step.content.length > 256) throw fail("invalid model output.");
    for (const rawContent of step.content) {
      const content = protocolObject(rawContent, fail);
      if (content.type === "audio") selected = content;
    }
  }
  if (!selected || typeof selected.data !== "string") throw fail("interaction returned no inline audio.");
  const mime = selected.mime_type;
  if (model === "lyria-3.5"
    ? mime !== "audio/wav" && mime !== "audio/mpeg" && mime !== "audio/mp3"
    : mime !== "audio/mpeg" && mime !== "audio/mp3") {
    throw fail("interaction returned an unsupported audio format.");
  }
  return decodeCanonicalBase64(selected.data, MAX_AUDIO_ASSET_BYTES, signal, fail);
}

async function generateRealtime(
  apiKey: string,
  request: Extract<AudioGenerationRequest, { operation: "generate_music" }>,
  openWebSocket: OpenProviderWebSocket,
  signal: AbortSignal,
  fail: (detail: string) => GoogleLyriaError,
): Promise<Uint8Array> {
  const controller = createHostAbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIVE_TIMEOUT_MS);
  let connection: ProviderWebSocketConnection | undefined;
  let completed = false;
  let playbackMayHaveStarted = false;
  try {
    const duration = request.durationSeconds ?? DEFAULT_LIVE_DURATION_SECONDS;
    const frames = Math.round(duration * LIVE_SAMPLE_RATE);
    const pcmBytes = frames * LIVE_FRAME_BYTES;
    if (!Number.isSafeInteger(pcmBytes) || pcmBytes < LIVE_FRAME_BYTES || pcmBytes + 44 > MAX_AUDIO_ASSET_BYTES) {
      throw fail("requested realtime audio exceeds the local asset limit.");
    }
    const pcm = Buffer.allocUnsafe(pcmBytes);
    let written = 0;
    connection = await openWebSocket(LIVE_MUSIC_URL, {
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      maximumMessageBytes: MAX_LIVE_MESSAGE_BYTES,
    });
    await connection.sendText(JSON.stringify({ setup: { model: "models/lyria-realtime-exp" } }));
    let messages = 0;
    while (true) {
      if (++messages > MAX_LIVE_MESSAGES) throw fail("realtime stream returned too many messages.");
      const message = liveMessage(await connection.receiveText(controller.signal), fail);
      if (message.warning !== undefined) continue;
      if (isProtocolObject(message.setupComplete)) break;
      throw fail("realtime setup returned an invalid response.");
    }
    await connection.sendText(JSON.stringify({
      clientContent: { weightedPrompts: [{ text: request.prompt, weight: 1 }] },
    }));
    // A failed send callback cannot prove whether PLAY reached the service.
    playbackMayHaveStarted = true;
    await connection.sendText(JSON.stringify({ playbackControl: "PLAY" }));

    while (written < pcmBytes) {
      if (++messages > MAX_LIVE_MESSAGES) throw fail("realtime stream returned too many messages.");
      const message = liveMessage(await connection.receiveText(controller.signal), fail);
      if (message.warning !== undefined) continue;
      if (message.filteredPrompt !== undefined) {
        protocolObject(message.filteredPrompt, fail);
        throw new AudioSubmissionNotStartedError(fail("prompt was rejected by the provider's safety filters.").message);
      }
      const serverContent = protocolObject(message.serverContent, fail);
      if (!Array.isArray(serverContent.audioChunks) || serverContent.audioChunks.length > 64) {
        throw fail("realtime stream returned invalid audio content.");
      }
      for (const rawChunk of serverContent.audioChunks) {
        const chunk = protocolObject(rawChunk, fail);
        if (chunk.mimeType !== undefined &&
            (typeof chunk.mimeType !== "string" || chunk.mimeType.length > 128 || !chunk.mimeType.toLowerCase().startsWith("audio/"))) {
          throw fail("realtime stream returned invalid audio content.");
        }
        if (typeof chunk.data !== "string") throw fail("realtime stream returned invalid audio content.");
        const decoded = await decodeCanonicalBase64(
          chunk.data,
          MAX_LIVE_MESSAGE_BYTES,
          controller.signal,
          fail,
        );
        const count = Math.min(decoded.byteLength, pcmBytes - written);
        pcm.set(decoded.subarray(0, count), written);
        written += count;
        if (written === pcmBytes) break;
      }
    }
    completed = true;
    try { await connection.sendText(JSON.stringify({ playbackControl: "STOP" })); } catch { /* complete PCM is owned */ }
    try { await connection.close(); } catch { /* complete PCM is owned */ }
    return waveFromPcm16(pcm, LIVE_SAMPLE_RATE, LIVE_CHANNELS);
  } catch (error) {
    if (completed) throw error;
    connection?.terminate();
    assertActive(signal, fail);
    if (!playbackMayHaveStarted && !(error instanceof AudioSubmissionNotStartedError)) {
      const message = error instanceof NetworkProxyError
        ? error.message
        : fail(timedOut
          ? "realtime setup timed out. No generation was submitted."
          : "realtime session failed before generation started. No generation was submitted.").message;
      throw new AudioSubmissionNotStartedError(message);
    }
    if (timedOut) throw fail("realtime generation timed out; its remote outcome may be unknown.");
    if (error instanceof GoogleLyriaError || error instanceof AudioSubmissionNotStartedError ||
        error instanceof NetworkProxyError) throw error;
    throw fail("realtime generation failed; its remote outcome may be unknown.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (!completed) connection?.terminate();
  }
}

function liveMessage(value: string, fail: (detail: string) => GoogleLyriaError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const message = protocolObject(parsed, fail);
    const fields = ["setupComplete", "serverContent", "filteredPrompt", "warning"]
      .filter((field) => Object.hasOwn(message, field));
    if (fields.length !== 1 || message.warning !== undefined && typeof message.warning !== "string") throw new Error();
    return message;
  } catch (error) {
    if (error instanceof GoogleLyriaError) throw error;
    throw fail("realtime stream returned invalid JSON.");
  }
}

function protocolObject(
  value: unknown,
  fail: (detail: string) => GoogleLyriaError,
): Record<string, unknown> {
  if (!isProtocolObject(value)) throw fail("invalid protocol response.");
  return value;
}

function isProtocolObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function decodeCanonicalBase64(
  value: string,
  maximumBytes: number,
  signal: AbortSignal,
  fail: (detail: string) => GoogleLyriaError,
): Promise<Uint8Array> {
  const maximumCharacters = Math.ceil(maximumBytes / 3) * 4;
  if (!value.length || value.length > maximumCharacters || value.length % 4 !== 0) {
    throw fail("audio data is invalid or exceeds the byte limit.");
  }
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) {
    padding = value.charCodeAt(value.length - 2) === 0x3d ? 2 : 1;
  }
  const contentLength = value.length - padding;
  let finalValue = -1;
  let nextYield = 256 * 1024;
  for (let index = 0; index < contentLength; index += 1) {
    finalValue = base64Sextet(value.charCodeAt(index));
    if (finalValue < 0) throw fail("audio data is not canonical base64.");
    if (index >= nextYield) {
      await yieldToHost(signal);
      nextYield = index + 256 * 1024;
    }
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) throw fail("audio data is not canonical base64.");
  }
  if ((padding === 2 && (finalValue & 0x0f) !== 0) ||
      (padding === 1 && (finalValue & 0x03) !== 0)) {
    throw fail("audio data is not canonical base64.");
  }
  const byteLength = value.length / 4 * 3 - padding;
  if (byteLength > maximumBytes) throw fail("audio data exceeds the byte limit.");
  return Buffer.from(value, "base64");
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function waveFromPcm16(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const headerBytes = 44;
  const output = Buffer.allocUnsafe(headerBytes + pcm.byteLength);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.byteLength - 8, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * LIVE_BITS_PER_SAMPLE / 8, 28);
  output.writeUInt16LE(channels * LIVE_BITS_PER_SAMPLE / 8, 32);
  output.writeUInt16LE(LIVE_BITS_PER_SAMPLE, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(pcm.byteLength, 40);
  output.set(pcm, headerBytes);
  return output;
}

function assertActive(signal: AbortSignal, fail: (detail: string) => GoogleLyriaError): void {
  if (!signal.aborted) return;
  const error = fail("request cancelled; remote generation may still complete.");
  error.name = "AbortError";
  throw error;
}
