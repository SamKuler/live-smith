import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import {
  createSunoApiAudioAdapter,
  DEFAULT_SUNOAPI_MUSIC_MODEL,
  SUNOAPI_MUSIC_MODELS,
} from "../../audio-services/sunoapi.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

export { DEFAULT_SUNOAPI_MUSIC_MODEL, SUNOAPI_MUSIC_MODELS };

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music"],
  generationOutputCount: 2,
  musicPromptCharacters: 3000,
};

export const sunoApiPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.sunoapi",
  version: "1",
  description: "Generate music through SunoAPI.org.",
  provider: "sunoapi",
  connection: {
    label: "Suno via SunoAPI.org (third-party)",
    authentication: "api-key",
    callbackUrl: true,
    modelIds: SUNOAPI_MUSIC_MODELS,
    defaultModelId: DEFAULT_SUNOAPI_MUSIC_MODEL,
    modelConfigurable: true,
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createGenerationAdapter(connection, runtime) {
    if (!connection.callbackUrl) throw new Error("SunoAPI.org callback configuration is unavailable.");
    return createSunoApiAudioAdapter(connection.apiKey, {
      fetchImpl: runtime.fetchImpl,
      callbackUrl: connection.callbackUrl,
      ...(connection.modelId ? { modelId: connection.modelId } : {}),
    });
  },
};
