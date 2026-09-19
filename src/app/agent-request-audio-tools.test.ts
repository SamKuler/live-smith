import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { Buffer } from "node:buffer";

import { SEPARATION_STEMS, type AudioServiceAdapter, type AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { loadSessionEvents } from "../storage/events.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import { handleAgentRequest } from "./agent-request.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";
import { builtInAudioToolName } from "../plugins/builtins/audio-toolsets.js";
import { elevenLabsPlugin } from "../plugins/builtins/elevenlabs.js";
import { lalalPlugin } from "../plugins/builtins/lalal.js";
import { sunoWebsitePlugin } from "../plugins/builtins/suno-website.js";
import { saveIntegrationConnection } from "./integration-connection-test-helpers.js";

const separateStemsTool = builtInAudioToolName(lalalPlugin, "separate_stems");
const elevenMusicTool = builtInAudioToolName(elevenLabsPlugin, "generate_music");
const sunoMusicTool = builtInAudioToolName(sunoWebsitePlugin, "generate_music");

test("a text-only chat model separates an attached file and reuses saved stems in a later send", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-audio-integration-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Stems", projectKey: "project", scope: { kind: "track", identity: "1", label: "Track" } });
  await saveIntegrationConnection(directory, "0", {
    id: "splitter", name: "Stem account", provider: "lalal", enabled: true,
    apiKey: "fixture-private-audio-key",
  });
  await saveSessionAttachment(directory, session.id, { fileName: "reference.wav", bytes: waveBytes() }, { preSavePendingAttachmentRefs: [] });
  const runtime = runtimeProfileForSavedProfile({
    id: "text-profile", name: "Text model", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test", apiKey: "model-test-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  let uploads = 0;
  const adapter: AudioServiceAdapter = {
    provider: "lalal", stems: SEPARATION_STEMS,
    upload: async (bytes) => { assert.deepEqual(bytes, waveBytes()); uploads++; return "source"; },
    submit: async () => "task",
    inspect: async () => ({ status: "completed", outputs: [
      { key: "vocals", role: "vocals", url: "https://d.lalal.ai/a" },
      { key: "rest", role: "residual", url: "https://d.lalal.ai/b" },
    ] }),
    download: async () => waveBytes(),
  };
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope };
  const context = { application: { song: { tempo: 120 } }, environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const callbacks = {
    signal: new AbortController().signal,
    onDelta() {}, onProgress() {}, onSessionEvent() {},
    confirmActions: async () => { throw new Error("Separation must not modify Live"); },
    audioProcessing: { adapter, wait: async () => {} },
  };
  let turns = 0;
  let assetId = "";
  const first = await handleAgentRequest(context, directory, interaction, "Separate vocals", runtime, "project", session.id, callbacks, async (request) => {
    assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === separateStemsTool));
    assert.ok(request.attachmentParts?.every((part) => part.type !== "audio"));
    if (++turns === 1) {
      const match = request.requestAudioSampleSourceInstructions?.match(/Audio input 1: (\{[^\n]+\})/);
      assert.ok(match?.[1]);
      return { content: null, toolCalls: [{ id: "split", name: separateStemsTool, arguments: JSON.stringify({ connectionId: "splitter", source: JSON.parse(match[1]), stems: ["vocals"] }) }] };
    }
    const result = JSON.parse(request.agentMessages.at(-1)!.content!);
    assert.equal(result.status, "completed");
    assetId = result.outputs[0].id;
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    return { content: "Stems ready.", toolCalls: [] };
  });
  assert.equal(first, "Stems ready."); assert.equal(uploads, 1);
  await handleAgentRequest(context, directory, interaction, "Show previous results", runtime, "project", session.id, callbacks, async (request) => {
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    assert.doesNotMatch(JSON.stringify(request), /fixture-private-audio-key|d\.lalal\.ai/);
    return { content: "Previous stems are available.", toolCalls: [] };
  });
  const history = JSON.stringify(await loadSessionEvents(directory, session.id));
  assert.doesNotMatch(history, /fixture-private-audio-key|d\.lalal\.ai|\/private\/tmp\//);
});

test("a text-only chat model generates music through a named connection and exposes it on the next send", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-music-integration-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Music", projectKey: "project", scope: { kind: "track", identity: "1", label: "Track" } });
  await saveIntegrationConnection(directory, "0", {
    id: "music-account", name: "Music production", provider: "elevenlabs",
    enabled: true, apiKey: "fixture-music-secret",
  });
  const runtime = runtimeProfileForSavedProfile({
    id: "text-profile", name: "Text model", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test", apiKey: "model-test-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  let generations = 0;
  const generationAdapter: AudioGenerationAdapter = { provider: "elevenlabs", submit: async (request) => {
    assert.deepEqual(request, { operation: "generate_music", prompt: "Ambient piano", durationSeconds: 10, instrumental: true });
    generations++;
    return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
  } };
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope };
  const context = { application: { song: { tempo: 120 } }, environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const callbacks = { signal: new AbortController().signal, onDelta() {}, onProgress() {}, onSessionEvent() {},
    confirmActions: async () => { throw new Error("Generation must not modify Live"); }, audioProcessing: { generationAdapter } };
  let turns = 0;
  let assetId = "";
  const first = await handleAgentRequest(context, directory, interaction, "Generate ambient piano", runtime, "project", session.id, callbacks, async (request) => {
    assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === elevenMusicTool));
    assert.ok(!request.tools.some((tool) => tool.type === "function" && tool.function.name === separateStemsTool));
    assert.ok(!request.tools.some((tool) => tool.type === "function" && tool.function.name === "listen_to_audio_asset"));
    if (++turns === 1) return { content: null, toolCalls: [{ id: "music-call", name: elevenMusicTool, arguments: JSON.stringify({
      connectionId: "music-account", prompt: "Ambient piano", durationSeconds: 10, instrumental: true,
    }) }] };
    const result = JSON.parse(request.agentMessages.at(-1)!.content!);
    assert.equal(result.status, "completed"); assert.equal(result.serviceId, "music-account");
    assert.equal(result.operation, "generate_music"); assetId = result.outputs[0].id;
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    return { content: "Music ready.", toolCalls: [] };
  });
  assert.equal(first, "Music ready."); assert.equal(generations, 1);
  assert.equal((await listAudioJobs(directory, session.id))[0]?.outputAssets[0]?.id, assetId);
  await handleAgentRequest(context, directory, interaction, "Use that music", runtime, "project", session.id, callbacks, async (request) => {
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    assert.doesNotMatch(JSON.stringify(request), /fixture-music-secret|\/private\/tmp/);
    return { content: "The saved music is available.", toolCalls: [] };
  });
  assert.doesNotMatch(JSON.stringify(await loadSessionEvents(directory, session.id)), /fixture-music-secret|\/private\/tmp/);
});

