import type { BuiltInAudioPluginDefinition } from "./contracts.js";

export const lalalPlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.lalal",
  version: "1",
  description: "Separate admitted audio into selected stems.",
  provider: "lalal",
  capabilities: {
    label: "LALAL.AI",
    operations: ["separate_stems"],
    generationOutputCount: 0,
    musicPromptCharacters: 0,
  },
};
