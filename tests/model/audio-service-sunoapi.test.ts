import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { MAX_AUDIO_ASSET_BYTES, type AudioGenerationRequest, type RemoteAudioOutput } from "../../src/audio-services/contracts.js";
import { createSunoApiAudioAdapter } from "../../src/audio-services/sunoapi.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const KEY = "fixture-sunoapi-key-only";
const TASK = "task_024a";
const CALLBACK = "https://callbacks.example.org/music";
const BASE = "https://api.sunoapi.org/api/v1/generate";
const CDN = "https://file.aiquickdraw.com/s/";
const MUSIC: AudioGenerationRequest = { operation: "generate_music", prompt: "Warm piano ambience", instrumental: true };
const OUTPUT: RemoteAudioOutput = { key: "audio_a", role: "music", url: `${CDN}audio_a.mp3` };
const BYTES = Buffer.from("synthetic audio bytes, inspected separately by the asset owner");
type Step = Response | (() => Response | Promise<Response>);

function replay(steps: Step[] = [], options: { modelId?: string; callbackUrl?: string } = {}) {
  const requests: Array<{ url: string; init: RequestInit; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (input, init = {}) => {
    requests.push({ url: String(input), init, headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const step = steps.shift();
    assert.ok(step, "unexpected extra request or retry");
    return typeof step === "function" ? step() : step;
  }) as typeof fetch;
  return { adapter: createSunoApiAudioAdapter(KEY, { callbackUrl: CALLBACK, ...options, fetchImpl }), requests };
}
function signal() { return createHostAbortController().signal; }
function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", ...headers } });
}
function receipt(taskId: unknown = TASK) { return json({ code: 200, msg: "success", data: { taskId } }); }
function audio(bytes: Uint8Array = BYTES, headers: Record<string, string> = {}) {
  return new Response(bytes as never, { headers: { "Content-Type": "audio/mpeg", ...headers } });
}
function track(id = "audio_a", overrides: Record<string, unknown> = {}) {
  return { id, audio_url: `${CDN}${id}.mp3`, stream_audio_url: "https://untrusted.test/preview",
    model_name: "chirp-v4-5", title: "fixture", duration: 30, ...overrides };
}
function status(state = "SUCCESS", tracks: unknown[] = [track()], overrides: Record<string, unknown> = {}) {
  return json({ code: 200, msg: "success", data: { taskId: TASK, status: state,
    response: { taskId: TASK, sunoData: tracks }, errorCode: null, errorMessage: null, ...overrides } });
}
async function safeFailure(operation: Promise<unknown>, pattern = /SunoAPI\.org/u, key = KEY): Promise<Error> {
  let captured: Error | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.equal((error.stack ?? "").includes(key), false);
    assert.doesNotMatch(error.stack ?? "", /raw-secret|untrusted\.test/u);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(key), false);
    captured = error;
    return true;
  });
  return captured!;
}
function stalledBody(cleanup: "hang" | "reject" | "throw" = "hang") {
  const started = Promise.withResolvers<void>();
  const read = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
  const cleaning = Promise.withResolvers<void>();
  let reads = 0; let cancels = 0; let releases = 0;
  const response = {
    status: 200, redirected: false, url: "", headers: new Headers({ "Content-Type": "audio/mpeg" }),
    body: { getReader() { return {
      read() { reads++; started.resolve(); return read.promise; },
      cancel() { cancels++; if (cleanup === "throw") throw new Error(KEY);
        return cleanup === "reject" ? Promise.reject(new Error(KEY)) : cleaning.promise; },
      releaseLock() { releases++; },
    }; }, cancel: async () => undefined },
  } as unknown as Response;
  return { response, started: started.promise, read, cleaning, counts: () => ({ reads, cancels, releases }) };
}

test("non-custom submit captures the exact third-party contract and current default model", async () => {
  const { adapter, requests } = replay([receipt()]);
  assert.equal(adapter.provider, "sunoapi");
  assert.equal(adapter.cancel, undefined);
  assert.deepEqual(await adapter.submit(MUSIC, signal()), { kind: "task", taskId: TASK });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, BASE);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(Object.fromEntries(request.headers), {
    accept: "application/json", authorization: `Bearer ${KEY}`, "content-type": "application/json",
  });
  assert.deepEqual(request.body, { customMode: false, instrumental: true, model: "V6", callBackUrl: CALLBACK, prompt: MUSIC.prompt });
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.referrerPolicy, "no-referrer");
});

