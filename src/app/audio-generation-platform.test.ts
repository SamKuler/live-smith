import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";

import { createSunoPlatformAudioAdapter } from "../audio-services/suno-platform.js";
import { createSession } from "../storage/sessions.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { generateAudio } from "./audio-generation.js";
import { audioJobViews } from "./audio-processing.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

const ID = "11111111-1111-4111-8111-111111111111";
const AUDIO = "https://audiopipe.suno.ai/official-fixture.wav";

test("official Platform completes through the provider-neutral job lifecycle", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-platform-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Official Suno", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const apiKey = "fixture-official-platform-key";
  const serviceId = "official-suno";
  await saveIntegrationConnection(directory, "0", {
    id: serviceId, name: "Official Suno", provider: "suno-platform", enabled: true, apiKey,
  });
  const calls: string[] = [];
  let polls = 0;
  const adapter = createSunoPlatformAudioAdapter(apiKey, { fetchImpl: async (input, init) => {
    const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://api.suno.com/v0/audio" && init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), { description: "Warm analog ambient" });
      return Response.json({ id: ID, status: "submitted" });
    }
    if (url === `https://api.suno.com/v0/audio/${ID}`) {
      return Response.json(++polls === 1 ? { id: ID, status: "streaming", audio_url: AUDIO }
        : { id: ID, status: "complete", audio_url: AUDIO });
    }
    assert.equal(url, AUDIO);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return new Response(waveBytes().slice().buffer, { headers: { "content-type": "audio/wav" } });
  } });
  const job = await generateAudio({ storageDirectory: directory, sessionId: session.id,
    signal: new AbortController().signal, generationAdapter: adapter, wait: async () => {} }, serviceId,
  { operation: "generate_music", prompt: "Warm analog ambient", instrumental: false });
  assert.equal(job.provider, "suno-platform");
  assert.equal(job.status, "completed");
  assert.deepEqual(job.expectedOutputs, [{ key: ID, role: "music" }]);
  assert.deepEqual(job.outputAssets.map((output) => output.role), ["music"]);
  assert.equal(calls.filter((call) => call.startsWith("POST ")).length, 1);
  assert.equal(calls.filter((call) => call === `GET ${AUDIO}`).length, 1);
  assert.doesNotMatch(JSON.stringify(await audioJobViews(directory, session.id)), /fixture-official|api\.suno\.com|audiopipe/);
});
