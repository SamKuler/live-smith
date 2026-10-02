import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest } from "../../src/agent/audio-tool-parser.js";
import { AgentExternalToolReportingError, runAgentLoop } from "../../src/agent/loop.js";
import type { BuiltInIntegrationConnectionChoice } from "../../src/plugins/builtins/contracts.js";
import type { ModelFunctionTool } from "../../src/model/provider.js";
import {
  builtInAudioLocalToolName,
  createBuiltInAudioToolsets,
} from "../../src/plugins/builtins/audio-toolsets.js";
import { builtInAudioPlugin, builtInAudioPluginId } from "../../src/plugins/builtins/index.js";

type ChoiceInput = Omit<BuiltInIntegrationConnectionChoice, "pluginId">;
const choices = (services: readonly ChoiceInput[]): BuiltInIntegrationConnectionChoice[] =>
  services.map((service) => ({
    ...service,
    pluginId: builtInAudioPluginId(service.provider),
  }));

function parseForService(
  service: BuiltInIntegrationConnectionChoice,
  name: string,
  args: unknown,
) {
  return builtInAudioPlugin(service.provider).tools.parse(name, JSON.stringify(args), [service]);
}

function pluginTools(
  services: readonly ChoiceInput[],
  includeModelAudioInput = false,
): ModelFunctionTool[] {
  return createBuiltInAudioToolsets({
    services: choices(services),
    includeModelAudioInput,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());
}

const localNames = (tools: readonly ModelFunctionTool[]) =>
  tools.map((tool) => builtInAudioLocalToolName(tool.function.name));
const localTool = (tools: readonly ModelFunctionTool[], name: string) =>
  tools.find((tool) => builtInAudioLocalToolName(tool.function.name) === name);

test("audio tools project supported combinations and strictly parse bounded source locators", () => {
  assert.deepEqual(localNames(pluginTools([])), ["resume_audio_job", "list_audio_jobs"]);
  assert.deepEqual(localNames(pluginTools([], true)),
    ["listen_to_audio_asset", "resume_audio_job", "list_audio_jobs"]);
  assert.deepEqual(parseAudioToolRequest("listen_to_audio_asset", JSON.stringify({ assetRef: "asset_known" })),
    { kind: "listen_to_audio_asset", assetRef: "asset_known" });
  assert.throws(() => parseAudioToolRequest("listen_to_audio_asset", JSON.stringify({ assetRef: "../private" })));
  assert.equal(pluginTools([{ id: "splitter", name: "Stems", provider: "lalal" }]).length, 3);
  const request = { connectionId: "splitter", source: { kind: "audio_asset", assetRef: "asset_known" }, stems: ["vocals", "drums"] };
  assert.deepEqual(parseAudioToolRequest("separate_stems", JSON.stringify(request)), { kind: "separate_stems", ...request });
  for (const invalid of [
    { ...request, stems: ["vocals", "vocals"] },
    { ...request, stems: ["synthesizer"] },
    { ...request, apiKey: "key" },
    { ...request, source: { kind: "audio_asset", assetRef: "../../secret" } },
    { ...request, source: { kind: "arrangement_audio", startBeat: 4, endBeat: 2 } },
    { ...request, source: { kind: "request_audio_attachment", requestId: "request", audioIndex: 2 } },
  ]) assert.throws(() => parseAudioToolRequest("separate_stems", JSON.stringify(invalid)));
});

test("audio tools expose distinct operations only for eligible named connections", () => {
  const tools = pluginTools([
    { id: "stems", name: "Separation account", provider: "lalal" },
    { id: "music-one", name: "Music account A", provider: "elevenlabs" },
    { id: "music-two", name: "Music account B", provider: "elevenlabs" },
    { id: "website", name: "Suno", provider: "suno" },
  ]);
  const music = tools.filter((tool) => builtInAudioLocalToolName(tool.function.name) === "generate_music");
  assert.equal(music.length, 2);
  const eleven = music.find((tool) => JSON.stringify(tool.function.parameters).includes("music-one"))!;
  const suno = music.find((tool) => JSON.stringify(tool.function.parameters).includes("website"))!;
  assert.match(JSON.stringify(eleven.function.parameters), /music-two/);
  assert.doesNotMatch(JSON.stringify(eleven.function.parameters), /website|stems/);
  assert.doesNotMatch(JSON.stringify(suno.function.parameters), /music-one|stems/);
  assert.ok(localTool(tools, "generate_sound_effect"));
});

test("music and sound-effect requests validate operation-specific options and never accept connection secrets", () => {
  const music = { connectionId: "music-one", prompt: "Sparse ambient piano", durationSeconds: 12, instrumental: true };
  assert.deepEqual(parseAudioToolRequest("generate_music", JSON.stringify(music)), { kind: "generate_music", ...music });
  const effect = { connectionId: "music-one", prompt: "Gentle rain", durationSeconds: 2.5, loop: true };
  assert.deepEqual(parseAudioToolRequest("generate_sound_effect", JSON.stringify(effect)), { kind: "generate_sound_effect", ...effect });
  for (const invalid of [
    { ...music, connectionId: "../key" }, { ...music, apiKey: "secret" },
    { ...music, baseUrl: "https://example.com" }, { ...music, prompt: " " },
    { ...music, prompt: "x".repeat(4101) }, { ...music, durationSeconds: 601 },
    { ...music, instrumental: "yes" }, { ...music, loop: true },
  ]) assert.throws(() => parseAudioToolRequest("generate_music", JSON.stringify(invalid)));
  for (const invalid of [{ ...effect, durationSeconds: 0.1 }, { ...effect, durationSeconds: 31 },
    { ...effect, loop: "true" }, { ...effect, instrumental: true }]) {
    assert.throws(() => parseAudioToolRequest("generate_sound_effect", JSON.stringify(invalid)));
  }
});

test("third-party Suno music declares its prompt limit and does not silently discard a duration", () => {
  const services = choices([{ id: "suno-third-party", name: "Suno via SunoAPI.org", provider: "sunoapi" as const }]);
  const tools = pluginTools(services);
  const music = localTool(tools, "generate_music")!;
  assert.match(music.function.description, /sunoapi/);
  assert.match(JSON.stringify(music.function.parameters), /3000/);
  assert.doesNotMatch(JSON.stringify(music.function.parameters), /durationSeconds/);
  assert.ok(!localTool(tools, "generate_sound_effect"));
  const args = { connectionId: services[0]!.id, prompt: "Ambient piano", instrumental: true };
  assert.equal(parseForService(services[0]!, "generate_music", args).kind, "generate_music");
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, durationSeconds: 10 }));
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, prompt: "a".repeat(3001), instrumental: false }));
});

