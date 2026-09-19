import { randomUUID } from "node:crypto";
import type { AudioDownloadAuthorization, AudioServiceAuthorization, AudioGenerationAdapter, AudioGenerationRequest, AudioGenerationSubmission, AudioJob, RemoteAudioOutput } from "./contracts.js";
import { AudioSubmissionNotStartedError } from "./contracts.js";
import { assertSunoVerificationFresh, readSunoVerificationProof, SunoVerificationError, type SunoHumanVerificationHandler, type SunoVerificationProof } from "./suno-verification.js";
import { createSunoHttp, type SunoSessionRefreshHandler } from "./suno-http.js";
import { exceedsAudioPromptLimit } from "./prompt.js";
import { downloadSunoClip, sunoDownloadPath } from "./suno-download.js";
import { readSunoCatalog, readSunoPersona, sunoActive, sunoObject, sunoUuid, type SunoMusicModel, type SunoSession } from "./suno-catalog.js";
export { readSunoMusicService } from "./suno-catalog.js";
export type { SunoMusicServiceRequest } from "./suno-catalog.js";

type SunoHttp = ReturnType<typeof createSunoHttp>;
type MusicRequest = Extract<AudioGenerationRequest, {
  operation: "generate_music" | "extend_music" | "get_whole_song";
}>;
type Manifest = NonNullable<AudioJob["expectedOutputs"]>;
function terminal(status: unknown): boolean { return status === "complete" || status === "error"; }

function validateRequest(request: AudioGenerationRequest, http: SunoHttp): MusicRequest {
  const input = sunoObject(request, http);
  const fields = request.operation === "generate_music" ? ["operation", "prompt", "durationSeconds", "instrumental", "options"]
    : request.operation === "extend_music" ? ["operation", "clipId", "startSeconds", "prompt", "instrumental", "options"]
    : request.operation === "get_whole_song" ? ["operation", "clipId"] : [];
  if (!fields.length || Object.keys(input).some((key) => !fields.includes(key))) throw http.fail("unsupported music operation or parameter.");
  if (request.operation === "get_whole_song") {
    sunoUuid(request.clipId, http);
    return { operation: request.operation, clipId: request.clipId };
  }
  if (request.operation !== "generate_music" && request.operation !== "extend_music") throw http.fail("unsupported music operation.");
  const custom = request.operation === "extend_music" || request.options?.mode === "custom";
  if (typeof request.prompt !== "string" || request.prompt.includes("\0") ||
      exceedsAudioPromptLimit(request.prompt, custom ? 5000 : 3000) || typeof request.instrumental !== "boolean") {
    throw http.fail("invalid music prompt or instrumental flag.");
  }
  if (request.options !== undefined) {
    const options = sunoObject(request.options, http);
    if (options.mode !== "custom" || Object.keys(options).some((key) => ![
      "mode", "title", "styles", "negativeStyles", "weirdness", "styleInfluence", "personaId",
      "vocalGender",
    ].includes(key))) throw http.fail("unsupported custom music option.");
    for (const key of ["title", "styles", "negativeStyles"] as const) {
      if (options[key] !== undefined && (typeof options[key] !== "string" || options[key].includes("\0") ||
          exceedsAudioPromptLimit(options[key], key === "title" ? 100 : 1000))) {
        throw http.fail("invalid custom music text.");
      }
    }
    if (options.vocalGender !== undefined && options.vocalGender !== "male" && options.vocalGender !== "female") {
      throw http.fail("vocal gender must be male or female.");
    }
    for (const key of ["weirdness", "styleInfluence"] as const) {
      const value = options[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        throw http.fail("music sliders must be numbers between 0 and 100.");
      }
    }
    if (options.personaId !== undefined) sunoUuid(options.personaId, http);
    if (request.operation === "extend_music" && options.personaId !== undefined) {
      throw http.fail("Persona is not available for music extensions.");
    }
  }
  if (!request.prompt.trim() && !(request.instrumental && custom)) {
    throw http.fail("a prompt is required except for instrumental custom music.");
  }
  if (request.operation === "generate_music" && request.durationSeconds !== undefined &&
    (typeof request.durationSeconds !== "number" || !Number.isFinite(request.durationSeconds) ||
      request.durationSeconds < 10 || request.durationSeconds > 480)) {
    throw http.fail("music duration must be between 10 and 480 seconds.");
  }
  if (request.operation === "extend_music") {
    sunoUuid(request.clipId, http);
    if (typeof request.startSeconds !== "number" || !Number.isFinite(request.startSeconds) || request.startSeconds < 0) {
      throw http.fail("invalid extension start time.");
    }
  }
  return {
    operation: request.operation, prompt: request.prompt, instrumental: request.instrumental,
    ...(request.operation === "generate_music" && request.durationSeconds !== undefined
      ? { durationSeconds: request.durationSeconds } : {}),
    ...(request.operation === "extend_music" ? { clipId: request.clipId, startSeconds: request.startSeconds } : {}),
    ...(request.options ? { options: { ...request.options } } : {}),
  } as MusicRequest;
}

