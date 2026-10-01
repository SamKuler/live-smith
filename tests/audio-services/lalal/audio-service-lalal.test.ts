import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import { setImmediate } from "node:timers";
import { URL } from "node:url";

import {
  MAX_AUDIO_ASSET_BYTES,
  SEPARATION_STEMS,
  type RemoteAudioOutput,
  type SeparationStem,
} from "../../../src/audio-services/contracts.js";
import { createLalalAudioAdapter } from "../../../src/audio-services/lalal/lalal.js";
import { createHostAbortController } from "../../../src/runtime/host.js";

const KEY = "fixture-license-only";
const SOURCE_ID = "e1fc1d8f-502e-4de0-bf3b-b30543d11c77";
const TASK_ID = "2fe8f214-1771-4900-9e7e-570f823bd359";
const IDEMPOTENCY_KEY = "cb443802-e5be-44c2-bdd8-cb1d343c7d25";
const OTHER_ID = "f4978ff5-8e0b-4fdc-913a-e350eeb16d31";
const BYTES = Buffer.from("small fixture audio");
const STEMS: SeparationStem[] = ["vocals", "drums"];
const OUTPUT_URL = `https://d.lalal.ai/${SOURCE_ID}/abcd1234/vocals`;
const OUTPUT: RemoteAudioOutput = { key: "stem:vocals", role: "vocals", url: OUTPUT_URL };

interface CapturedRequest {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: unknown;
}

function replay(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    requests.push({
      url: String(input), init, headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or additional request");
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { adapter: createLalalAudioAdapter(KEY, { fetchImpl }), requests };
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function uploadResponse(overrides: Record<string, unknown> = {}): Response {
  return json({ id: SOURCE_ID, name: "audio.wav", size: BYTES.length, duration: 18,
    expires: 2_000_000_000, ...overrides });
}

function checkResult(status: string, overrides: Record<string, unknown> = {}) {
  return { status, source_id: SOURCE_ID,
    presets: { task_type: "split", label: "multistem", stem_list: ["vocals", "drum"],
      encoder_format: "wav", splitter: "perseus", dereverb_enabled: false }, ...overrides };
}

function checkResponse(value: unknown): Response {
  return json({ result: { [TASK_ID]: value } });
}

function tracks() {
  return [
    { type: "stem", label: "vocals", url: OUTPUT_URL, name: "untrusted.wav", size: 100,
      waveform: "https://untrusted.test/waveform", playlist_file: null },
    { type: "stem", label: "drum", url: OUTPUT_URL.replace(/vocals$/u, "drum") },
    { type: "back", label: "no_multistem", url: OUTPUT_URL.replace(/vocals$/u, "no_multistem") },
  ];
}

function successResponse(outputTracks: unknown[] = tracks(), duration: unknown = 18): Response {
  return checkResponse(checkResult("success", { result: { tracks: outputTracks, duration } }));
}

function signal(): AbortSignal {
  return createHostAbortController().signal;
}

async function safeFailure(operation: Promise<unknown>, pattern = /LALAL\.AI/u): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.stack ?? "", /fixture-license-only|raw-secret|untrusted\.test/u);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    return true;
  });
}

test("Stop after response acquisition does not initiate another body read", async () => {
  const controller = createHostAbortController();
  let reads = 0;
  let cancels = 0;
  const response = {
    status: 200, redirected: false, url: "", headers: new Headers(),
    body: {
      getReader() {
        controller.abort();
        return {
          read() { reads++; return Promise.reject(new Error("raw-secret")); },
          cancel() { cancels++; return Promise.resolve(); },
          releaseLock() {},
        };
      },
      cancel() { return Promise.resolve(); },
    },
  } as unknown as Response;
  const { adapter } = replay(response);
  await safeFailure(adapter.upload(BYTES, "audio/wav", controller.signal), /cancelled/);
  assert.equal(reads, 0);
  assert.equal(cancels, 1);
});

