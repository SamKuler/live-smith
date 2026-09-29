import { randomUUID } from "node:crypto";
import type { AudioDownloadAuthorization, AudioServiceAuthorization, AudioGenerationAdapter, AudioGenerationRequest, AudioGenerationSubmission, AudioJob, RemoteAudioOutput } from "./contracts.js";
import { AudioSubmissionNotStartedError, SOUND_SAMPLE_KEYS, REMASTER_VARIATIONS } from "./contracts.js";
import { assertSunoVerificationFresh, readSunoVerificationProof, SunoVerificationError, type SunoHumanVerificationHandler, type SunoVerificationProof } from "./suno-verification.js";
import { createSunoHttp, type SunoSessionRefreshHandler } from "./suno-http.js";
import { exceedsAudioPromptLimit } from "./prompt.js";
import { downloadSunoClip, sunoDownloadPath } from "./suno-download.js";
import { readSunoCatalog, readSunoPersona, sunoActive, sunoObject, sunoUuid, type SunoMusicModel, type SunoSession } from "./suno-catalog.js";
import { sourceActionAllowed, musicEditTask, prepareMusicEdit, finishMusicReplacementBody } from "./suno-editing.js";
import { baseSunoStemRole, downloadSunoStem, isSunoStemRole, prepareSunoStems, sunoStemManifest, sunoStemRole } from "./suno-stems.js";
export { readSunoMusicService } from "./suno-catalog.js";
export type { SunoMusicServiceRequest } from "./suno-catalog.js";

type SunoHttp = ReturnType<typeof createSunoHttp>;
type MusicRequest = Extract<AudioGenerationRequest, {
  operation: "generate_music" | "extend_music" | "get_whole_song" | "generate_sound_sample" | "cover_music" | "remaster_music" | "add_vocals" | "add_instrumental" | "replace_music_section" | "finish_music_replacement" | "extract_music_stems";
}>;
type Manifest = NonNullable<AudioJob["expectedOutputs"]>;
function terminal(status: unknown): boolean { return status === "complete" || status === "error"; }

