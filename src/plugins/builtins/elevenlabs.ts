import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const elevenLabsPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.elevenlabs",
  version: "1",
  description: "Generate music and sound effects with ElevenLabs.",
  provider: "elevenlabs",
  capabilities: {
    label: "ElevenLabs",
    operations: ["generate_music", "generate_sound_effect"],
    musicDuration: { minimumSeconds: 3, maximumSeconds: 600 },
    generationOutputCount: 1,
    musicPromptCharacters: 4100,
    modelConfigurable: true,
    inlineGeneration: true,
  },
};