test("upload captures official octet-stream headers, immutable bytes and generic WAV/MP3 names", async () => {
  for (const mediaType of ["audio/wav", "audio/mpeg"] as const) {
    const { adapter, requests } = replay(uploadResponse());
    assert.equal(await adapter.upload(BYTES, mediaType, signal()), SOURCE_ID);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.url, "https://www.lalal.ai/api/v1/upload/");
    assert.equal(request.init.method, "POST");
    assert.equal(request.headers.get("x-license-key"), KEY);
    assert.equal(request.headers.get("content-type"), "application/octet-stream");
    assert.equal(request.headers.get("content-disposition"),
      `attachment; filename=audio.${mediaType === "audio/wav" ? "wav" : "mp3"}`);
    assert.deepEqual(request.body, BYTES);
    assert.notEqual(request.body, BYTES);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.credentials, "omit");
    assert.equal(request.init.referrerPolicy, "no-referrer");
    assert.ok(request.init.signal);
  }
});

test("single and all-stem submissions use multistem, drum mapping, source-matched encoding and caller idempotency", async () => {
  for (const stems of [["vocals"] as const, SEPARATION_STEMS]) {
    const { adapter, requests } = replay(json({ task_id: TASK_ID }));
    assert.deepEqual(adapter.stems, SEPARATION_STEMS);
    assert.equal(adapter.provider, "lalal");
    assert.equal(await adapter.submit(SOURCE_ID, stems, IDEMPOTENCY_KEY, signal()), TASK_ID);
    assert.equal(requests[0]!.url, "https://www.lalal.ai/api/v1/split/multistem/");
    assert.equal(requests[0]!.headers.get("x-license-key"), KEY);
    assert.equal(requests[0]!.headers.get("content-type"), "application/json");
    assert.deepEqual(requests[0]!.body, { source_id: SOURCE_ID,
      presets: { stem_list: stems.map((stem) => stem === "drums" ? "drum" : stem), encoder_format: "wav" },
      idempotency_key: IDEMPOTENCY_KEY });
  }
  const { adapter, requests } = replay(json({ task_id: TASK_ID }));
  assert.equal(await adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal(), "audio/mpeg"), TASK_ID);
  assert.equal((requests[0]!.body as { presets: { encoder_format: string } }).presets.encoder_format, "mp3");
});

test("check replays queued, processing and completed results with all stems and residual intact", async () => {
  const { adapter, requests } = replay(
    checkResponse(checkResult("progress", { progress: 0 })),
    checkResponse(checkResult("progress", { progress: 42 })), successResponse(),
  );
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()), { status: "running", progress: 0 });
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()), { status: "running", progress: 42 });
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()), {
    status: "completed", outputs: [OUTPUT,
      { key: "stem:drum", role: "drums", url: OUTPUT_URL.replace(/vocals$/u, "drum") },
      { key: "back:no_multistem", role: "residual", url: OUTPUT_URL.replace(/vocals$/u, "no_multistem") }],
  });
  for (const request of requests) {
    assert.equal(request.url, "https://www.lalal.ai/api/v1/check/");
    assert.equal(request.headers.get("x-license-key"), KEY);
    assert.deepEqual(request.body, { task_ids: [TASK_ID] });
  }
});

test("output order and preset order can differ from the request without changing role identity", async () => {
  const value = checkResult("success", { result: { tracks: tracks().reverse(), duration: 18 },
    presets: { stem_list: ["drum", "vocals"] } });
  const { adapter } = replay(checkResponse(value));
  const result = await adapter.inspect(TASK_ID, STEMS, signal());
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.outputs.map((track) => track.role),
    ["residual", "drums", "vocals"]);
});

test("all documented task terminal variants are parsed without provider metadata escaping", async () => {
  const { adapter } = replay(
    checkResponse(checkResult("error", { error: { detail: KEY, code: "raw-secret", id: KEY } })),
    checkResponse({ status: "server_error", error: KEY }),
    checkResponse(checkResult("cancelled")),
  );
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()),
    { status: "failed", message: "LALAL.AI audio processing failed." });
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()),
    { status: "failed", message: "LALAL.AI could not access this processing task." });
  assert.deepEqual(await adapter.inspect(TASK_ID, STEMS, signal()), { status: "cancelled" });
});