test("every published model and both instrumental flags use the same request schema", async () => {
  for (const modelId of ["V6", "V6_WILD", "V6_MINI", "V5_5", "V5", "V4_5PLUS", "V4_5ALL", "V4_5", "V4"]) {
    for (const instrumental of [true, false]) {
      const { adapter, requests } = replay([receipt()], { modelId });
      await adapter.submit({ ...MUSIC, instrumental }, signal());
      assert.deepEqual(requests[0]!.body, { customMode: false, instrumental, model: modelId, callBackUrl: CALLBACK, prompt: MUSIC.prompt });
    }
  }
});

test("prompt boundary counts characters and duration is rejected even for V5_5", async () => {
  const { adapter, requests } = replay([receipt()], { modelId: "V5_5" });
  await adapter.submit({ ...MUSIC, prompt: "🎵".repeat(3000) }, signal());
  for (const request of [
    ...["", "   ", "x".repeat(3001), "🎵".repeat(3001), 42].map((prompt) => ({ ...MUSIC, prompt })),
    ...[null, 0, 30, NaN, "30"].map((durationSeconds) => ({ ...MUSIC, durationSeconds })),
    { ...MUSIC, instrumental: "true" }, { ...MUSIC, operation: "generate_sound_effect", loop: true }, null,
  ]) await safeFailure(adapter.submit(request as AudioGenerationRequest, signal()));
  assert.equal(requests.length, 1);
});

test("invalid credentials, model IDs and callbacks fail before any request", () => {
  let requests = 0;
  const fetchImpl = (async () => { requests++; return receipt(); }) as typeof fetch;
  for (const apiKey of ["", " key", "key\r\nx-header:secret", "x".repeat(4097)]) {
    assert.throws(() => createSunoApiAudioAdapter(apiKey, { callbackUrl: CALLBACK, fetchImpl }));
  }
  for (const modelId of ["", "V3_5", "v5", "V5 ", KEY]) {
    assert.throws(() => createSunoApiAudioAdapter(KEY, { callbackUrl: CALLBACK, modelId, fetchImpl }), /model/u);
  }
  for (const callbackUrl of [undefined, null, "", "not a url", "ftp://callbacks.example.org/music",
    "https://user:password@callbacks.example.org/music", "https://@callbacks.example.org/music",
    "https:callbacks.example.org/music", "https:////callbacks.example.org/music",
    "https://callbacks.example.org/music#fragment", "https://callbacks.example.org/music#", "https://callbacks.example.org/a%zz",
    "https://callbacks.example.org/a%b", "https://callbacks.example.org/a b", "https://callbacks.example.org/a\\b",
    "https://callbacks.example.org/a%0db", `https://callbacks.example.org/${KEY}`,
  ]) assert.throws(() => createSunoApiAudioAdapter(KEY, { callbackUrl: callbackUrl as string, fetchImpl }), /callback/u);
  assert.equal(requests, 0);
});

test("callback preserves user-selected HTTP endpoints, ports, queries and valid path escapes without fetching them", async () => {
  for (const callbackUrl of ["https://callbacks.example.org:443/music%2Fready",
    "http://localhost:8787/music?token=fixture", "https://127.0.0.1:9443/callback?stage=complete"]) {
    const { adapter, requests } = replay([receipt()], { callbackUrl });
    await adapter.submit(MUSIC, signal());
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, BASE);
    assert.equal((requests[0]!.body as Record<string, unknown>).callBackUrl, new URL(callbackUrl).href);
  }
});

test("submit receipts require numeric success and a safe non-reflected task ID", async () => {
  for (const value of [{}, [], null, { code: "200", msg: "success", data: { taskId: TASK } },
    { code: 200, data: { taskId: TASK } }, { code: 200, msg: "success", data: null },
    ...[undefined, "", KEY, `task_${KEY}`, "https://untrusted.test/", "a/b", "a?b", "a".repeat(129), 42]
      .map((taskId) => ({ code: 200, msg: "success", data: { taskId } })),
  ]) await safeFailure(replay([json(value)]).adapter.submit(MUSIC, signal()));
});

