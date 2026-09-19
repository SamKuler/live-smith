import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const SUNOAPI_MUSIC_MODELS = [
  "V6",
  "V6_WILD",
  "V6_MINI",
  "V5_5",
  "V5",
  "V4_5PLUS",
  "V4_5ALL",
  "V4_5",
  "V4",
] as const;
export const DEFAULT_SUNOAPI_MUSIC_MODEL = "V6";

export const sunoApiPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.sunoapi",
  version: "1",
  description: "Generate music through SunoAPI.org.",
  provider: "sunoapi",
  capabilities: {
    label: "Suno via SunoAPI.org (third-party)",
    operations: ["generate_music"],
    generationOutputCount: 2,
    musicPromptCharacters: 3000,
    modelIds: SUNOAPI_MUSIC_MODELS,
    defaultModelId: DEFAULT_SUNOAPI_MUSIC_MODEL,
    modelConfigurable: true,
  },
};