test("cancel addresses the exact task and verifies its corresponding result", async () => {
  const { adapter, requests } = replay(json({ result: { [TASK_ID]: { status: "success" },
    [OTHER_ID]: { status: "server_error", error: KEY } } }));
  await adapter.cancel!(TASK_ID, signal());
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://www.lalal.ai/api/v1/cancel/");
  assert.deepEqual(requests[0]!.body, { task_ids: [TASK_ID] });
  assert.equal(requests[0]!.headers.get("x-license-key"), KEY);
  for (const value of [{ result: { [OTHER_ID]: { status: "success" } } },
    { result: { [TASK_ID]: { status: "server_error", error: KEY } } },
    { result: { [TASK_ID]: { status: "cancelled" } } }]) {
    await safeFailure(replay(json(value)).adapter.cancel!(TASK_ID, signal()));
  }
});

test("upload validates the complete required response metadata and never returns reflected credentials", async () => {
  for (const overrides of [
    { id: undefined }, { id: "raw-secret" }, { name: undefined }, { size: undefined },
    { size: BYTES.length + 1 }, { duration: undefined }, { duration: 901 },
    { duration: 1.5 }, { expires: undefined }, { expires: "2000000000" },
  ]) {
    await safeFailure(replay(uploadResponse(overrides)).adapter.upload(BYTES, "audio/wav", signal()));
  }
  const adapter = createLalalAudioAdapter(SOURCE_ID, { fetchImpl: async () => uploadResponse() });
  await safeFailure(adapter.upload(BYTES, "audio/wav", signal()));
});

test("invalid inputs fail before upload, submit, check or cancel can make a request", async () => {
  const { adapter, requests } = replay();
  await safeFailure(adapter.upload(new Uint8Array(), "audio/wav", signal()));
  await safeFailure(adapter.upload(new Uint8Array(MAX_AUDIO_ASSET_BYTES + 1), "audio/wav", signal()));
  await safeFailure(adapter.upload(BYTES, "audio/flac" as never, signal()));
  for (const stems of [[], ["vocals", "vocals"], ["guitar"], ["drum"]]) {
    await safeFailure(adapter.submit(SOURCE_ID, stems as SeparationStem[], IDEMPOTENCY_KEY, signal()));
    await safeFailure(adapter.inspect(TASK_ID, stems as SeparationStem[], signal()));
  }
  for (const id of ["", "__proto__", KEY, "http://untrusted.test/", TASK_ID.replace("4900", "1900")]) {
    await safeFailure(adapter.submit(id, STEMS, IDEMPOTENCY_KEY, signal()));
    await safeFailure(adapter.submit(SOURCE_ID, STEMS, id, signal()));
    await safeFailure(adapter.inspect(id, STEMS, signal()));
    await safeFailure(adapter.cancel!(id, signal()));
  }
  assert.equal(requests.length, 0);
  for (const key of ["", "raw-secret\r\nx-header:value", " leading-space", "x".repeat(4097)]) {
    assert.throws(() => createLalalAudioAdapter(key), /valid saved API key/u);
  }
});

test("check rejects malformed discriminators, required fields and mismatched presets", async () => {
  for (const value of [
    {}, { result: null }, { result: { [OTHER_ID]: checkResult("cancelled") } },
    ...[
      checkResult("done"), checkResult("cancelled", { source_id: undefined }),
      checkResult("cancelled", { presets: null }),
      checkResult("cancelled", { presets: { stem_list: ["vocals", "vocals"] } }),
      checkResult("cancelled", { presets: { stem_list: ["vocals", "bass"] } }),
      checkResult("cancelled", { presets: { stem_list: ["vocals", "drum"], label: "voice_clean" } }),
      checkResult("error", { error: KEY }), checkResult("error", { error: { code: "failure" } }),
      { status: "server_error", error: {} },
      ...[undefined, -1, 101, 0.5, "42"].map((progress) => checkResult("progress", { progress })),
    ].map((value) => ({ result: { [TASK_ID]: value } })),
  ]) await safeFailure(replay(json(value)).adapter.inspect(TASK_ID, STEMS, signal()));
});

