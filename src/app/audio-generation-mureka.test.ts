import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import test from "node:test";

import { createMurekaAudioAdapter } from "../audio-services/mureka.js";
import type { AudioGenerationAdapter } from "../audio-services/contracts.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { murekaPlugin } from "../plugins/builtins/mureka.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { createSession } from "../storage/sessions.js";
import { generateAudio } from "./audio-generation.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";
import { createRequestAudioTools } from "./request-audio-tools.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

function lyricMetadata() {
  return [{
    section_type: "verse", start: 0, end: 360_000,
    lines: Array.from({ length: 120 }, (_, line) => ({
      start: line * 3_000, end: (line + 1) * 3_000,
      text: "la la la la la la la la",
      words: Array.from({ length: 8 }, (_, word) => ({
        start: line * 3_000 + word * 375,
        end: line * 3_000 + (word + 1) * 375,
        text: "la",
      })),
    })),
  }];
}

test("Mureka generation and Resume share the provider-neutral single-output job lifecycle", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mureka-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Mureka", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const apiKey = "fixture-mureka-app-key";
  const connectionId = "mureka-studio";
  await saveIntegrationConnection(directory, "0", {
    id: connectionId, name: "Mureka studio", provider: "mureka", enabled: true,
    apiKey, modelId: "mureka-9",
  });

  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  let failDownload = true;
  let renewed = false;
  const fetchImpl = (async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, authorization: new Headers(init.headers).get("Authorization") });
    if (url === "https://api.mureka.ai/v1/song/easy-generate") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        model: "mureka-9", n: 1, prompt: "Nocturnal analog synthwave", stream: false,
      });
      return Response.json({ id: "task-one", status: "preparing", model: "mureka-9" });
    }
    if (url === "https://api.mureka.ai/v1/song/query/task-one") {
      const response = { id: "task-one", status: "succeeded", choices: [{
        index: 0, id: "track-a", url: `https://cdn.mureka.ai/first.wav${renewed ? "?renewed=1" : ""}`,
        lyrics_sections: lyricMetadata(),
      }] };
      assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 64 * 1024,
        "the official word-timestamp shape must remain within the accepted response byte limit");
      return Response.json(response);
    }
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    if (failDownload) return new Response("offline", { status: 503 });
    return new Response(waveBytes().slice().buffer, { headers: { "Content-Type": "audio/wav" } });
  }) as typeof fetch;
  const adapter = createMurekaAudioAdapter(apiKey, { modelId: "mureka-9", fetchImpl });
  const context = { storageDirectory: directory, sessionId: session.id,
    signal: new AbortController().signal, generationAdapter: adapter, wait: async () => {} };

  const interrupted = await generateAudio(context, connectionId, {
    operation: "generate_music", prompt: "Nocturnal analog synthwave", instrumental: false,
  });
  assert.equal(interrupted.provider, "mureka");
  assert.equal(interrupted.remoteTaskId, "song:task-one");
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(interrupted.expectedOutputs, [{ key: "track-a", role: "music" }]);
  assert.deepEqual(interrupted.outputAssets, []);

  failDownload = false;
  renewed = true;
  const completed = await resumeAudioJob({ ...context,
    generationAdapter: createMurekaAudioAdapter(apiKey, { modelId: "mureka-9", fetchImpl }),
  }, interrupted.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.outputAssets.map((asset) => asset.role), ["music"]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "Resume must not submit another paid task");
  assert.equal(calls.filter((call) => call.url.includes("first.wav")).length, 2);
  assert.ok(calls.some((call) => call.url.endsWith("first.wav?renewed=1")));
  assert.ok(calls.filter((call) => call.url.includes("cdn.mureka.ai")).every((call) => call.authorization === null));
  assert.doesNotMatch(JSON.stringify(await audioJobViews(directory, session.id)),
    /fixture-mureka-app-key|api\.mureka\.ai|cdn\.mureka\.ai|task-one|track-a/u);
});