function validateRequest(request: AudioGenerationRequest, http: SunoHttp): MusicRequest {
  const input = sunoObject(request, http);
  const fields = request.operation === "generate_music" ? ["operation", "prompt", "durationSeconds", "instrumental", "options"]
    : request.operation === "extend_music" ? ["operation", "clipId", "startSeconds", "prompt", "instrumental", "options"]
    : request.operation === "cover_music" ? ["operation", "clipId", "startSeconds", "endSeconds", "prompt", "instrumental", "options"]
    : request.operation === "generate_sound_sample" ? ["operation", "prompt", "loop", "bpm", "key"]
    : request.operation === "remaster_music" ? ["operation", "clipId", "modelId", "variation"]
    : request.operation === "add_vocals" || request.operation === "add_instrumental" ? ["operation", "clipId", "prompt", "options"]
    : request.operation === "replace_music_section" ? ["operation", "clipId", "startSeconds", "endSeconds", "contextStartSeconds", "contextEndSeconds", "replacementDurationSeconds", "prompt", "options"]
    : request.operation === "get_whole_song" || request.operation === "finish_music_replacement" || request.operation === "extract_music_stems" ? ["operation", "clipId"] : [];
  if (!fields.length || Object.keys(input).some((key) => !fields.includes(key))) throw http.fail("unsupported music operation or parameter.");
  if (request.operation === "generate_sound_sample") {
    if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.includes("\0") ||
        exceedsAudioPromptLimit(request.prompt, 500) || typeof request.loop !== "boolean" ||
        (request.bpm !== undefined && (!Number.isInteger(request.bpm) || request.bpm < 1 || request.bpm > 300)) ||
        (request.key !== undefined && !SOUND_SAMPLE_KEYS.includes(request.key))) throw http.fail("invalid sound sample parameters.");
    return { ...request };
  }
  if (request.operation === "remaster_music") {
    sunoUuid(request.clipId, http);
    if (request.modelId !== undefined && (typeof request.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.modelId)) ||
        request.variation !== undefined && !REMASTER_VARIATIONS.includes(request.variation)) throw http.fail("invalid remaster parameters.");
    return { ...request };
  }
  if (request.operation === "get_whole_song" || request.operation === "finish_music_replacement" || request.operation === "extract_music_stems") {
    sunoUuid(request.clipId, http);
    return { operation: request.operation, clipId: request.clipId };
  }
  if (request.operation !== "generate_music" && request.operation !== "extend_music" && request.operation !== "cover_music" && request.operation !== "add_vocals" && request.operation !== "add_instrumental" && request.operation !== "replace_music_section") throw http.fail("unsupported music operation.");
  const custom = request.operation !== "generate_music" || request.options?.mode === "custom";
  if (typeof request.prompt !== "string" || request.prompt.includes("\0") ||
      exceedsAudioPromptLimit(request.prompt, custom ? 5000 : 3000) || "instrumental" in request && typeof request.instrumental !== "boolean") {
    throw http.fail("invalid music prompt or instrumental flag.");
  }
  if (request.options !== undefined) {
    const options = sunoObject(request.options, http);
    if (options.mode !== "custom" || Object.keys(options).some((key) => ![
      "mode", "title", "styles", "negativeStyles", "weirdness", "styleInfluence", "personaId",
      "vocalGender", "audioInfluence",
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
    for (const key of ["weirdness", "styleInfluence", "audioInfluence"] as const) {
      const value = options[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        throw http.fail("music sliders must be numbers between 0 and 100.");
      }
    }
    if (options.personaId !== undefined) sunoUuid(options.personaId, http);
    if (request.operation !== "generate_music" && options.personaId !== undefined) {
      throw http.fail("Persona is not available for this music operation.");
    }
  }
  if (!request.prompt.trim() && !(("instrumental" in request && request.instrumental || request.operation === "add_instrumental" || request.operation === "replace_music_section") && custom)) {
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
  if (request.options?.audioInfluence !== undefined && request.operation === "generate_music" && !request.options.personaId) {
    throw http.fail("audio influence requires a source clip or Persona.");
  }
  if (request.operation === "cover_music") {
    sunoUuid(request.clipId, http);
    if ((request.startSeconds !== undefined && (typeof request.startSeconds !== "number" || !Number.isFinite(request.startSeconds) || request.startSeconds < 0)) ||
        (request.endSeconds !== undefined && (typeof request.endSeconds !== "number" || !Number.isFinite(request.endSeconds) || request.endSeconds <= (request.startSeconds ?? 0)))) {
      throw http.fail("invalid cover source interval.");
    }
  }
  if (request.operation === "add_vocals" || request.operation === "add_instrumental" || request.operation === "replace_music_section") {
    sunoUuid(request.clipId, http);
    if (request.operation === "replace_music_section") {
      for (const value of [request.startSeconds, request.endSeconds]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 900) throw http.fail("invalid replacement interval.");
      }
      if (request.endSeconds - request.startSeconds < 10) throw http.fail("replacement interval must be at least ten seconds.");
      for (const value of [request.contextStartSeconds, request.contextEndSeconds, request.replacementDurationSeconds]) {
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 900)) throw http.fail("invalid replacement context or duration.");
      }
      if (request.contextStartSeconds !== undefined && request.contextStartSeconds > request.startSeconds ||
          request.contextEndSeconds !== undefined && request.contextEndSeconds < request.endSeconds ||
          request.replacementDurationSeconds !== undefined && request.replacementDurationSeconds < 10) throw http.fail("invalid replacement context or duration.");
    }
    return { ...request, ...(request.options ? { options: { ...request.options } } : {}) };
  }
  return {
    operation: request.operation, prompt: request.prompt, instrumental: request.instrumental,
    ...(request.operation === "generate_music" && request.durationSeconds !== undefined
      ? { durationSeconds: request.durationSeconds } : {}),
    ...(request.operation === "extend_music" ? { clipId: request.clipId, startSeconds: request.startSeconds } : {}),
    ...(request.operation === "cover_music" ? { clipId: request.clipId,
      ...(request.startSeconds === undefined ? {} : { startSeconds: request.startSeconds }),
      ...(request.endSeconds === undefined ? {} : { endSeconds: request.endSeconds }) } : {}),
    ...(request.options ? { options: { ...request.options } } : {}),
  } as MusicRequest;
}

