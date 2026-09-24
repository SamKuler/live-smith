import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { inspectAudioAttachment } from "../attachments/audio.js";
import { AudioSubmissionNotStartedError, type AudioGenerationRequest } from "../audio-services/contracts.js";
import { createGoogleLyriaAudioAdapter } from "../audio-services/google-lyria.js";
import { createHostAbortController } from "../runtime/host.js";
import { NetworkProxyError } from "../runtime/network-proxy-error.js";
import type {
  OpenProviderWebSocket,
  OpenProviderWebSocketOptions,
  ProviderWebSocketConnection,
} from "../runtime/proxy-websocket.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";

const KEY = "fixture-google-lyria-key-only";
const URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
const MUSIC: AudioGenerationRequest = {
  operation: "generate_music",
  prompt: "  Luminous piano and strings 🌌\n",
  instrumental: false,
};

function signal(): AbortSignal {
  return createHostAbortController().signal;
}

function interaction(bytes: Uint8Array, mimeType = "audio/wav", extra: unknown[] = []): Response {
  return new Response(JSON.stringify({
    id: "interaction-fixture",
    steps: [
      { type: "model_output", content: [{ type: "text", text: "fixture lyrics" }, ...extra] },
      { type: "model_output", content: [{ type: "audio", mime_type: mimeType, data: Buffer.from(bytes).toString("base64") }] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function replay(responses: Response[], modelId?: string) {
  const requests: Array<{ url: string; init: RequestInit; headers: Headers; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({
      url: String(input), init, headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as unknown,
    });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or additional request");
    return response;
  };
  return {
    adapter: createGoogleLyriaAudioAdapter(KEY, { fetchImpl, ...(modelId ? { modelId } : {}) }),
    requests,
  };
}

test("Lyria 3.5 uses one stateless Interactions request and returns the final inline audio block", async () => {
  const older = waveBytes(1);
  const selected = waveBytes(2);
  const { adapter, requests } = replay([
    interaction(selected, "audio/wav", [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(older).toString("base64") }]),
  ]);
  const result = await adapter.submit({ ...MUSIC, instrumental: true, durationSeconds: 95.5 }, signal());
  assert.equal(adapter.provider, "google-lyria");
  assert.equal(result.kind, "audio");
  if (result.kind !== "audio") assert.fail("expected inline audio");
  assert.equal(result.outputs[0]!.role, "music");
  assert.deepEqual(Buffer.from(result.outputs[0]!.bytes), Buffer.from(selected));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, URL);
  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(requests[0]!.init.redirect, "error");
  assert.equal(requests[0]!.init.credentials, "omit");
  assert.equal(requests[0]!.init.referrerPolicy, "no-referrer");
  assert.deepEqual(Object.fromEntries(requests[0]!.headers), {
    accept: "application/json",
    "content-type": "application/json",
    "x-goog-api-key": KEY,
  });
  assert.deepEqual(requests[0]!.body, {
    model: "lyria-3.5",
    input: `${MUSIC.prompt}\n\nInstrumental only; do not include vocals. Target duration: 95.5 seconds.`,
    store: false,
    response_format: { type: "audio" },
  });
  assert.equal(JSON.stringify(requests[0]!.body).includes(KEY), false);
});

test("Lyria Clip keeps its fixed duration and MP3 response contract", async () => {
  const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
  const { adapter, requests } = replay([interaction(bytes, "audio/mp3")], "lyria-3-clip-preview");
  assert.equal((await adapter.submit({ ...MUSIC, instrumental: true, durationSeconds: 30 }, signal())).kind, "audio");
  assert.deepEqual(requests[0]!.body, {
    model: "lyria-3-clip-preview",
    input: `${MUSIC.prompt}\n\nInstrumental only; do not include vocals.`,
    store: false,
  });
  await assert.rejects(
    adapter.submit({ ...MUSIC, durationSeconds: 29, instrumental: true }, signal()),
    /always generates 30 seconds/,
  );
  assert.equal(requests.length, 1);
});

class ScriptedConnection implements ProviderWebSocketConnection {
  readonly sent: string[] = [];
  closes = 0;
  terminations = 0;

  constructor(private readonly messages: string[]) {}

  async sendText(value: string): Promise<void> {
    this.sent.push(value);
  }

  async receiveText(): Promise<string> {
    const message = this.messages.shift();
    if (message === undefined) throw new Error("fixture stream exhausted");
    return message;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  terminate(): void {
    this.terminations += 1;
  }
}

function scriptedWebSocket(messages: unknown[]) {
  const connection = new ScriptedConnection(messages.map((message) => JSON.stringify(message)));
  const opens: Array<{ url: string; options: OpenProviderWebSocketOptions }> = [];
  const openWebSocket: OpenProviderWebSocket = async (url, options) => {
    opens.push({ url, options });
    return connection;
  };
  return { connection, opens, openWebSocket };
}

test("Lyria RealTime follows setup ordering, collects exact PCM duration, stops, and returns a standard WAV", async () => {
  const durationSeconds = 3;
  const pcm = Buffer.alloc(48_000 * 2 * 2 * durationSeconds, 0x2a);
  const split = Math.floor(pcm.length / 2);
  const scripted = scriptedWebSocket([
    { setupComplete: {} },
    { warning: "fixture warning that must not terminate generation" },
    { serverContent: { audioChunks: [{ mimeType: "audio/pcm;rate=48000", data: pcm.subarray(0, split).toString("base64") }] } },
    { serverContent: { audioChunks: [{ data: pcm.subarray(split).toString("base64") }] } },
  ]);
  const adapter = createGoogleLyriaAudioAdapter(KEY, {
    modelId: "lyria-realtime-exp",
    openWebSocket: scripted.openWebSocket,
  });
  const result = await adapter.submit({
    operation: "generate_music", prompt: "Minimal techno", instrumental: true, durationSeconds,
  }, signal());
  assert.equal(result.kind, "audio");
  if (result.kind !== "audio") assert.fail("expected inline audio");
  const output = result.outputs[0]!.bytes;
  assert.deepEqual(await inspectAudioAttachment({ bytes: output }), {
    mediaType: "audio/wav", durationSeconds, sampleRate: 48_000, channels: 2,
  });
  assert.deepEqual(output.subarray(44), pcm);
  assert.equal(scripted.opens.length, 1);
  assert.equal(scripted.opens[0]!.url, LIVE_URL);
  assert.deepEqual(scripted.opens[0]!.options.headers, { "x-goog-api-key": KEY });
  assert.equal(scripted.opens[0]!.url.includes(KEY), false);
  assert.deepEqual(scripted.connection.sent.map((value) => JSON.parse(value)), [
    { setup: { model: "models/lyria-realtime-exp" } },
    { clientContent: { weightedPrompts: [{ text: "Minimal techno", weight: 1 }] } },
    { playbackControl: "PLAY" },
    { playbackControl: "STOP" },
  ]);
  assert.equal(scripted.connection.closes, 1);
  assert.equal(scripted.connection.terminations, 0);
});

test("realtime 600-second playback keeps its duration budget after setup and still obeys Stop", { timeout: 2_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const controller = createHostAbortController();
    const streaming = Promise.withResolvers<void>();
    let activeSignal: AbortSignal | undefined;
    let receives = 0;
    let terminations = 0;
    const connection: ProviderWebSocketConnection = {
      sendText: async () => undefined,
      receiveText: async (receiveSignal) => {
        if (receives++ === 0) {
          t.mock.timers.tick(30_000);
          return JSON.stringify({ setupComplete: {} });
        }
        streaming.resolve();
        return new Promise<string>((_resolve, reject) => {
          receiveSignal.addEventListener("abort", () => reject(new Error("fixture socket aborted")), { once: true });
        });
      },
      close: async () => undefined,
      terminate() { terminations += 1; },
    };
    const adapter = createGoogleLyriaAudioAdapter(KEY, {
      modelId: "lyria-realtime-exp",
      openWebSocket: async (_url, options) => { activeSignal = options.signal; return connection; },
    });
    const pending = adapter.submit({ ...MUSIC, instrumental: true, durationSeconds: 600 }, controller.signal);
    await streaming.promise;
    t.mock.timers.tick(600_000);
    const survivedDuration = activeSignal?.aborted === false;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(survivedDuration, true, "setup time must not consume the full advertised playback duration");
    assert.ok(terminations > 0);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("realtime setup and playback each have a bounded deadline", { timeout: 2_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    for (const phase of ["setup", "playback"] as const) {
      let receives = 0;
      let terminations = 0;
      let activeSignal: AbortSignal | undefined;
      const waiting = Promise.withResolvers<void>();
      const connection: ProviderWebSocketConnection = {
        sendText: async () => undefined,
        receiveText: async (receiveSignal) => {
          if (phase === "playback" && receives++ === 0) return JSON.stringify({ setupComplete: {} });
          waiting.resolve();
          return new Promise<string>((_resolve, reject) => {
            receiveSignal.addEventListener("abort", () => reject(new Error("fixture socket aborted")), { once: true });
          });
        },
        close: async () => undefined,
        terminate() { terminations += 1; },
      };
      const adapter = createGoogleLyriaAudioAdapter(KEY, {
        modelId: "lyria-realtime-exp",
        openWebSocket: async (_url, options) => { activeSignal = options.signal; return connection; },
      });
      const pending = adapter.submit({ ...MUSIC, instrumental: true, durationSeconds: 3 }, signal());
      await waiting.promise;
      t.mock.timers.tick(phase === "setup" ? 60_000 : 63_000);
      const expiredAtBudget = activeSignal?.aborted === true;
      if (!expiredAtBudget) t.mock.timers.tick(600_000);
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timed out/);
        assert.equal(error instanceof AudioSubmissionNotStartedError, phase === "setup");
        return true;
      });
      assert.equal(expiredAtBudget, true, `${phase} must expire at its own deadline`);
      assert.ok(terminations > 0);
    }
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("realtime safety filtering is known not to have submitted generation and never exposes provider text", async () => {
  const scripted = scriptedWebSocket([
    { setupComplete: {} },
    { filteredPrompt: { text: "raw-secret prompt", filteredReason: `raw-secret ${KEY}` } },
  ]);
  const adapter = createGoogleLyriaAudioAdapter(KEY, {
    modelId: "lyria-realtime-exp", openWebSocket: scripted.openWebSocket,
  });
  await assert.rejects(adapter.submit({ ...MUSIC, instrumental: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof AudioSubmissionNotStartedError);
    assert.equal(error.name, "Error");
    assert.match(error.message, /safety filters/);
    assert.doesNotMatch(error.message, /raw-secret|fixture-google-lyria-key-only/);
    return true;
  });
  assert.equal(scripted.connection.terminations > 0, true);
  assert.deepEqual(scripted.connection.sent.map((value) => JSON.parse(value)), [
    { setup: { model: "models/lyria-realtime-exp" } },
    { clientContent: { weightedPrompts: [{ text: MUSIC.prompt, weight: 1 }] } },
    { playbackControl: "PLAY" },
  ]);
});

test("realtime cancellation terminates the socket and transport failures cannot expose keys or raw causes", async () => {
  const controller = createHostAbortController();
  const waiting = Promise.withResolvers<void>();
  let receives = 0;
  const connection: ProviderWebSocketConnection = {
    sendText: async () => undefined,
    receiveText: async (receiveSignal) => {
      if (receives++ === 0) return JSON.stringify({ setupComplete: {} });
      waiting.resolve();
      return new Promise<string>((_resolve, reject) => {
        receiveSignal.addEventListener("abort", () => reject(new Error(`raw-secret ${KEY}`)), { once: true });
      });
    },
    close: async () => undefined,
    terminate() { receives += 100; },
  };
  const adapter = createGoogleLyriaAudioAdapter(KEY, {
    modelId: "lyria-realtime-exp", openWebSocket: async () => connection,
  });
  const operation = adapter.submit({ ...MUSIC, instrumental: true }, controller.signal);
  await waiting.promise;
  controller.abort();
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.doesNotMatch(error.message, /raw-secret|fixture-google-lyria-key-only/);
    return true;
  });
  assert.equal(receives >= 100, true);

  const failed = createGoogleLyriaAudioAdapter(KEY, {
    modelId: "lyria-realtime-exp",
    openWebSocket: async () => { throw new Error(`raw-secret ${KEY}`); },
  });
  await assert.rejects(failed.submit({ ...MUSIC, instrumental: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof AudioSubmissionNotStartedError);
    assert.match(error.message, /No generation was submitted/);
    assert.doesNotMatch(error.message, /raw-secret|fixture-google-lyria-key-only/);
    assert.equal(error.cause, undefined);
    return true;
  });

  const proxyMessage = "The selected Manual proxy could not be reached.";
  const proxyFailed = createGoogleLyriaAudioAdapter(KEY, {
    modelId: "lyria-realtime-exp",
    openWebSocket: async () => { throw new NetworkProxyError(proxyMessage); },
  });
  await assert.rejects(
    proxyFailed.submit({ ...MUSIC, instrumental: true }, signal()),
    (error: unknown) => error instanceof AudioSubmissionNotStartedError && error.message === proxyMessage,
  );
});

test("invalid models, requests, responses, base64, and media types fail without an extra paid call or secret leakage", async () => {
  for (const modelId of ["", "lyria-unknown", `bad\n${KEY}`]) {
    assert.throws(() => createGoogleLyriaAudioAdapter(KEY, { modelId }), /unsupported music model/);
  }
  for (const apiKey of ["", `bad ${KEY}`, `${KEY}\n`, "x".repeat(4097)]) {
    assert.throws(() => createGoogleLyriaAudioAdapter(apiKey), /valid saved Gemini API key/);
  }
  const invalidResponses = [
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: "AQJ=" }] }] }),
      { headers: { "Content-Type": "application/json" } }),
    interaction(waveBytes(), "audio/ogg"),
  ];
  const { adapter, requests } = replay(invalidResponses);
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(adapter.submit(MUSIC, signal()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Google Lyria audio service/);
      assert.doesNotMatch(error.message, /fixture-google-lyria-key-only|raw-secret/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(requests.length, 3);

  const local = replay([]).adapter;
  const invalidRequests: unknown[] = [
    null, {}, { ...MUSIC, operation: "generate_sound_effect" }, { ...MUSIC, options: { mode: "custom" } },
    { ...MUSIC, prompt: "" }, { ...MUSIC, prompt: "x".repeat(4101) },
    { ...MUSIC, durationSeconds: 2.9 }, { ...MUSIC, durationSeconds: 600.1 },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(local.submit(request as AudioGenerationRequest, signal()), /Google Lyria audio service/);
  }
});
