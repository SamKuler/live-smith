import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { ReadableStream } from "node:stream/web";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { MAX_AUDIO_ASSET_BYTES } from "../../src/audio-services/contracts.js";
import { createElevenLabsAudioAdapter } from "../../src/audio-services/elevenlabs/elevenlabs.js";
import { createLalalAudioAdapter } from "../../src/audio-services/lalal/lalal.js";
import { createMurekaAudioAdapter } from "../../src/audio-services/mureka/mureka.js";
import { createSunoPlatformAudioAdapter } from "../../src/audio-services/suno-platform/suno-platform.js";
import { createSunoApiAudioAdapter } from "../../src/audio-services/sunoapi/sunoapi.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const KEY = "synthetic-response-test-key";
const TASK = "2fe8f214-1771-4900-9e7e-570f823bd359";
const SOURCE = "e1fc1d8f-502e-4de0-bf3b-b30543d11c77";
const CALLBACK = "https://callbacks.example.org/music";
const MUSIC = { operation: "generate_music", prompt: "Soft piano", instrumental: true } as const;
const MP3 = Buffer.alloc(834);
MP3.set([0xff, 0xfb, 0x90, 0]);
MP3.set([0xff, 0xfb, 0x90, 0], 417);
const LALAL_OUTPUT = { key: "stem:vocals", role: "vocals", url: "https://d.lalal.ai/fixture/vocals" } as const;
const SUNO_OUTPUT = { key: "track1", role: "music", url: "https://file.aiquickdraw.com/fixture.mp3" } as const;
const PLATFORM_OUTPUT = { key: TASK, role: "music", url: "https://audiopipe.suno.ai/fixture.mp3" } as const;
const MUREKA_OUTPUT = { key: "song-a", role: "music", url: "https://cdn.mureka.ai/fixture.mp3" } as const;

const operations = {
  "sunoapi receipt": {
    bytes: Buffer.from(JSON.stringify({ code: 200, msg: "success", data: { taskId: TASK } })),
    mime: "application/json", expected: { kind: "task", taskId: TASK },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoApiAudioAdapter(KEY, { fetchImpl, callbackUrl: CALLBACK }).submit(MUSIC, signal),
  },
  "sunoapi poll": {
    bytes: Buffer.from(JSON.stringify({ code: 200, msg: "success", data: { taskId: TASK, status: "PENDING" } })),
    mime: "application/json", expected: { status: "running" },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoApiAudioAdapter(KEY, { fetchImpl, callbackUrl: CALLBACK }).inspect!(TASK, signal),
  },
  "sunoapi download": {
    bytes: MP3, mime: "audio/mpeg", expected: MP3,
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoApiAudioAdapter(KEY, { fetchImpl, callbackUrl: CALLBACK }).download!(SUNO_OUTPUT, signal),
  },
  "suno platform receipt": {
    bytes: Buffer.from(JSON.stringify({ id: TASK, status: "submitted" })),
    mime: "application/json", expected: { kind: "task", taskId: TASK, expectedOutputs: [{ key: TASK, role: "music" }] },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoPlatformAudioAdapter(KEY, { fetchImpl }).submit({ ...MUSIC, instrumental: false }, signal),
  },
  "suno platform poll": {
    bytes: Buffer.from(JSON.stringify({ id: TASK, status: "queued", detail: "waiting waiting waiting" })),
    mime: "application/json", expected: { status: "running" },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoPlatformAudioAdapter(KEY, { fetchImpl }).inspect!(TASK, signal, [{ key: TASK, role: "music" }]),
  },
  "suno platform download": {
    bytes: MP3, mime: "audio/mpeg", expected: MP3,
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createSunoPlatformAudioAdapter(KEY, { fetchImpl }).download!(PLATFORM_OUTPUT, signal),
  },
  "mureka receipt": {
    bytes: Buffer.from(JSON.stringify({ id: TASK, status: "preparing", model: "mureka-9.5" })),
    mime: "application/json", expected: { kind: "task", taskId: `song:${TASK}` },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createMurekaAudioAdapter(KEY, { fetchImpl }).submit({ ...MUSIC, instrumental: false }, signal),
  },
  "mureka poll": {
    bytes: Buffer.from(JSON.stringify({ id: TASK, status: "queued", detail: "waiting ".repeat(100) })),
    mime: "application/json", expected: { status: "running" },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createMurekaAudioAdapter(KEY, { fetchImpl }).inspect!(`song:${TASK}`, signal),
  },
  "mureka download": {
    bytes: MP3, mime: "audio/mpeg", expected: MP3,
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createMurekaAudioAdapter(KEY, { fetchImpl }).download!(MUREKA_OUTPUT, signal),
  },
  "elevenlabs audio": {
    bytes: MP3, mime: "audio/mpeg", expected: { kind: "audio", outputs: [{ role: "music", bytes: MP3 }] },
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createElevenLabsAudioAdapter(KEY, { fetchImpl }).submit(MUSIC, signal),
  },
  "lalal receipt": {
    bytes: Buffer.from(JSON.stringify({ task_id: TASK })), mime: "application/json", expected: TASK,
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createLalalAudioAdapter(KEY, { fetchImpl }).submit(SOURCE, ["vocals"], TASK, signal),
  },
  "lalal download": {
    bytes: MP3, mime: "audio/mpeg", expected: MP3,
    run: (fetchImpl: typeof fetch, signal: AbortSignal) =>
      createLalalAudioAdapter(KEY, { fetchImpl }).download(LALAL_OUTPUT, signal),
  },
};

