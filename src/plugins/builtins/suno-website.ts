import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const sunoWebsitePlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.suno-website",
  version: "1",
  description: "Generate, extend, retrieve, and inspect music through a Suno.com subscription.",
  provider: "suno",
  capabilities: {
    label: "Suno.com subscription (experimental)",
    operations: ["generate_music", "extend_music", "get_whole_song", "retrieve_music"],
    musicDuration: { minimumSeconds: 10, maximumSeconds: 480 },
    generationOutputCount: 2,
    musicPromptCharacters: 5000,
    sessionImport: true,
    customMusic: true,
    customMusicOptions: [
      "title",
      "styles",
      "negativeStyles",
      "weirdness",
      "styleInfluence",
      "vocalGender",
      "personaId",
    ],
    musicLibrary: true,
    modelConfigurable: true,
  },
};
