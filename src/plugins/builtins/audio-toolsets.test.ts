import assert from "node:assert/strict";
import test from "node:test";

import type { AudioServiceChoice } from "../../audio-services/capabilities.js";
import { PluginRegistry } from "../registry.js";
import {
  builtInAudioToolName,
  createBuiltInAudioToolsets,
} from "./audio-toolsets.js";
import { elevenLabsPlugin } from "./elevenlabs.js";
import { murekaPlugin } from "./mureka.js";

const services: AudioServiceChoice[] = [
  { id: "mureka-main", name: "Mureka main", provider: "mureka" },
  { id: "eleven-main", name: "ElevenLabs main", provider: "elevenlabs" },
];

test("built-in provider Plugins own distinct tools without a central generation route", async () => {
  const requests: unknown[] = [];
  const registry = new PluginRegistry(createBuiltInAudioToolsets({
    services,
    includeModelAudioInput: false,
    execute: async (request) => {
      requests.push(request);
      return { content: "ok" };
    },
  }));
  const names = registry.tools().map((tool) => tool.function.name);
  const mureka = builtInAudioToolName(murekaPlugin, "generate_music");
  const elevenMusic = builtInAudioToolName(elevenLabsPlugin, "generate_music");
  const elevenEffect = builtInAudioToolName(elevenLabsPlugin, "generate_sound_effect");
  assert.ok(names.includes(mureka));
  assert.ok(names.includes(elevenMusic));
  assert.ok(names.includes(elevenEffect));
  assert.equal(names.includes("generate_music"), false);

  assert.equal((await registry.callTool({
    id: "mureka-call",
    name: mureka,
    arguments: JSON.stringify({
      serviceId: "mureka-main",
      prompt: "Slow piano",
      instrumental: true,
    }),
  })).failed, undefined);
  assert.deepEqual(requests, [{
    kind: "generate_music",
    serviceId: "mureka-main",
    prompt: "Slow piano",
    instrumental: true,
  }]);

  const wrongOwner = await registry.callTool({
    id: "wrong-owner",
    name: mureka,
    arguments: JSON.stringify({
      serviceId: "eleven-main",
      prompt: "Slow piano",
      instrumental: true,
    }),
  });
  assert.equal(wrongOwner.invalidArguments, true);
  assert.equal(requests.length, 1);
});

test("Session media tools remain one built-in Plugin independent of connections", () => {
  const toolsets = createBuiltInAudioToolsets({
    services: [],
    includeModelAudioInput: true,
    execute: async () => ({ content: "ok" }),
  });
  assert.deepEqual(toolsets.map((toolset) => toolset.pluginId), ["live-smith.media"]);
  assert.deepEqual(toolsets[0]!.tools().map((tool) => tool.function.name), [
    "listen_to_audio_asset",
    "resume_audio_job",
    "list_audio_jobs",
  ]);
});