test("Mureka rejects an o2 instrumental before creating a paid-work job", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mureka-o2-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Mureka o2", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  await saveIntegrationConnection(directory, "0", {
    id: "mureka-o2", name: "Mureka o2", provider: "mureka", enabled: true,
    apiKey: "fixture-mureka-o2-key", modelId: "mureka-o2",
  });
  let submitted = false;
  await assert.rejects(generateAudio({ storageDirectory: directory, sessionId: session.id,
    signal: new AbortController().signal, generationAdapter: {
      provider: "mureka", submit: async () => { submitted = true; throw new Error("must not submit"); },
    } }, "mureka-o2", {
    operation: "generate_music", prompt: "Instrumental cinematic score", instrumental: true,
  }), /selected model.*instrumental/i);
  assert.equal(submitted, false);
  assert.deepEqual(await listAudioJobs(directory, session.id), []);
});

test("Mureka Plugin lyric tools keep text results out of audio jobs and persist lyrics-to-song identity", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-mureka-tools-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Mureka tools", projectKey: "project",
    scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const apiKey = "fixture-mureka-tools-key";
  const connectionId = "mureka-tools";
  await saveIntegrationConnection(directory, "0", {
    id: connectionId, name: "Mureka tools", provider: "mureka", enabled: true,
    apiKey, modelId: "mureka-9.5",
  });
  const submissions: unknown[] = [];
  const generationAdapter: AudioGenerationAdapter = {
    provider: "mureka",
    submit: async (request) => {
      submissions.push(request);
      return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
    },
  };
  let authorizationRuns = 0;
  const tools = await createRequestAudioTools({
    context: {} as never,
    storageDirectory: directory,
    sessionId: session.id,
    requestId: "request",
    attachmentRefs: [],
    target: {},
    signal: new AbortController().signal,
    onProgress() {},
    onAssets() {},
    withGenerationAuthorization: async (_signal, operation) => {
      authorizationRuns += 1;
      return operation();
    },
    processing: {
      generationAdapter,
      murekaLyricsGenerator: async (credential, prompt, signal, options) => {
        assert.equal(credential, apiKey);
        assert.equal(prompt, "A hopeful night-drive song");
        assert.equal(signal.aborted, false);
        assert.equal(typeof options?.fetchImpl, "function");
        return { title: "Afterlight", lyrics: "[Verse]\nCity lights" };
      },
    },
  });
  const execute = (localName: string, args: unknown) => tools.execute({
    id: localName,
    name: builtInAudioToolName(murekaPlugin, localName),
    arguments: JSON.stringify(args),
  });

  const lyrics = await execute("generate_lyrics", {
    connectionId,
    prompt: "A hopeful night-drive song",
  });
  assert.deepEqual(JSON.parse(lyrics.content), {
    title: "Afterlight",
    lyrics: "[Verse]\nCity lights",
  });
  assert.equal(authorizationRuns, 1);
  assert.deepEqual(await listAudioJobs(directory, session.id), []);

  const song = await execute("generate_song_from_lyrics", {
    connectionId,
    lyrics: "[Verse]\nCity lights",
    prompt: "future garage",
    gender: "female",
  });
  assert.equal(song.failed, undefined);
  assert.deepEqual(submissions, [{
    operation: "generate_song_from_lyrics",
    lyrics: "[Verse]\nCity lights",
    prompt: "future garage",
    gender: "female",
  }]);
  const [saved] = await listAudioJobs(directory, session.id);
  assert.deepEqual({
    pluginId: saved?.pluginId,
    toolId: saved?.toolId,
    toolVersion: saved?.toolVersion,
    operation: saved?.operation,
    modelId: saved?.modelId,
    status: saved?.status,
  }, {
    pluginId: "live-smith.mureka",
    toolId: "generate_song_from_lyrics",
    toolVersion: "1",
    operation: "generate_song_from_lyrics",
    modelId: "mureka-9.5",
    status: "completed",
  });
});
