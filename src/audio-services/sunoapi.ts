import type { AudioGenerationAdapter, RemoteAudioOutput } from "./contracts.js";
import { createSunoApiHttp } from "./sunoapi-http.js";
import { exceedsAudioPromptLimit } from "./prompt.js";

const RUNNING = ["PENDING", "TEXT_SUCCESS", "FIRST_SUCCESS"];
const FAILED = ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR"];

export const SUNOAPI_MUSIC_MODELS = [
  "V6",
  "V6_WILD",
  "V6_MINI",
  "V5_5",
  "V5",
  "V4_5PLUS",
  "V4_5ALL",
  "V4_5",
  "V4",
] as const;
export const DEFAULT_SUNOAPI_MUSIC_MODEL = "V6";

/** Third-party contract, not Suno's official or subscription API:
 * https://docs.sunoapi.org/suno-api/suno-api.json
 */
export function createSunoApiAudioAdapter(
  apiKey: string,
  options: { callbackUrl: string; modelId?: string | undefined; fetchImpl?: typeof fetch | undefined },
): AudioGenerationAdapter {
  const http = createSunoApiHttp(apiKey, options?.fetchImpl);
  const callbackUrl = http.callbackUrl(options?.callbackUrl);
  const model = options?.modelId ?? DEFAULT_SUNOAPI_MUSIC_MODEL;
  if (!SUNOAPI_MUSIC_MODELS.includes(model as (typeof SUNOAPI_MUSIC_MODELS)[number])) {
    throw http.fail("unsupported music model identifier.");
  }
  return {
    provider: "sunoapi",
    async submit(request, signal) {
      http.active(signal);
      if (!request || request.operation !== "generate_music") throw http.fail("only music generation is supported.");
      if (request.options !== undefined) throw http.fail("custom music options are not supported by this adapter.");
      if (request.durationSeconds !== undefined) throw http.fail("duration is not supported in non-custom music mode.");
      if (typeof request.instrumental !== "boolean") throw http.fail("instrumental must be a boolean.");
      if (typeof request.prompt !== "string" || !request.prompt.trim()) throw http.fail("a non-empty prompt is required.");
      if (exceedsAudioPromptLimit(request.prompt, 3000)) throw http.fail("music prompt exceeds 3000 characters.");
      const value = await http.post({
        customMode: false, instrumental: request.instrumental, model,
        callBackUrl: callbackUrl, prompt: request.prompt,
      }, signal);
      // Even during Stop, only a complete, validated paid receipt can escape.
      return { kind: "task", taskId: http.identifier(value.taskId) };
    },
    async inspect(taskId, signal) {
      http.active(signal);
      const requestedId = http.identifier(taskId);
      const value = await http.inspect(requestedId, signal);
      if (http.identifier(value.taskId) !== requestedId) throw http.fail("task ID does not match the requested task.");
      const response = value.response == null ? undefined : http.object(value.response);
      if (response && http.identifier(response.taskId) !== requestedId) throw http.fail("result task ID does not match the requested task.");
      if (typeof value.status !== "string") throw http.fail("invalid task status.");
      if (RUNNING.includes(value.status)) return { status: "running" };
      if (FAILED.includes(value.status)) return { status: "failed", message: http.fail(`task reported ${value.status}.`).message };
      if (value.status !== "SUCCESS") throw http.fail("unknown task status.");
      if (!response || !Array.isArray(response.sunoData) || response.sunoData.length < 1 || response.sunoData.length > 2) {
        throw http.fail("completed task must contain one or two audio outputs.");
      }
      const tracks = response.sunoData.map((entry) => {
        const track = http.object(entry);
        return { id: http.identifier(track.id), url: http.outputUrl(track.audio_url) };
      });
      if (new Set(tracks.map((track) => track.id)).size !== tracks.length) throw http.fail("duplicate audio output identifier.");
      // Provider array order is not stable across polling/resume. Persisted roles
      // depend on the stable audio identifier, never on response array order.
      tracks.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const outputs: RemoteAudioOutput[] = tracks.map((track, index) => ({
        key: track.id, role: index === 0 ? "music" : "music_alternative", url: track.url,
      }));
      return { status: "completed", outputs };
    },
    async download(output, signal) {
      http.active(signal);
      http.identifier(output.key);
      if (output.role !== "music" && output.role !== "music_alternative") throw http.fail("invalid music output role.");
      return http.download(output.url, signal);
    },
    // The published API has no cancellation operation. Stop only ends local work.
  };
}
