import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import type { AudioGenerationRequest, RemoteAudioOutput } from "../audio-services/contracts.js";
import { MUREKA_MUSIC_MODELS } from "../audio-services/capabilities.js";
import { createMurekaAudioAdapter, generateMurekaLyrics } from "../audio-services/mureka.js";
import { createHostAbortController } from "../runtime/host.js";

const KEY = "fixture-mureka-key-only";
const TASK = "task_024a";
const SONG_TASK = `song:${TASK}`;
const INSTRUMENTAL_TASK = `instrumental:${TASK}`;
const SONG_URL = "https://cdn.mureka.ai/generated/song-a.mp3?expires=1900000000&signature=fixture";
const MUSIC: AudioGenerationRequest = {
  operation: "generate_music", prompt: "Warm piano ambience", instrumental: false,
};
const BYTES = Buffer.from("synthetic Mureka audio bytes, inspected by the asset owner");

type Step = Response | (() => Response | Promise<Response>);

function replay(steps: Step[] = [], modelId?: string) {
  const requests: Array<{ url: string; init: RequestInit; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (input, init = {}) => {
    requests.push({ url: String(input), init, headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const step = steps.shift();
    assert.ok(step, "unexpected extra request or retry");
    return typeof step === "function" ? step() : step;
  }) as typeof fetch;
  return { adapter: createMurekaAudioAdapter(KEY, { ...(modelId ? { modelId } : {}), fetchImpl }), requests };
}

function signal() { return createHostAbortController().signal; }
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function receipt(status = "preparing", id: unknown = TASK) {
  return json({ id, created_at: 1_797_000_000, model: "mureka-9.5", status, trace_id: "trace-fixture" });
}
function choice(index: unknown, id: unknown, url: unknown) {
  return { index, id, url, wav_url: "https://untrusted.test/not-selected.wav", duration: 120_000 };
}
function task(status: unknown, choices: unknown = undefined, overrides: Record<string, unknown> = {}) {
  return json({ id: TASK, created_at: 1_797_000_000, finished_at: 1_797_000_120,
    model: "mureka-9.5", status, ...(choices === undefined ? {} : { choices }), ...overrides });
}
function audio(bytes: Uint8Array = BYTES, mime = "audio/mpeg", status = 200) {
  return new Response(bytes as never, { status, headers: { "Content-Type": mime } });
}

async function safeFailure(operation: Promise<unknown>, pattern = /Mureka audio service/u): Promise<Error> {
  let captured: Error | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /fixture-mureka-key-only|remote-secret|untrusted\.test/u);
    assert.doesNotMatch(error.stack ?? "", /fixture-mureka-key-only|remote-secret|untrusted\.test/u);
    assert.equal(error.cause, undefined);
    captured = error;
    return true;
  });
  return captured!;
}

test("Mureka prompt-to-song submit captures the current official request contract", async () => {
  const { adapter, requests } = replay([receipt()]);
  assert.equal(adapter.provider, "mureka");
  assert.equal(adapter.cancel, undefined);
  assert.deepEqual(await adapter.submit(MUSIC, signal()), { kind: "task", taskId: SONG_TASK });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.mureka.ai/v1/song/easy-generate");
  assert.equal(requests[0]!.init.method, "POST");
  assert.deepEqual(Object.fromEntries(requests[0]!.headers), {
    accept: "application/json", authorization: `Bearer ${KEY}`, "content-type": "application/json",
  });
  assert.deepEqual(requests[0]!.body, { model: "auto", n: 1, prompt: MUSIC.prompt, stream: false });
  assert.equal(requests[0]!.init.redirect, "error");
  assert.equal(requests[0]!.init.credentials, "omit");
  assert.equal(requests[0]!.init.referrerPolicy, "no-referrer");
});

test("Mureka lyrics-to-song uses literal lyrics and the dedicated official route", async () => {
  const { adapter, requests } = replay([receipt()]);
  assert.deepEqual(await adapter.submit({
    operation: "generate_song_from_lyrics",
    lyrics: "[Verse]\nCity lights in the rain",
    prompt: "future garage",
    gender: "female",
  }, signal()), { kind: "task", taskId: SONG_TASK });
  assert.equal(requests[0]!.url, "https://api.mureka.ai/v1/song/generate");
  assert.deepEqual(requests[0]!.body, {
    model: "auto",
    n: 1,
    lyrics: "[Verse]\nCity lights in the rain",
    prompt: "future garage",
    gender: "female",
    stream: false,
  });
});