function enforceLimits(request: Exclude<MusicRequest, { operation: "get_whole_song" }>, model: SunoMusicModel, http: SunoHttp) {
  const custom = request.operation === "extend_music" || request.options?.mode === "custom";
  const text: Array<[keyof SunoMusicModel["maxLengths"], string]> = [
    [custom ? "prompt" : "gpt_description_prompt", request.prompt],
    ["title", request.options?.title ?? ""], ["tags", request.options?.styles ?? ""],
    ["negative_tags", request.options?.negativeStyles ?? ""],
  ];
  for (const [key, value] of text) {
    const limit = model.maxLengths[key];
    if (limit !== undefined && exceedsAudioPromptLimit(value, limit)) throw http.fail("music text exceeds the selected model's catalog limit.");
  }
  if (request.operation === "generate_music" && request.durationSeconds !== undefined && model.supportsDuration !== true) {
    throw http.fail("the selected catalog model does not support requested duration.");
  }
}

function generationBody(request: Exclude<MusicRequest, { operation: "get_whole_song" }>, modelId: string) {
  const options = request.options;
  const custom = request.operation === "extend_music" || options?.mode === "custom";
  const sliders = {
    ...(options?.weirdness === undefined ? {} : { weirdness_constraint: options.weirdness / 100 }),
    ...(options?.styleInfluence === undefined ? {} : { style_weight: options.styleInfluence / 100 }),
  };
  // The web client sends descriptions in gpt_description_prompt; prompt is lyrics.
  // Unverified cover/remaster/Sounds controls are deliberately not exposed.
  return {
    token: null, token_provider: null, generation_type: "TEXT", mv: modelId,
    ...(request.operation === "extend_music" ? { task: "extend" } : {}),
    ...(custom ? { title: options?.title ?? "", tags: options?.styles ?? "", negative_tags: options?.negativeStyles ?? "" } : {}),
    prompt: custom ? request.prompt : "", ...(custom ? {} : { gpt_description_prompt: request.prompt }),
    make_instrumental: request.instrumental, user_uploaded_images_b64: null,
    ...(request.operation === "generate_music" && request.durationSeconds !== undefined
      ? { duration: request.durationSeconds } : {}),
    metadata: {
      web_client_pathname: "/create", is_max_mode: false, is_mumble: false,
      create_mode: custom ? "custom" : "simple",
      user_tier: "", create_session_token: randomUUID(), disable_volume_normalization: false,
      ...(request.operation === "extend_music" ? { is_remix: true, lyrics_updated: false } : {}),
      ...(options?.vocalGender === undefined ? {} : { vocal_gender: options.vocalGender === "female" ? "f" : "m" }),
      ...(Object.keys(sliders).length ? { control_sliders: sliders } : {}),
    },
    override_fields: [], cover_clip_id: null, cover_start_s: null, cover_end_s: null,
    persona_id: options?.personaId ?? null, artist_clip_id: null, artist_start_s: null, artist_end_s: null,
    continue_clip_id: request.operation === "extend_music" ? request.clipId : null,
    continued_aligned_prompt: null, continue_at: request.operation === "extend_music" ? request.startSeconds : null,
    transaction_uuid: randomUUID(),
  };
}

function manifestFromReceipt(value: unknown, single: boolean, http: SunoHttp): Manifest {
  const receipt = sunoObject(value, http);
  if (typeof receipt.status === "string" && receipt.status.toLowerCase() === "error") throw http.fail("music submission was rejected.");
  const clips = single ? [receipt] : receipt.clips;
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 2) throw http.fail("submission must acknowledge one or two clips.");
  const ids = clips.map((clip: unknown) => sunoUuid(sunoObject(clip, http).id, http)).sort();
  if (new Set(ids).size !== ids.length) throw http.fail("duplicate submission clip identifier.");
  const manifest: Manifest = ids.map((key, index) => ({ key, role: index === 0 ? "music" : "music_alternative" }));
  for (const entry of manifest) Object.freeze(entry);
  Object.freeze(manifest);
  return manifest;
}

