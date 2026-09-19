import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const sunoPlatformPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.suno-platform",
  version: "1",
  description: "Generate custom music with the official Suno Platform API.",
  provider: "suno-platform",
  capabilities: {
    label: "Suno Platform (official API)",
    operations: ["generate_music"],
    generationOutputCount: 1,
    musicPromptCharacters: 5000,
    customMusic: true,
    customMusicOptions: ["title", "styles", "personaId"],
    requiredCustomMusicOptions: ["styles"],
  },
};
