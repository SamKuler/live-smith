import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { inspectAudioAttachment } from "../../src/attachments/audio.js";
import { MAX_AUDIO_ASSET_BYTES, type AudioGenerationRequest } from "../../src/audio-services/contracts.js";
import { createElevenLabsAudioAdapter } from "../../src/audio-services/elevenlabs.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const KEY = "fixture-elevenlabs-key-only";
const MUSIC: AudioGenerationRequest = { operation: "generate_music", prompt: "  Soft piano 🌙\n", instrumental: true };
const EFFECT: AudioGenerationRequest = { operation: "generate_sound_effect", prompt: "Rain on leaves", durationSeconds: 1.5, loop: true };
const MUSIC_URL = "https://api.elevenlabs.io/v1/music?output_format=auto";
const EFFECT_URL = "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128";

function mp3Bytes(frames = 2): Buffer {
  const metadata = Buffer.from("opaque fixture metadata");
  const frameSize = Math.floor(144 * 128000 / 44100);
  const bytes = Buffer.alloc(10 + metadata.length + frameSize * frames);
  bytes.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, metadata.length]);
  bytes.set(metadata, 10);
  for (let frame = 0; frame < frames; frame++) {
    bytes.set([0xff, 0xfb, 0x90, 0], 10 + metadata.length + frame * frameSize);
  }
  return bytes;
}

function audio(bytes = mp3Bytes(), headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(bytes), { headers: { "Content-Type": "audio/mpeg", ...headers } });
}

function signal(): AbortSignal { return createHostAbortController().signal; }

function replay(responses: Array<Response | (() => Response | Promise<Response>)>, modelId?: string) {
  const requests: Array<{ url: string; init: RequestInit; headers: Headers; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or additional request");
    return typeof response === "function" ? response() : response;
  };
  return { adapter: createElevenLabsAudioAdapter(KEY, { fetchImpl, ...(modelId === undefined ? {} : { modelId }) }), requests };
}

async function safeFailure(operation: Promise<unknown>, pattern = /ElevenLabs audio service/u): Promise<Error> {
  let failure: Error | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.stack ?? "", /fixture-elevenlabs-key-only|raw-secret|untrusted\.test/u);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    failure = error;
    return true;
  });
  return failure!;
}

function stalledBody(cleanup: "hang" | "reject" | "throw" = "hang") {
  const reading = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
  const cleanupPending = Promise.withResolvers<void>();
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  const response = {
    status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg" }),
    body: {
      getReader() {
        return {
          read() { reads++; reading.resolve(); return pending.promise; },
          cancel() {
            cancels++;
            if (cleanup === "throw") throw new Error(`raw-secret ${KEY}`);
            if (cleanup === "reject") return Promise.reject(new Error(`raw-secret ${KEY}`));
            return cleanupPending.promise;
          },
          releaseLock() { releases++; throw new Error(`raw-secret ${KEY}`); },
        };
      },
      cancel() { return Promise.reject(new Error(`raw-secret ${KEY}`)); },
    },
  } as unknown as Response;
  return { response, reading: reading.promise, pending, cleanupPending, counts: () => ({ reads, cancels, releases }) };
}

test("music uses the documented REST request, model-selected quality, quickstart model and unchanged prompt", async () => {
  const bytes = mp3Bytes();
  const { adapter, requests } = replay([audio(bytes, { "Content-Length": String(bytes.length) })]);
  assert.equal(adapter.provider, "elevenlabs");
  assert.deepEqual(await adapter.submit(MUSIC, signal()), { kind: "audio", outputs: [{ role: "music", bytes }] });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, MUSIC_URL);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(Object.fromEntries(request.headers), {
    accept: "audio/mpeg", "content-type": "application/json", "xi-api-key": KEY,
  });
  assert.deepEqual(request.body, { prompt: MUSIC.prompt, model_id: "music_v2", force_instrumental: true, store_for_inpainting: false });
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.referrerPolicy, "no-referrer");
  assert.ok(request.init.signal);
  assert.equal(JSON.stringify(request.body).includes(KEY), false);
});

