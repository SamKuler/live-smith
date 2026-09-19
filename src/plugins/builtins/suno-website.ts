import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import { createBuiltInAudioTools } from "./provider-tools.js";

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music", "extend_music", "get_whole_song", "retrieve_music"],
  musicDuration: { minimumSeconds: 10, maximumSeconds: 480 },
  generationOutputCount: 2,
  musicPromptCharacters: 5000,
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
};

export const sunoWebsitePlugin: BuiltInAudioPluginDefinition = {
  id: "live-smith.suno-website",
  version: "1",
  description: "Generate, extend, retrieve, and inspect music through a Suno.com subscription.",
  provider: "suno",
  connection: {
    label: "Suno.com subscription (experimental)",
    authentication: "suno-session",
    modelConfigurable: true,
  },
  audio,
  tools: createBuiltInAudioTools(audio),
  createGenerationAdapter(connection, runtime, authorizeDownloads) {
    if (!connection.sunoSession || !runtime.createWebsiteSubscriptionAdapter) {
      throw new Error("The Suno.com subscription Connection is unavailable.");
    }
    return runtime.createWebsiteSubscriptionAdapter(connection, authorizeDownloads);
  },
};
