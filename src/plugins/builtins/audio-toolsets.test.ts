import assert from "node:assert/strict";
import test from "node:test";

import type { BuiltInIntegrationConnectionChoice } from "./contracts.js";
import { PluginRegistry } from "../registry.js";
import {
  builtInAudioToolName,
  createBuiltInAudioToolsets,
} from "./audio-toolsets.js";
import { elevenLabsPlugin } from "./elevenlabs.js";
import { BUILT_IN_AUDIO_PLUGINS } from "./index.js";
import { murekaPlugin } from "./mureka.js";

const services: BuiltInIntegrationConnectionChoice[] = [
  { id: "mureka-main", name: "Mureka main", pluginId: murekaPlugin.id, provider: "mureka" },
  { id: "eleven-main", name: "ElevenLabs main", pluginId: elevenLabsPlugin.id, provider: "elevenlabs" },
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
  const murekaLyrics = builtInAudioToolName(murekaPlugin, "generate_lyrics");
  const murekaSongFromLyrics = builtInAudioToolName(murekaPlugin, "generate_song_from_lyrics");
  const elevenMusic = builtInAudioToolName(elevenLabsPlugin, "generate_music");
  const elevenEffect = builtInAudioToolName(elevenLabsPlugin, "generate_sound_effect");
  assert.ok(names.includes(mureka));
  assert.ok(names.includes(murekaLyrics));
  assert.ok(names.includes(murekaSongFromLyrics));
  assert.ok(names.includes(elevenMusic));
  assert.ok(names.includes(elevenEffect));
  assert.equal(names.includes("generate_music"), false);

  assert.equal((await registry.callTool({
    id: "mureka-call",
    name: mureka,
    arguments: JSON.stringify({
      connectionId: "mureka-main",
      prompt: "Slow piano",
      instrumental: true,
    }),
  })).failed, undefined);
  assert.deepEqual(requests, [{
    kind: "generate_music",
    connectionId: "mureka-main",
    prompt: "Slow piano",
    instrumental: true,
  }]);

  assert.equal((await registry.callTool({
    id: "mureka-lyrics",
    name: murekaLyrics,
    arguments: JSON.stringify({
      connectionId: "mureka-main",
      prompt: "A hopeful night-drive song",
    }),
  })).failed, undefined);
  assert.equal((await registry.callTool({
    id: "mureka-song-from-lyrics",
    name: murekaSongFromLyrics,
    arguments: JSON.stringify({
      connectionId: "mureka-main",
      lyrics: "[Verse]\nCity lights",
    }),
  })).failed, undefined);
  assert.deepEqual(requests.slice(1), [
    {
      kind: "generate_lyrics",
      connectionId: "mureka-main",
      prompt: "A hopeful night-drive song",
    },
    {
      kind: "generate_song_from_lyrics",
      connectionId: "mureka-main",
      lyrics: "[Verse]\nCity lights",
    },
  ]);

  const wrongOwner = await registry.callTool({
    id: "wrong-owner",
    name: mureka,
    arguments: JSON.stringify({
      connectionId: "eleven-main",
      prompt: "Slow piano",
      instrumental: true,
    }),
  });
  assert.equal(wrongOwner.invalidArguments, true);
  assert.equal(requests.length, 3);
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

test("every built-in integration publishes its complete tool contract directly", () => {
  for (const plugin of BUILT_IN_AUDIO_PLUGINS) {
    const connection: BuiltInIntegrationConnectionChoice = {
      id: `connection-${plugin.provider.replaceAll(/[^a-z0-9]/gu, "-")}`,
      name: plugin.connection.label,
      pluginId: plugin.id,
      provider: plugin.provider,
    };
    const names = plugin.tools.tools([connection])
      .map((tool) => tool.function.name);
    assert.equal(new Set(names).size, names.length, plugin.id);
    assert.deepEqual(
      [...names].sort(),
      [...plugin.tools.localToolNames].sort(),
      plugin.id,
    );
    for (const operation of plugin.audio.operations) {
      assert.ok(names.includes(operation), `${plugin.id}:${operation}`);
    }
    assert.equal(
      names.includes("inspect_music_service"),
      plugin.audio.musicLibrary === true,
      plugin.id,
    );
  }
});