test("published error responses never leak messages or create an automatic retry", async () => {
  for (const code of [400, 401, 404, 405, 413, 429, 430, 455, 500]) {
    const { adapter, requests } = replay([json({ code, msg: `raw-secret ${KEY}`, data: { authorization: KEY } })]);
    await safeFailure(adapter.submit(MUSIC, signal()), /rejected/u);
    assert.equal(requests.length, 1);
  }
});

test("running states and first-track partial output stay running without exposing locators", async () => {
  const { adapter, requests } = replay([
    status("PENDING", [], { response: null }), status("TEXT_SUCCESS"), status("FIRST_SUCCESS", [track()]),
  ]);
  for (let i = 0; i < 3; i++) assert.deepEqual(await adapter.inspect!(TASK, signal()), { status: "running" });
  for (const request of requests) {
    assert.equal(request.url, `${BASE}/record-info?taskId=${TASK}`);
    assert.equal(request.init.method, "GET");
    assert.equal(request.body, undefined);
    assert.deepEqual(Object.fromEntries(request.headers), { accept: "application/json", authorization: `Bearer ${KEY}` });
  }
});

test("validated failure enums retain diagnostic context without raw errors or recovery requests", async () => {
  for (const state of ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR"]) {
    const { adapter, requests } = replay([status(state, [], { response: null, errorCode: 500, errorMessage: `raw-secret ${KEY}` })]);
    const value = await adapter.inspect!(TASK, signal());
    assert.deepEqual(value, { status: "failed", message: `SunoAPI.org third-party audio service: task reported ${state}.` });
    assert.doesNotMatch(JSON.stringify(value), /raw-secret|fixture-sunoapi-key-only/u);
    assert.equal(requests.length, 1);
  }
});

test("unknown and malformed task states are never considered success or cancellation", async () => {
  for (const state of [undefined, null, 0, "success", "COMPLETE", "CANCELLED", "UNKNOWN"]) {
    await safeFailure(replay([status("SUCCESS", [track()], { status: state })]).adapter.inspect!(TASK, signal()), /status/u);
  }
});

test("both echoed task IDs must exactly match including in partial and failed responses", async () => {
  for (const state of ["PENDING", "FIRST_SUCCESS", "SUCCESS", "GENERATE_AUDIO_FAILED"]) {
    for (const taskId of [undefined, "task_other", TASK.toUpperCase(), KEY]) {
      for (const override of [{ taskId }, { response: { taskId, sunoData: [track()] } }]) {
        await safeFailure(replay([status(state, [track()], override)]).adapter.inspect!(TASK, signal()));
      }
    }
  }
  const { adapter, requests } = replay();
  for (const id of ["", "a/b", "a?b", KEY, "x".repeat(129)]) await safeFailure(adapter.inspect!(id, signal()));
  assert.equal(requests.length, 0);
});

test("one or two final snake_case outputs get stable roles sorted by audio ID across resume", async () => {
  const { adapter } = replay([status(), status("SUCCESS", [track("audio_b"), track()]), status("SUCCESS", [track(), track("audio_b")])]);
  assert.deepEqual(await adapter.inspect!(TASK, signal()), { status: "completed", outputs: [OUTPUT] });
  const expected = { status: "completed", outputs: [OUTPUT, { key: "audio_b", role: "music_alternative", url: `${CDN}audio_b.mp3` }] };
  assert.deepEqual(await adapter.inspect!(TASK, signal()), expected);
  assert.deepEqual(await adapter.inspect!(TASK, signal()), expected);
});

test("malformed completed results, duplicate IDs and undocumented aliases are rejected", async () => {
  for (const tracks of [[], [track(), track(), track("audio_c")], [track(), track()], [null],
    [track(KEY)], [track("audio_a", { audio_url: undefined, audioUrl: OUTPUT.url })],
    [track("audio_a", { id: null })], [track("audio_a", { audio_url: null })],
  ]) await safeFailure(replay([status("SUCCESS", tracks)]).adapter.inspect!(TASK, signal()));
  for (const response of [undefined, null, [], { taskId: TASK }, { taskId: TASK, sunoData: {} }]) {
    await safeFailure(replay([status("SUCCESS", [], { response })]).adapter.inspect!(TASK, signal()));
  }
});