function checkedManifest(taskId: string, manifest: AudioJob["expectedOutputs"], http: SunoHttp): Manifest {
  sunoUuid(taskId, http);
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 2) throw http.fail("Suno recovery requires the original output manifest.");
  const result = manifest.map((entry, index) => {
    const value = sunoObject(entry, http);
    const key = sunoUuid(value.key, http);
    if (value.role !== (index === 0 ? "music" : "music_alternative") ||
        Object.keys(value).some((field) => field !== "key" && field !== "role")) throw http.fail("invalid Suno output manifest.");
    return { key, role: value.role } as Manifest[number];
  });
  if (result[0]!.key !== taskId || result.some((entry, index) => index > 0 && entry.key <= result[index - 1]!.key)) {
    throw http.fail("output manifest does not match the original Suno task.");
  }
  return result;
}

export function createSunoAudioAdapter(
  session: SunoSession, options: {
    fetchImpl?: typeof fetch;
    modelId?: string;
    authorizeDownloads?: boolean;
    onSessionRefresh?: SunoSessionRefreshHandler;
    verifyHuman?: SunoHumanVerificationHandler;
    authorizeSubmission?: AudioServiceAuthorization;
  } = {},
): AudioGenerationAdapter {
  session = { ...session };
  const http = createSunoHttp(session, options.fetchImpl, options.onSessionRefresh);
  const modelId = options.modelId;
  const authorizeDownloads = options.authorizeDownloads === true;
  const download = (output: RemoteAudioOutput, signal: AbortSignal, authorization?: AudioDownloadAuthorization) => {
    sunoActive(signal, http);
    sunoUuid(output.key, http);
    if (output.role !== "music" && output.role !== "music_alternative") throw http.fail("invalid generated music role.");
    if (output.url !== sunoDownloadPath(output.key)) throw http.fail("download locator does not match its clip identifier.");
    return downloadSunoClip(http, output.key, signal, authorizeDownloads, authorization);
  };
  if (modelId !== undefined && (typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(modelId))) {
    throw http.fail("invalid configured music model identifier.");
  }
  const prepared = new WeakMap<AudioGenerationRequest, {
    signature: string; signal: AbortSignal; path: string; body: object; proof?: SunoVerificationProof;
  }>();
  return {
    provider: "suno",
    async prepare(request, signal) {
      prepared.delete(request);
      sunoActive(signal, http);
      const snapshot = validateRequest(request, http);
      let body: object;
      let path: string;
      if (snapshot.operation === "get_whole_song") {
        body = { clip_id: snapshot.clipId };
        path = "/api/generate/concat/v2/";
      } else {
        const catalog = await readSunoCatalog(http, session, signal);
        const candidates = catalog.models.filter((model) => model.canUse === true && (modelId === undefined ? model.isDefault === true : model.id === modelId));
        if (candidates.length !== 1) throw http.fail("the configured model or an unambiguous usable default is unavailable.");
        enforceLimits(snapshot, candidates[0]!, http);
        if (snapshot.options?.personaId) await readSunoPersona(http, session, snapshot.options.personaId, signal);
        body = generationBody(snapshot, candidates[0]!.id);
        path = "/api/generate/v2-web/";
      }
      if (snapshot.operation === "extend_music" || snapshot.operation === "get_whole_song") {
        const clips = await http.request("GET", `/api/feed/?ids=${snapshot.clipId}`, undefined, signal);
        if (!Array.isArray(clips) || clips.length !== 1) throw http.fail("source clip is unavailable.");
        const source = sunoObject(clips[0], http);
        if (sunoUuid(source.id, http) !== snapshot.clipId || source.status !== "complete") throw http.fail("source clip is not complete or does not match.");
        if (snapshot.operation === "get_whole_song") {
          const task = sunoObject(source.metadata, http).task;
          if (typeof task !== "string" || !["extend", "upload_extend", "artist_extend", "vox_extend"].includes(task)) {
            throw http.fail("Get Whole Song requires a completed extension clip.");
          }
        }
        if (snapshot.operation === "extend_music") {
          const duration = sunoObject(source.metadata, http).duration;
          if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= snapshot.startSeconds) {
            throw http.fail("extension start must be before the source clip's duration.");
          }
        }
      }
      const gate = sunoObject(await http.request("POST", "/api/c/check", { ctype: "generation" }, signal), http);
      let proof: SunoVerificationProof | undefined;
      if (gate.required === true) {
        if (snapshot.operation === "get_whole_song") throw http.fail("verification for Get Whole Song is not supported. No generation was submitted.");
        if (gate.captcha_version !== 1 && gate.captcha_version !== 2) throw http.fail("unsupported verification version. No generation was submitted.");
        if (!options.verifyHuman) throw http.fail("human verification is unavailable. No generation was submitted.");
        try { proof = readSunoVerificationProof(await options.verifyHuman(gate.captcha_version, signal), gate.captcha_version); }
        catch (error) {
          sunoActive(signal, http);
          if (error instanceof SunoVerificationError) throw http.fail(error.message);
          throw http.fail("human verification could not be completed. No generation was submitted.");
        }
        http.protectPrivateValue(proof.token);
        body = { ...body, token: proof.token, token_provider: proof.captchaVersion };
      } else if (gate.required !== false) throw http.fail("generation verification status is unavailable. No generation was submitted.");
      sunoActive(signal, http);
      const signature = JSON.stringify(snapshot);
      if (JSON.stringify(validateRequest(request, http)) !== signature) throw http.fail("music parameters changed during preparation.");
      prepared.set(request, { signature, signal, path, body, ...(proof ? { proof } : {}) });
    },
    async submit(request, signal) {
      const plan = prepared.get(request);
      prepared.delete(request);
      const beforeSend = () => {
        try {
          sunoActive(signal, http);
          if (!plan || plan.signal !== signal || plan.signature !== JSON.stringify(validateRequest(request, http))) throw new Error();
          if (plan.proof) assertSunoVerificationFresh(plan.proof);
        } catch {
          const error = new AudioSubmissionNotStartedError("Suno.com audio service: preparation or verification is no longer valid. No generation was submitted.");
          if (signal.aborted) error.name = "AbortError";
          throw error;
        }
      };
      beforeSend();
      const dispatch = async (): Promise<AudioGenerationSubmission> => {
        beforeSend();
        const snapshot = validateRequest(request, http);
        const receipt = await http.request("POST", plan!.path, plan!.body, signal, beforeSend);
        // A validated receipt may race Stop; retain every acknowledged identity.
        const expectedOutputs = manifestFromReceipt(receipt, snapshot.operation === "get_whole_song", http);
        return { kind: "task", taskId: expectedOutputs[0]!.key, expectedOutputs };
      };
      return options.authorizeSubmission ? options.authorizeSubmission(signal, dispatch) : dispatch();
    },
    async inspect(taskId, signal, expectedOutputs) {
      sunoActive(signal, http);
      const manifest = checkedManifest(taskId, expectedOutputs, http);
      const value = await http.request("GET", `/api/feed/?ids=${manifest.map((entry) => entry.key).join(",")}`, undefined, signal);
      if (!Array.isArray(value) || value.length > manifest.length) throw http.fail("invalid clip status response.");
      const found = new Map<string, Record<string, unknown>>();
      for (const raw of value) {
        const clip = sunoObject(raw, http);
        const id = sunoUuid(clip.id, http);
        if (!manifest.some((entry) => entry.key === id) || found.has(id)) throw http.fail("unexpected or duplicate clip in status response.");
        if (typeof clip.status !== "string" || !clip.status.trim() || clip.status.length > 64 ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(clip.status)) throw http.fail("invalid clip status.");
        found.set(id, clip);
      }
      if (manifest.some((entry) => !found.has(entry.key) || !terminal(found.get(entry.key)!.status))) return { status: "running" };
      const outputs: RemoteAudioOutput[] = [];
      const failedOutputKeys: string[] = [];
      for (const entry of manifest) {
        const clip = found.get(entry.key)!;
        if (clip.status === "error") failedOutputKeys.push(entry.key);
        else outputs.push({ ...entry, url: sunoDownloadPath(entry.key) });
      }
      if (!outputs.length) return { status: "failed", message: http.fail("all generated clips failed.").message };
      return { status: "completed", outputs, ...(failedOutputKeys.length ? { failedOutputKeys } : {}) };
    },
    async download(output, signal) {
      return download(output, signal);
    },
    async downloadSelected(output, signal, authorization) {
      if (typeof authorization !== "function") throw http.fail("selected download requires a connection authorization guard.");
      return download({ ...output, url: sunoDownloadPath(output.key) }, signal, authorization);
    },
  };
}
