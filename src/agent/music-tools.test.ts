import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest, validateAudioServiceRequest } from "./audio-tools.js";
import type { AudioServiceChoice } from "../audio-services/capabilities.js";
import {
  builtInAudioLocalToolName,
  createBuiltInAudioToolsets,
} from "../plugins/builtins/audio-toolsets.js";

const service = { id: "website", name: "Personal Suno", provider: "suno" as const };
const clipId = "11111111-1111-4111-8111-111111111111";
const parse = (name: string, value: unknown) => parseAudioToolRequest(name, JSON.stringify(value));
const pluginTools = (services: readonly AudioServiceChoice[]) =>
  createBuiltInAudioToolsets({
    services,
    includeModelAudioInput: false,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());

test("custom music options are bounded and scoped to eligible connections", () => {
  const raw = { serviceId: service.id, prompt: "我的歌词", instrumental: false,
    durationSeconds: 120,
    options: { mode: "custom", styles: "minimal piano", negativeStyles: "drums", title: "新歌", weirdness: 0,
      styleInfluence: 100, vocalGender: "female", personaId: clipId } };
  const parsed = parse("generate_music", raw);
  validateAudioServiceRequest(parsed, [service]);
  assert.deepEqual(parsed, { kind: "generate_music", ...raw });
  for (const provider of ["elevenlabs", "sunoapi", "lalal"] as const) {
    assert.throws(() => validateAudioServiceRequest(parsed, [{ ...service, provider }]));
  }
  for (const options of [{ ...raw.options, weirdness: -1 }, { ...raw.options, styleInfluence: 101 },
    { ...raw.options, personaId: "../secret" }, { ...raw.options, title: "x".repeat(101) },
    { ...raw.options, audioInfluence: 50 }, { ...raw.options, vocalGender: "unspecified" },
    { ...raw.options, token: "secret" }, { ...raw.options, mode: "simple" }]) {
    assert.throws(() => parse("generate_music", { ...raw, options }));
  }
});

test("custom instrumental permits empty lyrics, while descriptions and vocal lyrics remain required", () => {
  const raw = { serviceId: service.id, prompt: "", instrumental: true, options: { mode: "custom" } };
  validateAudioServiceRequest(parse("generate_music", raw), [service]);
  assert.throws(() => parse("generate_music", { ...raw, instrumental: false }));
  assert.throws(() => parse("generate_music", { serviceId: service.id, prompt: "", instrumental: true }));
  validateAudioServiceRequest(parse("generate_music", { ...raw, prompt: "🎵".repeat(5000) }), [service]);
  assert.throws(() => parse("generate_music", { ...raw, prompt: "🎵".repeat(5001) }));
  assert.throws(() => validateAudioServiceRequest(parse("generate_music", {
    serviceId: service.id, prompt: "x".repeat(3001), instrumental: true,
  }), [service]));
});

test("music browsing and editing have strict action-specific fields", () => {
  for (const input of [{ serviceId: service.id, query: "catalog" },
    { serviceId: service.id, query: "library", search: "piano", cursor: "opaque-next" },
    { serviceId: service.id, query: "persona", personaId: clipId }]) {
    const parsed = parse("inspect_music_service", input);
    validateAudioServiceRequest(parsed, [service]);
    assert.throws(() => validateAudioServiceRequest(parsed, [{ ...service, provider: "sunoapi" }]));
  }
  for (const input of [{ serviceId: service.id, query: "catalog", cursor: "extra" },
    { serviceId: service.id, query: "library", personaId: clipId },
    { serviceId: service.id, query: "persona" }, { serviceId: service.id, query: "publish" }]) {
    assert.throws(() => parse("inspect_music_service", input));
  }
  const extend = { serviceId: service.id, clipId, startSeconds: 30, prompt: "new verse", instrumental: false };
  validateAudioServiceRequest(parse("extend_music", extend), [service]);
  for (const patch of [{ startSeconds: -1 }, { startSeconds: 901 }, { clipId: "https://suno.com/song/abc" }, { durationSeconds: 10 }]) {
    assert.throws(() => parse("extend_music", { ...extend, ...patch }));
  }
  assert.throws(() => parse("extend_music", {
    ...extend,
    options: { mode: "custom", personaId: clipId },
  }));
  validateAudioServiceRequest(parse("get_whole_song", { serviceId: service.id, clipId }), [service]);
  assert.throws(() => parse("get_whole_song", extend));
});

test("advanced tools are absent from other providers and contain no generic HTTP escape", () => {
  const tools = pluginTools([service]);
  assert.deepEqual(tools.map((tool) => builtInAudioLocalToolName(tool.function.name)), [
    "resume_audio_job", "list_audio_jobs", "generate_music", "inspect_music_service",
    "extend_music", "get_whole_song", "retrieve_music",
  ]);
  const other = pluginTools([{ ...service, provider: "elevenlabs" }]);
  assert.ok(!other.some((tool) => ["inspect_music_service", "extend_music", "get_whole_song"]
    .includes(builtInAudioLocalToolName(tool.function.name) ?? "")));
  const schemas = JSON.stringify(tools.map((tool) => tool.function.parameters));
  assert.doesNotMatch(schemas, /apiKey|clientToken|Authorization|endpoint|callbackUrl/);
});