test("inspect and download reject only malformed or credential-bearing provider URLs", async () => {
  const urls = ["file:///tmp/a.mp3", "data:audio/mpeg;base64,AAAA", "ftp://files.example.org/a.mp3",
    "https://user:pass@file.aiquickdraw.com/s/audio.mp3",
    "https://file.aiquickdraw.com/s/a.mp3#fragment", `${CDN}a%0db.mp3`,
    `${CDN}a%5cb.mp3`, `${CDN}${KEY}.mp3`, `${CDN}a.mp3?token=${KEY}`, `${CDN}a.mp3?token=${Array.from(KEY).map(c => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
  ];
  for (const url of urls) {
    const { adapter, requests } = replay([status("SUCCESS", [track("audio_a", { audio_url: url })])]);
    await safeFailure(adapter.inspect!(TASK, signal()));
    await safeFailure(adapter.download!({ ...OUTPUT, url }, signal()));
    assert.equal(requests.length, 1);
  }
});

test("provider-selected HTTP audio hosts, ports and signed queries are usable without forwarding credentials", async () => {
  for (const url of [
    "https://media.provider-cdn.org/generated/audio.mp3?expires=1900000000&signature=fixture",
    "https://cdn1.suno.ai/audio.mp3",
    "http://127.0.0.1:8080/audio.mp3?download=1",
  ]) {
    const output = { ...OUTPUT, url };
    const { adapter, requests } = replay([status("SUCCESS", [track("audio_a", { audio_url: url })]), audio()]);
    assert.deepEqual(await adapter.inspect!(TASK, signal()), { status: "completed", outputs: [output] });
    assert.deepEqual(await adapter.download!(output, signal()), BYTES);
    assert.equal(requests[1]!.url, url);
    assert.deepEqual(Object.fromEntries(requests[1]!.headers), { accept: "audio/mpeg, audio/wav, application/octet-stream" });
    assert.equal(requests[1]!.init.credentials, "omit");
    assert.equal(requests[1]!.init.redirect, "error");
  }
});

test("downloads never forward API credentials and keep query signatures on the trusted host", async () => {
  const url = `${OUTPUT.url}?expires=1900000000&signature=fixture-signature`;
  const { adapter, requests } = replay([audio()]);
  assert.deepEqual(await adapter.download!({ ...OUTPUT, url }, signal()), BYTES);
  assert.equal(requests[0]!.url, url);
  assert.deepEqual(Object.fromEntries(requests[0]!.headers), { accept: "audio/mpeg, audio/wav, application/octet-stream" });
  assert.equal(requests[0]!.init.redirect, "error");
  assert.equal(requests[0]!.init.credentials, "omit");
  assert.equal(requests[0]!.init.referrerPolicy, "no-referrer");
});

test("unexpected redirects, changed response URLs, MIME types and HTTP errors are rejected", async () => {
  for (const kind of ["submit", "download"] as const) {
    for (const mutation of ["redirected", "url", "mime", "status"] as const) {
      const response = kind === "submit" ? receipt() : audio();
      if (mutation === "mime") response.headers.set("Content-Type", "text/html");
      else Object.defineProperty(response, mutation, { value: mutation === "redirected" ? true : mutation === "status" ? 302 : `https://untrusted.test/${KEY}` });
      const { adapter, requests } = replay([response]);
      await safeFailure(kind === "submit" ? adapter.submit(MUSIC, signal()) : adapter.download!(OUTPUT, signal()));
      assert.equal(requests.length, 1);
      assert.equal(response.bodyUsed, true);
    }
  }
});

test("HTTP errors retain only numeric status and never raw status text or response bodies", async () => {
  for (const code of [401, 429, 500]) {
    const response = new Response(`raw-secret ${KEY}`, { status: code, statusText: KEY });
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), new RegExp(`HTTP ${code}`, "u"));
    assert.equal(requests.length, 1);
  }
});

