import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import type { AudioGenerationRequest } from "../../src/audio-services/contracts.js";
import { createSunoPlatformAudioAdapter } from "../../src/audio-services/suno-platform.js";
import { createHostAbortController } from "../../src/runtime/host.js";

const API_KEY = "fixture-suno-platform-key";
const API = "https://api.suno.com";
const ID = "11111111-1111-4111-8111-111111111111";
const AUDIO = "https://audiopipe.suno.ai/fixture.mp3?signature=opaque";
const signal = () => createHostAbortController().signal;
const simple: AudioGenerationRequest = {
  operation: "generate_music", prompt: "Dreamy synthwave night drive", instrumental: false,
};

function mp3Bytes(): Buffer {
  const frameSize = Math.floor(144 * 128000 / 44100);
  const bytes = Buffer.alloc(frameSize * 2);
  bytes.set([0xff, 0xfb, 0x90, 0]);
  bytes.set([0xff, 0xfb, 0x90, 0], frameSize);
  return bytes;
}

function replay(responses: Response[]) {
  const requests: Array<{ url: string; init: RequestInit; body?: unknown; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init, headers: new Headers(init.headers),
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or extra provider request");
    return response;
  };
  return { adapter: createSunoPlatformAudioAdapter(API_KEY, { fetchImpl }), requests };
}

async function safeFailure(operation: Promise<unknown>, pattern = /Suno Platform audio service/u) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.stack ?? "", /fixture-suno-platform-key|remote-secret|private prompt/u);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("official Platform simple generation uses only api.suno.com and returns a resumable receipt", async () => {
  const h = replay([Response.json({ id: ID, status: "submitted", created_at: "2026-09-11T00:00:00Z" })]);
  assert.equal(h.adapter.provider, "suno-platform");
  assert.deepEqual(await h.adapter.submit(simple, signal()), { kind: "task", taskId: ID,
    expectedOutputs: [{ key: ID, role: "music" }] });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.url, `${API}/v0/audio`);
  assert.equal(h.requests[0]!.init.method, "POST");
  assert.deepEqual(Object.fromEntries(h.requests[0]!.headers), {
    accept: "application/json", authorization: `Bearer ${API_KEY}`, "content-type": "application/json",
  });
  assert.deepEqual(h.requests[0]!.body, { description: simple.prompt });
  assert.equal(h.requests[0]!.init.redirect, "error");
  assert.equal(h.requests[0]!.init.credentials, "omit");
});

test("official Platform custom mode maps literal lyrics, style, title, voice and instrumental", async () => {
  const h = replay([Response.json({ id: ID, status: "queued" })]);
  const request: AudioGenerationRequest = {
    operation: "generate_music", prompt: "[Verse]\nSignals in the rain", instrumental: true,
    options: { mode: "custom", title: "Signal", styles: "dreampop", personaId: "22222222-2222-4222-8222-222222222222" },
  };
  await h.adapter.submit(request, signal());
  assert.deepEqual(h.requests[0]!.body, {
    lyrics: request.prompt, style: "dreampop", title: "Signal",
    voice_id: "22222222-2222-4222-8222-222222222222", instrumental: true,
  });
});

test("official Platform instrumental descriptions use custom style mode without invented lyrics", async () => {
  const h = replay([Response.json({ id: ID, status: "submitted" })]);
  await h.adapter.submit({ ...simple, instrumental: true }, signal());
  assert.deepEqual(h.requests[0]!.body, { style: simple.prompt, instrumental: true });
});