test("Mureka lyric generation returns only bounded title and lyrics", async () => {
  const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fetchImpl = (async (input, init = {}) => {
    requests.push({
      url: String(input),
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return json({
      title: "Afterlight",
      lyrics: "[Verse]\nRain on the glass",
      trace_id: "must-not-be-returned",
    });
  }) as typeof fetch;
  assert.deepEqual(await generateMurekaLyrics(
    KEY,
    "A hopeful night-drive song",
    signal(),
    { fetchImpl },
  ), {
    title: "Afterlight",
    lyrics: "[Verse]\nRain on the glass",
  });
  assert.equal(requests[0]!.url, "https://api.mureka.ai/v1/lyrics/generate");
  assert.equal(requests[0]!.init.method, "POST");
  assert.deepEqual(requests[0]!.body, { prompt: "A hopeful night-drive song" });
});

test("Mureka lyric and lyrics-to-song validation rejects unsafe input before HTTP", async () => {
  const { adapter, requests } = replay([]);
  for (const request of [
    { operation: "generate_song_from_lyrics", lyrics: "" },
    { operation: "generate_song_from_lyrics", lyrics: "x".repeat(5001) },
    { operation: "generate_song_from_lyrics", lyrics: "Lyrics", prompt: "x".repeat(1025) },
    { operation: "generate_song_from_lyrics", lyrics: "Lyrics", gender: "unknown" },
  ]) await safeFailure(adapter.submit(request as AudioGenerationRequest, signal()));
  assert.equal(requests.length, 0);

  let lyricRequests = 0;
  const fetchImpl = (async () => { lyricRequests++; return json({ title: "Title", lyrics: "Lyrics" }); }) as typeof fetch;
  await safeFailure(generateMurekaLyrics(KEY, "x".repeat(8001), signal(), { fetchImpl }));
  assert.equal(lyricRequests, 0);
  for (const response of [
    { title: "", lyrics: "Lyrics" },
    { title: "Title\nInjected", lyrics: "Lyrics" },
    { title: "Title", lyrics: "\u0001unsafe" },
    { title: "Title", lyrics: "x".repeat(20_001) },
  ]) {
    await safeFailure(generateMurekaLyrics(KEY, "Brief", signal(), {
      fetchImpl: (async () => json(response)) as typeof fetch,
    }));
  }
});

test("Mureka instrumentals use their dedicated submit and resumable query routes", async () => {
  const { adapter, requests } = replay([receipt(), task("queued")], "mureka-9");
  const request = { ...MUSIC, instrumental: true };
  assert.deepEqual(await adapter.submit(request, signal()), { kind: "task", taskId: INSTRUMENTAL_TASK });
  assert.deepEqual(await adapter.inspect!(INSTRUMENTAL_TASK, signal()), { status: "running" });
  assert.deepEqual(requests.map((entry) => [entry.init.method, entry.url]), [
    ["POST", "https://api.mureka.ai/v1/instrumental/generate"],
    ["GET", `https://api.mureka.ai/v1/instrumental/query/${TASK}`],
  ]);
  assert.deepEqual(requests[0]!.body, { model: "mureka-9", n: 1, prompt: MUSIC.prompt, stream: false });
  assert.equal(requests[1]!.body, undefined);
});

test("every published model maps literally while mureka-o2 rejects instrumental generation", async () => {
  assert.deepEqual(MUREKA_MUSIC_MODELS, ["auto", "mureka-7.6", "mureka-o2", "mureka-8", "mureka-9", "mureka-9.5"]);
  for (const modelId of MUREKA_MUSIC_MODELS) {
    const { adapter, requests } = replay([receipt()], modelId);
    await adapter.submit(MUSIC, signal());
    assert.equal((requests[0]!.body as Record<string, unknown>).model, modelId);
  }
  const { adapter, requests } = replay([], "mureka-o2");
  await safeFailure(adapter.submit({ ...MUSIC, instrumental: true }, signal()), /model/u);
  assert.equal(requests.length, 0);
});

test("unsupported generation parameters and invalid model credentials fail before HTTP", async () => {
  const { adapter, requests } = replay([]);
  for (const request of [
    null, { ...MUSIC, operation: "generate_sound_effect", durationSeconds: 3, loop: false },
    { ...MUSIC, prompt: "" }, { ...MUSIC, prompt: "   " }, { ...MUSIC, prompt: "🎵".repeat(1025) },
    { ...MUSIC, instrumental: "false" }, { ...MUSIC, durationSeconds: 30 },
    { ...MUSIC, options: { mode: "custom" } },
  ]) await safeFailure(adapter.submit(request as AudioGenerationRequest, signal()));
  assert.equal(requests.length, 0);
  const fetchImpl = (async () => receipt()) as typeof fetch;
  for (const apiKey of ["", " key", "key\r\nx-header:secret", "x".repeat(4097)]) {
    assert.throws(() => createMurekaAudioAdapter(apiKey, { fetchImpl }), /key/u);
  }
  for (const modelId of ["", "mureka-7.5", "MUREKA-9", "mureka-9 ", KEY]) {
    assert.throws(() => createMurekaAudioAdapter(KEY, { modelId, fetchImpl }), /model/u);
  }
});

test("documented running, failed, timeout and cancelled states map without remote messages", async () => {
  const { adapter } = replay([
    task("preparing"), task("queued"), task("running"), task("streaming"),
    task("failed", undefined, { failed_reason: `remote-secret ${KEY}` }),
    task("timeouted", undefined, { failed_reason: `remote-secret ${KEY}` }), task("cancelled"),
  ]);
  for (let index = 0; index < 4; index++) assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), { status: "running" });
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), {
    status: "failed", message: "Mureka audio service: task failed.",
  });
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), {
    status: "failed", message: "Mureka audio service: task timed out.",
  });
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), { status: "cancelled" });
});