function enforceLimits(request: Extract<MusicRequest, { operation: "generate_music" | "extend_music" | "cover_music" | "add_vocals" | "add_instrumental" | "replace_music_section" }>, model: SunoMusicModel, http: SunoHttp) {
  const custom = request.operation !== "generate_music" || request.options?.mode === "custom";
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

function generationBody(request: Extract<MusicRequest, { operation: "generate_music" | "extend_music" | "cover_music" | "add_vocals" | "add_instrumental" | "replace_music_section" }>, modelId: string) {
  const options = request.options;
  const custom = request.operation !== "generate_music" || options?.mode === "custom";
  const sliders = {
    ...(options?.weirdness === undefined ? {} : { weirdness_constraint: options.weirdness / 100 }),
    ...(options?.styleInfluence === undefined ? {} : { style_weight: options.styleInfluence / 100 }),
    ...(options?.audioInfluence === undefined ? {} : { audio_weight: options.audioInfluence / 100 }),
  };
  // The web client sends descriptions in gpt_description_prompt; prompt is lyrics.
  return {
    token: null, token_provider: null, generation_type: "TEXT", mv: request.operation === "replace_music_section" && ["chirp-auk", "chirp-v4-5"].includes(modelId) ? "chirp-auk-infill" : modelId,
    ...(request.operation === "extend_music" ? { task: "extend" } : request.operation === "cover_music" ? { task: "cover" } : request.operation === "add_vocals" || request.operation === "add_instrumental" || request.operation === "replace_music_section" ? { task: musicEditTask(request.operation) } : {}),
    ...(custom ? { title: options?.title ?? "", tags: options?.styles ?? "", negative_tags: options?.negativeStyles ?? "" } : {}),
    prompt: custom ? request.prompt : "", ...(custom ? {} : { gpt_description_prompt: request.prompt }),
    make_instrumental: "instrumental" in request ? request.instrumental : !request.prompt.trim(), user_uploaded_images_b64: null,
    ...(request.operation === "generate_music" && request.durationSeconds !== undefined
      ? { duration: request.durationSeconds } : {}),
    metadata: {
      web_client_pathname: "/create", is_max_mode: false, is_mumble: false,
      create_mode: custom ? "custom" : "simple",
      user_tier: "", create_session_token: randomUUID(), disable_volume_normalization: false,
      ...(request.operation === "extend_music" ? { is_remix: true, lyrics_updated: false } : request.operation === "cover_music" ? { is_remix: true } : {}),
      ...(options?.vocalGender === undefined ? {} : { vocal_gender: options.vocalGender === "female" ? "f" : "m" }),
      ...(Object.keys(sliders).length ? { control_sliders: sliders } : {}),
    },
    override_fields: [], cover_clip_id: request.operation === "cover_music" ? request.clipId : null,
    cover_start_s: request.operation === "cover_music" ? request.startSeconds ?? null : null,
    cover_end_s: request.operation === "cover_music" ? request.endSeconds ?? null : null,
    persona_id: options?.personaId ?? null, artist_clip_id: null, artist_start_s: null, artist_end_s: null,
    continue_clip_id: request.operation === "extend_music" ? request.clipId : null,
    continued_aligned_prompt: null, continue_at: request.operation === "extend_music" ? request.startSeconds : null,
    transaction_uuid: randomUUID(),
  };
}

function manifestFromReceipt(value: unknown, single: boolean, http: SunoHttp, sound = false): Manifest {
  const receipt = sunoObject(value, http);
  if (typeof receipt.status === "string" && receipt.status.toLowerCase() === "error") throw http.fail("music submission was rejected.");
  const clips = single ? [receipt] : receipt.clips;
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 2) throw http.fail("submission must acknowledge one or two clips.");
  const ids = clips.map((clip: unknown) => sunoUuid(sunoObject(clip, http).id, http)).sort();
  if (new Set(ids).size !== ids.length) throw http.fail("duplicate submission clip identifier.");
  const manifest: Manifest = ids.map((key, index) => ({ key, role: sound ? index === 0 ? "sound_effect" : "sound_effect_alternative" : index === 0 ? "music" : "music_alternative" }));
  for (const entry of manifest) Object.freeze(entry);
  Object.freeze(manifest);
  return manifest;
}