test("completed results require the full selected stem set and exactly one residual", async () => {
  for (const outputTracks of [
    [], tracks().slice(0, 2), [...tracks(), tracks()[0]],
    [tracks()[0], tracks()[0], tracks()[2]],
    [tracks()[0], tracks()[1], { ...tracks()[2], label: "no_vocals" }],
    [tracks()[0], { ...tracks()[1], label: "bass" }, tracks()[2]],
    [tracks()[0], tracks()[1], { ...tracks()[2], type: "stem" }],
    [tracks()[0], tracks()[1], { ...tracks()[2], url: undefined }],
    ...[0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1].map((size) =>
      [tracks()[0], tracks()[1], { ...tracks()[2], size }]),
    [tracks()[0], tracks()[1], { ...tracks()[2], playlist_file: {} }],
  ]) await safeFailure(replay(successResponse(outputTracks)).adapter.inspect(TASK_ID, STEMS, signal()));
  for (const duration of [-1, 1.5, 901, "18", null]) {
    await safeFailure(replay(successResponse(tracks(), duration)).adapter.inspect(TASK_ID, STEMS, signal()));
  }
});

test("optional output size metadata does not apply the local per-file download cap to the task", async () => {
  for (const size of [undefined, null, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_BYTES + 1, Number.MAX_SAFE_INTEGER]) {
    const outputTracks = [tracks()[0], tracks()[1], { ...tracks()[2], size }];
    const { adapter, requests } = replay(successResponse(outputTracks));
    const result = await adapter.inspect(TASK_ID, STEMS, signal());
    assert.equal(result.status, "completed");
    if (result.status !== "completed") assert.fail("Expected completed output locators");
    assert.deepEqual(result.outputs.map((output) => output.role), ["vocals", "drums", "residual"]);
    assert.equal(requests.length, 1);
  }
});

test("HTTP errors of every documented family stay fixed and do not retry upload or submit", async () => {
  const bodies = [{ detail: KEY, code: "idempotency_key_used" },
    { detail: [{ loc: [KEY], msg: "raw-secret", input: { api_key: KEY } }] },
    { detail: { arbitrary: KEY } }, { detail: "raw-secret" }];
  for (const status of [400, 403, 422, 429, 500]) {
    for (const body of bodies) {
      const { adapter, requests } = replay(json(body, { status, statusText: "raw-secret" }));
      await safeFailure(adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()), new RegExp(`HTTP ${status}`));
      assert.equal(requests.length, 1);
    }
  }
  for (const operation of ["upload", "submit"] as const) {
    const { adapter, requests } = replay(() => { throw new Error(`${KEY}: raw-secret`, { cause: KEY }); });
    await safeFailure(operation === "upload" ? adapter.upload(BYTES, "audio/wav", signal()) :
      adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()));
    assert.equal(requests.length, 1);
  }
});

test("successful HTTP with malformed, deep, unsafe or oversized JSON is rejected safely", async () => {
  const malformed = ["raw-secret", JSON.stringify([KEY]), "null", '{"task_id":', '{"number":1e309}',
    '{"__proto__":{"polluted":true}}', '{"constructor":{}}',
    '{"nested":' + "[".repeat(18) + "0" + "]".repeat(18) + "}",
    JSON.stringify({ task_id: TASK_ID, metadata: Array(4097).fill(0) }),
    JSON.stringify({ task_id: TASK_ID, metadata: "x".repeat(65536) })];
  for (const body of malformed) {
    await safeFailure(replay(new Response(body)).adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()));
  }
  await safeFailure(replay(new Response(new Uint8Array([0xff, 0xfe]))).adapter.submit(
    SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()));
  for (const value of [{}, { task_id: KEY }, { task_id: 42 }]) {
    await safeFailure(replay(json(value)).adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()));
  }
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("download copies audio bytes without API credentials, cookies, referrers or provider metadata", async () => {
  for (const url of [OUTPUT_URL, OUTPUT_URL.replace("https:", "http:")]) {
    const { adapter, requests } = replay(new Response(BYTES));
    assert.deepEqual(await adapter.download({ ...OUTPUT, url }, signal()), BYTES);
    const request = requests[0]!;
    assert.equal(request.url, OUTPUT_URL);
    assert.equal(request.init.method, "GET");
    assert.deepEqual([...request.headers.keys()], ["accept"]);
    assert.equal(request.init.credentials, "omit");
    assert.equal(request.init.referrerPolicy, "no-referrer");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.body, undefined);
    assert.equal(JSON.stringify(request.headers).includes(KEY), false);
  }
});

