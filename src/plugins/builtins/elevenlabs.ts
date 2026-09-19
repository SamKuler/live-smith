import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import { createElevenLabsAudioAdapter } from "../../audio-services/elevenlabs.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music", "generate_sound_effect"],
  musicDuration: { minimumSeconds: 3, maximumSeconds: 600 },
  generationOutputCount: 1,
  musicPromptCharacters: 4100,
  inlineGeneration: true,
};

export const elevenLabsPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.elevenlabs",
  version: "1",
  description: "Generate music and sound effects with ElevenLabs.",
  provider: "elevenlabs",
  connection: {
    label: "ElevenLabs",
    authentication: "api-key",
    modelConfigurable: true,
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createGenerationAdapter(connection, runtime) {
    return createElevenLabsAudioAdapter(connection.apiKey, {
      fetchImpl: runtime.fetchImpl,
      ...(connection.modelId ? { modelId: connection.modelId } : {}),
    });
  },
};