test("official Platform status polling exposes only a completed provider output", async () => {
  for (const status of ["submitted", "queued", "streaming"]) {
    const h = replay([Response.json({ id: ID, status, ...(status === "streaming" ? { audio_url: AUDIO } : {}) })]);
    assert.deepEqual(await h.adapter.inspect!(ID, signal(), [{ key: ID, role: "music" }]), { status: "running" });
    assert.equal(h.requests[0]!.url, `${API}/v0/audio/${ID}`);
    assert.equal(h.requests[0]!.init.method, "GET");
  }
  const complete = replay([Response.json({ id: ID, status: "complete", audio_url: AUDIO })]);
  assert.deepEqual(await complete.adapter.inspect!(ID, signal(), [{ key: ID, role: "music" }]), {
    status: "completed", outputs: [{ key: ID, role: "music", url: AUDIO }],
  });
  const failed = replay([Response.json({ id: ID, status: "error", error: `remote-secret ${API_KEY}` })]);
  const result = await failed.adapter.inspect!(ID, signal(), [{ key: ID, role: "music" }]);
  assert.deepEqual(result, { status: "failed", message: "Suno Platform audio service: task failed." });
  assert.doesNotMatch(JSON.stringify(result), /remote-secret|fixture-suno-platform-key/u);
});

test("official Platform downloads its authenticated result without forwarding the API key", async () => {
  const bytes = mp3Bytes();
  const h = replay([new Response(bytes as unknown as BodyInit, { headers: { "content-type": "audio/mpeg" } })]);
  assert.deepEqual(await h.adapter.download!({ key: ID, role: "music", url: AUDIO }, signal()), bytes);
  assert.equal(h.requests[0]!.url, AUDIO);
  assert.equal(h.requests[0]!.headers.get("authorization"), null);
  assert.equal(h.requests[0]!.headers.get("accept"), "audio/mpeg, audio/wav, application/octet-stream");
});

test("official Platform rejects unsupported parameters and malformed provider data before another paid call", async () => {
  const h = replay([]);
  for (const request of [
    { ...simple, durationSeconds: 30 },
    { ...simple, operation: "generate_sound_effect", durationSeconds: 1, loop: false },
    { ...simple, options: { mode: "custom" } },
    { ...simple, options: { mode: "custom", styles: "pop", negativeStyles: "metal" } },
    { ...simple, options: { mode: "custom", styles: "pop", weirdness: 50 } },
    { ...simple, options: { mode: "custom", styles: "pop", styleInfluence: 50 } },
  ]) await safeFailure(h.adapter.submit(request as AudioGenerationRequest, signal()));
  assert.equal(h.requests.length, 0);
  for (const key of ["", " key", "x\r\ny", "x".repeat(4097)]) {
    assert.throws(() => createSunoPlatformAudioAdapter(key), /API key/u);
  }
});

test("official Platform validates receipts, task identity, status and output URLs", async () => {
  for (const value of [{}, { id: "bad/id", status: "submitted" }, { id: ID, status: "unknown" },
    { id: ID, status: "complete" }, { id: ID, status: "complete", audio_url: "http://127.0.0.1/private" },
    { id: ID, status: "complete", audio_url: `https://cdn.suno.ai/${API_KEY}.mp3` }]) {
    const h = replay([Response.json(value)]);
    if (value.status === "submitted") await safeFailure(h.adapter.submit(simple, signal()));
    else await safeFailure(h.adapter.inspect!(ID, signal(), [{ key: ID, role: "music" }]));
  }
  const mismatch = replay([Response.json({ id: "22222222-2222-4222-8222-222222222222", status: "complete", audio_url: AUDIO })]);
  await safeFailure(mismatch.adapter.inspect!(ID, signal(), [{ key: ID, role: "music" }]), /task ID/u);
});

test("official Platform never retries HTTP failures, redirects or cancelled work", async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const h = replay([new Response(`remote-secret ${API_KEY}`, { status })]);
    await safeFailure(h.adapter.submit({ ...simple, prompt: "private prompt" }, signal()), new RegExp(`HTTP ${status}`));
    assert.equal(h.requests.length, 1);
  }
  const redirected = Response.json({ id: ID, status: "submitted" });
  Object.defineProperty(redirected, "redirected", { value: true });
  await safeFailure(replay([redirected]).adapter.submit(simple, signal()), /redirect/u);
  const controller = createHostAbortController();
  controller.abort(new Error(API_KEY));
  const h = replay([]);
  await safeFailure(h.adapter.submit(simple, controller.signal), /cancelled/u);
  assert.equal(h.requests.length, 0);
});
