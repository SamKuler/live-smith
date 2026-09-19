import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import { createSunoPlatformAudioAdapter } from "../../audio-services/suno-platform.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music"],
  generationOutputCount: 1,
  musicPromptCharacters: 5000,
  customMusic: true,
  customMusicOptions: ["title", "styles", "personaId"],
  requiredCustomMusicOptions: ["styles"],
};

export const sunoPlatformPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.suno-platform",
  version: "1",
  description: "Generate custom music with the official Suno Platform API.",
  provider: "suno-platform",
  connection: {
    label: "Suno Platform (official API)",
    authentication: "api-key",
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createGenerationAdapter(connection, runtime) {
    return createSunoPlatformAudioAdapter(connection.apiKey, {
      fetchImpl: runtime.fetchImpl,
    });
  },
};
