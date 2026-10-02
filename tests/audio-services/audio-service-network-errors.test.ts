import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { AudioSubmissionNotStartedError, AudioToolOutcomeUnknownError } from "../../src/audio-services/contracts.js";
import { createElevenLabsHttp } from "../../src/audio-services/elevenlabs/elevenlabs-http.js";
import { createGoogleLyriaAudioAdapter } from "../../src/audio-services/google-lyria/google-lyria.js";
import { createLalalHttp } from "../../src/audio-services/lalal/lalal-http.js";
import { createMurekaHttp } from "../../src/audio-services/mureka/mureka-http.js";
import { generateMurekaLyrics } from "../../src/audio-services/mureka/mureka.js";
import { createSunoPlatformHttp } from "../../src/audio-services/suno-platform/suno-platform-http.js";
import { createSunoApiHttp } from "../../src/audio-services/sunoapi/sunoapi-http.js";
import { createSunoHttp } from "../../src/audio-services/suno/suno-http.js";
import { writeSunoLyrics } from "../../src/audio-services/suno/suno-lyrics.js";
import { createSunoSessionResolver } from "../../src/audio-services/suno/suno-session.js";
import { createSunoUploadAdapter } from "../../src/audio-services/suno/suno-upload.js";
import { NetworkProxyError } from "../../src/runtime/network-proxy-error.js";
import { A, API, accountId, clientToken, replay, session, token } from "./suno/support/audio-service-suno-harness.js";

const KEY = "fixture-network-key-only";
const PRIVATE_DETAIL = "raw-secret fixture-network-key-only https://private.invalid/?token=private";
const PROXY_MESSAGE = "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.";
const generationPath = "/api/generate/v2-web/";
const lyricsPath = "/api/generate/cowrite-lyrics/";

interface HttpCase {
  name: string;
  invoke(fetchImpl: typeof fetch, signal: AbortSignal): Promise<unknown>;
  notStarted?: true;
  unknownToolResult?: true;
}

function authenticatedSunoFetch(fetchImpl: typeof fetch, path: string): typeof fetch {
  return replay([{ path, run: () => fetchImpl(`${API}${path}`) }]).fetchImpl;
}

const cases: readonly HttpCase[] = [
  { name: "ElevenLabs generation", invoke: (fetchImpl, signal) => createElevenLabsHttp(KEY, fetchImpl)("music", {}, signal) },
  { name: "LALAL submission", invoke: (fetchImpl, signal) => createLalalHttp(KEY, fetchImpl).post("split/multistem/", "{}", signal) },
  { name: "Mureka generation", invoke: (fetchImpl, signal) => createMurekaHttp(KEY, fetchImpl).submit("prompt-song", { prompt: "Piano" }, signal) },
  { name: "Suno Platform generation", invoke: (fetchImpl, signal) => createSunoPlatformHttp(KEY, fetchImpl).submit({ description: "Piano" }, signal) },
  { name: "SunoAPI generation", invoke: (fetchImpl, signal) => createSunoApiHttp(KEY, fetchImpl).post({ prompt: "Piano" }, signal) },
  { name: "Google Lyria generation", invoke: (fetchImpl, signal) => createGoogleLyriaAudioAdapter(KEY, { fetchImpl }).submit({
    operation: "generate_music", prompt: "Piano", instrumental: true,
  }, signal) },
  { name: "Suno generation", invoke: (fetchImpl, signal) => createSunoHttp(session, authenticatedSunoFetch(fetchImpl, generationPath))
    .request("POST", generationPath, { prompt: "Piano" }, signal) },
  { name: "Suno media download", invoke: (fetchImpl, signal) => createSunoHttp(session, fetchImpl).download(`https://cdn1.suno.ai/${A}.mp3`, signal) },
  { name: "Suno client authentication", invoke: (fetchImpl, signal) => createSunoSessionResolver(fetchImpl)(clientToken, signal) },
  { name: "Suno storage upload", invoke: (fetchImpl, signal) => createSunoUploadAdapter(session, { fetchImpl }).upload({
    uploadId: A, url: "https://suno-data-uploads.s3.amazonaws.com/", fields: { key: "fixture-audio", policy: "fixture-policy" },
  }, Buffer.from([1, 2, 3]), "audio/mpeg", signal) },
  { name: "Suno authentication before generation", notStarted: true, invoke: (fetchImpl, signal) =>
    createSunoHttp(session, fetchImpl).request("POST", generationPath, { prompt: "Piano" }, signal) },
  { name: "Mureka paid lyrics", unknownToolResult: true, invoke: (fetchImpl, signal) => generateMurekaLyrics(KEY, "Piano", signal, { fetchImpl }) },
  { name: "Suno paid lyrics", unknownToolResult: true, invoke: (fetchImpl, signal) => writeSunoLyrics(session, {
    selected: "", instruction: "Write about rain",
  }, signal, { fetchImpl: authenticatedSunoFetch(fetchImpl, lyricsPath) }) },
];

test("audio HTTP boundaries preserve fixed proxy diagnostics without changing paid-request outcomes", async (t) => {
  for (const entry of cases) await t.test(entry.name, async () => {
    let requests = 0;
    const failure = new NetworkProxyError(PROXY_MESSAGE);
    const fetchImpl: typeof fetch = async () => { requests += 1; throw failure; };
    await assert.rejects(entry.invoke(fetchImpl, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(PROXY_MESSAGE));
      assert.equal(error instanceof AudioSubmissionNotStartedError, entry.notStarted === true);
      assert.equal(error instanceof AudioToolOutcomeUnknownError, entry.unknownToolResult === true);
      if (!entry.notStarted && !entry.unknownToolResult) assert.equal(error, failure);
      if (entry.unknownToolResult) assert.match(error.message, /unconfirmed.*not submit.*automatically/i);
      if (!entry.notStarted) assert.doesNotMatch(error.message, /No generation was submitted/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test("audio HTTP boundaries hide ordinary sensitive transport errors and never retry them", async (t) => {
  for (const entry of cases) await t.test(entry.name, async () => {
    let requests = 0;
    const failure = new Error(PRIVATE_DETAIL, { cause: { Authorization: KEY } });
    await assert.rejects(entry.invoke(async () => { requests += 1; throw failure; }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error, failure);
      assert.doesNotMatch(error.stack ?? error.message, /raw-secret|fixture-network-key-only|private\.invalid/);
      assert.equal(error.cause, undefined);
      assert.equal(error instanceof AudioSubmissionNotStartedError, entry.notStarted === true);
      assert.equal(error instanceof AudioToolOutcomeUnknownError, entry.unknownToolResult === true);
      return true;
    });
    assert.equal(requests, 1);
  });
});

test("Suno touch proxy failure does not fall back to another authentication endpoint", async () => {
  let requests = 0;
  const failure = new NetworkProxyError(PROXY_MESSAGE);
  const sessionToken = token({ sub: accountId, sid: "sess_synthetic", exp: Math.floor(Date.now() / 1000) + 120 });
  await assert.rejects(createSunoSessionResolver(async () => { requests += 1; throw failure; })(
    `__session=${sessionToken}`, new AbortController().signal,
  ), (error: unknown) => error === failure);
  assert.equal(requests, 1);
});
