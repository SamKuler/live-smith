import { AudioToolOutcomeUnknownError } from "../contracts.js";
import type { AudioGenerationAdapter } from "../contracts.js";
import { createMurekaHttp, MurekaError, type MurekaTaskKind } from "./mureka-http.js";
import { MUREKA_LYRICS_PROMPT_CHARACTERS, validateMurekaGenerationRequest, validMurekaText } from "./mureka-rules.js";

const RUNNING = new Set(["preparing", "queued", "running", "streaming"]);
const TERMINAL = new Set(["succeeded", "failed", "timeouted", "cancelled"]);

export const MUREKA_MUSIC_MODELS = [
  "auto",
  "mureka-7.6",
  "mureka-o2",
  "mureka-8",
  "mureka-9",
  "mureka-9.5",
] as const;
export const DEFAULT_MUREKA_MUSIC_MODEL = "auto";

/** Official protocol: https://platform.mureka.ai/docs/ */
export function createMurekaAudioAdapter(
  apiKey: string, options: { modelId?: string | undefined; fetchImpl?: typeof fetch | undefined } = {},
): AudioGenerationAdapter {
  const http = createMurekaHttp(apiKey, options.fetchImpl);
  const model = options.modelId ?? DEFAULT_MUREKA_MUSIC_MODEL;
  if (!MUREKA_MUSIC_MODELS.includes(model as (typeof MUREKA_MUSIC_MODELS)[number])) {
    throw http.fail("unsupported music model identifier.");
  }
  const parseTask = (locator: string): { kind: MurekaTaskKind; taskId: string } => {
    const match = /^(song|instrumental):(.+)$/u.exec(locator);
    if (!match) throw http.fail("invalid task locator.");
    return { kind: match[1] as MurekaTaskKind, taskId: http.identifier(match[2]) };
  };
  return {
    provider: "mureka",
    async submit(request, signal) {
      http.active(signal);
      validateMurekaGenerationRequest(request, model, http.fail);
      const kind: MurekaTaskKind = request.operation === "generate_song_from_lyrics" || !request.instrumental
        ? "song"
        : "instrumental";
      const value = request.operation === "generate_song_from_lyrics"
        ? await http.submit("lyrics-song", {
            model,
            n: 1,
            lyrics: request.lyrics,
            ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
            ...(request.gender === undefined ? {} : { gender: request.gender }),
            stream: false,
          }, signal)
        : await http.submit(request.instrumental ? "instrumental" : "prompt-song", {
            model, n: 1, prompt: request.prompt, stream: false,
          }, signal);
      const taskId = http.identifier(value.id);
      if (typeof value.status !== "string" || !RUNNING.has(value.status) && !TERMINAL.has(value.status)) {
        throw http.fail("invalid submission task status.");
      }
      return { kind: "task", taskId: `${kind}:${taskId}` };
    },
    async inspect(locator, signal) {
      http.active(signal);
      const { kind, taskId } = parseTask(locator);
      const value = await http.inspect(kind, taskId, signal);
      if (http.identifier(value.id) !== taskId) throw http.fail("task ID does not match the requested task.");
      if (typeof value.status !== "string") throw http.fail("invalid task status.");
      if (RUNNING.has(value.status)) return { status: "running" };
      if (value.status === "failed") return { status: "failed", message: http.fail("task failed.").message };
      if (value.status === "timeouted") return { status: "failed", message: http.fail("task timed out.").message };
      if (value.status === "cancelled") return { status: "cancelled" };
      if (value.status !== "succeeded") throw http.fail("unknown task status.");
      if (!Array.isArray(value.choices) || value.choices.length !== 1) {
        throw http.fail("completed task must contain the requested audio output.");
      }
      const choice = http.object(value.choices[0]);
      return { status: "completed", outputs: [{
        key: http.identifier(choice.id), role: "music", url: http.outputUrl(choice.url),
      }] };
    },
    async download(output, signal) {
      http.active(signal);
      http.identifier(output.key);
      if (output.role !== "music") throw http.fail("invalid music output role.");
      return http.download(output.url, signal);
    },
    // The published API documents task state polling but no cancellation operation.
  };
}

export class MurekaLyricsOutcomeUnknownError extends AudioToolOutcomeUnknownError {
  constructor() { super("Mureka audio service: lyric-generation result is unconfirmed. Do not submit it again automatically."); }
}

export async function generateMurekaLyrics(
  apiKey: string,
  prompt: string,
  signal: AbortSignal,
  options: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<{ title: string; lyrics: string }> {
  const http = createMurekaHttp(apiKey, options.fetchImpl);
  if (!validMurekaText(prompt, MUREKA_LYRICS_PROMPT_CHARACTERS)) throw http.fail(`lyrics prompt must contain 1–${MUREKA_LYRICS_PROMPT_CHARACTERS} characters.`);
  let dispatched = false;
  try {
    const value = await http.submit("lyrics", { prompt }, signal, () => { dispatched = true; });
    const title = generatedText(value.title, 200, false, http.fail);
    const lyrics = generatedText(value.lyrics, 20_000, true, http.fail);
    return { title, lyrics };
  } catch (error) {
    const rejected = error instanceof MurekaError && error.status !== undefined &&
      error.status >= 400 && error.status < 500 && error.status !== 408;
    if (dispatched && !rejected) throw new MurekaLyricsOutcomeUnknownError();
    throw error;
  }
}

function generatedText(
  value: unknown,
  maximum: number,
  multiline: boolean,
  fail: (detail: string) => Error,
): string {
  if (!validMurekaText(value, maximum) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      !multiline && /[\r\n]/u.test(value)) {
    throw fail("invalid generated lyrics response.");
  }
  return value;
}
