import type { BuiltInAudioPluginDefinition, BuiltInAudioToolContract } from "./contracts.js";
import { createBuiltInAudioTools } from "./provider-tools.js";
import { SUNO_LYRIC_TOOL_NAMES, sunoLyricTools, parseSunoLyricTool } from "./suno-lyrics-tools.js";
import { readSunoLyricModels, writeSunoLyrics } from "../../audio-services/suno/suno-lyrics.js";
import { readSunoMusicService } from "../../audio-services/suno/suno-catalog.js";

const audio: BuiltInAudioToolContract = {
  operations: ["generate_music", "extend_music", "get_whole_song", "retrieve_music", "generate_sound_sample", "cover_music", "remaster_music", "add_vocals", "add_instrumental", "replace_music_section", "finish_music_replacement", "upload_music", "extract_music_stems"],
  musicDuration: { minimumSeconds: 10, maximumSeconds: 480 },
  generationOutputCount: 2,
  outputCollection: "explicit",
  musicPromptCharacters: 5000,
  customMusic: true,
  customMusicOptions: [
    "title",
    "styles",
    "negativeStyles",
    "weirdness",
    "styleInfluence",
    "audioInfluence",
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
  tools: createBuiltInAudioTools(audio, { localToolNames: SUNO_LYRIC_TOOL_NAMES, tools: sunoLyricTools, parse: parseSunoLyricTool }),
  generationModelId(connection, request) {
    if (request.operation === "extract_music_stems") return "chirp-v3-5-b";
    if (request.operation === "remaster_music") return request.modelId;
    return connection.modelId;
  },
  inspectMusicService(connection, query, signal, runtime) {
    if (!connection.sunoSession) throw new Error("The Suno.com subscription Connection is unavailable.");
    return readSunoMusicService(connection.sunoSession, query, signal, runtime.fetchImpl, runtime.onCredentialRefresh);
  },
  writeLyrics(connection, request, signal, runtime) {
    if (!connection.sunoSession) throw new Error("The Suno.com subscription Connection is unavailable.");
    return writeSunoLyrics(connection.sunoSession, request, signal, { fetchImpl: runtime.fetchImpl,
      ...(runtime.onCredentialRefresh ? { onSessionRefresh: runtime.onCredentialRefresh } : {}) });
  },
  inspectLyricModels(connection, signal, runtime) {
    if (!connection.sunoSession) throw new Error("The Suno.com subscription Connection is unavailable.");
    return readSunoLyricModels(connection.sunoSession, signal, { fetchImpl: runtime.fetchImpl,
      ...(runtime.onCredentialRefresh ? { onSessionRefresh: runtime.onCredentialRefresh } : {}) });
  },
  createGenerationAdapter(connection, runtime, authorizeDownloads) {
    if (!connection.sunoSession || !runtime.createGenerationAdapter) {
      throw new Error("The Suno.com subscription Connection is unavailable.");
    }
    return runtime.createGenerationAdapter(connection, authorizeDownloads);
  },
};