test("music model override and fractional seconds map to integer milliseconds", async () => {
  for (const durationSeconds of [3, 3.001, 10.0004, 600]) {
    const { adapter, requests } = replay([audio()], "music_v1");
    await adapter.submit({ ...MUSIC, durationSeconds, instrumental: false }, signal());
    assert.deepEqual(requests[0]!.body, { prompt: MUSIC.prompt, model_id: "music_v1", music_length_ms: Math.round(durationSeconds * 1000), force_instrumental: false, store_for_inpainting: false });
  }
});

test("effect duration and loop use the sound model independently of every music selection", async () => {
  for (const modelId of [undefined, "music_v1", "music_v2"]) {
    for (const durationSeconds of [0.5, 1.5, 30]) {
      for (const loop of [false, true]) {
        const bytes = mp3Bytes();
        const { adapter, requests } = replay([audio(bytes)], modelId);
        assert.deepEqual(await adapter.submit({ ...EFFECT, durationSeconds, loop }, signal()), {
          kind: "audio", outputs: [{ role: "sound_effect", bytes }],
        });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.url, EFFECT_URL);
        assert.deepEqual(requests[0]!.body, { text: EFFECT.prompt, duration_seconds: durationSeconds, loop, model_id: "eleven_text_to_sound_v2" });
        assert.equal(requests[0]!.headers.get("xi-api-key"), KEY);
      }
    }
  }
});

test("returned MP3 frames and ID3 bytes pass the actual audio validator unchanged", async () => {
  const bytes = mp3Bytes(400);
  const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 65535), bytes.subarray(65535)];
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk); else controller.close();
  } });
  const { adapter } = replay([new Response(body as never, { headers: { "Content-Type": "Audio/MPEG; charset=binary" } })]);
  const result = await adapter.submit(MUSIC, signal());
  assert.equal(result.kind, "audio");
  if (result.kind !== "audio") assert.fail("expected inline audio");
  const output = result.outputs[0]!;
  assert.deepEqual(output.bytes, bytes);
  assert.notEqual(output.bytes, bytes);
  const inspection = await inspectAudioAttachment({ bytes: output.bytes, signal: signal() });
  assert.deepEqual(inspection, { mediaType: "audio/mpeg", channels: 2, sampleRate: 44100, durationSeconds: 400 * 1152 / 44100 });
});

test("a reader reusing its chunk buffer cannot corrupt prior output bytes", async () => {
  const bytes = mp3Bytes();
  const shared = new Uint8Array(1);
  let offset = 0;
  const response = {
    status: 200, redirected: false, url: MUSIC_URL, headers: new Headers({ "Content-Type": "audio/mpeg" }),
    body: { getReader() { return {
      async read() {
        if (offset === bytes.length) return { done: true };
        shared[0] = bytes[offset++]!;
        return { done: false, value: shared };
      },
      cancel: async () => undefined, releaseLock() {},
    }; } },
  } as unknown as Response;
  const { adapter } = replay([response]);
  assert.deepEqual(await adapter.submit(MUSIC, signal()), { kind: "audio", outputs: [{ role: "music", bytes }] });
});

test("music counts Unicode characters and sound text does not inherit the music prompt limit", async () => {
  const { adapter, requests } = replay([audio(), audio()]);
  const prompt = "🎶".repeat(4100);
  await adapter.submit({ ...MUSIC, prompt }, signal());
  await adapter.submit({ ...EFFECT, prompt: "a".repeat(4101) }, signal());
  assert.equal((requests[0]!.body as { prompt: string }).prompt, prompt);
  assert.equal(requests.length, 2);
});

test("invalid requests are rejected locally without exposing arguments or making a paid call", async () => {
  const invalid: unknown[] = [null, {}, { ...MUSIC, operation: "unknown" },
    ...["", " \n", 5, null].map((prompt) => ({ ...MUSIC, prompt })),
    { ...MUSIC, prompt: "🎶".repeat(4101) },
    ...[2.999, 600.001, NaN, Infinity, null, "3"].map((durationSeconds) => ({ ...MUSIC, durationSeconds })),
    ...[undefined, null, "true", 1].map((instrumental) => ({ ...MUSIC, instrumental })),
    ...[0.499, 30.001, NaN, Infinity, undefined, null, "1"].map((durationSeconds) => ({ ...EFFECT, durationSeconds })),
    ...[undefined, null, "false", 0].map((loop) => ({ ...EFFECT, loop })),
  ];
  const { adapter, requests } = replay([]);
  for (const request of invalid) await safeFailure(adapter.submit(request as AudioGenerationRequest, signal()));
  assert.equal(requests.length, 0);
});

