import type { LyricModelCatalog, LyricWritingRequest, LyricWritingResult } from "../contracts.js";
import { createSunoHttp, SunoHttpError, type SunoSessionRefreshHandler } from "./suno-http.js";
import { sunoObject, type SunoSession } from "./suno-catalog.js";
import { exceedsAudioPromptLimit } from "../prompt.js";

type Http = ReturnType<typeof createSunoHttp>;
type Options = { fetchImpl?: typeof fetch; onSessionRefresh?: SunoSessionRefreshHandler };

export class SunoLyricsOutcomeUnknownError extends Error {
  constructor() { super("Suno's lyric-writing result is unconfirmed. Do not submit it again automatically."); }
}

export function parseLyricWritingRequest(input: unknown): LyricWritingRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid lyric-writing parameters.");
  const value = input as Record<string, unknown>;
  const fields = ["selected", "instruction", "contextBefore", "contextAfter", "title", "styles", "mode", "modelId", "enableThinking"];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unsupported lyric-writing parameter.");
  const readText = (field: string, maximum: number, required = false): string | undefined => {
    const text = value[field];
    if (text === undefined && !required) return undefined;
    if (typeof text !== "string" || text.includes("\0") || exceedsAudioPromptLimit(text, maximum)) throw new Error("Invalid lyric-writing text.");
    return text;
  };
  const selected = readText("selected", 5000, true)!;
  const instruction = readText("instruction", 8000, true)!;
  if (!instruction.trim()) throw new Error("A lyric-writing instruction is required.");
  if (value.mode !== undefined && value.mode !== "rewrite" && value.mode !== "alternatives") throw new Error("Invalid lyric-writing mode.");
  if (value.modelId !== undefined && (typeof value.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.modelId))) throw new Error("Invalid lyric model ID.");
  if (value.enableThinking !== undefined && typeof value.enableThinking !== "boolean") throw new Error("Invalid lyric reasoning option.");
  const result: LyricWritingRequest = { selected, instruction };
  for (const field of ["contextBefore", "contextAfter", "title", "styles"] as const) {
    const text = readText(field, field === "title" ? 100 : field === "styles" ? 1000 : 5000);
    if (text !== undefined) result[field] = text;
  }
  if (value.mode !== undefined) result.mode = value.mode;
  if (value.modelId !== undefined) result.modelId = value.modelId as string;
  if (value.enableThinking !== undefined) result.enableThinking = value.enableThinking as boolean;
  return result;
}

export async function readSunoLyricModels(session: SunoSession, signal: AbortSignal, options: Options = {}): Promise<LyricModelCatalog> {
  const http = createSunoHttp(session, options.fetchImpl, options.onSessionRefresh);
  return http.publicResult(await readModels(http, signal));
}

async function readModels(http: Http, signal: AbortSignal): Promise<LyricModelCatalog> {
  const value = await http.request("GET", "/api/generate/cowrite-lyrics/models/", undefined, signal);
  if (!Array.isArray(value) || value.length > 100) throw http.fail("invalid lyric model catalog.");
  const models = value.map((entry) => {
    const model = sunoObject(entry, http);
    if (typeof model.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(model.id) ||
        typeof model.display_name !== "string" || exceedsAudioPromptLimit(model.display_name, 160) ||
        model.supports_thinking !== undefined && typeof model.supports_thinking !== "boolean" ||
        model.family !== undefined && model.family !== null && (typeof model.family !== "string" || exceedsAudioPromptLimit(model.family, 128))) {
      throw http.fail("invalid lyric model evidence.");
    }
    return { id: model.id, name: model.display_name,
      ...(model.supports_thinking === undefined ? {} : { supportsThinking: model.supports_thinking as boolean }),
      ...(model.family === undefined || model.family === null ? {} : { family: model.family as string }) };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) throw http.fail("duplicate lyric model ID.");
  return { query: "lyric_models", models };
}

export async function writeSunoLyrics(
  session: SunoSession, input: LyricWritingRequest, signal: AbortSignal, options: Options = {},
): Promise<LyricWritingResult> {
  const request = parseLyricWritingRequest(input);
  const http = createSunoHttp(session, options.fetchImpl, options.onSessionRefresh);
  const modelId = request.modelId ?? "default";
  if (request.modelId !== undefined || request.enableThinking === true) {
    const catalog = await readModels(http, signal);
    const model = catalog.models.find((entry) => entry.id === modelId);
    if (!model || request.enableThinking === true && !model.supportsThinking) throw http.fail("the lyric model or thinking option is not available in this account's catalog.");
  }
  let dispatched = false;
  try {
    const value = sunoObject(await http.request("POST", "/api/generate/cowrite-lyrics/", {
      selected: request.selected, context_before: request.contextBefore ?? "", context_after: request.contextAfter ?? "",
      instruction: request.instruction, title: request.title ?? "", style: request.styles ?? "",
      mode: request.mode === "alternatives" ? "generate_variants" : "apply_user_request",
      references: [], num_variants: null,
      metadata: { lyrics_model: modelId, enable_thinking: request.enableThinking ?? false },
      create_session_token: null, lyrics_project_id: null,
    }, signal, () => { dispatched = true; }), http);
    const outputText = (text: unknown): string => {
      if (typeof text !== "string" || text.includes("\0") || exceedsAudioPromptLimit(text, 50_000)) throw http.fail("invalid lyric-writing result.");
      return text.replace(/\|edit_(start|end)\|?/gu, "").replace(/^\s*(\[[^\]\n]+\])[ \t]*\n+[ \t]*(?=\1[ \t]*\n)/u, "");
    };
    const lyrics = outputText(value.edited_lyrics);
    if (value.variants !== undefined && value.variants !== null && (!Array.isArray(value.variants) || value.variants.length > 16)) throw http.fail("invalid lyric variants.");
    const variants = Array.isArray(value.variants) ? value.variants.map(outputText) : undefined;
    if (!lyrics.trim() && !variants?.some((variant) => variant.trim())) throw http.fail("empty lyric-writing result.");
    if (variants && exceedsAudioPromptLimit(lyrics + variants.join(""), 100_000)) throw http.fail("lyric result exceeds the local text budget.");
    const result: LyricWritingResult = { status: "completed", lyrics, ...(variants?.length ? { variants } : {}) };
    for (const [source, target] of [["lyrics_request_id", "lyricsRequestId"], ["lyrics_id", "lyricsId"]] as const) {
      const id = value[source];
      if (id === undefined || id === null) continue;
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) throw http.fail("invalid lyric receipt ID.");
      result[target] = id;
    }
    return http.publicResult(result);
  } catch (error) {
    if (!dispatched || error instanceof SunoHttpError && error.status !== undefined && [400, 401, 402, 403, 404, 409, 422, 429].includes(error.status)) throw error;
    throw new SunoLyricsOutcomeUnknownError();
  }
}