test("a chat model can select Suno rendered audio with bounded advanced controls", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-agent-integration-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Suno", projectKey: "project",
    scope: { kind: "track", identity: "1", label: "Track" } });
  await saveIntegrationConnection(directory, "0", {
    id: "suno-account", name: "Suno account", provider: "suno", enabled: true, apiKey: "",
  });
  const clientToken = ["{}", "fixture-client", "fixture-signature"]
    .map((part) => Buffer.from(part).toString("base64url")).join(".");
  await new SunoSessions(directory).save("suno-account", {
    accountId: "user_fixture", clientToken,
  });
  const runtime = runtimeProfileForSavedProfile({
    id: "text-profile", name: "Text model", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses",
      baseUrl: "https://example.test", apiKey: "model-test-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 1024,
      reasoning: { mode: "default" } }, advanced: {} }],
  });
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const expected = { operation: "generate_music" as const, prompt: "[Verse]\nNeon rain",
    durationSeconds: 120, instrumental: false,
    options: { mode: "custom" as const, styles: "future garage", vocalGender: "female" as const } };
  let preparations = 0;
  let submissions = 0;
  const generationAdapter: AudioGenerationAdapter = {
    provider: "suno",
    prepare: async (request) => { preparations++; assert.deepEqual(request, expected); },
    submit: async (request) => {
      submissions++;
      assert.deepEqual(request, expected);
      return { kind: "task", taskId: a, expectedOutputs: [
        { key: a, role: "music" }, { key: b, role: "music_alternative" },
      ] };
    },
    inspect: async () => ({ status: "completed", outputs: [
      { key: a, role: "music", url: `/api/download/clip/${a}?format=mp3` },
      { key: b, role: "music_alternative", url: `/api/download/clip/${b}?format=mp3` },
    ] }),
  };
  const context = { application: { song: { tempo: 120 } },
    environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"),
    target: {}, scope: session.scope };
  let turns = 0;
  const result = await handleAgentRequest(context, directory, interaction,
    "Use Suno to render this song", runtime, "project", session.id, {
      signal: new AbortController().signal, onDelta() {}, onProgress() {}, onSessionEvent() {},
      confirmActions: async () => { throw new Error("Rendered generation must not mutate Live"); },
      audioProcessing: { generationAdapter },
    }, async (request) => {
      turns++;
      const tool = request.tools.find((entry) =>
        entry.type === "function" && entry.function.name === sunoMusicTool);
      assert.ok(tool?.type === "function");
      assert.match(tool.function.description, /rendered audio/i);
      if (turns === 1) return { content: null, toolCalls: [{ id: "suno-generate",
        name: sunoMusicTool, arguments: JSON.stringify({ connectionId: "suno-account", ...expected,
          operation: undefined }) }] };
      const toolResult = JSON.parse(request.agentMessages.at(-1)!.content!);
      assert.equal(toolResult.status, "ready");
      assert.equal(toolResult.remoteOutputs.length, 2);
      return { content: "Suno render is ready for preview.", toolCalls: [] };
    });
  assert.equal(result, "Suno render is ready for preview.");
  assert.equal(preparations, 1);
  assert.equal(submissions, 1);
  const [job] = await listAudioJobs(directory, session.id);
  assert.equal(job?.status, "ready");
  assert.equal(job?.remoteOutputs?.length, 2);
  assert.equal(job?.outputAssets.length, 0);
});