function checkedManifest(taskId: string, manifest: AudioJob["expectedOutputs"], http: SunoHttp): Manifest {
  sunoUuid(taskId, http);
  if (!Array.isArray(manifest) || manifest.length < 1) throw http.fail("Suno recovery requires the original output manifest.");
  const stems = isSunoStemRole(manifest[0]?.role);
  if (manifest.length > (stems ? 24 : 2) || new Set(manifest.map((entry) => entry.role)).size !== manifest.length) throw http.fail("invalid Suno output manifest.");
  const uploaded = manifest[0]?.role === "uploaded_audio";
  if (uploaded && manifest.length !== 1) throw http.fail("uploaded audio requires one original clip.");
  const sound = manifest[0]?.role === "sound_effect";
  const result = manifest.map((entry, index) => {
    const value = sunoObject(entry, http);
    const key = sunoUuid(value.key, http);
    if ((stems ? !isSunoStemRole(value.role) : value.role !== (uploaded ? "uploaded_audio" : sound ? index === 0 ? "sound_effect" : "sound_effect_alternative" : index === 0 ? "music" : "music_alternative")) ||
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
    if (!isSunoStemRole(output.role) && !["music", "music_alternative", "sound_effect", "sound_effect_alternative", "uploaded_audio"].includes(output.role)) throw http.fail("invalid generated music role.");
    if (output.url !== sunoDownloadPath(output.key)) throw http.fail("download locator does not match its clip identifier.");
    return isSunoStemRole(output.role)
      ? downloadSunoStem(http, output.key, output.role, signal, authorizeDownloads, authorization)
      : downloadSunoClip(http, output.key, signal, authorizeDownloads, authorization);
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
      let contextPromptLimit: number | undefined;
      if (snapshot.operation === "get_whole_song" || snapshot.operation === "finish_music_replacement") {
        body = { clip_id: snapshot.clipId };
        path = "/api/generate/concat/v2/";
      } else if (snapshot.operation === "extract_music_stems") {
        body = await prepareSunoStems(http, session, snapshot.clipId, signal);
        path = "/api/generate/v2-web/";
      } else {
        const catalog = await readSunoCatalog(http, session, signal);
        if (snapshot.operation === "remaster_music") {
          const models = catalog.remasterModels ?? [];
          const candidates = models.filter((model) => model.canUse === true &&
            (snapshot.modelId === undefined ? model.isDefault === true : model.id === snapshot.modelId));
          if (candidates.length !== 1) throw http.fail("choose an available model from the remaster catalog.");
          const selected = candidates[0]!;
          if (snapshot.variation !== undefined && selected.supportsVariation !== true) throw http.fail("this remaster model has no verified variation-strength support.");
          body = { clip_id: snapshot.clipId, model_name: selected.id,
            ...(snapshot.variation === undefined ? {} : { variation_category: snapshot.variation }) };
          path = "/api/generate/upsample";
        } else {
          const candidates = catalog.models.filter((model) => model.canUse === true && (modelId === undefined ? model.isDefault === true : model.id === modelId));
          if (candidates.length !== 1) throw http.fail("the configured model or an unambiguous usable default is unavailable.");
          const selected = candidates[0]!;
          contextPromptLimit = selected.maxLengths.prompt;
          if (snapshot.operation === "generate_sound_sample" || snapshot.operation === "cover_music" ||
              snapshot.operation === "add_vocals" || snapshot.operation === "add_instrumental" || snapshot.operation === "replace_music_section") {
            const task = snapshot.operation === "generate_sound_sample" ? "sound" : snapshot.operation === "cover_music" ? "cover" : musicEditTask(snapshot.operation);
            if (!selected.capabilities?.some((value) => value === "all" || value === task)) {
              throw http.fail("the account catalog does not confirm support for this operation.");
            }
            const condition = task === "sound" ? undefined : task === "overpainting" ? "overpaint" : task === "underpainting" ? "underpaint" : task;
            if (condition && selected.allowedConditionCombinations?.length &&
                !selected.allowedConditionCombinations.some((combination) => combination.length === 1 && combination[0] === condition)) {
              throw http.fail(`the selected model does not allow the ${condition} condition.`);
            }
          }
          if (snapshot.operation === "generate_sound_sample") {
            const limit = selected.maxLengths.tags;
            if (limit !== undefined && exceedsAudioPromptLimit(snapshot.prompt, limit)) throw http.fail("sound description exceeds the model catalog limit.");
            const base = generationBody({ operation: "generate_music", prompt: "", instrumental: true,
              options: { mode: "custom", styles: snapshot.prompt } }, selected.id);
            body = { ...base, task: "sound", metadata: { ...base.metadata, sound_configs: {
              user_loop: snapshot.loop, ...(snapshot.bpm === undefined ? {} : { user_tempo: snapshot.bpm }),
              ...(snapshot.key === undefined ? {} : { user_key: snapshot.key }),
            } } };
          } else {
            enforceLimits(snapshot, selected, http);
            if (snapshot.options?.audioInfluence !== undefined && !selected.features?.includes("create_control_sliders")) {
              throw http.fail("the account catalog does not confirm audio-influence support.");
            }
            if (snapshot.options?.personaId) await readSunoPersona(http, session, snapshot.options.personaId, signal);
            body = generationBody(snapshot, selected.id);
          }
          path = "/api/generate/v2-web/";
        }
      }
      if (snapshot.operation === "extend_music" || snapshot.operation === "get_whole_song" ||
          snapshot.operation === "cover_music" || snapshot.operation === "remaster_music" ||
          snapshot.operation === "add_vocals" || snapshot.operation === "add_instrumental" || snapshot.operation === "replace_music_section" || snapshot.operation === "finish_music_replacement") {
        let ownerId: string | undefined;
        if (snapshot.operation === "cover_music" || snapshot.operation === "remaster_music" || snapshot.operation === "add_vocals" || snapshot.operation === "add_instrumental" || snapshot.operation === "replace_music_section" || snapshot.operation === "finish_music_replacement" || snapshot.operation === "get_whole_song") {
          const account = sunoObject(await http.request("GET", "/api/session/", undefined, signal), http);
          const owner = sunoObject(account.user, http);
          if (owner.clerk_id !== session.accountId || typeof owner.id !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(owner.id)) throw http.fail("account ownership could not be verified.");
          ownerId = owner.id;
        }
        const clips = await http.request("GET", `/api/feed/?ids=${snapshot.clipId}`, undefined, signal);
        if (!Array.isArray(clips) || clips.length !== 1) throw http.fail("source clip is unavailable.");
        const source = sunoObject(clips[0], http);
        if (sunoUuid(source.id, http) !== snapshot.clipId || source.status !== "complete") throw http.fail("source clip is not complete or does not match.");
        if (snapshot.operation === "cover_music") {
          const fallback = source.is_trashed !== true &&
            (source.user_id === ownerId || sunoObject(source.metadata, http).can_remix === true);
          if (!sourceActionAllowed(source, "remix_cover", fallback)) {
            throw http.fail("source clip does not permit covers on this account.");
          }
        }
        if (snapshot.operation === "remaster_music" && !sourceActionAllowed(source, "remaster", source.user_id === ownerId)) {
          throw http.fail("source clip does not permit remastering on this account.");
        }
        if (snapshot.operation === "add_vocals" || snapshot.operation === "add_instrumental" || snapshot.operation === "replace_music_section") {
          body = await prepareMusicEdit(snapshot, source, ownerId!, body as Record<string, unknown>, http, signal, contextPromptLimit);
        }
        if (snapshot.operation === "finish_music_replacement") body = finishMusicReplacementBody(source, ownerId!, http);
        if (snapshot.operation === "get_whole_song") {
          if (source.user_id !== ownerId || source.is_trashed === true || !sourceActionAllowed(source, "get_full_song", true)) {
            throw http.fail("source clip does not permit whole-song creation on this account.");
          }
          const metadata = sunoObject(source.metadata, http);
          const task = metadata.task;
          if (typeof task !== "string" || !["extend", "upload_extend", "artist_extend", "vox_extend"].includes(task)) {
            throw http.fail("Get Whole Song requires a completed extension clip.");
          }
          body = { clip_id: snapshot.clipId, is_infill: false,
            ...(metadata.edit_session_id ? { edit_session_id: sunoUuid(metadata.edit_session_id, http) } : {}) };
        }
        if (snapshot.operation === "extend_music" || snapshot.operation === "cover_music") {
          const duration = sunoObject(source.metadata, http).duration;
          if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= (snapshot.startSeconds ?? 0) ||
              snapshot.operation === "cover_music" && snapshot.endSeconds !== undefined && snapshot.endSeconds > duration) {
            throw http.fail("source interval must lie within the completed clip's duration.");
          }
        }
      }
      let proof: SunoVerificationProof | undefined;
      // The website's shared generation endpoint owns the challenge preflight.
      if (path === "/api/generate/v2-web/") {
        const gate = sunoObject(await http.request("POST", "/api/c/check", { ctype: "generation" }, signal), http);
        if (gate.required === true) {
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
      }
      sunoActive(signal, http);
      const signature = JSON.stringify(snapshot);
      if (JSON.stringify(validateRequest(request, http)) !== signature) throw http.fail("music parameters changed during preparation.");
      prepared.set(request, { signature, signal, path, body, ...(proof ? { proof } : {}) });
    },
    async submit(request, signal, onAuthorizedDispatch) {
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
        await onAuthorizedDispatch?.();
        beforeSend();
        const receipt = await http.request("POST", plan!.path, plan!.body, signal, beforeSend);
        // A validated receipt may race Stop; retain every acknowledged identity.
        const expectedOutputs = snapshot.operation === "extract_music_stems" ? sunoStemManifest(receipt, http)
          : manifestFromReceipt(receipt, snapshot.operation === "get_whole_song" || snapshot.operation === "finish_music_replacement", http, snapshot.operation === "generate_sound_sample");
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
        else {
          if (isSunoStemRole(entry.role) && sunoStemRole(clip, http) !== baseSunoStemRole(entry.role)) throw http.fail("stem output changed its instrument identity.");
          outputs.push({ ...entry, url: sunoDownloadPath(entry.key) });
        }
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
