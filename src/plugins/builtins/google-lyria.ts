import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const GOOGLE_LYRIA_MUSIC_MODELS = [
  "lyria-3.5",
  "lyria-3-clip-preview",
  "lyria-realtime-exp",
] as const;
export const DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL = "lyria-3.5";

export const googleLyriaPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.google-lyria",
  version: "1",
  description: "Generate instrumental music with Google Lyria.",
  provider: "google-lyria",
  capabilities: {
    label: "Google Lyria (Gemini API)",
    operations: ["generate_music"],
    musicDuration: { minimumSeconds: 3, maximumSeconds: 600 },
    generationOutputCount: 1,
    musicPromptCharacters: 4100,
    inlineGeneration: true,
    modelIds: GOOGLE_LYRIA_MUSIC_MODELS,
    defaultModelId: DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL,
    modelConfigurable: true,
    instrumentalOnlyModelIds: ["lyria-realtime-exp"],
    fixedMusicDurationSecondsByModel: { "lyria-3-clip-preview": 30 },
    promptGuidedDurationModelIds: ["lyria-3.5"],
  },
};