test("Mureka exposes bounded prompt, lyric-writing and lyrics-to-song tools", () => {
  const services = choices([{ id: "mureka-studio", name: "Mureka studio", provider: "mureka" as const }]);
  const tools = pluginTools(services);
  const music = localTool(tools, "generate_music")!;
  const schema = JSON.stringify(music.function.parameters);
  assert.match(schema, /mureka-studio/);
  assert.match(schema, /1024/);
  assert.doesNotMatch(schema, /durationSeconds|options/);
  assert.ok(!localTool(tools, "generate_sound_effect"));
  assert.ok(localTool(tools, "generate_lyrics"));
  assert.ok(localTool(tools, "generate_song_from_lyrics"));
  const args = {
    connectionId: services[0]!.id, prompt: "Ambient piano", instrumental: false,
  };
  assert.equal(parseForService(services[0]!, "generate_music", args).kind, "generate_music");
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, prompt: "🎵".repeat(1025) }));
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, durationSeconds: 30 }));
});

test("official Suno Platform exposes only its supported custom fields", () => {
  const services = choices([{ id: "official-suno", name: "Official Suno", provider: "suno-platform" as const }]);
  const tool = localTool(pluginTools(services), "generate_music")!;
  const schema = JSON.stringify(tool.function.parameters);
  for (const field of ["title", "styles", "personaId"]) assert.match(schema, new RegExp(field));
  for (const field of ["negativeStyles", "weirdness", "styleInfluence", "durationSeconds"]) {
    assert.doesNotMatch(schema, new RegExp(field));
  }
  const variants = tool.function.parameters?.oneOf as Array<{ properties: { connectionId: { const: string }; options?: { required?: string[] } } }>;
  assert.deepEqual(variants.find((entry) => entry.properties.connectionId.const === services[0]!.id && entry.properties.options)?.properties.options?.required,
    ["mode", "styles"]);
  const args = { connectionId: services[0]!.id,
    prompt: "lyrics", instrumental: false, options: { mode: "custom", styles: "dream pop" } };
  assert.equal(parseForService(services[0]!, "generate_music", args).kind, "generate_music");
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, options: { mode: "custom" } }));
  assert.throws(() => parseForService(services[0]!, "generate_music", { ...args, options: {
    mode: "custom", styles: "dream pop", weirdness: 50,
  } }));
});

