import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import {
  createMurekaAudioAdapter,
  DEFAULT_MUREKA_MUSIC_MODEL,
  generateMurekaLyrics,
  MUREKA_MUSIC_MODELS,
} from "../../audio-services/mureka.js";
import {
  MUREKA_EXTENSION_TOOL_NAMES,
  murekaExtensionTools,
  parseMurekaExtensionTool,
} from "./mureka-tools.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

export { DEFAULT_MUREKA_MUSIC_MODEL, MUREKA_MUSIC_MODELS };

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music", "generate_song_from_lyrics"],
  generationOutputCount: 1,
  musicPromptCharacters: 1024,
  instrumentalUnsupportedModelIds: ["mureka-o2"],
};

export const murekaPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.mureka",
  version: "1",
  description: "Generate music with Mureka.",
  provider: "mureka",
  connection: {
    label: "Mureka",
    authentication: "api-key",
    modelIds: MUREKA_MUSIC_MODELS,
    defaultModelId: DEFAULT_MUREKA_MUSIC_MODEL,
    modelConfigurable: true,
  },
  audio,
  tools: createBuiltInAudioTools(audio, {
    localToolNames: MUREKA_EXTENSION_TOOL_NAMES,
    tools: murekaExtensionTools,
    parse: parseMurekaExtensionTool,
  }),
  createGenerationAdapter(connection, runtime) {
    return createMurekaAudioAdapter(connection.apiKey, {
      fetchImpl: runtime.fetchImpl,
      ...(connection.modelId ? { modelId: connection.modelId } : {}),
    });
  },
  generateLyrics(connection, prompt, signal, runtime) {
    return generateMurekaLyrics(connection.apiKey, prompt, signal, {
      fetchImpl: runtime.fetchImpl,
    });
  },
};
