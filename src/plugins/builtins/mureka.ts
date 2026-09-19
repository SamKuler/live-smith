import type { BuiltInAudioPluginDefinition } from "./contracts.js";
import {
  MUREKA_EXTENSION_TOOL_NAMES,
  murekaExtensionTools,
  parseMurekaExtensionTool,
} from "./mureka-tools.js";

export const MUREKA_MUSIC_MODELS = [
  "auto",
  "mureka-7.6",
  "mureka-o2",
  "mureka-8",
  "mureka-9",
  "mureka-9.5",
] as const;
export const DEFAULT_MUREKA_MUSIC_MODEL = "auto";

export const murekaPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.mureka",
  version: "1",
  description: "Generate music with Mureka.",
  provider: "mureka",
  capabilities: {
    label: "Mureka",
    operations: ["generate_music", "generate_song_from_lyrics"],
    generationOutputCount: 1,
    musicPromptCharacters: 1024,
    modelIds: MUREKA_MUSIC_MODELS,
    defaultModelId: DEFAULT_MUREKA_MUSIC_MODEL,
    modelConfigurable: true,
    instrumentalUnsupportedModelIds: ["mureka-o2"],
  },
  toolExtension: {
    localToolNames: MUREKA_EXTENSION_TOOL_NAMES,
    tools: murekaExtensionTools,
    parse: parseMurekaExtensionTool,
  },
};