test("Suno.com exposes its bounded duration and vocal controls only on that connection", () => {
  const website = choices([{ id: "website", name: "Suno subscription", provider: "suno" as const }])[0]!;
  const tool = localTool(pluginTools([website]), "generate_music")!;
  const variants = tool.function.parameters?.oneOf as Array<{
    properties: { connectionId: { const: string }; durationSeconds?: { minimum: number; maximum: number }; options?: { properties?: object } };
  }>;
  const custom = variants.find((entry) => entry.properties.connectionId.const === website.id && entry.properties.options)!;
  assert.deepEqual(custom.properties.durationSeconds, { type: "number", minimum: 10, maximum: 480 });
  assert.ok(Object.hasOwn(custom.properties.options!.properties!, "vocalGender"));
  const args = {
    connectionId: website.id, prompt: "[Verse]\nHello", durationSeconds: 10, instrumental: false,
    options: { mode: "custom", styles: "dream pop", vocalGender: "female" },
  };
  assert.equal(parseForService(website, "generate_music", args).kind, "generate_music");
  assert.equal(parseForService(website, "generate_music", { ...args, durationSeconds: 480 }).kind, "generate_music");
  assert.throws(() => parseForService(website, "generate_music", { ...args, durationSeconds: 9 }));
  assert.throws(() => parseForService(website, "generate_music", { ...args, durationSeconds: 481 }));
  const mismatched = createBuiltInAudioToolsets({
    services: [{ ...website, provider: "elevenlabs" }],
    includeModelAudioInput: false,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());
  assert.deepEqual(localNames(mismatched),
    ["resume_audio_job", "list_audio_jobs"]);
});

test("external music generation follows the user-selected rendered-audio deliverable", () => {
  const tool = localTool(pluginTools([
    { id: "website", name: "Suno subscription", provider: "suno" },
  ]), "generate_music")!;
  assert.match(tool.function.description, /rendered audio/i);
  assert.match(tool.function.description, /requested deliverable/i);
});

test("external audio result returns to the next model turn without a Live observation or mutation", async () => {
  let turns = 0;
  let executions = 0;
  let accepted = 0;
  const audio = { type: "audio" as const, fileName: "session-audio.wav", mediaType: "audio/wav" as const, bytes: Uint8Array.from(Buffer.from("AAAA", "base64")) };
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => { executions++; return { content: "asset_result", progressKey: "job", modelInputPart: audio }; } },
    askModel: async ({ messages }) => {
      if (++turns === 1) return { content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] };
      assert.deepEqual(messages.at(-1), { role: "tool", toolCallId: "call", content: "asset_result", modelInputPart: audio });
      return { content: "Separated.", toolCalls: [] };
    },
    onModelInputPartAccepted: () => { accepted++; },
    observe: async () => { throw new Error("must not observe Live"); },
    confirmActions: async () => { throw new Error("must not confirm Live"); },
    executeActions: async () => { throw new Error("must not mutate Live"); },
  });
  assert.equal(result.message, "Separated."); assert.equal(executions, 1); assert.equal(accepted, 1);
});

test("external audio is not admitted when its tool-result trace cannot be recorded", async () => {
  const audio = { type: "audio" as const, fileName: "session-audio.wav", mediaType: "audio/wav" as const, bytes: Uint8Array.from(Buffer.from("AAAA", "base64")) };
  let accepted = 0;
  await assert.rejects(runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["listen_to_audio_asset"], execute: async () => ({ content: "audio ready", modelInputPart: audio }) },
    askModel: async () => ({ content: null, toolCalls: [{ id: "listen", name: "listen_to_audio_asset", arguments: "{}" }] }),
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onEvent: async (event) => { if (event.kind === "tool_result") throw new Error("storage unavailable"); },
    onModelInputPartAccepted: () => { accepted++; },
  }), (error: unknown) => error instanceof AgentExternalToolReportingError && error.outcome?.modelInputPart === undefined);
  assert.equal(accepted, 0);
});

test("unknown external operation outcomes stop the send without a repair resubmission", async () => {
  let turns = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => ({ content: "submission unknown", failed: true, stop: true }) },
    askModel: async () => { turns++; return { content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }; },
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });
  assert.equal(result.message, "submission unknown"); assert.equal(turns, 1);
});

test("a failed external result event cannot turn an unknown paid outcome into a retry", async () => {
  let submissions = 0;
  await assert.rejects(runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => {
      submissions++; return { content: "unknown paid outcome", failed: true, stop: true };
    } },
    askModel: async () => ({ content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }),
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onEvent: async (event) => { if (event.kind === "tool_result") throw new Error("storage unavailable"); },
  }), (error: unknown) => error instanceof AgentExternalToolReportingError && error.outcome?.stop === true);
  assert.equal(submissions, 1);
});

test("pending steering cannot bypass an external terminal outcome", async () => {
  let pending = false;
  let consumed = false;
  let submissions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    hasPendingSteering: () => pending,
    consumeSteering: async () => {
      if (!pending) return [];
      consumed = true; pending = false; return [{ role: "user", content: "Put the result on track two" }];
    },
    externalTools: { names: ["separate_stems"], execute: async () => {
      submissions++; pending = true; return { content: "unknown paid outcome", failed: true, stop: true };
    } },
    askModel: async () => ({ content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }),
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });
  assert.equal(result.message, "unknown paid outcome");
  assert.equal(submissions, 1); assert.equal(consumed, false); assert.equal(pending, true);
});