test("check normalizes the official HTTP output example to HTTPS before returning its locator", async () => {
  const outputTracks = tracks().map((track) => ({ ...track, url: track.url.replace("https:", "http:") }));
  const result = await replay(successResponse(outputTracks)).adapter.inspect(TASK_ID, STEMS, signal());
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.ok(result.outputs.every((output) => output.url.startsWith("https:")));
});

test("URL authority, credential and scheme controls apply at both parsing and download", async () => {
  for (const url of [
    "https://untrusted.test/audio.wav", "https://d.lalal.ai.untrusted.test/audio.wav",
    "https://d.lalal.ai@untrusted.test/audio.wav", "https://user:password@d.lalal.ai/audio.wav",
    "http://127.0.0.1/audio.wav", "https://[::1]/audio.wav", "file:///audio.wav",
    "data:audio/wav;base64,AA==", "//d.lalal.ai/audio.wav", "https://d.lalal.ai:444/audio.wav",
    `${OUTPUT_URL}?X-License-Key=${KEY}`, `${OUTPUT_URL}?token=raw-secret`, `${OUTPUT_URL}#fragment`,
    `${OUTPUT_URL}/${KEY}`, `${OUTPUT_URL}/%66ixture-license-only`, `${OUTPUT_URL}/%0a`,
    `${OUTPUT_URL}\n`, "https://d.lalal.ai\\@untrusted.test/file", "https://d.lalal.ai./file",
    "https://d.lalal.ai/", `${OUTPUT_URL}/${"x".repeat(2048)}`, `${OUTPUT_URL}/%zz`,
  ]) {
    const { adapter, requests } = replay();
    await safeFailure(Promise.resolve().then(() => adapter.download({ ...OUTPUT, url }, signal())));
    assert.equal(requests.length, 0);
    await safeFailure(replay(successResponse([{ ...tracks()[0], url }, ...tracks().slice(1)])).adapter.inspect(
      TASK_ID, STEMS, signal()));
  }
});

test("API and output redirects are rejected without following their Location", async () => {
  for (const location of ["https://untrusted.test/audio.wav", OUTPUT_URL, "http://d.lalal.ai/audio.wav"]) {
    for (const operation of ["upload", "download"] as const) {
      const { adapter, requests } = replay(new Response(null, { status: 302, headers: { Location: location } }));
      await safeFailure(operation === "upload" ? adapter.upload(BYTES, "audio/wav", signal()) :
        adapter.download(OUTPUT, signal()));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.init.redirect, "error");
    }
  }
  const response = new Response(BYTES);
  Object.defineProperty(response, "redirected", { value: true });
  await safeFailure(replay(response).adapter.download(OUTPUT, signal()));
  const wrongUrl = new Response(BYTES);
  Object.defineProperty(wrongUrl, "url", { value: "https://untrusted.test/audio.wav" });
  await safeFailure(replay(wrongUrl).adapter.download(OUTPUT, signal()));
});

test("declared oversized JSON and audio bodies are cancelled before reading", async () => {
  for (const [operation, limit] of [["submit", 65536], ["download", MAX_AUDIO_ASSET_BYTES]] as const) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
    const response = new Response(body as never, { headers: { "Content-Length": String(limit + 1) } });
    const { adapter } = replay(response);
    await safeFailure(operation === "download" ? adapter.download(OUTPUT, signal()) :
      adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal()), /byte limit/u);
    assert.equal(cancelled, 1);
  }
});

test("streamed audio is bounded independently of missing or maximum Content-Length", async () => {
  for (const length of [undefined, String(MAX_AUDIO_ASSET_BYTES)]) {
    let cancelled = 0;
    let pulls = 0;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(chunk); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 });
    const { adapter } = replay(new Response(body as never,
      length ? { headers: { "Content-Length": length } } : undefined));
    await safeFailure(adapter.download(OUTPUT, signal()), /byte limit/u);
    assert.equal(pulls, 17);
    assert.equal(cancelled, 1);
  }
});