test("a successful choice retains its stable output identity while its URL can refresh", async () => {
  const { adapter } = replay([task("succeeded", [
    choice(0, "song_a", SONG_URL),
  ]), task("succeeded", [
    choice(0, "song_a", "https://cdn.mureka.cn/generated/song-a.mp3?renewed=1"),
  ])]);
  const expected = { status: "completed", outputs: [
    { key: "song_a", role: "music", url: SONG_URL },
  ] };
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), expected);
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), { status: "completed", outputs: [
    { ...expected.outputs[0], url: "https://cdn.mureka.cn/generated/song-a.mp3?renewed=1" },
  ] });
});

test("a single output does not require the optional provider choice index", async () => {
  const { adapter } = replay([task("succeeded", [{ id: "song_a", url: SONG_URL }])]);
  assert.deepEqual(await adapter.inspect!(SONG_TASK, signal()), { status: "completed", outputs: [
    { key: "song_a", role: "music", url: SONG_URL },
  ] });
});

test("task locators, echoed IDs, terminal shapes and output identities are strict", async () => {
  const completed = (choices: unknown) => task("succeeded", choices);
  for (const response of [
    task("unknown"), task(undefined), task("succeeded"), completed([]),
    completed([choice(0, "song_a", SONG_URL), choice(1, "song_b", "https://cdn.mureka.ai/song-b.mp3")]),
    completed([choice(0, "song_a", SONG_URL), choice(1, "song_b", "https://cdn.mureka.ai/song-b.mp3"), choice(2, "song_c", SONG_URL)]),
    completed([choice(0, KEY, SONG_URL)]),
    completed([choice(0, "song_a", `https://cdn.mureka.ai/${KEY}.mp3`)]),
    task("queued", undefined, { id: "other-task" }),
  ]) await safeFailure(replay([response]).adapter.inspect!(SONG_TASK, signal()));
  const { adapter, requests } = replay([]);
  for (const locator of ["", TASK, "video:task", "song:", `song:${KEY}`, "song:a/b", "song:" + "x".repeat(129)]) {
    await safeFailure(adapter.inspect!(locator, signal()), /task/u);
  }
  assert.equal(requests.length, 0);
});

