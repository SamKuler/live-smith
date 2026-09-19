import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import { createLalalAudioAdapter } from "../../audio-services/lalal.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

const audio: BuiltInAudioToolContract = {
  operations: ["separate_stems"],
  generationOutputCount: 0,
  musicPromptCharacters: 0,
};

export const lalalPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.lalal",
  version: "1",
  description: "Separate admitted audio into selected stems.",
  provider: "lalal",
  connection: {
    label: "LALAL.AI",
    authentication: "api-key",
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createProcessingAdapter(connection, runtime) {
    return createLalalAudioAdapter(connection.apiKey, { fetchImpl: runtime.fetchImpl });
  },
};