test("an audio-capable chat model can listen to a generated Session asset in the same send", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-music-listen-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Listen", projectKey: "project",
    scope: { kind: "track", identity: "1", label: "Track" } });
  await saveIntegrationConnection(directory, "0", {
    id: "music-account", name: "Music production", provider: "elevenlabs",
    enabled: true, apiKey: "fixture-music-secret",
  });
  const runtime = runtimeProfileForSavedProfile({
    id: "audio-profile", name: "Audio model", defaultModel: "audio-model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "chat-completions",
      baseUrl: "https://example.test/v1", apiKey: "model-test-key" },
    models: [{ model: "audio-model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } },
      advanced: { capabilityOverrides: { inputs: { audio: true } } } }],
  });
  const generationAdapter: AudioGenerationAdapter = { provider: "elevenlabs", submit: async () => ({
    kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }],
  }) };
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope };
  const context = { application: { song: { tempo: 120 } },
    environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  let turns = 0;
  const result = await handleAgentRequest(context, directory, interaction, "Generate and analyze a short idea", runtime,
    "project", session.id, { signal: new AbortController().signal, onDelta() {}, onProgress() {}, onSessionEvent() {},
      confirmActions: async () => { throw new Error("Generation and listening must not modify Live"); },
      audioProcessing: { generationAdapter } }, async (request) => {
      assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === "listen_to_audio_asset"));
      turns += 1;
      if (turns === 1) return { content: null, toolCalls: [{ id: "generate", name: elevenMusicTool,
        arguments: JSON.stringify({ connectionId: "music-account", prompt: "Short ambient idea", durationSeconds: 10,
          instrumental: true }) }] };
      if (turns === 2) {
        const generated = JSON.parse(request.agentMessages.at(-1)!.content!);
        return { content: null, toolCalls: [{ id: "listen", name: "listen_to_audio_asset",
          arguments: JSON.stringify({ assetRef: generated.outputs[0].id }) }] };
      }
      const heard = request.agentMessages.find((message) => message.role === "tool" && message.toolCallId === "listen");
      assert.equal(heard?.role, "tool");
      assert.equal(heard?.modelInputPart?.type, "audio");
      assert.equal(heard?.modelInputPart?.mediaType, "audio/wav");
      assert.ok(heard?.modelInputPart?.base64.length);
      return { content: "I heard the generated idea.", toolCalls: [] };
    });
  assert.equal(result, "I heard the generated idea.");
  assert.equal(turns, 3);
  assert.doesNotMatch(JSON.stringify(await loadSessionEvents(directory, session.id)), /fixture-music-secret|base64|UklGR/);
});
