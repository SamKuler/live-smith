import type { AudioGenerationAdapter, AudioGenerationRequest, MusicGenerationOptions } from "../contracts.js";
import { exceedsAudioPromptLimit } from "../prompt.js";
import { createSunoPlatformHttp } from "./suno-platform-http.js";

const RUNNING = new Set(["submitted", "queued", "streaming"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** First-party Platform contract exposed through platform.suno.com accounts. */
export function createSunoPlatformAudioAdapter(
  apiKey: string, options: { fetchImpl?: typeof fetch | undefined } = {},
): AudioGenerationAdapter {
  const http = createSunoPlatformHttp(apiKey, options.fetchImpl);
  return {
    provider: "suno-platform",
    async submit(request, signal) {
      http.active(signal);
      const body = generationBody(request, http.fail);
      const receipt = await http.submit(body, signal);
      const taskId = http.identifier(receipt.id);
      if (![...RUNNING, "complete"].includes(String(receipt.status))) {
        throw http.fail("invalid or failed submission receipt.");
      }
      return { kind: "task", taskId, expectedOutputs: [{ key: taskId, role: "music" }] };
    },
    async inspect(taskId, signal, expectedOutputs) {
      http.active(signal);
      const requestedId = http.identifier(taskId);
      if (!Array.isArray(expectedOutputs) || expectedOutputs.length !== 1 ||
          expectedOutputs[0]?.key !== requestedId || expectedOutputs[0]?.role !== "music") {
        throw http.fail("status retrieval requires the original output manifest.");
      }
      const value = await http.inspect(requestedId, signal);
      if (http.identifier(value.id) !== requestedId) throw http.fail("task ID does not match the requested task.");
      if (typeof value.status !== "string") throw http.fail("invalid task status.");
      if (RUNNING.has(value.status)) return { status: "running" };
      if (value.status === "error") return { status: "failed", message: http.fail("task failed.").message };
      if (value.status !== "complete") throw http.fail("unknown task status.");
      return { status: "completed", outputs: [{ key: requestedId, role: "music", url: http.outputUrl(value.audio_url) }] };
    },
    async download(output, signal) {
      http.active(signal);
      http.identifier(output.key);
      if (output.role !== "music") throw http.fail("invalid music output role.");
      return http.download(output.url, signal);
    },
  };
}

function generationBody(request: AudioGenerationRequest, fail: (detail: string) => Error): Record<string, unknown> {
  if (!request || request.operation !== "generate_music") throw fail("only music generation is supported.");
  if (request.durationSeconds !== undefined) throw fail("duration is not supported.");
  if (typeof request.prompt !== "string" || request.prompt.includes("\0") || typeof request.instrumental !== "boolean") {
    throw fail("invalid music prompt or instrumental flag.");
  }
  const options = request.options;
  if (!options) {
    if (!request.prompt.trim() || exceedsAudioPromptLimit(request.prompt, 3000)) throw fail("music description must contain 1–3000 characters.");
    return request.instrumental ? { style: request.prompt, instrumental: true } : { description: request.prompt };
  }
  validateOptions(options, fail);
  if (exceedsAudioPromptLimit(request.prompt, 5000) || (!request.instrumental && !request.prompt.trim())) {
    throw fail("custom lyrics must contain 1–5000 characters unless instrumental is enabled.");
  }
  return {
    lyrics: request.prompt,
    style: options.styles,
    ...(options.title ? { title: options.title } : {}),
    ...(options.personaId ? { voice_id: options.personaId } : {}),
    ...(request.instrumental ? { instrumental: true } : {}),
  };
}

function validateOptions(options: MusicGenerationOptions, fail: (detail: string) => Error): void {
  if (!options || typeof options !== "object" || Array.isArray(options) || options.mode !== "custom" ||
      Object.keys(options).some((field) => !["mode", "title", "styles", "personaId"].includes(field)) ||
      typeof options.styles !== "string" || !options.styles.trim() || exceedsAudioPromptLimit(options.styles, 1000) ||
      (options.title !== undefined && (typeof options.title !== "string" || exceedsAudioPromptLimit(options.title, 100))) ||
      (options.personaId !== undefined && (typeof options.personaId !== "string" || !UUID.test(options.personaId)))) {
    throw fail("invalid or unsupported custom music options.");
  }
}