test("invalid credentials and music configuration are rejected without echoing values", () => {
  for (const apiKey of ["", `raw-secret ${KEY}`, `${KEY}\r\n`, "x".repeat(4097), null]) {
    assert.throws(() => createElevenLabsAudioAdapter(apiKey as string), /valid saved API key/);
  }
  for (const modelId of ["", " ", `raw-secret\n${KEY}`, "x".repeat(129), 2]) {
    assert.throws(() => createElevenLabsAudioAdapter(KEY, { modelId: modelId as string }), /invalid music model/);
  }
});

test("construction is lazy and injected Fetch works without ambient Fetch", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error(`raw-secret ${KEY}`); });
  const adapter = createElevenLabsAudioAdapter(KEY);
  await safeFailure(adapter.submit(MUSIC, signal()), /request or response read failed/);
  assert.equal((globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount(), 1);
  const { adapter: injected } = replay([audio()]);
  assert.equal((await injected.submit(MUSIC, signal())).kind, "audio");
});

test("HTTP failures including retryable statuses never parse or replay provider errors", async () => {
  for (const status of [201, 202, 206, 301, 302, 307, 308, 400, 401, 403, 408, 422, 429, 500, 503]) {
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
    const response = new Response(body as never, { status, statusText: `raw-secret ${KEY}`, headers: {
      "Content-Type": "application/json", "Retry-After": "0", Location: `https://untrusted.test/${KEY}`,
    } });
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), new RegExp(`HTTP ${status}`));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.init.redirect, "error");
    assert.equal(cancels, 1);
  }
});

test("redirected responses and changed final URLs are rejected and cancelled", async () => {
  for (const property of ["redirected", "url"] as const) {
    const response = audio();
    Object.defineProperty(response, property, { value: property === "redirected" ? true : `https://untrusted.test/${KEY}` });
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), /redirect/);
    assert.equal(response.bodyUsed, true);
    assert.equal(requests.length, 1);
  }
});

test("missing and non-MP3 MIME types are rejected before reading", async () => {
  for (const mime of [null, "audio/wav", "application/json", "text/html", "application/octet-stream", `raw-secret/${KEY}`]) {
    const body = stalledBody();
    if (mime === null) body.response.headers.delete("content-type");
    else body.response.headers.set("content-type", mime);
    await safeFailure(replay([body.response]).adapter.submit(MUSIC, signal()), /MP3/);
    assert.equal(body.counts().reads, 0);
  }
});

test("invalid and oversized Content-Length is rejected before any body read", async () => {
  for (const length of ["-1", "1.5", "abc", "1, 2", String(MAX_AUDIO_ASSET_BYTES + 1), "999999999999999999999"]) {
    const body = stalledBody();
    body.response.headers.set("content-length", length);
    const { adapter, requests } = replay([body.response]);
    await safeFailure(adapter.submit(MUSIC, signal()), /Content-Length/);
    assert.equal(body.counts().reads, 0);
    assert.equal(requests.length, 1);
  }
});

test("empty, prematurely ended and overlong bodies fail with bounded errors", async () => {
  for (const response of [
    new Response(null, { headers: { "Content-Type": "audio/mpeg" } }),
    audio(Buffer.alloc(0)), audio(mp3Bytes(), { "Content-Length": "0" }),
    audio(mp3Bytes(), { "Content-Length": "1" }),
    audio(mp3Bytes(), { "Content-Length": "9999" }),
  ]) {
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), /empty|Content-Length/);
    assert.equal(requests.length, 1);
  }
});

test("stream byte cap is enforced with absent or deceptively small Content-Length", async () => {
  for (const length of [undefined, String(MAX_AUDIO_ASSET_BYTES)]) {
    let emitted = 0;
    let cancels = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const response = {
      status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg", ...(length === undefined ? {} : { "Content-Length": length }) }),
      body: { getReader() { return {
        async read() { emitted++; return { done: false, value: chunk }; },
        async cancel() { cancels++; }, releaseLock() {},
      }; }, cancel: async () => undefined },
    } as unknown as Response;
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), /128 MiB/);
    assert.equal(emitted, 129);
    assert.equal(cancels, 1);
    assert.equal(requests.length, 1);
  }
});

