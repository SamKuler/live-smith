import type { AudioGenerationRequest } from "../contracts.js";
import type { createSunoHttp } from "./suno-http.js";
import { sunoObject, sunoUuid } from "./suno-catalog.js";
import { exceedsAudioPromptLimit } from "../prompt.js";

type Http = ReturnType<typeof createSunoHttp>;
export type SunoMusicEdit = Extract<AudioGenerationRequest, {
  operation: "add_vocals" | "add_instrumental" | "replace_music_section";
}>;

export function sourceActionAllowed(source: Record<string, unknown>, type: string, fallback: boolean): boolean {
  const config = source.action_config;
  const actions = config && typeof config === "object" ? (config as Record<string, unknown>).actions : undefined;
  let action: Record<string, unknown> | undefined;
  if (Array.isArray(actions)) for (const entry of actions) {
    if (entry && typeof entry === "object" && entry.action_type === type) action = entry;
  }
  const visible = typeof action?.visible === "boolean" ? action.visible : action ? true : fallback;
  return visible && action?.disabled !== true;
}

export function musicEditTask(operation: SunoMusicEdit["operation"]): string {
  return operation === "add_vocals" ? "overpainting" : operation === "add_instrumental" ? "underpainting" : "infill";
}

export async function prepareMusicEdit(
  request: SunoMusicEdit, source: Record<string, unknown>, ownerId: string,
  body: Record<string, unknown>, http: Http, signal: AbortSignal, maximumPromptCharacters?: number,
): Promise<Record<string, unknown>> {
  const metadata = sunoObject(source.metadata, http);
  const sourceLyrics = typeof metadata.prompt === "string" ? metadata.prompt : "";
  const upload = metadata.type === "upload";
  const sourceKindAllowed = request.operation === "add_vocals"
    ? upload || metadata.stem_type_group_name === "Instrumental" || !sourceLyrics || /^\[.*\]$/u.test(sourceLyrics.trim())
    : request.operation === "add_instrumental"
    ? upload || metadata.stem_type_group_name === "Vocals" || metadata.stem_type_group_name === "Backing_Vocals"
    : true;
  const action = request.operation === "add_vocals" ? "add_vocal" : request.operation === "add_instrumental" ? "add_instrumental" : "replace_section";
  if (!sourceActionAllowed(source, action, source.user_id === ownerId && sourceKindAllowed)) {
    throw http.fail("the source clip does not permit this editing operation.");
  }
  const output: Record<string, unknown> & { metadata: Record<string, unknown> } = { ...body, task: musicEditTask(request.operation), metadata: { ...sunoObject(body.metadata, http), is_remix: true } };
  if (request.operation !== "replace_music_section") {
    return { ...output, [request.operation === "add_vocals" ? "overpainting_clip_id" : "underpainting_clip_id"]: request.clipId };
  }
  const duration = metadata.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
      request.endSeconds > duration || (request.contextEndSeconds ?? duration) > duration) {
    throw http.fail("replacement and context must lie within the completed source clip.");
  }
  const start = quantize(request.startSeconds, "floor");
  const end = quantize(request.endSeconds, "ceil");
  const contextStart = quantize(request.contextStartSeconds ?? 0, "floor");
  const contextEnd = quantize(request.contextEndSeconds ?? duration, "ceil");
  const lyrics = sourceLyrics.trim()
    ? await readExistingAlignedSection(http, request.clipId, request.startSeconds, request.endSeconds, signal)
    : { before: "", selected: "" };
  if (exceedsAudioPromptLimit(lyrics.before, maximumPromptCharacters ?? 5000)) throw http.fail("aligned lyric context exceeds the selected model limit.");
  // The website supplies context lyrics in prompt and the new lyrics separately.
  const { make_instrumental: _instrumental, ...base } = output;
  return {
    ...base, continue_clip_id: request.clipId, continued_aligned_prompt: request.prompt,
    prompt: lyrics.before,
    infill_start_s: start, infill_end_s: end,
    infill_dur_s: quantize(request.replacementDurationSeconds ?? request.endSeconds - request.startSeconds, "ceil"),
    infill_context_start_s: contextStart, infill_context_end_s: contextEnd,
    metadata: { ...output.metadata, infill_lyrics: request.prompt || lyrics.selected,
      lyrics_updated: request.prompt !== "" && request.prompt !== sourceLyrics },
  };
}