test("JSON parsing bounds bytes, nesting, nodes and unsafe property names", async () => {
  const valid = { code: 200, msg: "success", data: { taskId: TASK }, padding: "" };
  valid.padding = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(valid)));
  assert.deepEqual(await replay([json(valid)]).adapter.submit(MUSIC, signal()), { kind: "task", taskId: TASK });
  let deep: unknown = {};
  for (let i = 0; i < 20; i++) deep = { child: deep };
  const invalid = ["{", JSON.stringify({ ...valid, padding: `${valid.padding}x` }), JSON.stringify({ extra: deep }),
    JSON.stringify({ items: Array.from({ length: 4100 }, () => 0) }), '{"__proto__":{}}', '{"constructor":{}}',
    '{"a":{"prototype":{}}}', '{"code":1e999}', Buffer.from([0xff]),
  ];
  for (const body of invalid) {
    await safeFailure(replay([new Response(body, { headers: { "Content-Type": "application/json" } })]).adapter.submit(MUSIC, signal()));
  }
});

test("invalid or oversized Content-Length is rejected before a body read", async () => {
  for (const kind of ["submit", "download"] as const) {
    for (const length of ["-1", "1.5", "bad", "1, 2", String((kind === "submit" ? 65536 : MAX_AUDIO_ASSET_BYTES) + 1)]) {
      const body = stalledBody();
      body.response.headers.set("Content-Length", length);
      body.response.headers.set("Content-Type", kind === "submit" ? "application/json" : "audio/mpeg");
      const { adapter, requests } = replay([body.response]);
      await safeFailure(kind === "submit" ? adapter.submit(MUSIC, signal()) : adapter.download!(OUTPUT, signal()), /Content-Length/u);
      assert.equal(body.counts().reads, 0);
      assert.equal(requests.length, 1);
    }
  }
});

test("empty, truncated and overlong responses cannot become successful audio or receipts", async () => {
  for (const response of [audio(Buffer.alloc(0)), audio(BYTES, { "Content-Length": "0" }),
    audio(BYTES, { "Content-Length": "1" }), audio(BYTES, { "Content-Length": "9999" }),
    new Response(null, { headers: { "Content-Type": "audio/mpeg" } }),
  ]) await safeFailure(replay([response]).adapter.download!(OUTPUT, signal()));
  const text = JSON.stringify({ code: 200, msg: "success", data: { taskId: TASK } });
  await safeFailure(replay([new Response(text, { headers: { "Content-Type": "application/json", "Content-Length": String(text.length + 1) } })]).adapter.submit(MUSIC, signal()));
});

test("audio byte limit accepts exactly 128 MiB, owns reused chunks, and rejects one extra byte", async () => {
  for (const extra of [false, true]) {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 42);
    let pulls = 0; let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulls <= 16) controller.enqueue(chunk);
        else if (extra) controller.enqueue(new Uint8Array(1)); else controller.close(); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const { adapter } = replay([new Response(body as never, { headers: { "Content-Type": "audio/mpeg" } })]);
    if (extra) { await safeFailure(adapter.download!(OUTPUT, signal()), /byte limit/u); assert.equal(cancels, 1); }
    else { const bytes = await adapter.download!(OUTPUT, signal()); chunk.fill(0);
      assert.equal(bytes.length, MAX_AUDIO_ASSET_BYTES); assert.equal(bytes[0], 42); assert.equal(bytes[bytes.length - 1], 42); }
  }
});

test("all operations honor pre-aborted signals without requests or leaked abort reasons", async () => {
  const { adapter, requests } = replay();
  const controller = createHostAbortController(); controller.abort(new Error(`raw-secret ${KEY}`));
  for (const operation of [adapter.submit(MUSIC, controller.signal), adapter.inspect!(TASK, controller.signal), adapter.download!(OUTPUT, controller.signal)]) {
    assert.equal((await safeFailure(operation, /cancelled/u)).name, "AbortError");
  }
  assert.equal(requests.length, 0);
});

