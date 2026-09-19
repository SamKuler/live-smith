import assert from "node:assert/strict";
import test from "node:test";

import { murekaExtensionTools, parseMurekaExtensionTool } from "./mureka-tools.js";
import { murekaPlugin } from "./mureka.js";

const service = {
  id: "mureka-main", name: "Mureka main", pluginId: murekaPlugin.id,
  provider: "mureka" as const,
};

test("Mureka Plugin exposes separate lyric and literal-lyrics song tools", () => {
  const tools = murekaExtensionTools([service]);
  assert.deepEqual(tools.map((tool) => tool.function.name), [
    "generate_lyrics",
    "generate_song_from_lyrics",
  ]);
  assert.match(JSON.stringify(tools), /mureka-main/);
  assert.deepEqual(parseMurekaExtensionTool("generate_lyrics", JSON.stringify({
    connectionId: service.id,
    prompt: "A hopeful night-drive song",
  })), {
    kind: "generate_lyrics",
    connectionId: service.id,
    prompt: "A hopeful night-drive song",
  });
  assert.deepEqual(parseMurekaExtensionTool("generate_song_from_lyrics", JSON.stringify({
    connectionId: service.id,
    lyrics: "[Verse]\nCity lights",
    prompt: "future garage",
    gender: "female",
  })), {
    kind: "generate_song_from_lyrics",
    connectionId: service.id,
    lyrics: "[Verse]\nCity lights",
    prompt: "future garage",
    gender: "female",
  });
});

test("Mureka Plugin rejects cross-tool fields and bounded text overflow", () => {
  assert.throws(() => parseMurekaExtensionTool("generate_lyrics", JSON.stringify({
    connectionId: service.id,
    prompt: "Brief",
    apiKey: "secret",
  })));
  assert.throws(() => parseMurekaExtensionTool("generate_song_from_lyrics", JSON.stringify({
    connectionId: service.id,
    lyrics: "x".repeat(5001),
  })));
  assert.throws(() => parseMurekaExtensionTool("generate_song_from_lyrics", JSON.stringify({
    connectionId: service.id,
    lyrics: "Lyrics",
    gender: "unknown",
  })));
});
