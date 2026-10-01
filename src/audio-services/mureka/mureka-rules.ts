import type { AudioGenerationRequest } from "../contracts.js";
import { exceedsAudioPromptLimit } from "../prompt.js";

export const MUREKA_MUSIC_PROMPT_CHARACTERS = 1024;
export const MUREKA_LYRICS_CHARACTERS = 5000;
export const MUREKA_LYRICS_PROMPT_CHARACTERS = 8000;
export const MUREKA_VOCAL_GENDERS = ["female", "male"] as const;
export const MUREKA_INSTRUMENTAL_UNSUPPORTED_MODELS: readonly string[] = ["mureka-o2"];

export function isMurekaVocalGender(value: unknown): value is typeof MUREKA_VOCAL_GENDERS[number] {
  return MUREKA_VOCAL_GENDERS.some((gender) => value === gender);
}

export function validateMurekaGenerationRequest(
  request: AudioGenerationRequest, model: string, fail: (detail: string) => Error = (detail) => new Error(detail),
): asserts request is Extract<AudioGenerationRequest, {
  operation: "generate_music" | "generate_song_from_lyrics";
}> {
  if (!request || request.operation !== "generate_music" && request.operation !== "generate_song_from_lyrics") {
    throw fail("only supported music generation operations are accepted.");
  }
  if (request.operation === "generate_song_from_lyrics") {
    if (!validMurekaText(request.lyrics, MUREKA_LYRICS_CHARACTERS)) throw fail(`lyrics must contain 1–${MUREKA_LYRICS_CHARACTERS} characters.`);
    if (request.prompt !== undefined && !validMurekaText(request.prompt, MUREKA_MUSIC_PROMPT_CHARACTERS)) {
      throw fail(`song prompt must contain 1–${MUREKA_MUSIC_PROMPT_CHARACTERS} characters when provided.`);
    }
    if (request.gender !== undefined && !isMurekaVocalGender(request.gender)) {
      throw fail("vocal gender is invalid.");
    }
    return;
  }
  if (request.options !== undefined) throw fail("custom music options are not supported by this adapter.");
  if (request.durationSeconds !== undefined) throw fail("duration is not supported.");
  if (typeof request.instrumental !== "boolean") throw fail("instrumental must be a boolean.");
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.includes("\0") ||
      exceedsAudioPromptLimit(request.prompt, MUREKA_MUSIC_PROMPT_CHARACTERS)) throw fail(`music prompt must contain 1–${MUREKA_MUSIC_PROMPT_CHARACTERS} characters.`);
  if (request.instrumental && MUREKA_INSTRUMENTAL_UNSUPPORTED_MODELS.includes(model)) throw fail("the selected model does not support instrumental generation.");
}

export function validMurekaText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0") &&
    !exceedsAudioPromptLimit(value, maximum);
}