test("download accepts the exact byte limit and preserves independently owned streaming chunks", async () => {
  const chunk = Buffer.alloc(8 * 1024 * 1024, 42);
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls <= 16) controller.enqueue(chunk);
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const bytes = await replay(new Response(body as never)).adapter.download(OUTPUT, signal());
  assert.equal(bytes.byteLength, MAX_AUDIO_ASSET_BYTES);
  chunk.fill(0);
  assert.equal(bytes[0], 42);
  assert.equal(bytes[bytes.length - 1], 42);
});

test("empty, invalid length, partial-content and failed stream downloads do not return assets", async () => {
  for (const response of [new Response(null), new Response(new Uint8Array()),
    new Response(BYTES, { headers: { "Content-Length": "invalid" } }),
    new Response(BYTES, { status: 206 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error(KEY)); } }) as never)]) {
    await safeFailure(replay(response).adapter.download(OUTPUT, signal()));
  }
});

test("already-aborted operations do no network I/O and redact caller abort reasons", async () => {
  const controller = createHostAbortController();
  controller.abort(new Error(KEY, { cause: "raw-secret" }));
  const { adapter, requests } = replay();
  const operations = [
    () => adapter.upload(BYTES, "audio/wav", controller.signal),
    () => adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal),
    () => adapter.inspect(TASK_ID, STEMS, controller.signal),
    () => adapter.cancel!(TASK_ID, controller.signal),
    () => adapter.download(OUTPUT, controller.signal),
  ];
  for (const operation of operations) await assert.rejects(operation, { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("cancellation settles a stalled Fetch and cancels its late body without retry", { timeout: 2000 }, async () => {
  let resolveFetch!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
  let cancelled = 0;
  const { adapter, requests } = replay(() => pending);
  const controller = createHostAbortController();
  const upload = adapter.upload(BYTES, "audio/wav", controller.signal);
  controller.abort(KEY);
  await safeFailure(upload, /cancelled/u);
  assert.equal(requests[0]!.init.signal!.aborted, true);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled += 1; } }) as never));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(requests.length, 1);
});

test("cancellation releases stalled JSON and audio readers even if cleanup never settles", { timeout: 2000 }, async () => {
  for (const operation of ["check", "download"] as const) {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    let cancelled = 0;
    let released = 0;
    const response = {
      status: 200, url: "", redirected: false, headers: new Headers(),
      body: { getReader: () => ({
        read: () => { reading(); return new Promise(() => undefined); },
        cancel: () => { cancelled += 1; return new Promise(() => undefined); },
        releaseLock: () => { released += 1; throw new Error(KEY); },
      }) },
    } as unknown as Response;
    const { adapter } = replay(response);
    const controller = createHostAbortController();
    const pending = operation === "download" ? adapter.download(OUTPUT, controller.signal) :
      adapter.inspect(TASK_ID, STEMS, controller.signal);
    await started;
    controller.abort(new Error(KEY));
    await safeFailure(pending, /cancelled/u);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
  }
});

test("Stop at EOF preserves submit receipts but cancels ordinary JSON and audio outputs", async () => {
  for (const operation of ["submit", "upload", "check", "download"] as const) {
    const controller = createHostAbortController();
    const bytes = operation === "submit" ? Buffer.from(JSON.stringify({ task_id: TASK_ID })) :
      operation === "upload" ? Buffer.from(await uploadResponse().text()) :
      operation === "check" ? Buffer.from(await checkResponse(checkResult("progress", { progress: 42 })).text()) : BYTES;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (++pulls === 1) stream.enqueue(bytes);
        else { stream.close(); queueMicrotask(() => controller.abort(KEY)); }
      },
    });
    const { adapter } = replay(new Response(body as never));
    if (operation === "submit") {
      assert.equal(await adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal), TASK_ID);
    } else {
      await safeFailure(operation === "download" ? adapter.download(OUTPUT, controller.signal) :
        operation === "upload" ? adapter.upload(BYTES, "audio/wav", controller.signal) :
          adapter.inspect(TASK_ID, STEMS, controller.signal), /cancelled/u);
    }
    assert.equal(controller.signal.aborted, true);
  }
});

