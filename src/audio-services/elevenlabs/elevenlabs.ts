import type { AudioGenerationAdapter, AudioGenerationRequest } from "../contracts.js";
import { assertElevenLabsActive, createElevenLabsHttp, elevenLabsError } from "./elevenlabs-http.js";
import { exceedsAudioPromptLimit } from "../prompt.js";

/**
 * Official REST contracts: /docs/api-reference/music/compose and
 * /docs/api-reference/text-to-sound-effects/convert at https://elevenlabs.io.
 * The music quickstart explicitly selects music_v2 instead of the API default.
 */
export function createElevenLabsAudioAdapter(
  apiKey: string,
  options: { fetchImpl?: typeof fetch | undefined; modelId?: string | undefined } = {},
): AudioGenerationAdapter {
  const post = createElevenLabsHttp(apiKey, options.fetchImpl);
  const musicModel = options.modelId ?? "music_v2";
  if (typeof musicModel !== "string" || !musicModel.trim() || musicModel.length > 128 ||
      /[\s\u0000-\u001f\u007f]/u.test(musicModel)) {
    throw elevenLabsError("invalid music model identifier.");
  }

  return {
    provider: "elevenlabs",
    async submit(request, signal) {
      assertElevenLabsActive(signal);
      validateRequest(request);
      if (request.operation === "generate_music") {
        const bytes = await post("music", {
          prompt: request.prompt,
          ...(request.durationSeconds === undefined ? {} : {
            music_length_ms: Math.round(request.durationSeconds * 1000),
          }),
          model_id: musicModel,
          force_instrumental: request.instrumental,
          store_for_inpainting: false,
        }, signal);
        return { kind: "audio", outputs: [{ role: "music", bytes }] };
      }
      const bytes = await post("sound-generation", {
        text: request.prompt,
        duration_seconds: request.durationSeconds,
        loop: request.loop,
        model_id: "eleven_text_to_sound_v2",
      }, signal);
      return { kind: "audio", outputs: [{ role: "sound_effect", bytes }] };
    },
  };
}

function validateRequest(request: AudioGenerationRequest): asserts request is Extract<AudioGenerationRequest, { operation: "generate_music" | "generate_sound_effect" }> {
  if (!request || typeof request !== "object" ||
      (request.operation !== "generate_music" && request.operation !== "generate_sound_effect") ||
      typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw elevenLabsError("a non-empty generation prompt is required.");
  }
  if (request.operation === "generate_music") {
    if (request.options !== undefined) throw elevenLabsError("custom music options are not supported.");
    if (exceedsAudioPromptLimit(request.prompt, 4100)) throw elevenLabsError("music prompt exceeds 4100 characters.");
    if (typeof request.instrumental !== "boolean") {
      throw elevenLabsError("music instrumental must be a boolean.");
    }
    if (request.durationSeconds !== undefined && !durationInRange(request.durationSeconds, 3, 600)) {
      throw elevenLabsError("music duration must be between 3 and 600 seconds.");
    }
    return;
  }
  if (request.operation !== "generate_sound_effect") {
    throw elevenLabsError("unsupported generation operation.");
  }
  if (typeof request.loop !== "boolean") {
    throw elevenLabsError("sound effect loop must be a boolean.");
  }
  if (!durationInRange(request.durationSeconds, 0.5, 30)) {
    throw elevenLabsError("sound effect duration must be between 0.5 and 30 seconds.");
  }
}

function durationInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}