async function loopbackResponse(t: TestContext, wireBytes: Buffer, mime: string, headers: Record<string, string>) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(200, { "Content-Type": mime, "Connection": "close", ...headers });
    response.end(wireBytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    // Only this loopback server is contacted. Preserve native Fetch's decoded
    // body and original headers; remove only the synthetic server's final URL.
    const response = await fetch(`http://127.0.0.1:${address.port}/fixture`, {
      method: init.method ?? "GET", ...(init.body ? { body: init.body } : {}),
      signal: init.signal ?? null,
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  return { fetchImpl, requests: () => requests };
}

for (const [name, operation] of Object.entries(operations)) {
  test(`${name}: native Fetch decodes compressed HTTP without treating wire length as decoded length`, { timeout: 5000 }, async (t) => {
    for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
      const wire = compress(operation.bytes);
      assert.notEqual(wire.length, operation.bytes.length);
      const h = await loopbackResponse(t, wire, operation.mime, {
        "Content-Encoding": encoding, "Content-Length": String(wire.length),
      });
      assert.deepEqual(await operation.run(h.fetchImpl, createHostAbortController().signal), operation.expected);
      assert.equal(h.requests(), 1);
    }
  });

  test(`${name}: absent and identity coding still require exact Content-Length`, async () => {
    for (const encoding of [undefined, "identity", " Identity "]) {
      for (const delta of [-1, 0, 1]) {
        let requests = 0;
        const fetchImpl: typeof fetch = async () => {
          requests++;
          return new Response(operation.bytes, { headers: {
            "Content-Type": operation.mime, "Content-Length": String(operation.bytes.length + delta),
            ...(encoding ? { "Content-Encoding": encoding } : {}),
          } });
        };
        const result = operation.run(fetchImpl, createHostAbortController().signal);
        if (delta) await assert.rejects(result, /Content-Length/);
        else assert.deepEqual(await result, operation.expected);
        assert.equal(requests, 1);
      }
    }
  });

  test(`${name}: native Fetch rejects truncated HTTP with and without compression`, { timeout: 5000 }, async (t) => {
    for (const compressed of [false, true]) {
      const wire = compressed ? gzipSync(operation.bytes) : operation.bytes;
      const h = await loopbackResponse(t, wire, operation.mime, {
        "Content-Length": String(wire.length + 8), ...(compressed ? { "Content-Encoding": "gzip" } : {}),
      });
      await assert.rejects(operation.run(h.fetchImpl, createHostAbortController().signal));
      assert.equal(h.requests(), 1);
    }
  });
}

test("compressed JSON expansion is bounded before parsing a paid receipt", { timeout: 5000 }, async (t) => {
  for (const name of ["sunoapi receipt", "suno platform receipt", "mureka receipt", "lalal receipt"] as const) {
    const operation = operations[name];
    const bytes = Buffer.from(JSON.stringify({ padding: "x".repeat(65536) }));
    const wire = gzipSync(bytes);
    const h = await loopbackResponse(t, wire, operation.mime, {
      "Content-Encoding": "gzip", "Content-Length": String(wire.length),
    });
    await assert.rejects(operation.run(h.fetchImpl, createHostAbortController().signal), /byte limit/);
    assert.equal(h.requests(), 1);
  }
});

test("encoded response headers never remove the decoded audio byte cap or reader cleanup", async () => {
  for (const name of ["sunoapi download", "suno platform download", "mureka download", "elevenlabs audio", "lalal download"] as const) {
    const operation = operations[name];
    let reads = 0; let cancels = 0; let releases = 0;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const response = {
      status: 200, redirected: false, url: "",
      headers: new Headers({ "Content-Type": operation.mime, "Content-Encoding": "gzip", "Content-Length": "32" }),
      body: { getReader: () => ({
        read: async () => { reads++; return { done: false, value: chunk }; },
        cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
      }) },
    } as unknown as Response;
    await assert.rejects(operation.run(async () => response, createHostAbortController().signal), /byte limit|128 MiB/);
    assert.equal(reads, MAX_AUDIO_ASSET_BYTES / chunk.length + 1);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
  }
});

test("LALAL eager empty chunks yield to Stop, cancel once and release the reader", async () => {
  const controller = createHostAbortController();
  let reads = 0; let cancels = 0; let releases = 0;
  const response = {
    status: 200, redirected: false, url: "", headers: new Headers(),
    body: { getReader: () => ({
      read: async () => ++reads > 10_000 ? { done: true } : { done: false, value: new Uint8Array(0) },
      cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
    }) },
  } as unknown as Response;
  const pending = operations["lalal download"].run(async () => response, controller.signal)
    .then(() => undefined, error => error as Error);
  await setImmediate();
  controller.abort(KEY);
  const error = await pending;
  assert.equal(error?.name, "AbortError");
  assert.ok(reads > 0 && reads <= 128);
  assert.equal(cancels, 1);
  assert.equal(releases, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("LALAL eager reads let hard and Stop-grace deadlines run, then clear them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  try {
    for (const stop of [false, true]) {
      const controller = createHostAbortController();
      let reads = 0; let cancels = 0; let releases = 0;
      const response = {
        status: 200, redirected: false, url: "", headers: new Headers(),
        body: { getReader: () => ({
          read: async () => ++reads > 10_000 ? { done: true } : { done: false, value: new Uint8Array(0) },
          cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
        }) },
      } as unknown as Response;
      const pending = operations["lalal receipt"].run(async () => response, controller.signal)
        .then(() => undefined, error => error as Error);
      if (stop) controller.abort(KEY);
      await setImmediate();
      t.mock.timers.tick(stop ? 3000 : 120_000);
      const error = await pending;
      assert.match(error?.message ?? "", stop ? /cancelled/ : /timed out/);
      assert.ok(reads > 0 && reads <= 128);
      assert.equal(cancels, 1);
      assert.equal(releases, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      t.mock.timers.tick(120_000);
      assert.equal(cancels, 1);
    }
  } finally { t.mock.timers.reset(); syncBuiltinESMExports(); }
});

test("LALAL owns reused tiny chunks across block boundaries and empty reads", async () => {
  const expected = Buffer.alloc(70_000);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
  let offset = 0;
  let empty = false;
  const chunk = new Uint8Array(1);
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === expected.length) { controller.close(); return; }
      empty = !empty;
      if (empty) controller.enqueue(new Uint8Array(0));
      else { chunk[0] = expected[offset++]!; controller.enqueue(chunk); }
    },
  }, { highWaterMark: 0 }) as never);
  assert.deepEqual(await operations["lalal download"].run(async () => response, createHostAbortController().signal), expected);
});