test("synchronous Fetch throws and delayed rejections never expose causes or retry", async () => {
  for (const fetchImpl of [
    () => { throw new Error(`raw-secret ${KEY}`, { cause: { authorization: KEY } }); },
    async () => { await nextTurn(); throw new Error(`raw-secret ${KEY}`, { cause: { authorization: KEY } }); },
  ]) {
    let calls = 0;
    const adapter = createElevenLabsAudioAdapter(KEY, { fetchImpl: (() => { calls++; return fetchImpl(); }) as typeof fetch });
    await safeFailure(adapter.submit(MUSIC, signal()), /request or response read failed/);
    assert.equal(calls, 1);
  }
});

test("body rejection is redacted, cancelled and never automatically replayed", async () => {
  const body = stalledBody("reject");
  const { adapter, requests } = replay([body.response]);
  const pending = adapter.submit(MUSIC, signal());
  const failure = safeFailure(pending, /response read failed/);
  await body.reading;
  body.pending.reject(new Error(`raw-secret ${KEY}`, { cause: { headers: { "xi-api-key": KEY } } }));
  await failure;
  assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 });
  assert.equal(requests.length, 1);
});

test("already-cancelled submits do not call Fetch and sanitize the caller reason", async () => {
  const controller = createHostAbortController();
  controller.abort(new Error(`raw-secret ${KEY}`));
  const { adapter, requests } = replay([]);
  const error = await safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/);
  assert.equal(error.name, "AbortError");
  assert.equal(requests.length, 0);
});

test("cancellation before headers returns immediately and owns late Fetch rejection", { timeout: 2000 }, async () => {
  const controller = createHostAbortController();
  const fetchPending = Promise.withResolvers<Response>();
  const { adapter, requests } = replay([() => fetchPending.promise]);
  const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/);
  controller.abort(new Error(`raw-secret ${KEY}`));
  await failure;
  assert.equal(requests[0]!.init.signal!.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  fetchPending.reject(new Error(`raw-secret ${KEY}`));
  await nextTurn();
  assert.equal(requests.length, 1);
});

test("a late response after cancellation is cancelled without awaiting its cleanup", { timeout: 2000 }, async () => {
  const controller = createHostAbortController();
  const fetchPending = Promise.withResolvers<Response>();
  const cleanup = Promise.withResolvers<void>();
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; return cleanup.promise; } });
  const { adapter, requests } = replay([() => fetchPending.promise]);
  const failure = safeFailure(adapter.submit(EFFECT, controller.signal), /cancelled/);
  controller.abort(KEY);
  await failure;
  fetchPending.resolve(new Response(body as never));
  await nextTurn();
  assert.equal(cancels, 1);
  cleanup.reject(new Error(`raw-secret ${KEY}`));
  await nextTurn();
  assert.equal(requests.length, 1);
});

test("body cancellation is immediate despite hanging, rejecting or throwing cleanup and late read errors", { timeout: 2000 }, async () => {
  for (const cleanup of ["hang", "reject", "throw"] as const) {
    const controller = createHostAbortController();
    const body = stalledBody(cleanup);
    const { adapter, requests } = replay([body.response]);
    const failure = safeFailure(adapter.submit(EFFECT, controller.signal), /cancelled/);
    await body.reading;
    controller.abort(new Error(`raw-secret ${KEY}`));
    await failure;
    assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 });
    assert.equal(requests[0]!.init.signal!.aborted, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    body.pending.reject(new Error(`raw-secret ${KEY}`));
    if (cleanup === "hang") body.cleanupPending.reject(new Error(`raw-secret ${KEY}`));
    await nextTurn();
    assert.equal(requests.length, 1);
  }
});

test("cancellation acquiring the reader prevents reads and an empty EOF never succeeds", async () => {
  for (const boundary of ["acquire", "empty EOF"] as const) {
    const controller = createHostAbortController();
    let reads = 0;
    let cancels = 0;
    const response = {
      status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg" }),
      body: { getReader() {
        if (boundary === "acquire") controller.abort(KEY);
        return {
          async read() { reads++; controller.abort(KEY); return { done: true }; },
          async cancel() { cancels++; }, releaseLock() {},
        };
      }, cancel: async () => undefined },
    } as unknown as Response;
    await safeFailure(replay([response]).adapter.submit(MUSIC, controller.signal), /cancelled/);
    assert.equal(reads, boundary === "acquire" ? 0 : 1);
    assert.equal(cancels, boundary === "acquire" ? 1 : 0);
  }
});