test("Fetch throws and late rejects are sanitized without retrying", async () => {
  for (const step of [() => { throw new Error(`raw-secret ${KEY}`, { cause: KEY }); },
    async () => { await setImmediate(); throw new Error(`raw-secret ${KEY}`); },
  ]) {
    const { adapter, requests } = replay([step]);
    await safeFailure(adapter.submit(MUSIC, signal()), /request or response read failed/u);
    assert.equal(requests.length, 1);
  }
  const key = "200";
  const adapter = createSunoApiAudioAdapter(key, { callbackUrl: CALLBACK, fetchImpl: async () => json({ code: 200, msg: "success", data: { taskId: "task200" } }) });
  await safeFailure(adapter.submit(MUSIC, signal()), /identifier/u, key);
});

test("poll/download cancellation owns late responses and rejections without awaiting cleanup", { timeout: 2000 }, async () => {
  for (const kind of ["inspect", "download"] as const) {
    const pending = Promise.withResolvers<Response>(); const cleaning = Promise.withResolvers<void>();
    const controller = createHostAbortController(); let cancels = 0;
    const { adapter, requests } = replay([() => pending.promise]);
    const failure = safeFailure(kind === "inspect" ? adapter.inspect!(TASK, controller.signal) : adapter.download!(OUTPUT, controller.signal), /cancelled/u);
    controller.abort(KEY); await failure;
    assert.equal(requests[0]!.init.signal!.aborted, true);
    pending.resolve(new Response(new ReadableStream({ cancel() { cancels++; return cleaning.promise; } }) as never));
    await setImmediate(); assert.equal(cancels, 1);
    cleaning.reject(new Error(KEY)); await setImmediate();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("stalled readers and failing cleanup cannot block cancellation", { timeout: 2000 }, async () => {
  for (const kind of ["inspect", "download"] as const) {
    for (const cleanup of ["hang", "reject", "throw"] as const) {
      const body = stalledBody(cleanup); const controller = createHostAbortController();
      if (kind === "inspect") body.response.headers.set("Content-Type", "application/json");
      const { adapter } = replay([body.response]);
      const failure = safeFailure(kind === "inspect" ? adapter.inspect!(TASK, controller.signal) : adapter.download!(OUTPUT, controller.signal), /cancelled/u);
      await body.started; controller.abort(KEY); await failure;
      assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 });
      body.read.reject(new Error(`raw-secret ${KEY}`));
      if (cleanup === "hang") body.cleaning.reject(new Error(KEY));
      await setImmediate();
    }
  }
});

test("reader rejection is sanitized and cleanup is attempted without an automatic retry", async () => {
  const body = stalledBody("reject"); const { adapter, requests } = replay([body.response]);
  const failure = safeFailure(adapter.download!(OUTPUT, signal()), /read failed/u);
  await body.started; body.read.reject(new Error(`raw-secret ${KEY}`, { cause: KEY })); await failure;
  assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 }); assert.equal(requests.length, 1);
});

test("Stop at EOF preserves only a validated paid submit receipt", async () => {
  for (const kind of ["submit", "inspect", "download"] as const) {
    const controller = createHostAbortController();
    const bytes = kind === "submit" ? Buffer.from(await receipt().text()) : kind === "inspect" ? Buffer.from(await status().text()) : BYTES;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (++pulls === 1) stream.enqueue(bytes); else { stream.close(); controller.abort(KEY); }
    } }, { highWaterMark: 0 });
    const { adapter } = replay([new Response(body as never, { headers: { "Content-Type": kind === "download" ? "audio/mpeg" : "application/json" } })]);
    if (kind === "submit") assert.deepEqual(await adapter.submit(MUSIC, controller.signal), { kind: "task", taskId: TASK });
    else await safeFailure(kind === "inspect" ? adapter.inspect!(TASK, controller.signal) : adapter.download!(OUTPUT, controller.signal), /cancelled/u);
    assert.equal(controller.signal.aborted, true);
  }
});