test("submit accepts a valid receipt during Stop grace and clears both deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const response = Promise.withResolvers<Response>();
    const { adapter, requests } = replay(() => response.promise);
    const controller = createHostAbortController();
    const pending = adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal);
    controller.abort(KEY);
    t.mock.timers.tick(2_999);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    response.resolve(json({ task_id: TASK_ID }));
    assert.equal(await pending, TASK_ID);
    t.mock.timers.tick(120_000);
    assert.equal(requests[0]!.init.signal!.aborted, false);
    assert.equal(requests.length, 1);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("stalled submit grace ends at three seconds or the original hard deadline, without retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    for (const age of [0, 119_000]) {
      const response = Promise.withResolvers<Response>();
      const { adapter, requests } = replay(() => response.promise);
      const controller = createHostAbortController();
      const pending = safeFailure(adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal), /cancelled/u);
      t.mock.timers.tick(age);
      controller.abort(KEY);
      t.mock.timers.tick(Math.min(3_000, 120_000 - age) - 1);
      assert.equal(requests[0]!.init.signal!.aborted, false);
      t.mock.timers.tick(1);
      await pending;
      assert.equal(requests[0]!.init.signal!.aborted, true);
      let cancelled = 0;
      response.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }) as never));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(cancelled, 1);
      assert.equal(requests.length, 1);
    }
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("submit grace bounds an unfinished receipt body even after complete JSON bytes arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const reading = Promise.withResolvers<void>();
    let pulls = 0;
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (++pulls === 1) stream.enqueue(Buffer.from(JSON.stringify({ task_id: TASK_ID })));
        else reading.resolve();
      },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const { adapter, requests } = replay(new Response(body as never));
    const controller = createHostAbortController();
    const pending = safeFailure(adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal), /cancelled/u);
    await reading.promise;
    controller.abort(KEY);
    t.mock.timers.tick(2_999);
    assert.equal(cancelled, 0);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(cancelled, 1);
    assert.equal(requests[0]!.init.signal!.aborted, true);
    assert.equal(requests.length, 1);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});

test("Stop grace never turns malformed or credential-bearing submit responses into receipts", async () => {
  for (const payload of ["{", "{}", JSON.stringify({ task_id: KEY })]) {
    const controller = createHostAbortController();
    const { adapter, requests } = replay(() => {
      controller.abort(KEY);
      return new Response(payload);
    });
    await safeFailure(adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal));
    assert.equal(requests.length, 1);
  }
});

test("real HTTP submit receipt survives Stop at the response EOF boundary", { timeout: 2000 }, async () => {
  const captured = Promise.withResolvers<{ path: string | undefined; key: string | string[] | undefined; body: string }>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    captured.resolve({ path: request.url, key: request.headers["x-license-key"], body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ task_id: TASK_ID }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const controller = createHostAbortController();
    let requests = 0;
    const adapter = createLalalAudioAdapter(KEY, { fetchImpl: async (input, init) => {
      requests++;
      assert.equal(String(input), "https://www.lalal.ai/api/v1/split/multistem/");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/split/multistem/`, init);
      const reader = response.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          const result = await reader.read();
          if (result.done) { stream.close(); controller.abort(KEY); reader.releaseLock(); }
          else stream.enqueue(result.value);
        },
        cancel() { return reader.cancel(); },
      });
      return new Response(body as never, { status: response.status, headers: response.headers });
    } });
    assert.equal(await adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, controller.signal), TASK_ID);
    assert.equal(controller.signal.aborted, true);
    assert.equal(requests, 1);
    const request = await captured.promise;
    assert.equal(request.path, "/api/v1/split/multistem/");
    assert.equal(request.key, KEY);
    assert.deepEqual(JSON.parse(request.body), { source_id: SOURCE_ID,
      presets: { stem_list: ["vocals", "drum"], encoder_format: "wav" }, idempotency_key: IDEMPOTENCY_KEY });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("request deadlines abort a stalled host without disclosing details", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    const { adapter, requests } = replay(() => new Promise<Response>(() => undefined));
    const pending = adapter.submit(SOURCE_ID, STEMS, IDEMPOTENCY_KEY, signal());
    t.mock.timers.tick(120_000);
    await safeFailure(pending, /timed out/u);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.init.signal!.aborted, true);
  } finally {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  }
});
