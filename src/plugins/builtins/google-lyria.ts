import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import {
  createGoogleLyriaAudioAdapter,
  DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL,
  GOOGLE_LYRIA_MUSIC_MODELS,
} from "../../audio-services/google-lyria.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

export { DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL, GOOGLE_LYRIA_MUSIC_MODELS };

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music"],
  musicDuration: { minimumSeconds: 3, maximumSeconds: 600 },
  generationOutputCount: 1,
  musicPromptCharacters: 4100,
  inlineGeneration: true,
  instrumentalOnlyModelIds: ["lyria-realtime-exp"],
  fixedMusicDurationSecondsByModel: { "lyria-3-clip-preview": 30 },
  promptGuidedDurationModelIds: ["lyria-3.5"],
};

export const googleLyriaPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.google-lyria",
  version: "1",
  description: "Generate instrumental music with Google Lyria.",
  provider: "google-lyria",
  connection: {
    label: "Google Lyria (Gemini API)",
    authentication: "api-key",
    modelIds: GOOGLE_LYRIA_MUSIC_MODELS,
    defaultModelId: DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL,
    modelConfigurable: true,
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createGenerationAdapter(connection, runtime) {
    return createGoogleLyriaAudioAdapter(connection.apiKey, {
      fetchImpl: runtime.fetchImpl,
      openWebSocket: runtime.openWebSocket,
      ...(connection.modelId ? { modelId: connection.modelId } : {}),
    });
  },
};