test("downloads retain signed HTTPS URLs without forwarding Mureka credentials", async () => {
  const output: RemoteAudioOutput = { key: "song_a", role: "music", url: SONG_URL };
  const { adapter, requests } = replay([audio()]);
  assert.deepEqual(await adapter.download!(output, signal()), BYTES);
  assert.equal(requests[0]!.url, SONG_URL);
  assert.deepEqual(Object.fromEntries(requests[0]!.headers), {
    accept: "audio/mpeg, audio/wav, application/octet-stream",
  });
  assert.equal(requests[0]!.init.redirect, "error");
  assert.equal(requests[0]!.init.credentials, "omit");
  assert.equal(requests[0]!.init.referrerPolicy, "no-referrer");
  const invalid = replay([]);
  await safeFailure(invalid.adapter.download!({ ...output, role: "music_alternative" }, signal()), /role/u);
  assert.equal(invalid.requests.length, 0);
});

test("accepts provider-returned HTTPS media hosts without pinning example CDN domains", async () => {
  const url = "https://media.provider-cdn.example/generated/song-a.mp3?signature=fixture";
  const { adapter, requests } = replay([audio()]);
  assert.deepEqual(await adapter.download!({ key: "song_a", role: "music", url }, signal()), BYTES);
  assert.equal(requests[0]!.url, url);
});

test("HTTP errors, redirects, invalid media and reflected URLs expose only fixed local diagnostics", async () => {
  for (const response of [
    json({ error: { message: `remote-secret ${KEY}` }, trace_id: "trace-secret" }, 401),
    json({ error: { message: `remote-secret ${KEY}` } }, 429),
    json({ error: { message: `remote-secret ${KEY}` } }, 503),
  ]) {
    const { adapter, requests } = replay([response]);
    await safeFailure(adapter.submit(MUSIC, signal()), /HTTP/u);
    assert.equal(requests.length, 1);
  }
  for (const response of [audio(BYTES, "text/html"), audio(BYTES, "audio/mpeg", 302)]) {
    await safeFailure(replay([response]).adapter.download!({ key: "song_a", role: "music", url: SONG_URL }, signal()));
  }
  for (const url of ["http://cdn.mureka.ai/song.mp3", "file:///tmp/song.mp3", "https://user:pass@cdn.mureka.ai/song.mp3",
    "https://cdn.mureka.ai/song.mp3#fragment", `https://cdn.mureka.ai/${KEY}.mp3`]) {
    const { adapter, requests } = replay([]);
    await safeFailure(adapter.download!({ key: "song_a", role: "music", url }, signal()));
    assert.equal(requests.length, 0);
  }
});

test("Stop grace preserves a complete paid receipt and clears both deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const pending = Promise.withResolvers<Response>();
    const controller = createHostAbortController();
    const { adapter, requests } = replay([() => pending.promise]);
    const result = adapter.submit(MUSIC, controller.signal);
    controller.abort(KEY);
    t.mock.timers.tick(2_999);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    pending.resolve(receipt());
    assert.deepEqual(await result, { kind: "task", taskId: SONG_TASK });
    t.mock.timers.tick(120_000);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("Stop grace expires after three seconds and owns a late response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const pending = Promise.withResolvers<Response>();
    const controller = createHostAbortController();
    let cancels = 0;
    const { adapter, requests } = replay([() => pending.promise]);
    const failure = safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/u);
    controller.abort(KEY);
    t.mock.timers.tick(2_999);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    t.mock.timers.tick(1);
    await failure;
    pending.resolve(new Response(new ReadableStream({ cancel() { cancels++; } }) as never));
    await setImmediate();
    assert.equal(cancels, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(requests.length, 1);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("pre-aborted work makes no request and does not expose abort reasons", async () => {
  const { adapter, requests } = replay([]);
  const controller = createHostAbortController();
  controller.abort(new Error(`remote-secret ${KEY}`));
  const error = await safeFailure(adapter.submit(MUSIC, controller.signal), /cancelled/u);
  assert.equal(error.name, "AbortError");
  assert.equal(requests.length, 0);
});