test("complete paid audio survives Stop at EOF for the caller to persist", async () => {
  for (const boundary of ["inside read", "pending read"] as const) {
    const controller = createHostAbortController();
    const bytes = mp3Bytes();
    const readingEOF = Promise.withResolvers<void>();
    const eof = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const response = {
      status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg", "Content-Length": String(bytes.length) }),
      body: { getReader() { return {
        read() {
          if (++reads === 1) return Promise.resolve({ done: false, value: bytes });
          readingEOF.resolve();
          if (boundary === "pending read") return eof.promise;
          controller.abort(KEY);
          return Promise.resolve({ done: true });
        },
        async cancel() { cancels++; }, releaseLock() { releases++; },
      }; }, cancel: async () => undefined },
    } as unknown as Response;
    const { adapter, requests } = replay([response]);
    const result = adapter.submit(MUSIC, controller.signal);
    await readingEOF.promise;
    if (boundary === "pending read") {
      controller.abort(KEY);
      eof.resolve({ done: true, value: undefined });
    }
    assert.deepEqual(await result, { kind: "audio", outputs: [{ role: "music", bytes }] });
    assert.equal(controller.signal.aborted, true);
    assert.equal(cancels, 0);
    assert.equal(releases, 1);
    assert.equal(requests.length, 1);
  }
});

test("Stop during an incomplete real stream cannot manufacture a successful EOF", { timeout: 2000 }, async () => {
  const controller = createHostAbortController();
  const waiting = Promise.withResolvers<void>();
  let pulls = 0;
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(body) {
      if (++pulls === 1) body.enqueue(mp3Bytes());
      else waiting.resolve();
    },
    cancel() { cancels++; },
  });
  const { adapter, requests } = replay([new Response(stream as never, { headers: { "Content-Type": "audio/mpeg" } })]);
  const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/);
  await waiting.promise;
  await nextTurn();
  controller.abort(KEY);
  await failure;
  assert.equal(cancels, 1);
  assert.equal(requests.length, 1);
});

test("eager empty streams yield so a caller can cancel without reaching a byte limit", { timeout: 2000 }, async () => {
  const controller = createHostAbortController();
  let reads = 0;
  const response = {
    status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg" }),
    body: { getReader() { return {
      async read() { reads++; return { done: false, value: new Uint8Array(0) }; },
      cancel: async () => undefined, releaseLock() {},
    }; }, cancel: async () => undefined },
  } as unknown as Response;
  const failure = safeFailure(replay([response]).adapter.submit(MUSIC, controller.signal), /cancelled/);
  await nextTurn();
  controller.abort(KEY);
  await failure;
  assert.ok(reads > 0 && reads <= 128);
});

test("one ten-minute deadline covers both headers and body, with no reset or replay", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const controller = createHostAbortController();
    const fetchPending = Promise.withResolvers<Response>();
    const body = stalledBody();
    const { adapter, requests } = replay([() => fetchPending.promise]);
    let finished = false;
    const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /timed out/).then(() => { finished = true; });
    t.mock.timers.tick(480_000);
    fetchPending.resolve(body.response);
    await body.reading;
    t.mock.timers.tick(119_999);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    await failure;
    assert.equal(requests[0]!.init.signal!.aborted, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 });
    body.pending.reject(new Error(`raw-secret ${KEY}`));
    body.cleanupPending.reject(new Error(`raw-secret ${KEY}`));
    await nextTurn();
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("the deadline also bounds a Fetch that never returns headers", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const { adapter, requests } = replay([() => new Promise<Response>(() => undefined)]);
    const failure = safeFailure(adapter.submit(EFFECT, signal()), /timed out/);
    t.mock.timers.tick(600_000);
    await failure;
    assert.equal(requests[0]!.init.signal!.aborted, true);
    assert.equal(requests.length, 1);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("successful requests remove abort listeners and remain independent", async () => {
  const controller = createHostAbortController();
  const { adapter, requests } = replay([audio(), audio()]);
  await adapter.submit(MUSIC, controller.signal);
  await adapter.submit(EFFECT, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort(KEY);
  for (const request of requests) assert.equal(request.init.signal!.aborted, false);
  assert.equal(requests.length, 2);
});