test("Stop grace accepts a valid receipt before three seconds and clears both deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  try {
    const pending = Promise.withResolvers<Response>(); const controller = createHostAbortController();
    const { adapter, requests } = replay([() => pending.promise]);
    const result = adapter.submit(MUSIC, controller.signal); controller.abort(KEY);
    t.mock.timers.tick(2999); assert.equal(requests[0]!.init.signal!.aborted, false);
    pending.resolve(receipt()); assert.deepEqual(await result, { kind: "task", taskId: TASK });
    t.mock.timers.tick(120000); assert.equal(requests[0]!.init.signal!.aborted, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.equal(requests.length, 1);
  } finally { t.mock.timers.reset(); syncBuiltinESMExports(); }
});

test("Stop grace ends at three seconds or the original deadline and owns late responses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  try {
    for (const age of [0, 119000]) {
      const pending = Promise.withResolvers<Response>(); const controller = createHostAbortController();
      const { adapter, requests } = replay([() => pending.promise]);
      const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/u);
      t.mock.timers.tick(age); controller.abort(KEY); t.mock.timers.tick(Math.min(3000, 120000 - age) - 1);
      assert.equal(requests[0]!.init.signal!.aborted, false); t.mock.timers.tick(1); await failure;
      let cancels = 0;
      pending.resolve(new Response(new ReadableStream({ cancel() { cancels++; } }) as never));
      await setImmediate(); assert.equal(cancels, 1); assert.equal(requests.length, 1);
    }
  } finally { t.mock.timers.reset(); syncBuiltinESMExports(); }
});

test("complete JSON bytes without EOF cannot evade the paid receipt grace deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  try {
    const started = Promise.withResolvers<void>(); const controller = createHostAbortController(); let pulls = 0; let cancels = 0;
    const text = Buffer.from(await receipt().text());
    const body = new ReadableStream<Uint8Array>({ pull(stream) { if (++pulls === 1) stream.enqueue(text); else started.resolve(); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const { adapter } = replay([new Response(body as never, { headers: { "Content-Type": "application/json" } })]);
    const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/u);
    await started.promise; controller.abort(KEY); t.mock.timers.tick(3000); await failure; assert.equal(cancels, 1);
  } finally { t.mock.timers.reset(); syncBuiltinESMExports(); }
});

test("Stop grace cannot turn malformed or reflected-key JSON into a task receipt", async () => {
  for (const text of ["{", "{}", JSON.stringify({ code: 200, msg: "success", data: { taskId: KEY } })]) {
    const controller = createHostAbortController();
    const { adapter, requests } = replay([() => { controller.abort(KEY); return new Response(text, { headers: { "Content-Type": "application/json" } }); }]);
    await safeFailure(adapter.submit(MUSIC, controller.signal)); assert.equal(requests.length, 1);
  }
});

test("one ten-minute media deadline bounds headers and body without resetting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  try {
    const pending = Promise.withResolvers<Response>(); const body = stalledBody(); const controller = createHostAbortController();
    const { adapter, requests } = replay([() => pending.promise]);
    const failure = safeFailure(adapter.download!(OUTPUT, controller.signal), /timed out/u);
    t.mock.timers.tick(90_000); pending.resolve(body.response); await body.started;
    t.mock.timers.tick(509_999); assert.equal(requests[0]!.init.signal!.aborted, false);
    t.mock.timers.tick(1); await failure; assert.deepEqual(body.counts(), { reads: 1, cancels: 1, releases: 1 });
    body.read.reject(new Error(KEY)); body.cleaning.reject(new Error(KEY)); await setImmediate();
  } finally { t.mock.timers.reset(); syncBuiltinESMExports(); }
});

test("eager empty streams yield so deadlines and cancellation can run", { timeout: 2000 }, async () => {
  const controller = createHostAbortController(); let reads = 0;
  const response = { status: 200, url: "", redirected: false, headers: new Headers({ "Content-Type": "audio/mpeg" }),
    body: { getReader() { return { async read() { reads++; return { done: false, value: new Uint8Array() }; },
      cancel: async () => undefined, releaseLock() {} }; }, cancel: async () => undefined },
  } as unknown as Response;
  const failure = safeFailure(replay([response]).adapter.download!(OUTPUT, controller.signal), /cancelled/u);
  await setImmediate(); controller.abort(KEY); await failure; assert.ok(reads > 0 && reads <= 128);
});