export function finishMusicReplacementBody(source: Record<string, unknown>, ownerId: string, http: Http): Record<string, unknown> {
  const metadata = sunoObject(source.metadata, http);
  if (metadata.task !== "infill" || !sourceActionAllowed(source, "confirm_section", source.user_id === ownerId)) {
    throw http.fail("choose a completed replacement candidate permitted by this account.");
  }
  const parent = sunoUuid(metadata.edited_clip_id, http);
  if (parent === source.id) throw http.fail("replacement candidate lineage is invalid.");
  const editSession = metadata.edit_session_id;
  if (editSession !== undefined && editSession !== null) sunoUuid(editSession, http);
  return { clip_id: source.id, is_infill: true,
    ...(editSession === undefined || editSession === null ? {} : { edit_session_id: editSession }) };
}

function quantize(seconds: number, direction: "floor" | "ceil"): number {
  return Math[direction](seconds / 0.04 + (direction === "floor" ? 1e-9 : -1e-9)) * 0.04;
}

/** Read only existing alignment. Missing alignment never initiates a paid or mutating request. */
async function readExistingAlignedSection(http: Http, id: string, start: number, end: number, signal: AbortSignal) {
  const value = sunoObject(await http.request("GET", `/api/gen/${id}/aligned_lyrics/v2`, undefined, signal), http);
  if (!Array.isArray(value.aligned_words) || !value.aligned_words.length || value.aligned_words.length > 10_000) {
    throw http.fail("existing lyric alignment is unavailable. Align this song in Suno before replacing a vocal section.");
  }
  const words = value.aligned_words.map((raw) => {
    const word = sunoObject(raw, http);
    if (typeof word.word !== "string" || word.word.includes("\0") ||
        typeof word.start_s !== "number" || !Number.isFinite(word.start_s) || word.start_s < 0 ||
        typeof word.end_s !== "number" || !Number.isFinite(word.end_s) || word.end_s < word.start_s) {
      throw http.fail("invalid existing lyric alignment.");
    }
    return { text: word.word, start: word.start_s, end: word.end_s };
  });
  const before: LyricToken[] = [], selected: LyricToken[] = [];
  let started = false, inSection = false;
  for (const token of normalizeAlignedLyrics(words)) {
    if (token.timing) {
      const midpoint = (token.timing.start + token.timing.end) / 2;
      if (midpoint > start || token.timing.start === start) { inSection = true; started = true; }
      if (inSection && (midpoint > end || token.timing.start === end && token.timing.end > end)) inSection = false;
    }
    if (inSection) selected.push(token);
    else if (!started) before.push(token);
  }
  // Whitespace after the selection belongs to the following lyric context.
  while (selected.length && !selected.at(-1)!.timing && !selected.at(-1)!.text.trim()) selected.pop();
  const result = { before: before.map((token) => token.text).join(""), selected: selected.map((token) => token.text).join("") };
  if (Object.values(result).some((text) => exceedsAudioPromptLimit(text, 5000))) throw http.fail("aligned lyric context exceeds the supported limit.");
  return result;
}

interface TimedWord { text: string; start: number; end: number }
interface LyricToken { text: string; timing?: { start: number; end: number } }

/** Website lyric tokens give whitespace no timing and section markers point timing. */
function normalizeAlignedLyrics(words: TimedWord[]): LyricToken[] {
  const fragments = words.flatMap((word) => !word.text.includes("\n") ? [word] : word.text.split("\n").flatMap((text, index) => [
    ...(index ? [{ ...word, text: "\n" }] : []), ...(text ? [{ ...word, text }] : []),
  ]));
  const result: LyricToken[] = [];
  const whitespace = (text: string) => {
    if (!text || !result.length) return;
    const normalized = text.includes("\n") ? "\n" : " ";
    if (result.at(-1)!.text !== normalized) result.push({ text: normalized });
  };
  fragments.forEach((fragment, index) => {
    const next = fragments[index + 1], previous = fragments[index - 1];
    const text = fragment.text.trim();
    whitespace(fragment.text.match(/^\s*/u)![0]);
    const section = text.match(/^\[.*\]\s*/u)?.[0];
    if (section) {
      if (result.length) result.push({ text: "\n" });
      const point = fragment.start !== fragment.end ? fragment.start : next?.start ?? previous?.end;
      result.push({ text: section, ...(point === undefined ? {} : { timing: { start: point, end: point } }) });
      const remainder = text.slice(section.length).trim();
      if (remainder) {
        result.push({ text: remainder, timing: { start: fragment.start, end: fragment.end } }, { text: "\n" });
      }
    } else if (text) {
      const punctuation = next?.text.match(/^[.!?]*[)\]}>]*/u)?.[0] ?? "";
      if (punctuation && next) next.text = next.text.slice(punctuation.length);
      result.push({ text: text + punctuation, timing: { start: fragment.start, end: fragment.end } });
    }
    whitespace(fragment.text.match(/\s*$/u)![0]);
  });
  return result;
}
